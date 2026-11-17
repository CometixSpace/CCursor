import type { LLMContentBlock, LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toJsonString } from '@bufbuild/protobuf'
import { expect, it } from 'vitest'
import { persistBlob } from '../database/blobs'
import { getPersistedConversationCheckpoint, persistConversationCheckpoint } from '../database/checkpoints'
import { resetAgentDatabaseForTests } from '../database/sqlite'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { cacheBlob, getCachedBlob, resetBlobCacheForTests, warmupBlobsAsync } from '../handlers/agent/blobStore'
import { checkpoint, kvMessage, summary, summaryCompleted, summaryStarted } from '../handlers/agent/stream'
import { finalizeToolCall } from '../handlers/agent/toolLifecycle'
import { addUsage, clampTokenDetails, computeContextUsagePercent, emptyUsageTotals, estimateContextTokens } from '../handlers/agent/usage'
import { resolvePromptProfile } from '../handlers/llm/promptProfile'
import { resolveProviderRuntime } from '../handlers/llm/providerRuntime'
import { routeModel } from '../handlers/llm/router'
import { anthropicStateStrategy, geminiStateStrategy } from '../handlers/llm/stateStrategy'
import { inferModelContextMetadata, resolveModel } from '../handlers/models/mapper'

// 合成 providers 由 src/server/tests/setup.ts 通过 vitest setupFiles 全局注入。
// 测试里用到的 claude-sonnet-4 / qwen3.5-plus / glm-5 / gpt-5.4-medium /
// gemini-3.1-pro-preview 都在 setup.ts 的 TEST_PROVIDERS 里登记。

function createTestRoundContext(strategy: typeof anthropicStateStrategy | typeof geminiStateStrategy) {
  const pendingToolResults: LLMToolResultBlock[] = []
  return {
    pendingToolResults,
    createToolResult: strategy.createToolResult.bind(strategy),
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock) {
      strategy.addToolResult(messages, pendingToolResults, result)
    },
  }
}

it('provider state strategy preserves tool name on tool results for provider-specific replay', () => {
  const messages: LLMMessage[] = []
  const roundContext = createTestRoundContext(geminiStateStrategy)

  const finalized = finalizeToolCall({
    roundContext,
    messages,
    cursorToolType: 'webSearchToolCall',
    toolName: 'web_search',
    callId: 'call-gemini-tool',
    startedArgs: { searchTerm: 'cursor byok', toolCallId: 'call-gemini-tool' },
    rawToolResult: { result: { case: 'success', value: { references: [{ title: 'web', url: 'https://example.com/x', chunk: 'cursor byok' }] } } },
    input: { searchTerm: 'cursor byok' },
    modelCallId: 'model-gemini-tool',
  })

  expect(finalized.frame.message.case).toBe('interactionUpdate')
  if (finalized.frame.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(finalized.frame.message.value.message.case).toBe('toolCallCompleted')
  expect(messages.length).toBe(0)
  expect(roundContext.pendingToolResults.length).toBe(1)
  expect(roundContext.pendingToolResults[0]?.toolName).toBe('web_search')
})

it('resolvePromptProfile exposes provider-specific prompt and tool metadata', () => {
  const openaiProfile = resolvePromptProfile('gpt-5.4-medium')
  const geminiProfile = resolvePromptProfile('gemini-3.1-pro-preview')
  const fallbackProfile = resolvePromptProfile('composer-2-fast')

  // Cursor++ 把 OpenAI 拆成 openai-chat / openai-responses 两种 ProviderType
  expect(openaiProfile.provider).toBe('openai-chat')
  expect(openaiProfile.systemPromptStyle).toBe('openai-main')
  // OPENAI_VOCAB: Shell ReadFile ApplyPatch Write SwitchMode CallMcpTool ListMcpResources FetchMcpResource ReadLints
  expect(openaiProfile.promptVocabulary.join(' ')).toMatch(/ApplyPatch/)
  expect(openaiProfile.toolCatalog.observedTranscriptTools.join(' ')).toMatch(/ReadFile/)

  expect(geminiProfile.provider).toBe('gemini')
  expect(geminiProfile.systemPromptStyle).toBe('gemini-main')
  // GEMINI_VOCAB 用 PascalCase (TodoWrite, 不是 todo_write)
  expect(geminiProfile.promptVocabulary.join(' ')).toMatch(/TodoWrite/)
  expect(geminiProfile.toolCatalog.observedTranscriptTools.join(' ')).toMatch(/TodoWrite/)

  expect(fallbackProfile.variant).toBe('fallback')
  expect(fallbackProfile.systemPromptStyle).toBe('composer-fallback')
})

it('usage helpers accumulate totals and estimate context tokens for checkpointing', () => {
  const totals = addUsage(emptyUsageTotals(), {
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 40,
    cacheWriteTokens: 20,
  })

  expect(totals).toEqual({
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 40,
    cacheWriteTokens: 20,
  })
  expect(estimateContextTokens({ inputTokens: 1200, outputTokens: 300 })).toBe(1500)
  expect(clampTokenDetails(2500, 2000)).toEqual({ usedTokens: 2000, maxTokens: 2000 })
  expect(computeContextUsagePercent(1800, 2000)).toBe(90)
})

it('summary lifecycle builders emit Cursor-compatible interaction updates', () => {
  const started = summaryStarted()
  expect(started.message.case).toBe('interactionUpdate')
  if (started.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(started.message.value.message.case).toBe('summaryStarted')

  const delta = summary('Compacting chat context')
  expect(delta.message.case).toBe('interactionUpdate')
  if (delta.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(delta.message.value.message.case).toBe('summary')
  expect((delta.message.value.message.value as { summary: string }).summary).toBe('Compacting chat context')

  const completed = summaryCompleted('Chat context summarized.')
  expect(completed.message.case).toBe('interactionUpdate')
  if (completed.message.case !== 'interactionUpdate')
    throw new Error('unexpected case')
  expect(completed.message.value.message.case).toBe('summaryCompleted')
  expect((completed.message.value.message.value as { hookMessage?: string }).hookMessage).toBe('Chat context summarized.')
})

it('checkpoint carries non-zero tokenDetails used by Cursor compaction heuristics', () => {
  const frame = checkpoint(['blob-1'], 1536, 131072, 'AGENT_MODE_AGENT', { text: 'hello' }, {
    turnBlobIds: ['turn-1'],
  })
  expect(frame.message.case).toBe('conversationCheckpointUpdate')
  if (frame.message.case !== 'conversationCheckpointUpdate')
    throw new Error('unexpected case')
  const tokenDetails = frame.message.value.tokenDetails
  expect(tokenDetails?.usedTokens).toBe(1536)
  // maxTokens 经 normalizeContextWindowMaxTokens 规整为整齐显示值(取整到千): 131072 → 131000
  expect(tokenDetails?.maxTokens).toBe(131000)
  expect(frame.message.value.turns.map((id: Uint8Array) => Buffer.from(id).toString('utf-8'))).toEqual(['turn-1'])
})

it('checkpoint can carry summary archive blob references for compaction state', () => {
  const frame = checkpoint(['blob-1'], 512, 4096, 'AGENT_MODE_AGENT', undefined, {
    summaryArchiveIds: ['archive-1', 'archive-2'],
  })
  expect(frame.message.case).toBe('conversationCheckpointUpdate')
  if (frame.message.case !== 'conversationCheckpointUpdate')
    throw new Error('unexpected case')
  expect(
    frame.message.value.summaryArchives.map((id: Uint8Array) => Buffer.from(id).toString('utf-8')),
  ).toEqual(
    ['archive-1', 'archive-2'],
  )
})

it('kvMessage uses default id=0 for system-style scaffold blobs and id=1 for first ordered blob', () => {
  const systemJson = toJsonString(AgentServerMessageSchema, kvMessage(0, 'blob-system', 'data-system'))
  const preambleJson = toJsonString(AgentServerMessageSchema, kvMessage(1, 'blob-preamble', 'data-preamble'))

  expect(systemJson).not.toMatch(/"id":/)
  expect(systemJson).toMatch(/"setBlobArgs"/)
  expect(preambleJson).toMatch(/"id":1/)
})

it('resolveModel and inferred model metadata expose context window information', () => {
  const qwen = resolveModel('qwen3.5-plus')
  expect(qwen.contextTokenLimit).toBe(1000000)

  const glm = resolveModel('glm-5')
  expect(glm.provider).toBe('anthropic')
  expect(glm.contextTokenLimit).toBe(200000)

  const inferredClaude = inferModelContextMetadata('claude-sonnet-4', 'anthropic', { contextTokenLimit: 200000 })
  expect(inferredClaude.contextTokenLimit).toBe(200000)
})

it('routeModel exposes conversation codec aligned with prompt profile', () => {
  const openaiRoute = routeModel('gpt-5.4-medium')
  const geminiRoute = routeModel('gemini-3.1-pro-preview')
  expect(openaiRoute.provider.name).toBe('openai-chat')
  expect(openaiRoute.stateStrategy.name).toBe('openai-chat')
  expect(openaiRoute.conversationCodec.name).toBe('openai-chat')
  expect(openaiRoute.promptProfile.provider).toBe('openai-chat')
  expect(geminiRoute.provider.name).toBe('gemini')
  expect(geminiRoute.stateStrategy.name).toBe('gemini')
  expect(geminiRoute.conversationCodec.name).toBe('gemini-native')
  expect(geminiRoute.promptProfile.provider).toBe('gemini')
})

it('provider runtime prepares normalized messages and semantic turns together', () => {
  const runtime = resolveProviderRuntime('gpt-5.4-medium')
  const prepared = runtime.prepareConversation([
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '<user_query>hello</user_query>' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'private thought' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'call-1', name: 'ReadFile', input: { path: 'a.ts' } },
      ],
    },
  ])

  expect(prepared.normalizedMessages.length).toBe(3)
  expect(prepared.semanticTurns.length).toBe(3)
  expect(prepared.semanticTurns[0]?.kind).toBe('system')
  expect(prepared.semanticTurns[1]?.kind).toBe('user')
  expect(prepared.semanticTurns[2]?.kind).toBe('assistant')
  const assistant = prepared.normalizedMessages[2]
  expect(Array.isArray(assistant?.content)).toBeTruthy()
  const blocks = assistant?.content as LLMContentBlock[]
  expect(blocks.some(block => block.type === 'thinking')).toBe(false)
  expect(blocks.some(block => block.type === 'tool_use')).toBe(true)
})

it('provider runtime centralizes tool listing and round transitions', () => {
  const runtime = resolveProviderRuntime('claude-sonnet-4')
  const tools = runtime.listRuntimeTools([{ name: 'user-brave-search-brave_web_search', description: 'search', inputSchema: { type: 'object' } }])
  // anthropic provider 的 Read 工具 name 是 'Read' (PascalCase, 由 toolkit/definitions/Read.ts 定义)
  expect(tools.some(tool => tool.name === 'Read')).toBe(true)
  expect(tools.some(tool => tool.name === 'user-brave-search-brave_web_search')).toBe(true)

  const messages: LLMMessage[] = []
  const pending = [runtime.stateStrategy.createToolResult({
    toolCallId: 'call-rt',
    toolName: 'Read',
    content: 'file text',
    isError: false,
  })]
  const transition = runtime.transitionRound(
    messages,
    [{ type: 'tool_use', id: 'call-rt', name: 'Read', input: { path: 'a.ts' } }],
    pending,
  )
  expect(transition.assistantAdded).toBe(true)
  expect(transition.flushedToolResults).toBe(1)
  expect(transition.shouldContinue).toBe(true)
  expect(messages[0]?.role).toBe('assistant')
  expect(messages[1]?.role).toBe('tool')
  expect(pending.length).toBe(0)
})

it('provider runtime reorders anthropic tool results to match assistant tool_use order during transition', () => {
  const runtime = resolveProviderRuntime('claude-sonnet-4')
  const messages: LLMMessage[] = []
  const pending = [
    runtime.stateStrategy.createToolResult({
      toolCallId: 'call-b',
      toolName: 'Grep',
      content: 'grep result',
      isError: false,
    }),
    runtime.stateStrategy.createToolResult({
      toolCallId: 'call-a',
      toolName: 'Read',
      content: 'read result',
      isError: false,
    }),
  ]

  runtime.transitionRound(messages, [
    { type: 'text', text: '我先查两个地方。' },
    { type: 'tool_use', id: 'call-a', name: 'Read', input: { path: 'a.ts' } },
    { type: 'tool_use', id: 'call-b', name: 'Grep', input: { pattern: 'x', path: '.' } },
  ], pending)

  expect(messages).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先查两个地方。' },
        { type: 'tool_use', id: 'call-a', name: 'Read', input: { path: 'a.ts' } },
        { type: 'tool_use', id: 'call-b', name: 'Grep', input: { pattern: 'x', path: '.' } },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call-a',
      toolName: 'Read',
      content: 'read result',
    },
    {
      role: 'tool',
      toolCallId: 'call-b',
      toolName: 'Grep',
      content: 'grep result',
    },
  ])
})

it('provider runtime prepares provider stream requests from runtime metadata', () => {
  const runtime = resolveProviderRuntime('claude-sonnet-4')
  const prepared = runtime.prepareStreamRequest(
    [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
    [{ name: 'user-Context7-query-docs', description: 'query docs', inputSchema: { type: 'object' } }],
    4096,
  )

  expect(prepared.request.model).toBe(runtime.model)
  expect(prepared.request.thinking).toBe(runtime.thinking)
  expect(prepared.request.maxTokens).toBe(4096)
  expect(prepared.request.messages.length).toBe(2)
  expect(prepared.request.tools?.some(tool => tool.name === 'Read')).toBe(true)
  expect(prepared.request.tools?.some(tool => tool.name === 'user-Context7-query-docs')).toBe(true)
  expect(prepared.conversation.semanticTurns[0]?.kind).toBe('system')
  expect(prepared.conversation.semanticTurns[1]?.kind).toBe('user')
})

it('provider state strategy batches anthropic tool results but flushes canonical tool-role messages', () => {
  const anthropicMessages: LLMMessage[] = []
  const anthropicPending: LLMToolResultBlock[] = []
  const anthropicResult = anthropicStateStrategy.createToolResult({
    toolCallId: 'tool-a',
    toolName: 'ReadFile',
    content: 'ok',
    isError: false,
  })
  anthropicStateStrategy.addToolResult(anthropicMessages, anthropicPending, anthropicResult)
  expect(anthropicMessages.length).toBe(0)
  expect(anthropicPending.length).toBe(1)
  anthropicStateStrategy.flushToolResults(anthropicMessages, anthropicPending)
  expect(anthropicMessages[0]?.role).toBe('tool')
  expect(anthropicMessages[0]?.toolCallId).toBe('tool-a')

  const geminiMessages: LLMMessage[] = []
  const geminiPending: LLMToolResultBlock[] = []
  const geminiResult = geminiStateStrategy.createToolResult({
    toolCallId: 'tool-g',
    toolName: 'grep',
    content: 'match',
    isError: false,
  })
  geminiStateStrategy.addToolResult(geminiMessages, geminiPending, geminiResult)
  expect(geminiPending.length).toBe(1)
  expect(geminiMessages.length).toBe(0)
  geminiStateStrategy.flushToolResults(geminiMessages, geminiPending)
  expect(geminiMessages[0]?.role).toBe('tool')
  expect(geminiMessages[0]?.toolName).toBe('grep')
})

async function withTempAgentDatabase(run: () => Promise<void>): Promise<void> {
  const prevDbPath = process.env.BYOK_AGENT_DB_PATH
  const tempDir = mkdtempSync(join(tmpdir(), 'cursor-byok-agent-db-'))
  process.env.BYOK_AGENT_DB_PATH = join(tempDir, 'cursor.db')
  resetBlobCacheForTests()
  await resetAgentDatabaseForTests()

  try {
    await run()
  }
  finally {
    resetBlobCacheForTests()
    await resetAgentDatabaseForTests()
    if (prevDbPath === undefined)
      delete process.env.BYOK_AGENT_DB_PATH
    else process.env.BYOK_AGENT_DB_PATH = prevDbPath
    rmSync(tempDir, { recursive: true, force: true })
  }
}

it('blob store persists blobs to sqlite and reloads after memory cache reset', async () => {
  await withTempAgentDatabase(async () => {
    const blobId = 'blob-sqlite-roundtrip'
    const blobData = Buffer.from(JSON.stringify({ role: 'user', content: 'hello sqlite' })).toString('base64')

    // cacheBlob 内部对 persistBlob 采用 fire-and-forget; 测试需要确定写入已落盘,
    // 因此再显式 await 一次 persistBlob (幂等 INSERT OR REPLACE)。
    cacheBlob(blobId, blobData)
    await persistBlob(blobId, blobData)
    expect(getCachedBlob(blobId)).toBe(blobData)

    // 新版 getCachedBlob 是纯内存读取 —— DB 恢复需走 warmupBlobsAsync 显式预热。
    resetBlobCacheForTests()
    expect(getCachedBlob(blobId)).toBeUndefined()
    await warmupBlobsAsync([blobId])
    expect(getCachedBlob(blobId)).toBe(blobData)
  })
})

it('conversation checkpoints persist to sqlite and round-trip summary archives', async () => {
  await withTempAgentDatabase(async () => {
    await persistConversationCheckpoint({
      kind: 'committed',
      conversationId: 'conv-sqlite-1',
      rootBlobIds: ['blob-a', 'blob-b'],
      turnBlobIds: ['turn-a'],
      summaryArchiveIds: ['archive-1'],
      tokenDetails: { usedTokens: 321, maxTokens: 200000 },
      mode: 'AGENT_MODE_AGENT',
      updatedAt: 123456789,
    })

    expect(await getPersistedConversationCheckpoint('conv-sqlite-1')).toEqual({
      kind: 'committed',
      conversationId: 'conv-sqlite-1',
      rootBlobIds: ['blob-a', 'blob-b'],
      turnBlobIds: ['turn-a'],
      summaryArchiveIds: ['archive-1'],
      tokenDetails: { usedTokens: 321, maxTokens: 200000 },
      mode: 'AGENT_MODE_AGENT',
      updatedAt: 123456789,
    })
  })
})
