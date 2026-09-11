import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { checkpoint } from './stream';
import { clampTokenDetails, computeContextUsagePercent, shouldTriggerCompaction, type UsageTotals } from './usage';
import { summarizeAssistantContent } from './transcript';
import { persistConversationCheckpoint, type PersistedConversationCheckpoint } from '../../database/checkpoints';
import type { LLMContentBlock } from '../llm/types';
import { logger } from '../../logger';
import type { BlobRunContext } from './runContext';
import { saveCheckpointBlobs } from './clientBlobFetch';
import { AgentRunAbortedError, throwIfSessionCancelled } from './wait';

export function throwIfBlobRunInactive(run: BlobRunContext): void {
    if (run.signal.aborted)
        throw new AgentRunAbortedError('blob run was cancelled or disposed');
    if (!run.session)
        return;
    throwIfSessionCancelled(run.session);
    if (run.session.closed)
        throw new AgentRunAbortedError('client disconnected from the run');
}

/** Save all referenced blobs before a scoped write; callers own UI frame ordering. */
export async function* saveRunCheckpoint(
    run: BlobRunContext,
    state: Omit<PersistedConversationCheckpoint, 'updatedAt'>,
    terminalCheckpoint?: AgentServerMessage,
): AsyncGenerator<AgentServerMessage, void, void> {
    throwIfBlobRunInactive(run);
    yield* saveCheckpointBlobs(run, [
        ...state.rootBlobIds,
        ...state.turnBlobIds,
        ...state.summaryArchiveIds,
    ]);
    throwIfBlobRunInactive(run);
    // Only final publication creates a receipt, and only after successful Set ACKs.
    const terminalReceiptJson = terminalCheckpoint
        ? run.checkpointDelivery?.createTerminalReceipt(terminalCheckpoint)
        : undefined;
    await persistConversationCheckpoint({
        ...state,
        updatedAt: Date.now(),
    }, run.signal, run.requireCheckpointWriteScope(), terminalReceiptJson);
    throwIfBlobRunInactive(run);
}

export async function* emitRollingCheckpoint(params: {
    run: BlobRunContext;
    conversationId: string;
    round: number;
    nextBlobbedMessageIndex: number;
    allBlobIds: string[];
    turnBlobIds: string[];
    summaryArchiveIds: string[];
    usedTokensEstimate: number;
    contextTokenLimit: number;
    mode: string;
    lastAssistantContent: LLMContentBlock[] | undefined;
    usageTotals: UsageTotals;
    workspaceUris?: string[];
    /** 当前 provider runtime 的 model name, 用于 reasoning block 的 providerOptions.cursor.modelName */
    modelName?: string;
    /** 本次会话中已经读过的文件路径 (Read 工具目标), 未来接入 P5 时从 tool registry 提取 */
    readPaths?: string[];
    /** 当前工作区的 git repo 列表, 用于 ConversationStateStructure.trackedGitRepoBranches / activeBranchName */
    gitRepos?: Array<{ path: string, branchName: string }>;
    /** Context Window breakdown 分类 token 明细 */
    breakdownCategories?: Array<{ id: string, label: string, estimatedTokens: number }>;
}): AsyncGenerator<AgentServerMessage, void, void> {
    throwIfBlobRunInactive(params.run);
    const rollingAssistantSummary = summarizeAssistantContent(params.lastAssistantContent);
    const rollingTokenDetails = clampTokenDetails(params.usedTokensEstimate, params.contextTokenLimit);
    const rollingContextUsagePercent = computeContextUsagePercent(
        rollingTokenDetails.usedTokens,
        rollingTokenDetails.maxTokens,
    );

    logger.info({
        conversationId: params.conversationId,
        origin: 'rolling',
        round: params.round,
        nextBlobbedMessageIndex: params.nextBlobbedMessageIndex,
        rollingTokenDetails,
        rollingContextUsagePercent,
        shouldTriggerCompaction: shouldTriggerCompaction(
            rollingTokenDetails.usedTokens,
            rollingTokenDetails.maxTokens,
        ),
        usageTotals: params.usageTotals,
    }, '[SESSION] round checkpoint update');

    yield* saveRunCheckpoint(params.run, {
        conversationId: params.conversationId,
        kind: 'draft',
        rootBlobIds: params.allBlobIds,
        turnBlobIds: params.turnBlobIds,
        summaryArchiveIds: params.summaryArchiveIds,
        tokenDetails: rollingTokenDetails,
        mode: params.mode,
    });

    throwIfBlobRunInactive(params.run);
    yield checkpoint(
        params.allBlobIds,
        rollingTokenDetails.usedTokens,
        rollingTokenDetails.maxTokens,
        params.mode,
        rollingAssistantSummary,
        {
            turnBlobIds: params.turnBlobIds,
            summaryArchiveIds: params.summaryArchiveIds,
            workspaceUris: params.workspaceUris,
            readPaths: params.readPaths,
            modelName: params.modelName,
            gitRepos: params.gitRepos,
            breakdownCategories: params.breakdownCategories,
        },
    );
}

export async function* emitFinalCheckpoint(params: {
    run: BlobRunContext;
    conversationId: string;
    allBlobIds: string[];
    turnBlobIds: string[];
    summaryArchiveIds: string[];
    usedTokensEstimate: number;
    contextTokenLimit: number;
    mode: string;
    lastAssistantContent: LLMContentBlock[] | undefined;
    usageTotals: UsageTotals;
    workspaceUris?: string[];
    /** 当前 provider runtime 的 model name, 用于 reasoning block 的 providerOptions.cursor.modelName */
    modelName?: string;
    /** 本次会话中已经读过的文件路径 (Read 工具目标), 未来接入 P5 时从 tool registry 提取 */
    readPaths?: string[];
    /** 当前工作区的 git repo 列表, 用于 ConversationStateStructure.trackedGitRepoBranches / activeBranchName */
    gitRepos?: Array<{ path: string, branchName: string }>;
    /** Context Window breakdown 分类 token 明细 */
    breakdownCategories?: Array<{ id: string, label: string, estimatedTokens: number }>;
}): AsyncGenerator<AgentServerMessage, void, void> {
    throwIfBlobRunInactive(params.run);
    const assistantSummary = summarizeAssistantContent(params.lastAssistantContent);
    const tokenDetails = clampTokenDetails(params.usedTokensEstimate, params.contextTokenLimit);
    const contextUsagePercent = computeContextUsagePercent(tokenDetails.usedTokens, tokenDetails.maxTokens);

    logger.info({
        conversationId: params.conversationId,
        origin: 'final',
        blocks: params.lastAssistantContent?.length ?? 0,
        types: params.lastAssistantContent?.map(b => b.type) ?? [],
        thinkingLen: assistantSummary.thinking?.length ?? 0,
        textLen: assistantSummary.text?.length ?? 0,
        tokenDetails,
        contextUsagePercent,
        shouldTriggerCompaction: shouldTriggerCompaction(tokenDetails.usedTokens, tokenDetails.maxTokens),
        usageTotals: params.usageTotals,
    }, '[SESSION] checkpoint assistant content');

    const finalCheckpoint = checkpoint(
        params.allBlobIds,
        tokenDetails.usedTokens,
        tokenDetails.maxTokens,
        params.mode,
        assistantSummary,
        {
            turnBlobIds: params.turnBlobIds,
            summaryArchiveIds: params.summaryArchiveIds,
            workspaceUris: params.workspaceUris,
            readPaths: params.readPaths,
            modelName: params.modelName,
            gitRepos: params.gitRepos,
            breakdownCategories: params.breakdownCategories,
        },
    );
    yield* saveRunCheckpoint(params.run, {
        conversationId: params.conversationId,
        kind: 'committed',
        rootBlobIds: params.allBlobIds,
        turnBlobIds: params.turnBlobIds,
        summaryArchiveIds: params.summaryArchiveIds,
        tokenDetails,
        mode: params.mode,
    }, finalCheckpoint);

    throwIfBlobRunInactive(params.run);
    yield finalCheckpoint;
}
