import type { ParsedRunRequest } from './types'

/** XML 转义:preamble / system prompt 中用作 attribute 和 inner text */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** runRequest 缺失或形态异常时的默认 parsed 值 */
export function emptyParsed(): ParsedRunRequest {
  return {
    userText: '',
    modelId: '',
    conversationId: '',
    requestContextTransport: 'legacy',
    clientSupportsDynamicTools: false,
    cursorDynamicTools: [],
    dynamicToolCount: 0,
    dynamicToolTransitionReminder: false,
    mode: '',
    isSummarize: false,
    isSubagent: false,
    isBackgroundTaskCompletion: false,
    backgroundTaskCompletions: [],
    userRules: [],
    alwaysRules: [],
    projectRules: [],
    cursorRules: [],
    agentSkills: [],
    customSubagents: [],
    disabledTeamRules: [],
    env: {},
    mcpServers: [],
    mcpBasePath: '',
    mcpTools: [],
    mcpInstructions: [],
    ideState: undefined,
    documentations: [],
    cursorCommands: [],
    selectedSkills: [],
    selectedCursorRules: [],
    extraContextEntries: [],
    codeSelections: [],
    terminalSelections: [],
    fileContents: {},
    projectLayouts: [],
    externalLinks: [],
    selectedSubagents: [],
    selectedBrowsers: [],
    recentAgentsContext: [],
    webSearchEnabled: false,
    webFetchEnabled: false,
    readLintsEnabled: false,
    readPaths: [],
    historyBlobIds: [],
    historyTurnBlobIds: [],
    historySummaryArchiveIds: [],
    historyTokenDetails: undefined,
    rawUserMessage: undefined,
    selectedImages: [],
    prependUserMessages: [],
    isResume: false,
    interruptedResolutions: [],
    isExecutePlan: false,
    isGitRepo: false,
    conversationNotesListing: '',
    sharedNotesListing: '',
    subagentModelOverrides: [],
  }
}

/**
 * requestContext.env.workspacePaths 是 fsPath 字符串，不是真实 workspace URI。
 *
 * Cursor checkpoint.previousWorkspaceUris 仍期望 URI-ish 值；这里仅为该兼容位
 * 合成 file:// 前缀字符串。不要把返回值当作真实 URI，更不要用于 remote/path 语义判断。
 */
export function workspaceUris(parsed: ParsedRunRequest): string[] {
  return (parsed.env.workspacePaths ?? [])
    .filter(p => p.length > 0)
    .map(p => `file://${p}`)
}

/**
 * 归一 proto `bytes` 字段。
 *
 * proto 里声明为 bytes 的字段,到达服务端时未必是 Uint8Array —— 走 JSON 编码的
 * 路径 (RunSSE / BidiAppend 降级) 会把它变成 base64 字符串。只用 instanceof
 * 判断会静默丢数据,且现象具有极强的误导性:
 *
 *   实测 1-ClaudeCodeRev.log (2026-08-25):
 *     - requestContextParts.mcps_blob_id 过不了 instanceof → blob 从未取回
 *     - GetBlobResult.blob_data 过不了 instanceof → 报 "fetch returned no data",
 *       而客户端其实正常返回了数据
 *   两处叠加导致 MCP 整体退化成 legacy_flat + 空工具表。
 *
 * 凡是读 proto bytes 字段的地方都应走这里,不要各自写 instanceof。
 */
export function toBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array)
    return raw.length > 0 ? raw : undefined
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const buf = Buffer.from(raw, 'base64')
      return buf.length > 0 ? new Uint8Array(buf) : undefined
    }
    catch {
      return undefined
    }
  }
  return undefined
}
