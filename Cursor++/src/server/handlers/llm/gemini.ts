/**
 * Google Gemini Provider
 *
 * 实现 LLMProvider 接口，封装 @google/genai SDK。
 * 支持 streaming, tool calls, thinking (Gemini 2.5+)。
 */
import { GoogleGenAI, ThinkingLevel, type GenerateContentConfig, type ThinkingConfig } from '@google/genai';
import type { ProviderEntry } from '../../data/defaults';
import { logger } from '../../logger';
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from './types';
import { encodeGeminiRequestMessages, encodeGeminiTools } from './conversationCodec';
import { createTransformDiagnostics, hasTransformMutations, transformMessages } from './transformMessages';
import { buildDefaultHeaders } from './userAgent';
import { withProviderRequestLifecycle } from './requestLifecycle';

function guardGeminiAbortSubscription(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (!signal) return undefined;
    // @google/genai 2.7.0 subscribes after async setup without checking aborted.
    // Reject a late subscription instead of dispatching HTTP for a stopped run.
    return new Proxy(signal, {
        get(target, property) {
            if (property === 'addEventListener') {
                return (...parameters: Parameters<AbortSignal['addEventListener']>) => {
                    if (parameters[0] === 'abort') target.throwIfAborted();
                    target.addEventListener(...parameters);
                };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function mapThinkingLevelToGemini(level: NonNullable<LLMStreamRequest['thinkingLevel']>): ThinkingLevel {
    switch (level) {
        case 'minimal': return ThinkingLevel.MINIMAL;
        case 'low': return ThinkingLevel.LOW;
        case 'medium': return ThinkingLevel.MEDIUM;
        case 'high': return ThinkingLevel.HIGH;
        case 'xhigh': return ThinkingLevel.HIGH; // Gemini 最高档为 HIGH
        case 'max': return ThinkingLevel.HIGH;
    }
}

export class GeminiProvider implements LLMProvider {
    readonly name = 'gemini';
    private client: GoogleGenAI;

    constructor(entry: ProviderEntry) {
        const opts: ConstructorParameters<typeof GoogleGenAI>[0] = {
            apiKey: entry.auth.value,
        };
        const headers = buildDefaultHeaders('gemini', entry.headers);
        if (entry.baseUrl || headers) {
            opts.httpOptions = {
                ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
                ...(headers ? { headers } : {}),
            };
        }
        this.client = new GoogleGenAI(opts);
    }

    stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        return withProviderRequestLifecycle(lifecycle => this.streamRequest({ ...request, signal: lifecycle.signal }), request.signal);
    }

    private async *streamRequest(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        const diagnostics = createTransformDiagnostics('gemini', request.messages.length);
        const transformed = transformMessages(request.messages, 'gemini', diagnostics, request.model);
        if (hasTransformMutations(diagnostics)) {
            logger.debug({
                provider: 'gemini',
                model: request.model,
                ...diagnostics,
            }, '[HISTORY_REPAIR] provider conversation transformed');
        }
        const encoded = encodeGeminiRequestMessages(transformed);

        const genConfig: GenerateContentConfig = {
            maxOutputTokens: request.maxTokens ?? 8192,
            abortSignal: guardGeminiAbortSubscription(request.signal),
        };

        if (encoded.systemInstruction) {
            genConfig.systemInstruction = encoded.systemInstruction;
        }

        const tools = encodeGeminiTools(request.tools);
        if (tools) {
            genConfig.tools = tools;
        }

        if (request.thinking) {
            // 优先级: 精确 budget > level > 自动 (-1)
            const tc: ThinkingConfig = { includeThoughts: true };
            if (request.thinkingBudgetTokens !== undefined) {
                tc.thinkingBudget = request.thinkingBudgetTokens;
            }
            else if (request.thinkingLevel) {
                tc.thinkingLevel = mapThinkingLevelToGemini(request.thinkingLevel);
            }
            else {
                tc.thinkingBudget = -1; // AUTOMATIC
            }
            genConfig.thinkingConfig = tc;
        }

        const response = await this.client.models.generateContentStream({
            model: request.model,
            contents: encoded.contents,
            config: genConfig,
        });

        let inputTokens = 0;
        let outputTokens = 0;
        let sawToolCalls = false;
        let syntheticToolCallCounter = 0;
        let wasThinking = false;
        let lastThoughtSignature: string | undefined;
        const startedToolCalls = new Set<string>();
        const finishedToolCalls = new Set<string>();

        for await (const chunk of response) {
            if (chunk.usageMetadata) {
                inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
                outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
            }

            const parts = chunk.candidates?.[0]?.content?.parts;
            if (!parts) continue;

            for (const part of parts) {
                if (part.thought && part.text) {
                    wasThinking = true;
                    if (part.thoughtSignature) lastThoughtSignature = part.thoughtSignature;
                    yield { type: 'thinking_delta', text: part.text };
                } else if (part.text) {
                    if (wasThinking) {
                        yield { type: 'thinking_done', signature: lastThoughtSignature };
                        wasThinking = false;
                        lastThoughtSignature = undefined;
                    }
                    yield { type: 'text_delta', text: part.text };
                } else if (part.functionCall) {
                    sawToolCalls = true;
                    const id = part.functionCall.id ?? `gemini-${++syntheticToolCallCounter}`;
                    const name = part.functionCall.name ?? '';
                    if (!startedToolCalls.has(id)) {
                        startedToolCalls.add(id);
                        yield { type: 'tool_use_start', id, name };
                    }
                    yield { type: 'tool_use_delta', id, input: JSON.stringify(part.functionCall.args ?? {}) };
                    if (!part.functionCall.willContinue && !finishedToolCalls.has(id)) {
                        finishedToolCalls.add(id);
                        yield { type: 'tool_use_done', id };
                    }
                }
            }
        }

        if (wasThinking) {
            yield { type: 'thinking_done', signature: lastThoughtSignature };
        }

        yield {
            type: 'done',
            stopReason: sawToolCalls ? 'tool_use' : 'end_turn',
            usage: { inputTokens, outputTokens },
        };
    }
}
