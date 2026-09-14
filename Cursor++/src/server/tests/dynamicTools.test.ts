import type { DynamicNamespace } from '../handlers/agent/dynamicTools'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCursorAgentTools } from '../handlers/agent/cursorTools'
import {
  buildDynamicToolsSection,
  MCP_AUTH_TOOL,
  normalizeDynamicNamespaceStatus,
  parseDynamicToolsQuery,
  partitionCursorBuiltinTools,
  renderDynamicToolsResult,
  serializeDynamicToolsResult,
  shortenDescription,
  shouldEnableBuiltinDynamicProfile,
  toDynamicNamespace,
  validateDynamicToolsQuery,
} from '../handlers/agent/dynamicTools'
import { filterToolsForMode } from '../handlers/agent/toolkit/types'

/**
 * GetDynamicTools 渲染层 —— 1:1 复刻校验。
 *
 * 所有期望值来自官方实测样本 (analysis/mcp-dynamic-tools.md §4.5),
 * 用 grok-4.5 对 agentn.global.api5.cursor.sh 套取,非推断。
 */

const LONG_DESC = `PROBE_DESC_LISTFUNCS — List functions in the loaded binary. Padding for truncation test: ${'x'.repeat(600)}`

const NS: DynamicNamespace[] = [
  {
    name: 'user-ida-pro-mcp',
    source: 'mcp',
    status: 'ready',
    tools: [
      {
        tool: 'decompile',
        description: 'PROBE_DESC_DECOMPILE — Decompile the function at a given address to pseudocode.',
        inputSchema: {
          type: 'object',
          properties: { address: { type: 'string' } },
          required: ['address'],
        },
      },
      { tool: 'list_funcs', description: LONG_DESC, inputSchema: { type: 'object', properties: {} } },
    ],
  },
  {
    name: 'user-probe-two',
    source: 'mcp',
    status: 'ready',
    tools: [{ tool: 'alpha', description: 'PROBE_DESC_ALPHA — second namespace.', inputSchema: { type: 'object' } }],
  },
]

describe('截断规则', () => {
  it('超过 200 字符时截断,总长恰好 200', () => {
    const out = shortenDescription(LONG_DESC)
    expect(out).toHaveLength(200)
    expect(out.endsWith('... [truncated]')).toBe(true)
    expect(out.slice(0, 185)).toBe(LONG_DESC.slice(0, 185))
  })

  it('未超限时原样返回,不加后缀', () => {
    // 实测未截断样本最长 179,边界内
    const short = 'x'.repeat(179)
    expect(shortenDescription(short)).toBe(short)
    expect(shortenDescription('x'.repeat(185))).toBe('x'.repeat(185))
    expect(shortenDescription('x'.repeat(200))).toBe('x'.repeat(200))
    expect(shortenDescription('x'.repeat(201))).toHaveLength(200)
    expect(shortenDescription('x'.repeat(201))).toMatch(/\.\.\. \[truncated\]$/)
  })
})

describe('single_tool 模式', () => {
  it('返回完整 inputSchema 且不截断 description', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp', toolName: 'list_funcs' }, NS)
    expect(r.mode).toBe('single_tool')
    expect(r.namespace).toBe('user-ida-pro-mcp')
    expect(r.namespaceStatus).toBe('ready')
    const tool = r.tool as Record<string, unknown>
    expect(tool.tool).toBe('list_funcs')
    expect(tool.description).toBe(LONG_DESC) // 完整,不截断
    expect(tool.inputSchema).toBeDefined()
  })
})

describe('namespace 模式', () => {
  it('列出该 namespace 全部工具,均带 inputSchema', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp' }, NS)
    expect(r.mode).toBe('namespace')
    expect(r.namespaceStatus).toBe('ready')
    const tools = r.tools as Array<Record<string, unknown>>
    expect(tools.map(t => t.tool)).toEqual(['decompile', 'list_funcs'])
    expect(tools.every(t => t.inputSchema !== undefined)).toBe(true)
    // namespace 模式永不截断
    expect(tools[1].description).toBe(LONG_DESC)
  })
})

describe('search 模式', () => {
  it('跨 namespace 搜索,结果无 inputSchema 且 description 截断', () => {
    const r = renderDynamicToolsResult({ pattern: 'alpha' }, NS)
    expect(r.mode).toBe('search')
    expect(r.pattern).toBe('alpha')
    const matches = r.matches as Array<Record<string, unknown>>
    expect(matches).toHaveLength(1)
    expect(matches[0].namespace).toBe('user-probe-two')
    expect(matches[0].tool).toBe('alpha')
    expect(matches[0].inputSchema).toBeUndefined()
    expect(matches[0].namespaceStatus).toBeUndefined()
  })

  it('截断长 description', () => {
    const r = renderDynamicToolsResult({ pattern: 'list_funcs' }, NS)
    const matches = r.matches as Array<Record<string, unknown>>
    expect(matches[0].description).toHaveLength(200)
  })

  it('namespace 名命中时先返回 namespace-only match', () => {
    const r = renderDynamicToolsResult({ pattern: 'ida-pro' }, [{
      ...NS[0],
      description: 'IDA integration instructions.',
    }])
    const matches = r.matches as Array<Record<string, unknown>>
    expect(matches[0]).toEqual({
      namespace: 'user-ida-pro-mcp',
      description: 'IDA integration instructions.',
      namespaceStatus: 'ready',
    })
    expect(matches.slice(1).map(m => m.tool)).toEqual(['decompile', 'list_funcs'])
  })

  it('非法正则退化为子串匹配而不抛出', () => {
    const r = renderDynamicToolsResult({ pattern: '[unclosed' }, NS)
    expect(r.mode).toBe('search')
    expect(r.matches).toEqual([])
  })
})

describe('catalog 模式', () => {
  it('无参数返回全部 namespace,工具精简且 description 截断', () => {
    const r = renderDynamicToolsResult({}, NS)
    expect(r.mode).toBe('catalog')
    const namespaces = r.namespaces as Array<Record<string, unknown>>
    expect(namespaces.map(n => n.namespace)).toEqual(['user-ida-pro-mcp', 'user-probe-two'])
    const tools = namespaces[0].tools as Array<Record<string, unknown>>
    expect(tools.every(t => t.inputSchema === undefined)).toBe(true)
    expect(tools[1].description).toHaveLength(200)
  })

  it('catalog 会把过长 namespaceDescription 同样截到 200 字符', () => {
    const r = renderDynamicToolsResult({}, [{
      name: 'user-docs',
      source: 'mcp',
      status: 'ready',
      description: 'x'.repeat(300),
      tools: [],
    }])
    const ns = (r.namespaces as Array<Record<string, unknown>>)[0]
    expect(ns.namespaceDescription).toHaveLength(200)
  })

  it('cursor 源 namespace 用 namespaceDescription 而非 namespaceStatus', () => {
    const r = renderDynamicToolsResult({}, [
      { name: 'cursor', source: 'cursor', description: 'Native Cursor tools.', tools: [] },
    ])
    const ns = (r.namespaces as Array<Record<string, unknown>>)[0]
    expect(ns.namespaceDescription).toBe('Native Cursor tools.')
    expect(ns.namespaceStatus).toBeUndefined()
  })
})

describe('3.17 namespace 状态', () => {
  it('把客户端 connected 映射成模型侧 ready,并传播 error_message', () => {
    const ns = toDynamicNamespace({
      serverName: 'broken',
      serverIdentifier: 'user-broken',
      status: 'error',
      errorMessage: 'spawn ENOENT',
      instructions: 'Use only read-only operations.',
      tools: [],
    }, false)
    const result = renderDynamicToolsResult({ namespace: 'user-broken' }, [ns])
    expect(result.namespaceStatus).toBe('error')
    expect(result.namespaceError).toBe('spawn ENOENT')
    expect(result.namespaceDescription).toBe('Use only read-only operations.')
    expect(normalizeDynamicNamespaceStatus('connected')).toBe('ready')
  })

  it('search 结果携带异常 namespace 的状态与错误', () => {
    const result = renderDynamicToolsResult({ pattern: 'alpha' }, [{
      name: 'user-broken',
      source: 'mcp',
      status: 'error',
      error: 'not running',
      tools: [{ tool: 'alpha', description: 'd', inputSchema: { type: 'object' } }],
    }])
    const match = (result.matches as Array<Record<string, unknown>>)[0]
    expect(match.namespaceStatus).toBe('error')
    expect(match.namespaceError).toBe('not running')
  })
})

describe('mcp_auth 追加', () => {
  it('supportsMcpAuth 时在工具列表末尾补 mcp_auth', () => {
    const ns = toDynamicNamespace(
      {
        serverName: 'ida-pro-mcp',
        serverIdentifier: 'user-ida-pro-mcp',
        status: 'ready',
        tools: [{ name: 'x', providerIdentifier: 'ida-pro-mcp', toolName: 'decompile', description: 'd', inputSchema: {} }],
      },
      true,
    )
    expect(ns.tools.map(t => t.tool)).toEqual(['decompile', MCP_AUTH_TOOL.tool])
  })

  it('不支持时不补', () => {
    const ns = toDynamicNamespace(
      { serverName: 'x', serverIdentifier: 'user-x', status: 'ready', tools: [] },
      false,
    )
    expect(ns.tools).toEqual([])
  })

  it('客户端已提供 mcp_auth 时不重复追加', () => {
    const ns = toDynamicNamespace({
      serverName: 'a',
      serverIdentifier: 'user-a',
      status: 'connected',
      tools: [{
        name: 'user-a-mcp_auth',
        providerIdentifier: 'a',
        toolName: 'mcp_auth',
        description: 'auth',
        inputSchema: { type: 'object' },
      }],
    }, true)
    expect(ns.tools.filter(t => t.tool === 'mcp_auth')).toHaveLength(1)
    expect(ns.status).toBe('ready')
  })

  it('每个 namespace 各自持有独立的 mcp_auth schema 对象', () => {
    // 共享引用会让一处 mutation 污染所有 namespace
    const a = toDynamicNamespace({ serverName: 'a', serverIdentifier: 'user-a', status: 'ready', tools: [] }, true)
    const b = toDynamicNamespace({ serverName: 'b', serverIdentifier: 'user-b', status: 'ready', tools: [] }, true)
    expect(a.tools[0].inputSchema).not.toBe(b.tools[0].inputSchema)
    expect((a.tools[0].inputSchema as any).properties).not.toBe((b.tools[0].inputSchema as any).properties)
  })
})

describe('未知 namespace', () => {
  it('返回 not_found 而非抛出', () => {
    const r = renderDynamicToolsResult({ namespace: 'nope' }, NS)
    expect(r.namespaceStatus).toBe('not_found')
    expect(r.error).toContain('nope')
  })

  it('namespace 存在但工具不存在时报 tool 级错误', () => {
    const r = renderDynamicToolsResult({ namespace: 'user-ida-pro-mcp', toolName: 'nope' }, NS)
    expect(r.mode).toBe('single_tool')
    expect(r.namespaceStatus).toBe('ready')
    expect(r.error).toContain('nope')
  })
})

describe('3.17 参数兼容与大结果溢写', () => {
  it('优先读取 dynamic namespace,同时兼容旧 server/tool_name 参数', () => {
    expect(parseDynamicToolsQuery({ namespace: 'new', server: 'old', toolName: 't' })).toEqual({
      namespace: 'new',
      toolName: 't',
      pattern: undefined,
    })
    expect(parseDynamicToolsQuery({ server: 'old', tool_name: 'legacy' })).toEqual({
      namespace: 'old',
      toolName: 'legacy',
      pattern: undefined,
    })
    expect(validateDynamicToolsQuery({ toolName: 'orphan' })).toContain('requires namespace')
    expect(validateDynamicToolsQuery({ pattern: '[unclosed' })).toContain('Invalid regex pattern')
    expect(validateDynamicToolsQuery({ pattern: 'x'.repeat(257) })).toContain('256')
  })

  it('超过阈值时写入 projectDir/agent-tools 并返回 outputFilePath', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ccursor-dynamic-tools-'))
    try {
      const result = { mode: 'namespace', tools: [{ tool: 'large', description: 'x'.repeat(512) }] }
      const serialized = await serializeDynamicToolsResult(result, {
        projectDir,
        spillThresholdBytes: 64,
      })
      expect(serialized.wroteToFile).toBe(true)
      expect(serialized.outputFilePath).toContain(join(projectDir, 'agent-tools'))
      expect(JSON.parse(await readFile(serialized.outputFilePath!, 'utf8'))).toEqual(result)
      expect(JSON.parse(serialized.content).filePath).toBe(serialized.outputFilePath)
    }
    finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('小结果保持内联且使用可读 JSON', async () => {
    const result = { mode: 'catalog', namespaces: [] }
    const serialized = await serializeDynamicToolsResult(result, { spillThresholdBytes: 10_000 })
    expect(serialized.wroteToFile).toBe(false)
    expect(serialized.outputFilePath).toBeUndefined()
    expect(JSON.parse(serialized.content)).toEqual(result)
  })
})

describe('<dynamic_tools> prompt 段', () => {
  const servers = [
    { serverIdentifier: 'user-ida-pro-mcp', toolNames: ['decompile', 'list_funcs'] },
    { serverIdentifier: 'user-probe-two', toolNames: ['alpha'], serverUseInstructions: 'USE_ME' },
  ]

  it('namespace name 用 serverIdentifier,工具名逗号分隔', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('<namespace name="user-ida-pro-mcp" tools="decompile, list_funcs" source="mcp" />')
  })

  it('serverUseInstructions 渲染为 namespaceUseInstructions', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('namespaceUseInstructions="USE_ME"')
  })

  it('supportsMcpAuth 时工具列表含 mcp_auth 且附认证说明', () => {
    const s = buildDynamicToolsSection(servers, true)
    expect(s).toContain('tools="decompile, list_funcs, mcp_auth"')
    expect(s).toContain('call `mcp_auth` through `CallDynamicTool`')
  })

  it('descriptor 已含 mcp_auth 时 prompt 不重复列出', () => {
    const s = buildDynamicToolsSection([
      { serverIdentifier: 'user-auth', toolNames: ['mcp_auth'] },
    ], true)
    expect(s).toContain('tools="mcp_auth"')
    expect(s).not.toContain('tools="mcp_auth, mcp_auth"')
  })

  it('不支持认证时既不列 mcp_auth 也不附说明', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).not.toContain('mcp_auth')
  })

  it('保留官方原文的关键引导语', () => {
    const s = buildDynamicToolsSection(servers, false)
    expect(s).toContain('GetDynamicTools` and `CallDynamicTool')
    expect(s).toContain('Always inspect a tool\'s schema before invoking it with `CallDynamicTool`.')
    expect(s).toContain('... [truncated]')
  })

  it('转义 XML 属性中的引号,避免属性提前闭合', () => {
    const s = buildDynamicToolsSection(
      [{ serverIdentifier: 'srv', toolNames: ['t'], serverUseInstructions: 'say "hi" & <bye>' }],
      false,
    )
    expect(s).toContain('&quot;hi&quot;')
    expect(s).toContain('&amp;')
    expect(s).toContain('&lt;bye&gt;')
  })

  it('合并保留的 cursor namespace，且不会给它追加 mcp_auth', () => {
    const s = buildDynamicToolsSection([{
      serverIdentifier: 'cursor',
      toolNames: ['TodoWrite', 'Task'],
      serverUseInstructions: 'Native Cursor tools.',
      source: 'cursor',
    }], true)
    expect(s).toContain('name="cursor"')
    expect(s).toContain('tools="TodoWrite, Task"')
    expect(s).toContain('source="cursor"')
    expect(s).not.toContain('mcp_auth')
  })
})

describe('内置工具 final profile 分区', () => {
  const tool = (name: string) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
  })

  it('真实 registry 的核心/meta 工具常驻，Task/TodoWrite 按需发现', () => {
    const result = partitionCursorBuiltinTools(getCursorAgentTools('anthropic'), true)
    const staticNames = result.staticTools.map(item => item.name)
    const dynamicNames = result.dynamicTools.map(item => item.tool)
    expect(staticNames).toEqual(expect.arrayContaining([
      'Read',
      'Shell',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'AskQuestion',
      'GetDynamicTools',
      'CallDynamicTool',
      'ListMcpResources',
    ]))
    expect(dynamicNames).toEqual(expect.arrayContaining([
      'CreateGoal',
      'Task',
      'TodoWrite',
      'ReadLints',
      'FetchMcpResource',
      'UpdateGoal',
    ]))
    expect(dynamicNames).not.toContain('GetDynamicTools')
    expect(dynamicNames).not.toContain('CallDynamicTool')
    expect(dynamicNames).not.toContain('ListMcpResources')
  })

  it('核心工具和 meta tools 常驻，其余进入 cursor namespace', () => {
    const result = partitionCursorBuiltinTools([
      tool('Read'),
      tool('Shell'),
      tool('AskQuestion'),
      tool('GetDynamicTools'),
      tool('CallDynamicTool'),
      tool('ListMcpResources'),
      tool('FetchMcpResource'),
      tool('TodoWrite'),
      tool('Task'),
      tool('WebSearch'),
    ], true)
    expect(result.staticTools.map(item => item.name)).toEqual([
      'Read',
      'Shell',
      'AskQuestion',
      'GetDynamicTools',
      'CallDynamicTool',
      'ListMcpResources',
    ])
    expect(result.dynamicTools.map(item => item.tool)).toEqual([
      'FetchMcpResource',
      'Task',
      'TodoWrite',
      'WebSearch',
    ])
    expect(result.dynamicTools[0].inputSchema).toEqual({ type: 'object', properties: {} })
    expect(result.dynamicTools.find(item => item.tool === 'TodoWrite')?.conciseStaticContext)
      .toBe('Use this tool to manage complex multi-step tasks.')
  })

  it('把 Gemini provider 的大写 schema 类型还原为标准 JSON Schema', () => {
    const result = partitionCursorBuiltinTools([{
      name: 'TodoWrite',
      description: 'Manage todos.',
      inputSchema: {
        type: 'OBJECT',
        properties: { todos: { type: 'ARRAY', items: { type: 'STRING' } } },
      },
    }], true)
    expect(result.dynamicTools[0].inputSchema).toEqual({
      type: 'object',
      properties: { todos: { type: 'array', items: { type: 'string' } } },
    })
  })

  it('能力关闭时保持 all-static，不丢任何工具', () => {
    const tools = [tool('Read'), tool('TodoWrite')]
    const result = partitionCursorBuiltinTools(tools, false)
    expect(result.staticTools).toEqual(tools)
    expect(result.dynamicTools).toEqual([])
  })

  it('目标管理工具只提供给主代理', () => {
    const tools = getCursorAgentTools('anthropic')
    const mainNames = filterToolsForMode(tools, 'agent').map(item => item.name)
    const subagentNames = filterToolsForMode(tools, 'agent', true).map(item => item.name)

    expect(mainNames).toEqual(expect.arrayContaining(['CreateGoal', 'UpdateGoal']))
    expect(subagentNames).not.toContain('CreateGoal')
    expect(subagentNames).not.toContain('UpdateGoal')
  })

  it('仅在显式 3.17 能力、meta-MCP 或已启用会话中切到 final', () => {
    const base = {
      clientSupportsDynamicTools: false,
      mcpMetaToolEnabled: false,
      isSubagent: false,
    }
    expect(shouldEnableBuiltinDynamicProfile(base)).toBe(false)
    expect(shouldEnableBuiltinDynamicProfile({ ...base, clientSupportsDynamicTools: true })).toBe(true)
    expect(shouldEnableBuiltinDynamicProfile({ ...base, mcpMetaToolEnabled: true })).toBe(true)
    expect(shouldEnableBuiltinDynamicProfile({ ...base, previousDynamicToolCount: 4 })).toBe(true)
    expect(shouldEnableBuiltinDynamicProfile({ ...base, clientSupportsDynamicTools: true, isSubagent: true })).toBe(false)
  })
})
