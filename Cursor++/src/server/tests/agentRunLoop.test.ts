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
