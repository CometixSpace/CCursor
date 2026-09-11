/**
 * LLM Provider 统一类型定义
 *
 * 各 provider (Anthropic/OpenAI/Gemini) 实现此接口，
 * Agent/Chat 协议翻译层只依赖这些类型，不直接依赖具体 SDK。
 */

/** 对话消息 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LLMContentBlock[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /**
   * 透传的 provider 元数据 (白名单: 仅 cursor.isSummary 摘要标记, 设计文档 §6 Q6)。
   * 语义根治"旧摘要被当普通历史再次进摘要源+再次归档"的地板爬升问题;
   * 修复链 (repair/materialize/flush) 通过 {...msg} 展开保留该字段。
   */
  providerOptions?: Record<string, unknown>
}

/** 内容块 (用于 assistant 消息中混合 text + tool_use) */
export type LLMContentBlock
  = | { type: 'text', text: string }
    | { type: 'image', mimeType: string, data: string }
    | { type: 'thinking', text: string, signature?: string, sourceModel?: string, providerOptions?: Record<string, unknown> }
    | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
    | { type: 'tool_result', toolUseId: string, toolName?: string, content: string, isError?: boolean }

export type LLMToolResultBlock = Extract<LLMContentBlock, { type: 'tool_result' }>

/** 工具定义 */
export interface LLMTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Streaming delta 事件 */
export type LLMStreamEvent
  = | { type: 'thinking_delta', text: string }
    | { type: 'thinking_done', signature?: string }
    | { type: 'text_delta', text: string }
    | { type: 'tool_use_start', id: string, name: string }
    | { type: 'tool_use_delta', id: string, input: string }
    | { type: 'tool_use_done', id: string, arguments?: string }
    | { type: 'done', usage: LLMUsage, stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string }

/** Token 用量 */
export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 统一的 streaming 请求参数 */
export interface LLMStreamRequest {
  model: string
  messages: LLMMessage[]
  /** Cancellation for this run or request attempt, not the shared SDK client. */
  signal?: AbortSignal
  tools?: LLMTool[]
  maxTokens?: number
  thinking?: boolean
  /** 思考档位 — Anthropic 4.5-opus/4.6+ / OpenAI / Gemini 消费; 见 ProviderModel.thinkingLevel */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 精确思考预算 — 老 Claude 4.x (legacy budget_tokens) / Gemini 精确覆盖 */
  thinkingBudgetTokens?: number
  /** 会话 ID — OpenAI prompt_cache_key (同会话共享前缀缓存) */
  conversationId?: string
  /** OpenAI service_tier: "priority" 启用优先推理 */
  serviceTier?: 'priority' | 'default'
  /** Anthropic beta headers — 如 context-1m, interleaved-thinking 等 */
  anthropicBetas?: string[]
}

/** Provider 接口 — 各 SDK 实现此接口 */
export interface LLMProvider {
  readonly name: string

  /** 返回 async iterator of streaming events */
  stream: (request: LLMStreamRequest) => AsyncIterable<LLMStreamEvent>
}
