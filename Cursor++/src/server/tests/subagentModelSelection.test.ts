import type { ProvidersConfig } from '../data/defaults'
import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { getCursorAgentTools } from '../handlers/agent/cursorTools'
import {
  contextualizeSubagentTools,
  createSubagentModelCatalog,
  prepareSubagentTask,
  resolveSubagentModelSelection,
} from '../handlers/agent/subagentCatalog'
import { launchTaskTool } from '../handlers/agent/toolRuntime'

const PROVIDERS: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [
    {
      id: 'provider-openai',
      name: 'Readable OpenAI Provider',
      type: 'openai-responses',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        {
          id: 'canonical-explicit',
          apiModel: 'api-explicit-v7',
          displayName: 'Explicit Display Name',
          thinking: true,
        },
        {
          id: 'canonical-settings',
          apiModel: 'api-settings-v8',
          displayName: 'Settings Display Name',
          thinking: true,
        },
      ],
    },
    {
      id: 'provider-anthropic',
      name: 'Readable Anthropic Provider',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        {
          id: 'canonical-parent',
          apiModel: 'api-parent-v9',
          displayName: 'Parent Display Name',
          thinking: false,
        },
        {
          id: 'canonical-no-agent',
          apiModel: 'api-no-agent-v1',
          displayName: 'No Agent Display Name',
          thinking: false,
          supportsAgent: false,
        },
        {
          id: 'canonical-duplicate',
          apiModel: 'api-duplicate-anthropic',
          displayName: 'Duplicate Anthropic',
          thinking: false,
        },
      ],
    },
    {
      id: 'provider-gemini',
      name: 'Readable Gemini Provider',
      type: 'gemini',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        {
          id: 'canonical-duplicate',
          apiModel: 'api-duplicate-gemini',
          displayName: 'Duplicate Gemini',
          thinking: false,
        },
      ],
    },
  ],
}

const CATALOG = createSubagentModelCatalog(PROVIDERS)

function createRecordingLifecycle() {
  const messages: LLMMessage[] = []
  const toolResults: LLMToolResultBlock[] = []
  return {
    messages,
    toolResults,
    roundContext: {
      createToolResult: (params: {
        toolCallId: string
        toolName: string
        content: string
        isError: boolean
      }): LLMToolResultBlock => ({
        type: 'tool_result',
        toolUseId: params.toolCallId,
        toolName: params.toolName,
        content: params.content,
        isError: params.isError,
      }),
      recordToolResult: (_messages: LLMMessage[], result: LLMToolResultBlock): void => {
        toolResults.push(result)
      },
    },
  }
}

async function collectTaskLaunch(params: {
  toolCall: Parameters<typeof launchTaskTool>[0]['toolCall']
  overrides?: Parameters<typeof launchTaskTool>[0]['subagentModelOverrides']
  execMessageId?: number
}): Promise<{ frames: AgentServerMessage[], result: Awaited<ReturnType<ReturnType<typeof launchTaskTool>['next']>>, toolResults: LLMToolResultBlock[] }> {
  const lifecycle = createRecordingLifecycle()
  const iterator = launchTaskTool({
    toolCall: params.toolCall,
    availableMcpTools: [],
    conversationId: 'parent-conversation',
    currentModelId: 'canonical-parent',
    subagentModelOverrides: params.overrides,
    subagentModelCatalog: CATALOG,
    round: 3,
    allocateExecMessageId: () => params.execMessageId ?? 41,
    cursorDynamicTools: [{ tool: 'Task' }, { tool: 'Subagent' }],
    roundContext: lifecycle.roundContext,
    messages: lifecycle.messages,
  })
  const frames: AgentServerMessage[] = []
  let result = await iterator.next()
  while (!result.done) {
    frames.push(result.value)
    result = await iterator.next()
  }
  return { frames, result, toolResults: lifecycle.toolResults }
}

function findSubagentArgs(frames: AgentServerMessage[]): Record<string, unknown> | undefined {
  for (const frame of frames) {
    if (frame.message.case !== 'execServerMessage')
      continue
    if (frame.message.value.message.case !== 'subagentArgs')
      continue
    return frame.message.value.message.value
  }
  return undefined
}

describe('subagent model resolution', () => {
  it('applies explicit, Settings, then parent precedence', () => {
    const overrides = [{
      subagentType: 'explore',
      selection: { case: 'model' as const, modelId: 'canonical-settings' },
    }]
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      explicitModelId: 'canonical-explicit',
      parentModelId: 'canonical-parent',
      overrides,
      catalog: CATALOG,
    })).toMatchObject({ case: 'selected', source: 'explicit', entry: { modelId: 'canonical-explicit' } })
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      parentModelId: 'canonical-parent',
      overrides,
      catalog: CATALOG,
    })).toMatchObject({ case: 'selected', source: 'settings', entry: { modelId: 'canonical-settings' } })
    expect(resolveSubagentModelSelection({
      subagentType: 'shell',
      parentModelId: 'canonical-parent',
      overrides,
      catalog: CATALOG,
    })).toMatchObject({ case: 'selected', source: 'parent', entry: { modelId: 'canonical-parent' } })
  })

  it('blocks disabled, stale, unsupported, and duplicate choices', () => {
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      explicitModelId: 'canonical-explicit',
      parentModelId: 'canonical-parent',
      overrides: [{ subagentType: 'explore', selection: { case: 'disabled' } }],
      catalog: CATALOG,
    })).toMatchObject({ case: 'blocked' })
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      explicitModelId: 'stale-model-id',
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({ case: 'invalid', error: expect.stringContaining('stale-model-id') })
    for (const nonCanonicalName of ['api-explicit-v7', 'Explicit Display Name']) {
      expect(resolveSubagentModelSelection({
        subagentType: 'explore',
        explicitModelId: nonCanonicalName,
        parentModelId: 'canonical-parent',
        catalog: CATALOG,
      }), nonCanonicalName).toMatchObject({ case: 'invalid' })
    }
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      explicitModelId: 'canonical-no-agent',
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({ case: 'invalid', error: expect.stringContaining('supportsAgent=false') })
    expect(resolveSubagentModelSelection({
      subagentType: 'explore',
      explicitModelId: 'canonical-duplicate',
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({ case: 'invalid', error: expect.stringContaining('duplicated') })
  })

  it('normalizes built-in subagent aliases before applying Settings policy', () => {
    expect(resolveSubagentModelSelection({
      subagentType: 'general-purpose',
      explicitModelId: 'canonical-explicit',
      parentModelId: 'canonical-parent',
      overrides: [{ subagentType: 'generalPurpose', selection: { case: 'disabled' } }],
      catalog: CATALOG,
    })).toMatchObject({ case: 'blocked', error: expect.stringContaining('generalPurpose') })
  })

  it('rejects explicit models on ordinary resume but permits self-forks', () => {
    expect(prepareSubagentTask({
      input: { subagent_type: 'explore', model: 'canonical-explicit', resume: 'existing-agent' },
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({ case: 'invalid', error: expect.stringContaining('resuming existing agent') })
    expect(prepareSubagentTask({
      input: {
        subagent_type: 'explore',
        model: 'canonical-explicit',
        resume: 'self',
        thinking: true,
        reasoning: 'high',
        effort: 'max',
        modelParameters: { reasoningEffort: 'high' },
      },
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({
      case: 'selected',
      input: { model: 'canonical-explicit', modelId: 'canonical-explicit', resume: 'self' },
    })
    const selfFork = prepareSubagentTask({
      input: { subagent_type: 'explore', model: 'canonical-explicit', resume: 'self', thinking: true },
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })
    expect(selfFork).toMatchObject({ case: 'selected' })
    if (selfFork.case === 'selected')
      expect(selfFork.input).not.toHaveProperty('thinking')
  })

  it('rejects an explicitly empty model instead of inheriting silently', () => {
    expect(prepareSubagentTask({
      input: { subagent_type: 'explore', model: '   ' },
      parentModelId: 'canonical-parent',
      catalog: CATALOG,
    })).toMatchObject({ case: 'invalid', error: expect.stringContaining('cannot be empty') })
  })
})

describe('subagent Task schemas', () => {
  it('uses the same canonical enum for Anthropic, OpenAI, and Gemini', () => {
    const expectedModelIds = ['canonical-explicit', 'canonical-settings', 'canonical-parent']
    for (const providerType of ['anthropic', 'openai-responses', 'gemini'] as const) {
      const tools = contextualizeSubagentTools(getCursorAgentTools(providerType), [], CATALOG)
      const task = tools.find(tool => tool.name === 'Task' || tool.name === 'Subagent')
      expect(task).toBeDefined()
      const properties = task?.inputSchema.properties as Record<string, Record<string, unknown>>
      expect(properties.model.enum, providerType).toEqual(expectedModelIds)
      expect(properties.model.description, providerType).toContain('api-explicit-v7')
      expect(properties.model.description, providerType).toContain('Explicit Display Name')
      expect(properties).not.toHaveProperty('attachments')
      expect(properties).not.toHaveProperty('thinking')
      expect(properties.model.enum).not.toContain('fast')
    }
  })

  it('removes Task when no eligible Subagent model exists', () => {
    const emptyCatalog = createSubagentModelCatalog({
      $schemaVersion: 1,
      providers: [{
        id: 'disabled-provider',
        name: 'Disabled Provider',
        type: 'gemini',
        baseUrl: '',
        auth: { kind: 'apiKey', value: 'test-key' },
        models: [{
          id: 'disabled-model',
          apiModel: 'disabled-api-model',
          displayName: 'Disabled Model',
          thinking: false,
          supportsAgent: false,
        }],
      }],
    })
    const tools = contextualizeSubagentTools(getCursorAgentTools('gemini'), [], emptyCatalog)
    expect(tools.some(tool => tool.name === 'Task' || tool.name === 'Subagent')).toBe(false)
  })
})

describe('subagent Task execution preparation', () => {
  it('emits the canonical model for direct and cursor dynamic Task calls', async () => {
    const direct = await collectTaskLaunch({
      toolCall: {
        callId: 'direct-task',
        name: 'Task',
        input: { description: 'Direct task', prompt: 'Inspect it', subagent_type: 'explore', model: 'canonical-explicit' },
      },
    })
    const dynamic = await collectTaskLaunch({
      toolCall: {
        callId: 'dynamic-task',
        name: 'CallDynamicTool',
        input: {
          namespace: 'cursor',
          toolName: 'Task',
          arguments: { description: 'Dynamic task', prompt: 'Inspect it', subagent_type: 'explore', model: 'canonical-explicit' },
        },
      },
    })
    expect(findSubagentArgs(direct.frames)).toMatchObject({ modelId: 'canonical-explicit' })
    expect(findSubagentArgs(dynamic.frames)).toMatchObject({ modelId: 'canonical-explicit' })
  })

  it('pairs a rejected Task lifecycle, records one LLM result, and emits no subagentArgs', async () => {
    const rejected = await collectTaskLaunch({
      toolCall: {
        callId: 'rejected-task',
        name: 'Task',
        input: { description: 'Rejected task', prompt: 'Inspect it', subagent_type: 'explore', model: 'stale-model-id' },
      },
    })
    const interactionFrames = rejected.frames.filter(frame => frame.message.case === 'interactionUpdate')
    expect(interactionFrames).toHaveLength(2)
    expect(findSubagentArgs(rejected.frames)).toBeUndefined()
    expect(rejected.toolResults).toHaveLength(1)
    expect(rejected.toolResults[0]).toMatchObject({
      toolUseId: 'rejected-task',
      isError: true,
      content: expect.stringContaining('stale-model-id'),
    })
  })

  it('does not erase a successful sibling when another launch is rejected', async () => {
    const [successful, rejected] = await Promise.all([
      collectTaskLaunch({
        toolCall: {
          callId: 'successful-sibling',
          name: 'Task',
          input: { description: 'Successful sibling', prompt: 'Inspect it', subagent_type: 'explore', model: 'canonical-explicit' },
        },
        execMessageId: 101,
      }),
      collectTaskLaunch({
        toolCall: {
          callId: 'rejected-sibling',
          name: 'Task',
          input: { description: 'Rejected sibling', prompt: 'Inspect it', subagent_type: 'explore', model: 'stale-model-id' },
        },
        execMessageId: 102,
      }),
    ])
    expect(findSubagentArgs(successful.frames)).toMatchObject({ modelId: 'canonical-explicit' })
    expect(findSubagentArgs(rejected.frames)).toBeUndefined()
    expect(rejected.toolResults).toHaveLength(1)
  })
})
