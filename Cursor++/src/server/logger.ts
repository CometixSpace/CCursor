/**
 * Extension-embedded logger
 *
 * pino 输出桥接到 VS Code LogOutputChannel (原生颜色 + level 过滤)。
 * 在 extension activate() 中调用 initLogger(sink) 初始化。
 *
 * 日志流向 (按 AsyncLocalStorage 上下文分发):
 *   请求处理链内 (als 有 windowId):
 *     pino.info(...) → channelStream → pushFn(windowId, entry)
 *     → 仅发给该 windowId 的 SSE 连接 (per-window)
 *
 *   请求处理链外 (als 无上下文, 启动/配置变更等系统日志):
 *     pino.info(...) → channelStream
 *     → sink[level](msg)    (server owner LogOutputChannel)
 *     → broadcastFn(entry)  (SSE 广播给所有窗口)
 */
import type { Writable as WritableType } from 'node:stream'

import { AsyncLocalStorage } from 'node:async_hooks'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { Writable } from 'node:stream'
import pino from 'pino'
import { getLogsDir } from './config/paths'

/** 日志级别字符串 — 与 LogOutputChannel 方法名对齐 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  msg: string
}

/** server owner 本地写入 (LogOutputChannel.trace/debug/info/warn/error) */
type LogSink = (level: LogLevel, msg: string) => void
let sinkFn: LogSink | null = null

/** SSE 广播回调 — 推送结构化 entry 给所有已连接窗口 */
let broadcastFn: ((entry: LogEntry) => void) | null = null

/** SSE per-window 推送 — 仅发给指定 windowId 的连接 */
let pushFn: ((windowId: number, entry: LogEntry) => void) | null = null

/** 查询 windowId 是否有 SSE 订阅者 */
let hasSubscriberFn: ((windowId: number) => boolean) | null = null

// ── Agent Window orphan 日志 (无 SSE 订阅者的 windowId 直接落盘) ──
const orphanStreams = new Map<number, WritableType>()

function getOrphanStream(windowId: number): WritableType {
  let s = orphanStreams.get(windowId)
  if (s)
    return s
  const dir = getLogsDir()
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true })
  s = createWriteStream(`${dir}/agent-${windowId}.log`, { flags: 'a' })
  orphanStreams.set(windowId, s)
  return s
}

function writeOrphanLog(windowId: number, entry: LogEntry): void {
  const ts = new Date().toISOString()
  const line = `${ts} [${entry.level.toUpperCase()}] ${entry.msg}\n`
  try {
    getOrphanStream(windowId).write(line)
  }
  catch {}
}

/** 请求上下文 — 通过 AsyncLocalStorage 贯穿整条处理链 */
interface LogContext {
  windowId: number
}
const als = new AsyncLocalStorage<LogContext>()

/**
 * 同步进入 windowId 上下文 (适用于 Fastify onRequest hook).
 * enterWith 会把当前 async 上下文替换为新 store, 后续同一 async chain 内都能读到。
 */
export function enterWindowContext(windowId: number): void {
  als.enterWith({ windowId })
}

function numericLevelToLabel(level: number): LogLevel {
  if (level <= 10)
    return 'trace'
  if (level <= 20)
    return 'debug'
  if (level <= 30)
    return 'info'
  if (level <= 40)
    return 'warn'
  return 'error'
}

// 自定义 writable stream — 解析 pino JSON 并按 AsyncLocalStorage 上下文分发
const channelStream = new Writable({
  write(chunk, _encoding, callback) {
    const line = chunk.toString().trim()
    if (!line) {
      callback()
      return
    }

    let level: LogLevel = 'info'
    let msg = line
    try {
      const obj = JSON.parse(line)
      level = numericLevelToLabel(obj.level)
      const baseMsg = obj.msg || ''
      const extra = Object.keys(obj)
        .filter(k => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k))
        .reduce((o, k) => {
          o[k] = obj[k]
          return o
        }, {} as Record<string, unknown>)
      const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''
      msg = `${baseMsg}${extraStr}`
    }
    catch {
      // 非 JSON, 原样作为 info
    }

    const ctx = als.getStore()
    if (ctx && pushFn) {
      // 请求上下文内 → per-window 推送
      pushFn(ctx.windowId, { level, msg })
      // 无 SSE 订阅者 (Agent Window) → 直接落盘
      if (hasSubscriberFn && !hasSubscriberFn(ctx.windowId))
        writeOrphanLog(ctx.windowId, { level, msg })
    }
    else {
      // 请求外 (启动/配置变更/未映射请求) → sink + broadcast
      if (sinkFn)
        sinkFn(level, msg)
      if (broadcastFn)
        broadcastFn({ level, msg })
    }

    callback()
  },
})

// pino 级别设为 trace (发射所有) — 过滤交给 LogOutputChannel (每窗口独立)
// 用户通过 VS Code 命令 "Developer: Set Log Level..." 或 Output 面板 UI 切换
export const logger = pino({ level: 'trace' }, channelStream)
export const streamLogger = pino({ level: 'trace' }, channelStream)

/**
 * 连接 LogOutputChannel。在 extension.activate() 中调用。
 * sink 签名: (level, msg) => channel[level](msg)
 */
export function initLogger(sink: LogSink): void {
  sinkFn = sink
}

/** 设置 SSE 广播回调 — server 启动后调用 */
export function setLogBroadcast(fn: (entry: LogEntry) => void): void {
  broadcastFn = fn
}

/** 设置 per-window SSE 推送回调 — server 启动后调用 */
export function setLogPush(fn: (windowId: number, entry: LogEntry) => void): void {
  pushFn = fn
}

/** 设置订阅者查询回调 — 用于区分 Editor (有 SSE) vs Agent Window (无 SSE, 落盘) */
export function setLogSubscriberCheck(fn: (windowId: number) => boolean): void {
  hasSubscriberFn = fn
}
