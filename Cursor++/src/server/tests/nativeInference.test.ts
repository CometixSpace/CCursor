import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { Code } from '@connectrpc/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetProvidersCacheForTests, setProvidersForTests } from '../config/providersStore'
import { buildRedirectForMode } from '../data/defaults'
import { AgentClientMessageSchema } from '../gen/agent_v1_pb'
import { InferenceCoreMessageSchema, InferenceMessageRole, InferenceStreamRequestSchema, RunInferenceClientMessageSchema, RunInferenceRunRequestSchema } from '../gen/native_inference_pb'
import { appendMessage, closeSession, getOrCreateSession, waitForMessage } from '../handlers/agent/session'
import { appendBidiMessage, registerBidiReceiver } from '../handlers/bidiMailbox'
import { createRunReady, forwardInference, resolveNativeModel, translateMessages, translateRequest } from '../handlers/inference/forward'
import { InferenceQueue, runInferenceSession } from '../handlers/inference/session'
import { resetProviderInstanceCache, resolveProviderRuntime } from '../handlers/llm/providerRuntime'

beforeEach(() => {
  setProvidersForTests({
    $schemaVersion: 1,
    providers: [{ id: 'native-test', name: 'Native test', type: 'anthropic', baseUrl: 'https://provider.example.test', auth: { kind: 'apiKey', value: 'test-key' }, models: [
      { id: 'grok-4.7', apiModel: 'grok-4.7', displayName: 'Grok', thinking: true, thinkingLevel: 'xhigh', contextTokenLimit: 500000, maxOutputTokens: 32768 },
      { id: 'grok-4.6', apiModel: 'grok-4.6', displayName: 'Grok', thinking: true, thinkingLevel: 'xhigh', contextTokenLimit: 500000 },
      { id: 'other', apiModel: 'other', displayName: 'Other', thinking: false, contextTokenLimit: 128000 },
    ] }],
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetProvidersCacheForTests()
  resetProviderInstanceCache()
})

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const item of items) values.push(item)
  return values
}

function request() {
  return create(InferenceStreamRequestSchema, {
    modelId: 'grok-4.7',
    messages: [{ role: InferenceMessageRole.SYSTEM, content: { case: 'text', value: 'Native system prompt' } }, { role: InferenceMessageRole.USER, content: { case: 'text', value: 'Synthetic test input' } }],
    tools: [{ name: 'NativeTool', description: 'Native tool description', parameters: { type: 'object' } }],
  })
}
const runRequest = () => create(RunInferenceClientMessageSchema, { message: { case: 'runRequest', value: { conversationId: 'synthetic-conversation', requestedModel: { modelId: 'grok-4.7' } } } })
const invoke = (id: string, purpose = 0) => create(RunInferenceClientMessageSchema, { message: { case: 'invokeModel', value: { invocationId: id, request: request(), purpose } } })
const done: LLMStreamEvent = { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 200, cacheWriteTokens: 30 } }

describe('native inference forwarding', () => {
  it.each(['grok-4.6', 'grok-4.7'])('advertises the configured context for %s with native Grok prompts', (modelId) => {
    const ready = createRunReady(create(RunInferenceRunRequestSchema, { requestedModel: { modelId } }))
    expect(ready.promptModelMetadata).toMatchObject({ vendor: 'xai', promptVersion: 'cursor-0226', isGrok46ProductPrompt: true, agentTokenLimit: 500000 })
    expect(ready.summarization?.model?.modelId).toBe(modelId)
    expect(ready.supportsSelfSummary).toBe(true)
    expect(ready.acceptsAgentEvents).toBe(false)
  })

  it('rejects an unknown or unsupported native model', () => {
    expect(() => resolveNativeModel('missing')).toThrow()
    expect(() => resolveNativeModel('other')).toThrow(/supports configured Grok/)
  })

  it('fails on an incompatible advertised prompt module', () => {
    expect(() => createRunReady(create(RunInferenceRunRequestSchema, { requestedModel: { modelId: 'grok-4.7' }, agentModule: { promptVersions: ['unknown'] } }))).toThrow(/prompt version/)
  })

  it('preserves native prompts and tools without adding plugin agent content', () => {
    const signal = new AbortController().signal
    const translated = translateRequest(request(), 'grok-4.7', signal)
    expect(translated.messages).toEqual([{ role: 'system', content: [{ type: 'text', text: 'Native system prompt' }] }, { role: 'user', content: [{ type: 'text', text: 'Synthetic test input' }] }])
    expect(translated.tools).toEqual([{ name: 'NativeTool', description: 'Native tool description', inputSchema: { type: 'object' } }])
    expect(translated).toMatchObject({ nativeInference: true, signal, thinking: true, thinkingLevel: 'xhigh', maxTokens: 32768 })
  })

  it('round trips assistant reasoning/text/tool ordering and tool results', () => {
    const assistant = create(InferenceCoreMessageSchema, { role: InferenceMessageRole.ASSISTANT, assistantPartOrder: [1, 2, 3, 2], assistantTextParts: ['before', 'after'], reasoningParts: [{ text: 'reason' }], toolCalls: [{ toolCallId: 'call_1', toolName: 'NativeTool', args: { path: 'sample.txt' } }] })
    const tool = create(InferenceCoreMessageSchema, { role: InferenceMessageRole.TOOL, content: { case: 'toolContent', value: { parts: [{ toolCallId: 'call_1', toolName: 'NativeTool', result: { kind: { case: 'stringValue', value: 'synthetic result' } } }] } } })
    const translated = translateMessages([assistant, tool])
    expect(translated[0].content).toEqual([{ type: 'thinking', text: 'reason', signature: undefined, sourceModel: undefined }, { type: 'text', text: 'before' }, { type: 'tool_use', id: 'call_1', name: 'NativeTool', input: { path: 'sample.txt' } }, { type: 'text', text: 'after' }])
    expect(translated[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1', content: 'synthetic result' })
  })

  it('preserves native inline images and rejects unsupported parts', () => {
    const image = create(InferenceCoreMessageSchema, { role: InferenceMessageRole.USER, content: { case: 'parts', value: { parts: [{ part: { case: 'image', value: { data: 'data:image/png;base64,ZmFrZQ==' } } }] } } })
    expect(translateMessages([image])[0].content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }])
    if (image.content.case === 'parts')
      image.content.value.parts[0].part = { case: undefined }
    expect(() => translateMessages([image])).toThrow()
  })

  it('streams reasoning, tool deltas, a complete response and cache-inclusive usage', async () => {
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* () {
      yield { type: 'thinking_delta', text: 'thinking' }
      yield { type: 'thinking_done', signature: 'signature' }
      yield { type: 'text_delta', text: 'before' }
      yield { type: 'tool_use_start', id: 'call_1', name: 'NativeTool' }
      yield { type: 'tool_use_delta', id: 'call_1', input: '{"path":"sample.txt"}' }
      yield { type: 'tool_use_done', id: 'call_1' }
      yield done
    })
    const frames = await collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))
    const toolFrames = frames.filter(f => f.response.case === 'toolCallPart').map(f => f.response.value)
    expect(toolFrames).toMatchObject([{ toolName: 'NativeTool', isComplete: false }, { toolName: '', args: '{"path":"sample.txt"}' }, { toolName: 'NativeTool', isComplete: true }])
    expect(frames.find(f => f.response.case === 'usage')?.response.value).toMatchObject({ promptTokens: 330, completionTokens: 7, totalTokens: 337 })
    const info = frames.find(f => f.response.case === 'responseInfo')
    expect(info?.response.case === 'responseInfo' && Math.abs(Number(info.response.value.createdAt) - Date.now())).toBeLessThan(1000)
    expect(info?.response.value).toMatchObject({ supportsSelfSummary: true, selfSummaryFlavor: 'generic', messages: [{ content: 'before', assistantPartOrder: [1, 2, 3], assistantTextParts: ['before'], toolCalls: [{ args: { path: 'sample.txt' } }] }] })
    expect(frames.at(-1)?.response.value).toMatchObject({ isFinal: true })
  })

  it('retains tool order when parallel tools finish in reverse order', async () => {
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* () {
      yield { type: 'tool_use_start', id: 'one', name: 'First' }
      yield { type: 'tool_use_start', id: 'two', name: 'Second' }
      yield { type: 'tool_use_done', id: 'two', arguments: '{}' }
      yield { type: 'tool_use_done', id: 'one', arguments: '{}' }
      yield done
    })
    const frames = await collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))
    const info = frames.find(f => f.response.case === 'responseInfo')
    expect(info?.response.case === 'responseInfo' && info.response.value.messages[0].toolCalls.map(c => c.toolCallId)).toEqual(['one', 'two'])
  })

  it('rejects an upstream stream without completion or complete tool arguments', async () => {
    const stream = vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream')
    stream.mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'partial' }
    })
    await expect(collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))).rejects.toThrow(/without a completion/)
    stream.mockImplementation(async function* () {
      yield { type: 'tool_use_start', id: 'unfinished', name: 'NativeTool' }
      yield done
    })
    await expect(collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))).rejects.toThrow(/incomplete tool/)
  })

  it('reports provider context overflow using the native compaction error type', async () => {
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* () {
      throw Object.assign(new Error('prompt is too long'), { status: 400 })
    })
    const frames = await collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))
    expect(frames.at(-1)?.response.value).toMatchObject({ isInputTokenLimitError: true, code: 'context_length_exceeded' })
  })

  it('reports output truncation as an error instead of accepting a partial summary', async () => {
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'incomplete summary' }
      yield { ...done, stopReason: 'max_tokens' }
    })
    const frames = await collect(forwardInference(request(), 'grok-4.7', new AbortController().signal))
    expect(frames.at(-1)?.response.value).toMatchObject({ isOutputTokenLimitError: true })
    expect(frames.some(f => f.response.case === 'responseInfo')).toBe(false)
  })
})

describe('native inference session', () => {
  it('forwards both normal and summarization invocations in one native run', async () => {
    const received: LLMStreamRequest[] = []
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* (r) {
      received.push(r)
      yield { type: 'text_delta', text: 'synthetic answer' }
      yield done
    })
    const incoming = new InferenceQueue<ReturnType<typeof create<typeof RunInferenceClientMessageSchema>>>()
    const iterator = runInferenceSession(incoming, new AbortController().signal)
    incoming.push(runRequest())
    expect((await iterator.next()).value?.message.case).toBe('runReady')
    for (const [id, purpose] of [['normal', 0], ['summary', 1]] as const) {
      incoming.push(invoke(id, purpose))
      let last
      do {
        last = await iterator.next()
      } while (last.value?.message.case !== 'invocationEnd')
      expect(last.value?.message.value).toMatchObject({ invocationId: id })
      expect(last.value?.message.case === 'invocationEnd' && last.value.message.value.error).toBeUndefined()
    }
    expect(received).toHaveLength(2)
    incoming.push(create(RunInferenceClientMessageSchema, { message: { case: 'finishRun', value: {} } }))
    expect((await iterator.next()).done).toBe(true)
    incoming.end()
  })

  it('aborts the upstream request when an invocation is cancelled', async () => {
    let upstreamSignal: AbortSignal | undefined
    let markStarted!: () => void
    const upstreamStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream').mockImplementation(async function* (r) {
      upstreamSignal = r.signal
      markStarted()
      await new Promise<void>((_, reject) => r.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      yield done
    })
    const incoming = new InferenceQueue<ReturnType<typeof create<typeof RunInferenceClientMessageSchema>>>()
    const iterator = runInferenceSession(incoming, new AbortController().signal)
    incoming.push(runRequest())
    await iterator.next()
    incoming.push(invoke('cancelled'))
    await iterator.next()
    await upstreamStarted
    incoming.push(create(RunInferenceClientMessageSchema, { message: { case: 'cancelInvocation', value: { invocationId: 'cancelled' } } }))
    let end
    do {
      end = await iterator.next()
      expect(end.done).toBe(false)
    } while (end.value?.message.case !== 'invocationEnd')
    expect(upstreamSignal?.aborted).toBe(true)
    expect(end.value?.message.value).toMatchObject({ invocationId: 'cancelled', error: { code: Code.Canceled } })
    incoming.push(create(RunInferenceClientMessageSchema, { message: { case: 'finishRun', value: {} } }))
    await iterator.next()
    incoming.end()
  })

  it('does not start an upstream request cancelled before its first provider call', async () => {
    const stream = vi.spyOn(resolveProviderRuntime('grok-4.7').provider, 'stream')
    const incoming = new InferenceQueue<ReturnType<typeof create<typeof RunInferenceClientMessageSchema>>>()
    const iterator = runInferenceSession(incoming, new AbortController().signal)
    incoming.push(runRequest())
    await iterator.next()
    incoming.push(invoke('cancel-before-start'))
    incoming.push(create(RunInferenceClientMessageSchema, { message: { case: 'cancelInvocation', value: { invocationId: 'cancel-before-start' } } }))
    let end
    do {
      end = await iterator.next()
      expect(end.done).toBe(false)
    } while (end.value?.message.case !== 'invocationEnd')
    expect(end.value?.message.value).toMatchObject({ invocationId: 'cancel-before-start', error: { code: Code.Canceled } })
    expect(stream).not.toHaveBeenCalled()
    incoming.push(create(RunInferenceClientMessageSchema, { message: { case: 'finishRun', value: {} } }))
    expect((await iterator.next()).done).toBe(true)
    incoming.end()
  })
})

describe('shared Bidi transport', () => {
  it('buffers messages before SSE, orders appends and deduplicates retries', () => {
    const id = 'synthetic-bidi-order'
    const received: string[] = []
    appendBidiMessage(id, 1n, '02')
    appendBidiMessage(id, 0n, '01')
    const release = registerBidiReceiver(id, data => received.push(data))
    appendBidiMessage(id, 1n, '02')
    appendBidiMessage(id, 2n, '03')
    expect(received).toEqual(['01', '02', '03'])
    release()
    appendBidiMessage(id, 2n, '03')
    expect(received).toHaveLength(3)
  })

  it('defers inference protobuf decoding until the inference SSE receiver attaches', () => {
    const id = 'synthetic-bidi-inference'
    appendBidiMessage(id, 0n, Buffer.from(toBinary(RunInferenceClientMessageSchema, runRequest())).toString('hex'))
    const received: string[] = []
    const release = registerBidiReceiver(id, data => received.push(fromBinary(RunInferenceClientMessageSchema, Buffer.from(data, 'hex')).message.case!))
    expect(received).toEqual(['runRequest'])
    release()
  })

  it('keeps legacy Agent messages and cancellation on the Agent decoder', async () => {
    const id = 'synthetic-bidi-legacy'
    const session = getOrCreateSession(id)
    const cancel = create(AgentClientMessageSchema, { message: { case: 'conversationAction', value: { action: { case: 'cancelAction', value: { reason: 'synthetic-cancel' } } } } })
    const heartbeat = create(AgentClientMessageSchema, { message: { case: 'clientHeartbeat', value: {} } })
    appendBidiMessage(id, 1n, Buffer.from(toBinary(AgentClientMessageSchema, cancel)).toString('hex'))
    appendBidiMessage(id, 0n, Buffer.from(toBinary(AgentClientMessageSchema, heartbeat)).toString('hex'))
    const release = registerBidiReceiver(id, data => appendMessage(id, data))
    try {
      expect(await waitForMessage(session, 100)).toEqual({ clientHeartbeat: {} })
      expect(session.cancelledReason).toBe('synthetic-cancel')
      expect(await waitForMessage(session, 100)).toBeNull()
    }
    finally {
      release()
      closeSession(id)
    }
  })

  it('rejects malformed appends', () => {
    expect(() => appendBidiMessage('bad', 0n, 'not hex')).toThrow(/Invalid/)
    expect(() => appendBidiMessage('bad', -1n, '00')).toThrow(/Invalid/)
  })

  it('routes inference only while the opt-in and BYOK mode are enabled', () => {
    const route = 'aiserver.v1.InferenceService/RunInferenceSSE'
    expect(buildRedirectForMode(1)).not.toContain(route)
    expect(buildRedirectForMode(1, ['grok-4.7'])).toContain(route)
    expect(buildRedirectForMode(0, ['grok-4.7'])).not.toContain(route)
  })
})
