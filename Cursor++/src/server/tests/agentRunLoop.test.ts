import type { ProvidersConfig } from '../data/defaults'
import type { LLMStreamEvent } from '../handlers/llm/types'
import type { ModelAnswer } from './doubles'
import { beforeEach, expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { handleConversationRun } from '../handlers/agent/conversationRuntime'
import { parseRunRequest } from '../handlers/agent/protocol'
import { createEphemeralSession } from '../handlers/agent/session'
import { reply, stubModel } from './doubles'
import { useTempAgentDatabase } from './helpers'

/** 两个 200K 窗口的模型, 只差输出上限 (默认的 8192 / 配了 64000) */
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

  for await (const _ of handleConversationRun(parsed, session)) {
    // 只关心模型收到了什么
  }
  return model
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
