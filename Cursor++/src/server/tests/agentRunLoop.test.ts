import type { ProvidersConfig } from '../data/defaults'
import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import type { ModelAnswer } from './doubles'
import { beforeEach, expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { estimateMessagesTokens } from '../handlers/agent/compactionStrategy'
import { handleConversationRun } from '../handlers/agent/conversationRuntime'
import { parseRunRequest } from '../handlers/agent/protocol'
import { createEphemeralSession } from '../handlers/agent/session'
import { reply, stubModel } from './doubles'
import { frameKind, useTempAgentDatabase } from './helpers'

/** 两个 200K 窗口的模型, 只差输出上限 (默认的 8192 / 配了 64000); 另有一个 128K 窗口的 */
const PROVIDERS: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [{
    id: 'loop-anthropic',
    name: 'Loop Anthropic',
    type: 'anthropic',
    baseUrl: '',
    auth: { kind: 'apiKey', value: 'test-key' },
    models: [
      { id: 'default-output', apiModel: 'default-output', displayName: 'Default output', thinking: false, contextTokenLimit: 200_000 },
      { id: 'large-output', apiModel: 'large-output', displayName: 'Large output', thinking: false, contextTokenLimit: 200_000, maxOutputTokens: 64_000 },
      { id: 'small-window', apiModel: 'small-window', displayName: 'Small window', thinking: false, contextTokenLimit: 128_000 },
    ],
  }],
}

useTempAgentDatabase()

beforeEach(() => {
  setProvidersForTests(PROVIDERS)
})

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

function todoWrite(id: string): ToolCall {
  return {
    id,
    name: 'TodoWrite',
    input: { merge: false, todos: [{ id: '1', content: 'do the work', status: 'in_progress' }] },
  }
}

async function* callTools(inputTokens: number, ...calls: ToolCall[]): AsyncGenerator<LLMStreamEvent> {
  for (const call of calls) {
    yield { type: 'tool_use_start', id: call.id, name: call.name }
    yield { type: 'tool_use_done', id: call.id, arguments: JSON.stringify(call.input) }
  }
  yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens, outputTokens: 50 } }
}

/** 在一个新会话里发一条消息并跑完整个循环, 模型由 answer 充当 (见 stubModel) */
async function run(modelId: string, answer: ModelAnswer) {
  const model = stubModel(modelId, answer)
  const session = createEphemeralSession(`run-loop-${Math.random()}`)
  const parsed = parseRunRequest({
    runRequest: {
      conversationId: 'conv-run-loop',
      action: { userMessageAction: { userMessage: { text: 'do the work' }, requestContext: {} } },
      modelDetails: { modelId },
    },
  })

  const frames: string[] = []
  for await (const frame of handleConversationRun(parsed, session))
    frames.push(frameKind(frame))
  return { frames, ...model }
}

it('reserves the model\'s real output limit when deciding to compact', async () => {
  // 200K 窗口: 按默认的 8192 输出预留, 触发线是 171,808; 按配置的 64000 (预留封顶 20K) 是 160,000。
  // 第二轮模型上报占用 165K —— 只有后者该触发。(第一轮是铺垫: 得先有一轮能被摘要取代的历史)
  const answer = (attempt: number) => attempt <= 2 ? callTools(attempt === 1 ? 1_000 : 165_000, todoWrite(`call_${attempt}`)) : reply('done')

  const withDefaultOutput = await run('default-output', answer)
  const withLargeOutput = await run('large-output', answer)

  expect(withDefaultOutput.compactedAfter).toEqual([])
  expect(withLargeOutput.compactedAfter).toEqual([2])
})

it('counts the tool results of the current round on top of the usage the model reported', async () => {
  // 第二轮模型上报占用 150K, 离 171,808 的触发线还差两万多。这一轮 30 个工具结果各约 1K token ——
  // 而全部消息的估算远小于 150K, 只取两者较大值的话占用纹丝不动, 不会触发。
  const calls = Array.from({ length: 30 }, (_, i): ToolCall => ({
    id: `call_${i}`,
    name: 'TodoWrite',
    input: { merge: false, todos: [{ id: String(i), content: 'x'.repeat(5_000), status: 'pending' }] },
  }))

  const { compactedAfter } = await run('default-output', (attempt) => {
    if (attempt === 1)
      return callTools(1_000, todoWrite('call_first'))
    return attempt === 2 ? callTools(150_000, ...calls) : reply('done')
  })

  expect(compactedAfter).toEqual([2])
})

it('lets the usage the model reports bring an inflated estimate back down', async () => {
  // 第一轮上报 100K, 60 个工具结果各约 1K token 叠上去, 估算到了 160K。第二轮模型上报 110K ——
  // 以它为准再叠 15 个结果是 125K, 不触线; 只增不减的话是 160K 再叠 15K, 越过 171,808。
  const calls = (count: number) => Array.from({ length: count }, (_, i): ToolCall => ({
    id: `call_${count}_${i}`,
    name: 'TodoWrite',
    input: { merge: false, todos: [{ id: String(i), content: 'x'.repeat(4_100), status: 'pending' }] },
  }))

  const { compactedAfter } = await run('default-output', (attempt) => {
    if (attempt === 1)
      return callTools(100_000, ...calls(60))
    return attempt === 2 ? callTools(110_000, ...calls(15)) : reply('done')
  })

  expect(compactedAfter).toEqual([])
})

/** 工具定义之类的固定开销: 模型上报的用量里有, 消息估算里没有 */
const SCAFFOLD_TOKENS = 25_000

function promptTokens(request: LLMStreamRequest): number {
  return estimateMessagesTokens(request.messages) + SCAFFOLD_TOKENS
}

/**
 * 一个如实上报用量的模型: 前 rounds 轮每轮并行调 callsPerRound 次工具,
 * 每次调用本身约 tokensPerCall 个 token, 之后收尾。
 */
function longToolChain(rounds: number, tokensPerCall: number, callsPerRound = 1) {
  return async function* (attempt: number, request: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
    if (attempt > rounds) {
      yield { type: 'text_delta', text: 'all done' }
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: promptTokens(request), outputTokens: 20 } }
      return
    }
    for (let call = 0; call < callsPerRound; call++) {
      const id = `call_${attempt}_${call}`
      const input = { merge: false, todos: [{ id, content: 'x'.repeat(tokensPerCall * 4), status: 'pending' }] }
      yield { type: 'tool_use_start', id, name: 'TodoWrite' }
      yield { type: 'tool_use_done', id, arguments: JSON.stringify(input) }
    }
    yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: promptTokens(request), outputTokens: tokensPerCall * callsPerRound } }
  }
}

/** 相邻两次压缩之间隔了几轮对话 */
function gapsBetween(compactedAfter: number[]): number[] {
  return compactedAfter.slice(1).map((after, i) => after - compactedAfter[i]!)
}

it('gets through a 40-round tool chain in a 128K window without overflowing or compacting every round', async () => {
  // 每轮约 9K token, 40 轮共 36 万 —— 是窗口的近三倍, 不压缩一定超窗
  const { frames, conversationRequests, compactedAfter } = await run('small-window', longToolChain(40, 8_000))

  expect(frames).toContain('textDelta')
  expect(conversationRequests).toHaveLength(41)
  expect(Math.max(...conversationRequests.map(promptTokens))).toBeLessThan(128_000)
  expect(compactedAfter.length).toBeGreaterThanOrEqual(2)
  expect(compactedAfter.length).toBeLessThan(40 / 3)
  expect(Math.min(...gapsBetween(compactedAfter))).toBeGreaterThanOrEqual(3)
  // 压缩了好几次之后, 每次请求里仍有用户的原话, 而不只是摘要里的转述
  expect(conversationRequests.every(request => JSON.stringify(request.messages).includes('do the work'))).toBe(true)
})

it('does not compact after every round when rounds of parallel tool calls are large', async () => {
  // 每轮并行调 3 次工具, 共约 27K token、4 条历史。压缩时若按条数留下最近 6 条 (补齐配对后是两整轮,
  // 5.4 万), 加上固定开销已近 8 万, 下一轮必定再次触线 —— 每轮都压一次。
  const { frames, conversationRequests, compactedAfter } = await run('small-window', longToolChain(12, 8_000, 3))

  expect(frames).toContain('textDelta')
  expect(Math.max(...conversationRequests.map(promptTokens))).toBeLessThan(128_000)
  expect(Math.min(...gapsBetween(compactedAfter))).toBeGreaterThanOrEqual(2)
})
