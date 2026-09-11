/**
 * 跨 Provider 消息转换 / 修复
 *
 * 目标:
 *   1. tool call ID 标准化
 *   2. Anthropic legacy user.tool_result[] ↔ canonical tool role 互转
 *   3. 修复 assistant(tool_use...) ↔ tool_result 的配对/顺序
 *   4. 跨 provider thinking 降级
 */
import type { ProviderType as DefaultsProviderType } from '../../data/defaults'
import { findToolByAlias, listBuiltinLlmTools } from '../agent/toolkit/registry'
import { getProviderToolCatalog } from './toolCatalog'
import type { LLMContentBlock, LLMMessage } from './types'

// ── shortHash: 确定性短哈希 (对标 Pi utils/hash.ts) ──

export function shortHash(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}

// ── Provider-specific ID normalizers ──

function sanitizeId(id: string, maxLen = 64): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLen).replace(/_+$/, '')
}

export function normalizeToolCallIdForAnthropic(id: string): string {
  return sanitizeId(id, 64)
}

export function normalizeToolCallIdForOpenAIChat(id: string): string {
  return sanitizeId(id, 64)
}

export function normalizeToolCallIdForOpenAIResponses(id: string): string {
  if (!id.includes('|')) {
    return sanitizeId(id, 64)
  }
  const [callId, itemId] = id.split('|')
  const normalizedCallId = sanitizeId(callId, 64)
  let normalizedItemId = `fc_${shortHash(itemId)}`
  if (normalizedItemId.length > 64)
    normalizedItemId = normalizedItemId.slice(0, 64)
  return `${normalizedCallId}|${normalizedItemId}`
}

export function normalizeToolCallIdForGemini(id: string): string {
  return sanitizeId(id, 64)
}

export type ProviderType = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'

export interface RepairDiagnostics {
  inputMessages: number
  outputMessages: number
  legacyUserToolResultMessagesExploded: number
  legacyToolResultBlocksExploded: number
  legacyUserResidualMessagesPreserved: number
  assistantToolUseMessagesNormalized: number
  assistantTrailingBlocksDetached: number
  toolResultOrderRoundsRepaired: number
  syntheticToolResultsInserted: number
  orphanToolResultsTextified: number
  strayToolMessagesTextified: number
  unsupportedToolUsesDowngraded: number
  unsupportedToolResultsDowngraded: number
}

export interface TransformDiagnostics extends RepairDiagnostics {
  targetProvider: ProviderType
  idNormalizations: number
  signedThinkingDowngraded: number
  anthropicToolResultMessagesCompiled: number
  anthropicToolResultBlocksCompiled: number
  anthropicStrayToolMessagesTextified: number
}

export function createRepairDiagnostics(inputMessages = 0): RepairDiagnostics {
  return {
    inputMessages,
    outputMessages: inputMessages,
    legacyUserToolResultMessagesExploded: 0,
    legacyToolResultBlocksExploded: 0,
    legacyUserResidualMessagesPreserved: 0,
    assistantToolUseMessagesNormalized: 0,
    assistantTrailingBlocksDetached: 0,
    toolResultOrderRoundsRepaired: 0,
    syntheticToolResultsInserted: 0,
    orphanToolResultsTextified: 0,
    strayToolMessagesTextified: 0,
    unsupportedToolUsesDowngraded: 0,
    unsupportedToolResultsDowngraded: 0,
  }
}

export function createTransformDiagnostics(targetProvider: ProviderType, inputMessages: number): TransformDiagnostics {
  return {
    targetProvider,
    ...createRepairDiagnostics(inputMessages),
    idNormalizations: 0,
    signedThinkingDowngraded: 0,
    anthropicToolResultMessagesCompiled: 0,
    anthropicToolResultBlocksCompiled: 0,
    anthropicStrayToolMessagesTextified: 0,
  }
}

export function hasRepairMutations(diagnostics: RepairDiagnostics): boolean {
  return diagnostics.inputMessages !== diagnostics.outputMessages
    || diagnostics.legacyUserToolResultMessagesExploded > 0
    || diagnostics.legacyToolResultBlocksExploded > 0
    || diagnostics.legacyUserResidualMessagesPreserved > 0
    || diagnostics.assistantToolUseMessagesNormalized > 0
    || diagnostics.assistantTrailingBlocksDetached > 0
    || diagnostics.toolResultOrderRoundsRepaired > 0
    || diagnostics.syntheticToolResultsInserted > 0
    || diagnostics.orphanToolResultsTextified > 0
    || diagnostics.strayToolMessagesTextified > 0
    || diagnostics.unsupportedToolUsesDowngraded > 0
    || diagnostics.unsupportedToolResultsDowngraded > 0
}

export function hasTransformMutations(diagnostics: TransformDiagnostics): boolean {
  return hasRepairMutations(diagnostics)
    || diagnostics.idNormalizations > 0
    || diagnostics.signedThinkingDowngraded > 0
    || diagnostics.anthropicToolResultMessagesCompiled > 0
    || diagnostics.anthropicToolResultBlocksCompiled > 0
    || diagnostics.anthropicStrayToolMessagesTextified > 0
}

function getNormalizer(targetProvider: ProviderType): (id: string) => string {
  switch (targetProvider) {
    case 'anthropic': return normalizeToolCallIdForAnthropic
    case 'openai-chat': return normalizeToolCallIdForOpenAIChat
    case 'openai-responses': return normalizeToolCallIdForOpenAIResponses
    case 'gemini': return normalizeToolCallIdForGemini
  }
}

function stringifyContent(content: LLMMessage['content']): string {
  if (typeof content === 'string')
    return content
  return content
    .map((block): string => {
      switch (block.type) {
        case 'text':
        case 'thinking':
          return block.text
        case 'tool_result':
          return block.content
        case 'tool_use':
          return `[tool call] ${block.name} ${JSON.stringify(block.input)}`
        case 'image':
          return `[image:${block.mimeType}]`
        default: {
          const unhandledBlock: never = block
          throw new TypeError(`Unsupported LLM content block: ${JSON.stringify(unhandledBlock)}`)
        }
      }
    })
    .filter(Boolean)
    .join('\n')
}

function textifyToolMessage(msg: LLMMessage): LLMMessage | null {
  const content = stringifyContent(msg.content).trim()
  if (!content)
    return null
  return {
    role: 'user',
    content: `[Prior tool result: ${msg.toolName ?? 'unknown'}]\n${content}`,
  }
}

function hasToolUse(message: LLMMessage): boolean {
  return message.role === 'assistant'
    && typeof message.content !== 'string'
    && message.content.some(block => block.type === 'tool_use')
}

function extractToolUses(message: LLMMessage): Array<Extract<LLMContentBlock, { type: 'tool_use' }>> {
  if (!hasToolUse(message) || typeof message.content === 'string')
    return []
  return message.content.filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
}

function splitAssistantToolUseMessage(message: LLMMessage): { assistant: LLMMessage, residualAssistant?: LLMMessage } {
  if (!hasToolUse(message) || typeof message.content === 'string')
    return { assistant: message }

  const firstToolUseIndex = message.content.findIndex(block => block.type === 'tool_use')
  if (firstToolUseIndex < 0)
    return { assistant: message }

  const prefix = message.content.slice(0, firstToolUseIndex)
  const suffix = message.content.slice(firstToolUseIndex)
  const toolUses = suffix.filter((block): block is Extract<LLMContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
  const trailingNonToolUse = suffix.filter(block => block.type !== 'tool_use')

  const assistant: LLMMessage = {
    ...message,
    content: [...prefix, ...toolUses],
  }

  if (trailingNonToolUse.length === 0)
    return { assistant }

  return {
    assistant,
    residualAssistant: {
      role: 'assistant',
      content: trailingNonToolUse,
    },
  }
}

function createSyntheticToolResult(toolCallId: string, toolName: string): LLMMessage {
  return {
    role: 'tool',
    toolCallId,
    toolName,
    content: 'Tool call was interrupted before completion. Do not retry — continue with the conversation.',
    isError: false,
  }
}

function toAnthropicToolResultMessage(toolMessages: LLMMessage[], toolUses: Array<Extract<LLMContentBlock, { type: 'tool_use' }>>): LLMMessage {
  const toolById = new Map(toolMessages.map(msg => [msg.toolCallId ?? '', msg]))
  return {
    role: 'user',
    content: toolUses.map((toolUse) => {
      const toolMessage = toolById.get(toolUse.id)
      return {
        type: 'tool_result' as const,
        toolUseId: toolUse.id,
        toolName: toolMessage?.toolName ?? toolUse.name,
        content: stringifyContent(toolMessage?.content ?? 'No result provided (cross-provider handoff)'),
        ...(toolMessage?.isError ? { isError: true } : {}),
      }
    }),
  }
}

function normalizeIdsAndThinking(messages: LLMMessage[], targetProvider: ProviderType, targetSourceModel?: string): { messages: LLMMessage[], idNormalizations: number, signedThinkingDowngraded: number } {
  const normalizeId = getNormalizer(targetProvider)
  const toolCallIdMap = new Map<string, string>()
  let idNormalizations = 0
  let signedThinkingDowngraded = 0

  const getNormalizedId = (id: string): string => {
    const existing = toolCallIdMap.get(id)
    if (existing)
      return existing
    const normalized = normalizeId(id)
    toolCallIdMap.set(id, normalized)
    if (normalized !== id)
      idNormalizations++
    return normalized
  }

  return {
    messages: messages.map((msg): LLMMessage => {
      if (msg.role === 'tool') {
        const originalId = msg.toolCallId ?? ''
        return {
          ...msg,
          toolCallId: getNormalizedId(originalId),
        }
      }

      if (msg.role === 'assistant' && typeof msg.content !== 'string') {
        const transformedContent: LLMContentBlock[] = []
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            transformedContent.push({ ...block, id: getNormalizedId(block.id) })
          }
          else if (block.type === 'thinking') {
            if (targetProvider === 'openai-chat') {
              // OpenAI Chat 不支持 thinking 块 — 降级为 text
              signedThinkingDowngraded++
              if (block.text) transformedContent.push({ type: 'text', text: block.text })
            }
            else if (targetSourceModel && block.sourceModel && block.sourceModel !== targetSourceModel) {
              // 跨模型: signature 不兼容。目标分化:
              //   openai-responses → 降级为 text (codec 只回传合法 reasoning item signature,
              //     无 signature 的 thinking 块会被跳过, 文本会静默丢失)
              //   anthropic/gemini → 保留 thinking 类型, 清空 signature
              //     (DeepSeek 等 Anthropic 兼容 API 要求 thinking 块必须回传)
              signedThinkingDowngraded++
              if (targetProvider === 'openai-responses') {
                if (block.text) transformedContent.push({ type: 'text', text: block.text })
              }
              else {
                transformedContent.push({ type: 'thinking', text: block.text ?? '', sourceModel: block.sourceModel })
              }
            }
            else if (!block.sourceModel && block.signature) {
              // 无 sourceModel 但有 signature — 来源不明, 同样按目标分化处理
              signedThinkingDowngraded++
              if (targetProvider === 'openai-responses') {
                if (block.text) transformedContent.push({ type: 'text', text: block.text })
              }
              else {
                transformedContent.push({ type: 'thinking', text: block.text ?? '' })
              }
            }
            else {
              // 同 provider + 同 model 保留 thinking 块 (含 signature)
              transformedContent.push(block)
            }
          }
          else {
            transformedContent.push(block)
          }
        }
        return { ...msg, content: transformedContent }
      }

      if (msg.role === 'user' && typeof msg.content !== 'string') {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (block.type === 'tool_result') {
              return {
                ...block,
                toolUseId: getNormalizedId(block.toolUseId),
              }
            }
            return block
          }),
        }
      }

      return msg
    }),
    idNormalizations,
    signedThinkingDowngraded,
  }
}

function explodeLegacyUserToolResults(messages: LLMMessage[], diagnostics?: RepairDiagnostics): LLMMessage[] {
  const result: LLMMessage[] = []

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string' || !msg.content.some(block => block.type === 'tool_result')) {
      result.push(msg)
      continue
    }

    diagnostics && diagnostics.legacyUserToolResultMessagesExploded++

    let pendingUserBlocks: LLMContentBlock[] = []
    const flushPendingUserBlocks = () => {
      if (pendingUserBlocks.length === 0)
        return
      diagnostics && diagnostics.legacyUserResidualMessagesPreserved++
      result.push({ role: 'user', content: pendingUserBlocks })
      pendingUserBlocks = []
    }

    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        diagnostics && diagnostics.legacyToolResultBlocksExploded++
        flushPendingUserBlocks()
        result.push({
          role: 'tool',
          toolCallId: block.toolUseId,
          toolName: block.toolName,
          content: block.content,
          ...(block.isError ? { isError: true } : {}),
        })
      }
      else {
        pendingUserBlocks.push(block)
      }
    }

    flushPendingUserBlocks()
  }

  return result
}

function sanitizeUnsupportedHistoricalTools(
  messages: LLMMessage[],
  targetProvider: ProviderType,
  diagnostics?: RepairDiagnostics,
): LLMMessage[] {
  const builtinToolNames = listBuiltinLlmTools(targetProvider as DefaultsProviderType).map(tool => tool.name)
  const allowedToolNames = new Set(builtinToolNames)
  const allowedHistoricalToolNames = new Set<string>(allowedToolNames)
  const canonicalIntents = getProviderToolCatalog(targetProvider).getCanonicalToolIntents()
  for (const builtinName of builtinToolNames) {
    const canonicalIntent = canonicalIntents.find(intent => intent.aliases.includes(builtinName))
    if (!canonicalIntent)
      continue
    for (const alias of canonicalIntent.aliases)
      allowedHistoricalToolNames.add(alias)
  }
  const result: LLMMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (!hasToolUse(msg) || typeof msg.content === 'string') {
      result.push(msg)
      continue
    }

    const unsupportedIds = new Set<string>()
    const sanitizedContent: LLMContentBlock[] = []
    for (const block of msg.content) {
      if (block.type === 'tool_use' && findToolByAlias(block.name) && !allowedHistoricalToolNames.has(block.name)) {
        unsupportedIds.add(block.id)
        diagnostics && diagnostics.unsupportedToolUsesDowngraded++
        sanitizedContent.push({
          type: 'text',
          text: `[previous unsupported tool call: ${block.name}] ${JSON.stringify(block.input)}`,
        })
        continue
      }
      sanitizedContent.push(block)
    }

    // 降级产生的是 text 块: Anthropic 契约要求 tool_use 之后不得再有非 tool_use 块,
    // 因此把非 tool_use 块统一提到首个 tool_use 之前 (与 splitAssistantToolUseMessage 的拆分语义一致)。
    const nonToolUseBlocks = sanitizedContent.filter(block => block.type !== 'tool_use')
    const toolUseBlocks = sanitizedContent.filter(block => block.type === 'tool_use')
    result.push({ ...msg, content: [...nonToolUseBlocks, ...toolUseBlocks] })

    if (unsupportedIds.size === 0)
      continue

    let nextIndex = i + 1
    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      const toolMessage = messages[nextIndex]
      const toolCallId = toolMessage.toolCallId ?? ''
      if (unsupportedIds.has(toolCallId)) {
        const note = textifyToolMessage(toolMessage)
        if (note) {
          diagnostics && diagnostics.unsupportedToolResultsDowngraded++
          result.push(note)
        }
      }
      else {
        result.push(toolMessage)
      }
      nextIndex++
    }

    i = nextIndex - 1
  }

  return result
}

function repairConversationHistoryDetailed(messages: LLMMessage[]): { messages: LLMMessage[], diagnostics: RepairDiagnostics } {
  const diagnostics = createRepairDiagnostics(messages.length)
  const canonical = explodeLegacyUserToolResults(messages, diagnostics)
  const result: LLMMessage[] = []

  for (let i = 0; i < canonical.length; i++) {
    const msg = canonical[i]

    if (hasToolUse(msg)) {
      const { assistant, residualAssistant } = splitAssistantToolUseMessage(msg)
      if (assistant !== msg)
        diagnostics.assistantToolUseMessagesNormalized++

      const toolUses = extractToolUses(assistant)
      const toolUseIds = toolUses.map(toolUse => toolUse.id)
      const toolNameById = new Map(toolUses.map(toolUse => [toolUse.id, toolUse.name]))

      result.push(assistant)

      let nextIndex = i + 1
      const contiguousTools: LLMMessage[] = []
      while (nextIndex < canonical.length && canonical[nextIndex].role === 'tool') {
        contiguousTools.push(canonical[nextIndex])
        nextIndex++
      }

      const originalContiguousOrder = contiguousTools.map(toolMessage => toolMessage.toolCallId ?? '')
      const toolById = new Map<string, LLMMessage>()
      const orphanTools: LLMMessage[] = []
      for (const toolMessage of contiguousTools) {
        const toolCallId = toolMessage.toolCallId ?? ''
        if (toolUseIds.includes(toolCallId) && !toolById.has(toolCallId))
          toolById.set(toolCallId, toolMessage)
        else
          orphanTools.push(toolMessage)
      }

      const matchedInOriginalOrder = originalContiguousOrder.filter(id => toolUseIds.includes(id))
      if (matchedInOriginalOrder.some((id, index) => id !== toolUseIds[index]))
        diagnostics.toolResultOrderRoundsRepaired++

      for (const toolUseId of toolUseIds) {
        const matched = toolById.get(toolUseId)
        if (!matched)
          diagnostics.syntheticToolResultsInserted++
        result.push(matched ?? createSyntheticToolResult(toolUseId, toolNameById.get(toolUseId) ?? 'unknown'))
      }

      if (residualAssistant) {
        diagnostics.assistantTrailingBlocksDetached += Array.isArray(residualAssistant.content) ? residualAssistant.content.length : 1
        result.push(residualAssistant)
      }

      for (const orphanTool of orphanTools) {
        const note = textifyToolMessage(orphanTool)
        if (note) {
          diagnostics.orphanToolResultsTextified++
          result.push(note)
        }
      }

      i = nextIndex - 1
      continue
    }

    if (msg.role === 'tool') {
      const note = textifyToolMessage(msg)
      if (note) {
        diagnostics.strayToolMessagesTextified++
        result.push(note)
      }
      continue
    }

    result.push(msg)
  }

  diagnostics.outputMessages = result.length
  return { messages: result, diagnostics }
}

export function repairConversationHistory(messages: LLMMessage[], diagnostics?: RepairDiagnostics): LLMMessage[] {
  const repaired = repairConversationHistoryDetailed(messages)
  if (diagnostics)
    Object.assign(diagnostics, repaired.diagnostics)
  return repaired.messages
}

function compileCanonicalForAnthropic(messages: LLMMessage[], diagnostics?: TransformDiagnostics): LLMMessage[] {
  const result: LLMMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (hasToolUse(msg)) {
      const toolUses = extractToolUses(msg)
      result.push(msg)

      let nextIndex = i + 1
      const contiguousTools: LLMMessage[] = []
      while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
        contiguousTools.push(messages[nextIndex])
        nextIndex++
      }

      result.push(toAnthropicToolResultMessage(contiguousTools, toolUses))
      if (diagnostics) {
        diagnostics.anthropicToolResultMessagesCompiled++
        diagnostics.anthropicToolResultBlocksCompiled += toolUses.length
      }
      i = nextIndex - 1
      continue
    }

    if (msg.role === 'tool') {
      const note = textifyToolMessage(msg)
      if (note) {
        diagnostics && diagnostics.anthropicStrayToolMessagesTextified++
        result.push(note)
      }
      continue
    }

    result.push(msg)
  }

  return result
}

function transformMessagesDetailed(
  messages: LLMMessage[],
  targetProvider: ProviderType,
  targetModel?: string,
): { messages: LLMMessage[], diagnostics: TransformDiagnostics } {
  const diagnostics = createTransformDiagnostics(targetProvider, messages.length)
  const targetSourceModel = targetModel ? `${targetProvider}:${targetModel}` : undefined
  const normalized = normalizeIdsAndThinking(messages, targetProvider, targetSourceModel)
  diagnostics.idNormalizations = normalized.idNormalizations
  diagnostics.signedThinkingDowngraded = normalized.signedThinkingDowngraded

  const repairedCanonical = repairConversationHistoryDetailed(normalized.messages)
  const sanitizedCanonical = sanitizeUnsupportedHistoricalTools(repairedCanonical.messages, targetProvider, repairedCanonical.diagnostics)
  Object.assign(diagnostics, repairedCanonical.diagnostics, {
    targetProvider,
    idNormalizations: diagnostics.idNormalizations,
    signedThinkingDowngraded: diagnostics.signedThinkingDowngraded,
    anthropicToolResultMessagesCompiled: diagnostics.anthropicToolResultMessagesCompiled,
    anthropicToolResultBlocksCompiled: diagnostics.anthropicToolResultBlocksCompiled,
    anthropicStrayToolMessagesTextified: diagnostics.anthropicStrayToolMessagesTextified,
  })

  if (targetProvider === 'anthropic') {
    const compiled = compileCanonicalForAnthropic(sanitizedCanonical, diagnostics)
    diagnostics.outputMessages = compiled.length
    return { messages: compiled, diagnostics }
  }

  diagnostics.outputMessages = sanitizedCanonical.length
  return { messages: sanitizedCanonical, diagnostics }
}

// ── transformMessages: provider-aware 修复 + 编译 ──

export function transformMessages(
  messages: LLMMessage[],
  targetProvider: ProviderType,
  diagnostics?: TransformDiagnostics,
  targetModel?: string,
): LLMMessage[] {
  const transformed = transformMessagesDetailed(messages, targetProvider, targetModel)
  if (diagnostics)
    Object.assign(diagnostics, transformed.diagnostics)
  return transformed.messages
}
