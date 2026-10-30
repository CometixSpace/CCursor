import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { describe, expect, it } from 'vitest'
import { mergeMcpStateIntoRoutingTable } from '../handlers/agent/mcpState'
import { buildToolArgs } from '../handlers/agent/toolBuilders'
import { launchTaskTool } from '../handlers/agent/toolRuntime'
import { mapPartialToolName, mapToolName, parseFlatMcpToolName, resolveExecutionToolName, resolveToolCall } from '../handlers/agent/tools'
import { getProviderToolCatalog } from '../handlers/llm/toolCatalog'

/**
 * dynamic namespace 模式下的 CallDynamicTool 路由。
 *
 * Cursor 3.15.6 起第三方 MCP 工具不再逐个注册为 LLM 工具,而是收进 namespace。
 * LLM 先用 GetDynamicTools 取 schema,再用 CallDynamicTool{namespace,toolName,arguments}
 * 调用。见 analysis/mcp-dynamic-tools.md。
 */

const AVAILABLE = [
  {
    name: 'user-ida-pro-mcp-decompile',
    providerIdentifier: 'ida-pro-mcp',
    toolName: 'decompile',
    serverIdentifier: 'user-ida-pro-mcp',
  },
]

it('routes CallDynamicTool to mcpToolCall, mapping official arg names', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'user-ida-pro-mcp', toolName: 'decompile', arguments: { addr: '0x401000' } },
    AVAILABLE,
  )

  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('decompile')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.providerIdentifier).toBe('ida-pro-mcp')
  expect(sanitizedInput.args).toEqual({ addr: '0x401000' })
  expect(sanitizedInput.name).toBe('user-ida-pro-mcp-decompile')
})

it('routes reserved cursor namespace back to the native tool identity', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'TodoWrite', arguments: { todos: [] } },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.cursorToolType).toBe('updateTodosToolCall')
  expect(resolved.effectiveToolName).toBe('TodoWrite')
  expect(resolved.sanitizedInput).toEqual({ todos: [] })
  expect(resolved.resolutionError).toBeUndefined()
})

it('rejects non-object arguments before entering a native cursor lifecycle', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'TodoWrite', arguments: [] },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.resolutionError).toContain('JSON object')
})

it('rejects cursor tools that were not advertised by the dynamic registry', () => {
  const resolved = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'cursor', toolName: 'UnknownNative', arguments: {} },
    AVAILABLE,
    [{ tool: 'TodoWrite' }],
  )
  expect(resolved.resolutionError).toContain('UnknownNative')
  expect(resolved.cursorToolType).toBe('mcpToolCall')
})

it('accepts the server display name as well as the identifier', () => {
  const { sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'ida-pro-mcp', toolName: 'decompile', arguments: {} },
    AVAILABLE,
  )
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.providerIdentifier).toBe('ida-pro-mcp')
})

it('still accepts the legacy CallMcpTool name and server param', () => {
  // 会话中途升级时,LLM 可能仍按旧词表发起调用 —— 不能失配
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallMcpTool',
    { server: 'user-ida-pro-mcp', toolName: 'decompile', arguments: { addr: '0x1' } },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
  expect(sanitizedInput.args).toEqual({ addr: '0x1' })
})

it('still forwards the call when the tool is absent from the routing table', () => {
  // 客户端 callTool 以 toolName 为准,serverIdentifier 只是过滤器 —— 宁可让
  // 客户端报 tool-not-found,也不要在这里静默吞掉调用。
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'CallDynamicTool',
    { namespace: 'other-server', toolName: 'unknown_tool', arguments: { a: 1 } },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('unknown_tool')
  expect(sanitizedInput.serverIdentifier).toBe('other-server')
  expect(sanitizedInput.args).toEqual({ a: 1 })
})

it('keeps per-tool routing working when tools are registered individually (legacy)', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'user-ida-pro-mcp-decompile',
    { addr: '0x401000' },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('mcpToolCall')
  expect(sanitizedInput.toolName).toBe('decompile')
  expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
})

it('maps GetDynamicTools onto the discovery tool call', () => {
  const { cursorToolType, sanitizedInput } = resolveToolCall(
    'GetDynamicTools',
    { namespace: 'user-ida-pro-mcp', toolName: 'decompile' },
    AVAILABLE,
  )
  expect(cursorToolType).toBe('getMcpToolsToolCall')
  // 该工具走服务端自执行,input 原样透传给渲染层
  expect(sanitizedInput.namespace).toBe('user-ida-pro-mcp')
})

it('exposes both dynamic-tool metas in every provider prompt vocabulary', () => {
  // 曾只有 openai 词表含 MCP 调用工具,导致 anthropic/gemini 会话读得到 descriptor 却调不动
  for (const provider of ['anthropic', 'openai-chat', 'openai-responses', 'gemini'] as const) {
    const vocab = getProviderToolCatalog(provider).promptVocabulary
    expect(vocab, `${provider} vocabulary`).toContain('CallDynamicTool')
    expect(vocab, `${provider} vocabulary`).toContain('GetDynamicTools')
  }
})

describe('defensive flat MCP routing', () => {
  it('maps mcp__server__tool onto a typed MCP call and preserves __ inside tool names', () => {
    expect(parseFlatMcpToolName('mcp__srv__tool__part')).toEqual({
      server: 'srv',
      toolName: 'tool__part',
    })
    expect(mapToolName('mcp__srv__tool')).toBe('mcpToolCall')

    const { cursorToolType, sanitizedInput } = resolveToolCall(
      'mcp__ida-pro-mcp__decompile',
      { address: '0x401000' },
      AVAILABLE,
    )
    expect(cursorToolType).toBe('mcpToolCall')
    expect(sanitizedInput.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(sanitizedInput.toolName).toBe('decompile')
    expect(sanitizedInput.args).toEqual({ address: '0x401000' })

    const args = buildToolArgs('mcp__ida-pro-mcp__decompile', sanitizedInput, 'call-flat')
    expect(args.serverIdentifier).toBe('user-ida-pro-mcp')
    expect(args.toolCallId).toBe('call-flat')
  })

  it('keeps malformed or differently-cased names untouched', () => {
    expect(parseFlatMcpToolName('mcp__only-server')).toBeNull()
    expect(mapToolName('MCP__srv__tool')).toBe('MCP__srv__tool')
  })
})

/**
 * cursor namespace 下的原生工具身份必须贯穿"预告 → 分流 → 执行"三段。
 *
 * 客户端按 toolCall.tool.case 分派到独立 handler。其中 editToolCall /
 * updateTodosToolCall / shellToolCall / createPlanToolCall / taskToolCall /
 * askQuestionToolCall 六种走 specialToolHandlers,命中已有 bubble 时只
 * setBubbleData(status/params/toolCall) 而**不写 toolCallType** ——
 * 类型由建 bubble 的那一帧永久决定 (3.15.6 / 3.16.29 / 3.17.19 一致)。
 *
 * 所以任何一段用错名字,后面都改不回来:
 *   预告帧猜成 mcpToolCall  → Task 永远渲染成 MCP 菱形图标
 *   分流按 tc.name 判断     → Task 掉进串行路径,丢掉并发启动与 subagent 模型解析
 */
describe('cursor namespace 的原生工具身份', () => {
  it('对 CallDynamicTool 不发预告帧 —— 此刻参数未到,类型不可判定', () => {
    for (const alias of ['CallDynamicTool', 'call_dynamic_tool', 'CallMcpTool', 'call_mcp_tool'])
      expect(mapPartialToolName(alias), alias).toBeNull()
  })

  it('类型确定的工具照发预告帧', () => {
    // GetDynamicTools 的 cursorToolType 固定,不存在歧义
    expect(mapPartialToolName('GetDynamicTools')).toBe('getMcpToolsToolCall')
    expect(mapPartialToolName('Task')).toBe('taskToolCall')
    expect(mapPartialToolName('user-ida-pro-mcp-decompile')).toBe('mcpToolCall')
  })

  it('解包出执行侧的真实工具名', () => {
    expect(resolveExecutionToolName(
      'CallDynamicTool',
      { namespace: 'cursor', toolName: 'Task', arguments: { prompt: 'go' } },
      [{ tool: 'Task' }],
    )).toBe('Task')
  })

  it('未注册 / 参数非法 / 非 cursor namespace 一律不解包', () => {
    // 不解包 = 交给 resolveToolCall 走 resolutionError 反馈给 LLM,
    // 而不是在分流处静默当成原生工具启动
    expect(resolveExecutionToolName(
      'CallDynamicTool',
      { namespace: 'cursor', toolName: 'Task', arguments: {} },
      [{ tool: 'TodoWrite' }],
    )).toBe('CallDynamicTool')
    expect(resolveExecutionToolName(
      'CallDynamicTool',
      { namespace: 'cursor', toolName: 'Task', arguments: [] },
      [{ tool: 'Task' }],
    )).toBe('CallDynamicTool')
    expect(resolveExecutionToolName(
      'CallDynamicTool',
      { namespace: 'user-ida-pro-mcp', toolName: 'decompile', arguments: {} },
      [{ tool: 'Task' }],
    )).toBe('CallDynamicTool')
    expect(resolveExecutionToolName('Shell', { command: 'ls' }, [{ tool: 'Task' }])).toBe('Shell')
  })

  it('分流判据与执行判据不得漂移', () => {
    // resolveExecutionToolName (分流) 与 resolveToolCall (执行) 若给出不同答案,
    // 就会出现"分流当 MCP、执行当 Task"这类自相矛盾的状态
    const cases: Array<[Record<string, unknown>, Array<{ tool: string }>]> = [
      [{ namespace: 'cursor', toolName: 'Task', arguments: {} }, [{ tool: 'Task' }]],
      [{ namespace: 'cursor', toolName: 'Task', arguments: {} }, []],
      [{ namespace: 'cursor', toolName: 'TodoWrite', arguments: { todos: [] } }, [{ tool: 'TodoWrite' }]],
      [{ namespace: 'cursor', toolName: 'Task', arguments: 'oops' }, [{ tool: 'Task' }]],
      [{ namespace: 'user-ida-pro-mcp', toolName: 'decompile', arguments: {} }, [{ tool: 'Task' }]],
    ]
    for (const [input, registry] of cases) {
      const resolved = resolveToolCall('CallDynamicTool', input, AVAILABLE, registry)
      expect(resolveExecutionToolName('CallDynamicTool', input, registry), JSON.stringify(input))
        .toBe(resolved.effectiveToolName ?? 'CallDynamicTool')
    }
  })

  it('经 CallDynamicTool 启动的 Task 走 subagent 通道,不走 mcpArgs', async () => {
    const frames: AgentServerMessage[] = []
    const messages: LLMMessage[] = []
    const iterator = launchTaskTool({
      toolCall: {
        callId: 'call-task-1',
        name: 'CallDynamicTool',
        input: {
          namespace: 'cursor',
          toolName: 'Task',
          arguments: { description: 'probe', prompt: 'look around', subagent_type: 'explore' },
        },
      },
      availableMcpTools: AVAILABLE,
      conversationId: 'conv-1',
      currentModelId: 'gpt-5.4-medium',
      round: 0,
      allocateExecMessageId: () => 1,
      cursorDynamicTools: [{ tool: 'Task' }],
      messages,
      roundContext: {
        createToolResult: params => ({
          type: 'tool_result',
          toolUseId: params.toolCallId,
          toolName: params.toolName,
          content: params.content,
          isError: params.isError,
        }),
        recordToolResult: (_messages: LLMMessage[], result: LLMToolResultBlock) => {
          messages.push({ role: 'user', content: [result] })
        },
      },
    })
    let result = await iterator.next()
    while (!result.done) {
      frames.push(result.value)
      result = await iterator.next()
    }

    expect(result.value?.cursorToolType).toBe('taskToolCall')

    // 帧的 case 由 cursorToolType / 硬编码 kind 决定,不受工具名影响 ——
    // tc.name 真正决定的是 args 用哪个 builder 填充。曾用 tc.name 构建,
    // 于是走到 McpArgs 的 builder 上,proto 字段全部对不上号:
    // taskToolCall 拿不到 description/prompt,subagentArgs 拿不到 prompt/subagentType。
    const started = frames.find(frame => frame.message.case === 'interactionUpdate')
    if (started?.message.case !== 'interactionUpdate')
      throw new Error('expected toolCallStarted frame')
    if (started.message.value.message.case !== 'toolCallStarted')
      throw new Error('expected toolCallStarted frame')
    const startedTool = started.message.value.message.value.toolCall?.tool
    expect(startedTool?.case).toBe('taskToolCall')
    expect((startedTool?.value as any)?.args).toMatchObject({
      description: 'probe',
      prompt: 'look around',
    })

    const execFrame = frames.find(frame => frame.message.case === 'execServerMessage')
    if (execFrame?.message.case !== 'execServerMessage')
      throw new Error('expected exec frame')
    expect(execFrame.message.value.message.case).toBe('subagentArgs')
    expect(execFrame.message.value.message.value).toMatchObject({
      prompt: 'look around',
      subagentType: 'explore',
      modelId: 'gpt-5.4-medium',
    })
  })
})

it('discovery synchronizes and upgrades the authoritative routing table', () => {
  const routingTable = [{
    name: 'user-ida-pro-mcp-decompile',
    description: '',
    inputSchema: { type: 'object' },
    providerIdentifier: 'ida-pro-mcp',
    toolName: 'decompile',
    serverIdentifier: 'user-ida-pro-mcp',
  }]
  const merged = mergeMcpStateIntoRoutingTable(routingTable, [{
    serverName: 'ida-pro-mcp',
    serverIdentifier: 'user-ida-pro-mcp',
    status: 'connected',
    tools: [
      {
        name: 'user-ida-pro-mcp-decompile',
        providerIdentifier: 'ida-pro-mcp',
        toolName: 'decompile',
        description: 'Full decompile description.',
        inputSchema: { type: 'object', required: ['address'] },
      },
      {
        name: 'user-ida-pro-mcp-xrefs',
        providerIdentifier: 'ida-pro-mcp',
        toolName: 'xrefs',
        description: 'Find references.',
        inputSchema: { type: 'object' },
      },
    ],
  }])

  expect(merged).toEqual({ added: 1, updated: 1 })
  expect(routingTable).toHaveLength(2)
  expect(routingTable[0].description).toBe('Full decompile description.')
  expect(routingTable[0].inputSchema).toEqual({ type: 'object', required: ['address'] })
  expect(routingTable[1].toolName).toBe('xrefs')
})
