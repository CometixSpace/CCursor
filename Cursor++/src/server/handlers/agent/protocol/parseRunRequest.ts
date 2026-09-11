import type { IdeFile, ParsedCursorRule, ParsedRunRequest } from './types'
import { listKnowledgeItems } from '../../../config/knowledgeBaseStore'
import { logger } from '../../../logger'
import { emptyParsed, toBytes } from './shared'
import { blobIdFromBytes } from '../blob'
import { BlobIntegrityError } from '../blobErrors'
import {
  categorizeCursorRules,
  isSkillPath,
  mergeAgentSkills,
  normalizeAgentSkill,
  normalizeCursorRule,
  normalizeCustomSubagent,
} from '../contextCatalog'

type ParsedBackgroundTaskCompletion = {
  taskId: string
  kind: string
  status: string
  title: string
  detail?: string
  outputPath?: string
  threadId?: string
}

function parseBlobReferences(value: unknown): string[] {
  if (value === undefined || value === null)
    return []
  if (!Array.isArray(value))
    throw new BlobIntegrityError([{ blobId: '(reference list)', status: 'invalid-reference' }])
  return value.map((reference) => {
    const bytes = toBytes(reference)
    if (!bytes?.byteLength)
      throw new BlobIntegrityError([{ blobId: '(empty reference)', status: 'invalid-reference' }])
    return blobIdFromBytes(bytes)
  })
}

function normalizeBackgroundTaskKind(value: unknown): string {
  if (typeof value === 'number') {
    if (value === 1) return 'shell'
    if (value === 2) return 'subagent'
  }
  const text = String(value ?? '').toLowerCase()
  if (text.includes('shell')) return 'shell'
  if (text.includes('subagent')) return 'subagent'
  return 'unspecified'
}

function normalizeBackgroundTaskStatus(value: unknown): string {
  if (typeof value === 'number') {
    if (value === 1) return 'success'
    if (value === 2) return 'error'
    if (value === 3) return 'aborted'
  }
  const text = String(value ?? '').toLowerCase()
  if (text.includes('success')) return 'success'
  if (text.includes('error')) return 'error'
  if (text.includes('abort')) return 'aborted'
  return text || 'unspecified'
}

function parseBackgroundTaskCompletions(action: Record<string, unknown> | undefined): ParsedBackgroundTaskCompletion[] {
  const backgroundAction = action?.backgroundTaskCompletionAction as Record<string, unknown> | undefined
  const completions = (backgroundAction?.completions as Array<Record<string, unknown>> | undefined) ?? []
  return completions.map(c => ({
    taskId: String(c.taskId ?? ''),
    kind: normalizeBackgroundTaskKind(c.kind),
    status: normalizeBackgroundTaskStatus(c.status),
    title: String(c.title ?? ''),
    ...(typeof c.detail === 'string' ? { detail: c.detail } : {}),
    ...(typeof c.outputPath === 'string' ? { outputPath: c.outputPath } : {}),
    ...(typeof c.threadId === 'string' ? { threadId: c.threadId } : {}),
  }))
}

function formatBackgroundTaskCompletionMessage(completions: ParsedBackgroundTaskCompletion[]): string {
  const blocks = completions.map((c, index) => {
    const lines = [
      `kind: ${c.kind}`,
      c.taskId ? `task_id: ${c.taskId}` : undefined,
      `status: ${c.status}`,
      c.title ? `title: ${c.title}` : undefined,
      c.outputPath ? `output_path: ${c.outputPath}` : undefined,
      c.threadId ? `thread_id: ${c.threadId}` : undefined,
      'response:',
      '<response>',
      c.detail?.trim() || 'No output',
      '</response>',
    ].filter((line): line is string => line !== undefined)
    return completions.length > 1 ? `task_completion_${index + 1}:\n${lines.join('\n')}` : lines.join('\n')
  })

  return `<system_reminder>
Do not reiterate or repeat the contents of this agent notification to the user unless asked to do so.

Follow your instructions for Handling subagent notifications.
</system_reminder>

<agent_notification>
${blocks.join('\n\n')}
</agent_notification>`
}

/** 解析 runRequest protobuf → ParsedRunRequest */
export function parseRunRequest(msg: Record<string, unknown>): ParsedRunRequest {
  const runRequest = msg.runRequest as Record<string, unknown> | undefined
  if (!runRequest) {
    return emptyParsed()
  }

  const action = runRequest.action as Record<string, unknown> | undefined

  const resumeAction = action?.resumeAction as Record<string, unknown> | undefined
  const isResume = !!resumeAction
  const isSummarize = !!action?.summarizeAction
  const backgroundTaskCompletions = parseBackgroundTaskCompletions(action)
  const isBackgroundTaskCompletion = backgroundTaskCompletions.length > 0
  // 子代理判定: subagentTypeName 由客户端在创建 subagent RunSSE 时设置
  // conversationGroupId is root-parent correlation, not this child's state identity.
  const subagentTypeName = runRequest.subagentTypeName as string | undefined
  const isSubagent = typeof subagentTypeName === 'string' && subagentTypeName.length > 0

  if (isBackgroundTaskCompletion) {
    logger.info({
      count: backgroundTaskCompletions.length,
      completions: backgroundTaskCompletions.map(c => ({
        taskId: c.taskId, kind: c.kind, status: c.status, detailLen: c.detail?.length ?? 0,
      })),
    }, '[AGENT] backgroundTaskCompletion parsed');
  }

  logger.debug({
    actionKeys: action ? Object.keys(action) : [],
    isSummarize, isResume, isSubagent, isBackgroundTaskCompletion,
    backgroundTaskCompletionCount: backgroundTaskCompletions.length,
    runRequestTopKeys: Object.keys(runRequest).filter(k => !['conversationState', 'action', 'modelDetails', 'mcpTools'].includes(k)),
  }, '[AGENT] action diagnosis')

  // executePlanAction: Build 按钮触发 (Plan 确认后执行)
  // Proto: ExecutePlanAction { request_context, plan, plan_file_uri, plan_file_content, execution_mode }
  const executePlanAction = action?.executePlanAction as Record<string, unknown> | undefined
  const isExecutePlan = !!executePlanAction

  const userAction = action?.userMessageAction as Record<string, unknown> | undefined
  const cancelAction = action?.cancelAction as Record<string, unknown> | undefined
  const userMessage = userAction?.userMessage as Record<string, unknown> | undefined

  // InterruptedPendingToolCallResolutions — 用户中断时已完成的 shell/task 结果
  // 来自 userMessageAction (resume 后重发) 或 cancelAction (中断时附带)
  const interruptedResolutionsRaw = (
    userAction?.interruptedPendingToolCallResolutions
    ?? cancelAction?.interruptedPendingToolCallResolutions
  ) as Record<string, unknown> | undefined
  const interruptedResolutions: Array<{ toolCallId: string, shellResult?: Record<string, unknown>, taskResult?: Record<string, unknown> }> = (() => {
    const raw = interruptedResolutionsRaw?.resolutions
    if (!Array.isArray(raw))
      return []
    return raw.map((r: any) => ({
      toolCallId: typeof r.toolCallId === 'string' ? r.toolCallId : '',
      shellResult: r.resolution?.case === 'shellResult' ? r.resolution.value : r.shellResult,
      taskResult: r.resolution?.case === 'taskResult' ? r.resolution.value : r.taskResult,
    })).filter(r => r.toolCallId.length > 0)
  })()
  if (interruptedResolutions.length > 0) {
    logger.info({ count: interruptedResolutions.length, ids: interruptedResolutions.map(r => r.toolCallId) },
      '[AGENT] interrupted pending tool call resolutions received')
  }
  // requestContext: userMessageAction / resumeAction / executePlanAction 都可能带一份。
  // 多轮对话中每一轮都会重新推送,不能假设首轮装载一次就够。
  //
  // Cursor 3.13+ 引入 requestContextParts 分片投递 (agent-client/request-context-blob.ts)。
  // 三种模式由 Statsig `nal_request_context_blob_transport_config` 下发:
  //   legacy   → requestContext 内联,无 parts
  //   dual     → requestContext 内联 + parts (双写)
  //   ref_only → requestContext 置为 undefined,只发 parts
  //
  // ref_only 下客户端拆分函数 (workbench GM_) 把 requestContext 切成 5 份:
  //   rules / skills / subagents / mcps 四组走 blob (仅留 blobId),
  //   其余字段(env、各类开关、fileContents、projectLayouts…) 原样留在 parts.dynamic_context。
  // 因此这里用 dynamic_context 兜底,可救回除那 9 个字段外的全部上下文。
  // 注: MCP 工具表在 mcps blob 里,需另行取回,见 mcpTools 段。
  // 层级要点: request_context_parts 挂在 **ConversationAction** 上 (field 17),
  // 与 user_message_action 等 oneof 分支平级 —— 而 request_context 才在
  // UserMessageAction 内部 (field 2)。两者层级不同,极易搞混。
  //
  //   message ConversationAction {
  //     oneof action { user_message_action = 1; resume_action = 2; ... }
  //     optional RequestContextPartReferences request_context_parts = 17;
  //   }
  //
  // 早前从 userAction/resumeAction 内部取,恒为 undefined,ref_only 补偿
  // 从未生效: 实测日志里 actionKeys 明确是 ["userMessageAction","requestContextParts"]
  // 两者并列,而同轮 mcpMode 退化为 legacy_flat、routingTableSize=0。
  // 保留旧路径作兜底,以防个别 action 变体真把它放在内层。
  const requestContextParts = (action?.requestContextParts
    ?? userAction?.requestContextParts
    ?? resumeAction?.requestContextParts
    ?? executePlanAction?.requestContextParts) as Record<string, unknown> | undefined
  const inlineRequestContext = (userAction?.requestContext
    ?? resumeAction?.requestContext
    ?? executePlanAction?.requestContext) as Record<string, unknown> | undefined
  const requestContext = inlineRequestContext
    ?? (requestContextParts?.dynamicContext as Record<string, unknown> | undefined)

  if (requestContextParts) {
    logger.debug({
      transportMode: inlineRequestContext ? 'dual' : 'ref_only',
      hasDynamicContext: !!requestContextParts.dynamicContext,
      mcpsByteLength: requestContextParts.mcpsByteLength ?? 0,
      rulesByteLength: requestContextParts.rulesByteLength ?? 0,
      skillsByteLength: requestContextParts.skillsByteLength ?? 0,
      subagentsByteLength: requestContextParts.subagentsByteLength ?? 0,
    }, '[PROTOCOL] requestContext delivered via blob parts')
  }
  const modelDetails = runRequest.modelDetails as Record<string, unknown> | undefined
  const requestedModel = runRequest.requestedModel as Record<string, unknown> | undefined

  // 打点: 记录客户端发来的模型相关字段, 定位 modelId 为空的根因
  logger.debug({
    'modelDetails.modelId': modelDetails?.modelId,
    'modelDetails.displayModelId': modelDetails?.displayModelId,
    'requestedModel.modelId': requestedModel?.modelId,
    hasModelDetails: !!modelDetails,
    hasRequestedModel: !!requestedModel,
    modelDetailsKeys: modelDetails ? Object.keys(modelDetails) : [],
    requestedModelKeys: requestedModel ? Object.keys(requestedModel) : [],
  }, '[AGENT] model field diagnosis')
  const conversationState = runRequest.conversationState as Record<string, unknown> | undefined
  const prependUserMessagesRaw = (
    (userAction?.prependUserMessages as Array<Record<string, unknown>> | undefined)
    ?? (runRequest.prependUserMessages as Array<Record<string, unknown>> | undefined)
    ?? []
  )

  // Debug: log conversationState — 判断客户端是否回传了完整 state
  //
  // 两种常见形态:
  //  1. rpmLen > 0: 客户端在 checkpoint roundtrip 里带回了历史, server 直接采用
  //  2. csKeys=[]: new conversation, reset, or delayed initial request.
  // No client epoch is transmitted; never infer deletion or recover SQL history.
  const csKeys = conversationState ? Object.keys(conversationState) : []
  const rpmLen = (conversationState?.rootPromptMessagesJson as unknown[])?.length ?? 0
  const csMode = conversationState?.mode as string | undefined
  logger.debug({
    csKeys,
    rpmLen,
    csMode,
    turnsLen: (conversationState?.turns as unknown[])?.length ?? 0,
    csEmpty: csKeys.length === 0,
  }, rpmLen > 0
    ? '[SESSION] <<< CS RECV: client sent history (checkpoint roundtrip OK)'
    : '[SESSION] <<< CS RECV: empty (new session or unverified reset; no automatic history restore/delete)',
  )

  // 提取用户消息附带的图片
  // Cursor 客户端 toJson() 后 oneof 展平为顶层字段:
  //   { blobIdWithData: { blobId: "base64", data: "base64" } }  — 最常见,含内联数据
  //   { data: "base64" }                                         — 纯内联数据
  //   { blobId: "base64" }                                       — 纯引用(无数据,暂不支持)
  // protobuf-es 原生 oneof 形态: { dataOrBlobId: { case, value } }  — 同时兼容
  const selectedContext = userMessage?.selectedContext as Record<string, unknown> | undefined
  const selectedImagesRaw = (selectedContext?.selectedImages as Array<Record<string, unknown>> | undefined) ?? []
  const selectedImages: Array<{ mimeType: string, data: string }> = []
  for (const img of selectedImagesRaw) {
    const mimeType = (img.mimeType as string) ?? 'image/png'
    let imageBase64 = ''

    // 形态 1: JSON 展平 — blobIdWithData 顶层字段 (Cursor 实际发送格式)
    const blobIdWithData = img.blobIdWithData as Record<string, unknown> | undefined
    if (blobIdWithData?.data) {
      const raw = blobIdWithData.data
      imageBase64 = raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : String(raw)
    }

    // 形态 2: JSON 展平 — data 顶层字段
    if (!imageBase64 && img.data && img.data !== img.blobIdWithData) {
      const raw = img.data
      imageBase64 = raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : String(raw)
    }

    // 形态 3: protobuf-es oneof — dataOrBlobId = { case, value }
    if (!imageBase64) {
      const dataOrBlobId = img.dataOrBlobId as { case?: string, value?: unknown } | undefined
      if (dataOrBlobId?.case === 'data' && dataOrBlobId.value) {
        imageBase64 = Buffer.from(dataOrBlobId.value as Uint8Array).toString('base64')
      }
      else if (dataOrBlobId?.case === 'blobIdWithData') {
        const nested = dataOrBlobId.value as Record<string, unknown>
        if (nested.data) {
          imageBase64 = Buffer.from(nested.data as Uint8Array).toString('base64')
        }
      }
    }

    if (imageBase64) {
      selectedImages.push({ mimeType, data: imageBase64 })
    }
    else {
      logger.warn({ uuid: img.uuid, keys: Object.keys(img) }, '[SESSION] skipping image: no inline data available')
    }
  }
  if (selectedImages.length > 0) {
    logger.info({ count: selectedImages.length, mimeTypes: selectedImages.map(i => i.mimeType) }, '[SESSION] extracted user images')
  }

  const env = requestContext?.env as Record<string, unknown> | undefined
  const rules = (requestContext?.rules as Array<Record<string, unknown>> | undefined) ?? []
  const nonFileRules = (requestContext?.nonFileRules as Array<Record<string, unknown>> | undefined) ?? []
  const disabledTeamRules = (requestContext?.disabledTeamRules as string[] | undefined) ?? []
  const tools = (requestContext?.tools as Array<Record<string, unknown>> | undefined) ?? []
  const categorizedRules = categorizeCursorRules({
    rules,
    nonFileRules,
    disabledTeamRules,
    workspacePaths: (env?.workspacePaths as string[] | undefined) ?? [],
  })
  const userRules = [...categorizedRules.userRules]
  const alwaysRules = categorizedRules.alwaysRules
  const projectRules = categorizedRules.requestableRules
  const cursorRules = categorizedRules.cursorRules

  if (cursorRules.length > 0) {
    logger.debug({
      count: cursorRules.length,
      always: alwaysRules.length,
      requestable: projectRules.length,
      user: categorizedRules.userRules.length,
      skillsFromRules: categorizedRules.skills.length,
      samples: cursorRules.slice(0, 5).map(rule => ({
        kind: rule.kind,
        source: rule.source,
        fullPath: rule.fullPath,
        globs: rule.globs,
        contentPreview: rule.content.slice(0, 60),
      })),
    }, '[AGENT] rules classified')
  }

  // 合入本地 KnowledgeBase items (Cursor 设置页 "User Rules")。
  // 官方客户端不会把这些塞进 requestContext.rules,而是靠官方服务端
  // 从用户账户侧读出 knowledgeBase 后自行注入 system prompt。BYOK 在
  // 这里复刻同样的行为 — 读本地 knowledge-base.json,合入 userRules。
  //
  // 去重策略:以 content 判重,避免用户既在设置页填了又在 .cursor/rules 下写同名规则导致双份。
  try {
    const kbItems = listKnowledgeItems()
    if (kbItems.length > 0) {
      const existing = new Set([
        ...userRules.map(rule => rule.trim()),
        ...alwaysRules.map(rule => rule.content.trim()),
      ])
      let injected = 0
      for (const it of kbItems) {
        const body = (it.knowledge ?? '').trim()
        if (!body || existing.has(body))
          continue
        userRules.push(it.knowledge)
        existing.add(body)
        injected++
      }
      if (injected > 0) {
        logger.debug({ injected, total: kbItems.length }, '[AGENT] knowledge-base items injected into userRules')
      }
    }
  }
  catch (err) {
    logger.warn({ error: (err as Error).message }, '[AGENT] knowledge-base injection failed (continuing)')
  }

  const agentSkillsField = (requestContext?.agentSkills as Array<Record<string, unknown>> | undefined) ?? []
  const agentSkills = mergeAgentSkills(
    categorizedRules.skills,
    agentSkillsField.map(normalizeAgentSkill),
  )
  const customSubagents = ((requestContext?.customSubagents as Array<Record<string, unknown>> | undefined) ?? [])
    .map(normalizeCustomSubagent)
    .filter(subagent => subagent.name.length > 0)

  logger.debug({
    userRulesCount: userRules.length,
    alwaysRulesCount: alwaysRules.length,
    requestableRulesCount: projectRules.length,
    agentSkillsCount: agentSkills.length,
    customSubagentsCount: customSubagents.length,
  }, '[AGENT] request context catalogs parsed')

  // MCP 服务器配置
  // 官方客户端双写:AgentRunRequest.mcp_file_system_options (proto field 6) 和
  // requestContext.mcp_file_system_options (field 23) 内容等价,后者优先,前者兜底。
  const mcpFsOpts = (requestContext?.mcpFileSystemOptions
    ?? runRequest.mcpFileSystemOptions) as Record<string, unknown> | undefined
  const mcpDescriptors = (mcpFsOpts?.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  const mcpBasePath = (mcpFsOpts?.workspaceProjectDir as string) ?? ''

  const mcpServers = mcpDescriptors.map(d => ({
    serverName: (d.serverName as string) ?? '',
    serverIdentifier: (d.serverIdentifier as string) ?? '',
    folderPath: (d.folderPath as string) ?? '',
    serverUseInstructions: (d.serverUseInstructions as string) ?? '',
  }))

  // MCP 工具 — 官方双写:AgentRunRequest.mcp_tools.mcp_tools[] (field 4) 和
  // requestContext.tools[] (field 7) 内容一致;合并去重 (按 name)。
  const topLevelMcpToolsBag = runRequest.mcpTools as Record<string, unknown> | undefined
  const topLevelMcpTools = (topLevelMcpToolsBag?.mcpTools as Array<Record<string, unknown>> | undefined) ?? []
  const mergedToolsByName = new Map<string, Record<string, unknown>>()
  for (const t of tools) {
    const name = (t.name as string) ?? ''
    if (name)
      mergedToolsByName.set(name, t)
  }
  // MCP meta-tool 模式 (requestContext.mcp_meta_tool_options, proto field 26)
  //
  // Cursor 3.9+ 引入,由 feature gate 控制。开启后客户端不再把第三方 MCP 工具
  // 塞进扁平 tools[],改为只下发一份"目录"(descriptor),让 LLM 用 GetMcpTools
  // 按需拉取完整定义 —— 上下文经济学: 装几个 server 就上百个工具,全量预载
  // 会吃掉几万 token,而一次会话通常只用到其中几个。
  //
  // 客户端构造逻辑 (workbench ZOg, 行 597380):
  //   n = mcpMetaToolEnabled && mcpMetaToolSlimDescriptorsEnabled
  //   if (!n || DRu.has(serverIdentifier))  → 才进扁平 tools[]
  //   DRu = {"cursor-dev-control", "cursor-ide-browser"}  ← 仅自家两个 server
  //
  //   descriptor 里的工具在 slim 模式下被裁剪 (YOg, 行 597370):
  //     保留 toolName + annotations(title/readOnlyHint/destructiveHint/
  //          idempotentHint/openWorldHint)
  //     砍掉 description + inputSchema
  //   annotations 之所以保留,是因为审批决策(只读可自动放行)必须在调用前做出。
  //
  // 关键: slim descriptor 虽缺 schema,但**路由所需字段齐全**
  //   serverIdentifier + serverName + toolName → 足以构造 McpArgs,
  // 所以工具表(路由用)可由 descriptor 直接构建,只有给 LLM 看的 schema 需按需拉。
  const mcpMetaTool = parseMcpMetaToolOptions(requestContext?.mcpMetaToolOptions)

  // meta-tool 开启时,把 descriptor 里的工具补进合并表,保证 CallMcpTool 能路由。
  // 已在扁平表里的(白名单 server)不覆盖,避免丢掉其完整 description/inputSchema。
  if (mcpMetaTool) {
    for (const d of mcpMetaTool.descriptors) {
      for (const dt of d.tools) {
        // 复刻客户端扁平表的命名: `${serverIdentifier}-${toolName}` (ZOg)
        const flatName = d.serverIdentifier ? `${d.serverIdentifier}-${dt.toolName}` : dt.toolName
        if (mergedToolsByName.has(flatName))
          continue
        mergedToolsByName.set(flatName, {
          name: flatName,
          providerIdentifier: d.serverName,
          toolName: dt.toolName,
          description: dt.description ?? '',
          inputSchema: dt.inputSchema,
          inputSchemaJson: dt.inputSchemaJson,
          annotationsJson: dt.annotationsJson,
        })
      }
    }
  }

  for (const t of topLevelMcpTools) {
    const name = (t.name as string) ?? ''
    if (name && !mergedToolsByName.has(name))
      mergedToolsByName.set(name, t)
  }
  const mergedMcpTools = Array.from(mergedToolsByName.values())

  // MCP 使用说明 (requestContext.mcp_instructions, proto field 14)
  const mcpInstructionsRaw = (requestContext?.mcpInstructions as Array<Record<string, unknown>> | undefined) ?? []
  const mcpInstructions = mcpInstructionsRaw.map(m => ({
    serverName: (m.serverName as string) ?? '',
    instructions: (m.instructions as string) ?? '',
    serverIdentifier: (m.serverIdentifier as string) ?? '',
  }))

  // serverName → serverIdentifier 反查表。
  // McpToolDefinition 只带 provider_identifier(= serverName),没有 server_identifier;
  // 后者来自 McpDescriptor / McpInstructions,用作 resolveMcpServerIdentifier 的兜底源。
  const serverIdentifierByName = new Map<string, string>()
  for (const src of [...mcpServers, ...mcpInstructions]) {
    if (src.serverName && src.serverIdentifier && !serverIdentifierByName.has(src.serverName))
      serverIdentifierByName.set(src.serverName, src.serverIdentifier)
  }

  // IDE 状态 (selectedContext.invocation_context.ide_state)
  const invocationContext = selectedContext?.invocationContext as Record<string, unknown> | undefined
  const ideStateRaw = invocationContext?.ideState as Record<string, unknown> | undefined
  const mapIdeFiles = (raw: Array<Record<string, unknown>> | undefined): IdeFile[] => {
    if (!raw)
      return []
    return raw.map((f) => {
      const cursor = f.cursorPosition as Record<string, unknown> | undefined
      return {
        path: (f.path as string) ?? '',
        relativePath: f.relativePath as string | undefined,
        totalLines: Number(f.totalLines) || 0,
        activeCommand: f.activeCommand as string | undefined,
        cursorLine: cursor?.line !== undefined ? Number(cursor.line) : undefined,
        cursorText: cursor?.text as string | undefined,
      }
    })
  }
  const ideState = ideStateRaw
    ? {
        visibleFiles: mapIdeFiles(ideStateRaw.visibleFiles as Array<Record<string, unknown>> | undefined),
        recentlyViewedFiles: mapIdeFiles(ideStateRaw.recentlyViewedFiles as Array<Record<string, unknown>> | undefined),
      }
    : undefined

  // Documentations (selectedContext.documentations) — 只含 docId + name,正文需客户端之后补
  const documentationsRaw = (selectedContext?.documentations as Array<Record<string, unknown>> | undefined) ?? []
  const documentations = documentationsRaw.map(d => ({
    docId: (d.docId as string) ?? '',
    name: (d.name as string) ?? '',
  }))

  // Cursor Commands (selectedContext.cursor_commands) — 用户触发的 /command
  const cursorCommandsRaw = (selectedContext?.cursorCommands as Array<Record<string, unknown>> | undefined) ?? []
  const cursorCommands = cursorCommandsRaw.map(c => ({
    name: (c.name as string) ?? '',
    content: (c.content as string) ?? '',
  }))

  // 用户手动 @ 的 Skill/Rule。Skill 必须保留完整 content，官方会直接内联；
  // SelectedCursorRule 外层是 { rule: CursorRule }。
  const selectedSkillsRaw = (selectedContext?.selectedSkills as Array<Record<string, unknown>> | undefined) ?? []
  const selectedRuleRecords = ((selectedContext?.cursorRules as Array<Record<string, unknown>> | undefined) ?? [])
    .map(item => item.rule && typeof item.rule === 'object'
      ? normalizeCursorRule(item.rule as Record<string, unknown>)
      : null)
    .filter((rule): rule is ParsedCursorRule => rule !== null && rule.content.length > 0)
  const selectedSkills = selectedSkillsRaw
    .map(normalizeAgentSkill)
    .filter(skill => skill.fullPath.length > 0 || skill.content.length > 0)
  // 旧客户端把手动 Skill 放在 selectedContext.cursor_rules；新字段有值时以
  // selected_skills 为权威，避免同一 Skill 被同时当作 Rule 和 Skill 注入。
  if (selectedSkillsRaw.length === 0) {
    selectedSkills.push(...selectedRuleRecords
      .filter(rule => isSkillPath(rule.fullPath))
      .map(rule => normalizeAgentSkill({
        ...rule.raw,
        fullPath: rule.fullPath,
        content: rule.content,
      })))
  }
  const selectedCursorRules = selectedSkillsRaw.length > 0
    ? selectedRuleRecords
    : selectedRuleRecords.filter(rule => !isSkillPath(rule.fullPath))

  // ── SelectedContext 扩展字段 (客户端已 gather,server 注入 LLM) ──
  //
  // 注: 5 个 git 字段 (gitDiff / gitDiffFromBranchToMain / gitCommits /
  //   gitPrDiffSelections / selectedPullRequests) 已刻意跳过 — 官方有
  //   StreamDiffReview / SummarizeWithReferences 专用后端 pipeline,
  //   BYOK 直接注入原始数据会爆 context 或无效。改为让 LLM 主动用 Shell
  //   tool 查 git (与 Claude Code 工具优先哲学一致)。

  // codeSelections (field 5) — 用户框选代码,Range 采用 agent.v1.Range (start/end
  // 均为 Position{line,column})。JSON 展平后 range.start.line / start.column 路径一致。
  const codeSelectionsRaw = (selectedContext?.codeSelections as Array<Record<string, unknown>> | undefined) ?? []
  const codeSelections = codeSelectionsRaw.map((cs) => {
    const range = cs.range as Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const end = range?.end as Record<string, unknown> | undefined
    return {
      content: (cs.content as string) ?? '',
      path: (cs.path as string) ?? '',
      relativePath: cs.relativePath as string | undefined,
      range: range
        ? {
            startLine: Number(start?.line ?? 0),
            startCol: Number(start?.column ?? 0),
            endLine: Number(end?.line ?? 0),
            endCol: Number(end?.column ?? 0),
          }
        : undefined,
    }
  }).filter(cs => cs.content.length > 0)

  // terminalSelections (field 7) — 用户框选终端输出,结构同 codeSelections + title
  const terminalSelectionsRaw = (selectedContext?.terminalSelections as Array<Record<string, unknown>> | undefined) ?? []
  const terminalSelections = terminalSelectionsRaw.map((ts) => {
    const range = ts.range as Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const end = range?.end as Record<string, unknown> | undefined
    return {
      content: (ts.content as string) ?? '',
      title: ts.title as string | undefined,
      path: ts.path as string | undefined,
      range: range
        ? {
            startLine: Number(start?.line ?? 0),
            startCol: Number(start?.column ?? 0),
            endLine: Number(end?.line ?? 0),
            endCol: Number(end?.column ?? 0),
          }
        : undefined,
    }
  }).filter(ts => ts.content.length > 0)

  // requestContext.file_contents (proto field 20) — @ 整个文件的真实通道
  // map<string, string> 在 protobuf-es toJson 后是普通对象 { path: content }
  // 注:这个字段在 requestContext 下,不是 selectedContext 下
  const fileContentsRaw = requestContext?.fileContents as Record<string, unknown> | undefined
  const fileContents: Record<string, string> = {}
  if (fileContentsRaw && typeof fileContentsRaw === 'object') {
    for (const [k, v] of Object.entries(fileContentsRaw)) {
      if (typeof v === 'string' && v.length > 0)
        fileContents[k] = v
    }
  }

  // requestContext.project_layouts (proto field 13) — @ Folder 的目录树
  // repeated LsDirectoryTreeNode,递归结构 { path, files, subfolders }
  // 原样保留给 messageBuilder 决定如何渲染,不在 server 侧展开避免 token 失控
  const projectLayoutsRaw = (requestContext?.projectLayouts as Array<Record<string, unknown>> | undefined) ?? []
  const projectLayouts = projectLayoutsRaw.filter(n => n && typeof n === 'object')

  // externalLinks (field 9) — 普通链接 + PDF。pdfContent 是已解析的文本;
  // blob_id 分支暂不支持(与 extraContext blob 一样等 Step 4 blob store)
  const externalLinksRaw = (selectedContext?.externalLinks as Array<Record<string, unknown>> | undefined) ?? []
  const externalLinks = externalLinksRaw.map(el => ({
    url: (el.url as string) ?? '',
    uuid: (el.uuid as string) ?? '',
    filename: el.filename as string | undefined,
    isPdf: (el.isPdf as boolean) ?? false,
    pdfContent: el.pdfContent as string | undefined,
  })).filter(el => el.url.length > 0)

  // selectedSubagents (field 22) — 用户 @ 的 subagent,只有 name
  const selectedSubagentsRaw = (selectedContext?.selectedSubagents as Array<Record<string, unknown>> | undefined) ?? []
  const selectedSubagents = selectedSubagentsRaw.map(s => ({
    name: (s.name as string) ?? '',
  })).filter(s => s.name.length > 0)

  // subagentModelOverrides (AgentRunRequest field 20) — 用户在 Settings > Subagents 中的模型 override
  // subagentModelOverrides oneof 在 protobuf JSON 中: { subagentType, model?: {modelId,...}, inherit?: bool, disabled?: bool }
  const subagentModelOverridesRaw = (runRequest?.subagentModelOverrides as Array<Record<string, unknown>> | undefined) ?? []
  const subagentModelOverrides = subagentModelOverridesRaw.map(o => {
    const subagentType = (o.subagentType as string) ?? ''
    if (o.model) {
      const model = o.model as Record<string, unknown>
      return { subagentType, selection: { case: 'model' as const, modelId: (model.modelId as string) ?? '' } }
    }
    if (o.disabled)
      return { subagentType, selection: { case: 'disabled' as const } }
    return { subagentType, selection: { case: 'inherit' as const } }
  }).filter(o => o.subagentType.length > 0)

  // selectedBrowsers (field 24) — Cursor 浏览器集成,@ 的页面
  const selectedBrowsersRaw = (selectedContext?.selectedBrowsers as Array<Record<string, unknown>> | undefined) ?? []
  const selectedBrowsers = selectedBrowsersRaw.map(b => ({
    browserId: (b.browserId as string) ?? '',
    url: (b.url as string) ?? '',
    pageTitle: b.pageTitle as string | undefined,
  })).filter(b => b.url.length > 0)

  // recentAgentsContext (field 27) — 最近 N 个对话摘要。Proto 层是 oneof wrapper:
  // { recent_agents_context: { recent_agents: [...] } }
  const recentAgentsContextRaw = selectedContext?.recentAgentsContext as Record<string, unknown> | undefined
  const recentAgentsRaw = (recentAgentsContextRaw?.recentAgents as Array<Record<string, unknown>> | undefined) ?? []
  const recentAgentsContext = recentAgentsRaw.map(a => ({
    name: (a.name as string) ?? '',
    path: (a.path as string) ?? '',
    overview: a.overview as string | undefined,
  })).filter(a => a.name.length > 0)

  // 诊断打点:两处 context 下各字段发来什么 keys + 各字段实际 parse 到多少条
  // 用于持续观察客户端真实字段分布,定位"@ 菜单 → proto 字段"的真实映射。
  logger.debug({
    // ── userMessage.selectedContext 下的字段 ──
    selectedContextKeys: selectedContext ? Object.keys(selectedContext) : [],
    codeSelections: codeSelections.length,
    terminalSelections: terminalSelections.length,
    externalLinks: externalLinks.length,
    selectedSubagents: selectedSubagents.length,
    selectedBrowsers: selectedBrowsers.length,
    recentAgentsContext: recentAgentsContext.length,
    pastChatsInCodeSelections: codeSelections.filter(cs => cs.path.includes('agent-transcripts')).length,
    gitDiff: !!selectedContext?.gitDiff,
    gitDiffFromBranchToMain: !!selectedContext?.gitDiffFromBranchToMain,
    gitCommits: ((selectedContext?.gitCommits as unknown[]) ?? []).length,
    // ── userMessageAction.requestContext 下的字段 (新发现:@ File / @ Folder 走这里) ──
    requestContextKeys: requestContext ? Object.keys(requestContext) : [],
    fileContentsCount: Object.keys(fileContents).length,
    fileContentsTotalBytes: Object.values(fileContents).reduce((a, b) => a + b.length, 0),
    projectLayoutsCount: projectLayouts.length,
  }, '[AGENT] selectedContext diagnosis')

  // Extra Context Entries — oneof { data, blob_id }。本步只记录原始形态,
  // blobId 形态的取回留给 Step 4 (通过 blob store 解包)。
  const extraContextEntriesRaw = (selectedContext?.extraContextEntries as Array<Record<string, unknown>> | undefined) ?? []
  const extraContextEntries = extraContextEntriesRaw.map((e) => {
    // JSON 展平形态:{ data: "..." } 或 { blobId: "base64-bytes" }
    if (typeof e.data === 'string') {
      return { data: e.data }
    }
    if (e.blobId) {
      const raw = e.blobId
      const blobId = raw instanceof Uint8Array
        ? blobIdFromBytes(raw)
        : typeof raw === 'string'
          ? blobIdFromBytes(Buffer.from(raw, 'base64'))
          : ''
      return { blobId }
    }
    // protobuf-es oneof 形态:{ dataOrBlobId: { case, value } }
    const dob = e.dataOrBlobId as { case?: string, value?: unknown } | undefined
    if (dob?.case === 'data' && typeof dob.value === 'string') {
      return { data: dob.value }
    }
    if (dob?.case === 'blobId' && dob.value) {
      const blobId = dob.value instanceof Uint8Array
        ? blobIdFromBytes(dob.value)
        : String(dob.value)
      return { blobId }
    }
    return {}
  }).filter(e => e.data || e.blobId)

  // Git 仓库信息 — requestContext.git_repos (proto field 11),不在 env 下
  const gitReposRaw = (requestContext?.gitRepos as Array<Record<string, unknown>> | undefined) ?? []
  const gitRepos = gitReposRaw.map(g => ({
    path: (g.path as string) ?? '',
    status: (g.status as string) ?? '',
    branchName: (g.branchName as string) ?? '',
  }))

  // executePlanAction: Build 按钮点击后,客户端发 planFileContent(plan 全文)
  // 作为 userText 注入,让 LLM 在 Agent 模式下按 plan 执行
  const planContent = (executePlanAction?.planFileContent as string) ?? ''
  const planFileUri = (executePlanAction?.planFileUri as string) ?? ''
  const baseUserText = (userMessage?.text as string) ?? ''
  const backgroundTaskCompletionText = isBackgroundTaskCompletion
    ? formatBackgroundTaskCompletionMessage(backgroundTaskCompletions)
    : ''

  // 解析 RequestedModel.parameters[] — 客户端 Edit 面板选中的参数值
  const requestedParams = (requestedModel?.parameters as Array<{ id: string, value: string }>) ?? []
  const paramMap = new Map(requestedParams.map(p => [p.id, p.value]))

  // reasoning (OpenAI 复合: none=off, 其他=thinking+level) / effort (Anthropic: →level 别名)
  let clientThinking = paramMap.has('thinking') ? paramMap.get('thinking') === 'true' : undefined
  let clientThinkingLevel: string | undefined = paramMap.get('level') || paramMap.get('effort') || undefined
  const clientReasoning = paramMap.get('reasoning')
  if (clientReasoning !== undefined) {
    clientThinking = clientReasoning !== 'none'
    clientThinkingLevel = clientReasoning !== 'none' ? clientReasoning : undefined
  }
  const clientThinkingBudgetRaw = paramMap.get('budget')
  const clientThinkingBudget = clientThinkingBudgetRaw ? Number(clientThinkingBudgetRaw) : undefined
  // effort/budget 轴存在但无 thinking 轴时隐含 thinking 开启 (QS 只开 Effort Levels 的场景),
  // 对齐 buildVariantSuffix 的显示语义——picker 显示 :icon-brain: 档位就必须真的思考。
  // legacy 'level' 参数不触发隐含: legacy 路径 thinking=true 时总会显式回传 thinking 参数
  if (clientThinking === undefined && (paramMap.has('effort') || paramMap.has('budget')))
    clientThinking = true
  const clientContextTokenLimitRaw = paramMap.get('context')
  const clientContextTokenLimit = clientContextTokenLimitRaw ? Number(clientContextTokenLimitRaw) : undefined
  const clientFast = paramMap.has('fast') ? paramMap.get('fast') === 'true' : undefined

  if (requestedParams.length > 0) {
    logger.debug({ parameters: Object.fromEntries(paramMap) }, '[AGENT] client parameters')
  }

  return {
    userText: isExecutePlan && planContent
      ? `Execute the following plan:\n\n${planContent}`
      : isBackgroundTaskCompletion
        ? backgroundTaskCompletionText
        : baseUserText,
    modelId: (requestedModel?.modelId as string) || (modelDetails?.modelId as string) || '',
    conversationId: (runRequest.conversationId as string) ?? '',
    runId: typeof runRequest.runId === 'string' && runRequest.runId ? runRequest.runId : undefined,
    conversationGroupId: typeof runRequest.conversationGroupId === 'string' && runRequest.conversationGroupId ? runRequest.conversationGroupId : undefined,
    requestContextTransport: requestContextParts
      ? (inlineRequestContext ? 'dual' : 'ref_only')
      : 'legacy',
    // 这些显式 capability fields 与 Dynamic Tools 同批出现在 3.17 AgentRunRequest；
    // 老客户端完全没有字段，不能只凭 requestContextParts(3.13+)误判。
    clientSupportsDynamicTools: runRequest.clientSupportsPromptContextUsageRpc === true
      || runRequest.clientSupportsRoutedModelUpdate === true
      || runRequest.clientSupportsPreviewCard === true,
    cursorDynamicTools: [],
    dynamicToolCount: 0,
    dynamicToolTransitionReminder: false,
    contextTokenLimit: clientContextTokenLimit && Number.isFinite(clientContextTokenLimit) && clientContextTokenLimit > 0
      ? Math.floor(clientContextTokenLimit)
      : undefined,
    mode: (userMessage?.mode as string) ?? 'AGENT_MODE_AGENT',
    isSummarize,
    isSubagent,
    isBackgroundTaskCompletion,
    backgroundTaskCompletions,
    clientThinking,
    clientThinkingLevel,
    clientThinkingBudget: clientThinkingBudget && Number.isFinite(clientThinkingBudget) ? clientThinkingBudget : undefined,
    clientFast,
    userRules,
    alwaysRules,
    projectRules,
    cursorRules,
    agentSkills,
    skillOptions: (requestContext?.skillOptions ?? runRequest.skillOptions) as Record<string, unknown> | undefined,
    customSubagents,
    cloudRule: typeof requestContext?.cloudRule === 'string' ? requestContext.cloudRule : undefined,
    disabledTeamRules,
    env: {
      osVersion: env?.osVersion as string | undefined,
      workspacePaths: env?.workspacePaths as string[] | undefined,
      shell: env?.shell as string | undefined,
      sandboxEnabled: env?.sandboxEnabled as boolean | undefined,
      terminalsFolder: env?.terminalsFolder as string | undefined,
      agentSharedNotesFolder: env?.agentSharedNotesFolder as string | undefined,
      agentConversationNotesFolder: env?.agentConversationNotesFolder as string | undefined,
      timeZone: env?.timeZone as string | undefined,
      projectFolder: env?.projectFolder as string | undefined,
      agentTranscriptsFolder: env?.agentTranscriptsFolder as string | undefined,
      artifactsFolder: env?.artifactsFolder as string | undefined,
      sandboxSupported: env?.sandboxSupported as boolean | undefined,
      sandboxNetworkHasDefaults: env?.sandboxNetworkHasDefaults as boolean | undefined,
      sandboxNetworkExplicitAllowlist: env?.sandboxNetworkExplicitAllowlist as string[] | undefined,
      secretRedactionEnabled: env?.secretRedactionEnabled as boolean | undefined,
      computerUseSupported: env?.computerUseSupported as boolean | undefined,
      isWorkingDirHomeDir: env?.isWorkingDirHomeDir as boolean | undefined,
      processWorkingDirectory: env?.processWorkingDirectory as string | undefined,
      smartModeClassifierAutoModeEnabled: env?.smartModeClassifierAutoModeEnabled as boolean | undefined,
      devForceNextSmartModeClassifierBlockToken: env?.devForceNextSmartModeClassifierBlockToken as string | undefined,
    },
    gitRepos: gitRepos.length > 0 ? gitRepos : undefined,
    isGitRepo: gitRepos.length > 0,
    mcpServers,
    mcpBasePath: mcpBasePath ? `${mcpBasePath}/mcps` : '',
    // 只有 ref_only 需要回取 blob。dual 已有完整 inline requestContext，
    // 不暴露引用可避免双写模式重复 fetch。
    rulesBlobId: inlineRequestContext ? undefined : toBytes(requestContextParts?.rulesBlobId),
    skillsBlobId: inlineRequestContext ? undefined : toBytes(requestContextParts?.skillsBlobId),
    subagentsBlobId: inlineRequestContext ? undefined : toBytes(requestContextParts?.subagentsBlobId),
    mcpsBlobId: inlineRequestContext ? undefined : toBytes(requestContextParts?.mcpsBlobId),
    supportsMcpAuth: requestContext?.supportsMcpAuth === true,
    mcpMetaTool,
    mcpTools: (() => {
      const seenNames = new Set<string>()
      return mergedMcpTools.map((t) => {
        const rawName = (t.name as string) ?? ''
        const normalizedName = normalizeMcpToolName(rawName, seenNames)
        seenNames.add(normalizedName)
        if (normalizedName !== rawName) {
          logger.debug(
            { raw: rawName, normalized: normalizedName },
            '[PROTOCOL] MCP tool name sanitized to match Anthropic pattern',
          )
        }
        const providerIdentifier = (t.providerIdentifier as string) ?? ''
        const toolName = (t.toolName as string) ?? ''
        return {
          name: normalizedName,
          description: (t.description as string) ?? '',
          inputSchema: normalizeMcpInputSchema(t.inputSchema, t.inputSchemaJson),
          providerIdentifier,
          toolName,
          serverIdentifier: resolveMcpServerIdentifier(rawName, toolName, providerIdentifier, serverIdentifierByName),
        }
      })
    })(),
    mcpInstructions,
    ideState,
    documentations,
    cursorCommands,
    selectedSkills,
    selectedCursorRules,
    extraContextEntries,
    codeSelections,
    terminalSelections,
    fileContents,
    projectLayouts,
    externalLinks,
    selectedSubagents,
    subagentModelOverrides,
    selectedBrowsers,
    recentAgentsContext,
    webSearchEnabled: (requestContext?.webSearchEnabled as boolean) ?? false,
    webFetchEnabled: (requestContext?.webFetchEnabled as boolean) ?? false,
    readLintsEnabled: (requestContext?.readLintsEnabled as boolean) ?? false,
    readPaths: Array.isArray(conversationState?.readPaths)
      ? conversationState.readPaths.filter((path): path is string => typeof path === 'string')
      : [],
    // rootPromptMessagesJson 包含对话历史的所有 blob IDs。
    // ConversationStateStructure (checkpoint) 中是 bytes[] (T:12),
    // ConversationState (runRequest) 中是 string[] (T:9)。
    // protobuf-es 将 bytes → string 时做了 base64 encode,
    // 所以收到的 string 需要 base64 decode 还原为原始 blobId。
    historyBlobIds: parseBlobReferences(conversationState?.rootPromptMessagesJson),
    historyTurnBlobIds: parseBlobReferences(conversationState?.turns),
    historySummaryArchiveIds: parseBlobReferences(conversationState?.summaryArchives),
    historyTokenDetails: (() => {
      const tokenDetails = conversationState?.tokenDetails as Record<string, unknown> | undefined
      if (!tokenDetails)
        return undefined
      const usedTokens = Number(tokenDetails.usedTokens)
      const maxTokens = Number(tokenDetails.maxTokens)
      if (!Number.isFinite(usedTokens) || !Number.isFinite(maxTokens))
        return undefined
      return { usedTokens, maxTokens }
    })(),
    rawUserMessage: userMessage ? { ...userMessage } : undefined,
    selectedImages,
    prependUserMessages: prependUserMessagesRaw
      .map(entry => ({
        text: typeof entry.text === 'string' ? entry.text : '',
        messageId: typeof entry.messageId === 'string' ? entry.messageId : undefined,
      }))
      .filter(entry => entry.text.length > 0),
    isResume,
    interruptedResolutions,
    isExecutePlan,
    executePlanContent: planContent || undefined,
    executePlanFileUri: planFileUri || undefined,
    debugModeConfig: (() => {
      const dmc = requestContext?.debugModeConfig as Record<string, unknown> | undefined
      if (!dmc) return undefined
      return {
        logPath: (dmc.logPath as string) ?? '',
        serverEndpoint: (dmc.serverEndpoint as string) ?? '',
        sessionId: (dmc.sessionId as string) ?? '',
      }
    })(),
    conversationNotesListing: (requestContext?.conversationNotesListing as string) ?? '',
    sharedNotesListing: (requestContext?.sharedNotesListing as string) ?? '',
  }
}

/** 将 requestContext/RequestContextMcpsPart 中的 meta-tool 目录归一成同一形态。 */
export function parseMcpMetaToolOptions(raw: unknown): ParsedRunRequest['mcpMetaTool'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const options = raw as Record<string, unknown>
  if (options.enabled !== true)
    return undefined

  const descriptors = (options.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  return {
    enabled: true,
    descriptors: descriptors.map(d => ({
      serverName: typeof d.serverName === 'string' ? d.serverName : '',
      serverIdentifier: typeof d.serverIdentifier === 'string' ? d.serverIdentifier : '',
      ...(typeof d.serverUseInstructions === 'string' && d.serverUseInstructions
        ? { serverUseInstructions: d.serverUseInstructions }
        : {}),
      tools: ((d.tools as Array<Record<string, unknown>> | undefined) ?? [])
        .map(t => ({
          toolName: typeof t.toolName === 'string' ? t.toolName : '',
          ...(typeof t.description === 'string' && t.description ? { description: t.description } : {}),
          ...(t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
            ? { inputSchema: t.inputSchema as Record<string, unknown> }
            : {}),
          ...(typeof t.inputSchemaJson === 'string' && t.inputSchemaJson
            ? { inputSchemaJson: t.inputSchemaJson }
            : {}),
          ...(typeof t.annotationsJson === 'string' ? { annotationsJson: t.annotationsJson } : {}),
        }))
        .filter(t => t.toolName.length > 0),
    })),
  }
}

/**
 * 规范化 MCP 工具名以匹配 Anthropic tools 的 name pattern: ^[a-zA-Z0-9_-]+$
 *
 * MCP server 下发的工具名经常带 `.` / `:` / `/` / 空格 / 非 ASCII,会触发
 * provider 400 "tools[N].name: string does not match pattern"。
 *
 * 这里把所有非法字符替换为 `_`,合并连续下划线、修剪首尾下划线;空或首字符被
 * 修没的回退到 `mcp_tool`;冲突时追加 _2 / _3 / ... 保证一批工具内唯一。
 *
 * 注意:只 normalize 用作 LLM tools schema 的 name;providerIdentifier 与
 * toolName 保持原样,因为那两个字段用来把 tool_call 回路回客户端 mcpService
 * 做真实路由。
 */
/**
 * 解析 MCP 工具归属 server 的 identifier,用于回填 McpArgs.server_identifier。
 *
 * 客户端构造工具定义时 (workbench q1f):
 *   name               = `${serverIdentifier}-${toolName}`
 *   providerIdentifier = serverName        ← 注意是显示名,不是 identifier
 *
 * 因此优先从 rawName 剥掉 `-${toolName}` 后缀拿到精确 identifier;这条路径不依赖
 * mcpFileSystemOptions,在 requestContext 走 blob 分片(ref_only)时依然可用。
 * 剥离失败再退回 serverName → serverIdentifier 反查表。
 */
export function resolveMcpServerIdentifier(
  rawName: string,
  toolName: string,
  providerIdentifier: string,
  byName: Map<string, string>,
): string {
  if (rawName && toolName) {
    const suffix = `-${toolName}`
    if (rawName.endsWith(suffix) && rawName.length > suffix.length)
      return rawName.slice(0, -suffix.length)
  }
  return byName.get(providerIdentifier) ?? ''
}

export function normalizeMcpToolName(raw: string, seen: Set<string>): string {
  let base = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!base)
    base = 'mcp_tool'
  if (!seen.has(base))
    return base
  let i = 2
  while (seen.has(`${base}_${i}`))
    i++
  return `${base}_${i}`
}

/**
 * 把 McpToolDefinition.inputSchema 规范成标准 JSON Schema object。
 *
 * 客户端 (@bufbuild/protobuf) 在 toJson 后 google.protobuf.Value 常见为普通 JSON,
 * 但偶尔仍会以 Value-wrapped 形态下发 (如 { structValue: { fields: {...} } }),
 * 这时 LLM 的 tools schema 会报无效 JSON Schema。
 *
 * 防御性地 unwrap 一层,并确保输出至少是 object 形态以通过 provider 侧校验。
 */
export function normalizeMcpInputSchema(raw: unknown, rawJson?: unknown): Record<string, unknown> {
  if (typeof rawJson === 'string' && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    }
    catch {
      // 回退到 protobuf Value 字段;调用方仍能得到可诊断的 schema。
    }
  }
  if (raw == null || typeof raw !== 'object')
    return { type: 'object' }
  const obj = raw as Record<string, unknown>

  // 已是标准 JSON Schema: { type, properties?, ... }
  if (typeof obj.type === 'string' || obj.properties || obj.$schema)
    return obj

  // google.protobuf.Value 形态: { structValue: { fields: { ... } } }
  const structValue = obj.structValue as Record<string, unknown> | undefined
  if (structValue) {
    const fields = (structValue.fields as Record<string, unknown> | undefined) ?? structValue
    return { type: 'object', properties: unwrapProtoValueFields(fields) }
  }

  // google.protobuf.Struct 形态: { fields: { ... } }
  if (obj.fields && typeof obj.fields === 'object')
    return { type: 'object', properties: unwrapProtoValueFields(obj.fields as Record<string, unknown>) }

  // 其他未知形态直接返回,让 provider 报错 (比伪造 schema 更可诊断)
  return obj
}

/** 把 google.protobuf.Struct.fields 中每个 Value 递归 unwrap 为裸值 */
function unwrapProtoValueFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields))
    out[k] = unwrapProtoValue(v)
  return out
}

function unwrapProtoValue(v: unknown): unknown {
  if (v == null || typeof v !== 'object')
    return v
  const obj = v as Record<string, unknown>
  if ('stringValue' in obj) return obj.stringValue
  if ('numberValue' in obj) return obj.numberValue
  if ('boolValue' in obj) return obj.boolValue
  if ('nullValue' in obj) return null
  if (obj.listValue && typeof obj.listValue === 'object') {
    const values = (obj.listValue as Record<string, unknown>).values as unknown[] | undefined
    return Array.isArray(values) ? values.map(unwrapProtoValue) : []
  }
  if (obj.structValue && typeof obj.structValue === 'object') {
    const fields = (obj.structValue as Record<string, unknown>).fields as Record<string, unknown> | undefined
    return fields ? unwrapProtoValueFields(fields) : {}
  }
  return v
}
