import type { InferenceContentPart, InferenceCoreMessage, InferenceStreamRequest, InferenceStreamResponse, RunInferenceRunReady, RunInferenceRunRequest } from '../../gen/native_inference_pb';
import type { LLMContentBlock, LLMMessage, LLMStreamRequest } from '../llm/types';
import { randomUUID } from 'node:crypto';
import { create, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { InferenceAssistantPartKind, InferenceMessageRole, InferenceResponseMessageSchema, InferenceStreamErrorType, InferenceStreamResponseSchema, RunInferenceRunReadySchema } from '../../gen/native_inference_pb';
import { resolveModel } from '../models/mapper';
import { resolveProviderRuntime } from '../llm/providerRuntime';

/** The initial native-loop rollout is restricted to the supported Grok models. */
export function resolveNativeModel(modelId: string) {
    const model = resolveModel(modelId);
    if (!/^grok-4\.[67]$/.test(model.apiModel) || model.provider !== 'anthropic') {
        throw new ConnectError('Native inference forwarding supports configured Grok 4.6/4.7 Anthropic-compatible providers.', Code.FailedPrecondition);
    }
    if (model.contextTokenLimit <= model.maxOutputTokens) {
        throw new ConnectError('Set the model context limit above its maximum output tokens.', Code.FailedPrecondition);
    }
    return model;
}

export function createRunReady(request: RunInferenceRunRequest): RunInferenceRunReady {
    const requested = request.requestedModel;
    if (!requested?.modelId) throw new ConnectError('Missing native inference model.', Code.InvalidArgument);
    const model = resolveNativeModel(requested.modelId);
    // This prompt version is shipped by the native Grok harness. Prefer the
    // advertised version, and fail rather than silently construct another family.
    const promptVersion = 'cursor-0226';
    if (request.agentModule && !request.agentModule.promptVersions.includes(promptVersion)) {
        throw new ConnectError('This agent module does not advertise the supported Grok prompt version.', Code.FailedPrecondition);
    }
    return create(RunInferenceRunReadySchema, {
        resolvedModel: requested,
        supportsSelfSummary: true,
        promptModelMetadata: {
            vendor: 'xai',
            promptVersion,
            isGrok46ProductPrompt: true,
            agentTokenLimit: model.contextTokenLimit,
            reasoningEffort: model.thinkingLevel,
            selfIdentityName: 'Grok',
            agentModeConfigs: ['agent', 'plan', 'ask', 'debug'].map(modeId => ({
                modeId,
                enableAskQuestionTool: true,
                switchModeToolConfig: { targetModes: ['agent', 'plan', 'ask', 'debug'].filter(m => m !== modeId) },
            })),
        },
        summarization: {
            model: requested,
            isFallbackToMainModel: true,
            maxPromptChars: model.contextTokenLimit * 3,
            // Native foreground compaction remains available without speculative
            // background requests or an independent plugin compaction policy.
            background: { discardOnError: true },
        },
        acceptsClientHeartbeat: true,
        acceptsAbortedFinish: true,
    });
}

function partsToBlocks(parts: InferenceContentPart[]): LLMContentBlock[] {
    return parts.map(({ part }) => {
        if (part.case === 'text') return { type: 'text', text: part.value.text };
        if (part.case === 'image') {
            const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(part.value.data);
            if (!data) throw new ConnectError('Native image must contain inline base64 data.', Code.Unimplemented);
            return { type: 'image', mimeType: part.value.mimeType ?? data[1], data: data[2] };
        }
        throw new ConnectError('Unsupported native inference content part.', Code.Unimplemented);
    });
}

export function translateMessages(messages: InferenceCoreMessage[]): LLMMessage[] {
    return messages.flatMap((message): LLMMessage[] => {
        if (message.role === InferenceMessageRole.TOOL) {
            if (message.content.case !== 'toolContent') throw new ConnectError('Tool message has no results.', Code.InvalidArgument);
            return message.content.value.parts.map(part => {
                const result = part.result ? toJson(ValueSchema, part.result) : null;
                if (part.experimentalContent.length) throw new ConnectError('Multimodal tool results are not yet supported by native forwarding.', Code.Unimplemented);
                return { role: 'tool', toolCallId: part.toolCallId, toolName: part.toolName, isError: part.isError, content: typeof result === 'string' ? result : JSON.stringify(result) };
            });
        }
        const role = message.role === InferenceMessageRole.SYSTEM ? 'system'
            : message.role === InferenceMessageRole.USER ? 'user'
                : message.role === InferenceMessageRole.ASSISTANT ? 'assistant' : undefined;
        if (!role) throw new ConnectError('Unsupported native inference role.', Code.InvalidArgument);
        const content: LLMContentBlock[] = message.content.case === 'text'
            ? [{ type: 'text', text: message.content.value }]
            : message.content.case === 'parts' ? partsToBlocks(message.content.value.parts) : [];
        const reasoning: LLMContentBlock[] = message.reasoningParts.map(part => {
            if (part.isRedacted) throw new ConnectError('Redacted reasoning cannot be forwarded to this provider.', Code.Unimplemented);
            return { type: 'thinking', text: part.text, signature: part.signature, sourceModel: part.modelName };
        });
        const tools: LLMContentBlock[] = message.toolCalls.map(call => {
            let input: Record<string, unknown>;
            try {
                input = call.args ?? JSON.parse(call.rawToolCallArgs ?? '{}');
            } catch {
                throw new ConnectError('Invalid native tool arguments.', Code.InvalidArgument);
            }
            return { type: 'tool_use', id: call.toolCallId, name: call.toolName, input };
        });
        if (!message.assistantPartOrder.length) return [{ role, content: [...reasoning, ...content, ...tools] }];
        const groups: Record<number, LLMContentBlock[]> = {
            [InferenceAssistantPartKind.REASONING]: [...reasoning],
            [InferenceAssistantPartKind.TEXT]: message.assistantTextParts.map(text => ({ type: 'text', text })),
            [InferenceAssistantPartKind.TOOL_CALL]: [...tools],
        };
        const ordered = message.assistantPartOrder.map(kind => {
            const block = groups[kind]?.shift();
            if (!block) throw new ConnectError('Native assistant part ordering is inconsistent.', Code.InvalidArgument);
            return block;
        });
        if (Object.values(groups).some(group => group.length)) throw new ConnectError('Native assistant ordering omits content.', Code.InvalidArgument);
        return [{ role, content: ordered }];
    });
}

export function translateRequest(request: InferenceStreamRequest, modelId: string, signal: AbortSignal): LLMStreamRequest {
    const model = resolveNativeModel(modelId);
    if (request.providerDefinedTools.length || request.tools.some(tool => tool.customToolFormat)) {
        throw new ConnectError('Provider-defined tools require a native forwarding adapter.', Code.Unimplemented);
    }
    if ((request.modelConfig?.maxTokens ?? 1) <= 0) throw new ConnectError('Invalid inference output token limit.', Code.InvalidArgument);
    if (request.modelConfig?.chatTemplateKwargs || request.modelConfig?.continueFinalMessage) throw new ConnectError('Unsupported native model config.', Code.Unimplemented);
    return {
        model: model.apiModel,
        messages: translateMessages(request.messages),
        tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters ?? {} })),
        maxTokens: Math.min(request.modelConfig?.maxTokens ?? model.maxOutputTokens, model.maxOutputTokens),
        thinking: model.thinking,
        thinkingLevel: model.thinkingLevel,
        thinkingBudgetTokens: model.thinkingBudgetTokens,
        anthropicBetas: model.anthropicBetas,
        conversationId: request.conversationId,
        signal,
        nativeInference: true,
        temperature: request.modelConfig?.temperature,
        topP: request.modelConfig?.topP,
        topK: request.modelConfig?.topK,
        stopSequences: request.modelConfig?.stopSequences,
    };
}

/** One inference invocation only: Cursor owns tools, history, and compaction. */
async function* streamInference(request: InferenceStreamRequest, modelId: string, signal: AbortSignal): AsyncGenerator<InferenceStreamResponse> {
    const translated = translateRequest(request, modelId, signal);
    const runtime = resolveProviderRuntime(modelId);
    const responseId = randomUUID();
    const message = create(InferenceResponseMessageSchema, { id: responseId, role: InferenceMessageRole.ASSISTANT });
    const calls = new Map<string, { name: string; args: string; index: number }>();
    let text = '', thinking = '', completed = false;
    const frame = (response: Parameters<typeof create<typeof InferenceStreamResponseSchema>>[1]) => create(InferenceStreamResponseSchema, response);
    yield frame({ response: { case: 'invocationId', value: { invocationId: request.invocationId ?? responseId } } });
    const flushText = () => {
        if (!text) return;
        message.assistantPartOrder.push(InferenceAssistantPartKind.TEXT);
        message.assistantTextParts.push(text);
        message.content = (message.content ?? '') + text;
        text = '';
    };
    const flushThinking = (signature?: string) => {
        if (!thinking && !signature) return;
        message.assistantPartOrder.push(InferenceAssistantPartKind.REASONING);
        message.reasoningParts.push({ $typeName: 'aiserver.v1.InferenceReasoningPart', text: thinking, isRedacted: false, signature, modelName: runtime.model });
        thinking = '';
    };
    signal.throwIfAborted();
    for await (const event of runtime.provider.stream(translated)) {
        signal.throwIfAborted();
        switch (event.type) {
            case 'text_delta':
                flushThinking();
                text += event.text;
                yield frame({ response: { case: 'textPart', value: { text: event.text } } });
                break;
            case 'thinking_delta':
                flushText();
                thinking += event.text;
                yield frame({ response: { case: 'thinkingPart', value: { text: event.text, modelName: runtime.model } } });
                break;
            case 'thinking_done':
                flushThinking(event.signature);
                if (event.signature) yield frame({ response: { case: 'thinkingPart', value: { signature: event.signature } } });
                break;
            case 'tool_use_start': {
                flushText(); flushThinking();
                if (calls.has(event.id)) throw new ConnectError('Duplicate upstream tool call id.', Code.Internal);
                calls.set(event.id, { name: event.name, args: '', index: calls.size });
                message.assistantPartOrder.push(InferenceAssistantPartKind.TOOL_CALL);
                yield frame({ response: { case: 'toolCallPart', value: { toolCallId: event.id, toolName: event.name, toolIndex: calls.size - 1 } } });
                break;
            }
            case 'tool_use_delta': {
                const call = calls.get(event.id);
                if (!call) throw new ConnectError('Tool delta has no upstream start.', Code.Internal);
                call.args += event.input;
                yield frame({ response: { case: 'toolCallPart', value: { toolCallId: event.id, args: event.input, toolIndex: call.index } } });
                break;
            }
            case 'tool_use_done': {
                const call = calls.get(event.id);
                if (!call) throw new ConnectError('Tool completion has no upstream start.', Code.Internal);
                const args = event.arguments ?? (call.args || '{}');
                const parsed = JSON.parse(args);
                message.toolCalls[call.index] = { $typeName: 'aiserver.v1.InferenceToolCall', toolCallId: event.id, toolName: call.name, args: parsed, rawToolCallArgs: args };
                yield frame({ response: { case: 'toolCallPart', value: { toolCallId: event.id, toolName: call.name, args, isComplete: true, toolIndex: call.index } } });
                break;
            }
            case 'done': {
                if ([...calls.values()].some(call => !message.toolCalls[call.index])) throw new ConnectError('Upstream inference ended with incomplete tool arguments.', Code.Unavailable);
                flushText(); flushThinking();
                const usage = event.usage;
                const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
                yield frame({ response: { case: 'usage', value: { promptTokens: input, completionTokens: usage.outputTokens, totalTokens: input + usage.outputTokens } } });
                yield frame({ response: { case: 'extendedUsage', value: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0, maxTokens: translated.maxTokens ?? runtime.maxOutputTokens } } });
                if (event.stopReason === 'max_tokens' || event.stopReason === 'length') {
                    yield frame({ response: { case: 'error', value: { message: 'The model reached its output token limit.', code: 'max_tokens', isOutputTokenLimitError: true, errorType: InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT } } });
                    return;
                }
                yield frame({ response: { case: 'responseInfo', value: { id: responseId, model: runtime.model, createdAt: BigInt(Date.now()), messages: [message], supportsSelfSummary: true, selfSummaryFlavor: 'generic' } } });
                yield frame({ response: { case: 'textPart', value: { text: '', isFinal: true } } });
                completed = true;
                break;
            }
        }
    }
    if (!completed) throw new ConnectError('Upstream inference ended without a completion.', Code.Unavailable);
}

export async function* forwardInference(request: InferenceStreamRequest, modelId: string, signal: AbortSignal): AsyncGenerator<InferenceStreamResponse> {
    try {
        yield* streamInference(request, modelId, signal);
    } catch (error) {
        // Cursor needs this native error type to run its own overflow recovery.
        const e = error as { status?: number; error?: { error?: { type?: string; message?: string } }; message?: string };
        const detail = e.error?.error;
        if (e.status === 400 && /context_length_exceeded|prompt is too long|maximum context length/i.test(`${detail?.type ?? ''} ${detail?.message ?? e.message ?? ''}`)) {
            yield create(InferenceStreamResponseSchema, { response: { case: 'error', value: { message: 'The provider input exceeds the model context limit.', code: 'context_length_exceeded', isInputTokenLimitError: true, errorType: InferenceStreamErrorType.INPUT_TOKEN_LIMIT } } });
            return;
        }
        throw error;
    }
}
