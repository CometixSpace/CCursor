import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { collectExtraContextBlobIds, parseRunRequest, resolveExtraContextBlobs } from './protocol';
import type { AgentSession } from './session';
import { handleSummarizeAction } from './summarizeRuntime';
import { handleConversationRun } from './conversationRuntime';
import { beginCheckpointWriteScope, CheckpointConflictError } from '../../database/checkpoints';
import { binaryBlobDataFromClientBytes, blobIdFromBytes, blobIdToBytes } from './blob';
import { BlobRunContext } from './runContext';
import { BlobIntegrityError } from './blobErrors';
import { uploadHandoff } from './uploadHandoff';
import { fetchBlobsFromClient } from './clientBlobFetch';
import { logger } from '../../logger';
import { isAgentRunAbortedError } from './wait';
import { applyRequestContextPart, type RequestContextPartName } from './requestContextParts';
import { makeByokConnectError } from '../errors';
import { ErrorDetails_Error } from '../../gen/aiserver_v1_shared_pb';
import { claimUploadedConversationBlobs } from './uploadRunHandoff';
import { processRunResources } from './runResources';
import { throwIfBlobRunInactive } from './checkpointManager';
import { CheckpointDelivery } from './checkpointDelivery';
import { admitClientCheckpoint } from './checkpointRecovery';

export async function* handleRunRequest(
    msg: Record<string, unknown>,
    session: AgentSession | null = null,
): AsyncIterable<AgentServerMessage> {
    const parsed = parseRunRequest(msg);
    const run = new BlobRunContext(session, {
        conversationId: parsed.conversationId,
        resourceBudget: processRunResources,
        inheritedBlobIds: [...parsed.historyBlobIds, ...parsed.historyTurnBlobIds, ...parsed.historySummaryArchiveIds],
    });

    try {
        const hasUserContent = parsed.userText || parsed.selectedImages.length > 0;
        if (!hasUserContent && !parsed.isResume && !parsed.isExecutePlan && !parsed.isBackgroundTaskCompletion && !parsed.isSummarize)
            return;
        run.checkpointWriteScope = await beginCheckpointWriteScope(parsed.conversationId, { signal: run.signal });
        if (run.checkpointWriteScope.isDeleted)
            throw new CheckpointConflictError(parsed.conversationId);
        if (parsed.runId && !parsed.isSummarize) {
            try {
                run.checkpointDelivery = new CheckpointDelivery(msg.runRequest as Record<string, unknown>);
            } catch {
                // Replay is optional; unknown future state fields must not break normal runs.
                logger.warn({ conversationId: parsed.conversationId }, '[CHECKPOINT] request cannot be fingerprinted for terminal redelivery');
            }
        }
        if (run.checkpointDelivery && (yield* run.checkpointDelivery.replayTerminalCheckpoint(run)))
            return;
        yield* claimUploadedConversationBlobs(parsed, run);
        const admittedCheckpoint = yield* admitClientCheckpoint(parsed, run);

        // The client still owns prompt bytes. Only matching checkpoint metadata is reused.
        if (admittedCheckpoint && !parsed.historyTokenDetails) {
            parsed.historyTokenDetails = admittedCheckpoint.tokenDetails;
        }

        logger.debug({ conversationId: parsed.conversationId, runId: parsed.runId, requestId: session?.requestId }, '[AGENT] checkpoint write scope admitted');

        // Explicitly attached context is required, unlike optional capability
        // catalogs below. Never replace a missing attachment with a prompt marker.
        if (collectExtraContextBlobIds(parsed).length > 0) {
            for (const blobId of new Set(collectExtraContextBlobIds(parsed))) {
                const bytes = uploadHandoff.read(parsed.conversationId, blobIdToBytes(blobId));
                if (bytes)
                    run.blobs.cacheBlob(blobId, binaryBlobDataFromClientBytes(bytes), bytes);
            }
            resolveExtraContextBlobs(parsed, run.blobs);
            const unresolvedBlobIds = [...new Set(collectExtraContextBlobIds(parsed))];
            if (unresolvedBlobIds.length > 0) {
                const results = yield* fetchBlobsFromClient({
                    run,
                    blobIds: unresolvedBlobIds.map(blobIdToBytes),
                });
                results.forEach((result, index) => {
                    const blobId = unresolvedBlobIds[index]!;
                    if (result.status === 'ok') {
                        run.blobs.cacheBlob(blobId, binaryBlobDataFromClientBytes(result.bytes), result.bytes);
                        run.blobs.markClientSaved(blobId);
                    }
                });
                const failures = results.flatMap((result, index) => result.status === 'ok'
                    ? [] : [{ blobId: unresolvedBlobIds[index]!, status: result.status, message: result.message }]);
                if (failures.length)
                    throw new BlobIntegrityError(failures);
                resolveExtraContextBlobs(parsed, run.blobs);
            }
            const missingContext = collectExtraContextBlobIds(parsed);
            if (missingContext.length)
                throw new BlobIntegrityError(missingContext.map(blobId => ({ blobId, status: 'decode-error' })));
        }

        // Cursor 3.13+ ref_only: rules / skills / subagents / mcps 四类稳定上下文位于客户端
        // transient blob, 一批取回后分别解码合入。dual 模式在 parseRunRequest 中不暴露这些
        // 引用, 因此不会重复 fetch。
        const partReferences: Array<{ partName: RequestContextPartName, blobId: Uint8Array }> = [
            { partName: 'rules', blobId: parsed.rulesBlobId },
            { partName: 'skills', blobId: parsed.skillsBlobId },
            { partName: 'subagents', blobId: parsed.subagentsBlobId },
            { partName: 'mcps', blobId: parsed.mcpsBlobId },
        ].filter((reference): reference is { partName: RequestContextPartName, blobId: Uint8Array } => reference.blobId !== undefined);
        if (partReferences.length > 0) {
            const partBytes = yield* fetchBlobsFromClient({
                run,
                blobIds: partReferences.map(reference => reference.blobId),
            });
            partReferences.forEach((reference, index) => {
                const result = partBytes[index]!;
                throwIfBlobRunInactive(run);
                const restored = result.status === 'ok'
                    && applyRequestContextPart(parsed, reference.partName, result.bytes);
                if (restored)
                    return;
                // Rules and MCP parts can carry instructions, not just discovery.
                // Skills/subagents here are catalogs; explicit attachments are inline
                // or required extra-context references handled above.
                const required = reference.partName === 'rules' || reference.partName === 'mcps'
                    || (reference.partName === 'subagents' && parsed.selectedSubagents.some(selected =>
                        !parsed.customSubagents.some(subagent => subagent.name === selected.name)));
                const status = result.status === 'ok' ? 'decode-error' : result.status;
                if (required) {
                    const contextError = new BlobIntegrityError([{
                        blobId: blobIdFromBytes(reference.blobId), status,
                        message: `Required ${reference.partName} context has no complete inline copy; refusing generation`,
                    }]);
                    contextError.message = `Required ${reference.partName} context is unavailable (${status}) and has no complete inline copy; refusing generation`;
                    logger.error({ partName: reference.partName, status }, '[AGENT] required request context unavailable; generation stopped');
                    throw contextError;
                }
                logger.warn({
                    partName: reference.partName, status,
                    unavailableCapability: reference.partName === 'skills' ? 'automatic skill discovery' : 'custom subagent discovery',
                    inlineAttachmentsPreserved: true,
                }, '[AGENT] optional request context catalog unavailable; discovery degraded');
            });
        }

        const missingSelectedSubagents = parsed.selectedSubagents.filter(selected =>
            !parsed.customSubagents.some(subagent => subagent.name === selected.name));
        if (missingSelectedSubagents.length) {
            throw new BlobIntegrityError(missingSelectedSubagents.map(selected => ({
                blobId: `(selected subagent ${selected.name})`, status: 'not-found',
                message: 'Explicitly selected subagent definition is unavailable',
            })));
        }
        throwIfBlobRunInactive(run);

        if (parsed.isSummarize) {
            yield* handleSummarizeAction(parsed, session, run);
            return;
        }

        for await (const frame of handleConversationRun(parsed, session, run)) {
            run.checkpointDelivery?.observe(frame);
            yield frame;
        }
    } catch (error) {
        if (error instanceof CheckpointConflictError) {
            throw makeByokConnectError({
                errorCode: ErrorDetails_Error.CUSTOM,
                title: 'Checkpoint version conflict; history preserved',
                detail: `${error.message} Saved history was not overwritten. Compatible legacy checkpoints and correlated completed retries recover automatically. For an unresolved branch, continue from the main chat and answer the recovery question. A deletion, unavailable recovery interaction, or a version change during recovery requires checking the current chat state before retrying. Histories are never merged automatically.`,
                isRetryable: false,
                additionalInfo: { conversationId: parsed.conversationId, errorClass: error.name },
                cause: error,
            });
        }
        const isBlobCancellation = error instanceof BlobIntegrityError
            && error.failures.length > 0
            && error.failures.every(failure => failure.status === 'cancelled');
        const isAbortSignalError = run.signal.aborted && error instanceof Error && error.name === 'AbortError';
        // Do not suppress a real persistence/restoration error merely because
        // cancellation also happened; that failure needs a diagnostic response.
        if (isAgentRunAbortedError(error) || isBlobCancellation || isAbortSignalError) {
            logger.info({
                conversationId: parsed.conversationId,
                execMessageId: isAgentRunAbortedError(error) ? error.execMessageId : undefined,
                error: error instanceof Error ? error.message : String(error),
            }, '[AGENT] run aborted by client exec control message');
            return;
        }
        if (error instanceof Error && error.name.startsWith('Blob')) {
            const retryable = 'retryable' in error && error.retryable === true;
            throw makeByokConnectError({
                errorCode: ErrorDetails_Error.CUSTOM,
                title: 'Conversation data unavailable; checkpoint preserved',
                detail: error.message,
                isRetryable: retryable,
                additionalInfo: { conversationId: parsed.conversationId, errorClass: error.name },
                cause: error,
            });
        }
        throw error;
    } finally {
        run.dispose();
    }
}
