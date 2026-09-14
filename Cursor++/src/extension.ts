import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import * as http from 'node:http'
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
import { PanelProvider } from './ui/panel-provider'
import { getState, onStateChange, probeByokServer, refreshState, requestByokServerTakeover, setFileLogState } from './ui/state'
import { startUpdateCheck, stopUpdateCheck } from './update-check'
import { EXTENSION_VERSION, isNewerVersion } from './version'

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
let skipNextDisconnectTakeover = false
let legacyOwnerWarningShown = false

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
          let takeoverVersion: string | undefined
          try {
            const data = JSON.parse(dataLine) as { takeoverVersion?: unknown }
            if (typeof data.takeoverVersion === 'string')
              takeoverVersion = data.takeoverVersion
          }
          catch { /* legacy shutdown payload */ }

          if (takeoverVersion && isNewerVersion(takeoverVersion, EXTENSION_VERSION)) {
            skipNextDisconnectTakeover = true
            log('info', `[TAKEOVER] yielding server ownership to newer version ${takeoverVersion}`)
            startHeartbeat()
            return
          }

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
  if (skipNextDisconnectTakeover) {
    skipNextDisconnectTakeover = false
    await refreshState()
    renderStatusBar()
    startHeartbeat()
    return
  }
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
    if (myWindowId !== null) {
      const cfg = getServerConfig()
      connectLogStream(cfg.port, myWindowId)
    }
    if (getState().server === 'local') {
      stopHeartbeat()
      log('info', '[TAKEOVER] this window is now the server owner')
    }
    else {
      startHeartbeat()
    }
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
    else if (probe.kind === 'byok') {
      if (getState().server !== 'remote') {
        await refreshState()
        renderStatusBar()
      }
      if (probe.version && isNewerVersion(EXTENSION_VERSION, probe.version)) {
        log('info', `[HEARTBEAT] older server version ${probe.version} detected, attempting takeover...`)
        attemptTakeover()
      }
      else if (!probe.version) {
        warnLegacyOwner()
      }
      else if (!sseRequest && myWindowId !== null) {
        connectLogStream(cfg.port, myWindowId)
      }
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

  statusBarItem.text = `${serverIcon} BYOK ${byokGlyph}`
  statusBarItem.tooltip = `${serverTip}\n${byokTip}\n\nClick: toggle BYOK Mode`
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

function warnLegacyOwner(): void {
  if (legacyOwnerWarningShown)
    return
  legacyOwnerWarningShown = true
  const message = 'Cursor++ server is owned by an older extension that cannot hand off automatically. Close all Cursor windows once, then reopen the project.'
  log('warn', `[TAKEOVER] ${message}`)
  void vscode.window.showWarningMessage(message)
}

async function waitForRemoteOwnerChange(host: string, port: number, ownerVersion: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const probe = await probeByokServer(host, port)
    if (probe.kind === 'offline')
      return
    if (probe.kind === 'byok' && probe.version !== ownerVersion)
      return
  }
}

async function doStartServer() {
  const cfg = getServerConfig()

  await refreshState()
  let s = getState()
  if (s.server === 'local') {
    log('warn', '[SRV] server already running in this instance')
    return
  }
  if (s.server === 'remote') {
    const probe = await probeByokServer(cfg.host, cfg.port)
    if (probe.kind === 'byok') {
      if (probe.version && isNewerVersion(EXTENSION_VERSION, probe.version)) {
        log('info', `[TAKEOVER] requesting handoff from server version ${probe.version} to ${EXTENSION_VERSION}`)
        const accepted = await requestByokServerTakeover(cfg.host, cfg.port, EXTENSION_VERSION)
        if (!accepted) {
          log('warn', `[TAKEOVER] server version ${probe.version} rejected the handoff request`)
          startHeartbeat()
          return
        }
        await waitForRemoteOwnerChange(cfg.host, cfg.port, probe.version)
        await refreshState()
        s = getState()
      }
      else {
        if (!probe.version)
          warnLegacyOwner()
        log('info', `[SRV] port ${cfg.port} claimed by another Cursor++ instance, running as remote`)
        startHeartbeat()
        return
      }
    }
    else {
      await refreshState()
      s = getState()
    }
  }
  if (s.server === 'local') {
    stopHeartbeat()
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
  await stopServer()
  if (outputChannel)
    outputChannel.dispose()
}
