import type { LogEntry, LogLevel } from './logger'
import type { RuntimeConfigInit } from './runtime-config'
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify'
import cors from '@fastify/cors'
/**
 * Embedded BYOK Server — Fastify + ConnectRPC
 *
 * 在 extension host 进程内运行，通过 startServer/stopServer 管理生命周期。
 */
import Fastify from 'fastify'
import { EXTENSION_VERSION, isNewerVersion } from '../version'
import { ensureProvidersFile } from './config/providersStore'
import { ensureRoutesFile, loadRoutes, toggleByokMode } from './config/routesStore'
import { closeAgentDatabase, initDatabase } from './database/sqlite'
import { enterWindowContext, logger, setLogBroadcast, setLogPush, setLogSubscriberCheck } from './logger'
import { initRuntimeConfig } from './runtime-config'
import routes from './services'

const RE_CONNECT_RPC_PATH = /\/([^/]+)\/(\w+)$/

/**
 * 高频轮询端点 — 固定走 trace 级别 (默认不可见)。
 *
 * - /auth/full_stripe_profile, /auth/stripe_profile: Cursor 订阅状态轮询
 *
 * 节流机制已移除: trace 级别默认被 LogOutputChannel 过滤掉,
 * 开启 trace 时用户自己需要面对所有细节, 不再聚合汇总。
 */
const TRACE_PATHS = new Set([
  '/auth/full_stripe_profile',
  '/auth/stripe_profile',
])

let app: any = null

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address)
    return false
  const normalized = address.toLowerCase()
  return normalized === '::1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.')
}

// ── SSE 日志分发 (per-windowId) ──
//
// windowId 从请求头 x-client-wid 直接读取 — 由 renderer inject-patch 注入,
// 值来自 window.vscodeWindowId。Extension host 侧通过解析 VSCODE_PROCESS_TITLE
// 中的 [N-M] 得到相同的 N, 两边自然对齐, 无需任何映射表。

/** windowId → SSE response set (extension host 订阅) */
const logStreams = new Map<number, Set<any>>()

/** 查询 windowId 是否有 SSE 订阅者 (Editor 窗口有, Agent Window 没有) */
export function hasLogSubscriber(windowId: number): boolean {
  const s = logStreams.get(windowId)
  return !!s && s.size > 0
}

/** 向指定 windowId 的所有 SSE 连接推送结构化日志 */
export function pushLog(windowId: number, entry: LogEntry): void {
  const streams = logStreams.get(windowId)
  if (!streams || streams.size === 0)
    return
  const data = `data: ${JSON.stringify(entry)}\n\n`
  for (const reply of streams) {
    try {
      reply.raw.write(data)
    }
    catch {
      streams.delete(reply)
    }
  }
}

/** 向所有 SSE 连接广播结构化日志 (系统级日志, 无特定 windowId) */
export function broadcastLog(entry: LogEntry): void {
  const data = `data: ${JSON.stringify(entry)}\n\n`
  for (const [, streams] of logStreams) {
    for (const reply of streams) {
      try {
        reply.raw.write(data)
      }
      catch {
        streams.delete(reply)
      }
    }
  }
}

/** 从请求头 x-client-wid 读取 windowId (由 inject-patch 注入) */
function resolveWindowId(req: any): number | null {
  const v = req.headers['x-client-wid']
  if (typeof v !== 'string')
    return null
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Refresh signal — 通过 /byok/events SSE 端点推送给所有 renderer。
 *
 * 触发链路:
 *   extension toggleByok 命令 / providers.json / routes.json 变更
 *     → bumpRefreshSignal()
 *     → 向所有已连接的 renderer SSE 推送 "event: refresh"
 *     → renderer EventSource 监听 refresh 事件
 *     → globalThis.__byokRefreshModels()
 *     → globalThis.__byokAiSvc.refreshDefaultModels()  (引用由 patch-inject 字符串重写时泄漏)
 *     → 客户端模型选择器自动刷新
 *
 * 替换了早期的轮询方案 (renderer 每 3s GET /byok/refresh-signal + counter 对比)。
 * Push 模式零心跳,消除了 trace 级别的轮询噪声,同时响应更及时。
 */
const refreshEventStreams = new Set<any>()

let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null

export function bumpRefreshSignal(): void {
  if (refreshDebounceTimer)
    clearTimeout(refreshDebounceTimer)
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null
    let sent = 0
    for (const reply of refreshEventStreams) {
      try {
        reply.raw.write(`event: refresh\ndata: {}\n\n`)
        sent++
      }
      catch {
        refreshEventStreams.delete(reply)
      }
    }
    logger.info({ connections: sent }, '[SRV] refresh signal pushed')
  }, 500)
}

/**
 * 向所有 renderer SSE 推送 REST redirect 列表变更。
 *
 * inject-patch 的 globalThis.fetch wrapper 里 _restPaths / _restSet 是安装时写死的,
 * 不随 routes.json 运行时变化。toggle BYOK 后需要通过 SSE 推送新列表让 renderer
 * 热更新,否则 OFF 模式下 /auth/poll 仍被拦截到本地,阻断真实登录流程。
 *
 * inject-patch 端监听 `event: routes`, 收到后替换 _restPaths + _restSet。
 */
export function pushRoutesUpdate(restPaths: string[]): void {
  let sent = 0
  const data = JSON.stringify(restPaths)
  for (const reply of refreshEventStreams) {
    try {
      reply.raw.write(`event: routes\ndata: ${data}\n\n`)
      sent++
    }
    catch {
      refreshEventStreams.delete(reply)
    }
  }
  logger.info({ connections: sent, restPaths: restPaths.length }, '[SRV] routes update pushed')
}

export interface StartServerOptions extends RuntimeConfigInit {}

export async function startServer(opts: StartServerOptions): Promise<{ host: string, port: number }> {
  if (app) {
    throw new Error('Server already running')
  }

  await initRuntimeConfig(opts)
  await ensureRoutesFile()
  await ensureProvidersFile()
  await initDatabase()

  const host = opts.host || '127.0.0.1'
  const port = opts.port || 39831

  const server = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    bodyLimit: 10 * 1024 * 1024,
  })

  // onRequest: 绑定 windowId 到 AsyncLocalStorage, 后续整个处理链
  // 的 logger 调用都会自动路由到正确的窗口 (per-window SSE 推送)
  server.addHook('onRequest', (req, _reply, done) => {
    const wid = resolveWindowId(req)
    if (wid !== null)
      enterWindowContext(wid)
    done()
  })

  // Request logging — 通过 logger.xxx() 输出, 由 AsyncLocalStorage 上下文
  // (在 onRequest hook 中设置) 自动路由到正确的 windowId SSE 连接。
  //
  // 格式统一为 "[CATEGORY] 主体 → 状态 (耗时)":
  //   - [GRPC]  aiserver.v1.AiService/AvailableModels → 200 (5ms)
  //   - [GET]   /byok/refresh-signal → 200 (0ms)
  //   - [POST]  /auth/logout → 200 (1ms)
  //
  // 判定顺序 (顺序很重要):
  //   1. TRACE_PATHS 优先 — 高频轮询端点会被 RE_CONNECT_RPC_PATH 错误匹配
  //      (e.g. /auth/full_stripe_profile → 捕获 auth/full_stripe_profile), 必须先拦截。
  //   2. ConnectRPC 服务名匹配 — service 段必须含点 (aiserver.v1.AiService),
  //      与扁平 REST 路径区分。
  //   3. 其他 REST 端点 → debug
  server.addHook('onResponse', (req, reply, done) => {
    const url = req.url
    const status = reply.statusCode
    const rt = reply.elapsedTime?.toFixed(0) ?? '?'

    if (TRACE_PATHS.has(url)) {
      logger.trace(`[${req.method}] ${url} → ${status} (${rt}ms)`)
      done()
      return
    }

    const match = url.match(RE_CONNECT_RPC_PATH)
    if (match && match[1].includes('.')) {
      const [, svc, method] = match
      const shortSvc = svc.split('.').pop()
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      logger[level](`[GRPC] ${shortSvc}/${method} → ${status} (${rt}ms)`)
      done()
      return
    }

    logger.debug(`[${req.method}] ${url} → ${status} (${rt}ms)`)
    done()
  })

  await server.register(cors, { origin: true })
  await server.register(fastifyConnectPlugin, { routes })

  // ── SSE 日志流 + 窗口注册 ──

  // 诊断端点 — 查看 SSE 连接状态 (log-stream per-window + events 广播)
  server.get('/byok/debug', async () => ({
    logStreams: Array.from(logStreams.entries()).map(([wid, set]) => ({
      windowId: wid,
      connections: set.size,
    })),
    refreshEventConnections: refreshEventStreams.size,
  }))

  // SSE 公共头 — reply.raw.writeHead 绕过 Fastify 管道,
  // 必须手动包含 CORS header (renderer EventSource 受浏览器 CORS 策略限制)
  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  }

  // Extension host SSE 订阅 — per-windowId 日志流
  server.get('/byok/log-stream', async (req, reply) => {
    const wid = Number((req.query as any).windowId)
    if (Number.isNaN(wid)) {
      reply.code(400).send({ error: 'windowId required' })
      return
    }
    if (!logStreams.has(wid))
      logStreams.set(wid, new Set())
    logStreams.get(wid)!.add(reply)

    reply.raw.writeHead(200, sseHeaders)
    reply.raw.write(`data: ${JSON.stringify(`[INFO] log stream connected (windowId=${wid})`)}\n\n`)
    // hijack: 不让 Fastify 关闭 response
    reply.hijack()

    req.raw.on('close', () => {
      logStreams.get(wid)?.delete(reply)
    })
  })

  // Renderer SSE 订阅 — refresh 事件推送 (BYOK mode / providers 变更时触发模型列表刷新)
  // 广播式: 所有 renderer 都订阅同一条流, 不按窗口过滤,
  // 因为 providers / routes 变更是全局事件, 每个窗口都需要刷新。
  server.get('/byok/events', async (req, reply) => {
    refreshEventStreams.add(reply)
    reply.raw.writeHead(200, sseHeaders)
    reply.raw.write(`: connected\n\n`)
    // 立即推送当前 REST redirect 列表 — inject-patch 初始只含 BASE,
    // 需要 server 就绪后推送完整列表才能拦截 BYOK 路径
    const currentRestPaths = loadRoutes().redirect.filter((r: string) => r.startsWith('REST:')).map((r: string) => r.slice(5))
    reply.raw.write(`event: routes\ndata: ${JSON.stringify(currentRestPaths)}\n\n`)
    reply.hijack()

    req.raw.on('close', () => {
      refreshEventStreams.delete(reply)
    })
  })

  // BYOK toggle — renderer (glass sidebar) 通过 fetch 调用
  server.post('/byok/toggle', async () => {
    const next = await toggleByokMode()
    const restPaths = next.redirect
      .filter((r: string) => r.startsWith('REST:'))
      .map((r: string) => r.slice(5))
    pushRoutesUpdate(restPaths)
    bumpRefreshSignal()
    logger.info({ byokMode: next.byokMode }, '[SRV] BYOK toggled via REST')
    return { byokMode: next.byokMode }
  })

  // Fake auth endpoints
  server.get('/health', async () => ({ ok: true, mode: 'byok', version: EXTENSION_VERSION }))

  // Extension-host-only handoff. A newer extension may replace an older owner,
  // while equal or older versions remain remote to avoid takeover loops.
  server.post('/byok/takeover', async (req, reply) => {
    if (req.headers.origin || !isLoopbackAddress(req.socket.remoteAddress)) {
      return reply.code(403).send({ accepted: false, reason: 'only local extension hosts may request takeover' })
    }

    const requesterVersion = (req.body as { requesterVersion?: unknown } | null)?.requesterVersion
    if (typeof requesterVersion !== 'string' || !isNewerVersion(requesterVersion, EXTENSION_VERSION)) {
      return reply.code(409).send({
        accepted: false,
        ownerVersion: EXTENSION_VERSION,
        reason: 'requester must be newer than the current owner',
      })
    }

    reply.raw.once('finish', () => {
      void stopServer(requesterVersion).catch((error) => {
        logger.error({ err: error }, '[SRV] version takeover shutdown failed')
      })
    })
    return reply.code(202).send({ accepted: true, ownerVersion: EXTENSION_VERSION })
  })

  server.get('/auth/full_stripe_profile', async () => ({
    membershipType: 'ultra',
    paymentId: 'byok_local',
    subscriptionStatus: 'active',
    verifiedStudent: false,
    trialEligible: false,
    trialLengthDays: 0,
    isOnStudentPlan: false,
    isOnBillableAuto: false,
    customerBalance: null,
    trialWasCancelled: false,
    isTeamMember: false,
    teamMembershipType: null,
    individualMembershipType: 'ultra',
    lastPaymentFailed: false,
    pendingCancellationDate: null,
    isYearlyPlan: false,
  }))

  server.get('/auth/stripe_profile', async (_req, reply) => {
    reply.type('text/plain').send('byok_local')
  })

  server.get('/auth/has_valid_payment_method', async () => ({ hasValidPaymentMethod: true }))
  server.post('/auth/logout', async () => ({ ok: true }))
  server.get('/auth/poll', async () => ({ accessToken: 'byok-token', authId: 'byok-user' }))

  // 日志分发回调: 请求内 → pushLog (per-window), 请求外 → broadcastLog (所有窗口)
  setLogBroadcast(broadcastLog)
  setLogPush(pushLog)
  setLogSubscriberCheck(hasLogSubscriber)

  try {
    await server.listen({ port, host })
  }
  catch (err) {
    app = null
    try {
      await server.close()
    }
    catch { /* noop */ }
    try {
      await closeAgentDatabase()
    }
    catch { /* noop */ }
    throw err
  }
  app = server
  logger.info(`[SRV] listening at http://${host}:${port}`)

  return { host, port }
}

export function broadcastShutdown(takeoverVersion?: string): void {
  const msg = `event: shutdown\ndata: ${JSON.stringify({ takeoverVersion })}\n\n`
  for (const [, streams] of logStreams) {
    for (const reply of streams) {
      try {
        reply.raw.end(msg)
      }
      catch { /* noop */ }
    }
  }
  for (const reply of refreshEventStreams) {
    try {
      reply.raw.end(msg)
    }
    catch { /* noop */ }
  }
  logStreams.clear()
  refreshEventStreams.clear()
  logger.info('[SRV] shutdown broadcast sent')
}

export async function stopServer(takeoverVersion?: string): Promise<void> {
  if (!app)
    return
  const server = app
  app = null
  broadcastShutdown(takeoverVersion)
  try {
    await server.close()
  }
  finally {
    await closeAgentDatabase()
  }
}

export function isServerRunning(): boolean {
  return app !== null
}
