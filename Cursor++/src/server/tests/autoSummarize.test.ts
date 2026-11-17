import type { HistoryEntry } from '../handlers/agent/historyManager'
import type { LLMMessage } from '../handlers/llm/types'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetAgentDatabaseForTests } from '../database/sqlite'
import { encodeBlob } from '../handlers/agent/blob'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'
import { createCompactionArtifacts, estimateMessagesTokens, formatMessageForSummary, planCompaction } from '../handlers/agent/compactionStrategy'
import { hydrateHistoryEntries, isSummaryBlobMessage } from '../handlers/agent/historyManager'
import { clampTokenDetails, computeContextUsagePercent, getAutoCompactThreshold } from '../handlers/agent/usage'

// ─── helpers ───

function makeBlobEntry(role: string, content: string, extra?: Record<string, unknown>): { blobId: string, raw: Record<string, unknown>, message: LLMMessage } {
  const raw: Record<string, unknown> = { role, content, ...extra }
  const blob = encodeBlob(raw)
  cacheBlob(blob.blobId, blob.blobData)
  return {
    blobId: blob.blobId,
    raw,
    message: { role: role as 'system' | 'user' | 'assistant', content },
  }
}

function makeHistoryEntries(count: number, opts?: { withSystem?: boolean, withPreamble?: boolean }): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  if (opts?.withSystem) {
    entries.push(makeBlobEntry('system', 'You are a helpful assistant.'))
  }
  if (opts?.withPreamble) {
    entries.push(makeBlobEntry('user', '<user_info>\nUser context here\n</user_info>'))
  }
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const content = role === 'user'
      ? `User message ${Math.floor(i / 2) + 1}: ${'x'.repeat(200)}`
      : `Assistant response ${Math.floor(i / 2) + 1}: ${'y'.repeat(300)}`
    entries.push(makeBlobEntry(role, content))
  }
  return entries
}

// ─── setup / teardown ───

let tmpDbPath = ''

beforeEach(async () => {
  tmpDbPath = join(tmpdir(), `.tmp-auto-summarize-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  process.env.BYOK_AGENT_DB_PATH = tmpDbPath
  await resetAgentDatabaseForTests()
  resetBlobCacheForTests()
})

afterEach(async () => {
  await resetAgentDatabaseForTests()
  resetBlobCacheForTests()
  delete process.env.BYOK_AGENT_DB_PATH
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`)
    }
    catch {}
  }
})

// ─── getAutoCompactThreshold tests ───

it('getAutoCompactThreshold uses absolute buffer threshold', () => {
  // 绝对 buffer 模式 (对齐 Claude Code):
  //   threshold = maxTokens - min(maxOutputTokens, 20K outputReserve) - 20K buffer
  // 默认 maxOutputTokens=8192 → 100K 模型 threshold = 100000 - 8192 - 20000 = 71808
  expect(getAutoCompactThreshold(100000)).toBe(71808)
})

it('getAutoCompactThreshold caps output reserve at 20K', () => {
  // maxOutputTokens 超过 20K 时按 20K 计 — 200K 模型 threshold=160K (~80%, 基准)
  expect(getAutoCompactThreshold(200000, 64000)).toBe(160000)
  // 1M 模型 threshold=960K (~96%)
  expect(getAutoCompactThreshold(1000000, 32000)).toBe(960000)
})

it('auto compaction never triggers while the context window size is unknown', () => {
  // providers.json 里没配 contextTokenLimit 的模型, 窗口大小一路传下来是 0
  expect(getAutoCompactThreshold(0)).toBe(Infinity)
})

// ─── clampTokenDetails tests ───

it('clampTokenDetails clamps to valid range', () => {
  const result = clampTokenDetails(150000, 100000)
  expect(result.usedTokens).toBe(100000)
  expect(result.maxTokens).toBe(100000)
})

it('clampTokenDetails handles zero maxTokens', () => {
  const result = clampTokenDetails(5000, 0)
  expect(result.maxTokens).toBe(1)
  expect(result.usedTokens).toBe(1)
})

it('clampTokenDetails passes through valid values', () => {
  const result = clampTokenDetails(50000, 200000)
  expect(result.usedTokens).toBe(50000)
  expect(result.maxTokens).toBe(200000)
})

// ─── computeContextUsagePercent tests ───

it('computeContextUsagePercent computes correctly', () => {
  expect(computeContextUsagePercent(85000, 100000)).toBe(85)
  expect(computeContextUsagePercent(0, 100000)).toBe(0)
  expect(computeContextUsagePercent(100000, 100000)).toBe(100)
})

// ─── planCompaction tests ───

it('planCompaction preserves system and preamble in leading', () => {
  const entries = makeHistoryEntries(10, { withSystem: true, withPreamble: true })
  const plan = planCompaction(entries)

  expect(plan.leading.length).toBe(2)
  expect(plan.leading[0].message.role).toBe('system')
  expect((plan.leading[1].message.content as string).includes('<user_info>')).toBe(true)
  expect(plan.summarizeEntries.length > 0).toBeTruthy()
  expect(plan.keepTail.length > 0).toBeTruthy()
})

it('planCompaction keeps system+preamble in leading, compacts body', () => {
  // With system + preamble + 1 body entry:
  // leading = [system, preamble], body = [1 entry]
  // body.length=1 <= MEDIUM(2), keepTailCount=0, summarizeCount=1
  // So even a single body entry gets marked for summarize
  const entries = makeHistoryEntries(1, { withSystem: true, withPreamble: true })
  const plan = planCompaction(entries)

  expect(plan.leading.length).toBe(2) // system + preamble
  expect(plan.summarizeEntries.length + plan.keepTail.length).toBe(1)
})

it('planCompaction splits medium conversations correctly', () => {
  const entries = makeHistoryEntries(6, { withSystem: true })
  // body = 6 entries (excl system), body.length > MEDIUM_THRESHOLD(2)
  const plan = planCompaction(entries)

  expect(plan.leading.length).toBe(1) // system
  expect(plan.summarizeEntries.length > 0).toBeTruthy()
  expect(plan.keepTail.length >= 2).toBeTruthy()
  expect(plan.summarizeEntries.length + plan.keepTail.length).toBe(6)
})

// ─── createCompactionArtifacts tests ───

it('createCompactionArtifacts produces valid summary blob and archive', () => {
  const entries = makeHistoryEntries(10, { withSystem: true, withPreamble: true })
  const plan = planCompaction(entries)

  const artifacts = createCompactionArtifacts({
    plan,
    summaryText: '- User asked about X.\n- Assistant explained Y.',
    previousSummaryArchiveIds: [],
  })

  expect(artifacts.summaryBlobId).toBeTruthy()
  expect(artifacts.summaryBlobData).toBeTruthy()
  expect(artifacts.archiveBlobs.length > 0).toBeTruthy()
  expect(artifacts.nextRootBlobIds.length > 0).toBeTruthy()
  expect(artifacts.nextSummaryArchiveIds.length > 0).toBeTruthy()

  // nextRootBlobIds = leading + summary + keepTail
  expect(
    artifacts.nextRootBlobIds.length,
  ).toBe(
    plan.leading.length + 1 + plan.keepTail.length,
  )

  // summary blob should be in root IDs
  expect(artifacts.nextRootBlobIds.includes(artifacts.summaryBlobId)).toBeTruthy()
})

it('createCompactionArtifacts preserves previous summary archive IDs', () => {
  const entries = makeHistoryEntries(10, { withSystem: true })
  const plan = planCompaction(entries)

  const artifacts = createCompactionArtifacts({
    plan,
    summaryText: '- Previous summary context.',
    previousSummaryArchiveIds: ['old-archive-1', 'old-archive-2'],
  })

  expect(artifacts.nextSummaryArchiveIds.includes('old-archive-1')).toBeTruthy()
  expect(artifacts.nextSummaryArchiveIds.includes('old-archive-2')).toBeTruthy()
  expect(artifacts.nextSummaryArchiveIds.length >= 3).toBeTruthy() // old + new
})

// ─── hydrateHistoryEntries tests ───

it('hydrateHistoryEntries recovers cached blobs', () => {
  const entries = makeHistoryEntries(4)
  const blobIds = entries.map(e => e.blobId)

  const hydrated = hydrateHistoryEntries(blobIds)

  expect(hydrated.length).toBe(4)
  expect(hydrated[0].message.role).toBe('user')
  expect(hydrated[1].message.role).toBe('assistant')
})

it('hydrateHistoryEntries skips missing blobs', () => {
  const entries = makeHistoryEntries(2)
  const blobIds = [entries[0].blobId, 'nonexistent-blob-id', entries[1].blobId]

  const hydrated = hydrateHistoryEntries(blobIds)

  expect(hydrated.length).toBe(2)
})

// ─── isSummaryBlobMessage tests ───

it('isSummaryBlobMessage detects summary blobs', () => {
  expect(isSummaryBlobMessage({
    role: 'assistant',
    content: 'Previous conversation summary:\n- stuff',
    providerOptions: { cursor: { isSummary: true } },
  })).toBe(true)

  expect(isSummaryBlobMessage({
    role: 'assistant',
    content: 'Normal response',
  })).toBe(false)
})

// ─── formatMessageForSummary tests ───

it('formatMessageForSummary formats string content', () => {
  const result = formatMessageForSummary({ role: 'user', content: 'Hello world' })
  expect(result).toMatch(/user:\nHello world/)
})

it('formatMessageForSummary formats content blocks', () => {
  const msg: LLMMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'I should help' },
      { type: 'text', text: 'Here is the answer' },
      { type: 'tool_use', id: 't1', name: 'readFile', input: { path: '/foo' } },
    ],
  }
  const result = formatMessageForSummary(msg)
  expect(result).toMatch(/\[thinking\] I should help/)
  expect(result).toMatch(/Here is the answer/)
  expect(result).toMatch(/\[tool call\] readFile/)
})

// ─── estimateMessagesTokens tests ───

it('estimateMessagesTokens provides reasonable estimates', () => {
  const messages: LLMMessage[] = [
    { role: 'user', content: 'a'.repeat(400) }, // ~100 tokens
    { role: 'assistant', content: 'b'.repeat(800) }, // ~200 tokens
  ]
  const estimate = estimateMessagesTokens(messages)
  expect(estimate >= 200, `expected >= 200, got ${estimate}`).toBeTruthy()
  expect(estimate <= 400, `expected <= 400, got ${estimate}`).toBeTruthy()
})

it('estimateMessagesTokens counts CJK text at about one token per character', () => {
  expect(estimateMessagesTokens([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100)
  expect(estimateMessagesTokens([{ role: 'user', content: '压'.repeat(400) }])).toBe(400)
  expect(estimateMessagesTokens([{ role: 'user', content: '压缩'.repeat(100) + 'a'.repeat(400) }])).toBe(300)
})

// ─── End-to-end compaction flow test ───

it('end-to-end: compaction reduces blob count and token estimate', () => {
  const entries = makeHistoryEntries(20, { withSystem: true, withPreamble: true })
  const originalBlobIds = entries.map(e => e.blobId)
  const originalTokenEstimate = estimateMessagesTokens(entries.map(e => e.message))

  const plan = planCompaction(entries)
  expect(plan.summarizeEntries.length > 0, 'should have entries to summarize').toBeTruthy()

  const artifacts = createCompactionArtifacts({
    plan,
    summaryText: '- User discussed topics A, B, C.\n- Assistant provided solutions.',
    previousSummaryArchiveIds: [],
  })

  const compactedTokenEstimate = estimateMessagesTokens([
    ...plan.leading.map(e => e.message),
    { role: 'assistant', content: `Previous conversation summary:\n${artifacts.summaryText}` },
    ...plan.keepTail.map(e => e.message),
  ])

  expect(artifacts.nextRootBlobIds.length < originalBlobIds.length, `expected fewer blobs: ${artifacts.nextRootBlobIds.length} < ${originalBlobIds.length}`).toBeTruthy()
  expect(compactedTokenEstimate < originalTokenEstimate, `expected fewer tokens: ${compactedTokenEstimate} < ${originalTokenEstimate}`).toBeTruthy()

  // Verify compacted blobs can be hydrated
  const hydrated = hydrateHistoryEntries(artifacts.nextRootBlobIds)
  expect(hydrated.length > 0, 'compacted blobs should be hydratable').toBeTruthy()

  // Summary blob should be among them
  const summaryEntry = hydrated.find(e => isSummaryBlobMessage(e.raw))
  expect(summaryEntry, 'should have a summary blob in compacted history').toBeTruthy()
  expect(summaryEntry!.message.content as string).toMatch(/Previous conversation summary/)
})
