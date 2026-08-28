import type Anthropic from '@anthropic-ai/sdk'
import type { ProviderEntry } from '../data/defaults'
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../handlers/llm/anthropic'

// 会话亲和契约: conversationId 必须进入请求体 metadata.user_id,
// 供下游网关做会话级粘性路由; 未提供时不得注入空 metadata。
// 通过拦截 SDK client 的 messages.stream 参数直接断言 (不发起真实请求)。

type CapturedParams = Anthropic.MessageCreateParamsStreaming

function makeProvider(): { provider: AnthropicProvider, captured: CapturedParams[] } {
  const captured: CapturedParams[] = []
  const fakeStream = (params: CapturedParams) => {
    captured.push(params)
    throw new Error('STOP_TEST')
  }
  const client = {
    messages: { stream: fakeStream },
    beta: { messages: { stream: fakeStream } },
  } as unknown as Anthropic
  const entry = {
    id: 'test',
    name: 'Test',
    type: 'anthropic',
    baseUrl: 'https://api.example.com',
    auth: { kind: 'apiKey', value: 'sk-test' },
    models: [],
  } as unknown as ProviderEntry
  const provider = new AnthropicProvider(entry)
  // @ts-expect-error 访问私有字段替换 client
  provider.client = client
  return { provider, captured }
}

async function consumeStream(provider: AnthropicProvider, conversationId?: string): Promise<void> {
  const stream = provider.stream({
    model: 'test-model',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...(conversationId ? { conversationId } : {}),
  })
  try {
    for await (const _ of stream) {
      // 迭代到 fakeStream 抛错为止
    }
  }
  catch (err) {
    if (!(err instanceof Error && err.message === 'STOP_TEST'))
      throw err
  }
}

describe('anthropic conversation affinity (metadata.user_id)', () => {
  it('passes conversationId as metadata.user_id when present', async () => {
    const { provider, captured } = makeProvider()
    await consumeStream(provider, 'conv-affinity-42')
    expect(captured.length).toBe(1)
    expect(captured[0].metadata).toEqual({ user_id: 'conv-affinity-42' })
  })

  it('omits metadata entirely when conversationId is absent', async () => {
    const { provider, captured } = makeProvider()
    await consumeStream(provider)
    expect(captured.length).toBe(1)
    expect(captured[0].metadata).toBeUndefined()
  })

  it('keeps a distinct user_id per conversation (no cross-session leakage)', async () => {
    const { provider, captured } = makeProvider()
    await consumeStream(provider, 'conv-A')
    await consumeStream(provider, 'conv-B')
    expect(captured.map(p => p.metadata?.user_id)).toEqual(['conv-A', 'conv-B'])
  })
})
