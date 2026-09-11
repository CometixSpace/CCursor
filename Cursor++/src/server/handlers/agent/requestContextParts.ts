/**
 * requestContextParts blob 取回 — Cursor 3.13+ ref_only 传输模式补偿
 *
 * 背景 (agent-client/request-context-blob.ts):
 *   3.13 起 requestContext 支持分片投递,模式由 Statsig
 *   `nal_request_context_blob_transport_config` 下发,内置 fallback 为 legacy:
 *
 *     legacy   → requestContext 内联,无 parts
 *     dual     → requestContext 内联 + parts (双写)
 *     ref_only → requestContext = undefined,只发 parts
 *
 *   客户端拆分函数 (workbench GM_) 把 requestContext 切成 5 份,其中
 *   rules / skills / subagents / mcps 四组序列化后按内容哈希存入
 *   **客户端本地** transient blob map (seedAll),请求里只带 blobId;
 *   其余字段留在 parts.dynamic_context 内联下发。
 *
 *   注意 ref_only 有一条首轮降级: 会话第一轮 (turns.length === 0 且
 *   userMessageAction) 强制走 dual,第二轮起才是真 ref_only。这解释了
 *   "首条消息 MCP 正常、后续消息 MCP 消失" 的现象。
 *
 * 实测 (2-Cometixy.log, 2026-08-07):
 *   ref_only 下 requestContext 与顶层 mcp_tools **同时缺席**,
 *   parseRunRequest 两条数据源全落空 → mcpToolsCount: 0,
 *   LLM 只剩内置的 ListMcpResources / FetchMcpResource / CallMcpTool,
 *   动态 MCP 工具(decompile / list_funcs …)全部消失。
 *
 * 本模块负责: 把取回的四个 Part 字节 (取回走 clientBlobFetch, 与历史 blob 同一原语)
 * 分别解码为 Rules / Skills / Subagents / Mcps Part，再合回同一个 ParsedRunRequest。
 * dual/legacy 模式不暴露引用，因此不会重复拉取或影响旧客户端。
 */
import { fromBinary } from '@bufbuild/protobuf'
import {
  RequestContextMcpsPartSchema,
  RequestContextRulesPartSchema,
  RequestContextSkillsPartSchema,
  RequestContextSubagentsPartSchema,
} from '../../gen/agent_v1_pb'
import { logger } from '../../logger'
import type { ParsedRunRequest } from './protocol/types'
import {
  normalizeMcpInputSchema,
  normalizeMcpToolName,
  parseMcpMetaToolOptions,
  resolveMcpServerIdentifier,
} from './protocol/parseRunRequest'
import {
  applyRuleContext,
  mergeAgentSkills,
  normalizeAgentSkill,
  normalizeCustomSubagent,
} from './contextCatalog'

export type RequestContextPartName = 'rules' | 'skills' | 'subagents' | 'mcps'

export interface FetchedRulesPart {
  rules: Array<Record<string, unknown>>
  nonFileRules: Array<Record<string, unknown>>
  cloudRule?: string
}

export interface FetchedSkillsPart {
  agentSkills: Array<Record<string, unknown>>
  skillOptions?: Record<string, unknown>
}

export interface FetchedSubagentsPart {
  customSubagents: Array<Record<string, unknown>>
}

export interface FetchedMcpsPart {
  tools: Array<Record<string, unknown>>
  mcpInstructions: Array<Record<string, unknown>>
  mcpFileSystemOptions?: Record<string, unknown>
  mcpMetaToolOptions?: Record<string, unknown>
}

export function decodeRulesPart(blobData: Uint8Array): FetchedRulesPart | null {
  try {
    const part = fromBinary(RequestContextRulesPartSchema, blobData)
    const result = {
      rules: part.rules as unknown as Array<Record<string, unknown>>,
      nonFileRules: part.nonFileRules as unknown as Array<Record<string, unknown>>,
      ...(part.cloudRule !== undefined ? { cloudRule: part.cloudRule } : {}),
    }
    logger.info({ bytes: blobData.length, rules: result.rules.length, nonFileRules: result.nonFileRules.length, hasCloudRule: result.cloudRule !== undefined },
      '[PROTOCOL] rules blob decoded')
    return result
  }
  catch (error) {
    logger.warn({ error: (error as Error).message, bytes: blobData.length }, '[PROTOCOL] failed to decode RequestContextRulesPart')
    return null
  }
}

export function decodeSkillsPart(blobData: Uint8Array): FetchedSkillsPart | null {
  try {
    const part = fromBinary(RequestContextSkillsPartSchema, blobData)
    const result = {
      agentSkills: part.agentSkills as unknown as Array<Record<string, unknown>>,
      ...(part.skillOptions ? { skillOptions: part.skillOptions as unknown as Record<string, unknown> } : {}),
    }
    logger.info({ bytes: blobData.length, skills: result.agentSkills.length, hasSkillOptions: !!result.skillOptions },
      '[PROTOCOL] skills blob decoded')
    return result
  }
  catch (error) {
    logger.warn({ error: (error as Error).message, bytes: blobData.length }, '[PROTOCOL] failed to decode RequestContextSkillsPart')
    return null
  }
}

export function decodeSubagentsPart(blobData: Uint8Array): FetchedSubagentsPart | null {
  try {
    const part = fromBinary(RequestContextSubagentsPartSchema, blobData)
    const result = { customSubagents: part.customSubagents as unknown as Array<Record<string, unknown>> }
    logger.info({ bytes: blobData.length, subagents: result.customSubagents.length }, '[PROTOCOL] subagents blob decoded')
    return result
  }
  catch (error) {
    logger.warn({ error: (error as Error).message, bytes: blobData.length }, '[PROTOCOL] failed to decode RequestContextSubagentsPart')
    return null
  }
}

export function decodeMcpsPart(blobData: Uint8Array): FetchedMcpsPart | null {
  try {
    const part = fromBinary(RequestContextMcpsPartSchema, blobData)
    const tools = part.tools as unknown as Array<Record<string, unknown>>
    logger.info({
      bytes: blobData.length,
      toolCount: tools.length,
      instructionCount: part.mcpInstructions.length,
      hasFsOptions: !!part.mcpFileSystemOptions,
      hasMetaToolOptions: !!part.mcpMetaToolOptions,
    }, '[PROTOCOL] mcps blob decoded')
    return {
      tools,
      mcpInstructions: part.mcpInstructions as unknown as Array<Record<string, unknown>>,
      mcpFileSystemOptions: part.mcpFileSystemOptions as unknown as Record<string, unknown> | undefined,
      mcpMetaToolOptions: part.mcpMetaToolOptions as unknown as Record<string, unknown> | undefined,
    }
  }
  catch (error) {
    logger.warn({ error: (error as Error).message, bytes: blobData.length }, '[PROTOCOL] failed to decode RequestContextMcpsPart')
    return null
  }
}

export function applyRulesPart(parsed: ParsedRunRequest, part: FetchedRulesPart): void {
  applyRuleContext({
    parsed,
    rules: part.rules,
    nonFileRules: part.nonFileRules,
    cloudRule: part.cloudRule,
    preserveExistingUserRules: true,
  })
  logger.info({ alwaysRules: parsed.alwaysRules.length, requestableRules: parsed.projectRules.length, userRules: parsed.userRules.length },
    '[PROTOCOL] Rule context restored from rules blob')
}

export function applySkillsPart(parsed: ParsedRunRequest, part: FetchedSkillsPart): void {
  parsed.agentSkills = mergeAgentSkills(parsed.agentSkills, part.agentSkills.map(normalizeAgentSkill))
  if (part.skillOptions)
    parsed.skillOptions = part.skillOptions
  logger.info({ agentSkills: parsed.agentSkills.length, hasSkillOptions: !!parsed.skillOptions },
    '[PROTOCOL] Skill context restored from skills blob')
}

export function applySubagentsPart(parsed: ParsedRunRequest, part: FetchedSubagentsPart): void {
  const byName = new Map(parsed.customSubagents.map(subagent => [subagent.name, subagent]))
  for (const raw of part.customSubagents) {
    const subagent = normalizeCustomSubagent(raw)
    if (subagent.name)
      byName.set(subagent.name, subagent)
  }
  parsed.customSubagents = [...byName.values()]
  logger.info({ customSubagents: parsed.customSubagents.length }, '[PROTOCOL] Subagent context restored from subagents blob')
}

/**
 * 把取回的 mcps Part 合入 ParsedRunRequest。
 *
 * 复用 parseRunRequest 的同一套规范化逻辑(工具名清洗 / inputSchema 归一 /
 * serverIdentifier 解析),避免两条路径产出不一致的工具表。
 */
export function applyMcpsPart(parsed: ParsedRunRequest, part: FetchedMcpsPart): void {
  // mcpServers / mcpBasePath — 来自 mcp_file_system_options
  const fsOpts = part.mcpFileSystemOptions
  const descriptors = (fsOpts?.mcpDescriptors as Array<Record<string, unknown>> | undefined) ?? []
  if (descriptors.length > 0) {
    parsed.mcpServers = descriptors.map(d => ({
      serverName: (d.serverName as string) ?? '',
      serverIdentifier: (d.serverIdentifier as string) ?? '',
      folderPath: (d.folderPath as string) ?? '',
      serverUseInstructions: (d.serverUseInstructions as string) ?? '',
    }))
    const basePath = (fsOpts?.workspaceProjectDir as string) ?? ''
    if (basePath)
      parsed.mcpBasePath = `${basePath}/mcps`
  }

  // mcpInstructions
  if (part.mcpInstructions.length > 0) {
    parsed.mcpInstructions = part.mcpInstructions.map(m => ({
      serverName: (m.serverName as string) ?? '',
      instructions: (m.instructions as string) ?? '',
      serverIdentifier: (m.serverIdentifier as string) ?? '',
    }))
  }

  // ref_only 下 mcp_meta_tool_options 只存在于 mcps blob,不在 dynamic_context。
  // 漏掉它会把本轮误判成 legacy_flat,从而既不注入 namespace 目录也不暴露 meta tools。
  const recoveredMetaTool = parseMcpMetaToolOptions(part.mcpMetaToolOptions)
  if (recoveredMetaTool)
    parsed.mcpMetaTool = recoveredMetaTool

  // serverName → serverIdentifier 反查表 (与 parseRunRequest 同构)。meta descriptor
  // 同样是权威来源,尤其在 mcpFileSystemOptions 未启用时不能只依赖 fs descriptors。
  const serverIdentifierByName = new Map<string, string>()
  for (const src of [...parsed.mcpServers, ...parsed.mcpInstructions, ...(parsed.mcpMetaTool?.descriptors ?? [])]) {
    if (src.serverName && src.serverIdentifier && !serverIdentifierByName.has(src.serverName))
      serverIdentifierByName.set(src.serverName, src.serverIdentifier)
  }

  // mcpTools: 先恢复完整/白名单工具,再从 slim meta descriptor 补齐路由条目。
  // 后者即使没有 schema,也具备 CallDynamicTool 所需的 serverIdentifier + toolName。
  const seenNames = new Set<string>()
  parsed.mcpTools = part.tools.map((t) => {
    const rawName = (t.name as string) ?? ''
    const normalizedName = normalizeMcpToolName(rawName, seenNames)
    seenNames.add(normalizedName)
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

  const routed = new Set(parsed.mcpTools.map(t => `${t.serverIdentifier}\u0000${t.toolName}`))
  for (const descriptor of parsed.mcpMetaTool?.descriptors ?? []) {
    for (const tool of descriptor.tools) {
      const routeKey = `${descriptor.serverIdentifier}\u0000${tool.toolName}`
      if (routed.has(routeKey))
        continue
      routed.add(routeKey)
      const rawName = descriptor.serverIdentifier
        ? `${descriptor.serverIdentifier}-${tool.toolName}`
        : tool.toolName
      const name = normalizeMcpToolName(rawName, seenNames)
      seenNames.add(name)
      parsed.mcpTools.push({
        name,
        description: tool.description ?? '',
        inputSchema: normalizeMcpInputSchema(tool.inputSchema, tool.inputSchemaJson),
        providerIdentifier: descriptor.serverName,
        toolName: tool.toolName,
        serverIdentifier: descriptor.serverIdentifier,
      })
    }
  }

  logger.info({
    mcpTools: parsed.mcpTools.length,
    mcpServers: parsed.mcpServers.length,
    mcpInstructions: parsed.mcpInstructions.length,
    mcpMetaToolEnabled: parsed.mcpMetaTool?.enabled === true,
    namespaces: parsed.mcpMetaTool?.descriptors.map(d => ({
      name: d.serverIdentifier,
      tools: d.tools.length,
    })) ?? [],
  }, '[PROTOCOL] MCP context restored from mcps blob')
}

/** Return decode success; the run boundary decides required versus catalog-only. */
export function applyRequestContextPart(parsed: ParsedRunRequest, partName: RequestContextPartName, blobData: Uint8Array | null): boolean {
  if (!blobData) {
    logger.warn({ partName }, '[PROTOCOL] request-context part blob unavailable from client; keeping inline context')
    return false
  }
  switch (partName) {
    case 'rules': {
      const part = decodeRulesPart(blobData)
      if (part)
        applyRulesPart(parsed, part)
      return part !== null
    }
    case 'skills': {
      const part = decodeSkillsPart(blobData)
      if (part)
        applySkillsPart(parsed, part)
      return part !== null
    }
    case 'subagents': {
      const part = decodeSubagentsPart(blobData)
      if (part)
        applySubagentsPart(parsed, part)
      return part !== null
    }
    case 'mcps': {
      const part = decodeMcpsPart(blobData)
      if (part)
        applyMcpsPart(parsed, part)
      return part !== null
    }
  }
}
