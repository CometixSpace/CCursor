import type { LLMContentBlock, LLMProvider, LLMMessage, LLMStreamRequest, LLMTool, LLMToolResultBlock } from './types';
import type { ProviderEntry, ProviderType } from '../../data/defaults';
import { AnthropicProvider } from './anthropic';
import { OpenAIChatProvider } from './openai-chat';
import { OpenAIResponsesProvider } from './openai-responses';
import { GeminiProvider } from './gemini';
import { resolveModel } from '../models/mapper';
import { makeByokConnectError } from '../errors';
import { withUsageRecording } from './usageRecorder';
import { ErrorDetails_Error } from '../../gen/aiserver_v1_shared_pb';
import type { ProviderStateStrategy } from './stateStrategy';
import { anthropicStateStrategy, geminiStateStrategy, openAIStateStrategy } from './stateStrategy';
import { resolvePromptProfile, type ProviderPromptProfile } from './promptProfile';
import type { ProviderToolCatalog } from './toolCatalog';
import {
    anthropicConversationCodec,
    geminiConversationCodec,
    openAIChatConversationCodec,
    openAIResponsesConversationCodec,
    type ProviderConversationCodec,
} from './conversationCodec';
import type { SemanticTurn } from './semanticConversation';
import { llmMessageToStoredMessage } from './storedTranscript';
import { filterToolsForMode } from '../agent/toolkit/types';

export interface PreparedProviderConversation {
    normalizedMessages: LLMMessage[];
    semanticTurns: SemanticTurn[];
}

export interface PreparedProviderRequest {
    conversation: PreparedProviderConversation;
    request: LLMStreamRequest;
}

export interface ProviderRoundTransition {
    assistantAdded: boolean;
    flushedToolResults: number;
    shouldContinue: boolean;
}

export interface ProviderRoundContext {
    pendingToolResults: LLMToolResultBlock[];
    createToolResult(params: {
        toolCallId: string;
        toolName: string;
        content: string;
        isError: boolean;
    }): LLMToolResultBlock;
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock): void;
    transition(messages: LLMMessage[], assistantContent: LLMContentBlock[]): ProviderRoundTransition;
}

export interface ProviderRuntime {
    provider: LLMProvider;
    stateStrategy: ProviderStateStrategy;
    conversationCodec: ProviderConversationCodec;
    promptProfile: ProviderPromptProfile;
    toolCatalog: ProviderToolCatalog;
    model: string;
    thinking: boolean;
    contextTokenLimit: number;
    prepareConversation(messages: LLMMessage[]): PreparedProviderConversation;
    prepareStreamRequest(messages: LLMMessage[], extraTools?: LLMTool[], maxTokens?: number, mode?: string, thinkingOverride?: { thinking?: boolean, level?: string, budget?: number }, conversationId?: string, isSubagent?: boolean, fastOverride?: boolean, disabledTools?: Set<string>, contextTokenLimitOverride?: number, builtinToolsOverride?: LLMTool[]): PreparedProviderRequest;
    /** 模型配置的最大输出 token 数 */
    maxOutputTokens: number;
    listRuntimeTools(extraTools?: LLMTool[], mode?: string, isSubagent?: boolean, disabledTools?: Set<string>, builtinToolsOverride?: LLMTool[]): LLMTool[];
    createRoundContext(): ProviderRoundContext;
    transitionRound(messages: LLMMessage[], assistantContent: LLMContentBlock[], pendingToolResults?: LLMToolResultBlock[]): ProviderRoundTransition;
}

/**
 * Provider SDK 实例缓存 — 按 ProviderEntry.id 维度复用 client。
 * 同一个 entry 的多次解析共享一个 client; 编辑 providers.json 后通过
 * resetProviderInstanceCache() 重置 (目前仅在测试用,生产期可加 watch 自动重置)。
 */
const providerInstances = new Map<string, LLMProvider>();

function instantiateProvider(entry: ProviderEntry): LLMProvider {
    switch (entry.type) {
        case 'anthropic': return new AnthropicProvider(entry);
        case 'openai-chat': return new OpenAIChatProvider(entry);
        case 'openai-responses': return new OpenAIResponsesProvider(entry);
        case 'gemini': return new GeminiProvider(entry);
    }
}

function getProviderForEntry(entry: ProviderEntry): LLMProvider {
    let inst = providerInstances.get(entry.id);
    if (!inst) {
        inst = instantiateProvider(entry);
        providerInstances.set(entry.id, inst);
    }
    return inst;
}

export function resetProviderInstanceCache(): void {
    providerInstances.clear();
}

function getStateStrategy(name: ProviderType): ProviderStateStrategy {
    switch (name) {
        case 'anthropic': return anthropicStateStrategy;
        case 'openai-chat':
        case 'openai-responses': return openAIStateStrategy;
        case 'gemini': return geminiStateStrategy;
    }
}

function getConversationCodec(name: ProviderType): ProviderConversationCodec {
    switch (name) {
        case 'anthropic': return anthropicConversationCodec;
        case 'openai-chat': return openAIChatConversationCodec;
        case 'openai-responses': return openAIResponsesConversationCodec;
        case 'gemini': return geminiConversationCodec;
    }
}

function syntheticProviderEntry(type: ProviderType): ProviderEntry {
    return {
        id: `__synthetic__${type}`,
        name: `Synthetic ${type}`,
        type,
        baseUrl: '',
        auth: { kind: 'apiKey', value: '' },
        models: [],
    };
}

export function resolveProviderRuntime(modelId: string): ProviderRuntime {
    const resolved = resolveModel(modelId);
    const promptProfile = resolvePromptProfile(modelId);
    const conversationCodec = getConversationCodec(resolved.provider);
    const stateStrategy = getStateStrategy(resolved.provider);
    const providerEntry = resolved.providerEntry ?? syntheticProviderEntry(resolved.provider);
    const prepareConversation = (messages: LLMMessage[]): PreparedProviderConversation => {
        const normalizedMessages = conversationCodec.normalizeMessages(messages);
        return {
            normalizedMessages,
            semanticTurns: conversationCodec.normalizeStoredTranscript(normalizedMessages.map(llmMessageToStoredMessage)),
        };
    };
    const listRuntimeTools = (extraTools: LLMTool[] = [], mode?: string, isSubagent = false, disabledTools?: Set<string>, builtinToolsOverride?: LLMTool[]): LLMTool[] => {
        let builtins = builtinToolsOverride ?? promptProfile.toolCatalog.listBuiltins();
        // disabledTools 表示内置功能开关/动态隐藏集合；不能误删同名的外部 MCP 工具。
        if (disabledTools && disabledTools.size > 0)
            builtins = builtins.filter(tool => !disabledTools.has(tool.name));
        const all = [...builtins, ...extraTools];
        return mode ? filterToolsForMode(all, mode, isSubagent) : all;
    };
    return {
        // 用量采集埋点 (唯一): 包装缓存的 SDK client, 每次 resolve 新建轻量闭包,
        // 底层 client 缓存机制不变 — agent 主循环 / 压缩摘要 / 子代理全部经此覆盖
        provider: withUsageRecording(getProviderForEntry(providerEntry), {
            providerId: providerEntry.id,
            providerName: providerEntry.name,
            modelId,
            apiModel: resolved.apiModel,
        }),
        stateStrategy,
        conversationCodec,
        promptProfile,
        toolCatalog: promptProfile.toolCatalog,
        model: resolved.apiModel,
        thinking: resolved.thinking,
        maxOutputTokens: resolved.maxOutputTokens,
        contextTokenLimit: resolved.contextTokenLimit,
        prepareConversation,
        prepareStreamRequest(messages: LLMMessage[], extraTools: LLMTool[] = [], maxTokens = resolved.noMaxTokens ? undefined : resolved.maxOutputTokens, mode?: string, thinkingOverride?: { thinking?: boolean, level?: string, budget?: number }, conversationId?: string, isSubagent = false, fastOverride?: boolean, disabledTools?: Set<string>, contextTokenLimitOverride?: number, builtinToolsOverride?: LLMTool[]): PreparedProviderRequest {
            const conversation = prepareConversation(messages);
            // 客户端运行时参数覆盖静态配置 (undefined = 不覆盖, 保留 providers.json 值)
            const thinking = thinkingOverride?.thinking ?? resolved.thinking;
            // Level 和 Budget 互斥: 客户端如果指定了其中一个,另一个必须清除
            let thinkingLevel = (thinkingOverride?.level as LLMStreamRequest['thinkingLevel']) ?? resolved.thinkingLevel;
            let thinkingBudgetTokens = thinkingOverride?.budget ?? resolved.thinkingBudgetTokens;
            if (thinkingLevel && thinkingBudgetTokens) {
                thinkingBudgetTokens = undefined;
            }
            // 客户端显式开 thinking 但静态配置无 level/budget 时兜底默认档位
            // (QS 只开 Thinking Toggle 而顶层 thinking=false 的场景), 与 UI 开 thinking 时的默认值一致
            if (thinkingOverride?.thinking === true && !thinkingLevel && !thinkingBudgetTokens) {
                thinkingLevel = resolved.provider === 'anthropic' ? 'high' : 'medium';
            }
            // 后端校验: thinking 配置合规性
            if (thinking) {
                if (!thinkingLevel && !thinkingBudgetTokens) {
                    throw makeByokConnectError({
                        errorCode: ErrorDetails_Error.CUSTOM,
                        title: 'Thinking configuration incomplete',
                        detail: 'Thinking is enabled but neither Level nor Budget is set.\n\nOpen Cursor++ panel → edit the model to set a thinking level or budget.',
                        isRetryable: false,
                        additionalInfo: { model: resolved.apiModel },
                    });
                }
                if (!thinkingLevel && thinkingBudgetTokens !== undefined) {
                    if (thinkingBudgetTokens < 1024) {
                        throw makeByokConnectError({
                            errorCode: ErrorDetails_Error.CUSTOM,
                            title: 'Invalid thinking budget',
                            detail: `Thinking budget must be ≥ 1024 tokens (got ${thinkingBudgetTokens}).`,
                            isRetryable: false,
                            additionalInfo: { model: resolved.apiModel, budget: String(thinkingBudgetTokens) },
                        });
                    }
                    if (maxTokens !== undefined && thinkingBudgetTokens >= maxTokens) {
                        throw makeByokConnectError({
                            errorCode: ErrorDetails_Error.CUSTOM,
                            title: 'Thinking budget exceeds output limit',
                            detail: `Thinking budget (${thinkingBudgetTokens}) must be less than Max Output Tokens (${maxTokens}).`,
                            isRetryable: false,
                            additionalInfo: { model: resolved.apiModel, budget: String(thinkingBudgetTokens), maxTokens: String(maxTokens) },
                        });
                    }
                }
            }
            // fast override: clientFast 覆盖静态 fastMode 配置
            // 非 Anthropic: fastOverride=false 必须清掉静态 serviceTier, 否则 picker 关 Fast 后仍发 priority
            const effectiveFast = fastOverride ?? !!resolved.serviceTier
            const serviceTier = resolved.provider !== 'anthropic'
                ? (effectiveFast ? 'priority' as const : undefined)
                : resolved.serviceTier
            const effectiveContextLimit = contextTokenLimitOverride ?? resolved.contextTokenLimit
            const anthropicBetas = (() => {
              if (resolved.provider !== 'anthropic')
                return resolved.anthropicBetas ? [...resolved.anthropicBetas] : []
              let base = resolved.anthropicBetas ? [...resolved.anthropicBetas] : []
              if (fastOverride === true && !base.some(b => b.startsWith('fast-mode')))
                base.push('fast-mode-2026-02-01')
              if (fastOverride === false)
                base = base.filter(b => !b.startsWith('fast-mode'))
              // 客户端 context 轴选 ≥1M 时动态补 1M beta (静态 mapper 只看顶层 contextTokenLimit)。
              // 只补不删: 输入 ≤200K 时该 beta 无副作用, 移除反而会让超 200K 的输入被 API 拒绝
              if (effectiveContextLimit >= 1_000_000 && !base.some(b => b.startsWith('context-1m')))
                base.push('context-1m-2025-08-07')
              return base
            })()

            return {
                conversation,
                request: {
                    model: resolved.apiModel,
                    messages: conversation.normalizedMessages,
                    tools: listRuntimeTools(extraTools, mode, isSubagent, disabledTools, builtinToolsOverride),
                    thinking,
                    thinkingLevel,
                    thinkingBudgetTokens,
                    maxTokens,
                    conversationId,
                    ...(serviceTier ? { serviceTier } : {}),
                    ...(anthropicBetas.length ? { anthropicBetas } : {}),
                },
            };
        },
        listRuntimeTools,
        createRoundContext(): ProviderRoundContext {
            const pendingToolResults: LLMToolResultBlock[] = [];
            return {
                pendingToolResults,
                createToolResult(params) {
                    return stateStrategy.createToolResult(params);
                },
                recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock): void {
                    stateStrategy.addToolResult(messages, pendingToolResults, result);
                },
                transition(messages: LLMMessage[], assistantContent: LLMContentBlock[]): ProviderRoundTransition {
                    const assistantAdded = assistantContent.length > 0;
                    if (assistantAdded) {
                        messages.push({ role: 'assistant', content: assistantContent });
                    }
                    const flushedToolResults = pendingToolResults.length;
                    if (flushedToolResults > 0) {
                        stateStrategy.flushToolResults(messages, pendingToolResults);
                    }
                    return {
                        assistantAdded,
                        flushedToolResults,
                        shouldContinue: flushedToolResults > 0,
                    };
                },
            };
        },
        transitionRound(messages: LLMMessage[], assistantContent: LLMContentBlock[], pendingToolResults: LLMToolResultBlock[] = []): ProviderRoundTransition {
            const assistantAdded = assistantContent.length > 0;
            if (assistantAdded) {
                messages.push({ role: 'assistant', content: assistantContent });
            }
            const flushedToolResults = pendingToolResults.length;
            if (flushedToolResults > 0) {
                stateStrategy.flushToolResults(messages, pendingToolResults);
            }
            return {
                assistantAdded,
                flushedToolResults,
                shouldContinue: flushedToolResults > 0,
            };
        },
    };
}
