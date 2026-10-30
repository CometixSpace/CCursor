import type { LLMMessage } from '../handlers/llm/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as checkpoints from '../database/checkpoints'
import { closeAgentDatabase, resetAgentDatabaseForTests } from '../database/sqlite'
import { encodeBlob } from '../handlers/agent/blob'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { estimateMessagesTokens } from '../handlers/agent/compactionStrategy'
import { performInlineAutoSummarize } from '../handlers/agent/conversationRuntime'
import { parseRunRequest } from '../handlers/agent/protocol'
import { resolveProviderRuntime } from '../handlers/llm'

let tempDir = ''
let previousDbPath: string | undefined

beforeEach(async () => {
  previousDbPath = process.env.BYOK_AGENT_DB_PATH
  tempDir = mkdtempSync(join(tmpdir(), 'inline-compaction-test-'))
  process.env.BYOK_AGENT_DB_PATH = join(tempDir, 'agent.db')
  await resetAgentDatabaseForTests()
  resetBlobCacheForTests()
})

afterEach(async () => {
  await closeAgentDatabase()
  resetBlobCacheForTests()
  vi.restoreAllMocks()
  if (previousDbPath === undefined)
    delete process.env.BYOK_AGENT_DB_PATH
  else process.env.BYOK_AGENT_DB_PATH = previousDbPath
  rmSync(tempDir, { recursive: true, force: true })
})

// Generated fixtures only; no captured conversations or provider responses.
function toolHistory(): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'assistant', content: 'Previous conversation summary:\nSynthetic earlier progress.' },
    { role: 'user', content: 'Inspect the synthetic fixture.' },
  ]
  for (let round = 0; round < 32; round++) {
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `call-${round}`, name: 'Read', input: { path: 'fixture.ts' } }] },
      { role: 'tool', toolCallId: `call-${round}`, toolName: 'Read', content: 'synthetic result '.repeat(200) },
    )
  }
  return messages
}

async function compact(messages: LLMMessage[], output: string | Error, usedTokens = 112000, contextTokenLimit = 128000) {
  const allBlobIds = messages.map((message) => {
    const blob = encodeBlob(message)
    cacheBlob(blob.blobId, blob.blobData)
    return blob.blobId
  })
  const stream = vi.fn(async function* () {
    if (output instanceof Error)
      throw output
    yield { type: 'text_delta' as const, text: output }
  })
  const commit = vi.spyOn(checkpoints, 'persistConversationCheckpoint')
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'synthetic-compaction-test',
      modelDetails: { modelId: 'gpt-5.4-medium' },
      action: { userMessageAction: { userMessage: { text: 'Synthetic task' }, requestContext: {} } },
    },
  })
  const generator = performInlineAutoSummarize({
    parsed,
    allBlobIds,
    summaryArchiveIds: ['synthetic-archive'],
    usedTokensEstimate: usedTokens,
    contextTokenLimit,
    messages,
    readPaths: [],
    route: { ...resolveProviderRuntime(parsed.modelId), provider: { name: 'synthetic', stream } },
  })
  const events = []
  while (true) {
    const next = await generator.next()
    if (next.done)
      return { result: next.value, events, stream, commit }
    events.push(next.value)
  }
}

function eventTypes(events: Awaited<ReturnType<typeof compact>>['events']) {
  return events.map(event => event.message.case === 'interactionUpdate'
    ? event.message.value.message.case
    : event.message.case)
}

it('does not invoke the provider for an empty history or a previous summary alone', async () => {
  for (const messages of [[], [{ role: 'assistant' as const, content: 'Previous conversation summary:\nSynthetic summary.' }]]) {
    const run = await compact(messages, 'Unused summary')
    expect(run.result).toBeNull()
    expect(run.stream).not.toHaveBeenCalled()
    expect(run.commit).not.toHaveBeenCalled()
    expect(run.events).toHaveLength(0)
  }
})

it('preserves history and completes the UI interaction when a summary does not shrink it', async () => {
  const messages = toolHistory()
  const original = structuredClone(messages)
  const run = await compact(messages, 'oversized synthetic summary '.repeat(20000))
  expect(run.result).toBeNull()
  expect(run.stream).toHaveBeenCalledTimes(1)
  expect(run.commit).not.toHaveBeenCalled()
  expect(messages).toEqual(original)
  expect(eventTypes(run.events)).toEqual(['summaryStarted', 'summary', 'summaryCompleted'])
})

it('rejects a summary whose estimated size is exactly unchanged', async () => {
  const prefix = 'Previous conversation summary:\n'
  const run = await compact([{ role: 'user', content: 'x'.repeat(prefix.length + 8) }], 'x'.repeat(8))
  expect(run.result).toBeNull()
  expect(run.commit).not.toHaveBeenCalled()
  expect(eventTypes(run.events).at(-1)).toBe('summaryCompleted')
})

it.each([128000, 500000])('calibrates token usage and preserves archives at a %i-token window', async (window) => {
  const messages = toolHistory()
  const before = estimateMessagesTokens(messages)
  const upstreamUsage = Math.round(before * 1.7)
  const run = await compact(messages, 'Synthetic summary of completed work.', upstreamUsage, window)
  expect(run.result).not.toBeNull()
  const result = run.result!
  const after = estimateMessagesTokens(result.newMessages)
  expect(result.newBlobIds.length).toBeLessThan(messages.length)
  expect(result.newUsedTokens).toBe(Math.min(window, upstreamUsage, Math.round(after * upstreamUsage / before)))
  expect(result.newSummaryArchiveIds[0]).toBe('synthetic-archive')
  expect(run.commit).toHaveBeenCalledTimes(1)
  expect(eventTypes(run.events).filter(type => type === 'summaryStarted')).toHaveLength(1)
  expect(eventTypes(run.events).filter(type => type === 'summaryCompleted')).toHaveLength(1)
})

it('uses the local estimate when no previous usage is available', async () => {
  const run = await compact(toolHistory(), 'Synthetic summary.', 0)
  expect(run.result).not.toBeNull()
  expect(run.result!.newUsedTokens).toBe(estimateMessagesTokens(run.result!.newMessages))
})

it('can commit a shrinking local fallback after a provider failure', async () => {
  const run = await compact(toolHistory(), new Error('Synthetic provider failure'))
  expect(run.result).not.toBeNull()
  expect(run.result!.newBlobIds.length).toBeLessThan(toolHistory().length)
  expect(run.commit).toHaveBeenCalledTimes(1)
  expect(eventTypes(run.events).at(-1)).toBe('summaryCompleted')
})
