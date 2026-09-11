/**
 * LLM 用量采集 — provider 透明包装层
 *
 * withUsageRecording(inner, meta) 返回一个与 inner 行为完全一致的 LLMProvider:
 *   - 透传每个流事件, 不吞事件、不改语义
 *   - 不捕获流本身的错误 (上游 agent 循环依赖原始错误做重试/中断)
 *   - 遇到 done 事件时 fire-and-forget 落库用量 (recordModelUsage 内部
 *     全量 try/catch + .catch 兜底, DB 故障对流零影响)
 *
 * 唯一埋点: resolveProviderRuntime() — 覆盖 agent 主循环 / 压缩摘要 / 子代理全部调用路径。
 */
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from './types';
import { recordModelUsage } from '../../database/usageStats';
import { withProviderRequestLifecycle } from './requestLifecycle';

export interface UsageRecordingMeta {
    providerId: string;
    providerName: string;
    /** Cursor 模型选择器里的 byok modelId (统计桶主键) */
    modelId: string;
    /** provider 实际请求的 api 模型名 */
    apiModel: string;
}

export function withUsageRecording(inner: LLMProvider, meta: UsageRecordingMeta): LLMProvider {
    return {
        name: inner.name,
        stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
            async function* recordEvents(signal: AbortSignal): AsyncIterable<LLMStreamEvent> {
                for await (const event of inner.stream({ ...request, signal })) {
                    if (event.type === 'done') {
                        // fire-and-forget: 不 await、不抛错 — 用量统计绝不阻塞/干扰 LLM 流
                        void recordModelUsage({ ...meta, usage: event.usage }).catch(() => {});
                    }
                    yield event;
                }
            }
            // Keep creation lazy, but abort before a pending generator queues return/throw.
            return withProviderRequestLifecycle(lifecycle => recordEvents(lifecycle.signal), request.signal);
        },
    };
}
