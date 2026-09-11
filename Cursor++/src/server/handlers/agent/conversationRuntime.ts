import { SimulatedMsgReason, type AgentServerMessage } from '../../gen/agent_v1_pb'
import type { LLMContentBlock, LLMMessage, LLMTool, LLMToolResultBlock } from '../llm/types'
import type { ParsedRunRequest } from './protocol'
import type { AgentSession } from './session'
import type { ToolCallInfo } from './tools'
import { resolveExecutionToolName } from './tools'
import { CheckpointConflictError } from '../../database/checkpoints'
import { logger } from '../../logger'
import { resolveProviderRuntime } from '../llm'
import { emitFinalCheckpoint, emitRollingCheckpoint, throwIfBlobRunInactive } from './checkpointManager'
import { BlobIntegrityError } from './blobErrors'
import { ContextTokenTracker } from './tokenCounter'
import { estimateMessagesTokens, measureMessagesTokens, planCompaction } from './compactionStrategy'
import { executeCompaction, waitForRunCompactionLockRelease } from './compactionExecution'
import { getCompactionContentionCount, isCompactionLockHeld, releaseCompactionLock, tryAcquireCompactionLock } from './compactionLock'
import { extractPlainTextContent, materializeHistoryEntries, rebuildConversationHistory, repairHistoryEntries, retainMessageBlob, retainMessageBlobs } from './historyManager'
import { buildMessages, workspaceUris } from './protocol'
import { checkpoint, editToolCallStreamDelta, heartbeat, partialToolCall, summaryCompleted, summaryStarted, translateStream, userMessageAppended } from './stream'
import { finalizeTaskResult, launchTaskTool, runToolCall, type TaskLaunchContext } from './toolRuntime'
import { awaitExecResultAndClose, isAgentRunAbortedError, waitForPromiseWithHeartbeat } from './wait'
import { ActiveTurnTracker, createCurrentTurnUserMessageBlob, ensureTurnBlobCached, probeTurnDynamicToolCount, readTurnBaseline, type EncodedBlob } from './turnTracker'
import { restoreRequiredBlobGraph } from './requiredBlobGraph'
import type { BlobRunContext } from './runContext'
import { contextualizeDynamicMetaTools, partitionCursorBuiltinTools, shouldEnableBuiltinDynamicProfile } from './dynamicTools'
import { contextualizeSubagentTools } from './subagentCatalog'
import { addUsage, AUTOCOMPACT_NET_GROWTH_MIN_TOKENS, emptyUsageTotals, estimateContextTokens, getAutoCompactThreshold, isContextLengthLimitError, shouldTriggerCompaction } from './usage'
import { CONTEXT_LENGTH_RETRY_MAX } from './constants'
import { isSessionCancelled } from './session'
import { makeProviderError, makeToolError } from '../errors'
import { createRepairDiagnostics, hasRepairMutations, repairConversationHistory } from '../llm/transformMessages'

const EDIT_TOOL_NAMES = new Set(['ApplyPatch', 'Edit', 'Write', 'EditNotebook'])

const EDIT_TARGET_FIELD: Record<string, string> = {
  ApplyPatch: 'patch',
  Write: 'contents',
  Edit: 'new_string',
  EditNotebook: 'new_string',
}

type BreakdownCategory = { id: string, label: string, estimatedTokens: number }

function extractXmlSection(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`))
  return match?.[0] ?? ''
}

function splitSubagentDefinitionsFromDescription(description: string): { description: string, subagentDefinitions: string } {
  const marker = 'Available subagent_types and a quick description of what they do:'
  const start = description.indexOf(marker)
  if (start < 0)
    return { description, subagentDefinitions: '' }

  const availableModelsStart = description.indexOf('\n\nAvailable models:', start)
  const nextInstructionsStart = description.indexOf('\n\nWhen speaking to the USER', start)
  const endCandidates = [availableModelsStart, nextInstructionsStart].filter(index => index > start)
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : description.length
  const subagentDefinitions = description.slice(start, end).trim()
  const cleanedDescription = `${description.slice(0, start).trimEnd()}\n\n${description.slice(end).trimStart()}`.trim()
  return { description: cleanedDescription, subagentDefinitions }
}

function splitSubagentDefinitionsFromTools(tools: LLMTool[]): { sanitizedTools: LLMTool[], subagentDefinitionsText: string } {
  const subagentDefinitions: string[] = []
  const sanitizedTools = tools.map(tool => {
    if (tool.name !== 'Task' && tool.name !== 'Subagent' && !tool.description.includes('Available subagent_types'))
      return tool

    const split = splitSubagentDefinitionsFromDescription(tool.description)
    if (!split.subagentDefinitions)
      return tool

    subagentDefinitions.push(split.subagentDefinitions)
    return { ...tool, description: split.description }
  })

  return {
    sanitizedTools,
    subagentDefinitionsText: subagentDefinitions.join('\n\n'),
  }
}

/** 工具 schema 的计数文本 — 空集不产出 "[]",免得凭空多算 token */
function toolSchemaText(tools: LLMTool[]): string {
  return tools.length > 0 ? JSON.stringify(tools) : ''
}

/**
 * 拼接分类文本,丢掉空片段。
 *
 * 直接用 `${a}\n${b}` 在全空时会得到 "\n",countTokens 记 1 —— 而
 * toBreakdownCategories() 只输出 tokens > 0 的分类,于是 UI 上会凭空
 * 多出一行 "MCP: 1 token"。
 */
function joinSections(...parts: string[]): string {
  return parts.filter(p => p && p.trim() !== '').join('\n')
}

export function buildContextBreakdown(params: {
  systemContent: string
  preambleUserContent: string
  requestMessages: LLMMessage[]
  requestTools: LLMTool[]
  /**
   * MCP 工具名集合 — 用来把 MCP schema 从内置工具里分出来。
   *
   * tools 与 mcp 两个分类按**来源**划分,不按性质:
   *   tools — 内置工具 (含 GetDynamicTools/CallDynamicTool 这两个 meta 工具)
   *   mcp   — 一切 MCP 来的东西
   *
   * 必须这么分,否则 legacy 与 dynamic 两种模式口径会打架:
   * legacy 下 MCP 工具进扁平 requestTools,dynamic 下同一份 schema 走
   * GetDynamicTools 的结果进对话历史 —— 若按性质划分,切模式时数字会莫名跳动,
   * 也就没法回答"我装的 MCP 到底吃了多少 context"这个真正有决策价值的问题。
   */
  mcpToolNames: Set<string>
}): BreakdownCategory[] {
  const tracker = new ContextTokenTracker()

  const toolsText = extractXmlSection(params.systemContent, 'tools')
  // <dynamic_tools> 取代了旧的 <mcp_file_system> 段 (Cursor 3.15.6)。
  // 两个 tag 都抓: 旧段虽已不再生成,但历史会话的 system prompt 里可能还有,
  // 漏掉会让那部分 token 被错记进 system_prompt。
  const dynamicToolsText = extractXmlSection(params.systemContent, 'dynamic_tools')
  const mcpFileSystemText = extractXmlSection(params.systemContent, 'mcp_file_system')
  const systemPromptText = params.systemContent
    .replace(toolsText, '')
    .replace(dynamicToolsText, '')
    .replace(mcpFileSystemText, '')
  const { sanitizedTools, subagentDefinitionsText } = splitSubagentDefinitionsFromTools(params.requestTools)
  // legacy 模式下 MCP 工具混在扁平 requestTools 里,按名字挑出来归 mcp,
  // 与 dynamic 模式的 discovery 结果同一口径
  const builtinToolSchemas = sanitizedTools.filter(t => !params.mcpToolNames.has(t.name))
  const mcpToolSchemas = sanitizedTools.filter(t => params.mcpToolNames.has(t.name))
  tracker.addText('system_prompt', systemPromptText)
  tracker.addText('tools', joinSections(toolsText, toolSchemaText(builtinToolSchemas)))

  const rulesText = extractXmlSection(params.preambleUserContent, 'rules')
  const manuallyAttachedRulesText = extractXmlSection(params.preambleUserContent, 'cursor_rules_context')
  const cloudInstructionsText = extractXmlSection(params.preambleUserContent, 'cloud_instructions')
  const availableSkillsText = extractXmlSection(params.preambleUserContent, 'agent_skills')
  const attachedSkillsText = extractXmlSection(params.preambleUserContent, 'manually_attached_skills')
  const mcpInstructionsText = extractXmlSection(params.preambleUserContent, 'mcp_instructions')
  const attachedSubagentsText = extractXmlSection(params.preambleUserContent, 'attached_subagents')

  tracker.addText('rules', joinSections(rulesText, manuallyAttachedRulesText, cloudInstructionsText))
  tracker.addText('skills', joinSections(availableSkillsText, attachedSkillsText))
  // dynamic_tools 段 / mcp_instructions 段 / legacy 扁平表里的 MCP schema
  // (dynamic 模式下 discovery 结果的那部分在下面按 tool_result 归入同一分类)
  tracker.addText('mcp', joinSections(dynamicToolsText, mcpFileSystemText, mcpInstructionsText, toolSchemaText(mcpToolSchemas)))
  tracker.addText('subagents', joinSections(subagentDefinitionsText, attachedSubagentsText))

  const knownPreambleSections = [
    rulesText,
    manuallyAttachedRulesText,
    cloudInstructionsText,
    availableSkillsText,
    attachedSkillsText,
    mcpInstructionsText,
    attachedSubagentsText,
  ].filter(Boolean)
  let conversationText = params.preambleUserContent
  for (const section of knownPreambleSections)
    conversationText = conversationText.replace(section, '')

  // tool 消息在下面按工具名单独归类,这里排除以免重复计数
  // (OpenAI/Gemini 形态 content 是 string,会被 extractPlainTextContent 直接返回)
  const requestConversationText = params.requestMessages
    .filter(message => message.role !== 'tool')
    .map(message => extractPlainTextContent(message))
    .filter(text => text && text !== params.systemContent && text !== params.preambleUserContent)
    .join('\n')

  // ── 工具结果 ──
  //
  // extractPlainTextContent 只保留 text/thinking block,Anthropic 形态下
  // tool_result 是 content block,整块被过滤掉 —— 实测 6000 字符的结果
  // 计出来是 0。OpenAI 形态(role:'tool' + string content)则正常计入,
  // 两家口径不一致。这里统一按 block/字符串两种形态抽取。
  //
  // GetDynamicTools 的结果本质是 MCP 工具 schema(单个 40 工具的 namespace
  // 查询约 6k tokens),归到 mcp 分类才和 legacy 模式下"工具定义"的口径可比;
  // 留在 conversation 里会让人误以为是对话在膨胀。
  const toolResultTexts: string[] = []
  const mcpDiscoveryTexts: string[] = []
  const cursorDiscoveryTexts: string[] = []
  for (const message of params.requestMessages) {
    for (const { toolName, text } of extractToolResultTexts(message)) {
      if (!text)
        continue
      if (toolName === 'GetDynamicTools') {
        if (isCursorOnlyDynamicDiscovery(text))
          cursorDiscoveryTexts.push(text)
        else
          mcpDiscoveryTexts.push(text)
      }
      else
        toolResultTexts.push(text)
    }
  }

  tracker.addText('tools', joinSections(...cursorDiscoveryTexts))
  tracker.addText('mcp', joinSections(...mcpDiscoveryTexts))
  tracker.addText('conversation', joinSections(conversationText, requestConversationText, ...toolResultTexts))
  return tracker.toBreakdownCategories()
}

/**
 * 抽取消息里的工具结果文本,连同工具名。
 *
 * 两种 provider 形态:
 *   Anthropic — tool_result 作为 user 消息的 content block
 *   OpenAI/Gemini — role:'tool' 消息,content 直接是字符串
 */
function isCursorOnlyDynamicDiscovery(text: string): boolean {
  try {
    const result = JSON.parse(text) as Record<string, unknown>
    if (result.namespace === 'cursor')
      return true
    const namespaces = Array.isArray(result.namespaces) ? result.namespaces as Array<Record<string, unknown>> : []
    if (namespaces.length > 0)
      return namespaces.every(namespace => namespace.namespace === 'cursor')
    const matches = Array.isArray(result.matches) ? result.matches as Array<Record<string, unknown>> : []
    return matches.length > 0 && matches.every(match => match.namespace === 'cursor')
  }
  catch {
    return false
  }
}

function extractToolResultTexts(message: LLMMessage): Array<{ toolName: string, text: string }> {
  if (typeof message.content === 'string') {
    return message.role === 'tool'
      ? [{ toolName: message.toolName ?? '', text: message.content }]
      : []
  }
  return message.content
    .filter((block): block is LLMToolResultBlock => block.type === 'tool_result')
    .map(block => ({ toolName: block.toolName ?? '', text: block.content }))
}

export function detectEditPathFromToolInput(toolName: string, rawInput: string): string {
  const pathKey = toolName === 'EditNotebook' ? 'target_notebook' : 'path'
  const m = rawInput.match(new RegExp(`"${pathKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
  if (m?.[1]) return decodeJsonStringFragment(m[1])
  if (toolName === 'ApplyPatch') {
    const p = rawInput.match(/\*\*\*\s+(?:Update|Add|Delete)\s+File:([^\r\n]*?)(?:\\n|\r?\n)/)
    if (p?.[1]) return p[1].trim()
  }
  return ''
}

export function normalizeDetectedEditPath(rawPath: string): string {
  return rawPath || ''
}

/**
 * 增量 JSON 值提取器 — flat scanner。
 *
 * 从 LLM 流式 tool_use 参数（JSON chunks）中提取:
 * 1. path（通过 regex 在累积文本上匹配）
 * 2. 目标字段值（通过状态机扫描 key/value string pairs）
 *
 * 不做完整 JSON parse。忽略 {/[/]/} 结构字符，只关注 "key":"value"。
 * 对嵌套结构（如旧 edits[] 内的 newText）也能自然工作。
 */
export class EditDeltaExtractor {
  private state: 'SCAN' | 'IN_KEY' | 'COLON' | 'IN_VAL' | 'SKIP_VAL' | 'DONE' = 'SCAN'
  private key = ''
  private esc = false
  private buf = ''
  private readonly target: string
  private pendingOutputCR = false
  detectedPath = ''

  constructor(private readonly toolName: string) {
    this.target = EDIT_TARGET_FIELD[toolName] ?? 'patch'
  }

  feed(delta: string): string | null {
    this.buf += delta
    if (!this.detectedPath) this.detectedPath = detectEditPathFromToolInput(this.toolName, this.buf)
    if (this.state === 'DONE') return null
    let out = ''
    for (let i = 0; i < delta.length; i++) {
      const c = delta[i]
      if (this.esc) { this.esc = false; if (this.state === 'IN_VAL') out += decodeEscape(c); else if (this.state === 'IN_KEY') this.key += c; continue }
      switch (this.state) {
        case 'SCAN': if (c === '"') { this.state = 'IN_KEY'; this.key = '' } break
        case 'IN_KEY': if (c === '\\') { this.esc = true } else if (c === '"') this.state = 'COLON'; else this.key += c; break
        case 'COLON': if (c === ':' || c === ' ' || c === '\t') break; if (c === '"') this.state = this.key === this.target ? 'IN_VAL' : 'SKIP_VAL'; else this.state = 'SCAN'; break
        case 'IN_VAL': if (c === '\\') { if (i + 1 < delta.length) { out += decodeEscape(delta[++i]) } else this.esc = true } else if (c === '"') this.state = 'DONE'; else out += c; break
        case 'SKIP_VAL': if (c === '\\') { if (i + 1 < delta.length) i++; else this.esc = true } else if (c === '"') this.state = 'SCAN'; break
      }
      if (this.state === 'DONE') break
    }
    const normalizedOut = this.normalizeOutputDelta(out, this.state === 'DONE')
    return normalizedOut || null
  }

  private normalizeOutputDelta(text: string, flushPendingCR: boolean): string {
    if (!text) {
      if (flushPendingCR && this.pendingOutputCR) {
        this.pendingOutputCR = false
        return '\n'
      }
      return ''
    }

    let value = text
    let prefix = ''
    if (this.pendingOutputCR) {
      this.pendingOutputCR = false
      if (value.startsWith('\n'))
        value = value.slice(1)
      prefix = '\n'
    }

    if (!flushPendingCR && value.endsWith('\r')) {
      this.pendingOutputCR = true
      value = value.slice(0, -1)
    }

    return prefix + value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
}

function decodeJsonStringFragment(value: string): string {
  return value.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_match, esc: string) => {
    if (esc === 'b') return '\b'
    if (esc === 'f') return '\f'
    if (esc === 'n') return '\n'
    if (esc === 'r') return '\r'
    if (esc === 't') return '\t'
    if (esc.startsWith('u')) return String.fromCharCode(Number.parseInt(esc.slice(1), 16))
    return esc
  })
}

function decodeEscape(ch: string): string {
  switch (ch) {
    case 'n': return '\n'
    case 't': return '\t'
    case '\\': return '\\'
    case '"': return '"'
    case '/': return '/'
    case 'r': return '\r'
    default: return `\\${ch}`
  }
}

type EditNewlineStats = {
  chars: number
  crlf: number
  lfOnly: number
  crOnly: number
  crcrlf: number
  mixed: boolean
  trailingNewline: boolean
  maxConsecutiveBlankLines: number
}

function editNewlineStats(text: string): EditNewlineStats {
  let crlf = 0
  let lfOnly = 0
  let crOnly = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        crlf++
        i++
      } else {
        crOnly++
      }
    } else if (ch === '\n') {
      lfOnly++
    }
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let currentBlankRun = 0
  let maxConsecutiveBlankLines = 0
  for (const line of normalized.split('\n')) {
    if (line.trim().length === 0) {
      currentBlankRun++
      maxConsecutiveBlankLines = Math.max(maxConsecutiveBlankLines, currentBlankRun)
    } else {
      currentBlankRun = 0
    }
  }

  return {
    chars: text.length,
    crlf,
    lfOnly,
    crOnly,
    crcrlf: (text.match(/\r\r\n/g) ?? []).length,
    mixed: crlf > 0 && (lfOnly > 0 || crOnly > 0),
    trailingNewline: text.endsWith('\n') || text.endsWith('\r'),
    maxConsecutiveBlankLines,
  }
}

function editToolTargetStats(toolName: string, input: Record<string, unknown>): Record<string, EditNewlineStats> {
  const stats: Record<string, EditNewlineStats> = {}
  const add = (key: string) => {
    const value = input[key]
    if (typeof value === 'string') stats[key] = editNewlineStats(value)
  }
  if (toolName === 'Write') add('contents')
  else if (toolName === 'ApplyPatch') add('patch')
  else {
    add('old_string')
    add('new_string')
  }
  return stats
}

function recordAssistantBlocksIntoTurn(turn: ActiveTurnTracker | null, blocks: LLMContentBlock[]): EncodedBlob[] {
  if (!turn)
    return []
  const emitted: EncodedBlob[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') {
      const blob = turn.addThinking(block.text)
      if (blob)
        emitted.push(blob)
      continue
    }
    if (block.type === 'text') {
      const blob = turn.addAssistantText(block.text)
      if (blob)
        emitted.push(blob)
    }
  }
  return emitted
}

function isRunStateError(error: unknown): boolean {
  return error instanceof CheckpointConflictError || error instanceof BlobIntegrityError || (error instanceof Error && (
    error.name === 'BlobIntegrityError'
    || error.name === 'BlobTransferError'
    || error.name === 'BlobResourceLimitError'
  ))
}

function extractCompletedToolCall(frame: AgentServerMessage) {
  if (frame.message.case !== 'interactionUpdate')
    return undefined
  const msg = frame.message.value.message
  if (msg.case !== 'toolCallCompleted')
    return undefined
  return msg.value.toolCall
}

type EditStreamDiagnostics = {
  deltaCount: number
  streamContent: string
}

const editExtractors = new Map<string, EditDeltaExtractor>()
const editPathSent = new Set<string>()
const editStreamDiagnostics = new Map<string, EditStreamDiagnostics>()

// Auto-summarize 阈值: 不再用百分比，改为绝对 buffer 模式 (对齐 Claude Code):
//   threshold = (contextTokenLimit - 20K outputReserve) - 13K buffer
// 效果: 200K 模型 ~83.5% 触发, 1M 模型 ~96.7% 触发

function flushPendingAssistantPrefix(params: {
  roundAssistantBlocks: LLMContentBlock[]
  currentThinking: string
  currentText: string
}): {
  currentThinking: string
  currentText: string
} {
  const { roundAssistantBlocks } = params
  let { currentThinking, currentText } = params

  if (currentThinking) {
    roundAssistantBlocks.push({ type: 'thinking', text: currentThinking })
    currentThinking = ''
  }

  if (currentText) {
    roundAssistantBlocks.push({ type: 'text', text: currentText })
    currentText = ''
  }

  return { currentThinking, currentText }
}

interface InlineCompactionParams {
  run: BlobRunContext
  parsed: ParsedRunRequest
  allBlobIds: string[]
  turnBlobIds: string[]
  summaryArchiveIds: string[]
  usedTokensEstimate: number
  contextTokenLimit: number
  messages: LLMMessage[]
  route: ReturnType<typeof resolveProviderRuntime>
  readPaths: string[]
  budgetOverride?: number
}

interface InlineCompactionResult {
  newBlobIds: string[]
  newSummaryArchiveIds: string[]
  newUsedTokens: number
  newMessages: LLMMessage[]
  /** Base budget used by subsequent context-length retries. */
  baseBudgetTokens: number
}

/**
 * 在 Agent Run 流内执行 inline auto-summarize。
 *
 * 对应客户端分析中的链路①：服务端在 BiDi 流中自主决定 summarize，
 * 客户端通过 summaryStarted/summaryCompleted 消息被动响应。
 *
 * 流程：
 * 1. yield summaryStarted — 通知客户端开始 summarize
 * 2. 根据当前 allBlobIds 规划 compaction（planCompaction）
 * 3. 调用 LLM 生成摘要文本
 * 4. 生成 compaction artifacts（summary blob + archive）
 * 5. 通过 kv 消息发送新 blob 到客户端
 * 6. yield checkpoint — 回写 compacted ConversationState
 * 7. yield summaryCompleted — 通知客户端 summarize 完成
 * 8. 返回 compacted 状态供后续 round 继续使用
 */
async function* performInlineAutoSummarize(
  params: InlineCompactionParams,
): AsyncGenerator<AgentServerMessage, InlineCompactionResult | 'lock-held' | null> {
  const { parsed, run } = params
  throwIfBlobRunInactive(run)

  // 并发互斥 (设计文档 §7#7): inline 触发时锁被占 → 本轮跳过, 下轮重试。
  // F5 修正 (2026-08-29 实弹): 返回 'lock-held' 哨兵而非 null —
  // 锁被占意味着另一路压缩正在进行, 不是压缩失败, 不得计入熔断计数
  // (实弹曾观测: 慢摘要占锁 → 并发 run 三连撞锁 → 熔断误开 → 压缩被永久关停)。
  if (!tryAcquireCompactionLock(parsed.conversationId)) {
    logger.warn({
      conversationId: parsed.conversationId,
      contentionCount: getCompactionContentionCount(parsed.conversationId),
    }, '[AUTOCOMPACT] compaction lock held (another compaction in flight) — skipping this round without counting failure')
    return 'lock-held'
  }
  try {
    return yield* performInlineAutoSummarizeLocked(params)
  }
  finally {
    releaseCompactionLock(parsed.conversationId)
  }
}

async function* performInlineAutoSummarizeLocked(
  params: InlineCompactionParams,
): AsyncGenerator<AgentServerMessage, InlineCompactionResult | null> {
  const { parsed, run, allBlobIds, turnBlobIds, summaryArchiveIds, usedTokensEstimate, contextTokenLimit, route } = params

  const historyEntries = repairHistoryEntries(materializeHistoryEntries(params.messages, run.blobs), run.blobs)
  if (historyEntries.length === 0)
    return null

  const compactionPlan = planCompaction(historyEntries, {
    contextTokenLimit,
    budgetOverride: params.budgetOverride,
  })

  // 小窗结构性不可行终态: 停用自动压缩并告警 (拒动为合格终态, 设计文档 #10)
  if (compactionPlan.mode === 'disabled') {
    logger.error({
      conversationId: parsed.conversationId,
      contextTokenLimit,
      diagnostics: compactionPlan.diagnostics,
    }, '[AUTOCOMPACT] planCompaction disabled — skipping compaction (see guidance above)')
    return null
  }

  if (compactionPlan.summarizeEntries.length === 0) {
    logger.info({ conversationId: parsed.conversationId }, '[AGENT] auto-summarize: nothing to compact')
    return null
  }

  // keepTail 构成观测: 占位命中数 / 实占 token / 前沿超额 / 违约与升级链事件
  const planDiagnostics = compactionPlan.diagnostics
  const keepTailEntries = compactionPlan.keepTail.map(entry => ({
    role: entry.message.role,
    toolName: entry.message.toolName,
    isPlaceholder: typeof entry.message.content === 'string'
      ? entry.message.content.includes('[tool output elided during context compaction')
      : false,
    tokens: measureMessagesTokens([entry.message]),
  }))
  logger.info({
    conversationId: parsed.conversationId,
    compactionStartedAt: new Date().toISOString(),
    totalEntries: historyEntries.length,
    summarizeCount: compactionPlan.summarizeEntries.length,
    keepTailCount: compactionPlan.keepTail.length,
    leadingCount: compactionPlan.leading.length,
    keepTailTokens: keepTailEntries,
    placeholderHits: planDiagnostics.placeholderCount,
    inputElidedCount: planDiagnostics.inputElidedCount,
    anchorInserted: planDiagnostics.anchorInserted,
    escalationLevel: planDiagnostics.escalationLevel,
    floorViolation: planDiagnostics.floorViolation,
    frontierExcessTokens: planDiagnostics.frontierExcessTokens,
    firstConsumptionLossCount: planDiagnostics.firstConsumptionLossCount,
    budgetTokens: planDiagnostics.budgetTokens,
    largeEntryLineTokens: planDiagnostics.largeEntryLineTokens,
    usedTokensEstimate,
    contextTokenLimit,
    aggressiveRetry: params.budgetOverride !== undefined,
  }, '[AGENT] auto-summarize: starting inline compaction')

  yield summaryStarted()
  throwIfBlobRunInactive(run)

  const { artifacts, tokenDetails: compactedTokenDetails } = yield* executeCompaction({
    run,
    conversationId: parsed.conversationId,
    origin: 'inline',
    plan: compactionPlan,
    route,
    contextTokenLimit,
    turnBlobIds,
    previousSummaryArchiveIds: summaryArchiveIds,
    mode: parsed.mode,
  })

  throwIfBlobRunInactive(run)
  yield checkpoint(
    artifacts.nextRootBlobIds,
    compactedTokenDetails.usedTokens,
    compactedTokenDetails.maxTokens,
    parsed.mode,
    undefined,
    {
      turnBlobIds,
      summaryArchiveIds: artifacts.nextSummaryArchiveIds,
      workspaceUris: workspaceUris(parsed),
      readPaths: params.readPaths,
      modelName: route.model,
      gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
    },
  )

  throwIfBlobRunInactive(run)
  yield summaryCompleted('Chat context summarized.')

  // 重建 compacted 后的 messages 数组供后续 round 使用
  const newMessages = artifacts.rootEntries.map(entry => entry.message)
  const repairDiagnostics = createRepairDiagnostics(newMessages.length)
  const repairedNewMessages = repairConversationHistory(newMessages, repairDiagnostics)
  if (hasRepairMutations(repairDiagnostics)) {
    logger.debug({
      stage: 'performInlineAutoSummarize:newMessages',
      conversationId: parsed.conversationId,
      ...repairDiagnostics,
    }, '[HISTORY_REPAIR] canonicalized conversation history')
  }

  logger.info({
    conversationId: parsed.conversationId,
    previousBlobCount: allBlobIds.length,
    newBlobCount: artifacts.nextRootBlobIds.length,
    previousUsedTokens: usedTokensEstimate,
    newUsedTokens: compactedTokenDetails.usedTokens,
    newMessageCount: repairedNewMessages.length,
  }, '[AGENT] auto-summarize: compaction complete')

  return {
    newBlobIds: artifacts.nextRootBlobIds,
    newSummaryArchiveIds: artifacts.nextSummaryArchiveIds,
    newUsedTokens: compactedTokenDetails.usedTokens,
    newMessages: repairedNewMessages,
    baseBudgetTokens: compactionPlan.diagnostics.budgetTokens,
  }
}

export async function* handleConversationRun(
  parsed: ParsedRunRequest,
  session: AgentSession | null,
  run: BlobRunContext,
): AsyncIterable<AgentServerMessage> {
  throwIfBlobRunInactive(run)
  const route = resolveProviderRuntime(parsed.modelId)
  const requestedContextTokenLimit = parsed.contextTokenLimit
  if (parsed.contextTokenLimit === undefined) {
    parsed.contextTokenLimit = route.contextTokenLimit
  }
  const contextTokenLimit = parsed.contextTokenLimit ?? route.contextTokenLimit
  // contextTokenLimit<=0 (providers.json 未配置 context 且客户端未下发 parameters.context)
  // 会使阈值变负 -> shouldTriggerCompaction 恒真 -> 每个工具轮都压缩。显式禁用并告警。
  const autoCompactEnabled = contextTokenLimit > 0
  if (!autoCompactEnabled) {
    logger.warn({
      conversationId: parsed.conversationId,
      modelId: parsed.modelId,
      routeContextTokenLimit: route.contextTokenLimit,
      requestedContextTokenLimit,
    }, '[AGENT] auto-compact disabled: non-positive contextTokenLimit — configure providers.json context or send parameters.context')
  }
  logger.debug({
    conversationId: parsed.conversationId,
    modelId: parsed.modelId,
    routeContextTokenLimit: route.contextTokenLimit,
    requestedContextTokenLimit,
    effectiveContextTokenLimit: contextTokenLimit,
    source: requestedContextTokenLimit !== undefined ? 'requestedModel.parameters.context' : 'route.contextTokenLimit',
  }, '[AGENT] context token limit resolved')

  const disabledToolsForRun = new Set<string>()
  if (!parsed.webFetchEnabled)
    disabledToolsForRun.add('WebFetch')
  if (!parsed.webSearchEnabled)
    disabledToolsForRun.add('WebSearch')
  if (!parsed.readLintsEnabled)
    disabledToolsForRun.add('ReadLints')

  // Resume re-encodes this turn. Ordinary continuation only probes a tool hint.
  const latestTurnBlobId = parsed.historyTurnBlobIds.at(-1)
  if (parsed.isResume && latestTurnBlobId !== undefined) {
    yield* ensureTurnBlobCached(latestTurnBlobId, run)
    yield* restoreRequiredBlobGraph(run, [{ blobId: latestTurnBlobId, kind: 'turn' }])
  }
  const previousDynamicToolCount = latestTurnBlobId !== undefined
    ? parsed.isResume
      ? readTurnBaseline(latestTurnBlobId, run.blobs).dynamicToolCount
      : yield* probeTurnDynamicToolCount(latestTurnBlobId, run)
    : undefined
  // 官方 dynamicToolProfile 缺省 all-static；显式 capability、meta-MCP 或同一
  // 会话已经启用过 dynamic profile 时继续 final。后两者覆盖不带 context 的
  // background-completion/resume 请求，避免工具集在相邻轮间来回抖动。
  const clientSupportsDynamicProfile = shouldEnableBuiltinDynamicProfile({
    clientSupportsDynamicTools: parsed.clientSupportsDynamicTools,
    mcpMetaToolEnabled: parsed.mcpMetaTool?.enabled === true,
    previousDynamicToolCount,
    isSubagent: parsed.isSubagent,
  })
  const contextualizedBuiltinTools = contextualizeSubagentTools(
    route.toolCatalog.listBuiltins(),
    parsed.customSubagents,
  )
  const modeFilteredBuiltins = route.listRuntimeTools(
    [],
    parsed.mode,
    parsed.isSubagent,
    disabledToolsForRun,
    contextualizedBuiltinTools,
  )
  const cursorPartition = partitionCursorBuiltinTools(
    modeFilteredBuiltins,
    clientSupportsDynamicProfile,
  )
  parsed.cursorDynamicTools = cursorPartition.dynamicTools
  parsed.dynamicToolCount = cursorPartition.dynamicTools.length
  const runtimeBuiltinTools = contextualizeDynamicMetaTools(
    contextualizedBuiltinTools,
    parsed.cursorDynamicTools,
  )
  for (const tool of cursorPartition.dynamicTools)
    disabledToolsForRun.add(tool.tool)

  const hasMcpDynamicNamespaces = parsed.mcpMetaTool?.enabled === true
    && parsed.mcpMetaTool.descriptors.length > 0
  const hasAnyDynamicNamespaces = hasMcpDynamicNamespaces || parsed.cursorDynamicTools.length > 0
  if (!hasAnyDynamicNamespaces) {
    disabledToolsForRun.add('GetDynamicTools')
    disabledToolsForRun.add('CallDynamicTool')
  }

  // 旧 Cursor++ turn 没写 field 5；已有历史时把 undefined 视作 rollout 前的 0，
  // 只在首个 dynamic turn 提醒一次，随后 checkpoint 会持久化真实计数。
  const effectivePreviousDynamicToolCount = previousDynamicToolCount
    ?? (parsed.historyTurnBlobIds.length > 0 ? 0 : undefined)
  parsed.dynamicToolTransitionReminder = !parsed.isBackgroundTaskCompletion
    && parsed.dynamicToolCount > 0
    && effectivePreviousDynamicToolCount === 0

  logger.info({
    conversationId: parsed.conversationId,
    transport: parsed.requestContextTransport,
    clientSupportsDynamicProfile,
    profile: parsed.cursorDynamicTools.length > 0 ? 'final' : 'all-static',
    cursorDynamicToolCount: parsed.cursorDynamicTools.length,
    cursorDynamicToolNames: parsed.cursorDynamicTools.map(tool => tool.tool),
    previousDynamicToolCount,
    effectivePreviousDynamicToolCount,
    transitionReminder: parsed.dynamicToolTransitionReminder,
  }, '[DYNAMIC-TOOLS] builtin profile resolved')

  const [systemMessage, preambleUserMessage, currentUserMessage] = buildMessages(parsed, route.promptProfile)
  const systemContent = typeof systemMessage.content === 'string' ? systemMessage.content : ''
  const preambleUserContent = typeof preambleUserMessage.content === 'string' ? preambleUserMessage.content : ''
  // currentUserMessage.content 可能是 string 或 LLMContentBlock[]（当含图片时）
  const currentUserContentRaw = currentUserMessage.content
  const currentUserText = typeof currentUserContentRaw === 'string'
    ? currentUserContentRaw
    : currentUserContentRaw
        .filter((b): b is Extract<LLMContentBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('')
  const currentUserImageCount = typeof currentUserContentRaw === 'string'
    ? 0
    : currentUserContentRaw.filter(b => b.type === 'image').length

  logger.info({
    promptProvider: route.promptProfile.provider,
    promptVariant: route.promptProfile.variant,
    promptStyle: route.promptProfile.systemPromptStyle,
    observedSystemPromptHashes: route.promptProfile.observedSystemPromptHashes,
    promptVocabulary: route.promptProfile.promptVocabulary,
    systemPromptLength: systemContent.length,
    preambleUserMessageLength: preambleUserContent.length,
    currentUserMessageLength: currentUserText.length,
    currentUserImageCount,
    hasRulesSection: preambleUserContent.includes('<rules>'),
    hasAgentSkillsSection: preambleUserContent.includes('<agent_skills>'),
    hasAgentTranscriptsSection: preambleUserContent.includes('<agent_transcripts>'),
    hasUserQuerySection: currentUserText.includes('<user_query>'),
    hasMcpSection: systemContent.includes('<mcp_file_system>'),
    hasLinterSection: systemContent.includes('<linter_errors>'),
    hasTerminalSection: systemContent.includes('<terminal_files_information>'),
  }, '[AGENT] built prompt')

  // 后台 job 注册表需要 env.terminalsFolder 构造后台 shell 的终端文件路径
  // ({terminalsFolder}/{shellId}.txt)。在 run 起始把它挂到 session,供 AwaitShell 分流时取用。
  if (session && parsed.env.terminalsFolder)
    session.terminalsFolder = parsed.env.terminalsFolder

  const readContext = {
    cursorRules: parsed.cursorRules,
    agentSkills: parsed.agentSkills,
    workspacePaths: parsed.env.workspacePaths ?? [],
    readPaths: new Set(parsed.readPaths),
  }

  // MCP 模式判定 —— 每轮一条,用来回答"这次会话到底走的哪条路"。
  // 没有它,"客户端没开 meta 模式"和"我们把工具弄丢了"在日志上长得一样。
  //
  // 内置工具侧同理: profile 一开,那批工具就从 LLM 可见表移进 cursor namespace,
  // 现象与"工具被弄丢"完全一致。故把分区结果与触发来源一并打出 ——
  // profileTrigger 三条路径行为不同(capability 来自 3.17 客户端字段、
  // mcp_meta 跟随 MCP 开关、previous_turn 是跨轮防抖),出问题要先分清是哪条。
  logger.info({
    conversationId: parsed.conversationId,
    mcpMode: parsed.mcpMetaTool?.enabled ? 'dynamic_namespace' : 'legacy_flat',
    namespaces: parsed.mcpMetaTool?.descriptors.map(d => ({
      name: d.serverIdentifier,
      tools: d.tools.length,
    })) ?? [],
    routingTableSize: parsed.mcpTools.length,
    supportsMcpAuth: parsed.supportsMcpAuth === true,
    // ── 内置工具 dynamic profile (cursor namespace) ──
    builtinDynamicProfile: clientSupportsDynamicProfile,
    profileTrigger: !clientSupportsDynamicProfile
      ? 'off'
      : parsed.clientSupportsDynamicTools
          ? 'capability'
          : parsed.mcpMetaTool?.enabled
            ? 'mcp_meta'
            : 'previous_turn',
    // staticToolCount 是模型直接可见的内置工具数;骤降说明分区把不该动的工具
    // (Shell / Read / Edit 等)划进了 dynamic,而那类故障没有其它痕迹。
    staticToolCount: cursorPartition.staticTools.length,
    dynamicToolCount: parsed.dynamicToolCount,
    cursorDynamicTools: parsed.cursorDynamicTools.map(t => t.tool),
  }, '[DYNAMIC-TOOLS] MCP mode resolved')

  let breakdownCategories: BreakdownCategory[] | undefined

  let execMessageIdCounter = 0
  let blobIds: string[] = []
  let turnBlobIds = [...parsed.historyTurnBlobIds]
  let messages: LLMMessage[] = []
  let currentSummaryArchiveIds = [...parsed.historySummaryArchiveIds]
  // 连续失败熔断 (对齐 Claude Code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3)
  // 不再用 autoSummarizePerformed 一次性限制——每轮都可重复触发,直至连续失败 3 次停止
  let autoCompactConsecutiveFailures = 0
  const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
  // 上次"有效"压缩后的估算基线; 净增长门槛的参照点 (0 = 本 run 尚未压缩过)
  let lastCompactionBaseline = 0
  // 错误驱动压缩重试计数 (≤3 轮硬封顶) 与首次压缩基准预算 (budget/2^retry 的被除数)
  let contextLengthRetryCount = 0
  let baseKeepTailBudget = 0
  let firstCompactionAt = 0
  const syntheticUserMessageId = parsed.isBackgroundTaskCompletion
    ? `background-completion-${Date.now()}`
    : parsed.rawUserMessage?.messageId && typeof parsed.rawUserMessage.messageId === 'string'
      ? parsed.rawUserMessage.messageId
      : `turn-${Date.now()}`
  let activeTurn: ActiveTurnTracker | null = null

  const sendSystemScaffoldBlob = (
    data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean },
  ): void => {
    retainMessageBlob(run.blobs, data, blobIds)
  }

  const sendOrderedBlob = (
    data: { role: string, content: unknown, toolCallId?: string, toolName?: string, isError?: boolean },
  ): void => {
    retainMessageBlob(run.blobs, data, blobIds)
  }

  const retainCurrentTurnBlob = (): string[] => {
    const turnBlob = activeTurn?.materializeTurnBlob()
    if (!turnBlob)
      return [...turnBlobIds]
    run.blobs.cacheBlob(turnBlob.blobId, turnBlob.blobData, turnBlob.blobDataRaw, turnBlob.dependencies)
    return [...turnBlobIds, turnBlob.blobId]
  }

  yield heartbeat()

  if (parsed.isBackgroundTaskCompletion) {
    const completion = parsed.backgroundTaskCompletions[0]
    logger.info({
      conversationId: parsed.conversationId,
      completionCount: parsed.backgroundTaskCompletions.length,
      completions: parsed.backgroundTaskCompletions.map(c => ({
        taskId: c.taskId,
        kind: c.kind,
        status: c.status,
        title: c.title,
        hasDetail: !!c.detail,
        detailLen: c.detail?.length ?? 0,
        hasOutputPath: !!c.outputPath,
        hasThreadId: !!c.threadId,
      })),
      simulatedUserTextLen: parsed.userText.length,
    }, '[AGENT] background task completion: appending simulated user message')
    yield userMessageAppended({
      text: parsed.userText,
      messageId: syntheticUserMessageId,
      mode: parsed.mode,
      simulatedMsgReason: SimulatedMsgReason.BACKGROUND_TASK_COMPLETION,
      simulatedMessageMetadata: completion
        ? {
            ...(completion.title ? { title: completion.title } : {}),
            ...(completion.taskId ? { taskId: completion.taskId } : {}),
          }
        : undefined,
    })
  }

  if (parsed.isResume) {
    if (turnBlobIds.length > 0) {
      const resumed = ActiveTurnTracker.fromTurnBlobId(turnBlobIds[turnBlobIds.length - 1]!, run.blobs)
      resumed.setDynamicToolCount(parsed.dynamicToolCount)
      activeTurn = resumed
      turnBlobIds = turnBlobIds.slice(0, -1)
    }
  }
  else {
    const { blob, messageId } = createCurrentTurnUserMessageBlob({
      parsed,
      fallbackMessageId: syntheticUserMessageId,
    })
    activeTurn = new ActiveTurnTracker(blob.blobId, [], messageId, parsed.dynamicToolCount)
    run.blobs.cacheBlob(blob.blobId, blob.blobData, blob.blobDataRaw, blob.dependencies)
  }

  // 历史 blob: 内存未命中的经 getBlobArgs 向客户端取 (客户端是唯一持久持有方)
  const rebuiltHistory = yield* rebuildConversationHistory({
    historyBlobIds: parsed.historyBlobIds,
    prependUserMessages: parsed.prependUserMessages,
    systemMessage,
    preambleUserMessage,
    currentUserMessage,
    systemContent,
    preambleUserContent,
    sendSystemScaffoldBlob,
    sendOrderedBlob,
    run,
  })
  messages = rebuiltHistory.messages

  for (const text of rebuiltHistory.insertedPrependUserTexts) {
    sendOrderedBlob({ role: 'user', content: text })
  }

  sendOrderedBlob({ role: 'user', content: currentUserContentRaw })
  let nextBlobbedMessageIndex = messages.length

  const userPreview = parsed.isExecutePlan && parsed.executePlanContent
    ? `[ExecutePlan] ${parsed.executePlanContent.match(/^---\s*\nname:\s*(.+)/m)?.[1]?.trim() ?? parsed.executePlanFileUri ?? 'plan'}`
    : parsed.userText.length > 80 ? `${parsed.userText.slice(0, 80)}...` : parsed.userText
  logger.info(`[AGENT] → [${route.provider.name}/${route.model}] "${userPreview}" (${messages.length} msgs)`)

  const usageTotals = emptyUsageTotals()
  // 估算来源归因: 记录 usedTokensEstimate 当前由哪把尺子顶到该值
  // ('client-inherited' = 客户端回传的 checkpoint 值 | 'chars/4' | 'provider')
  let estimateSource: 'client-inherited' | 'chars/4' | 'provider' = 'chars/4'
  const clientInheritedTokens = parsed.historyTokenDetails?.usedTokens ?? 0
  const charsInitTokens = estimateMessagesTokens(messages)
  if (clientInheritedTokens > 0 && clientInheritedTokens >= charsInitTokens)
    estimateSource = 'client-inherited'
  let usedTokensEstimate = Math.max(clientInheritedTokens, charsInitTokens)
  logger.info({
    conversationId: parsed.conversationId,
    isSubagent: parsed.isSubagent,
    historyTokenDetails: parsed.historyTokenDetails,
    routeContextTokenLimit: route.contextTokenLimit,
    contextTokenLimit,
    clientInheritedTokens,
    charsInitTokens,
    initialEstimate: usedTokensEstimate,
    estimateSource,
    autoCompactEnabled,
  }, '[AUTOCOMPACT] run start baseline')
  let lastAssistantContent: LLMContentBlock[] | undefined
  let stepCounter = 0

  for (let round = 0; ; round++) {
    // 轮次边界的中断检查 —— 上一轮工具刚跑完时客户端可能已经中断,
    // 此处拦下可避免白发一次 LLM 请求
    if (session && (isSessionCancelled(session) || session.closed)) {
      logger.info({
        conversationId: parsed.conversationId,
        round,
        reason: session.cancelledReason,
      }, '[CANCEL] run cancelled at round boundary')
      return
    }

    const pendingToolCalls: ToolCallInfo[] = []
    const inflightToolCalls = new Map<string, { name: string, input: string }>()
    const roundAssistantBlocks: LLMContentBlock[] = []
    let currentThinking = ''
    let currentText = ''

    try {
      // dynamic namespace 模式 (Cursor 3.15.6): MCP 工具**不进** LLM 可见工具表,
      // 改由 GetDynamicTools 按需发现。parsed.mcpTools 仍保持全量 —— 它是**路由表**,
      // CallDynamicTool 要靠它把 namespace + toolName 映射成 McpArgs。
      //
      // 这两张表此前是同一张,legacy 模式下恰好重合所以没暴露问题;meta 模式下
      // 客户端只发 slim 名单(仅 toolName,无 inputSchema),摊平下发等于给 LLM
      // 一堆没有参数说明的工具。见 analysis/mcp-dynamic-tools.md。
      const llmVisibleMcpTools = parsed.mcpMetaTool?.enabled ? [] : parsed.mcpTools
      const preparedRequest = route.prepareStreamRequest(messages, llmVisibleMcpTools, undefined, parsed.mode, {
        thinking: parsed.clientThinking,
        level: parsed.clientThinkingLevel,
        budget: parsed.clientThinkingBudget,
      }, parsed.conversationId, parsed.isSubagent, parsed.clientFast,
      disabledToolsForRun.size > 0 ? disabledToolsForRun : undefined,
      contextTokenLimit,
      runtimeBuiltinTools)

      if (!breakdownCategories) {
        breakdownCategories = buildContextBreakdown({
          systemContent,
          preambleUserContent,
          requestMessages: preparedRequest.request.messages,
          requestTools: preparedRequest.request.tools ?? [],
          // 路由表(全量)而非 LLM 可见表 —— legacy 模式下要靠它把扁平
          // requestTools 里的 MCP 工具认出来
          mcpToolNames: new Set(parsed.mcpTools.map(t => t.name)),
        })
      }

      logger.info({
        round,
        codec: route.conversationCodec.name,
        semanticTurns: preparedRequest.conversation.semanticTurns.map(turn => turn.kind),
        toolCatalogProvider: route.toolCatalog.provider,
        toolCatalogVariant: route.toolCatalog.variant,
        builtinsCount: route.toolCatalog.listBuiltins().length,
        runtimeToolsCount: preparedRequest.request.tools?.length ?? 0,
        // 路由表规模 vs 实际下发给 LLM 的规模 — meta 模式下后者恒为 0
        mcpToolsCount: parsed.mcpTools.length,
        mcpToolNames: parsed.mcpTools.map(t => t.name),
        mcpMetaToolEnabled: parsed.mcpMetaTool?.enabled === true,
        llmVisibleMcpToolsCount: llmVisibleMcpTools.length,
      }, '[AGENT] prepared provider conversation')

      throwIfBlobRunInactive(run)
      const translatedFrames = translateStream(signal => route.provider.stream({ ...preparedRequest.request, signal }), String(++stepCounter), (event) => {
        switch (event.type) {
          case 'thinking_delta':
            currentThinking += event.text
            break
          case 'thinking_done':
            // 即使 currentThinking 为空也要保存 — DeepSeek 要求空 reasoning_content 原样回传
            roundAssistantBlocks.push({ type: 'thinking', text: currentThinking, signature: event.signature, sourceModel: `${route.promptProfile.provider}:${route.model}` })
            currentThinking = ''
            break
          case 'text_delta':
            currentText += event.text
            break
          case 'tool_use_start': {
            ({ currentThinking, currentText } = flushPendingAssistantPrefix({
              roundAssistantBlocks,
              currentThinking,
              currentText,
            }))
            inflightToolCalls.set(event.id, { name: event.name, input: '' })
            if (EDIT_TOOL_NAMES.has(event.name)) {
              editExtractors.set(event.id, new EditDeltaExtractor(event.name))
              editStreamDiagnostics.set(event.id, { deltaCount: 0, streamContent: '' })
              logger.debug({ callId: event.id, tool: event.name }, '[EDIT_T] 1.tool_use_start → extractor created')
            }
            break
          }
          case 'tool_use_delta': {
            const current = inflightToolCalls.get(event.id) ?? { name: '', input: '' }
            const accumulatedInput = current.input + event.input
            inflightToolCalls.set(event.id, { ...current, input: accumulatedInput })
            const extractor = editExtractors.get(event.id)
            if (extractor) {
              const content = extractor.feed(event.input)
              const mcid = `${parsed.conversationId}-${round}-${event.id.slice(-4)}`
              const frames: AgentServerMessage[] = []
              if (extractor.detectedPath && !editPathSent.has(event.id)) {
                editPathSent.add(event.id)
                const normalizedPath = normalizeDetectedEditPath(extractor.detectedPath)
                frames.push(partialToolCall(event.id, 'editToolCall', mcid, { path: normalizedPath }))
                logger.debug({ callId: event.id, path: normalizedPath, rawPath: extractor.detectedPath, mcid }, '[EDIT_T] 2.partialToolCall{path}')
                const streamDiag = editStreamDiagnostics.get(event.id)
                logger.debug({
                  callId: event.id,
                  tool: current.name,
                  path: normalizedPath,
                  rawPath: extractor.detectedPath,
                  streamedBeforePath: streamDiag ? {
                    deltaCount: streamDiag.deltaCount,
                    streamContent: editNewlineStats(streamDiag.streamContent),
                  } : undefined,
                  currentDelta: editNewlineStats(event.input),
                  accumulatedInput: editNewlineStats(accumulatedInput),
                  mcid,
                }, '[EDIT_NL] edit path detected during stream')
              }
              if (content) {
                const streamDiag = editStreamDiagnostics.get(event.id)
                if (streamDiag) {
                  streamDiag.deltaCount++
                  streamDiag.streamContent += content
                }
                frames.push(editToolCallStreamDelta(event.id, content, mcid))
                logger.debug({ callId: event.id, contentLen: content.length, hasPath: editPathSent.has(event.id), mcid }, '[EDIT_T] 3.editToolCallDelta')
              }
              if (frames.length > 0) return frames.length === 1 ? frames[0] : frames
            }
            break
          }
          case 'tool_use_done': {
            editExtractors.delete(event.id)
            const pathWasSent = editPathSent.has(event.id)
            const streamDiag = editStreamDiagnostics.get(event.id)
            const current = inflightToolCalls.get(event.id)
            if (current) {
              // 权威参数: done 事件携带的完整 arguments > delta 累积
              const rawArgs = event.arguments ?? current.input ?? ''
              let input: Record<string, unknown> = {}
              try { input = JSON.parse(rawArgs) } catch {}
              if (EDIT_TOOL_NAMES.has(current.name)) {
                logger.debug({
                  callId: event.id,
                  tool: current.name,
                  pathWasSentDuringStream: pathWasSent,
                  rawArgs: editNewlineStats(rawArgs),
                  targetFields: editToolTargetStats(current.name, input),
                  streamedContent: streamDiag ? {
                    deltaCount: streamDiag.deltaCount,
                    stats: editNewlineStats(streamDiag.streamContent),
                    suspicious: {
                      hasCrCrLf: /\r\r\n/.test(streamDiag.streamContent),
                      mixedLineEndings: editNewlineStats(streamDiag.streamContent).mixed,
                      hasLargeBlankRun: editNewlineStats(streamDiag.streamContent).maxConsecutiveBlankLines >= 3,
                    },
                  } : undefined,
                }, '[EDIT_NL] final edit tool arguments newline diagnostics')
              }
              pendingToolCalls.push({ callId: event.id, name: current.name, input })
              roundAssistantBlocks.push({ type: 'tool_use', id: event.id, name: current.name, input })
              inflightToolCalls.delete(event.id)
              editPathSent.delete(event.id)
              editStreamDiagnostics.delete(event.id)
            }
            else {
              editPathSent.delete(event.id)
              editStreamDiagnostics.delete(event.id)
            }
            break
          }
          case 'done': {
            ({ currentThinking, currentText } = flushPendingAssistantPrefix({
              roundAssistantBlocks,
              currentThinking,
              currentText,
            }))
            Object.assign(usageTotals, addUsage(usageTotals, event.usage))
            const estimateBefore = usedTokensEstimate
            const providerEstimate = estimateContextTokens(event.usage)
            if (providerEstimate > usedTokensEstimate)
              estimateSource = 'provider'
            usedTokensEstimate = Math.max(usedTokensEstimate, providerEstimate)
            // 尺子差观测点: inputTokens(全量,含脚手架) 与 chars/4(仅对话消息) 的差
            // 即"脚手架 + tokenizer 偏差"的实测值, 用于校准压缩重置的自校准补偿
            const charsEstimate = estimateMessagesTokens(messages)
            logger.info({
              conversationId: parsed.conversationId,
              round,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
              providerEstimate,
              charsEstimate,
              scaffoldDelta: Math.max(0, (event.usage.inputTokens ?? 0) - charsEstimate),
              estimateBefore,
              estimateAfter: usedTokensEstimate,
              estimateSource,
            }, '[AUTOCOMPACT] provider usage latch')
            break
          }
        }
      }, undefined, (event) => {
        if (event.type === 'tool_use_start')
          return `${parsed.conversationId}-${round}-${event.id.slice(-4)}`
      }, run.signal)

      for await (const frame of translatedFrames) {
        // LLM 流是一轮里最长的一段停留,中断多半落在这里。逐帧检查把中断
        // 粒度收敛到单个事件 (thinking_delta 级,毫秒量级)。抛出后由下方
        // catch 的 isAgentRunAbortedError 分支干净收尾,半截的
        // roundAssistantBlocks 一并丢弃,不污染历史。
        throwIfBlobRunInactive(run)
        yield frame
      }
    }
    catch (e) {
      if (run.signal.aborted && e instanceof Error && e.name === 'AbortError')
        throw e
      // 客户端主动中断不是错误 —— 必须先于 makeProviderError 拦下,
      // 否则会被包成 ErrorDetails,在客户端渲染出一条 retry banner:
      // 用户只是发了新消息抢占当前生成,却看到"上一条失败了"。
      if (isAgentRunAbortedError(e)) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          reason: session?.cancelledReason,
        }, '[CANCEL] LLM stream aborted by client')
        return
      }
      if (isRunStateError(e))
        throw e

      // 错误驱动压缩重试 (设计文档 §4 运行时层, 官方 CC-001/017):
      // provider 报 context-length 类错误 → aggressive 压缩 (预算 /2^retry)
      // → 重发本轮请求, ≤3 轮硬封顶; 非白名单错误走现状路径。
      if (autoCompactEnabled && isContextLengthLimitError(e) && contextLengthRetryCount < CONTEXT_LENGTH_RETRY_MAX) {
        contextLengthRetryCount += 1
        // aggressive 预算: 基准预算 / 2^retry (未压缩过时按 targetFloor 估计基准)
        const effectiveBaseBudget = baseKeepTailBudget > 0
          ? baseKeepTailBudget
          : Math.floor(0.25 * contextTokenLimit)
        const aggressiveBudget = Math.max(1, Math.floor(effectiveBaseBudget / 2 ** contextLengthRetryCount))
        logger.warn({
          conversationId: parsed.conversationId,
          round,
          retry: contextLengthRetryCount,
          maxRetries: CONTEXT_LENGTH_RETRY_MAX,
          aggressiveBudget,
          error: (e as Error).message,
        }, '[AUTOCOMPACT] context-length error — retrying with aggressive compaction')
        let retryCompactionResult = yield* performInlineAutoSummarize({
          run,
          parsed,
          allBlobIds: [...parsed.historyBlobIds, ...blobIds],
          turnBlobIds: retainCurrentTurnBlob(),
          summaryArchiveIds: currentSummaryArchiveIds,
          usedTokensEstimate,
          contextTokenLimit,
          messages,
          route,
          readPaths: [...readContext.readPaths],
          budgetOverride: aggressiveBudget,
        })
        if (retryCompactionResult === 'lock-held') {
          // 上下文已爆窗, 唯一出路是压缩 — 学官方 WaitForCompletion 形态纯等
          // 持锁压缩完成 (无 deadline; 持锁者有界性由 idle 超时 + 兜底梯子保证),
          // 心跳保 SSE 活性, 释放后用本 run 视图重压一次
          logger.warn({
            conversationId: parsed.conversationId,
            round,
            retry: contextLengthRetryCount,
          }, '[AUTOCOMPACT] context-length retry blocked by in-flight compaction — waiting for lock release')
          while (isCompactionLockHeld(parsed.conversationId))
            yield* waitForRunCompactionLockRelease(parsed.conversationId, run)
          const secondAttempt = yield* performInlineAutoSummarize({
            run,
            parsed,
            allBlobIds: [...parsed.historyBlobIds, ...blobIds],
            turnBlobIds: retainCurrentTurnBlob(),
            summaryArchiveIds: currentSummaryArchiveIds,
            usedTokensEstimate,
            contextTokenLimit,
            messages,
            route,
            readPaths: [...readContext.readPaths],
            budgetOverride: aggressiveBudget,
          })
          retryCompactionResult = secondAttempt === 'lock-held' ? null : secondAttempt
        }
        // 至此 'lock-held' 已被上方分支消解 (TS 控制流可证), 仅剩成功对象或 null
        if (retryCompactionResult !== null) {
          messages = retryCompactionResult.newMessages
          parsed.historyBlobIds = retryCompactionResult.newBlobIds
          currentSummaryArchiveIds = retryCompactionResult.newSummaryArchiveIds
          usedTokensEstimate = retryCompactionResult.newUsedTokens
          blobIds = []
          execMessageIdCounter = 0
          nextBlobbedMessageIndex = messages.length
          lastCompactionBaseline = usedTokensEstimate
          round-- // 重发本轮请求: for-loop 递增后回到同一 round
          continue
        }
      }

      // 关键: 不再往对话流 yield textDelta('[BYOK Error] ...') —— 那会让错误文本
      // 伪装成 assistant 的"正常回复", 同时被写进 roundAssistantBlocks 污染历史,
      // 下一轮 LLM 会看到自己刚刚回复了 [BYOK Error] 导致状态错乱。
      //
      // 现在直接抛 ConnectError, 让 AgentService.runSSE 的顶层 catch 把 error
      // 序列化到 SSE trailer。客户端 @connectrpc 解包 aiserver.v1.ErrorDetails
      // 后, composer.maybeThrowErrorAndRetry 会写入 ComposerData.submitErrorDetails,
      // Glass Composer 的 Lzv 组件渲染成 input 正上方的 retry banner。
      logger.error({ error: (e as Error).message, stack: (e as Error).stack }, '[LLM] stream error')
      throw makeProviderError(e, {
        conversationId: parsed.conversationId,
        modelId: parsed.modelId,
        round: String(round),
      })
    }

    if (pendingToolCalls.length === 0) {
      const transition = route.transitionRound(messages, roundAssistantBlocks)
      if (transition.assistantAdded) {
        lastAssistantContent = roundAssistantBlocks
        const turnBlobs = recordAssistantBlocksIntoTurn(activeTurn, roundAssistantBlocks)
        for (const blob of turnBlobs)
          run.blobs.cacheBlob(blob.blobId, blob.blobData, blob.blobDataRaw, blob.dependencies)
      }
      break
    }

    logger.info({ round, toolCalls: pendingToolCalls.map(t => t.name) }, '[AGENT] processing tool calls')
    let flushedToolResults = 0
    try {
      const assistantContent = roundAssistantBlocks
      lastAssistantContent = assistantContent
      const turnBlobs = recordAssistantBlocksIntoTurn(activeTurn, assistantContent)
      for (const blob of turnBlobs)
        run.blobs.cacheBlob(blob.blobId, blob.blobData, blob.blobDataRaw, blob.dependencies)

      const roundContext = route.createRoundContext()
      const roundImageBlocks: LLMContentBlock[] = []

      // ── Phase 1: 批量发送 Task tool 的 started + exec（不等待结果） ──
      const taskLaunches: TaskLaunchContext[] = []
      const nonTaskCalls: typeof pendingToolCalls = []
      for (const tc of pendingToolCalls) {
        // dynamic profile 下 Task 落在 cursor namespace,LLM 侧名字是
        // CallDynamicTool,真实身份藏在 arguments 里。按 tc.name 分流会让
        // Task 掉进 Phase 2 串行路径,丢掉并发启动与 subagent 模型解析。
        const executionToolName = resolveExecutionToolName(tc.name, tc.input, parsed.cursorDynamicTools)
        if ((executionToolName === 'Task' || executionToolName === 'Subagent') && session) {
          const ctx = yield* launchTaskTool({
            toolCall: tc,
            availableMcpTools: parsed.mcpTools,
            conversationId: parsed.conversationId,
            currentModelId: parsed.modelId,
            subagentModelOverrides: parsed.subagentModelOverrides,
            round,
            allocateExecMessageId: () => ++execMessageIdCounter,
            cursorDynamicTools: parsed.cursorDynamicTools,
            contextTokenLimit,
          })
          if (ctx)
            taskLaunches.push(ctx)
        }
        else {
          nonTaskCalls.push(tc)
        }
      }

      if (taskLaunches.length > 1)
        logger.info({ count: taskLaunches.length, callIds: taskLaunches.map(t => t.tc.callId) }, '[AGENT] task tools launched concurrently')

      // ── Phase 2: 串行执行非 Task 工具（edit, shell, glob 等） ──
      for (const tc of nonTaskCalls) {
        const toolFrames = runToolCall({
          toolCall: tc,
          availableMcpTools: parsed.mcpTools,
          conversationId: parsed.conversationId,
          currentModelId: parsed.modelId,
          subagentModelOverrides: parsed.subagentModelOverrides,
          round,
          session,
          roundContext,
          messages,
          allocateExecMessageId: () => ++execMessageIdCounter,
          allocateInteractionId: () => run.allocateInteractionId(),
          imageCollector: roundImageBlocks,
          readContext,
          // GetDynamicTools 需要据此决定取哪些 server、是否补 mcp_auth
          mcpMetaTool: parsed.mcpMetaTool,
          supportsMcpAuth: parsed.supportsMcpAuth,
          cursorDynamicTools: parsed.cursorDynamicTools,
          projectDir: parsed.env.projectFolder ?? parsed.env.workspacePaths?.[0],
          contextTokenLimit,
        })
        for await (const frame of toolFrames) {
          const completedToolCall = extractCompletedToolCall(frame)
          if (activeTurn && completedToolCall) {
            const toolBlob = activeTurn.addCompletedToolCall(completedToolCall)
            run.blobs.cacheBlob(toolBlob.blobId, toolBlob.blobData, toolBlob.blobDataRaw, toolBlob.dependencies)
          }
          yield frame
        }
      }

      // ── Phase 3: 并发等待所有 Task 结果 ──
      if (taskLaunches.length > 0 && session) {
        const resultPromises = taskLaunches.map(ctx =>
          awaitExecResultAndClose(session, ctx.execMessageId),
        )
        const results = yield* waitForPromiseWithHeartbeat(Promise.all(resultPromises))
        for (let i = 0; i < taskLaunches.length; i++) {
          const frame = finalizeTaskResult(taskLaunches[i], results[i], roundContext, messages, session)
          const completedToolCall = extractCompletedToolCall(frame)
          if (activeTurn && completedToolCall) {
            const toolBlob = activeTurn.addCompletedToolCall(completedToolCall)
            run.blobs.cacheBlob(toolBlob.blobId, toolBlob.blobData, toolBlob.blobDataRaw, toolBlob.dependencies)
          }
          yield frame
        }
      }

      // SwitchMode 成功后立即切换 mode,让下一轮 LLM 用新工具集
      // (例如 Agent→Plan 切换后 CreatePlan 工具才会出现在列表里)
      for (const tr of roundContext.pendingToolResults) {
        if (!tr.isError && tr.content.includes('toModeId')) {
          try {
            const parsed_result = JSON.parse(tr.content)
            const toMode = parsed_result?.toModeId as string | undefined
            if (toMode) {
              const newMode = `AGENT_MODE_${toMode.toUpperCase()}`
              logger.info({ from: parsed.mode, to: newMode }, '[AGENT] mode switched mid-session')
              parsed.mode = newMode
            }
          }
          catch {}
        }
      }

      if (roundContext.pendingToolResults.length > 0) {
        logger.info({
          round,
          stateStrategy: route.stateStrategy.name,
          toolResults: roundContext.pendingToolResults.map(block => ({
            toolUseId: block.toolUseId,
            isError: !!block.isError,
            contentLen: block.content.length,
          })),
        }, '[AGENT] tool results pending provider-state flush')
      }
      const transition = roundContext.transition(messages, assistantContent)
      flushedToolResults = transition.flushedToolResults;

      if (roundImageBlocks.length > 0) {
        messages.push({ role: 'user', content: roundImageBlocks })
        logger.info({ count: roundImageBlocks.length }, '[AGENT] injected image blocks from Read tool results')
      }

      ({ nextIndex: nextBlobbedMessageIndex } = retainMessageBlobs(
        run.blobs,
        messages,
        nextBlobbedMessageIndex,
        blobIds,
      ))

      const charsLatch = estimateMessagesTokens(messages)
      if (charsLatch > usedTokensEstimate)
        estimateSource = 'chars/4'
      usedTokensEstimate = Math.max(usedTokensEstimate, charsLatch)

      const allBlobIdsForCheckpoint = [...parsed.historyBlobIds, ...blobIds]
      const checkpointTurnBlobIds = retainCurrentTurnBlob()
      yield* emitRollingCheckpoint({
        run,
        conversationId: parsed.conversationId,
        round,
        nextBlobbedMessageIndex,
        allBlobIds: allBlobIdsForCheckpoint,
        turnBlobIds: checkpointTurnBlobIds,
        summaryArchiveIds: currentSummaryArchiveIds,
        usedTokensEstimate,
        contextTokenLimit,
        mode: parsed.mode,
        lastAssistantContent,
        usageTotals,
        workspaceUris: workspaceUris(parsed),
        modelName: route.model,
        readPaths: [...readContext.readPaths],
        gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
        breakdownCategories,
      })

      // 链路①: 服务端 Agent Run 内自动 summarize
      // 每轮都检查——超阈值就触发 compaction,可重复触发,连续失败 3 次才熔断
      // (对齐 Claude Code autoCompactIfNeeded 的 consecutiveFailures 熔断机制)
      //
      // 两道防抖 (诊断报告 §8.1):
      //   1. 净增长门槛: 距上次有效压缩基线的净增长 >= 15K 才允许再次触发,
      //      打断"压缩后 provider usage 立刻反弹 -> 读一个文件就再压"的锯齿循环;
      //   2. 硬安全线: 距窗口上限不足 8K 时无视门槛立即压缩,不为等门槛撑爆窗口。
      const autoCompactThreshold = getAutoCompactThreshold(contextTokenLimit)
      const overThreshold = autoCompactEnabled
        && shouldTriggerCompaction(usedTokensEstimate, contextTokenLimit)
      const netGrowthSinceCompaction = usedTokensEstimate - lastCompactionBaseline
      const netGrowthOk = netGrowthSinceCompaction >= AUTOCOMPACT_NET_GROWTH_MIN_TOKENS
      const hardPressure = usedTokensEstimate >= contextTokenLimit - Math.min(contextTokenLimit, 8192)
      if (overThreshold && !netGrowthOk && !hardPressure) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          usedTokensEstimate,
          threshold: autoCompactThreshold,
          lastCompactionBaseline,
          netGrowthSinceCompaction,
          netGrowthMin: AUTOCOMPACT_NET_GROWTH_MIN_TOKENS,
          estimateSource,
        }, '[AGENT] auto-summarize: net-growth gate holds, skipping compaction')
      } else if (overThreshold && autoCompactConsecutiveFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          usedTokensEstimate,
          contextTokenLimit,
          threshold: autoCompactThreshold,
          maxOutputTokens: route.maxOutputTokens,
          estimateSource,
          hardPressure,
          consecutiveFailures: autoCompactConsecutiveFailures,
        }, '[AGENT] auto-summarize: threshold exceeded, triggering inline compaction')

        const compactionResult = yield* performInlineAutoSummarize({
          run,
          parsed,
          allBlobIds: allBlobIdsForCheckpoint,
          turnBlobIds: checkpointTurnBlobIds,
          summaryArchiveIds: currentSummaryArchiveIds,
          usedTokensEstimate,
          contextTokenLimit,
          messages,
          route,
          readPaths: [...readContext.readPaths],
        })

        if (compactionResult === 'lock-held') {
          // F5: 另一路压缩在飞行中 — 跳过本轮但不计失败 (熔断只留给真实压缩失败)
          logger.info({
            conversationId: parsed.conversationId,
            round,
            contentionCount: getCompactionContentionCount(parsed.conversationId),
          }, '[AGENT] auto-summarize: concurrent compaction in flight — round skipped, failure fuse untouched')
        } else if (compactionResult) {
          // 用 compacted 后的状态替换当前状态，继续后续 round
          messages = compactionResult.newMessages
          parsed.historyBlobIds = compactionResult.newBlobIds
          currentSummaryArchiveIds = compactionResult.newSummaryArchiveIds
          usedTokensEstimate = compactionResult.newUsedTokens
          // 重置 blob 追踪：compaction 后 blobIds 都已合并到 parsed.historyBlobIds
          blobIds = []
          execMessageIdCounter = 0
          nextBlobbedMessageIndex = messages.length

          // 首次压缩时间戳观测 (压缩间隔 p50/p95 的输入, 事故签名 4-5 分钟/次)
          if (firstCompactionAt === 0) {
            firstCompactionAt = Date.now()
          }
          else {
            logger.info({
              conversationId: parsed.conversationId,
              sinceFirstCompactionMs: Date.now() - firstCompactionAt,
            }, '[AUTOCOMPACT] compaction interval sample')
          }
          // 记录基准预算 (错误驱动重试的 budget/2^retry 被除数)
          if (compactionResult.baseBudgetTokens > 0)
            baseKeepTailBudget = compactionResult.baseBudgetTokens

          // 压缩后仍超线 = 无效压缩 (keepTail 巨物压不动), 计入熔断而非清零,
          // 否则"每轮都成功压缩却永远降不到线下"的循环没有任何刹车
          if (usedTokensEstimate >= autoCompactThreshold) {
            autoCompactConsecutiveFailures++
            lastCompactionBaseline = usedTokensEstimate
            logger.warn({
              conversationId: parsed.conversationId,
              newUsedTokens: usedTokensEstimate,
              threshold: autoCompactThreshold,
              consecutiveFailures: autoCompactConsecutiveFailures,
            }, '[AGENT] auto-summarize: compaction ineffective (still above threshold), counting toward fuse')
          } else {
            autoCompactConsecutiveFailures = 0 // 有效压缩,成功后重置
            lastCompactionBaseline = usedTokensEstimate
          }

          logger.info({
            conversationId: parsed.conversationId,
            newMessageCount: messages.length,
            newUsedTokens: usedTokensEstimate,
            threshold: autoCompactThreshold,
            gapToThreshold: autoCompactThreshold - usedTokensEstimate,
            lastCompactionBaseline,
          }, '[AGENT] auto-summarize: state replaced, continuing agent loop')
        } else {
          autoCompactConsecutiveFailures++
          logger.warn({
            conversationId: parsed.conversationId,
            consecutiveFailures: autoCompactConsecutiveFailures,
            maxFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          }, '[AGENT] auto-summarize: compaction failed, incrementing failure counter')
        }
      }
    }
    catch (e) {
      if (run.signal.aborted && e instanceof Error && e.name === 'AbortError')
        throw e
      if (isAgentRunAbortedError(e)) {
        logger.info({
          conversationId: parsed.conversationId,
          round,
          execMessageId: e.execMessageId,
          error: e.message,
        }, '[AGENT] tool call wait aborted by client; ending current run')
        return
      }

      // Tool call 抛错 (非用户 abort) —— 同样改为 throw ConnectError, 不再伪装
      // 成正常消息写入对话流。当前 round 的 roundAssistantBlocks 里可能含有
      // 半构造的 tool_use block, 我们让它和 error 一起丢弃, 保证客户端点 retry
      // 后从干净状态重发最后一条 human bubble。
      logger.error({ error: (e as Error).message, stack: (e as Error).stack }, '[AGENT] tool call processing error')
      if (isRunStateError(e))
        throw e
      throw makeToolError(e)
    }

    logger.info({ round: round + 1, messages: messages.length, flushedToolResults }, '[AGENT] continuing LLM with tool results')
  }

  ({ nextIndex: nextBlobbedMessageIndex } = retainMessageBlobs(
    run.blobs,
    messages,
    nextBlobbedMessageIndex,
    blobIds,
  ))

  const finalCharsLatch = estimateMessagesTokens(messages)
  if (finalCharsLatch > usedTokensEstimate)
    estimateSource = 'chars/4'
  usedTokensEstimate = Math.max(usedTokensEstimate, finalCharsLatch)

  yield* emitFinalCheckpoint({
    run,
    conversationId: parsed.conversationId,
    allBlobIds: [...parsed.historyBlobIds, ...blobIds],
    turnBlobIds: retainCurrentTurnBlob(),
    summaryArchiveIds: currentSummaryArchiveIds,
    usedTokensEstimate,
    contextTokenLimit,
    mode: parsed.mode,
    lastAssistantContent,
    usageTotals,
    workspaceUris: workspaceUris(parsed),
    modelName: route.model,
    readPaths: [...readContext.readPaths],
    gitRepos: parsed.gitRepos?.map(r => ({ path: r.path, branchName: r.branchName })),
    breakdownCategories,
  })

  // All staged blobs were acknowledged before the final checkpoint was published.
  throwIfBlobRunInactive(run)
  yield heartbeat()
}
