/**
 * OpenAI GPT Provider
 *
 * 实现 LLMProvider 接口，封装 openai SDK。
 * 支持 tool_calls, streaming, 以及 OpenAI 兼容端点。
 */
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ProviderEntry } from '../../data/defaults';
import { logger } from '../../logger';
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from './types';
import { encodeOpenAIRequestMessages, encodeOpenAITools } from './conversationCodec';
import { createProxiedFetch } from './proxyFetch';
import { createTransformDiagnostics, hasTransformMutations, transformMessages } from './transformMessages';
import { buildDefaultHeaders } from './userAgent';
import { withProviderRequestLifecycle } from './requestLifecycle';

export class OpenAIChatProvider implements LLMProvider {
    readonly name = 'openai-chat';
    private client: OpenAI;

    constructor(entry: ProviderEntry) {
        const opts: ConstructorParameters<typeof OpenAI>[0] = {
            apiKey: entry.auth.value,
        };
        if (entry.baseUrl) {
            opts.baseURL = entry.baseUrl;
        }
        opts.fetch = createProxiedFetch(entry.proxyUrl);
        const headers = buildDefaultHeaders('openai-chat', entry.headers);
        if (headers) {
            opts.defaultHeaders = headers;
        }
        this.client = new OpenAI(opts);
    }

    stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        return withProviderRequestLifecycle(lifecycle => this.streamRequest({ ...request, signal: lifecycle.signal }), request.signal);
    }

    private async *streamRequest(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        const diagnostics = createTransformDiagnostics('openai-chat', request.messages.length);
        const transformed = transformMessages(request.messages, 'openai-chat', diagnostics, request.model);
        if (hasTransformMutations(diagnostics)) {
            logger.debug({
                provider: 'openai-chat',
                model: request.model,
                ...diagnostics,
            }, '[HISTORY_REPAIR] provider conversation transformed');
        }
        const params: ChatCompletionCreateParamsStreaming = {
            model: request.model,
            messages: encodeOpenAIRequestMessages(transformed),
            max_tokens: request.maxTokens ?? 8192,
            stream: true,
            stream_options: { include_usage: true },
            ...(request.conversationId ? { prompt_cache_key: request.conversationId } : {}),
        };

        const tools = encodeOpenAITools(request.tools);
        if (tools) {
            params.tools = tools;
        }

        // OpenAI reasoning_effort: minimal | low | medium | high | xhigh | max
        if (request.thinkingLevel) {
            params.reasoning_effort = request.thinkingLevel;
        }

        const stream = await this.client.chat.completions.create(params, { signal: request.signal });

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null;
        let sawToolCalls = false;

        for await (const chunk of stream) {
            if (chunk.usage) {
                const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
                usage = {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                    cacheReadTokens: cachedTokens || undefined,
                };
                if (cachedTokens) {
                    logger.info({
                        model: request.model,
                        cached: cachedTokens,
                        input: chunk.usage.prompt_tokens,
                    }, '[OAI_CHAT] prompt cache');
                }
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;

            if (typeof delta.content === 'string' && delta.content.length > 0) {
                yield { type: 'text_delta', text: delta.content };
            }

            if (delta.tool_calls) {
                sawToolCalls = true;
                for (const tc of delta.tool_calls) {
                    const existing = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
                    const next = {
                        id: tc.id ?? existing.id,
                        name: tc.function?.name ?? existing.name,
                        args: existing.args + (tc.function?.arguments ?? ''),
                    };

                    const shouldStart = !existing.id && !!next.id && !!next.name;
                    toolCalls.set(tc.index, next);

                    if (shouldStart) {
                        yield { type: 'tool_use_start', id: next.id, name: next.name };
                    }

                    if (tc.function?.arguments) {
                        yield {
                            type: 'tool_use_delta',
                            id: next.id,
                            input: tc.function.arguments,
                        };
                    }
                }
            }

            if (choice?.finish_reason === 'tool_calls') {
                for (const [, toolCall] of toolCalls) {
                    if (toolCall.id) {
                        yield { type: 'tool_use_done', id: toolCall.id, arguments: toolCall.args || undefined };
                    }
                }
            }
        }

        yield {
            type: 'done',
            stopReason: sawToolCalls ? 'tool_use' : 'end_turn',
            usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
    }
}
