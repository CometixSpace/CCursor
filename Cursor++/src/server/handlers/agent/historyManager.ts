import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMContentBlock, LLMMessage } from '../llm/types'
import { logger } from '../../logger'
import { blobIdToBytes, decodeBlob, encodeBlob, jsonBlobDataFromClientBytes } from './blob'
import type { RunBlobStore } from './blobStore'
import { BlobIntegrityError, type BlobFailure } from './blobErrors'
import { fetchBlobsFromClient } from './clientBlobFetch'
import type { BlobRunContext } from './runContext'
import { normalizeBlobMessage, restoreBlobMessageToLLMMessage } from './transcript'
import { createRepairDiagnostics, hasRepairMutations, repairConversationHistory, type RepairDiagnostics } from '../llm/transformMessages'

export interface HistoryEntry {
  blobId: string
  blobData?: string
  raw: Record<string, unknown>
  message: LLMMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function retainMessageBlob(
  store: RunBlobStore,
  data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean, providerOptions?: Record<string, unknown> },
  blobIds: string[],
): void {
  const normalized = normalizeBlobMessage(data)
  const blob = encodeBlob(normalized)
  blobIds.push(blob.blobId)
  store.cacheBlob(blob.blobId, blob.blobData)
}

export function retainMessageBlobs(
  store: RunBlobStore,
  messages: LLMMessage[],
  startIndex: number,
  blobIds: string[],
): { nextIndex: number } {
  let nextIndex = startIndex
  for (let messageIndex = startIndex; messageIndex < messages.length; messageIndex++) {
    retainMessageBlob(store, messages[messageIndex]!, blobIds)
    nextIndex = messageIndex + 1
  }
  return { nextIndex }
}

export function extractPlainTextContent(message: LLMMessage): string {
  if (typeof message.content === 'string')
    return message.content
  return message.content
    .filter((block): block is Extract<LLMContentBlock, { type: 'text' | 'thinking' }> => block.type === 'text' || block.type === 'thinking')
    .map(block => block.text)
    .join('')
}

export function extractComparableUserTexts(message: LLMMessage): string[] {
  const text = extractPlainTextContent(message).trim()
  if (!text)
    return []

  const values = new Set<string>([text])
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const userQueryMatches = text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)
  for (const match of userQueryMatches) {
    const inner = match[1]?.trim()
    if (inner)
      values.add(inner)
  }

  return [...values]
}

export function hasSystemMessage(messages: LLMMessage[]): boolean {
  return messages.some(message => message.role === 'system')
}

export function isPreambleUserMessage(message: LLMMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string')
    return false
  return message.content.includes('<user_info>')
    && !message.content.includes('<user_query>')
}

export function hasPreambleUserMessage(messages: LLMMessage[]): boolean {
  return messages.some(isPreambleUserMessage)
}

function syncConversationScaffold(messages: LLMMessage[], systemMessage: LLMMessage, preambleUserMessage: LLMMessage): { messages: LLMMessage[], systemReplaced: boolean, preambleReplaced: boolean } {
  const next = [...messages]
  let systemReplaced = false
  let preambleReplaced = false

  const systemIndex = next.findIndex(message => message.role === 'system')
  if (systemIndex >= 0 && next[systemIndex]?.content !== systemMessage.content) {
    next[systemIndex] = systemMessage
    systemReplaced = true
  }

  const preambleIndex = next.findIndex(isPreambleUserMessage)
  if (preambleIndex >= 0 && next[preambleIndex]?.content !== preambleUserMessage.content) {
    next[preambleIndex] = preambleUserMessage
    preambleReplaced = true
  }

  return { messages: next, systemReplaced, preambleReplaced }
}

export function mergePrependUserMessages(
  messages: LLMMessage[],
  prependUserMessages: Array<{ text: string, messageId?: string }>,
): { messages: LLMMessage[], insertedTexts: string[] } {
  if (prependUserMessages.length === 0)
    return { messages, insertedTexts: [] }

  const existingUserTexts = new Set(
    messages
      .filter(message => message.role === 'user')
      .flatMap(extractComparableUserTexts)
      .filter(text => text.length > 0),
  )

  const missing = prependUserMessages
    .map(entry => entry.text)
    .filter(text => text.length > 0 && !existingUserTexts.has(text))

  if (missing.length === 0) {
    logger.info({ prependCount: prependUserMessages.length }, '[SESSION] prepend user messages already satisfied by history')
    return { messages, insertedTexts: [] }
  }

  const insertAt = messages.findIndex(message => message.role !== 'system' && !isPreambleUserMessage(message))
  const prefix = missing.map(text => ({ role: 'user' as const, content: text }))

  logger.info({
    prependCount: prependUserMessages.length,
    missingCount: missing.length,
    firstMissing: missing[0],
  }, '[SESSION] merging prepend user messages into history')

  if (insertAt === -1)
    return { messages: [...messages, ...prefix], insertedTexts: missing }
  return {
    messages: [...messages.slice(0, insertAt), ...prefix, ...messages.slice(insertAt)],
    insertedTexts: missing,
  }
}

/**
 * 摘要 blob 判定 — 双保险 (设计文档 §6 Q6):
 *   1. providerOptions.cursor.isSummary 语义标记 (修复后透传, 语义根治);
 *   2. 内容前缀 fallback: assistant 且以 `Previous conversation summary:` 开头
 *      (本插件格式) 或官方 `[Previous conversation summary]: ` 格式 ——
 *      对修复上线前的存量摘要 blob 立即生效 (标记已丢, 只剩前缀)。
 */
const SUMMARY_CONTENT_PREFIXES = [
  'Previous conversation summary:',
  '[Previous conversation summary]:',
] as const

function extractLeadingTextFromContent(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    const firstTextBlock = content.find(
      (block): block is Record<string, unknown> => isRecord(block) && block.type === 'text',
    )
    return typeof firstTextBlock?.text === 'string' ? firstTextBlock.text : ''
  }
  return ''
}

export function isSummaryBlobMessage(raw: Record<string, unknown>): boolean {
  const providerOptions = raw.providerOptions
  if (isRecord(providerOptions)) {
    const cursor = providerOptions.cursor
    if (isRecord(cursor) && cursor.isSummary === true)
      return true
  }
  if (raw.role === 'assistant') {
    const text = extractLeadingTextFromContent(raw.content).trimStart()
    return SUMMARY_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))
  }
  return false
}

function isValidHistoryBlock(block: unknown): boolean {
  if (!isRecord(block))
    return false
  switch (block.type) {
    case 'text':
    case 'reasoning':
    case 'thinking':
      return typeof block.text === 'string'
    case 'image':
      return typeof block.mimeType === 'string' && typeof block.data === 'string'
    case 'tool-call':
      return typeof block.toolCallId === 'string' && typeof block.toolName === 'string' && isRecord(block.args)
    case 'tool_use':
      return typeof block.id === 'string' && typeof block.name === 'string' && isRecord(block.input)
    case 'tool-result':
      return typeof block.toolCallId === 'string' && typeof block.result === 'string'
    case 'tool_result':
      return typeof block.toolUseId === 'string' && typeof block.content === 'string'
    default:
      return false
  }
}

export function decodeHistoryEntry(blobId: string, blobData: string): HistoryEntry {
  const decoded: unknown = decodeBlob(blobData)
  if (!isRecord(decoded)
    || !['system', 'user', 'assistant', 'tool'].includes(String(decoded.role))
    || !(typeof decoded.content === 'string'
      || (Array.isArray(decoded.content) && decoded.content.every(isValidHistoryBlock)))) {
    throw new Error('Blob is not a supported history message; refusing lossy restoration')
  }
  const message = restoreBlobMessageToLLMMessage(decoded)
  if (!message)
    throw new Error('Blob could not be restored to a history message')
  return { blobId, blobData, raw: decoded, message }
}

function retainClientHistoryEntry(store: RunBlobStore, blobId: string, bytes: Uint8Array): void {
  const blobData = jsonBlobDataFromClientBytes(bytes)
  if (blobData === null)
    throw new Error('Invalid JSON blob transport encoding')
  const entry = decodeHistoryEntry(blobId, blobData)
  store.cacheBlob(blobId, blobData, bytes)
  store.markClientSaved(blobId)
  store.historyEntries.set(blobId, entry)
}

export function hydrateHistoryEntries(blobIds: string[], store: RunBlobStore): HistoryEntry[] {
  return blobIds.map((blobId) => {
    const existing = store.historyEntries.get(blobId)
    if (existing)
      return existing
    const blobData = store.getCachedBlob(blobId)
    if (blobData === undefined)
      throw new BlobIntegrityError([{ blobId, status: 'not-found' }])
    try {
      const entry = decodeHistoryEntry(blobId, blobData)
      store.historyEntries.set(blobId, entry)
      return entry
    }
    catch (error) {
      throw new BlobIntegrityError([{ blobId, status: 'decode-error', message: (error as Error).message }])
    }
  })
}

export function retainHistoryEntries(store: RunBlobStore, entries: HistoryEntry[]): void {
  for (const entry of entries) {
    if (store.getCachedBlob(entry.blobId) === undefined) {
      const encoded = entry.blobData === undefined ? encodeBlob(entry.raw) : undefined
      if (encoded && encoded.blobId !== entry.blobId)
        throw new BlobIntegrityError([{ blobId: entry.blobId, status: 'missing-original-bytes' }])
      store.cacheBlob(entry.blobId, entry.blobData ?? encoded!.blobData)
    }
    store.historyEntries.set(entry.blobId, entry)
  }
}

export function materializeHistoryEntries(messages: LLMMessage[], store?: RunBlobStore): HistoryEntry[] {
  const entries = messages.map((message) => {
    const normalized = normalizeBlobMessage({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      providerOptions: message.providerOptions,
    })
    const blob = encodeBlob(normalized)
    return {
      blobId: blob.blobId,
      blobData: blob.blobData,
      raw: normalized as unknown as Record<string, unknown>,
      message,
    }
  })
  if (store)
    retainHistoryEntries(store, entries)
  return entries
}

function logHistoryRepair(stage: string, diagnostics: RepairDiagnostics, extra: Record<string, unknown> = {}): void {
  if (!hasRepairMutations(diagnostics))
    return
  logger.debug({
    stage,
    ...extra,
    ...diagnostics,
  }, '[HISTORY_REPAIR] canonicalized conversation history')
}

export function repairHistoryEntries(entries: HistoryEntry[], store?: RunBlobStore): HistoryEntry[] {
  const diagnostics = createRepairDiagnostics(entries.length)
  const repaired = repairConversationHistory(entries.map(entry => entry.message), diagnostics)
  logHistoryRepair('repairHistoryEntries', diagnostics, {
    entryCount: entries.length,
    inputBlobIds: entries.length,
  })
  if (!hasRepairMutations(diagnostics)) {
    if (store)
      retainHistoryEntries(store, entries)
    return entries
  }
  return materializeHistoryEntries(repaired, store)
}

export interface HistoryBlobLoadParams {
  historyBlobIds: string[]
  run: BlobRunContext
}

/**
 * Reference counts retain duplicates; only network requests are deduplicated.
 * Cached means usable, decoded data in THIS run, never a process history cache.
 */
export async function* loadHistoryEntries(params: HistoryBlobLoadParams): AsyncGenerator<AgentServerMessage, HistoryEntry[], void> {
  const store = params.run.blobs
  let requestedFromClient = 0
  const failures = new Map<string, BlobFailure>()
  const availableAtStart = new Set<string>()
  const fetchedBlobIds = new Set<string>()
  const missingBlobIds: string[] = []
  for (const blobId of new Set(params.historyBlobIds)) {
    try {
      if (store.getCachedBlob(blobId) === undefined) {
        const existingResult = params.run.getCompletedClientBlobResult(blobIdToBytes(blobId))
        if (existingResult?.status === 'ok')
          retainClientHistoryEntry(store, blobId, existingResult.bytes)
        else if (existingResult) {
          failures.set(blobId, { blobId, status: existingResult.status, message: existingResult.message })
          continue
        }
        else {
          missingBlobIds.push(blobId)
          continue
        }
      }
      hydrateHistoryEntries([blobId], store)
      availableAtStart.add(blobId)
    }
    catch (error) {
      if ((error as Error).name === 'BlobResourceLimitError')
        throw error
      failures.set(blobId, { blobId, status: 'decode-error', message: (error as Error).message })
    }
  }
  if (missingBlobIds.length > 0) {
    const fetchedResults = yield* fetchBlobsFromClient({
      run: params.run,
      blobIds: missingBlobIds.map(blobIdToBytes),
      onRequestSent: () => { requestedFromClient++ },
    })
    fetchedResults.forEach((result, index) => {
      const blobId = missingBlobIds[index]!
      if (result.status !== 'ok') {
        failures.set(blobId, { blobId, status: result.status, message: result.message })
        return
      }
      try {
        retainClientHistoryEntry(store, blobId, result.bytes)
        fetchedBlobIds.add(blobId)
      }
      catch (error) {
        if ((error as Error).name === 'BlobResourceLimitError')
          throw error
        failures.set(blobId, { blobId, status: 'decode-error', message: (error as Error).message })
      }
    })
  }

  const cachedBlobs = params.historyBlobIds.filter(blobId => availableAtStart.has(blobId)).length
  const fetchedFromClient = params.historyBlobIds.filter(blobId => fetchedBlobIds.has(blobId)).length
  const stillMissing = params.historyBlobIds.length - cachedBlobs - fetchedFromClient
  logger.info({
    requestedBlobs: params.historyBlobIds.length,
    uniqueBlobs: new Set(params.historyBlobIds).size,
    cachedBlobs,
    fetchedFromClient,
    requestedFromClient,
    uniqueMissingAtStart: missingBlobIds.length,
    stillMissing,
    resolvedBlobs: cachedBlobs + fetchedFromClient,
    ...(failures.size ? { failures: [...failures.values()] } : {}),
  }, '[SESSION] history blobs from cache')
  if (stillMissing > 0)
    throw new BlobIntegrityError([...failures.values()])
  return hydrateHistoryEntries(params.historyBlobIds, store)
}

export async function* rebuildConversationHistory(params: {
  historyBlobIds: string[]
  prependUserMessages: Array<{ text: string, messageId?: string }>
  systemMessage: LLMMessage
  preambleUserMessage: LLMMessage
  currentUserMessage: LLMMessage
  systemContent: string
  preambleUserContent: string
  sendSystemScaffoldBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => void
  sendOrderedBlob: (data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean }) => void
} & HistoryBlobLoadParams): AsyncGenerator<AgentServerMessage, { messages: LLMMessage[], insertedPrependUserTexts: string[] }, void> {
  let messages: LLMMessage[] = []
  let insertedPrependUserTexts: string[] = []

  if (params.historyBlobIds.length > 0) {
    const historyEntries = yield* loadHistoryEntries(params)
    messages = historyEntries.map(entry => entry.message)

    const scaffoldSynced = syncConversationScaffold(messages, params.systemMessage, params.preambleUserMessage)
    messages = scaffoldSynced.messages
    if (scaffoldSynced.systemReplaced || scaffoldSynced.preambleReplaced) {
      logger.debug({
        systemReplaced: scaffoldSynced.systemReplaced,
        preambleReplaced: scaffoldSynced.preambleReplaced,
      }, '[HISTORY_REPAIR] replaced provider-specific scaffold in restored history')
    }

    if (!hasSystemMessage(messages)) {
      messages.unshift(params.systemMessage)
      params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })
    }

    if (!hasPreambleUserMessage(messages)) {
      const insertAt = messages.findIndex(message => message.role !== 'system')
      if (insertAt === -1)
        messages.push(params.preambleUserMessage)
      else messages.splice(insertAt, 0, params.preambleUserMessage)
      params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent })
    }

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
    messages.push(params.currentUserMessage)
  }
  else {
    messages.push(params.systemMessage)
    params.sendSystemScaffoldBlob({ role: 'system', content: params.systemContent })

    messages.push(params.preambleUserMessage)
    params.sendOrderedBlob({ role: 'user', content: params.preambleUserContent });

    ({ messages, insertedTexts: insertedPrependUserTexts } = mergePrependUserMessages(messages, params.prependUserMessages))
    messages.push(params.currentUserMessage)
  }

  const diagnostics = createRepairDiagnostics(messages.length)
  const repaired = repairConversationHistory(messages, diagnostics)
  logHistoryRepair('rebuildConversationHistory', diagnostics, {
    historyBlobIds: params.historyBlobIds.length,
    insertedPrependUserTexts: insertedPrependUserTexts.length,
  })

  return {
    messages: repaired,
    insertedPrependUserTexts,
  }
}
