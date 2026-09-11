import type { LLMContentBlock, LLMMessage } from './types'

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | StoredBlock[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  id?: string
  providerOptions?: Record<string, unknown>
}

export type StoredBlock
  = | { type: 'text', text: string }
    | { type: 'image', mimeType: string, data: string }
    | { type: 'reasoning', text: string, signature?: string, providerOptions?: Record<string, unknown> }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: Record<string, unknown> }
    | { type: 'tool-result', toolCallId: string, toolName?: string, result: string, isError?: boolean, structured?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/**
 * providerOptions 白名单过滤: 只透传 cursor.isSummary 摘要标记 (设计文档 §6 Q6)。
 *
 * 语义: blob 里只允许携带这一项元数据 —— 它是官方 CC-010 的尾部保留判定依据,
 * 丢失会导致旧摘要被当普通历史重复进摘要源/重复归档 (地板爬升根因之二);
 * 其余 provider 选项不落盘, 避免无限膨胀的透传面。
 */
export function filterSummaryProviderOptions(providerOptions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!isRecord(providerOptions))
    return undefined
  const cursor = providerOptions.cursor
  if (!isRecord(cursor) || cursor.isSummary !== true)
    return undefined
  return { cursor: { isSummary: true } }
}

export function normalizeStoredMessage(message: {
  role: string
  content: unknown
  toolCallId?: string
  toolName?: string
  isError?: boolean
  id?: string
  providerOptions?: Record<string, unknown>
}): StoredMessage {
  if (!Array.isArray(message.content)) {
    return {
      role: message.role as StoredMessage['role'],
      content: typeof message.content === 'string' ? message.content : '',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      id: message.id,
      providerOptions: filterSummaryProviderOptions(message.providerOptions),
    }
  }

  const normalized: StoredBlock[] = []
  for (const block of message.content as unknown[]) {
    if (!isRecord(block) || typeof block.type !== 'string')
      continue
    switch (block.type) {
      case 'text':
        normalized.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
        break
      case 'image':
        normalized.push({
          type: 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
          data: typeof block.data === 'string' ? block.data : '',
        })
        break
      case 'reasoning':
      case 'thinking':
        normalized.push({
          type: 'reasoning',
          text: typeof block.text === 'string' ? block.text : '',
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(isRecord(block.providerOptions) ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        normalized.push({
          type: 'tool-call',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          toolName: typeof block.toolName === 'string' ? block.toolName : '',
          args: isRecord(block.args) ? block.args : {},
        })
        break
      case 'tool_use':
        normalized.push({
          type: 'tool-call',
          toolCallId: typeof block.id === 'string' ? block.id : '',
          toolName: typeof block.name === 'string' ? block.name : '',
          args: isRecord(block.input) ? block.input : {},
        })
        break
      case 'tool-result':
        normalized.push({
          type: 'tool-result',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? ''),
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
          ...(block.structured !== undefined ? { structured: block.structured } : {}),
        })
        break
      case 'tool_result':
        normalized.push({
          type: 'tool-result',
          toolCallId: typeof block.toolUseId === 'string' ? block.toolUseId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
        })
        break
      default:
        break
    }
  }

  return {
    role: message.role as StoredMessage['role'],
    content: normalized,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    id: message.id,
    providerOptions: filterSummaryProviderOptions(message.providerOptions),
  }
}

export function restoreStoredMessage(message: Record<string, unknown>): StoredMessage | null {
  if (typeof message.role !== 'string')
    return null

  if (!Array.isArray(message.content)) {
    return {
      role: message.role as StoredMessage['role'],
      content: typeof message.content === 'string' ? message.content : '',
      toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
      isError: typeof message.isError === 'boolean' ? message.isError : undefined,
      id: typeof message.id === 'string' ? message.id : undefined,
      providerOptions: filterSummaryProviderOptions(isRecord(message.providerOptions) ? message.providerOptions : undefined),
    }
  }

  const content: StoredBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== 'string')
      continue
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
        break
      case 'image':
        content.push({
          type: 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
          data: typeof block.data === 'string' ? block.data : '',
        })
        break
      case 'reasoning':
      case 'thinking':
        content.push({
          type: 'reasoning',
          text: typeof block.text === 'string' ? block.text : '',
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(isRecord(block.providerOptions) ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        content.push({
          type: 'tool-call',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          toolName: typeof block.toolName === 'string' ? block.toolName : '',
          args: isRecord(block.args) ? block.args : {},
        })
        break
      case 'tool_use':
        content.push({
          type: 'tool-call',
          toolCallId: typeof block.id === 'string' ? block.id : '',
          toolName: typeof block.name === 'string' ? block.name : '',
          args: isRecord(block.input) ? block.input : {},
        })
        break
      case 'tool-result':
        content.push({
          type: 'tool-result',
          toolCallId: typeof block.toolCallId === 'string' ? block.toolCallId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: typeof block.result === 'string' ? block.result : '',
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
          ...(block.structured !== undefined ? { structured: block.structured } : {}),
        })
        break
      case 'tool_result':
        content.push({
          type: 'tool-result',
          toolCallId: typeof block.toolUseId === 'string' ? block.toolUseId : '',
          ...(typeof block.toolName === 'string' ? { toolName: block.toolName } : {}),
          result: typeof block.content === 'string' ? block.content : '',
          ...(typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
        })
        break
      default:
        break
    }
  }

  return {
    role: message.role as StoredMessage['role'],
    content,
    toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
    toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
    isError: typeof message.isError === 'boolean' ? message.isError : undefined,
    id: typeof message.id === 'string' ? message.id : undefined,
    providerOptions: filterSummaryProviderOptions(isRecord(message.providerOptions) ? message.providerOptions : undefined),
  }
}

export function storedMessageToLLMMessage(message: StoredMessage): LLMMessage {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      providerOptions: filterSummaryProviderOptions(message.providerOptions),
    }
  }

  const content: LLMContentBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        break
      case 'reasoning':
        content.push({
          type: 'thinking',
          text: block.text,
          ...(block.signature ? { signature: block.signature } : {}),
          ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool-call':
        content.push({ type: 'tool_use', id: block.toolCallId, name: block.toolName, input: block.args })
        break
      case 'tool-result':
        content.push({
          type: 'tool_result',
          toolUseId: block.toolCallId,
          toolName: block.toolName,
          content: block.result,
          ...(block.isError ? { isError: true } : {}),
        })
        break
    }
  }

  return {
    role: message.role,
    content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    providerOptions: filterSummaryProviderOptions(message.providerOptions),
  }
}

export function llmMessageToStoredMessage(message: LLMMessage): StoredMessage {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      providerOptions: filterSummaryProviderOptions(message.providerOptions),
    }
  }

  const content: StoredBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image':
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        break
      case 'thinking':
        content.push({
          type: 'reasoning',
          text: block.text,
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          ...(block.providerOptions ? { providerOptions: block.providerOptions } : {}),
        })
        break
      case 'tool_use':
        content.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, args: block.input })
        break
      case 'tool_result':
        content.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: block.toolName,
          result: block.content,
          ...(block.isError ? { isError: true } : {}),
        })
        break
    }
  }

  return {
    role: message.role,
    content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    providerOptions: filterSummaryProviderOptions(message.providerOptions),
  }
}
