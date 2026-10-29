import type { ByokMode } from './server/data/defaults'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import * as http from 'node:http'
import * as vscode from 'vscode'
import { bumpRefreshSignal, bumpRefreshSignalForModeChange, pushRoutesUpdate, startServer, stopServer } from './server'
import { getServerConfig } from './server/config'
import { getLogsDir, getProvidersFilePath, getSessionLogFilePath } from './server/config/paths'
import { ensureProvidersFile, onProvidersChange, startProvidersWatcher, stopProvidersWatcher } from './server/config/providersStore'
import { ensureRoutesFile, loadRoutes, onRoutesChange, requestByokMode, startRoutesWatcher, stopRoutesWatcher } from './server/config/routesStore'
import { isLikelyWindowsMsvcMissing, preflightSupermarkdown, setSupermarkdownNativeErrorNotifier } from './server/handlers/agent/supermarkdown'
import { resetProviderInstanceCache } from './server/handlers/llm/providerRuntime'
import { initLogger } from './server/logger'
import { getRoutesFilePath } from './server/routes'
import { ensureUsageSettingsFile, onUsageSettingsChange, startUsageSettingsWatcher, stopUsageSettingsWatcher } from './server/usage/settings'
import { pruneOldUsageLogs } from './server/usage/store'
import { PanelProvider } from './ui/panel-provider'
import { getState, onStateChange, probeByokServer, refreshState, setFileLogState } from './ui/state'
import { getUsageSuffix, getUsageTooltipLine, initUsageStatusBar, refreshUsageStatusBar } from './ui/usage-statusbar'
import { startUpdateCheck, stopUpdateCheck } from './update-check'

let outputChannel: vscode.LogOutputChannel
let statusBarItem: vscode.StatusBarItem

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

// ── 状态栏渲染 ──
//
// 复合状态: 同时显示 server 进程状态 + BYOK Mode 开关
//   - 前缀 codicon (✓ / ○) → server 进程状态 (复用旧的语义)
//   - 后缀 ◉ / ○ → BYOK Mode 开/关
//   - 整体颜色: BYOK off 时给警告色提示
//
// 点击 → toggle BYOK Mode (非 server)。Server 启停走命令面板/侧边栏。

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

  statusBarItem.text = `${serverIcon} BYOK ${byokGlyph}${getUsageSuffix()}`
  statusBarItem.tooltip = `${serverTip}\n${byokTip}${getUsageTooltipLine() ? `\n${getUsageTooltipLine()}` : ''}\n\nClick: toggle BYOK Mode`
  statusBarItem.backgroundColor = s.byokMode
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground')
  // 携带目标值 (按当前显示状态取反) 而非翻转: 同一次点击被重复处理时结果不变
  statusBarItem.command = {
    title: 'Toggle BYOK Mode',
    command: 'cursor2plus.setByokMode',
    arguments: [s.byokMode ? 0 : 1, 'statusbar'],
  }
}

/**
 * BYOK 开关的统一执行入口 (状态栏 / 侧边栏 / 命令面板)。
 * 只有状态实际变化时才推送路由、刷新模型列表、弹出提示; 重复请求为空操作。
 */
async function applyByokRequest(target: ByokMode | 'toggle', source: string): Promise<void> {
  const { routes: next, changed } = await requestByokMode(target, source)
  await refreshState()
  renderStatusBar()
  if (!changed)
    return
  // 1. 推送 redirect 列表变更到 renderer — inject-patch 的 fetch wrapper
  //    安装时写死了 _restPaths, 切 OFF 后 /auth/poll 仍被拦截导致登录中断,
  //    必须通过 SSE 推送新列表让 renderer 热更新 (REST + ConnectRPC 规则)。
  pushRoutesUpdate(next.redirect)
  // 2. 触发 renderer hook 主动刷新模型列表 (借助捕获的 aiService 引用), 并在稳定后补发一次
  //    (覆盖被合并进「切换前已发出的官方请求」的刷新, 见 bumpRefreshSignalForModeChange)
  bumpRefreshSignalForModeChange()
  const label = next.byokMode ? 'BYOK enabled' : 'BYOK disabled (using official Cursor)'
  vscode.window.showInformationMessage(`${label}. Model list will refresh automatically.`)
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

/**
 * listen 报 EADDRINUSE 之后, 等待端口持有者被识别为 Cursor++。
 *
 * EADDRINUSE 已证明端口被绑定: 此时探测为 'offline' 的含义是「对方尚未就绪」
 * (另一窗口的 server 正在启动, 扩展宿主事件循环繁忙, /health 500ms 内未响应),
 * 不能据此放弃 —— 否则会把另一个 Cursor++ 实例误报为「被其他进程占用」(多窗口同时启动时实测出现)。
 * 约 5s 窗口内持续探测; 返回观察到的探测结果供诊断。
 */
async function waitForRemoteByokServer(host: string, port: number, attempts = 20): Promise<{ byok: boolean, observed: string[] }> {
  const observed: string[] = []
  for (let i = 0; i < attempts; i++) {
    const probe = await probeByokServer(host, port)
    observed.push(probe.kind)
    if (probe.kind === 'byok')
      return { byok: true, observed }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return { byok: false, observed }
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
    const { host, port } = await startServer({
      host: cfg.host,
      port: cfg.port,
    })
    log('info', `[SRV] listening at http://${host}:${port}`)
    stopHeartbeat()
  }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code === 'EADDRINUSE' || msg.includes('EADDRINUSE')) {
      const waited = await waitForRemoteByokServer(cfg.host, cfg.port)
      const probeTrail = [...new Set(waited.observed)].map(k => `${k}×${waited.observed.filter(x => x === k).length}`).join(', ')
      if (waited.byok) {
        log('info', `[SRV] port ${cfg.port} claimed by another Cursor++ instance, running as remote (probes: ${probeTrail})`)
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
        log('warn', `[SRV] port ${cfg.port} owner never identified as Cursor++ (probes: ${probeTrail})`)
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
  setupSupermarkdownNativeTip()
  preflightSupermarkdown()
  log('info', 'Cursor++ activating...')

  // 状态栏 (BYOK Mode 切换按钮)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.name = 'Cursor++: BYOK'
  statusBarItem.command = 'cursor2plus.toggleByok'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // 用量后缀挂在 BYOK 状态栏项上 (今日费用, 点击项仍是 BYOK 开关)
  initUsageStatusBar(renderStatusBar)

  // 状态变化 → 刷新状态栏; server 就绪时同步刷新今日费用后缀
  context.subscriptions.push(onStateChange(() => {
    renderStatusBar()
    if (getState().server === 'local')
      refreshUsageStatusBar()
  }))

  // 侧边栏面板
  const panelProvider = new PanelProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelProvider.viewType, panelProvider),
  )

  // ── 正常命令注册 ──
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor2plus.serverToggle', () => toggleServer()),
    // 旧入口 (命令面板 / 快捷键): 翻转语义, 500ms 防抖
    vscode.commands.registerCommand('cursor2plus.toggleByok', () => applyByokRequest('toggle', 'command:toggle')),
    // 幂等入口: 设为目标值 (状态栏 / 侧边栏按当前显示状态计算 target)
    vscode.commands.registerCommand('cursor2plus.setByokMode', (mode: unknown, source?: unknown) => {
      if (mode !== 0 && mode !== 1)
        return applyByokRequest('toggle', `command:set(invalid ${String(mode)})`)
      return applyByokRequest(mode, typeof source === 'string' ? source : 'command:set')
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
    vscode.commands.registerCommand('cursor2plus.openUsage', () => {
      void vscode.commands.executeCommand('cursor2plus.panel.focus')
      panelProvider.revealUsage()
    }),
    vscode.commands.registerCommand('cursor2plus.toggleFileLog', () => toggleFileLog(context)),
    vscode.commands.registerCommand('cursor2plus.openLogFile', () => openLogFile()),
  )

  // 确保配置文件存在 —— 即使 server 未启动,面板也能读写
  await ensureRoutesFile()
  await ensureProvidersFile()
  ensureUsageSettingsFile()
  // 清理超过保留期的用量明细, 防止 usage_logs 无限膨胀
  void pruneOldUsageLogs()

  // 文件监听: 其他实例修改配置时自动同步状态 + UI
  startRoutesWatcher()
  startProvidersWatcher()
  startUsageSettingsWatcher()
  const disposeRoutesWatch = onRoutesChange(async () => {
    await refreshState()
    renderStatusBar()
    // 其他实例 toggle / 外部编辑 routes.json 时, 由 server 所在进程把新列表推给 renderer;
    // 本进程不是 server owner 时 SSE 连接集合为空, 推送为空操作
    pushRoutesUpdate(loadRoutes().redirect)
    bumpRefreshSignalForModeChange()
  })
  const disposeProvidersWatch = onProvidersChange(async () => {
    resetProviderInstanceCache() // 清除缓存的 SDK client, 下次请求用新 baseUrl/apiKey
    await refreshState()
    bumpRefreshSignal()
  })
  const disposeUsageWatch = onUsageSettingsChange(async () => {
    await refreshState()
    refreshUsageStatusBar()
  })
  context.subscriptions.push({ dispose: disposeRoutesWatch }, { dispose: disposeProvidersWatch }, { dispose: disposeUsageWatch })

  // 初始化状态
  await refreshState()
  renderStatusBar()

  // Auto-start server
  const { autoStart } = getServerConfig()
  if (autoStart) {
    await doStartServer()
    await refreshState()
  }

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

  if (fileLogEnabled)
    log('info', `[SRV] file logging restored from globalState → ${logFilePath}`)

  log('info', 'Cursor++ activated')

  // 版本更新检查
  startUpdateCheck(context.globalState, msg => log('info', msg))
}

export async function deactivate() {
  stopUpdateCheck()
  stopHeartbeat()
  disconnectLogStream()
  closeLogFileStream()
  stopRoutesWatcher()
  stopProvidersWatcher()
  stopUsageSettingsWatcher()
  await stopServer()
  if (outputChannel)
    outputChannel.dispose()
}
