import type { ProvidersConfig } from '../data/defaults'
import type { LLMMessage } from '../handlers/llm/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { finalizeToolCall } from '../handlers/agent/toolLifecycle'
import { omitImagesForTextOnlyModel, selectRoundModel } from '../handlers/agent/visionRouting'

function createProvidersConfig(visionModelId = 'vision-model'): ProvidersConfig {
  return {
    $schemaVersion: 1,
    visionModelId,
    providers: [
      {
        id: 'test-provider',
        name: 'Test Provider',
        type: 'openai-chat',
        baseUrl: 'https://example.com/v1',
        auth: { kind: 'apiKey', value: 'test-key' },
        models: [
          {
            id: 'text-model',
            apiModel: 'text-model',
            displayName: 'Text Model',
            thinking: false,
            supportsAgent: true,
            supportsImages: false,
            contextTokenLimit: 100000,
          },
          {
            id: 'vision-model',
            apiModel: 'vision-model',
            displayName: 'Vision Model',
            thinking: false,
            supportsAgent: true,
            supportsImages: true,
            contextTokenLimit: 100000,
          },
        ],
      },
    ],
  }
}

describe('vision round routing', () => {
  beforeEach(() => {
    setProvidersForTests(createProvidersConfig())
  })

  it('keeps text-only rounds on the main model', () => {
    expect(selectRoundModel('text-model', false)).toEqual({
      modelId: 'text-model',
      supportsImages: false,
      switchedToVisionModel: false,
    })
  })

  it('routes a new image to the configured vision model', () => {
    expect(selectRoundModel('text-model', true)).toEqual({
      modelId: 'vision-model',
      supportsImages: true,
      switchedToVisionModel: true,
    })
  })

  it('keeps an image-capable main model selected', () => {
    expect(selectRoundModel('vision-model', true)).toEqual({
      modelId: 'vision-model',
      supportsImages: true,
      switchedToVisionModel: false,
    })
  })

  it('rejects image input when no vision model is configured', () => {
    setProvidersForTests(createProvidersConfig(''))
    expect(() => selectRoundModel('text-model', true)).toThrow('Vision model is not configured')
  })

  it('removes historical image blocks before returning to a text-only model', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please inspect this.' },
          { type: 'image', mimeType: 'image/png', data: 'base64-image' },
        ],
      },
      { role: 'assistant', content: 'The screenshot shows a settings panel.' },
    ]

    const sanitized = omitImagesForTextOnlyModel(messages)

    expect(sanitized).not.toBe(messages)
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'Please inspect this.' },
      { type: 'image', mimeType: 'image/png', data: 'base64-image' },
    ])
    expect(sanitized[0]?.content).toEqual([
      { type: 'text', text: 'Please inspect this.' },
      {
        type: 'text',
        text: '[Image omitted for this text-only model. Use the previous vision-model response as the image analysis.]',
      },
    ])
    expect(sanitized[1]).toBe(messages[1])
  })

  it('collects MCP screenshot images for the next vision round', () => {
    const messages: LLMMessage[] = []
    const pendingToolResults: unknown[] = []
    const finalized = finalizeToolCall({
      roundContext: {
        createToolResult: params => ({
          type: 'tool_result',
          toolUseId: params.toolCallId,
          toolName: params.toolName,
          content: params.content,
          isError: params.isError,
        }),
        recordToolResult: (_messages, result) => pendingToolResults.push(result),
      },
      messages,
      cursorToolType: 'mcpToolCall',
      toolName: 'browser_screenshot',
      callId: 'screenshot-call',
      startedArgs: {},
      rawToolResult: {
        result: {
          case: 'success',
          value: {
            content: [
              {
                content: {
                  case: 'image',
                  value: {
                    data: new Uint8Array([1, 2, 3]),
                    mimeType: 'image/png',
                  },
                },
              },
            ],
            isError: false,
          },
        },
      },
      input: {},
      modelCallId: 'model-call',
    })

    expect(finalized.imageBlock).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'AQID',
    })
    expect(pendingToolResults).toHaveLength(1)
  })
})
