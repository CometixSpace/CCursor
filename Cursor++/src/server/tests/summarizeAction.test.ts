import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { ParsedRunRequest } from '../handlers/agent/protocol'
import { beforeEach, expect, it, vi } from 'vitest'
import { handleSummarizeAction } from '../handlers/agent/summarizeRuntime'
import { reply } from './doubles'
import { longHistory, useTempAgentDatabase } from './helpers'

/** 摘要模型的替身: 每个用例设置它的窗口大小和应答方式 */
const summaryModel = vi.hoisted(() => ({
  contextTokenLimit: 128_000,
  respond: (): AsyncIterable<unknown> => {
    throw new Error('summary model not stubbed')
  },
}))

vi.mock('../handlers/llm', async importOriginal => ({
  ...await importOriginal<typeof import('../handlers/llm')>(),
  resolveProviderRuntime: () => ({
    model: 'test-model',
    contextTokenLimit: summaryModel.contextTokenLimit,
    provider: { name: 'test', stream: () => summaryModel.respond() },
  }),
}))

useTempAgentDatabase()

beforeEach(() => {
  summaryModel.contextTokenLimit = 128_000
})

async function summarize(historyBlobIds: string[]) {
  const parsed = {
    conversationId: 'conv-summarize',
    modelId: 'claude-sonnet-4',
    mode: 'agent',
    historyBlobIds,
    historyTurnBlobIds: [],
    historySummaryArchiveIds: [],
    readPaths: [],
    env: {},
  } as unknown as ParsedRunRequest

  const frames: AgentServerMessage[] = []
  for await (const frame of handleSummarizeAction(parsed, null))
    frames.push(frame)
  return frames
}

/** checkpoint 帧里回写给客户端的历史 blobId 列表 */
function checkpointRoot(frames: AgentServerMessage[]): string[] {
  const checkpoint = frames.find(frame => frame.message.case === 'conversationCheckpointUpdate')
  if (checkpoint?.message.case !== 'conversationCheckpointUpdate')
    throw new Error('no checkpoint frame')
  return checkpoint.message.value.rootPromptMessagesJson.map(id => new TextDecoder().decode(id))
}

it('keeps the usual tail when the model has no configured context window', async () => {
  summaryModel.contextTokenLimit = 0
  summaryModel.respond = () => reply('- did the work')

  const frames = await summarize(longHistory())

  // 10 条正文按条数留 6 条, 加上系统提示和摘要共 8 条; 窗口未知时不该再按体积削减
  expect(checkpointRoot(frames)).toHaveLength(8)
})
