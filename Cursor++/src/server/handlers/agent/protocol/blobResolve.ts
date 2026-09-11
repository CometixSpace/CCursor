/**
 * Blob 形态字段的二次解包
 *
 * parseRunRequest records references only. Resolution reads the explicit run
 * workspace after upload handoff or client KV retrieval.
 */
import type { ParsedRunRequest } from './types'
import type { RunBlobStore } from '../blobStore'
import { logger } from '../../../logger'

/** 收集 parsed 里所有需要从 blobStore 取回的 blobId (当前仅 extraContextEntries) */
export function collectExtraContextBlobIds(parsed: ParsedRunRequest): string[] {
  return parsed.extraContextEntries
    .filter(e => e.data === undefined && !!e.blobId)
    .map(e => e.blobId!)
}

/**
 * 从 blobStore 里取回 extraContextEntries 的 blob 内容,就地替换 blobId → data。
 * 可重复调用: 调用方在向客户端回取未命中的 blob 之后再 resolve 一次。
 *
 * blobStore 里的数据以 base64 存,这里解码为 UTF-8 文本(extra context 本质是
 * 长文本片段,不做 JSON.parse 避免遇到纯文本时失败)。
 * Unresolved IDs stay visible to the orchestrator, which rejects missing explicit
 * attachments before generating instead of silently inserting pending markers.
 */
export function resolveExtraContextBlobs(parsed: ParsedRunRequest, store: RunBlobStore): { resolved: number, missed: number } {
  let resolved = 0
  let missed = 0
  for (const entry of parsed.extraContextEntries) {
    if (entry.data !== undefined || !entry.blobId)
      continue
    const cached = store.getCachedBlob(entry.blobId)
    if (cached === undefined) {
      missed++
      continue
    }
    try {
      entry.data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cached, 'base64'))
      delete entry.blobId
      resolved++
    }
    catch (err) {
      logger.warn(
        { blobId: entry.blobId, error: (err as Error).message },
        '[PROTOCOL] failed to decode extra_context blob as utf-8',
      )
      missed++
    }
  }
  if (resolved > 0 || missed > 0) {
    logger.debug({ resolved, missed }, '[PROTOCOL] resolveExtraContextBlobs')
  }
  return { resolved, missed }
}
