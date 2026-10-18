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
import { toJson } from '@bufbuild/protobuf'
import { ConnectError } from '@connectrpc/connect'
import { AgentClientMessageSchema, AgentService } from '../../gen/agent_v1_pb'
import { handleRunRequest } from '../../handlers/agent/agentOrchestrator'
import { cacheBlob } from '../../handlers/agent/blobStore'
import { registerCloneLineage } from '../../handlers/agent/cloneRegistry'
import { ModelNotFoundError } from '../../handlers/models/mapper'
import { makeByokConnectError, makeModelNotFoundError, makeProviderError } from '../../handlers/errors'
import { ErrorDetails_Error } from '../../gen/aiserver_v1_shared_pb'
import { appendMessage, closeSession, createEphemeralSession, getOrCreateSession, markSessionClosed, pushSessionMessage, waitForMessage } from '../../handlers/agent/session'
import { registerBidiReceiver } from '../../handlers/bidiMailbox'
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
  if (error instanceof ModelNotFoundError)
    return makeModelNotFoundError(error.modelId)
  return makeProviderError(error, context)
}

function isStreamDestroyedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('stream was destroyed')
    || error.message.includes('write after end')
    || error.message.includes('ERR_STREAM_DESTROYED')
}

export default (router: ConnectRouter) => {
  router.service(AgentService, {
    /** Bidi streaming (HTTP/2) */
    async* run(requests) {
      logger.info('[SVC] AgentService/Run bidi started')

      const iterator = requests[Symbol.asyncIterator]()
      let firstMsg: Record<string, unknown> | null = null
      let bidiQueuedUserText: string | undefined

      while (true) {
        const next = await iterator.next()
        if (next.done)
          return
        const msg = toJson(AgentClientMessageSchema, next.value) as Record<string, unknown>
        if ('clientHeartbeat' in msg || 'kvClientMessage' in msg)
          continue
        if ('conversationAction' in msg && !bidiQueuedUserText) {
          const ca = msg.conversationAction as Record<string, unknown> | undefined
          const ua = ca?.userMessageAction as Record<string, unknown> | undefined
          const um = ua?.userMessage as Record<string, unknown> | undefined
          bidiQueuedUserText = typeof um?.text === 'string' && um.text ? um.text : undefined
          logger.info({ queuedUserText: bidiQueuedUserText?.slice(0, 80) }, '[SVC] Run bidi got conversationAction before runRequest')
          continue
        }
        if ('runRequest' in msg) {
          if (bidiQueuedUserText) {
            const rr = msg.runRequest as Record<string, unknown>
            const action = rr?.action as Record<string, unknown> | undefined
            if (action && !action.userMessageAction && action.resumeAction) {
              action.userMessageAction = {
                userMessage: { text: bidiQueuedUserText },
                requestContext: (action.resumeAction as Record<string, unknown>)?.requestContext,
              }
              delete action.resumeAction
              logger.info({ textLen: bidiQueuedUserText.length }, '[SVC] bidi: injected queued userText into resumeAction → userMessageAction')
            }
          }
          firstMsg = msg
          break
        }
      }

      const session = createEphemeralSession(`bidi-${Date.now()}`)
      const pump = (async () => {
        try {
          while (true) {
            const next = await iterator.next()
            if (next.done)
              break
            const msg = toJson(AgentClientMessageSchema, next.value) as Record<string, unknown>
            if ('clientHeartbeat' in msg || 'kvClientMessage' in msg)
              continue
            pushSessionMessage(session, msg)
          }
        }
        finally {
          markSessionClosed(session)
        }
      })()

      try {
        for await (const frame of handleRunRequest(firstMsg, session)) {
          yield frame
        }
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
        await pump.catch((e) => {
          logger.warn({ error: (e as Error).message }, '[SVC] Run bidi pump error')
        })
      }
    },

    /** Server streaming SSE (HTTP/1.1 降级) */
    async* runSSE(req) {
      const requestId = req.requestId
      if (!requestId) {
        // 缺 requestId 无法关联到 bidi session, 走静默 return 让 SSE 正常结束。
        // 这是协议层问题而不是业务错, 不触发 retry banner。
        logger.warn('[SVC] RunSSE called without requestId')
        return
      }

      logger.info({ requestId }, '[SVC] AgentService/RunSSE started')
      const session = getOrCreateSession(requestId)
      const releaseBidi = registerBidiReceiver(requestId, data => appendMessage(requestId, data))

      try {
        const firstMsg = await waitForMessage(session)
        if (!firstMsg) {
          // Session 建立后没等到首条消息 —— 通常是 BidiAppend 协调慢或客户端问题。
          // 也构造一个 ErrorDetails 让客户端 banner 提示, 可 retry。
          logger.warn({ requestId }, '[SVC] RunSSE no message received (timeout)')
          throw makeByokConnectError({
            errorCode: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT,
            title: 'Agent session timeout',
            detail: 'RunSSE waited for the first BidiAppend message but none arrived. This is usually a client-side routing issue — please retry.',
            isRetryable: true,
            additionalInfo: { requestId },
          })
        }

        logger.info({ requestId, keys: Object.keys(firstMsg) }, '[SVC] RunSSE first message')

        // 队列消息场景: 客户端先发 conversationAction(含用户文本), 再发 runRequest。
        // 如果首条不是 runRequest, 提取 conversationAction 中的 userText, 继续等 runRequest。
        let queuedUserText: string | undefined
        let actualFirstMsg = firstMsg

        if (!('runRequest' in firstMsg) && 'conversationAction' in firstMsg) {
          const ca = firstMsg.conversationAction as Record<string, unknown> | undefined
          const ua = ca?.userMessageAction as Record<string, unknown> | undefined
          const um = ua?.userMessage as Record<string, unknown> | undefined
          queuedUserText = typeof um?.text === 'string' && um.text ? um.text : undefined
          logger.info({ requestId, queuedUserText: queuedUserText?.slice(0, 80) }, '[SVC] RunSSE got conversationAction before runRequest — waiting for runRequest')
          const nextMsg = await waitForMessage(session)
          if (!nextMsg || !('runRequest' in nextMsg)) {
            logger.warn({ requestId, nextMsgKeys: nextMsg ? Object.keys(nextMsg) : null }, '[SVC] RunSSE never received runRequest after conversationAction')
            return
          }
          actualFirstMsg = nextMsg
        }

        if ('runRequest' in actualFirstMsg) {
          // 如果 runRequest 是 resumeAction 且有来自 conversationAction 的用户文本, 注入
          if (queuedUserText) {
            const rr = actualFirstMsg.runRequest as Record<string, unknown>
            const action = rr?.action as Record<string, unknown> | undefined
            if (action && !action.userMessageAction && action.resumeAction) {
              action.userMessageAction = {
                userMessage: { text: queuedUserText },
                requestContext: (action.resumeAction as Record<string, unknown>)?.requestContext,
              }
              delete action.resumeAction
              logger.info({ requestId, textLen: queuedUserText.length }, '[SVC] injected queued userText into resumeAction → userMessageAction')
            }
          }
          for await (const frame of handleRunRequest(actualFirstMsg, session)) {
            yield frame
          }
        }
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
        releaseBidi()
        closeSession(requestId)
      }
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
     * 客户端在发 RunRequest **之前**会先 chunk(≤100 条/批)上传 blobs,
     * Server 把每条存进 blobCache,key 为 utf-8 decode 后的 blob id 字符串,
     * value 为 base64 encoded bytes。下游 parseRunRequest + resolveExtraContextBlobs
     * 直接从 blobCache 命中。
     *
     * 编码对齐 (与 parseRunRequest.ts 里的 extraContextEntries.blob_id 解码一致):
     *   - blob.id (bytes) → TextDecoder.decode → utf-8 string 作为 cache key
     *   - blob.value (bytes) → base64 string 作为 cache value
     *
     * 分片语义:
     *   - chunk_index / total_chunks 只用于客户端进度,server 端逐条 cacheBlob 即可。
     *   - Response 空体只表示 ACK。
     */
    async uploadConversationBlobs(req) {
      const { conversationId, blobs, chunkIndex, totalChunks } = req
      let cached = 0
      for (const blob of blobs) {
        if (!blob.id || blob.id.length === 0)
          continue
        const blobId = Buffer.from(blob.id).toString('utf-8')
        const blobData = Buffer.from(blob.value ?? new Uint8Array()).toString('base64')
        cacheBlob(blobId, blobData)
        cached++
      }
      logger.debug(
        { conversationId, chunkIndex, totalChunks, cached, received: blobs.length },
        '[SVC] UploadConversationBlobs chunk received',
      )
      return {}
    },

    /**
     * NotifyConversationClone — Fork Chat 血缘登记
     *
     * 客户端 "Fork Chat" 时 deepCloneComposer 在本地复制整个对话(重映射所有
     * bubbleId/blobId),完成后调用此 RPC 通知后端这是一次克隆。请求只含血缘元数据
     * (新对话 id ← 源对话 id + 源 requestId),**不含 blob 内容** —— cloned blob
     * 由 UploadConversationBlobs 单独上传并缓存,fork 对话首次 Run 时即可命中重建。
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
