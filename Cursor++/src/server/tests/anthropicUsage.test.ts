import type { ProviderEntry } from '../data/defaults'
import type { LLMStreamEvent } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { AnthropicProvider } from '../handlers/llm/anthropic'

it('anthropic usage reports the whole prompt as inputTokens, cached parts included', async () => {
  const provider = new AnthropicProvider({
    id: 'test-anthropic',
    name: 'Test Anthropic',
    type: 'anthropic',
    baseUrl: '',
    auth: { kind: 'apiKey', value: 'test-key' },
    models: [],
  } as ProviderEntry)
  // Anthropic 的 input_tokens 只是没命中缓存的尾巴, 与两个 cache 字段互不相交
  const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 2_000 }
  Object.assign(provider, {
    client: {
      messages: {
        stream: () => ({
          async* [Symbol.asyncIterator]() {},
          finalMessage: async () => ({ stop_reason: 'end_turn', usage }),
        }),
      },
    },
  })

  const events: LLMStreamEvent[] = []
  for await (const event of provider.stream({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }))
    events.push(event)

  expect(events.at(-1)).toMatchObject({
    type: 'done',
    usage: { inputTokens: 92_120, outputTokens: 30, cacheReadTokens: 90_000, cacheWriteTokens: 2_000 },
  })
})
