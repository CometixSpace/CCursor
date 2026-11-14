import type { LLMStreamEvent } from '../handlers/llm/types'

/** 模型的一次应答: 一段文字, 然后正常结束 */
export async function* reply(text: string): AsyncGenerator<LLMStreamEvent> {
  yield { type: 'text_delta', text }
  yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1_000, outputTokens: 20 } }
}
