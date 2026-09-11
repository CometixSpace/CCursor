/**
 * agent.v1.AgentService — Agent 模式服务
 *
 * Transport / Session 入口适配层：
 * - 维护 bidi / SSE 生命周期
 * - 建立 session 队列
 * - 将首条 runRequest 交给 agent orchestrator
 *
 * ## 错误处理契约
 *
 * 下游 handler (handleRunRequest / conversationRuntime / ...) 抛出的 error 分两类:
 *
 *   1. **ConnectError with ErrorDetails** —— 已经构造好的客户端友好错误 (通过
 *      makeProviderError/makeToolError/makeModelNotFoundError 等工厂), 直接 rethrow
 *      让 @connectrpc/connect-fastify 序列化到 SSE trailer。客户端 Composer 的
 *      retry banner 依赖这条路径。
 *
 *   2. **其他 Error** —— 裸 Error / ModelNotFoundError / 编码 bug 等, 在顶层 catch
 *      里用 makeProviderError 兜底包装后 rethrow。
 *
 * 之前的实现 (静默 log.error + 不 rethrow) 会让所有错误消失 —— 客户端只看到 SSE
 * 突然结束, 没有 banner。这里的修复是此功能的必要前置。
 */
import type { ConnectRouter } from '@connectrpc/connect'
import { randomUUID } from 'node:crypto'
import { toBinary, toJson } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { type AgentClientMessage, AgentClientMessageSchema, AgentService } from '../../gen/agent_v1_pb'
import { handleRunRequest } from '../../handlers/agent/agentOrchestrator'
import { uploadHandoff } from '../../handlers/agent/uploadHandoff'
import { registerCloneLineage } from '../../handlers/agent/cloneRegistry'
import { ModelNotFoundError } from '../../handlers/models/mapper'
import { makeByokConnectError, makeModelNotFoundError, makeProviderError } from '../../handlers/errors'
import { ErrorDetails_Error } from '../../gen/aiserver_v1_shared_pb'
import { type AgentSession, attachSessionTransport, closeSession, createEphemeralSession, getOrCreateSession, markSessionClosed, pushSessionMessage, recordSessionBlobRequestSent } from '../../handlers/agent/session'
import { waitForRunRequest } from '../../handlers/agent/transportStartup'
import { logger } from '../../logger'

/**
 * 统一错误归一化: 任何下游冒上来的 error 都要转换成带 ErrorDetails 的 ConnectError,
 * 否则客户端 retry banner 不会显示。
 *
 * 优先级:
 *   1. 已经是 ConnectError → 直接返回 (下游工厂已构造好)
 *   2. ModelNotFoundError → 专用工厂 (is_retryable=false, title 带 modelId)
 *   3. 其他 Error → makeProviderError 兜底 (走 inferRetryable 启发式)
 */
function normalizeToConnectError(error: unknown, context: Record<string, string>): ConnectError {
  if (error instanceof ConnectError)
    return error
  if (error instanceof Error && error.name === 'AbortError')
    return new ConnectError(error.message, Code.Canceled, undefined, undefined, error)
  if (error instanceof ModelNotFoundError)
    return makeModelNotFoundError(error.modelId)
  if (error instanceof Error && error.name.startsWith('Blob')) {
    return makeByokConnectError({
      errorCode: ErrorDetails_Error.CUSTOM,
      title: 'Conversation data unavailable; checkpoint preserved',
      detail: error.message,
      isRetryable: 'retryable' in error && error.retryable === true,
      additionalInfo: { ...context, errorClass: error.name },
      cause: error,
    })
  }
  return makeProviderError(error, context)
}

function isStreamDestroyedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('stream was destroyed')
    || error.message.includes('write after end')
    || error.message.includes('ERR_STREAM_DESTROYED')
}

/** Native generator.return() queues behind next(); close the owned session first. */
function withSessionConsumerLifecycle<Frame>(
  createFrames: (claimSession: (session: AgentSession) => void) => AsyncGenerator<Frame, void, unknown>,
): AsyncGenerator<Frame, void, unknown> {
  let ownedSession: AgentSession | undefined
  const iterator = createFrames(session => {
    ownedSession = session
  })
  const releaseOwnership = (): void => {
    ownedSession = undefined
  }
  const interrupt = (): void => {
    if (ownedSession)
      markSessionClosed(ownedSession)
  }
  return {
    async next(value) {
      try {
        const result = await iterator.next(value)
        if (result.done)
          releaseOwnership()
        return result
      }
      catch (error) {
        releaseOwnership()
        throw error
      }
    },
    return(value) {
      interrupt()
      return iterator.return(value).finally(releaseOwnership)
    },
    throw(error) {
      interrupt()
      return iterator.throw(error).finally(releaseOwnership)
    },
    [Symbol.asyncIterator]() { return this },
  }
}

/**
 * Bidi (HTTP/2) 上行泵: 从连接建立起, 把客户端流上的每一帧推入 session 队列,
 * 供 waitForMessageMatching 消费; 流结束时关闭 session。
 *
 * 只有 clientHeartbeat 被丢弃 —— 它纯粹是保活, 没有任何等待方。
 *
 * kvClientMessage **必须入队**: getBlobArgs 的回包 (kvClientMessage.getBlobResult)
 * 正是经这条路到达 requestContextParts / 历史 blob 回源的 waitForMessageMatching。
 * 此前这里把 kvClientMessage 与 clientHeartbeat 一并 continue 掉, 结果 bidi 模式下
 * 每次 getBlobArgs 都等到 BLOB_FETCH_TIMEOUT_MS 超时才放弃; SSE 降级路径
 * (BidiAppend → appendMessage) 从未做过这种过滤, 所以只有 bidi 受影响。
 * SetBlobResult also reaches the run-owned KV waiters; checkpoint publication
 * requires their successful acknowledgement rather than merely queueing a send.
 */
export async function pumpBidiClientMessages(
  iterator: AsyncIterator<AgentClientMessage>,
  session: AgentSession,
): Promise<void> {
  try {
    while (!session.closed && session.cancelledReason === undefined) {
      let resolveClosed!: () => void
      const closed = new Promise<null>((resolve) => {
        resolveClosed = () => resolve(null)
      })
      const onSessionChange = (): void => {
        if (session.closed || session.cancelledReason !== undefined)
          resolveClosed()
      }
      session.listeners.add(onSessionChange)
      // Output can finish or fail while the client is still waiting for it.
      // Waiting for client EOF here would prevent that error/EOF from being sent.
      let next: IteratorResult<AgentClientMessage> | null
      try {
        next = await Promise.race([iterator.next(), closed])
      }
      finally {
        session.listeners.delete(onSessionChange)
      }
      if (!next || next.done || session.closed || session.cancelledReason !== undefined)
        break
      const msg = toJson(AgentClientMessageSchema, next.value) as Record<string, unknown>
      if ('clientHeartbeat' in msg)
        continue
      pushSessionMessage(session, msg, toBinary(AgentClientMessageSchema, next.value).byteLength)
    }
  }
  finally {
    markSessionClosed(session)
  }
}

export default (router: ConnectRouter) => {
  router.service(AgentService, {
    /** Bidi streaming (HTTP/2) */
    run(requests, context) {
      return withSessionConsumerLifecycle(async function* (claimSession) {
        logger.info('[SVC] AgentService/Run bidi started')

        const iterator = requests[Symbol.asyncIterator]()
        // Official 3.14.27 transport uses x-request-id, or a fresh UUID. Transport
        // identity is independent of conversationId and saved turn requestIds.
        const session = createEphemeralSession(context.requestHeader.get('x-request-id') || randomUUID())
        const detachTransport = attachSessionTransport(session, context.signal)
        claimSession(session)
        const pump = pumpBidiClientMessages(iterator, session).catch((error: unknown) => {
          session.transportError = error
          markSessionClosed(session)
        })

        try {
          const firstMessage = await waitForRunRequest(session)
          if (firstMessage) {
            for await (const frame of handleRunRequest(firstMessage, session)) {
              context.signal.throwIfAborted()
              if (session.closed || session.cancelledReason !== undefined)
                break
              recordSessionBlobRequestSent(session, frame)
              yield frame
            }
          }
          context.signal.throwIfAborted()
          if (session.transportError)
            throw session.transportError
        }
        catch (error) {
          // 用户中断对话 → stream 已销毁, yield 写入失败 — 正常退出, 不触发 retry banner
          if (isStreamDestroyedError(error)) {
            logger.info({ sessionId: session?.requestId }, '[SVC] Run bidi stream destroyed (client abort)')
            return
          }
          // Bidi (HTTP/2) 路径 —— 同 runSSE, 把下游冒上来的错归一化为 ConnectError
          // + ErrorDetails, 让客户端 retry banner 能识别。
          const sessionIdStr = session?.requestId ?? 'bidi'
          const connErr = normalizeToConnectError(error, { transport: 'bidi', sessionId: sessionIdStr })
          logger.error(
            { sessionId: sessionIdStr, error: (error as Error).message, stack: (error as Error).stack },
            '[SVC] AgentService/Run bidi handler error, rethrowing as ConnectError with ErrorDetails',
          )
          throw connErr
        }
        finally {
          markSessionClosed(session)
          detachTransport()
          // Closing the session releases the pump even with input.next pending.
          await pump
        }
      })
    },

    /** Server streaming SSE (HTTP/1.1 降级) */
    runSSE(req, context) {
      return withSessionConsumerLifecycle(async function* (claimSession) {
        const requestId = req.requestId
        if (!requestId) {
          throw new ConnectError('RunSSE requires request_id', Code.InvalidArgument)
        }

        logger.info({ requestId }, '[SVC] AgentService/RunSSE started')
        const session = getOrCreateSession(requestId)
        const detachTransport = attachSessionTransport(session, context.signal)
        // A duplicate/rejected consumer must never acquire cancellation rights
        // over the existing stream; claim only after successful attachment.
        claimSession(session)

        try {
          const firstMessage = await waitForRunRequest(session)
          if (firstMessage) {
            for await (const frame of handleRunRequest(firstMessage, session)) {
              context.signal.throwIfAborted()
              if (session.closed || session.cancelledReason !== undefined)
                break
              recordSessionBlobRequestSent(session, frame)
              yield frame
            }
          }
          context.signal.throwIfAborted()
          if (session.transportError)
            throw session.transportError
        }
        catch (error) {
          // 用户中断对话 → stream 已销毁, yield 写入失败 — 正常退出
          if (isStreamDestroyedError(error)) {
            logger.info({ requestId }, '[SVC] RunSSE stream destroyed (client abort)')
            return
          }
          // 关键修复 —— 之前这里是 logger.error(...) 后静默吞掉, 导致下游抛出
          // 的任何错误都不会到达客户端, SSE 突然结束, Composer 不会显示 banner。
          //
          // 现在统一归一化为 ConnectError + aiserver.v1.ErrorDetails outgoing
          // detail, 让 @connectrpc/connect-fastify 序列化到 SSE trailer, 客户端
          // @connectrpc 解包后触发 Glass Composer 的 maybeThrowErrorAndRetry,
          // 最终渲染 input 上方的 retry banner。
          const connErr = normalizeToConnectError(error, { transport: 'sse', requestId })
          logger.error(
            { requestId, error: (error as Error).message, stack: (error as Error).stack },
            '[SVC] RunSSE handler error, rethrowing as ConnectError with ErrorDetails',
          )
          throw connErr
        }
        finally {
          detachTransport()
          closeSession(requestId)
        }
      })
    },

    /**
     * Client → Server blob 上传(单次 unary RPC,支持分片)
     *
     * 触发场景:
     *   - selectedContext.extra_context_entries 里有 blob_id 分支(大段 @ 内容)
     *   - selectedContext.selected_documents / selected_videos / selected_images 等走 blob 的字段
     *   - selectedContext.external_links.blob_id (PDF blob)
     *   - selectedContext.selected_pull_requests.blob_id / git_pr_diff_selections.blob_id
     *
     * Client uploads can precede RunRequest; fork uploads are asynchronously
     * queued in chunks of at most 100 IDs and are not a Run completion barrier.
     * Server retains the original key/value bytes in a short-lived handoff,
     * isolated by conversationId. Runs copy only the blobs they reference.
     *
     * 编码对齐 (与 parseRunRequest.ts 里的 extraContextEntries.blob_id 解码一致):
     *   - Blob keys remain bytes; JSON/history versus protobuf decoding belongs
     *     to the consumer, not the upload RPC.
     *
     * 分片语义:
     *   - Chunks are independent (there is no upload attempt id in this RPC).
     *   - Empty response acknowledges handoff acceptance, not client storage.
     */
    async uploadConversationBlobs(req) {
      const { conversationId, blobs, chunkIndex, totalChunks } = req
      uploadHandoff.putChunk({ conversationId, blobs, chunkIndex, totalChunks })
      logger.debug(
        { conversationId, chunkIndex, totalChunks, accepted: blobs.length },
        '[SVC] UploadConversationBlobs chunk received',
      )
      return {}
    },

    /**
     * NotifyConversationClone — Fork Chat 血缘登记
     *
     * Client forks rewrite selected user/turn blobs while retaining unchanged
     * references. This RPC reports lineage only, not completion of blob uploads.
     * 请求只含血缘元数据
     * (新对话 id ← 源对话 id + 源 requestId),**不含 blob 内容** —— cloned blob
     * 由 UploadConversationBlobs 单独上传到短期交接区; 未到达的引用需经 KV 取回。
     *
     * 此前未实现导致客户端收到 unimplemented、重试 3 次并打 metric。现在登记血缘
     * 并 ACK,消除噪音,同时为诊断 / transcript 关联保留映射。
     */
    async notifyConversationClone(req) {
      const { conversationId, sourceConversationId, sourceRequestId } = req
      if (conversationId && sourceConversationId) {
        registerCloneLineage(conversationId, { sourceConversationId, sourceRequestId })
      }
      logger.info(
        { conversationId, sourceConversationId, sourceRequestId },
        '[SVC] NotifyConversationClone (fork chat lineage)',
      )
      return {}
    },
  })
}
