import type { StartServerOptions } from './server'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { bumpRefreshSignal, pushRoutesUpdate, startServer, stopServer } from './server'
import { getServerConfig } from './server/config'
import { getLogsDir, getProvidersFilePath, getSessionLogFilePath } from './server/config/paths'
import { ensureProvidersFile, onProvidersChange, startProvidersWatcher, stopProvidersWatcher } from './server/config/providersStore'
import { ensureRoutesFile, onRoutesChange, startRoutesWatcher, stopRoutesWatcher, toggleByokMode } from './server/config/routesStore'
import { isLikelyWindowsMsvcMissing, preflightSupermarkdown, setSupermarkdownNativeErrorNotifier } from './server/handlers/agent/supermarkdown'
import { resetProviderInstanceCache } from './server/handlers/llm/providerRuntime'
import { initLogger } from './server/logger'
import { getRoutesFilePath } from './server/routes'
import { renderDashboardPageHtml } from './ui/dashboard/pageChrome'
import { PanelProvider } from './ui/panel-provider'
import { getState, onStateChange, probeByokServer, refreshState, setFileLogState } from './ui/state'
import { openUsageDashboard } from './ui/usage-dashboard'
import { startUpdateCheck, stopUpdateCheck } from './update-check'

let outputChannel: vscode.LogOutputChannel
let statusBarItem: vscode.StatusBarItem

// 扩展安装根 — activate() 时记录一次, 供 doStartServer 构造浏览器版 Dashboard
// 的资源路径 (dist/dashboard.js)。doStartServer 的调用方 (toggleServer /
// attemptTakeover) 拿不到 context, 模块级 set-once 是最小传参调整;
// activationEvents: "*" 保证任何 server 启动前 activate 已先执行。
let extensionAssetsBasePath: string | null = null

// 窗口标识 — 从 VSCODE_PROCESS_TITLE 的 [N-M] 提取, 提前声明供 initLogFilePath 读取
let myWindowId: number | null = null

type SseLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
interface SseLogEntry { level: SseLogLevel, msg: string }

// ── File Logger ──────────────────────────────────────────────────
//
// Per-window 日志文件: 每个 Cursor 窗口实例写自己独立的文件,
// 避免多实例并发写冲突。开关状态存 globalState (per-instance debug 偏好,
// 不应跨实例同步)。
//
// 文件路径: ~/.ccursor/logs/${windowId}-${workspace}.log
// 懒初始化: 只在首次写入时创建 writeStream 和 logs 目录
//
const GLOBAL_STATE_FILE_LOG_KEY = 'cursor2plus.fileLogEnabled'

let fileLogEnabled = false
let logFilePath = ''
let logFileStream: NodeJS.WritableStream | null = null

function initLogFilePath(context: vscode.ExtensionContext): void {
  const wid = myWindowId ?? 0
  const workspace = vscode.workspace.name || 'no-workspace'
  logFilePath = getSessionLogFilePath(wid, workspace)
  fileLogEnabled = context.globalState.get<boolean>(GLOBAL_STATE_FILE_LOG_KEY, false)
}

function ensureLogFileStream(): NodeJS.WritableStream | null {
  if (logFileStream)
    return logFileStream
  try {
    const dir = getLogsDir()
    if (!existsSync(dir))
      mkdirSync(dir, { recursive: true })
    logFileStream = createWriteStream(logFilePath, { flags: 'a' })
    return logFileStream
  }
  catch (err) {
    outputChannel.error(`[SRV] file log init failed: ${(err as Error).message}`)
    return null
  }
}

function closeLogFileStream(): void {
  if (logFileStream) {
    try {
      logFileStream.end()
    }
    catch {}
    logFileStream = null
  }
}

function formatFileLogLine(entry: SseLogEntry): string {
  const ts = new Date().toISOString()
  return `${ts} [${entry.level}] ${entry.msg}\n`
}

/** 单一写入入口 — 所有 log 都走这里, 保证 Output Channel 和文件同步 */
function writeToChannel(entry: SseLogEntry) {
  switch (entry.level) {
    case 'trace':
      outputChannel.trace(entry.msg)
      break
    case 'debug':
      outputChannel.debug(entry.msg)
      break
    case 'info':
      outputChannel.info(entry.msg)
      break
    case 'warn':
      outputChannel.warn(entry.msg)
      break
    case 'error':
      outputChannel.error(entry.msg)
      break
  }

  if (fileLogEnabled) {
    const stream = ensureLogFileStream()
    if (stream) {
      try {
        stream.write(formatFileLogLine(entry))
      }
      catch {}
    }
  }
}

/** 语义化包装: 替代直接 outputChannel.info/warn/error 调用, 走统一文件写入 */
function log(level: SseLogLevel, msg: string): void {
  writeToChannel({ level, msg })
}

function showPortOccupiedMessage(port: number): void {
  const text = `Cursor++ Server cannot start because port ${port} is already used by another process. Close the process using this port, then restart Cursor.`
  log('error', `[SRV] ${text}`)
  vscode.window.showErrorMessage(text)
}

let supermarkdownTipShown = false

function setupSupermarkdownNativeTip(): void {
  setSupermarkdownNativeErrorNotifier((error) => {
    if (supermarkdownTipShown || !isLikelyWindowsMsvcMissing(error))
      return
    supermarkdownTipShown = true
    log('warn', `[WEB] supermarkdown native module failed to load: ${error.message}`)
    vscode.window.showWarningMessage(
      'Cursor++ Web Fetch requires Microsoft Visual C++ Redistributable 2015-2022 x64. Install it, then restart Cursor.',
      'Download MSVC Runtime',
    ).then((choice) => {
      if (choice === 'Download MSVC Runtime')
        vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/vs/17/release/vc_redist.x64.exe'))
    })
  })
}

/** 切换文件日志开关, 落盘到 globalState, 同步到 state (UI 显示) */
async function toggleFileLog(context: vscode.ExtensionContext): Promise<void> {
  fileLogEnabled = !fileLogEnabled
  await context.globalState.update(GLOBAL_STATE_FILE_LOG_KEY, fileLogEnabled)

  if (fileLogEnabled) {
    const stream = ensureLogFileStream()
    if (stream) {
      log('info', `[SRV] file logging ENABLED → ${logFilePath}`)
      vscode.window.showInformationMessage(`Cursor++ file logging enabled → ${logFilePath}`)
    }
  }
  else {
    log('info', '[SRV] file logging DISABLED')
    closeLogFileStream()
  }

  setFileLogState(fileLogEnabled, logFilePath)
}

/** 在 VS Code 里打开当前实例的日志文件 */
async function openLogFile(): Promise<void> {
  if (!logFilePath || !existsSync(logFilePath)) {
    vscode.window.showWarningMessage('Cursor++ log file does not exist yet. Enable file logging first.')
    return
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath))
  await vscode.window.showTextDocument(doc)
}

// ── 窗口标识 (从 VSCODE_PROCESS_TITLE 解析) —— myWindowId 声明在文件头部 ──
const RE_WINDOW_ID = /\[(\d+)-\d+\]/

function parseWindowId(): number | null {
  const title = process.env.VSCODE_PROCESS_TITLE || ''
  const m = title.match(RE_WINDOW_ID)
  return m ? Number.parseInt(m[1], 10) : null
}

// ── SSE 日志订阅 + Server Takeover ──
let sseRequest: http.ClientRequest | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let takeoverInProgress = false

function connectLogStream(port: number, windowId: number) {
  disconnectLogStream()

  const req = http.get(`http://127.0.0.1:${port}/byok/log-stream?windowId=${windowId}`, (res) => {
    let buf = ''
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const lines = part.split('\n')
        let eventType = ''
        let dataLine = ''
        for (const l of lines) {
          if (l.startsWith('event: '))
            eventType = l.slice(7).trim()
          else if (l.startsWith('data: '))
            dataLine = l.slice(6)
          else if (l.startsWith(':'))
            continue // SSE comment
        }
        if (eventType === 'shutdown') {
          log('info', '[TAKEOVER] shutdown signal received')
          attemptTakeover()
          return
        }
        if (!dataLine)
          continue
        try {
          const entry = JSON.parse(dataLine) as SseLogEntry
          writeToChannel(entry)
        }
        catch {
          log('info', dataLine)
        }
      }
    })
    res.on('end', () => {
      sseRequest = null
      onSseDisconnect()
    })
  })

  req.on('error', () => {
    sseRequest = null
    onSseDisconnect()
  })

  sseRequest = req
}

function disconnectLogStream() {
  if (sseRequest) {
    sseRequest.destroy()
    sseRequest = null
  }
}

// ── Ext Events SSE 订阅 (renderer → ext host 桥) ──
//
// Agents Window (glass) 注入按钮跑在 renderer, 无扩展进程直连; server 的
// /byok/ext-events 把 openUsagePage 这类需要 vscode.commands 的动作广播
// 给各窗口 ext host, 由聚焦窗口执行 (玻璃命令 glass.openBrowserTab 在
// Agents Window 的内置浏览器打开 Usage Dashboard)。
// 断线由 5s 定时重试兜底 (server takeover 期间会断); server offline 属
// 正常态, 连接失败静默。

let extEventsRequest: http.ClientRequest | null = null
let extEventsRetryTimer: ReturnType<typeof setTimeout> | null = null
let extEventsStopped = false

function disconnectExtEventsStream() {
  if (extEventsRequest) {
    extEventsRequest.destroy()
    extEventsRequest = null
  }
}

function scheduleExtEventsReconnect() {
  if (extEventsStopped || extEventsRetryTimer)
    return
  extEventsRetryTimer = setTimeout(() => {
    extEventsRetryTimer = null
    connectExtEventsStream()
  }, 5000)
}

/** 广播打到所有窗口, 只有用户刚点击的 (必然聚焦的) 那个窗口执行 */
async function handleOpenUsagePage(url: string): Promise<void> {
  if (!vscode.window.state.focused)
    return
  try {
    await vscode.commands.executeCommand('glass.openBrowserTab', {
      url,
      preserveFocus: false,
      inactive: false,
      focusOmnibar: false,
      reuseExistingUrlTab: true,
    })
  }
  catch {
    // 编辑器窗口聚焦时理论到不了这里; catch 兜底保证任何窗口都有可用行为
    void vscode.env.openExternal(vscode.Uri.parse(url))
  }
}

function connectExtEventsStream() {
  disconnectExtEventsStream()
  const { host, port } = getServerConfig()
  const request = http.get(`http://${host}:${port}/byok/ext-events`, (res) => {
    let buf = ''
    res.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const lines = part.split('\n')
        let eventType = ''
        let dataLine = ''
        for (const l of lines) {
          if (l.startsWith('event: '))
            eventType = l.slice(7).trim()
          else if (l.startsWith('data: '))
            dataLine = l.slice(6)
        }
        if (eventType === 'openUsagePage' && dataLine) {
          try {
            const payload = JSON.parse(dataLine) as { url?: string }
            if (payload.url)
              void handleOpenUsagePage(payload.url)
          }
          catch { /* 非 JSON data 忽略 */ }
        }
      }
    })
    res.on('end', () => {
      extEventsRequest = null
      scheduleExtEventsReconnect()
    })
  })

  request.on('error', () => {
    extEventsRequest = null
    scheduleExtEventsReconnect()
  })

  extEventsRequest = request
}

async function onSseDisconnect() {
  if (getState().server === 'local')
    return // owner 自己关闭,不需要接管
  const cfg = getServerConfig()
  const probe = await probeByokServer(cfg.host, cfg.port)
  if (probe.kind === 'byok') {
    setTimeout(() => {
      if (myWindowId !== null) {
        const c = getServerConfig()
        connectLogStream(c.port, myWindowId)
      }
    }, 3000)
  }
  else if (probe.kind === 'offline') {
    attemptTakeover()
  }
  else {
    log('warn', `[SRV] port ${cfg.port} is occupied by another process (${probe.reason})`)
    await refreshState()
    renderStatusBar()
    stopHeartbeat()
  }
}

async function attemptTakeover() {
  if (takeoverInProgress)
    return
  if (getState().server === 'local')
    return
  takeoverInProgress = true
  try {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 600))
    if (getState().server === 'local')
      return // 等待期间已被接管
    await refreshState() // 刷新缓存状态: remote → offline
    await doStartServer()
    await refreshState()
    renderStatusBar()
    stopHeartbeat()
    if (myWindowId !== null) {
      const cfg = getServerConfig()
      connectLogStream(cfg.port, myWindowId)
    }
    log('info', '[TAKEOVER] this window is now the server owner')
  }
  catch {
    await refreshState()
    renderStatusBar()
    startHeartbeat()
    if (myWindowId !== null) {
      const cfg = getServerConfig()
      connectLogStream(cfg.port, myWindowId)
    }
  }
  finally {
    takeoverInProgress = false
  }
}

function startHeartbeat() {
  if (heartbeatTimer)
    return
  heartbeatTimer = setInterval(async () => {
    if (getState().server === 'local') {
      stopHeartbeat()
      return
    }
    const cfg = getServerConfig()
    const probe = await probeByokServer(cfg.host, cfg.port)
    if (probe.kind === 'offline') {
      log('info', '[HEARTBEAT] server unreachable, attempting takeover...')
      attemptTakeover()
    }
    else if (probe.kind === 'occupied') {
      log('warn', `[SRV] port ${cfg.port} is occupied by another process (${probe.reason})`)
      await refreshState()
      renderStatusBar()
      stopHeartbeat()
    }
  }, 3000)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// ── 今日用量摘要 (状态栏 tooltip 数据) ──
//
// 周期 (60s) 从 server 拉取 range=today 的原始行自行求和,
// 失败静默置 null (tooltip 隐藏该行), 绝不影响状态栏其他内容。

let todayUsageSummary: { totalTokens: number, requests: number } | null = null

/** K/M 缩写 — 与 Dashboard 前端 formatTokenCount 同规则 */
function formatTokenCountForTooltip(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

async function refreshStatusBarUsageSummary(): Promise<void> {
  if (getState().server === 'offline') {
    todayUsageSummary = null
    renderStatusBar()
    return
  }
  try {
    const { host, port } = getServerConfig()
    const response = await fetch(`http://${host}:${port}/byok/usage-stats?range=today`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as { rows?: Array<{ inputTokens: number, outputTokens: number, requestCount: number }> }
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    todayUsageSummary = rows.reduce((summary, row) => ({
      totalTokens: summary.totalTokens + row.inputTokens + row.outputTokens,
      requests: summary.requests + row.requestCount,
    }), { totalTokens: 0, requests: 0 })
  }
  catch {
    todayUsageSummary = null
  }
  renderStatusBar()
}

// ── 状态栏渲染 ──
//
// 复合状态: 同时显示 server 进程状态 + BYOK Mode 开关
//   - 前缀 codicon (✓ / ○) → server 进程状态 (复用旧的语义)
//   - 后缀 ◉ / ○ → BYOK Mode 开/关
//   - 整体颜色: BYOK off 时给警告色提示
//
// 点击 → toggle BYOK Mode (非 server)。Server 启停走命令面板/侧边栏。
// tooltip 是 MarkdownString: 含可点击的 Open Usage Dashboard 命令链接,
// 需要 isTrusted = true 才能激活 command: 链接; supportThemeIcons 启用 $(graph)。

function renderStatusBar() {
  const s = getState()

  // server 状态前缀 codicon: ✓ on / ✗ offline (close 是 × 不是字母 x)
  const serverIcon = s.server === 'offline' ? '$(close)' : '$(check)'

  // 主 tooltip 行 — 保留旧 Server 描述形态
  const src = s.server === 'local' ? 'this instance' : 'another instance'
  const serverTip = s.serverIssue === 'port_occupied'
    ? `Cursor++ — port ${s.port} is occupied by another process`
    : s.server === 'offline'
      ? 'Cursor++ — Server offline'
      : `Cursor++ — Server :${s.port} (${src})`

  // BYOK mode 后缀 + tooltip 行
  const byokGlyph = s.byokMode ? '◉' : '○'
  const byokTip = s.byokMode
    ? 'BYOK ON — using local providers.json'
    : 'BYOK OFF — passing through to official Cursor'

  // tooltip: server/byok 语义保持不变, 追加今日摘要 (有数据才显示) + Dashboard 链接。
  // 链接始终可见 (入口可发现性), 仅摘要行依赖数据 — 摘要拉取失败/未就绪时只隐藏摘要。
  const tooltip = new vscode.MarkdownString(undefined, true)
  tooltip.isTrusted = true
  tooltip.appendMarkdown(`${serverTip}\n\n${byokTip}`)
  tooltip.appendMarkdown(`\n\n---`)
  if (todayUsageSummary)
    tooltip.appendMarkdown(`\n\n今日: **${formatTokenCountForTooltip(todayUsageSummary.totalTokens)}** tokens · **${todayUsageSummary.requests}** requests`)
  tooltip.appendMarkdown(`\n\n$(graph) [Open Usage Dashboard](command:cursor2plus.openUsageDashboard)`)
  tooltip.appendMarkdown(`\n\n---\n\nClick: toggle BYOK Mode`)

  statusBarItem.text = `${serverIcon} BYOK ${byokGlyph}`
  statusBarItem.tooltip = tooltip
  statusBarItem.backgroundColor = s.byokMode
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground')
  statusBarItem.command = 'cursor2plus.toggleByok'
}

// ── Server 操作 ──

async function toggleServer() {
  const s = getState()

  if (s.server === 'local') {
    await stopServer()
    log('info', '[SRV] stopped')
    vscode.window.showInformationMessage('Cursor++ BYOK Server stopped')
  }
  else if (s.server === 'remote') {
    vscode.window.showInformationMessage('Server is running in another Cursor instance')
    return
  }
  else {
    await doStartServer()
  }
  await refreshState()
}

async function waitForRemoteByokServer(host: string, port: number, attempts = 8): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const probe = await probeByokServer(host, port)
    if (probe.kind === 'byok')
      return true
    if (probe.kind === 'offline')
      return false
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function doStartServer() {
  const cfg = getServerConfig()

  await refreshState()
  const s = getState()
  if (s.server === 'local') {
    log('warn', '[SRV] server already running in this instance')
    return
  }
  if (s.server === 'remote') {
    log('info', `[SRV] port ${cfg.port} claimed by another Cursor++ instance, running as remote`)
    startHeartbeat()
    return
  }
  if (s.serverIssue === 'port_occupied') {
    showPortOccupiedMessage(cfg.port)
    return
  }

  try {
    const startOptions: StartServerOptions = {
      host: cfg.host,
      port: cfg.port,
    }
    // 浏览器版 Dashboard (/byok/usage): Agents Window 入口用, 缺资源时降级 503
    if (extensionAssetsBasePath) {
      startOptions.usageDashboardPage = {
        html: renderDashboardPageHtml({ scriptSrc: '/byok/usage.js', includeBrowserThemeDefaults: true }),
        dashboardJsPath: join(extensionAssetsBasePath, 'dist', 'dashboard.js'),
      }
    }
    const { host, port } = await startServer(startOptions)
    log('info', `[SRV] listening at http://${host}:${port}`)
    stopHeartbeat()
  }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code === 'EADDRINUSE' || msg.includes('EADDRINUSE')) {
      if (await waitForRemoteByokServer(cfg.host, cfg.port)) {
        log('info', `[SRV] port ${cfg.port} claimed by another Cursor++ instance, running as remote`)
        await refreshState()
        renderStatusBar()
        startHeartbeat()
      }
      else {
        await refreshState()
        if (getState().server === 'remote') {
          log('info', `[SRV] port ${cfg.port} claimed by another Cursor++ instance, running as remote`)
          startHeartbeat()
          return
        }
        showPortOccupiedMessage(cfg.port)
      }
    }
    else {
      log('error', `[SRV] failed to start: ${msg}`)
      vscode.window.showErrorMessage(`Cursor++ Server failed: ${msg}`)
    }
  }
}

// ── 激活 ──

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Cursor++', { log: true })
  initLogger((level, msg) => writeToChannel({ level, msg }))
  // 扩展根路径先于任何 startServer 调用记录 (浏览器版 Dashboard 资源定位用)
  extensionAssetsBasePath = context.extensionPath
  setupSupermarkdownNativeTip()
  preflightSupermarkdown()
  log('info', 'Cursor++ activating...')

  // 状态栏 (BYOK Mode 切换按钮)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'cursor2plus.toggleByok'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // 状态变化 → 刷新状态栏
  context.subscriptions.push(onStateChange(() => renderStatusBar()))

  // 侧边栏面板
  const panelProvider = new PanelProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, panelProvider),
  )

  // ── 正常命令注册 ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor2plus.serverToggle', () => toggleServer()),
    vscode.commands.registerCommand('cursor2plus.toggleByok', async () => {
      const next = await toggleByokMode()
      await refreshState()
      // 1. 推送 REST redirect 列表变更到 renderer — inject-patch 的 fetch wrapper
      //    安装时写死了 _restPaths, 切 OFF 后 /auth/poll 仍被拦截导致登录中断,
      //    必须通过 SSE 推送新列表让 renderer 热更新。
      const restPaths = next.redirect
        .filter((r: string) => r.startsWith('REST:'))
        .map((r: string) => r.slice(5))
      pushRoutesUpdate(restPaths)
      // 2. 触发 renderer hook 主动刷新模型列表 (借助捕获的 aiService 引用)
      bumpRefreshSignal()
      const label = next.byokMode ? 'BYOK enabled' : 'BYOK disabled (using official Cursor)'
      vscode.window.showInformationMessage(`${label}. Model list will refresh automatically.`)
    }),
    vscode.commands.registerCommand('cursor2plus.editRoutes', () => {
      vscode.window.showTextDocument(vscode.Uri.file(getRoutesFilePath()))
    }),
    vscode.commands.registerCommand('cursor2plus.editProviders', () => {
      vscode.window.showTextDocument(vscode.Uri.file(getProvidersFilePath()))
    }),
    vscode.commands.registerCommand('cursor2plus.openSettings', () => {
      vscode.commands.executeCommand('cursor2plus.panel.focus')
    }),
    vscode.commands.registerCommand('cursor2plus.toggleFileLog', () => toggleFileLog(context)),
    vscode.commands.registerCommand('cursor2plus.openLogFile', () => openLogFile()),
    vscode.commands.registerCommand('cursor2plus.openUsageDashboard', () => openUsageDashboard(context)),
  )

  // 确保配置文件存在 —— 即使 server 未启动,面板也能读写
  await ensureRoutesFile()
  await ensureProvidersFile()

  // 文件监听: 其他实例修改配置时自动同步状态 + UI
  startRoutesWatcher()
  startProvidersWatcher()
  const disposeRoutesWatch = onRoutesChange(async () => {
    await refreshState()
    renderStatusBar()
    bumpRefreshSignal()
  })
  const disposeProvidersWatch = onProvidersChange(async () => {
    resetProviderInstanceCache() // 清除缓存的 SDK client, 下次请求用新 baseUrl/apiKey
    await refreshState()
    bumpRefreshSignal()
  })
  context.subscriptions.push({ dispose: disposeRoutesWatch }, { dispose: disposeProvidersWatch })

  // 初始化状态
  await refreshState()
  renderStatusBar()

  // Auto-start server
  const { autoStart } = getServerConfig()
  if (autoStart) {
    await doStartServer()
    await refreshState()
  }

  // 今日用量摘要: server 尝试自启动之后初始拉一次 (启动前必然 offline, 拉了也是空),
  // 再挂 60s 周期刷新 (tooltip 数据)
  void refreshStatusBarUsageSummary()
  const usageSummaryTimer = setInterval(() => void refreshStatusBarUsageSummary(), 60_000)
  context.subscriptions.push({ dispose: () => clearInterval(usageSummaryTimer) })

  if (getState().server === 'remote')
    startHeartbeat()

  // 解析窗口 ID 并连接 SSE 日志流
  myWindowId = parseWindowId()
  // 初始化 file log 路径 (依赖 myWindowId 和 vscode.workspace.name)
  initLogFilePath(context)
  setFileLogState(fileLogEnabled, logFilePath)
  if (myWindowId !== null) {
    const cfg = getServerConfig()
    log('info', `[SRV] windowId=${myWindowId}, connecting to :${cfg.port}`)
    connectLogStream(cfg.port, myWindowId)
  }
  else {
    log('warn', '[SRV] could not parse windowId from VSCODE_PROCESS_TITLE')
  }

  // renderer→ext host 桥订阅 — 每个窗口的 ext host 都挂上, 由聚焦窗口消费
  connectExtEventsStream()

  if (fileLogEnabled)
    log('info', `[SRV] file logging restored from globalState → ${logFilePath}`)

  log('info', 'Cursor++ activated')

  // 版本更新检查
  startUpdateCheck(context.globalState, msg => log('info', msg))
}

export async function deactivate() {
  stopUpdateCheck()
  stopHeartbeat()
  extEventsStopped = true
  if (extEventsRetryTimer) {
    clearTimeout(extEventsRetryTimer)
    extEventsRetryTimer = null
  }
  disconnectExtEventsStream()
  disconnectLogStream()
  closeLogFileStream()
  stopRoutesWatcher()
  stopProvidersWatcher()
  await stopServer()
  if (outputChannel)
    outputChannel.dispose()
}
