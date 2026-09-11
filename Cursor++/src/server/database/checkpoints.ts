import { createHash, randomUUID } from 'node:crypto';
import { getCheckpointDatabase } from './sqlite';

export type CheckpointKind = 'committed' | 'draft';

export interface PersistedConversationCheckpoint {
    conversationId: string;
    kind: CheckpointKind;
    rootBlobIds: string[];
    turnBlobIds: string[];
    summaryArchiveIds: string[];
    tokenDetails: { usedTokens: number; maxTokens: number };
    mode: string;
    updatedAt: number;
}

interface CheckpointRow {
    conversation_id: string;
    kind: string;
    root_blob_ids_json: string;
    turn_blob_ids_json: string;
    summary_archive_ids_json: string;
    used_tokens: number;
    max_tokens: number;
    mode: string;
    updated_at: number;
}

interface CheckpointWriteRow extends CheckpointRow {
    write_token: string;
    is_deleted: number;
    terminal_receipt_json: string;
}

export type CheckpointReferences = Pick<PersistedConversationCheckpoint, 'rootBlobIds' | 'turnBlobIds' | 'summaryArchiveIds'>;

interface CheckpointVersion {
    committed: string | null;
    draft: string | null;
}

const checkpointVersion = Symbol('checkpointVersion');
const checkpointRecoveryRows = Symbol('checkpointRecoveryRows');
// Provenance for cooperative writers that atomically retire draft on committed writes.
// This is not authentication: external writers must not forge or reuse these tokens.
const checkpointWriteTokenPrefix = 'ccursor-cas-v1:';

/** One run owns this scope and sequentially awaits its writes. Both kinds share validity. */
export interface CheckpointWriteScope {
    readonly conversationId: string;
    readonly committedCheckpoint: PersistedConversationCheckpoint | null;
    readonly draftCheckpoint: PersistedConversationCheckpoint | null;
    /** Legacy pairs require compatibility verification, not a blind draft preference. */
    readonly hasAmbiguousLegacyPair: boolean;
    /** An explicit conversation reset is not authority for a delayed run to recreate it. */
    readonly isDeleted: boolean;
    readonly terminalReceiptJson: string;
    readonly [checkpointVersion]: CheckpointVersion;
    readonly [checkpointRecoveryRows]: string;
}

export class CheckpointConflictError extends Error {
    constructor(readonly conversationId: string) {
        super(`Checkpoint changed for conversation ${conversationId}; restart from the current checkpoint.`);
        this.name = 'CheckpointConflictError';
    }
}

function parseStringArray(value: string, conversationId: string): string[] {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === 'string'))
            throw new Error('Invalid checkpoint reference array');
        return parsed;
    } catch {
        // Malformed mirror metadata cannot establish a safe version baseline.
        throw new CheckpointConflictError(conversationId);
    }
}

function parseCheckpointRow(row: CheckpointRow): PersistedConversationCheckpoint {
    return {
        conversationId: row.conversation_id,
        kind: row.kind as CheckpointKind,
        rootBlobIds: parseStringArray(row.root_blob_ids_json, row.conversation_id),
        turnBlobIds: parseStringArray(row.turn_blob_ids_json, row.conversation_id),
        summaryArchiveIds: parseStringArray(row.summary_archive_ids_json, row.conversation_id),
        tokenDetails: {
            usedTokens: row.used_tokens,
            maxTokens: row.max_tokens,
        },
        mode: row.mode,
        updatedAt: row.updated_at,
    };
}

export function hasMatchingCheckpointReferences(actual: CheckpointReferences | null, expected: CheckpointReferences | null): boolean {
    if (!actual || !expected) return actual === expected;
    return (['rootBlobIds', 'turnBlobIds', 'summaryArchiveIds'] as const).every(field =>
        actual[field].length === expected[field].length
        && actual[field].every((blobId, index) => blobId === expected[field][index]));
}

/**
 * Capture before restoring context or starting run work, not immediately before saving.
 * The optional reference precondition rejects a client based on an older completed checkpoint.
 * Omit it only when the caller has separately validated the incoming state/reset policy.
 * Checkpoints exposed on the scope are the run-start snapshot, not a live cache.
 */
export async function beginCheckpointWriteScope(
    conversationId: string,
    options: { signal?: AbortSignal; expectedCommittedCheckpoint?: CheckpointReferences | null } = {},
): Promise<CheckpointWriteScope> {
    options.signal?.throwIfAborted();
    // One SELECT snapshots both rows (including tombstones) consistently across connections.
    const rows = await getCheckpointDatabase().all<CheckpointWriteRow>(`
        SELECT * FROM conversation_checkpoints WHERE conversation_id = ?
    `, [conversationId]);
    options.signal?.throwIfAborted();
    const committedRow = rows.find(row => row.kind === 'committed');
    const draftRow = rows.find(row => row.kind === 'draft');
    const committedCheckpoint = committedRow && !committedRow.is_deleted ? parseCheckpointRow(committedRow) : null;
    const draftCheckpoint = draftRow && !draftRow.is_deleted ? parseCheckpointRow(draftRow) : null;
    // Never infer legacy ordering from timestamps or rewrite either recovery candidate.
    const hasAmbiguousLegacyPair = committedCheckpoint !== null && draftCheckpoint !== null
        && !hasMatchingCheckpointReferences(committedCheckpoint, draftCheckpoint)
        && !(committedRow?.write_token.startsWith(checkpointWriteTokenPrefix)
            && draftRow?.write_token.startsWith(checkpointWriteTokenPrefix));
    if (options.expectedCommittedCheckpoint !== undefined
        && !hasMatchingCheckpointReferences(committedCheckpoint, options.expectedCommittedCheckpoint)) {
        throw new CheckpointConflictError(conversationId);
    }
    return {
        conversationId,
        committedCheckpoint,
        draftCheckpoint,
        hasAmbiguousLegacyPair,
        isDeleted: committedRow?.is_deleted === 1,
        // Final acceptance writes both tokens together. Any later draft write or
        // cleanup invalidates redelivery, including a subsequently retired draft.
        terminalReceiptJson: !draftCheckpoint && committedCheckpoint && committedRow?.write_token === draftRow?.write_token
            ? committedRow!.terminal_receipt_json : '',
        [checkpointRecoveryRows]: JSON.stringify(rows.sort((left, right) => left.kind.localeCompare(right.kind))),
        [checkpointVersion]: {
            committed: committedRow?.write_token ?? null,
            draft: draftRow?.write_token ?? null,
        },
    };
}

async function writeCheckpointRows(
    mutation: { checkpoint: PersistedConversationCheckpoint; deleted?: boolean; terminalReceiptJson?: string },
    signal?: AbortSignal,
    writeScope?: CheckpointWriteScope,
): Promise<void> {
    signal?.throwIfAborted();
    const { checkpoint } = mutation;
    const scope = writeScope ?? await beginCheckpointWriteScope(checkpoint.conversationId, { signal });
    if (scope.conversationId !== checkpoint.conversationId) {
        throw new Error('Checkpoint write scope belongs to a different conversation.');
    }
    const database = getCheckpointDatabase();
    const writeToken = `${checkpointWriteTokenPrefix}${randomUUID()}`;
    const parameters = {
        $conversationId: checkpoint.conversationId,
        $kind: checkpoint.kind,
        $rootBlobIdsJson: JSON.stringify(checkpoint.rootBlobIds),
        $turnBlobIdsJson: JSON.stringify(checkpoint.turnBlobIds),
        $summaryArchiveIdsJson: JSON.stringify(checkpoint.summaryArchiveIds),
        $usedTokens: checkpoint.tokenDetails.usedTokens,
        $maxTokens: checkpoint.tokenDetails.maxTokens,
        $mode: checkpoint.mode,
        $updatedAt: checkpoint.updatedAt,
        $writeToken: writeToken,
        $isDeleted: mutation.deleted ? 1 : 0,
        $expectedCommittedToken: scope[checkpointVersion].committed,
        $expectedDraftToken: scope[checkpointVersion].draft,
        $terminalReceiptJson: mutation.terminalReceiptJson ?? '',
    };

    // Dispatch is the cancellation boundary. This single SQLite statement atomically
    // checks the whole conversation version and replaces its payload/version. Committed
    // writes also retire draft so it cannot remain an active, older input baseline.
    // Never compensate or throw cancellation after dispatch: accepted writes stay accepted.
    signal?.throwIfAborted();
    const result = await database.run(`
        WITH current_version AS MATERIALIZED (
            SELECT
                (SELECT write_token FROM conversation_checkpoints
                 WHERE conversation_id = $conversationId AND kind = 'committed') IS $expectedCommittedToken
                AND
                (SELECT write_token FROM conversation_checkpoints
                 WHERE conversation_id = $conversationId AND kind = 'draft') IS $expectedDraftToken AS matches
        ), checkpoint_kinds(kind, is_deleted) AS (
            SELECT $kind, $isDeleted
            UNION ALL SELECT 'draft', 1 WHERE $kind = 'committed'
        )
        INSERT INTO conversation_checkpoints (
            conversation_id,
            kind,
            root_blob_ids_json,
            turn_blob_ids_json,
            summary_archive_ids_json,
            used_tokens,
            max_tokens,
            mode,
            updated_at,
            write_token,
            is_deleted,
            terminal_receipt_json
        ) SELECT
            $conversationId,
            checkpoint_kinds.kind,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN '[]' ELSE $rootBlobIdsJson END,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN '[]' ELSE $turnBlobIdsJson END,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN '[]' ELSE $summaryArchiveIdsJson END,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN 0 ELSE $usedTokens END,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN 0 ELSE $maxTokens END,
            CASE WHEN checkpoint_kinds.is_deleted = 1 THEN '' ELSE $mode END,
            $updatedAt,
            $writeToken,
            checkpoint_kinds.is_deleted,
            CASE WHEN checkpoint_kinds.is_deleted = 0 AND checkpoint_kinds.kind = 'committed'
                 THEN $terminalReceiptJson ELSE '' END
        FROM checkpoint_kinds, current_version
        WHERE current_version.matches
        ON CONFLICT(conversation_id, kind) DO UPDATE SET
            root_blob_ids_json = excluded.root_blob_ids_json,
            turn_blob_ids_json = excluded.turn_blob_ids_json,
            summary_archive_ids_json = excluded.summary_archive_ids_json,
            used_tokens = excluded.used_tokens,
            max_tokens = excluded.max_tokens,
            mode = excluded.mode,
            updated_at = excluded.updated_at,
            write_token = excluded.write_token,
            is_deleted = excluded.is_deleted,
            terminal_receipt_json = excluded.terminal_receipt_json
    `, parameters);
    if (result.changes === 0) throw new CheckpointConflictError(checkpoint.conversationId);
    scope[checkpointVersion][checkpoint.kind] = writeToken;
    if (checkpoint.kind === 'committed') scope[checkpointVersion].draft = writeToken;
}

/**
 * Run callers must pass their run-start scope, reusing it after every accepted write.
 * Without a scope this is a compatible one-shot CAS, not protection for earlier run work.
 * Committed writes atomically tombstone draft and advance both tokens in that scope.
 */
export function persistConversationCheckpoint(
    checkpoint: PersistedConversationCheckpoint,
    signal?: AbortSignal,
    writeScope?: CheckpointWriteScope,
    terminalReceiptJson?: string,
): Promise<void> {
    return writeCheckpointRows({ checkpoint, terminalReceiptJson }, signal, writeScope);
}

/** Read-only fence after asynchronous validation; it is not a network delivery ACK. */
export async function assertCheckpointWriteScopeCurrent(scope: CheckpointWriteScope, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const current = await getCheckpointDatabase().get<{ matches: number }>(`
        SELECT
            (SELECT write_token FROM conversation_checkpoints WHERE conversation_id = ? AND kind = 'committed') IS ?
            AND (SELECT write_token FROM conversation_checkpoints WHERE conversation_id = ? AND kind = 'draft') IS ? AS matches
    `, [scope.conversationId, scope[checkpointVersion].committed, scope.conversationId, scope[checkpointVersion].draft]);
    signal?.throwIfAborted();
    if (!current?.matches) throw new CheckpointConflictError(scope.conversationId);
}

/**
 * Archive the exact run-start candidates BEFORE adopting a client-selected baseline.
 * A crash/conflict between these statements leaves an extra recovery snapshot, never
 * an unbacked overwrite. The adoption still compares the original token pair.
 */
export async function adoptConversationCheckpoint(
    checkpoint: PersistedConversationCheckpoint,
    scope: CheckpointWriteScope,
    reason: 'legacy-compatible' | 'user-selected',
    signal?: AbortSignal,
): Promise<void> {
    if (checkpoint.conversationId !== scope.conversationId || checkpoint.kind !== 'committed' || scope.isDeleted)
        throw new CheckpointConflictError(scope.conversationId);
    await assertCheckpointWriteScopeCurrent(scope, signal);
    const rowsJson = scope[checkpointRecoveryRows];
    const snapshotId = createHash('sha256').update(rowsJson).digest('hex');
    signal?.throwIfAborted();
    await getCheckpointDatabase().run(`
        INSERT INTO conversation_checkpoint_recovery
            (snapshot_id, conversation_id, reason, checkpoint_rows_json, preserved_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_id) DO NOTHING
    `, [snapshotId, scope.conversationId, reason, rowsJson, Date.now()]);
    await persistConversationCheckpoint(checkpoint, signal, scope);
}

/**
 * 获取指定会话的 committed checkpoint (默认)。
 * 恢复历史时只用 committed，不用 draft。
 */
export async function getPersistedConversationCheckpoint(
    conversationId: string,
    kind: CheckpointKind = 'committed',
): Promise<PersistedConversationCheckpoint | null> {
    if (!conversationId) return null;

    const row = await getCheckpointDatabase().get<CheckpointRow>(`
        SELECT conversation_id, kind, root_blob_ids_json, turn_blob_ids_json, summary_archive_ids_json, used_tokens, max_tokens, mode, updated_at
        FROM conversation_checkpoints
        WHERE conversation_id = ? AND kind = ? AND is_deleted = 0
    `, [conversationId, kind]);
    return row ? parseCheckpointRow(row) : null;
}

/** Explicit, version-conditional draft cleanup; run failures never call this automatically. */
export function clearDraftCheckpoint(
    conversationId: string,
    signal?: AbortSignal,
    writeScope?: CheckpointWriteScope,
): Promise<void> {
    return clearCheckpointRows(conversationId, false, signal, writeScope);
}

/** Explicit reset retains tombstones. Empty client state never implies deletion. */
export function clearPersistedConversationCheckpoint(
    conversationId: string,
    signal?: AbortSignal,
    writeScope?: CheckpointWriteScope,
): Promise<void> {
    return clearCheckpointRows(conversationId, true, signal, writeScope);
}

async function clearCheckpointRows(
    conversationId: string,
    clearAll: boolean,
    signal?: AbortSignal,
    writeScope?: CheckpointWriteScope,
): Promise<void> {
    if (!conversationId) return;
    // Retain fresh tokens even when already absent. Physical DELETE would allow ABA
    // and let a scope captured before reset resurrect the conversation afterwards.
    // The materialized CAS above is evaluated once before either kind is tombstoned.
    await writeCheckpointRows({
        checkpoint: {
            conversationId,
            kind: clearAll ? 'committed' : 'draft',
            rootBlobIds: [],
            turnBlobIds: [],
            summaryArchiveIds: [],
            tokenDetails: { usedTokens: 0, maxTokens: 0 },
            mode: '',
            updatedAt: Date.now(),
        },
        deleted: true,
    }, signal, writeScope);
}
