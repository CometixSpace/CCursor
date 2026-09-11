/**
 * Agent 协议类型定义
 *
 * ParsedRunRequest 是从 Cursor AgentClientMessage (runRequest) 中解出来的规整结构,
 * 下游翻译器(LLM 消息构造、preamble 构造、工具注册表)统一消费此结构。
 */

/** IDE 状态中的单个文件记录 (agent.v1.InvocationContext.IdeState.File) */
export interface IdeFile {
  path: string
  relativePath?: string
  totalLines: number
  activeCommand?: string
  cursorLine?: number
  cursorText?: string
}

export type ParsedCursorRuleKind = 'global' | 'fileGlobbed' | 'agentFetched' | 'manuallyAttached' | 'unknown'

/** CursorRule 的无 protobuf 包装归一形态。raw 保留给 typed ReadToolSuccess 回传。 */
export interface ParsedCursorRule {
  fullPath: string
  content: string
  kind: ParsedCursorRuleKind
  /** CursorRuleSource enum: 0 unspecified / 1 team / 2 user */
  source: number
  globs: string[]
  /** 旧调用点兼容字段；等价于 globs.join(', ')。 */
  glob?: string
  description?: string
  gitRemoteOrigin?: string
  parseError?: string
  environments: string[]
  disabledEnvironments: string[]
  plugin?: string
  marketplace?: string
  pluginId?: string
  marketplaceId?: string
  scopedTo: string[]
  frontmatter: string
  isRequired?: boolean
  raw: Record<string, unknown>
}

export interface ParsedAgentSkill {
  fullPath: string
  content: string
  description: string
  parseError?: string
  environments: string[]
  disabledEnvironments: string[]
  gitRemoteOrigin?: string
  disableModelInvocation: boolean
  plugin?: string
  marketplace?: string
  pluginId?: string
  marketplaceId?: string
  globs: string[]
  scopedTo: string[]
  raw: Record<string, unknown>
}

export interface ParsedCustomSubagent {
  fullPath: string
  name: string
  description: string
  tools: string[]
  model: string
  prompt: string
  permissionMode: 'default' | 'readonly' | 'agentOnly'
  isBackground: boolean
  forceDefaultModel: boolean
  plugin?: string
  marketplace?: string
  pluginId?: string
  marketplaceId?: string
  source?: string
  raw: Record<string, unknown>
}

/** 从 runRequest 中提取的关键信息 */
export interface ParsedRunRequest {
  userText: string
  modelId: string
  conversationId: string
  /** Logical Cursor run/retry family; distinct from the transport attempt requestId. */
  runId?: string
  /** Correlation only; never a checkpoint or cancellation ownership key. */
  conversationGroupId?: string
  /** 客户端本轮 RequestContext 传输形态，用于能力驱动的兼容切换。 */
  requestContextTransport: 'legacy' | 'dual' | 'ref_only'
  /** 由 3.17+ RunRequest capability fields 推导；旧客户端缺省为 false。 */
  clientSupportsDynamicTools: boolean
  /** 当前轮隐藏但可经保留 cursor namespace 发现/执行的原生工具。 */
  cursorDynamicTools: Array<{
    tool: string
    description: string
    inputSchema: Record<string, unknown>
    conciseStaticContext?: string
  }>
  dynamicToolCount: number
  dynamicToolTransitionReminder: boolean
  /** 当前模型的上下文窗口大小 (tokens),用于 skill catalog 预算计算 */
  contextTokenLimit?: number
  mode: string
  isSummarize: boolean
  isSubagent: boolean
  isBackgroundTaskCompletion: boolean
  backgroundTaskCompletions: Array<{
    taskId: string
    kind: string
    status: string
    title: string
    detail?: string
    outputPath?: string
    threadId?: string
  }>
  /** 用户设置的规则 (CursorRuleSource.USER + 本地 knowledge base) */
  userRules: string[]
  /** 始终注入完整正文的 workspace/team/global rules。 */
  alwaysRules: ParsedCursorRule[]
  /** 可请求或随 Read 自动附加的 workspace rules。 */
  projectRules: ParsedCursorRule[]
  /** 去重、禁用策略处理后的完整规则表，供 Read 关联匹配。 */
  cursorRules: ParsedCursorRule[]
  /** Agent Skills；完整正文只在手动附加或 Read SKILL.md 后进入模型上下文。 */
  agentSkills: ParsedAgentSkill[]
  /** RequestContextSkillsPart.skill_options，保留供旧 Skill UI/descriptor 兼容。 */
  skillOptions?: Record<string, unknown>
  /** 客户端自定义 Subagent 定义。 */
  customSubagents: ParsedCustomSubagent[]
  /** RequestContext.cloud_rule / RequestContextRulesPart.cloud_rule。 */
  cloudRule?: string
  /** dynamic_context 中保留，用于恢复 rules blob 后过滤可禁用 Team Rules。 */
  disabledTeamRules: string[]
  env: {
    osVersion?: string
    workspacePaths?: string[]
    shell?: string
    sandboxEnabled?: boolean
    terminalsFolder?: string
    agentSharedNotesFolder?: string
    agentConversationNotesFolder?: string
    timeZone?: string
    projectFolder?: string
    agentTranscriptsFolder?: string
    artifactsFolder?: string
    sandboxSupported?: boolean
    sandboxNetworkHasDefaults?: boolean
    sandboxNetworkExplicitAllowlist?: string[]
    secretRedactionEnabled?: boolean
    computerUseSupported?: boolean
    isWorkingDirHomeDir?: boolean
    processWorkingDirectory?: string
    smartModeClassifierAutoModeEnabled?: boolean
    devForceNextSmartModeClassifierBlockToken?: string
  }
  /** Git 仓库信息 */
  gitRepos?: Array<{ path: string, status: string, branchName: string }>
  isGitRepo: boolean
  /** MCP 服务器配置 */
  mcpServers: Array<{
    serverName: string
    /** McpDescriptor.server_identifier — 客户端 mcpService 按此字段唯一定位 server */
    serverIdentifier: string
    folderPath: string
    serverUseInstructions: string
  }>
  /** MCP 工具目录根路径 */
  mcpBasePath: string
  /** Cursor 3.13+ ref_only 四类 RequestContext blob 引用；dual/legacy 下均为空。 */
  rulesBlobId?: Uint8Array
  skillsBlobId?: Uint8Array
  subagentsBlobId?: Uint8Array
  mcpsBlobId?: Uint8Array
  /**
   * MCP meta-tool 模式 (requestContext.mcp_meta_tool_options)。
   *
   * enabled 时客户端只下发工具"目录"而非完整定义,LLM 需先调 GetMcpTools
   * 拉取签名再调 CallMcpTool。descriptors 在 slim 模式下只有 toolName +
   * annotations,description/inputSchema 为空 —— 完整定义须经
   * mcp_state_exec_args 通道向客户端取。
   */
  /**
   * requestContext.supports_mcp_auth — 客户端是否支持 MCP 认证流程。
   *
   * 实测: 为 true 时官方服务端会给每个 MCP namespace 的工具列表末尾自动追加
   * 一个 mcp_auth 工具(客户端下发的 descriptor 里并没有它),并在
   * <dynamic_tools> 段尾附上认证说明。见 dynamicTools.ts MCP_AUTH_TOOL。
   */
  supportsMcpAuth?: boolean
  mcpMetaTool?: {
    enabled: boolean
    descriptors: Array<{
      serverName: string
      serverIdentifier: string
      serverUseInstructions?: string
      tools: Array<{
        toolName: string
        description?: string
        inputSchema?: Record<string, unknown>
        inputSchemaJson?: string
        annotationsJson?: string
      }>
    }>
  }
  mcpTools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    providerIdentifier: string
    toolName: string
    /**
     * 归属 server 的 identifier — 回传 McpArgs.server_identifier (field 9)。
     * 客户端 MCPService.callTool 用它把工具查找限定在该 server:
     *   for (const g in tools) { if (s && g !== s) continue; ... }
     * 不传则退化为"遍历所有 server 取首个同名工具",多 server 重名时会路由错。
     */
    serverIdentifier: string
  }>
  /** MCP server 使用说明 (来自 requestContext.mcp_instructions, proto field 14) */
  mcpInstructions: Array<{
    serverName: string
    instructions: string
    serverIdentifier: string
  }>
  /** IDE 状态快照 (来自 selectedContext.invocation_context.ide_state) */
  ideState?: {
    visibleFiles: Array<IdeFile>
    recentlyViewedFiles: Array<IdeFile>
  }
  /** 用户 @ 的文档引用 (来自 selectedContext.documentations) */
  documentations: Array<{ docId: string, name: string }>
  /** 用户触发的 cursor command (来自 selectedContext.cursor_commands) */
  cursorCommands: Array<{ name: string, content: string }>
  /** 用户手动 @ 的 skill，官方会把完整 content 内联到 manually_attached_skills。 */
  selectedSkills: ParsedAgentSkill[]
  /** 用户手动 @ 的普通 Cursor Rules，完整正文只作用于当前请求。 */
  selectedCursorRules: ParsedCursorRule[]
  /**
   * 额外上下文条目 (来自 selectedContext.extra_context_entries)。
   * 每条是 { data } 或 { blobId } 之一,blobId 形态需经 blob store 解包 (Step 4)。
   */
  extraContextEntries: Array<{ data?: string, blobId?: string }>

  // ── SelectedContext 扩展字段 (客户端已 gather,逐一注入 LLM) ──

  /**
   * 用户框选代码 (来自 selectedContext.code_selections, proto field 5)
   * content = 选中的代码;range = 起止行列;path 为绝对路径
   */
  codeSelections: Array<{
    content: string
    path: string
    relativePath?: string
    range?: { startLine: number, startCol: number, endLine: number, endCol: number }
  }>
  /**
   * 用户框选终端输出 (来自 selectedContext.terminal_selections, proto field 7)
   * 客户端异步 gather,content 为多行拼接,title/path 可空
   */
  terminalSelections: Array<{
    content: string
    title?: string
    path?: string
    range?: { startLine: number, startCol: number, endLine: number, endCol: number }
  }>
  /**
   * 用户 @ 的文件内容 (来自 requestContext.file_contents, proto field 20)
   *
   * **注意:不在 selectedContext 下,在 requestContext 下**。Cursor 客户端对
   * "@ 整个文件"的处理是填 requestContext.file_contents (map<path, content>),
   * 不走 selectedContext.files。同理 @ Folder 走 requestContext.project_layouts。
   *
   * 数据形态: { "/abs/path/file.ts": "<file content>", ... }
   */
  fileContents: Record<string, string>
  /**
   * 用户 @ 的项目目录树 (来自 requestContext.project_layouts, proto field 13)
   *
   * 对应 @ Folder 菜单触发的目录结构快照。每个节点是 LsDirectoryTreeNode
   * (递归结构, 含 path / files / subfolders)。原样 JSON 压入 XML 供 LLM 理解。
   */
  projectLayouts: Array<Record<string, unknown>>
  /** 子代理模型 override (来自 AgentRunRequest.subagent_model_overrides, field 20) */
  subagentModelOverrides: Array<{
    subagentType: string
    selection: { case: 'model', modelId: string } | { case: 'inherit' } | { case: 'disabled' }
  }>
  /**
   * 用户 @ 的外部链接 (来自 selectedContext.external_links, proto field 9)
   * 包含普通 URL 和 PDF (is_pdf + pdf_content / blob_id)。菜单里没有 @Link 入口,
   * 但客户端 appendDataLink (unminify.js:709435) 仍有写入路径,保留注入。
   */
  externalLinks: Array<{
    url: string
    uuid: string
    filename?: string
    isPdf: boolean
    pdfContent?: string
  }>
  /**
   * 用户 @ 的 subagent (来自 selectedContext.selected_subagents, proto field 22)
   * 只有 name,server 需要按 name 查找 subagent 定义
   *
   * ── 刻意跳过的 git 相关字段(决策记录) ──
   * gitDiff / gitCommits / gitPrDiffSelections / selectedPullRequests:
   *   官方有 StreamDiffReview / SummarizeWithReferences 专用后端 pipeline,
   *   BYOK 脱离后直接注入原始 diff/commit 会爆 context 或成为无效数据。依赖
   *   LLM 通过 Shell tool 主动运行 git diff/log/show 获取更精确的信息。
   *
   * gitDiffFromBranchToMain (field 11) **已核实客户端真的会发**(@ Branch 实测):
   *   proto 结构为 { content: string, full_content_length_char_count: int32 },
   *   客户端跑 git diff origin/main...HEAD 截断到 ~500KB。本可实装(带硬截断
   *   到 80KB 以内注入 <git_diff_from_branch_to_main> XML 块),但:
   *     (1) @ Branch 菜单使用率预期低(大部分场景 LLM 自己跑 git 命令更准)
   *     (2) 实装要多维护一段带阈值分支的 XML 渲染逻辑
   *   权衡后**暂不实装激活**。parseRunRequest 里的诊断打点已经在持续观察
   *   客户端是否填充此字段,日后使用率上来再启用。
   *
   * 以上所有 git 字段若要激活,同步改: types.ts(加字段) + shared.ts(默认值)
   *   + parseRunRequest.ts(解析) + messageBuilder.ts(XML 块 + 硬截断)。
   */
  selectedSubagents: Array<{ name: string }>
  /**
   * 用户 @ 的浏览器页面 (来自 selectedContext.selected_browsers, proto field 24)
   * 来自 Cursor 浏览器集成,含 url + 页面标题
   */
  selectedBrowsers: Array<{
    browserId: string
    url: string
    pageTitle?: string
  }>
  /**
   * 最近的 agent 对话 (来自 selectedContext.recent_agents_context, proto field 27)
   * 取代 past_chats;客户端从最近对话列表取前 N 个 transcript 摘要
   */
  recentAgentsContext: Array<{
    name: string
    path: string
    overview?: string
  }>
  /** 客户端 Edit 面板参数 (来自 RequestedModel.parameters[]) */
  clientThinking?: boolean
  clientThinkingLevel?: string
  clientThinkingBudget?: number
  clientFast?: boolean
  /** 功能开关 */
  webSearchEnabled: boolean
  webFetchEnabled: boolean
  readLintsEnabled: boolean
  /** ConversationStateStructure.read_paths，跨轮去重 Rule/Skill 关联注入。 */
  readPaths: string[]
  /** rootPromptMessagesJson — 对话历史 blob IDs (system + messages 链) */
  historyBlobIds: string[]
  /** turns — ConversationTurnStructure blob IDs */
  historyTurnBlobIds: string[]
  /** summary_archives — 已压缩历史的 archive blob IDs */
  historySummaryArchiveIds: string[]
  historyTokenDetails?: { usedTokens: number, maxTokens: number }
  /** 当前轮原始 UserMessage (仅 userMessageAction 有；用于 turns.user_message 复刻) */
  rawUserMessage?: Record<string, unknown>
  /** 用户消息附带的图片 (来自 SelectedContext.selectedImages) */
  selectedImages: Array<{ mimeType: string, data: string }>
  /** replay / mid-conversation resend 时客户端额外附带的前序用户消息 */
  prependUserMessages: Array<{ text: string, messageId?: string }>
  isResume: boolean
  /** 中断时已完成的 shell/task 结果 (3.4.20+) */
  interruptedResolutions: Array<{ toolCallId: string, shellResult?: Record<string, unknown>, taskResult?: Record<string, unknown> }>
  /** Build 按钮触发的 Plan 执行 (来自 action.executePlanAction) */
  isExecutePlan: boolean
  executePlanContent?: string
  executePlanFileUri?: string
  /** Debug 模式配置 (来自 requestContext.debug_mode_config, proto field 15) */
  debugModeConfig?: {
    logPath: string
    serverEndpoint: string
    sessionId: string
  }
  /** 备注列表 */
  conversationNotesListing: string
  sharedNotesListing: string
}
