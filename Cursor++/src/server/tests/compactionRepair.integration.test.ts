import type { HistoryEntry } from '../handlers/agent/historyManager'
import type { LLMContentBlock, LLMMessage } from '../handlers/llm/types'
import { fromBinary } from '@bufbuild/protobuf'
import { expect, it } from 'vitest'
import { ConversationSummaryArchiveSchema } from '../gen/agent_v1_pb'
import { createCompactionArtifacts, planCompaction } from '../handlers/agent/compactionStrategy'
import { repairHistoryEntries } from '../handlers/agent/historyManager'
import { repairConversationHistory } from '../handlers/llm/transformMessages'

function makeEntry(index: number, message: LLMMessage): HistoryEntry {
  return {
    blobId: `blob-${index}`,
    raw: { role: message.role, content: message.content as unknown },
    message,
  }
}

function hasToolUse(message: LLMMessage): boolean {
  return message.role === 'assistant'
    && typeof message.content !== 'string'
    && message.content.some((block: LLMContentBlock) => block.type === 'tool_use')
}

function buildLegacyCompactionEntries(): HistoryEntry[] {
  return [
    makeEntry(0, { role: 'system', content: 'sys prompt' }),
    makeEntry(1, { role: 'user', content: '<user_info>env</user_info>' }),
    makeEntry(2, { role: 'user', content: 'user-1' }),
    makeEntry(3, { role: 'assistant', content: 'assistant-1' }),
    makeEntry(4, { role: 'user', content: 'user-2' }),
    makeEntry(5, {
      role: 'assistant',
      content: [
        { type: 'text', text: '先查一下。' },
        { type: 'tool_use', id: 'call_A', name: 'Read', input: { path: 'a.ts' } },
      ],
    }),
    makeEntry(6, {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_A', toolName: 'Read', content: 'read result' },
      ],
    }),
    makeEntry(7, { role: 'assistant', content: 'assistant-tail' }),
  ]
}

function toEntries(messages: LLMMessage[]): HistoryEntry[] {
  return messages.map((message, index) => makeEntry(index, message))
}

it('diagnostic: summarize-path planCompaction can still split legacy anthropic assistant/tool_result boundary before repair', () => {
  const entries = buildLegacyCompactionEntries()
  const plan = planCompaction(entries)

  expect(plan.leading.map(entry => entry.message.role)).toEqual(['system', 'user'])
  expect(plan.summarizeEntries.at(-1)?.message.role).toBe('assistant')
  expect(hasToolUse(plan.summarizeEntries.at(-1)!.message)).toBe(true)
  // tail 开头是用户的指令 (tool_result 的载体不算), 紧跟着才是那个和 tool_use 分了家的载体
  expect(plan.keepTail[0]?.message.content).toBe('user-2')
  expect(plan.keepTail[1]?.message.role).toBe('user')
  expect(Array.isArray(plan.keepTail[1]?.message.content)).toBe(true)
  expect(((plan.keepTail[1]?.message.content as LLMContentBlock[])[0] as Extract<LLMContentBlock, { type: 'tool_result' }>).type).toBe('tool_result')
})

it('after repairConversationHistory canonicalizes legacy anthropic tool results, planCompaction no longer splits the assistant/tool boundary', () => {
  const repairedMessages = repairConversationHistory(buildLegacyCompactionEntries().map(entry => entry.message))
  const repairedEntries = toEntries(repairedMessages)
  const plan = planCompaction(repairedEntries)

  expect(plan.leading.map(entry => entry.message.role)).toEqual(['system', 'user'])
  expect(plan.summarizeEntries.some(entry => hasToolUse(entry.message))).toBe(false)
  expect(plan.keepTail[0]?.message.role).toBe('user')
  expect(plan.keepTail[1]?.message.role).toBe('assistant')
  expect(hasToolUse(plan.keepTail[1]!.message)).toBe(true)
  expect(plan.keepTail[2]?.message.role).toBe('tool')
  expect(plan.keepTail[2]?.message.toolCallId).toBe('call_A')
})

it('runtime helper repairHistoryEntries materializes canonicalized entries before compaction planning', () => {
  const plan = planCompaction(repairHistoryEntries(buildLegacyCompactionEntries()))

  expect(plan.keepTail[1]?.message.role).toBe('assistant')
  expect(hasToolUse(plan.keepTail[1]!.message)).toBe(true)
  expect(plan.keepTail[2]?.message.role).toBe('tool')
  expect(plan.keepTail[2]?.message.toolCallId).toBe('call_A')
})

function buildToolChainEntries(rounds: number, resultChars: number, instruction = 'user-1'): HistoryEntry[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: instruction },
  ]
  for (let round = 0; round < rounds; round++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `call_${round}`, name: 'Read', input: { path: `${round}.ts` } }],
    })
    messages.push({ role: 'tool', content: 'x'.repeat(resultChars), toolCallId: `call_${round}`, toolName: 'Read' })
  }
  return toEntries(messages)
}

it('planCompaction summarizes the older rounds of a long tool chain instead of keeping the whole chain', () => {
  const plan = planCompaction(buildToolChainEntries(20, 100))

  expect(plan.summarizeEntries).toHaveLength(35)
  // 用户的指令 + 最近 3 轮
  expect(plan.keepTail.map(entry => entry.message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool'])
})

it('planCompaction keeps the user\'s instruction verbatim in the tail when it would otherwise survive only inside the summary', () => {
  const plan = planCompaction(buildToolChainEntries(20, 100, 'refactor the billing module'))
  const instruction = plan.keepTail[0]!

  expect(instruction.message).toEqual({ role: 'user', content: 'refactor the billing module' })
  // 摘要一侧也还有它: 摘要要对着任务来写
  expect(plan.summarizeEntries).toContain(instruction)

  // 它没有被摘要取代, 所以不记进 "已被摘要的消息"
  const artifacts = createCompactionArtifacts({ plan, summaryText: '- did things', previousSummaryArchiveIds: [] })
  const archive = fromBinary(ConversationSummaryArchiveSchema, artifacts.archiveBlobs[0]!.blobDataRaw!)
  const archived = archive.summarizedMessages.map(blobId => new TextDecoder().decode(blobId))
  expect(archived).toHaveLength(34)
  expect(archived).not.toContain(instruction.blobId)
  expect(artifacts.nextRootBlobIds.filter(blobId => blobId === instruction.blobId)).toHaveLength(1)
})

it('planCompaction does not mistake tool results or images carried by user messages for the instruction', () => {
  const chain = buildToolChainEntries(20, 100, 'the real request').map(entry => entry.message)
  // 第 10 轮之后: 旧形态的 tool_result 载体, 以及 Read 读到图片时附带的图片消息
  chain.splice(22, 0, { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_x', content: 'legacy result' }] }, { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] })

  const plan = planCompaction(toEntries(chain))

  expect(plan.keepTail[0]?.message.content).toBe('the real request')
})

it('planCompaction has nothing to summarize when the instruction it would keep verbatim is all that precedes the tail', () => {
  const plan = planCompaction(toEntries([
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'user-1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_0', name: 'Read', input: { path: '0.ts' } }] },
    { role: 'tool', content: 'file body', toolCallId: 'call_0', toolName: 'Read' },
  ]))

  // 指令原文留在 tail 里, 摘要什么也没取代
  expect(plan.summarizeEntries).toEqual([])
  expect(plan.keepTail).toHaveLength(3)
})

it('planCompaction does not keep an already answered question when nothing follows it', () => {
  const plan = planCompaction(toEntries([
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'user-1' },
    { role: 'assistant', content: 'assistant-1' },
  ]))

  // 钉回去的话, 压缩后的历史会以一条旧问题结尾, 答案却只在摘要里
  expect(plan.summarizeEntries.map(entry => entry.message.content)).toEqual(['user-1', 'assistant-1'])
  expect(plan.keepTail).toEqual([])
})

it('planCompaction trims an oversized tail to the token budget but always keeps the last round', () => {
  // 每个结果约 40K token, 128K 窗口的 tail 预算只有 32K: 一轮都装不下, 最后一轮照样留着
  const plan = planCompaction(buildToolChainEntries(12, 160_000), 128_000)

  expect(plan.keepTail.map(entry => entry.message.role)).toEqual(['user', 'assistant', 'tool'])
  expect(plan.keepTail[2]?.message.toolCallId).toBe('call_11')
})

it('planCompaction counts the instruction it keeps verbatim against the tail budget', () => {
  // 每轮约 8K token, 3.2 万的预算本来留得下 3 轮; 约 1 万 token 的指令占掉其中一轮的位置
  const plan = planCompaction(buildToolChainEntries(20, 32_000, 'x'.repeat(40_000)), 128_000)

  expect(plan.keepTail.map(entry => entry.message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
})

it('planCompaction leaves an instruction that alone exceeds the tail budget to the summary', () => {
  // 约 5 万 token 的指令, 128K 窗口的尾窗预算是 3.2 万: 原文留着的话它永远压不掉
  const plan = planCompaction(buildToolChainEntries(20, 100, 'x'.repeat(200_000)), 128_000)

  expect(plan.keepTail.some(entry => entry.message.role === 'user')).toBe(false)
  expect(plan.summarizeEntries[0]?.message.role).toBe('user')
})
