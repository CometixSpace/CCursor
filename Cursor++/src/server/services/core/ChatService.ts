/**
 * aiserver.v1.ChatService — 统一对话服务
 *
 * 14 方法，Cursor 新版统一对话入口:
 *   - StreamUnifiedChatWithTools (bidi) — 主力对话流，支持工具调用
 *   - StreamUnifiedChatWithToolsSSE/Poll — SSE/轮询降级变体
 *   - StreamUnifiedChatWithToolsIdempotent — 幂等版本
 *   - StreamUnifiedChat — 旧版流式对话
 *   - GetConversationSummary, StreamSpeculativeSummaries — 对话摘要
 *   - StreamFullFileCmdK — 全文件 CmdK
 *   - GetPromptDryRun, ConvertOALToNAL — 调试/转换
 *
 * Transport: backendUrl (api2.cursor.sh)
 *   部分方法有 transport 覆盖:
 *     - StreamUnifiedChatWithTools, Idempotent, Warm → agenticComposerTransport (bidi)
 *
 * TODO: 实现 LLM 翻译层，将 Cursor 对话协议转换为 Anthropic/OpenAI/Gemini API 调用
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { ChatService, StreamUnifiedChatRequestSchema, type StreamUnifiedChatRequest } from '../../gen/aiserver_v1_pb';
import { buildConversationSummary, buildSpeculativeConversationSummaries } from '../../handlers/chat/summary';
import { getLatestConversationSummary, persistConversationSummaries } from '../../database/chatSummaries';
import { logger } from '../../logger';

async function withPersistedPreviousSummary(req: StreamUnifiedChatRequest): Promise<StreamUnifiedChatRequest> {
    if (req.conversationSummary || !req.conversationId) {
        return req;
    }

    const persistedSummary = await getLatestConversationSummary(req.conversationId);
    if (!persistedSummary) {
        return req;
    }

    return create(StreamUnifiedChatRequestSchema, {
        ...req,
        conversationSummary: persistedSummary,
    });
}

export default (router: ConnectRouter) => {
    router.service(ChatService, {
        getConversationSummary: async (req) => {
            const hydratedReq = await withPersistedPreviousSummary(req);
            const summary = buildConversationSummary(hydratedReq);
            await persistConversationSummaries(hydratedReq.conversationId, 'latest', [summary]);
            logger.info({
                conversationId: hydratedReq.conversationId,
                messageCount: hydratedReq.conversation.length,
                truncationLastBubbleIdInclusive: summary.truncationLastBubbleIdInclusive,
                resumeBubbleId: summary.clientShouldStartSendingFromInclusiveBubbleId,
                includesToolResults: summary.includesToolResults,
                strategy: summary.strategy,
                usedPersistedPreviousSummary: !req.conversationSummary && hydratedReq.conversationSummary !== undefined,
            }, '[SVC] chat conversation summary generated');
            return summary;
        },

        async *streamSpeculativeSummaries(req) {
            const hydratedReq = await withPersistedPreviousSummary(req);
            const summaries = buildSpeculativeConversationSummaries(hydratedReq);
            await persistConversationSummaries(hydratedReq.conversationId, 'speculative', summaries);
            logger.info({
                conversationId: hydratedReq.conversationId,
                messageCount: hydratedReq.conversation.length,
                candidateCount: summaries.length,
                truncationLastBubbleIdsInclusive: summaries.map(summary => summary.truncationLastBubbleIdInclusive),
                usedPersistedPreviousSummary: !req.conversationSummary && hydratedReq.conversationSummary !== undefined,
            }, '[SVC] chat speculative summaries generated');
            for (const summary of summaries) {
                yield summary;
            }
        },
    });
};
