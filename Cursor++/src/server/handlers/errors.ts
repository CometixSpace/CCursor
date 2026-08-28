/**
 * ByokError → ConnectError 统一包装 (阶段 1, 最小可用)
 *
 * ## 设计目标
 *
 * Cursor 客户端 Composer input 上方的"retry banner"只会在 SSE 流以 ConnectError
 * 结尾且 error.details 里包含 `aiserver.v1.ErrorDetails` Any 时才会触发。
 *
 * 逆向摘要 (workbench.desktop.main.js):
 *   - 客户端 `P7(ConnectError)` 通过 `findDetails(ErrorDetailsSchema).at(0)` 解包
 *   - `composer.maybeThrowErrorAndRetry` 把解包结果写入 ComposerData.submitErrorDetails
 *   - Glass Composer 的 `Lzv` React 组件订阅此字段渲染 banner
 *   - `is_retryable = true` 决定"Try again"按钮是否出现 (未设置时默认 true)
 *   - 点击 retry 会重发最后一条 human bubble, 不带任何 resumeToken
 *
 * 所以 BYOK server 要做的事就一件: 遇到错误时抛一个 ConnectError, details 里带
 * 正确构造的 ErrorDetails message。阶段 1 暂时不做按根因细分 (AuthError /
 * ConfigError / UpstreamError / ProtocolError / ToolError 这些), 先用 3 个粗粒度
 * 工厂覆盖现有 3 个 catch 点。细分会在阶段 2 (Error 类层级 + provider 适配器)
 * 展开。
 *
 * ## 使用
 *
 *   throw makeProviderError(e)                      // LLM stream 崩了 (通常 retryable)
 *   throw makeToolError(e)                          // 工具调用崩了 (通常 retryable)
 *   throw makeModelNotFoundError(modelId)           // 未登记模型 (不可 retry)
 *
 * ## 阶段 1 的简化
 *
 * - 只有 3 个工厂 + 1 个内部 make() — 不是完整的 class 层级
 * - 所有错都用 `Code.Internal` — 客户端不看 Connect code, 只看 ErrorDetails
 * - title / detail 直接从原始 error 提取, 不做二次翻译
 * - additional_info 塞了 errorClass / stack preview, 方便调试
 */
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
// ErrorDetails / CustomErrorDetails 自 3.17.8 起由 emitter 拆入 shared 包 ——
// 它们同时被 agent_v1 与 aiserver_v1 引用,触发跨包提取。类型本身未变。
import {
  CustomErrorDetailsSchema,
  ErrorDetails_Error,
  ErrorDetailsSchema,
} from '../gen/aiserver_v1_shared_pb'

export interface MakeByokErrorOptions {
  /** aiserver.v1.ErrorDetails.Error enum — 决定客户端走哪条 gating 分支 */
  errorCode: ErrorDetails_Error
  /** Banner 粗体标题 */
  title: string
  /** Banner Markdown 正文 */
  detail: string
  /** true 时 banner 上出现"Try again"按钮 (默认 true, 参考 workbench.desktop.main.js:44074) */
  isRetryable?: boolean
  /** 附加到 additional_info 里的 k/v (工具名 / 模型 ID / request id 等) */
  additionalInfo?: Record<string, string>
  /** 原始 error, 会绑到 ConnectError.cause 方便上游日志 */
  cause?: unknown
}

/**
 * 构造一个带 aiserver.v1.ErrorDetails outgoing detail 的 ConnectError。
 *
 * ## Connect Code 选择(非常重要)
 *
 * 客户端在 **non-Glass Composer 路径** (EOi 组件, 对话气泡内 inline error) 里,
 * detail 文案渲染有一条硬编码 gating:
 *
 *   switch (connectCode) {
 *     case Code.Internal:
 *     case Code.Unknown:
 *       return "An unexpected error occurred on our servers. Please try again..."
 *     default:
 *       return details.detail ?? errorMessage ?? "Connection failed..."
 *   }
 *
 * 意思是: 只要 ConnectError.code 是 `Internal` 或 `Unknown`, 客户端就会
 * **完全忽略我们传的 details.detail**, 直接替换成硬编码兜底文案。
 *
 * 所以我们必须用其他 Connect Code 来保证 detail 能被原样渲染:
 *
 *   - `Code.Unavailable`       (14) — 可 retry 的上游临时错 (429 / 5xx / stream 断)
 *   - `Code.FailedPrecondition` (9) — 需要改配置才能恢复的永久错 (未登记模型 / 认证错)
 *
 * Glass Composer 的 banner 组件 (Lzv/D40/P40) 不看 connect code, 直接透传
 * details.title / details.detail, 所以对它来说用什么 code 都一样 —— 这里
 * 的选择纯粹是为了兼容 non-Glass 路径。
 */
export function makeByokConnectError(opts: MakeByokErrorOptions): ConnectError {
  const isRetryable = opts.isRetryable ?? true
  const errorDetails = create(ErrorDetailsSchema, {
    error: opts.errorCode,
    details: create(CustomErrorDetailsSchema, {
      title: opts.title,
      detail: opts.detail,
      isRetryable,
      additionalInfo: opts.additionalInfo ?? {},
    }),
    isExpected: false,
  })

  // 按 retryable 语义二分 Connect Code, 避免 Internal/Unknown 触发客户端
  // EOi 分支的硬编码文案替换。
  const connectCode = isRetryable ? Code.Unavailable : Code.FailedPrecondition

  return new ConnectError(
    opts.title,
    connectCode,
    undefined,
    [{ desc: ErrorDetailsSchema, value: errorDetails }],
    opts.cause,
  )
}

// ── 粗粒度工厂 ────────────────────────────────────────────────

/**
 * LLM provider 调用层错误 (流中断 / 429 / 5xx / 协议错 / 鉴权错)。
 *
 * 阶段 1 没有 ByokError 类层级, 也没在 provider 层做 HTTP status 判别,
 * 这里只能靠 **错误消息前缀的启发式匹配** 把观测到的 "retry 必然无效" 类
 * (图 31/33/34/35/36/37/38/39) 挑出来, 强制 isRetryable=false。
 *
 * 其他未识别的错保守默认可 retry, 这样图 30 (stream 断) 和 429/5xx 之类
 * 真正的 transient 错能一键恢复。
 *
 * 这个启发式是临时方案, 阶段 2 会被 provider 层的 HTTP status 判断替代。
 */
export function makeProviderError(cause: unknown, extra?: Record<string, string>): ConnectError {
  const message = extractErrorMessage(cause)
  const retryable = inferRetryable(message)
  const errorCode = retryable
    ? ErrorDetails_Error.PROVIDER_ERROR
    : ErrorDetails_Error.CUSTOM
  return makeByokConnectError({
    errorCode,
    title: retryable ? 'LLM provider error' : 'BYOK request rejected',
    detail: message,
    isRetryable: retryable,
    additionalInfo: {
      errorClass: getErrorClass(cause),
      retryableHint: retryable ? 'true' : 'false',
      ...extra,
    },
    cause,
  })
}

/**
 * 启发式: 识别 retry 必然无效的错误类型。
 *
 * 覆盖的观测类 (实际截图编号 30-39):
 *   - 401/403 auth 错     → 图 38   (api key 错)
 *   - 404 路由错          → 图 31, 34 (baseUrl 错)
 *   - SDK auth 参数缺失   → 图 35   (Anthropic SDK 报 "Could not resolve authentication method")
 *   - Anthropic 400 协议错 → 图 33   (tool_use 无配对 tool_result)
 *   - Anthropic 400 校验错 → 图 39   (tool name 正则不匹配)
 *   - OpenAI 400 协议错   → 图 36   (no tool output for function call)
 *   - Gemini 400 校验错   → 图 37   (function_response.name empty)
 *
 * 未匹配的错误保守默认可 retry (图 30 stream 断 / 图 32 JSON 解析 / 429 / 5xx)。
 */
function inferRetryable(rawMessage: string): boolean {
  const msg = rawMessage.toLowerCase()

  // 鉴权类 — retry 无效
  if (/\b401\b/.test(msg) || msg.includes('unauthorized') || msg.includes('auth_error'))
    return false
  if (/\b403\b/.test(msg) || msg.includes('forbidden'))
    return false
  if (msg.includes('could not resolve authentication'))
    return false

  // 路由 / endpoint 错 — retry 无效
  if (/\b404\b/.test(msg) || msg.includes('page not found') || msg.includes('not found'))
    return false

  // upstream 400 请求体校验错 — retry 无效 (我们自己 codec / builder bug)
  if (msg.includes('invalid_request_error'))
    return false
  if (msg.includes('tool_use ids were found without tool_result'))
    return false
  if (msg.includes('no tool output found for function call'))
    return false
  if (msg.includes('function_response.name'))
    return false
  if (msg.includes('does not match pattern'))
    return false

  // 其他 — 可 retry
  return true
}

/** 工具执行层错误 (非用户 abort, 非 tool 自身返回的 error envelope) */
export function makeToolError(cause: unknown, toolName?: string): ConnectError {
  const message = extractErrorMessage(cause)
  return makeByokConnectError({
    errorCode: ErrorDetails_Error.CUSTOM,
    title: toolName ? `Tool "${toolName}" failed` : 'Tool execution failed',
    detail: message,
    isRetryable: true,
    additionalInfo: {
      errorClass: getErrorClass(cause),
      ...(toolName ? { toolName } : {}),
    },
    cause,
  })
}

/** 未在 providers.json 中登记的 modelId — 必须先改配置, 不能 retry */
export function makeModelNotFoundError(modelId: string): ConnectError {
  return makeByokConnectError({
    errorCode: ErrorDetails_Error.BAD_MODEL_NAME,
    title: 'Model not registered',
    detail:
      `Model \`${modelId}\` was not found in \`~/.ccursor/providers.json\`.\n\n`
      + 'Open the Cursor++ side panel → Providers, add the model, then try again.',
    isRetryable: false,
    additionalInfo: { modelId },
  })
}

/** 当前轮包含图片，但没有可用的多模态 Agent 模型。 */
export function makeVisionModelConfigurationError(
  detail: string,
  additionalInfo: Record<string, string> = {},
): ConnectError {
  return makeByokConnectError({
    errorCode: ErrorDetails_Error.BAD_MODEL_NAME,
    title: 'Vision model is not configured',
    detail,
    isRetryable: false,
    additionalInfo,
  })
}

// ── 内部 helper ────────────────────────────────────────────────

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error)
    return e.message || e.name || 'Unknown error'
  if (typeof e === 'string')
    return e
  try {
    return JSON.stringify(e)
  }
  catch {
    return 'Unknown error'
  }
}

function getErrorClass(e: unknown): string {
  if (e instanceof Error)
    return e.constructor?.name || 'Error'
  return typeof e
}
