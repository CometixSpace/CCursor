import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { checkpoint } from './stream';
import { clampTokenDetails, computeContextUsagePercent, type UsageTotals } from './usage';
import { summarizeAssistantContent } from './transcript';
import { persistConversationCheckpoint } from '../../database/checkpoints';
import type { LLMContentBlock } from '../llm/types';
import { logger } from '../../logger';

export function emitRollingCheckpoint(params: {
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
}): AgentServerMessage {
    const rollingAssistantSummary = summarizeAssistantContent(params.lastAssistantContent);
    const rollingTokenDetails = clampTokenDetails(params.usedTokensEstimate, params.contextTokenLimit);
    const rollingContextUsagePercent = computeContextUsagePercent(
        rollingTokenDetails.usedTokens,
        rollingTokenDetails.maxTokens,
    );

    logger.info({
        conversationId: params.conversationId,
        round: params.round,
        nextBlobbedMessageIndex: params.nextBlobbedMessageIndex,
        rollingTokenDetails,
        rollingContextUsagePercent,
        usageTotals: params.usageTotals,
    }, '[SESSION] round checkpoint update');

    persistConversationCheckpoint({
        conversationId: params.conversationId,
        kind: 'draft',
        rootBlobIds: params.allBlobIds,
        turnBlobIds: params.turnBlobIds,
        summaryArchiveIds: params.summaryArchiveIds,
        tokenDetails: rollingTokenDetails,
        mode: params.mode,
        updatedAt: Date.now(),
    });

    return checkpoint(
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

export function emitFinalCheckpoint(params: {
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
}): AgentServerMessage {
    const assistantSummary = summarizeAssistantContent(params.lastAssistantContent);
    const tokenDetails = clampTokenDetails(params.usedTokensEstimate, params.contextTokenLimit);
    const contextUsagePercent = computeContextUsagePercent(tokenDetails.usedTokens, tokenDetails.maxTokens);

    logger.info({
        conversationId: params.conversationId,
        blocks: params.lastAssistantContent?.length ?? 0,
        types: params.lastAssistantContent?.map(b => b.type) ?? [],
        thinkingLen: assistantSummary.thinking?.length ?? 0,
        textLen: assistantSummary.text?.length ?? 0,
        tokenDetails,
        contextUsagePercent,
        usageTotals: params.usageTotals,
    }, '[SESSION] checkpoint assistant content');

    persistConversationCheckpoint({
        conversationId: params.conversationId,
        kind: 'committed',
        rootBlobIds: params.allBlobIds,
        turnBlobIds: params.turnBlobIds,
        summaryArchiveIds: params.summaryArchiveIds,
        tokenDetails,
        mode: params.mode,
        updatedAt: Date.now(),
    });

    return checkpoint(
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
}
