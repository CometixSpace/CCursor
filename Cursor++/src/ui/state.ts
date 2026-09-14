/**
 * 共享应用状态 — 单一数据源
 *
 * 所有 UI（状态栏、侧边栏面板）从此处读取状态。
 * 状态变化时通过 EventEmitter 通知所有消费方。
 */
import type { ByokMode, ProviderEntry } from '../server/data/defaults'
import * as net from 'node:net'
import * as vscode from 'vscode'
import { isServerRunning } from '../server'
import { getServerConfig } from '../server/config'
import { loadProviders } from '../server/config/providersStore'
import { getByokMode } from '../server/config/routesStore'
import { getWebTools } from '../server/config/searchConfigStore'
import { EXTENSION_VERSION } from '../version'

export type ServerState = 'local' | 'remote' | 'offline'

export type ServerIssue = 'port_occupied' | null

export interface AppState {
  server: ServerState
  serverIssue: ServerIssue
  serverIssueDetail: string
  host: string
  port: number
  byokMode: ByokMode
  providers: ProviderEntry[]
  webTools: import('../server/data/defaults').WebToolsConfig
  version: string
  fileLogEnabled: boolean
  logFilePath: string
}

const emitter = new vscode.EventEmitter<AppState>()
export const onStateChange = emitter.event

let current: AppState = {
  server: 'offline',
  serverIssue: null,
  serverIssueDetail: '',
  host: '127.0.0.1',
  port: 39831,
  byokMode: 1,
  version: EXTENSION_VERSION,
  providers: [],
  webTools: { $schemaVersion: 1, search: { providers: [], parallel: false, maxResults: 5 }, fetch: { provider: 'builtin' } },
  fileLogEnabled: false,
  logFilePath: '',
}

/** 文件日志状态由 extension.ts 注入 (globalState + 实际写入 stream) */
export function setFileLogState(enabled: boolean, path: string): void {
  current = { ...current, fileLogEnabled: enabled, logFilePath: path }
  emitter.fire(current)
}

export function getState(): AppState {
  return current
}

export function isPortReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host)
  })
}

export type ServerProbeResult
  = | { kind: 'byok', version?: string }
    | { kind: 'offline' }
    | { kind: 'occupied', reason: string }

export async function probeByokServer(host: string, port: number): Promise<ServerProbeResult> {
  const reachable = await isPortReachable(host, port)
  if (!reachable)
    return { kind: 'offline' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal })
    const data = await response.json().catch(() => null) as any
    if (response.ok && data?.ok === true && data?.mode === 'byok') {
      const version = typeof data.version === 'string' && data.version.length > 0
        ? data.version
        : undefined
      return { kind: 'byok', version }
    }
    // HTTP 响应了但不是 BYOK server — 真正被占用
    return { kind: 'occupied', reason: `unexpected /health response: HTTP ${response.status}` }
  }
  catch {
    // TCP reachable 但 HTTP fetch 失败 (connection reset, timeout, non-HTTP service)
    // 不判定为 occupied — 可能是 Windows 网络栈假阳性或 always-local patch 干扰。
    // 让 Fastify listen 的 EADDRINUSE 做最终仲裁。
    return { kind: 'offline' }
  }
  finally {
    clearTimeout(timer)
  }
}

export async function requestByokServerTakeover(host: string, port: number, requesterVersion: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    const response = await fetch(`http://${host}:${port}/byok/takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterVersion }),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null) as any
    return response.status === 202 && data?.accepted === true
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

export async function refreshState(_secrets?: vscode.SecretStorage): Promise<AppState> {
  const cfg = getServerConfig()

  let server: ServerState = 'offline'
  let serverIssue: ServerIssue = null
  let serverIssueDetail = ''
  if (isServerRunning()) {
    server = 'local'
  }
  else {
    const probe = await probeByokServer(cfg.host, cfg.port)
    if (probe.kind === 'byok') {
      server = 'remote'
    }
    else if (probe.kind === 'occupied') {
      serverIssue = 'port_occupied'
      serverIssueDetail = probe.reason
    }
  }

  const byokMode = getByokMode()
  const providers = loadProviders().providers

  current = {
    server,
    serverIssue,
    serverIssueDetail,
    host: cfg.host,
    port: cfg.port,
    byokMode,
    providers,
    webTools: getWebTools(),
    version: EXTENSION_VERSION,
    fileLogEnabled: current.fileLogEnabled,
    logFilePath: current.logFilePath,
  }
  emitter.fire(current)
  return current
}
