import type { ToolResultEnvelope } from '../handlers/agent/toolBuilders'
import { toBinary, toJsonString } from '@bufbuild/protobuf'
import { expect, it } from 'vitest'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { execMessage, partialToolCall, toolCallCompleted, toolCallStarted } from '../handlers/agent/stream'
import {
  buildExecToolResult,
  buildLocalToolResult,
  buildToolResultText,
  isToolResultError,
  normalizeToolResult,
} from '../handlers/agent/toolBuilders'
import { buildExecArgs, resolveToolCall } from '../handlers/agent/tools'

it('normalizeToolResult wraps grep workspaceResults map values as GrepUnionResult oneof', () => {
  const normalized = normalizeToolResult('grepToolCall', {
    result: {
      case: 'success',
      value: {
        pattern: 'needle',
        path: '/workspace',
        workspaceResults: {
          '/workspace': {
            content: {
              matches: [
                {
                  file: 'src/index.ts',
                  matches: [
                    {
                      lineNumber: 12,
                      content: 'needle here',
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }, {
    pattern: 'needle',
    path: '/workspace',
  })

  expect(normalized.result.case).toBe('success')
  const workspace = (normalized.result.value.workspaceResults as Record<string, unknown>)['/workspace'] as Record<string, unknown>
  const union = workspace.result as { case: string, value: Record<string, unknown> }
  expect(union.case).toBe('content')
  expect((union.value.matches as Array<Record<string, unknown>>)[0]?.file).toBe('src/index.ts')

  const text = buildToolResultText('grepToolCall', normalized, { pattern: 'needle' })
  expect(text).toMatch(/src\/index\.ts:12 needle here/)
})

it('normalizeToolResult wraps read success output as oneof and text reads content', () => {
  const normalized = normalizeToolResult('readToolCall', {
    result: {
      case: 'success',
      value: {
        path: '/tmp/file.txt',
        totalLines: 2,
        fileSize: 11,
        truncated: false,
        rangeApplied: false,
        output: {
          content: 'hello world',
        },
      },
    },
  }, {
    path: '/tmp/file.txt',
  })

  expect(normalized.result.case).toBe('success')
  const output = normalized.result.value.output as { case: string, value: unknown }
  expect(output.case).toBe('content')
  expect(output.value).toBe('hello world')
  expect(buildToolResultText('readToolCall', normalized, { path: '/tmp/file.txt' })).toBe('hello world')
})

it('buildExecToolResult keeps flat exec readResult.success.content instead of blanking it', async () => {
  const { buildExecToolResult } = await import('../handlers/agent/toolBuilders')
  const built = buildExecToolResult('readToolCall', {
    readResult: {
      success: {
        path: 'test_file.txt',
        content: 'Hello read tool',
        totalLines: 1,
        fileSize: '15',
      },
    },
  }, {
    path: 'test_file.txt',
  })

  expect(built.result.case).toBe('success')
  const output = built.result.value.output as { case: string, value: unknown }
  expect(output.case).toBe('content')
  expect(output.value).toBe('Hello read tool')

  const normalized = normalizeToolResult('readToolCall', built, { path: 'test_file.txt' })
  const normalizedOutput = normalized.result.value.output as { case: string, value: unknown }
  expect(normalizedOutput.case).toBe('content')
  expect(normalizedOutput.value).toBe('Hello read tool')
  expect(buildToolResultText('readToolCall', normalized, { path: 'test_file.txt' })).toBe('Hello read tool')
})

it('normalizeToolResult wraps mcp content items as nested oneof content blocks', () => {
  const normalized = normalizeToolResult('mcpToolCall', {
    result: {
      case: 'success',
      value: {
        content: [
          {
            text: {
              text: 'plain text result',
            },
          },
          {
            image: {
              data: 'ZmFrZQ==',
              mimeType: 'image/png',
            },
          },
        ],
        isError: false,
        structuredContent: {
          foo: 'bar',
        },
      },
    },
  }, {})

  expect(normalized.result.case).toBe('success')
  const content = normalized.result.value.content as Array<Record<string, unknown>>
  expect((content[0]?.content as { case: string }).case).toBe('text')
  expect(((content[0]?.content as { value: Record<string, unknown> }).value.text)).toBe('plain text result')
  expect((content[1]?.content as { case: string }).case).toBe('image')
})

it('resolveToolCall maps descriptor-provided external tools onto mcpToolCall with provider metadata', () => {
  const resolved = resolveToolCall('user-Context7-query-docs', {
    libraryId: '/vercel/next.js',
    query: 'routing',
  }, [
    {
      name: 'user-Context7-query-docs',
      providerIdentifier: 'Context7',
      toolName: 'query-docs',
    },
  ])

  expect(resolved.cursorToolType).toBe('mcpToolCall')
  expect(resolved.sanitizedInput.name).toBe('user-Context7-query-docs')
  expect(resolved.sanitizedInput.providerIdentifier).toBe('Context7')
  expect(resolved.sanitizedInput.toolName).toBe('query-docs')
  expect(resolved.sanitizedInput.args).toEqual({
    libraryId: '/vercel/next.js',
    query: 'routing',
  })
})

it('mcp tool args serialize correctly as google.protobuf.Value map entries', async () => {
  const { buildToolArgs } = await import('../handlers/agent/toolBuilders')
  const resolved = resolveToolCall('user-brave-search-brave_web_search', {
    query: 'cursor',
    count: 3,
    includeDomains: ['example.com'],
    freshness: null,
    safe: true,
  }, [
    {
      name: 'user-brave-search-brave_web_search',
      providerIdentifier: 'brave-search',
      toolName: 'brave_web_search',
    },
  ])

  const startedArgs = buildToolArgs('CallMcpTool', resolved.sanitizedInput, 'call-1')
  const execArgs = buildExecArgs('CallMcpTool', resolved.sanitizedInput, 'call-1')

  const startedFrame = toolCallStarted('call-1', resolved.cursorToolType, startedArgs, 'model-1')
  const execFrame = execMessage(1, 'exec-1', 'mcpArgs', execArgs)

  const startedJson = toJsonString(AgentServerMessageSchema, startedFrame)
  const execJson = toJsonString(AgentServerMessageSchema, execFrame)

  expect(startedJson).toMatch(/"providerIdentifier":"brave-search"/)
  expect(startedJson).toMatch(/"toolName":"brave_web_search"/)
  expect(startedJson).toMatch(/"query":"cursor"/)
  expect(execJson).toMatch(/"mcpArgs"/)
  expect(execJson).toMatch(/"includeDomains":\["example.com"\]/)
  expect(toBinary(AgentServerMessageSchema, startedFrame).length > 0).toBeTruthy()
})

it('partialToolCall maps dynamic external tool names to valid proto tool cases', () => {
  const frame = partialToolCall('call-1', 'mcpToolCall', 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"mcpToolCall"/)
})

it('getDynamicTools completion uses the typed proto case and preserves outputFilePath', () => {
  const raw: ToolResultEnvelope = {
    result: {
      case: 'success',
      value: {
        content: '{"note":"written"}',
        outputFilePath: '/tmp/agent-tools/tools.txt',
      },
    },
  }
  const normalized = normalizeToolResult('getMcpToolsToolCall', raw, {})
  expect(buildToolResultText('getMcpToolsToolCall', normalized, {})).toBe('{"note":"written"}')

  const frame = toolCallCompleted(
    'call-discovery',
    'getMcpToolsToolCall',
    { server: 'user-test', toolCallId: 'call-discovery' },
    normalized,
    'model-discovery',
  )
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toContain('"getMcpToolsToolCall"')
  expect(json).toContain('"outputFilePath":"/tmp/agent-tools/tools.txt"')
  expect(toBinary(AgentServerMessageSchema, frame).length).toBeGreaterThan(0)
})

it('normalizeToolResult preserves shell failure semantics and error classification', () => {
  const toolResult: ToolResultEnvelope = normalizeToolResult('shellToolCall', {
    result: {
      case: 'failure',
      value: {
        command: 'grep foo missing.txt',
        workingDirectory: '/workspace',
        stdout: '',
        stderr: 'No such file',
        output: 'No such file',
        exitCode: 2,
      },
    },
  }, {
    command: 'grep foo missing.txt',
    workingDirectory: '/workspace',
  })

  expect(toolResult.result.case).toBe('failure')
  expect(toolResult.result.value.exitCode).toBe(2)
  expect(isToolResultError(toolResult)).toBe(true)
  expect(buildToolResultText('shellToolCall', toolResult, { command: 'grep foo missing.txt' })).toMatch(/exit_code: 2/)
})

it('buildExecArgs for readLintsToolCall uses first path from paths[]', () => {
  const args = buildExecArgs('ReadLints', {
    paths: ['/tmp/a.ts', '/tmp/b.ts'],
  }, 'call-2')

  expect(args.path).toBe('/tmp/a.ts')
  expect(args.toolCallId).toBe('call-2')
})

it('task tool exec args match official subagent launch fields (方案 A: LLM 传入的 model 被忽略, 强制继承 currentModelId)', () => {
  // 输入里故意塞一个 "composer-2-fast" 模拟 LLM 被原 schema 描述诱导的行为。
  // 方案 A 下 buildExecArgs 应当完全忽略这个字段, 改用 options.currentModelId。
  const args = buildExecArgs('Task', {
    description: 'Find python script',
    prompt: 'Please find the name of the Python script that captures Claude status in this repository. Return just the filename.',
    subagentType: 'explore',
    model: 'composer-2-fast',
  }, 'call-task', {
    conversationId: 'conv-parent',
    currentModelId: 'claude-sonnet-4',
  })

  expect(args.toolCallId).toBe('call-task')
  expect(args.subagentType).toBe('explore')
  expect(args.modelId).toBe('claude-sonnet-4')
  expect(args.prompt).toBe('Please find the name of the Python script that captures Claude status in this repository. Return just the filename.')
  // proto3 bool 默认 false — LLM 不传 readonly 时 subagent 可读写(Agent 模式)
  expect(args.readonly).toBe(false)
  expect(args.parentConversationId).toBe('conv-parent')
})

it('task tool exec args fall back to current run model when subagent model is unspecified', () => {
  const args = buildExecArgs('Task', {
    description: 'Find python script',
    prompt: 'Find the Python script filename.',
    subagentType: 'explore',
  }, 'call-task-fallback', {
    conversationId: 'conv-parent',
    currentModelId: 'claude-sonnet-4',
  })

  expect(args.modelId).toBe('claude-sonnet-4')
  expect(args.parentConversationId).toBe('conv-parent')
})

it('task tool maps resume="self" to forkAgentId (self-fork), not resumeAgentId', () => {
  // 官方 Task schema: resume="self" = self-fork(fork 当前父对话为新子 agent)。
  // 必须翻译成 forkAgentId=当前 conversationId,否则客户端会把 "self" 当真实 agentId 找不到。
  const args = buildExecArgs('Task', {
    description: 'Fork current agent',
    prompt: 'Continue exploring from current state',
    subagentType: 'generalPurpose',
    resume: 'self',
  }, 'call-self-fork', {
    conversationId: 'conv-parent',
    currentModelId: 'claude-sonnet-4',
  })

  expect(args.forkAgentId).toBe('conv-parent')
  expect(args.resumeAgentId).toBeUndefined()
  expect(args.parentConversationId).toBe('conv-parent')
})

it('task tool maps "SELF" case-insensitively to forkAgentId', () => {
  const args = buildExecArgs('Task', {
    description: 'Fork',
    prompt: 'go',
    resume: ' Self ',
  }, 'call-self-fork-2', { conversationId: 'conv-x', currentModelId: 'claude-sonnet-4' })

  expect(args.forkAgentId).toBe('conv-x')
  expect(args.resumeAgentId).toBeUndefined()
})

it('task tool maps a normal resume id to resumeAgentId (not fork)', () => {
  const args = buildExecArgs('Task', {
    description: 'Resume agent',
    prompt: 'follow up',
    resume: 'agent-123',
  }, 'call-resume', { conversationId: 'conv-parent', currentModelId: 'claude-sonnet-4' })

  expect(args.resumeAgentId).toBe('agent-123')
  expect(args.forkAgentId).toBeUndefined()
})

it('task tool result maps subagent success into official task success shape', () => {
  const result = normalizeToolResult('taskToolCall', buildExecToolResult('taskToolCall', {
    subagentResult: {
      success: {
        agentId: 'subagent-1',
        finalMessage: 'capture_claude_status.py',
        toolCallCount: 1,
        durationMs: '10101',
      },
    },
  }, {
    description: 'Find python script',
    prompt: 'Find the Claude status script',
    subagentType: 'explore',
  }), {
    description: 'Find python script',
    prompt: 'Find the Claude status script',
    subagentType: 'explore',
  })

  expect(result.result.case).toBe('success')
  const value = result.result.value
  const steps = value.conversationSteps as Array<Record<string, unknown>>
  const firstMessage = steps[0]?.message as { case: string, value: Record<string, unknown> }
  expect(firstMessage?.case).toBe('assistantMessage')
  expect(firstMessage?.value?.text).toBe('capture_claude_status.py')
  expect(value.agentId).toBe('subagent-1')
  expect(value.durationMs).toBe(10101n)
  expect(value.toolCallCount).toBe(1)
  expect(buildToolResultText('taskToolCall', result, {})).toBe('capture_claude_status.py')
})

it('task tool result text exposes official subagent finalMessage response to the parent model', () => {
  const finalMessage = '<user_visible_high_level_summary>撰写了一篇文章。</user_visible_high_level_summary>\n<response>\n# AI编程助手：软件开发的未来\n\n完整正文内容。\n</response>'
  const result = normalizeToolResult('taskToolCall', buildExecToolResult('taskToolCall', {
    id: 1,
    subagentResult: {
      success: {
        agentId: 'subagent-1',
        finalMessage,
        transcriptPath: '/tmp/subagent.md',
        toolCallCount: 2,
      },
    },
  }, {}), {})
  const text = buildToolResultText('taskToolCall', result, {})

  expect(text).toContain('# AI编程助手：软件开发的未来')
  expect(text).toContain('完整正文内容')
  expect(text).toContain('[Subagent transcript: /tmp/subagent.md]')
  expect(text).not.toMatch(/^Subagent completed/)
  expect(result.result.value.transcriptPath).toBe('/tmp/subagent.md')
  expect(result.result.value.toolCallCount).toBe(2)
})

it('task tool result text supports Cursor expanded conversationStep assistantMessage shape', () => {
  const result: ToolResultEnvelope = {
    result: {
      case: 'success',
      value: {
        conversationSteps: [{ assistantMessage: { text: 'expanded step text' } }],
        agentId: 'subagent-2',
      },
    },
  }

  expect(buildToolResultText('taskToolCall', result, {})).toBe('expanded step text')
})

it('normalizeToolResult keeps updateTodos status values so Cursor can diff progress', () => {
  const normalized = normalizeToolResult('updateTodosToolCall', {
    result: {
      case: 'success',
      value: {
        todos: [
          { id: '1', content: 'todo 1', status: 2 },
          { id: '2', content: 'todo 2', status: 'TODO_STATUS_COMPLETED' },
        ],
        totalCount: 2,
        wasMerge: false,
      },
    },
  }, {})

  expect(normalized.result.case).toBe('success')
  const todos = normalized.result.value.todos as Array<Record<string, unknown>>
  expect(todos[0]?.status).toBe(2)
  expect(todos[1]?.status).toBe('TODO_STATUS_COMPLETED')
})

it('goal tools map arguments and results onto their protocol shapes', () => {
  const createResolved = resolveToolCall('CreateGoal', { objective: 'Finish remote setup' })
  expect(createResolved.cursorToolType).toBe('createGoalToolCall')
  expect(buildLocalToolResult(createResolved.cursorToolType, createResolved.sanitizedInput))
    .toEqual({ result: { case: 'success', value: {} } })

  const updateResolved = resolveToolCall('UpdateGoal', { status: 'complete' })
  expect(updateResolved.cursorToolType).toBe('updateGoalToolCall')
  expect(updateResolved.sanitizedInput.status).toBe(3)
  const updateResult = buildLocalToolResult(updateResolved.cursorToolType, updateResolved.sanitizedInput)
  expect(updateResult).toEqual({ result: { case: 'success', value: { status: 3 } } })
  expect(buildToolResultText(updateResolved.cursorToolType, updateResult, updateResolved.sanitizedInput))
    .toBe('Goal status updated to complete.')
})

it('goal tool frames serialize with the dedicated protobuf cases', () => {
  const created = toolCallCompleted('call-create-goal', 'createGoalToolCall', {
    objective: 'Finish remote setup',
  }, {
    result: { case: 'success', value: {} },
  }, 'model-1')
  expect(toJsonString(AgentServerMessageSchema, created)).toContain('"createGoalToolCall"')

  const updated = toolCallCompleted('call-update-goal', 'updateGoalToolCall', {
    status: 3,
  }, {
    result: { case: 'success', value: { status: 3 } },
  }, 'model-1')
  const json = toJsonString(AgentServerMessageSchema, updated)
  expect(json).toContain('"updateGoalToolCall"')
  expect(json).toContain('"status":"GOAL_STATUS_COMPLETE"')
})

it('task tool args serialize subagentType as official oneof shape', () => {
  const frame = toolCallStarted('call-task-json', 'taskToolCall', {
    description: 'd',
    prompt: 'p',
    subagentType: { type: { case: 'shell', value: {} } },
    model: 'qwen3.5-plus',
  }, 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"subagentType":\{"shell":\{\}\}/)
})

it('task tool completed result serializes conversationSteps assistantMessage text', () => {
  const frame = toolCallCompleted('call-task-json', 'taskToolCall', {
    description: 'd',
    prompt: 'p',
    subagentType: { type: { case: 'shell', value: {} } },
    model: 'qwen3.5-plus',
  }, {
    result: {
      case: 'success',
      value: {
        conversationSteps: [{ message: { case: 'assistantMessage', value: { text: 'hello from subagent' } } }],
        agentId: 'subagent-1',
      },
    },
  }, 'model-1')
  const json = toJsonString(AgentServerMessageSchema, frame)
  expect(json).toMatch(/"assistantMessage":\{"text":"hello from subagent"\}/)
})
