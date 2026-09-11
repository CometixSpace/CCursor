/**
 * Anthropic Claude Provider
 *
 * 实现 LLMProvider 接口，封装 @anthropic-ai/sdk。
 *
 * 思考模式分支 (Claude 4.x / 4.5 / 4.6):
 *   1. 用户配了 thinkingLevel →
 *        thinking: { type: 'adaptive' } + output_config: { effort }
 *        适用于 Claude Opus 4.5 / Opus 4.6 / Sonnet 4.6 (官方 "adaptive thinking + effort" 姿势)
 *   2. 用户配了 thinkingBudgetTokens →
 *        thinking: { type: 'enabled', budget_tokens: N }
 *        适用于老 4.x (没有 effort 参数) 或手动控制 budget 的场景
 *   3. 都没配但 thinking:true →
 *        fallback: thinking: { type: 'enabled', budget_tokens: min(maxTokens-1, 32768) }
 *        保留旧行为,兼容未升级配置
 *
 * Level → effort 映射:
 *   minimal → low (Anthropic 没有 minimal 档)
 *   low / medium / high → 同名
 *   xhigh → max  (只在 4.6 可用)
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ProviderEntry } from '../../data/defaults';
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from './types';
import { assertValidAnthropicToolUseContract } from './anthropicContract';
import { applyAnthropicCacheBreakpoints, encodeAnthropicRequestMessages, encodeAnthropicTools } from './conversationCodec';
import { logger } from '../../logger';
import { createProxiedFetch } from './proxyFetch';
import { createTransformDiagnostics, hasTransformMutations, transformMessages } from './transformMessages';
import { buildDefaultHeaders } from './userAgent';
import { withProviderRequestLifecycle } from './requestLifecycle';

type AnthropicEffort = 'low' | 'medium' | 'high' | 'max';

function mapThinkingLevelToAnthropicEffort(level: NonNullable<LLMStreamRequest['thinkingLevel']>): AnthropicEffort {
    switch (level) {
        case 'minimal': return 'low';     // Anthropic 无 minimal,降级
        case 'low': return 'low';
        case 'medium': return 'medium';
        case 'high': return 'high';
        case 'xhigh': return 'max';       // Anthropic SDK effort 最高档为 max
        case 'max': return 'max';
    }
}

export class AnthropicProvider implements LLMProvider {
    readonly name = 'anthropic';
    private client: Anthropic;

    constructor(entry: ProviderEntry) {
        const opts: ConstructorParameters<typeof Anthropic>[0] = {};
        if (entry.baseUrl) {
            opts.baseURL = entry.baseUrl;
        }

        if (entry.auth.kind === 'token') {
            opts.authToken = entry.auth.value;
        } else {
            opts.apiKey = entry.auth.value;
        }

        opts.fetch = createProxiedFetch(entry.proxyUrl);

        const headers = buildDefaultHeaders('anthropic', entry.headers);
        if (headers) {
            opts.defaultHeaders = headers;
        }

        this.client = new Anthropic(opts);
    }

    stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        return withProviderRequestLifecycle(lifecycle => this.streamRequest({ ...request, signal: lifecycle.signal }), request.signal);
    }

    private async *streamRequest(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        const diagnostics = createTransformDiagnostics('anthropic', request.messages.length);
        const transformed = transformMessages(request.messages, 'anthropic', diagnostics, request.model);
        if (hasTransformMutations(diagnostics)) {
            logger.debug({
                provider: 'anthropic',
                model: request.model,
                ...diagnostics,
            }, '[HISTORY_REPAIR] provider conversation transformed');
        }
        const encoded = encodeAnthropicRequestMessages(transformed);
        const cached = applyAnthropicCacheBreakpoints(encoded.system, encoded.messages);
        assertValidAnthropicToolUseContract(cached.messages);

        const params: Anthropic.MessageCreateParamsStreaming = {
            model: request.model,
            max_tokens: request.maxTokens ?? 8192,
            messages: cached.messages,
            stream: true,
        };

        if (cached.system) {
            params.system = cached.system;
        }

        const tools = encodeAnthropicTools(request.tools);
        if (tools) {
            params.tools = tools;
        }

        // effort 参数官方允许独立于 thinking 使用 (控制整体 token 消耗 + tool 调用详略),
        // 因此 thinkingLevel 不受 request.thinking 的 gate 限制 —— 只要配了就发。
        if (request.thinkingLevel) {
            params.output_config = {
                effort: mapThinkingLevelToAnthropicEffort(request.thinkingLevel),
            };
        }

        if (request.thinking) {
            const maxTok = request.maxTokens ?? 8192;
            if (request.thinkingLevel) {
                // 4.5-opus / 4.6+ 的 adaptive thinking + effort 组合 (effort 上面已发)
                params.thinking = { type: 'adaptive' };
            }
            else if (request.thinkingBudgetTokens !== undefined) {
                // 老路径: 显式 budget_tokens (clamp 到 [1024, maxTokens-1])
                const clamped = Math.max(1024, Math.min(request.thinkingBudgetTokens, maxTok - 1));
                params.thinking = { type: 'enabled', budget_tokens: clamped };
            }
            else {
                // 默认 fallback —— 保持旧行为 (legacy budget)
                params.thinking = {
                    type: 'enabled',
                    budget_tokens: Math.min(maxTok - 1, 32768),
                };
            }
        }

        // 构建 beta headers: thinking → interleaved-thinking, 1M context 等按需追加
        const betas: string[] = [];
        if (request.thinking)
            betas.push('interleaved-thinking-2025-05-14');
        if (request.anthropicBetas)
            betas.push(...request.anthropicBetas.filter(b => !betas.includes(b)));

        const stream = betas.length > 0
            ? this.client.beta.messages.stream({ ...params, betas } as any, { signal: request.signal })
            : this.client.messages.stream(params, { signal: request.signal });
        const contentBlocks = new Map<number, { type: string; id?: string; name?: string; signature?: string }>();

        for await (const event of stream) {
            switch (event.type) {
                case 'content_block_start': {
                    const block = event.content_block;
                    if (block.type === 'tool_use') {
                        contentBlocks.set(event.index, { type: block.type, id: block.id, name: block.name });
                        yield { type: 'tool_use_start', id: block.id, name: block.name };
                    } else if (block.type === 'thinking') {
                        contentBlocks.set(event.index, { type: block.type, signature: '' });
                    } else {
                        contentBlocks.set(event.index, { type: block.type });
                    }
                    break;
                }
                case 'content_block_delta': {
                    const blockMeta = contentBlocks.get(event.index);
                    const delta = event.delta;
                    if (delta.type === 'text_delta') {
                        yield { type: 'text_delta', text: delta.text };
                    } else if (delta.type === 'thinking_delta') {
                        yield { type: 'thinking_delta', text: delta.thinking };
                    } else if ((delta as any).type === 'signature_delta' && blockMeta?.type === 'thinking') {
                        blockMeta.signature = (blockMeta.signature ?? '') + (delta as any).signature;
                    } else if (delta.type === 'input_json_delta') {
                        yield {
                            type: 'tool_use_delta',
                            id: blockMeta?.id ?? '',
                            input: delta.partial_json,
                        };
                    }
                    break;
                }
                case 'content_block_stop': {
                    const blockMeta = contentBlocks.get(event.index);
                    if (blockMeta?.type === 'thinking') {
                        yield { type: 'thinking_done', signature: blockMeta.signature };
                    } else if (blockMeta?.type === 'tool_use' && blockMeta.id) {
                        yield { type: 'tool_use_done', id: blockMeta.id };
                    }
                    contentBlocks.delete(event.index);
                    break;
                }
                default:
                    break;
            }
        }

        const finalMessage = await stream.finalMessage();
        const cacheRead = finalMessage.usage.cache_read_input_tokens ?? 0;
        const cacheWrite = finalMessage.usage.cache_creation_input_tokens ?? 0;
        if (cacheRead || cacheWrite) {
            logger.info({
                model: request.model,
                cacheRead,
                cacheWrite,
                input: finalMessage.usage.input_tokens,
            }, '[ANTHROPIC] prompt cache');
        }
        // Anthropic 的 input_tokens 不含 cache_read/cache_creation (三者互不相交)。
        // 归一成"完整 prompt 规模"口径 (与 OpenAI prompt_tokens / Gemini promptTokenCount 一致),
        // auto-compaction 的触发判定依赖该口径; 若只上报裸 input_tokens, 缓存命中轮会严重低估。
        const fullPromptTokens = (finalMessage.usage.input_tokens ?? 0) + cacheRead + cacheWrite;
        yield {
            type: 'done',
            stopReason: finalMessage.stop_reason ?? 'end_turn',
            usage: {
                inputTokens: fullPromptTokens,
                outputTokens: finalMessage.usage.output_tokens,
                cacheReadTokens: cacheRead || undefined,
                cacheWriteTokens: cacheWrite || undefined,
            },
        };
    }
}
