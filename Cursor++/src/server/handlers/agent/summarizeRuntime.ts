import { randomUUID } from 'crypto';
import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { workspaceUris, type ParsedRunRequest } from './protocol';
import type { AgentSession } from './session';
import { heartbeat, checkpoint, summaryCompleted, summaryStarted } from './stream';
import { clampTokenDetails, computeContextUsagePercent } from './usage';
import { resolveProviderRuntime } from '../llm';
import type { BlobRunContext } from './runContext';
import { loadHistoryEntries, repairHistoryEntries } from './historyManager';
import { measureMessagesTokens, planCompaction } from './compactionStrategy';
import { releaseCompactionLock, tryAcquireCompactionLock } from './compactionLock';
import { executeCompaction, waitForRunCompactionLockRelease } from './compactionExecution';
import { executePreCompactHook } from './hookRuntime';
import { logger } from '../../logger';
import { saveRunCheckpoint, throwIfBlobRunInactive } from './checkpointManager';

export async function* handleSummarizeAction(
    parsed: ParsedRunRequest,
    session: AgentSession | null,
    run: BlobRunContext,
): AsyncIterable<AgentServerMessage> {
    throwIfBlobRunInactive(run);
    const route = resolveProviderRuntime(parsed.modelId);
    // Release wakes every waiter; only a successful acquire grants lock ownership.
    while (!tryAcquireCompactionLock(parsed.conversationId))
        yield* waitForRunCompactionLockRelease(parsed.conversationId, run);
    try {
        throwIfBlobRunInactive(run);
        yield* handleSummarizeActionLocked(parsed, session, route, run);
    }
    finally {
        releaseCompactionLock(parsed.conversationId);
    }
}

async function* handleSummarizeActionLocked(
    parsed: ParsedRunRequest,
    session: AgentSession | null,
    route: ReturnType<typeof resolveProviderRuntime>,
    run: BlobRunContext,
): AsyncIterable<AgentServerMessage> {
    // 历史 blob 与对话路径同源: 内存未命中的经 getBlobArgs 向客户端取
    const hydratedHistoryEntries = yield* loadHistoryEntries({
        historyBlobIds: parsed.historyBlobIds,
        run,
    });
    const historyEntries = repairHistoryEntries(hydratedHistoryEntries, run.blobs);
    const contextTokenLimit = parsed.historyTokenDetails?.maxTokens ?? parsed.contextTokenLimit ?? route.contextTokenLimit;
    const compactionPlan = planCompaction(historyEntries, { contextTokenLimit });
    const currentTokenDetails = clampTokenDetails(
        parsed.historyTokenDetails?.usedTokens ?? measureMessagesTokens(historyEntries.map(entry => entry.message)),
        contextTokenLimit,
    );
    const contextUsagePercent = computeContextUsagePercent(currentTokenDetails.usedTokens, currentTokenDetails.maxTokens);
    const generationId = randomUUID();

    logger.info({
        conversationId: parsed.conversationId,
        model: route.model,
        historyBlobIds: parsed.historyBlobIds.length,
        hydratedEntries: hydratedHistoryEntries.length,
        summarizeEntries: compactionPlan.summarizeEntries.length,
        keepTail: compactionPlan.keepTail.length,
        contextUsagePercent: contextUsagePercent.toFixed(1),
        usedTokens: currentTokenDetails.usedTokens,
        maxTokens: currentTokenDetails.maxTokens,
    }, '[SUMMARIZE] action started');

    yield heartbeat();

    const hookMessage = yield* executePreCompactHook({
        session,
        conversationId: parsed.conversationId,
        generationId,
        modelId: parsed.modelId,
        contextUsagePercent,
        contextTokens: currentTokenDetails.usedTokens,
        contextWindowSize: currentTokenDetails.maxTokens,
        messageCount: historyEntries.length,
        messagesToCompact: compactionPlan.summarizeEntries.length,
        isFirstCompaction: parsed.historySummaryArchiveIds.length === 0,
        execMessageId: 1,
    });

    throwIfBlobRunInactive(run);
    yield summaryStarted();
    throwIfBlobRunInactive(run);

    if (compactionPlan.summarizeEntries.length === 0) {
        // F2: mode==='disabled' 时 plan 同样返回空 summarizeEntries, 但语义是
        // "压缩结构性不可行" (leading 过大/窗口过小), 不是"已经够紧凑" — 文案须区分
        if (compactionPlan.mode === 'disabled') {
            logger.warn({
                conversationId: parsed.conversationId,
                contextTokenLimit,
                leadingTokens: compactionPlan.diagnostics.leadingTokens,
            }, '[AUTOCOMPACT] summarizeAction skipped — compaction structurally infeasible for this window');
        }
        logger.info({
            conversationId: parsed.conversationId,
            origin: 'client_summarize',
            kind: 'committed',
            usedTokens: currentTokenDetails.usedTokens,
            maxTokens: currentTokenDetails.maxTokens,
            rootBlobCount: parsed.historyBlobIds.length,
            summaryArchiveCount: parsed.historySummaryArchiveIds.length,
        }, '[AUTOCOMPACT] checkpoint write');
        yield* saveRunCheckpoint(run, {
            kind: 'committed',
            conversationId: parsed.conversationId,
            rootBlobIds: parsed.historyBlobIds,
            turnBlobIds: parsed.historyTurnBlobIds,
            summaryArchiveIds: parsed.historySummaryArchiveIds,
            tokenDetails: currentTokenDetails,
            mode: parsed.mode,
        });

        throwIfBlobRunInactive(run);
        yield summaryCompleted(hookMessage ?? (compactionPlan.mode === 'disabled'
            ? 'Compaction unavailable: system prompt plus reserves exceed this model\'s usable context window. Consider a larger-context model.'
            : 'Conversation already compact enough.'));
        throwIfBlobRunInactive(run);
        yield checkpoint(
            parsed.historyBlobIds,
            currentTokenDetails.usedTokens,
            currentTokenDetails.maxTokens,
            parsed.mode,
            undefined,
            {
                turnBlobIds: parsed.historyTurnBlobIds,
                summaryArchiveIds: parsed.historySummaryArchiveIds,
                workspaceUris: workspaceUris(parsed),
                readPaths: parsed.readPaths,
                modelName: route.model,
                gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
            },
        );
        return;
    }

    const { artifacts, tokenDetails: compactedUsedTokens } = yield* executeCompaction({
        run,
        conversationId: parsed.conversationId,
        origin: 'client_summarize',
        plan: compactionPlan,
        route,
        contextTokenLimit,
        turnBlobIds: parsed.historyTurnBlobIds,
        previousSummaryArchiveIds: parsed.historySummaryArchiveIds,
        mode: parsed.mode,
    });

    throwIfBlobRunInactive(run);
    yield checkpoint(
        artifacts.nextRootBlobIds,
        compactedUsedTokens.usedTokens,
        compactedUsedTokens.maxTokens,
        parsed.mode,
        undefined,
        {
            turnBlobIds: parsed.historyTurnBlobIds,
            summaryArchiveIds: artifacts.nextSummaryArchiveIds,
            workspaceUris: workspaceUris(parsed),
            readPaths: parsed.readPaths,
            modelName: route.model,
            gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
        },
    );
    throwIfBlobRunInactive(run);
    yield summaryCompleted(hookMessage ?? 'Chat context summarized.');
}
