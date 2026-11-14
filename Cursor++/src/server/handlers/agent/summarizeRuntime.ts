import { randomUUID } from 'crypto';
import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import { workspaceUris, type ParsedRunRequest } from './protocol';
import type { AgentSession } from './session';
import { heartbeat, checkpoint, kvMessage, summary, summaryCompleted, summaryStarted } from './stream';
import { clampTokenDetails, computeContextUsagePercent } from './usage';
import { resolveProviderRuntime } from '../llm';
import { hydrateHistoryEntries, repairHistoryEntries } from './historyManager';
import { createCompactionArtifacts, estimateMessagesTokens, formatMessageForSummary, planCompaction } from './compactionStrategy';
import { executePreCompactHook } from './hookRuntime';
import { persistConversationCheckpoint } from '../../database/checkpoints';
import { SUMMARY_SYSTEM_PROMPT, buildSummaryUserMessage } from './summaryPrompt';
import { logger } from '../../logger';

export async function* handleSummarizeAction(
    parsed: ParsedRunRequest,
    session: AgentSession | null,
): AsyncIterable<AgentServerMessage> {
    const route = resolveProviderRuntime(parsed.modelId);
    const hydratedHistoryEntries = hydrateHistoryEntries(parsed.historyBlobIds);
    const missingHistoryBlobs = Math.max(0, parsed.historyBlobIds.length - hydratedHistoryEntries.length);
    const historyEntries = repairHistoryEntries(hydratedHistoryEntries);
    const currentTokenDetails = clampTokenDetails(
        parsed.historyTokenDetails?.usedTokens ?? estimateMessagesTokens(historyEntries.map(entry => entry.message)),
        parsed.historyTokenDetails?.maxTokens ?? parsed.contextTokenLimit ?? route.contextTokenLimit,
    );
    // 压缩策略看的窗口大小与 run 路径同源, 0 表示未知。currentTokenDetails.maxTokens 是给客户端
    // 显示用的, 已被钳到至少 1, 拿它做判断会把 "未知" 当成 "只有 1 个 token 的窗口"。
    const contextTokenLimit = parsed.contextTokenLimit ?? route.contextTokenLimit;
    const compactionPlan = planCompaction(historyEntries, contextTokenLimit);
    const contextUsagePercent = computeContextUsagePercent(currentTokenDetails.usedTokens, currentTokenDetails.maxTokens);
    const generationId = randomUUID();

    logger.info({
        conversationId: parsed.conversationId,
        model: route.model,
        historyBlobIds: parsed.historyBlobIds.length,
        hydratedEntries: hydratedHistoryEntries.length,
        missingBlobs: missingHistoryBlobs,
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

    yield summaryStarted();

    if (missingHistoryBlobs > 0) {
        logger.warn({
            conversationId: parsed.conversationId,
            requestedBlobs: parsed.historyBlobIds.length,
            resolvedBlobs: hydratedHistoryEntries.length,
            missingHistoryBlobs,
        }, '[AGENT] summarizeAction skipped due to incomplete history');

        persistConversationCheckpoint({
            kind: 'committed',
            conversationId: parsed.conversationId,
            rootBlobIds: parsed.historyBlobIds,
            turnBlobIds: parsed.historyTurnBlobIds,
            summaryArchiveIds: parsed.historySummaryArchiveIds,
            tokenDetails: currentTokenDetails,
            mode: parsed.mode,
            updatedAt: Date.now(),
        });

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
        yield summaryCompleted(hookMessage ?? 'Compaction deferred: conversation history is incomplete.');
        return;
    }

    if (compactionPlan.summarizeEntries.length === 0) {
        persistConversationCheckpoint({
            kind: 'committed',
            conversationId: parsed.conversationId,
            rootBlobIds: parsed.historyBlobIds,
            turnBlobIds: parsed.historyTurnBlobIds,
            summaryArchiveIds: parsed.historySummaryArchiveIds,
            tokenDetails: currentTokenDetails,
            mode: parsed.mode,
            updatedAt: Date.now(),
        });

        yield summaryCompleted(hookMessage ?? 'Conversation already compact enough.');
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

    const summarySourceText = compactionPlan.summarizeEntries
        .map(entry => formatMessageForSummary(entry.message))
        .filter(text => text.length > 0)
        .join('\n\n');

    let summaryText = '';
    const llmStartTime = Date.now();
    logger.info({
        conversationId: parsed.conversationId,
        model: route.model,
        sourceTextLen: summarySourceText.length,
        summarizeEntries: compactionPlan.summarizeEntries.length,
        keepTail: compactionPlan.keepTail.length,
    }, '[SUMMARIZE] LLM summary starting');

    let lastHeartbeatTime = Date.now();
    try {
        const llmStream = route.provider.stream({
            model: route.model,
            thinking: false,
            messages: [
                { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
                { role: 'user', content: buildSummaryUserMessage(summarySourceText) },
            ],
        });

        for await (const event of llmStream) {
            if (event.type === 'text_delta') {
                summaryText += event.text;
                yield summary(event.text);
            }
            // LLM 生成期间持续 yield heartbeat, 防止客户端 stall detector 误判
            if (Date.now() - lastHeartbeatTime >= 4000) {
                yield heartbeat();
                lastHeartbeatTime = Date.now();
            }
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message, durationMs: Date.now() - llmStartTime }, '[SUMMARIZE] LLM failed, falling back to local summary');
    }

    logger.info({
        conversationId: parsed.conversationId,
        summaryLen: summaryText.length,
        durationMs: Date.now() - llmStartTime,
    }, '[SUMMARIZE] LLM summary done');

    summaryText = summaryText.trim();
    if (!summaryText) {
        summaryText = summarySourceText
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 12)
            .map(line => `- ${line.replace(/^-\s*/, '')}`)
            .join('\n')
            .slice(0, 4000);
    }
    if (!summaryText) {
        summaryText = '- Prior conversation compacted.';
    }

    const artifacts = createCompactionArtifacts({
        plan: compactionPlan,
        summaryText,
        previousSummaryArchiveIds: parsed.historySummaryArchiveIds,
    });

    yield kvMessage(1, artifacts.summaryBlobId, artifacts.summaryBlobData);
    for (const [index, archiveBlob] of artifacts.archiveBlobs.entries()) {
        yield kvMessage(2 + index, archiveBlob.blobId, archiveBlob.blobData, archiveBlob.blobDataRaw);
    }

    const compactedUsedTokens = clampTokenDetails(
        estimateMessagesTokens([
            ...compactionPlan.leading.map(entry => entry.message),
            { role: 'assistant', content: `Previous conversation summary:\n${artifacts.summaryText}` },
            ...compactionPlan.keepTail.map(entry => entry.message),
        ]),
        currentTokenDetails.maxTokens,
    );

    persistConversationCheckpoint({
        kind: 'committed',
        conversationId: parsed.conversationId,
        rootBlobIds: artifacts.nextRootBlobIds,
        turnBlobIds: parsed.historyTurnBlobIds,
        summaryArchiveIds: artifacts.nextSummaryArchiveIds,
        tokenDetails: compactedUsedTokens,
        mode: parsed.mode,
        updatedAt: Date.now(),
    });

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
    yield summaryCompleted(hookMessage ?? 'Chat context summarized.');
}
