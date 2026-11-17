import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { onTestFinished, vi } from 'vitest'
import { SUMMARY_SYSTEM_PROMPT } from '../handlers/agent/summaryPrompt'
import { resolveProviderRuntime } from '../handlers/llm'

/** 模型的一次应答: 一段文字, 然后正常结束 */
export async function* reply(text: string): AsyncGenerator<LLMStreamEvent> {
  yield { type: 'text_delta', text }
  yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1_000, outputTokens: 20 } }
}

/** 对话请求怎么应答; 参数是第几次对话请求和请求本身 */
export type ModelAnswer = (attempt: number, request: LLMStreamRequest) => AsyncIterable<LLMStreamEvent>

/**
 * 在当前用例里把 modelId 对应的模型换成替身: 对话请求交给 answer 应答, 摘要请求一律给出一份简短摘要。
 * 返回收到的对话请求, 以及每次摘要请求发生在第几次对话请求之后。
 */
export function stubModel(modelId: string, answer: ModelAnswer) {
  const conversationRequests: LLMStreamRequest[] = []
  const compactedAfter: number[] = []
  const stream = vi.spyOn(resolveProviderRuntime(modelId).provider, 'stream').mockImplementation((request) => {
    if (request.messages[0]?.content === SUMMARY_SYSTEM_PROMPT) {
      compactedAfter.push(conversationRequests.length)
      return reply('- summary')
    }
    conversationRequests.push(request)
    return answer(conversationRequests.length, request)
  })
  onTestFinished(() => stream.mockRestore())
  return { conversationRequests, compactedAfter }
}
