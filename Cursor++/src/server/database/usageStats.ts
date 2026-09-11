/**
 * 每模型 Token 用量统计 — 存储层
 *
 * 按 (本地时区 day, hour, provider_id, model_id) 桶粒度 UPSERT 累加,
 * 由 usageRecorder 在 LLM 流结束时 fire-and-forget 调用 (绝不阻塞流)。
 * 查询侧只做原始行输出, 聚合计算全部交给 Dashboard 前端。
 */
import type { LLMUsage } from '../handlers/llm/types'
import { logger } from '../logger'
import { getAgentDatabase } from './sqlite'

/** 单次 LLM 调用的用量采样 — done 事件携带的 LLMUsage + 模型归属元数据 */
export interface ModelUsageSample {
  providerId: string
  providerName: string
  /** Cursor 模型选择器里的 byok modelId (桶主键之一) */
  modelId: string
  /** provider 实际请求的 api 模型名 */
  apiModel: string
  usage: LLMUsage
}

/** 查询结果行 — snake_case 列名映射为 camelCase */
export interface UsageStatsRow {
  day: string
  hour: number
  providerId: string
  providerName: string
  modelId: string
  apiModel: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  lastUsedAt: number
}

/** 'YYYY-MM-DD' (本地时区) — 注意不能用 toISOString() (UTC 会跨日漂移) */
export function toLocalDayString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * range 参数 → sinceDay 换算 (全部本地时区):
 *   today → 今天 0 点的 'YYYY-MM-DD'
 *   7d/30d → 含今天往前 7/30 天 (用 setDate 回退, 天然规避 DST 毫秒漂移)
 *   all / 未知值 → null (查全部), 未知值由调用方先归一为默认
 */
export function resolveUsageRangeSinceDay(range: string): string | null {
  if (range === 'all')
    return null
  if (range === 'today')
    return toLocalDayString(new Date())
  const backDays = range === '30d' ? 29 : range === '7d' ? 6 : -1
  if (backDays < 0)
    return null
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - backDays)
  return toLocalDayString(startDate)
}

/**
 * 落库一条用量采样 (单条 UPSERT 累加)。
 *
 * 整个函数体 try/catch: getAgentDatabase() 在 DB 未初始化时会同步 throw,
 * 写失败绝不能外抛 — 上游是 fire-and-forget 调用点, 只允许 logger.warn 静默降级。
 */
export async function recordModelUsage(sample: ModelUsageSample): Promise<void> {
  try {
    const now = new Date()
    const day = toLocalDayString(now)
    const hour = now.getHours()
    await getAgentDatabase().run(`
      INSERT INTO model_usage_stats (
        day, hour, provider_id, provider_name, model_id, api_model,
        request_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, last_used_at
      ) VALUES (
        $day, $hour, $providerId, $providerName, $modelId, $apiModel,
        1, $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens, $lastUsedAt
      )
      ON CONFLICT(day, hour, provider_id, model_id) DO UPDATE SET
        request_count = request_count + excluded.request_count,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        provider_name = excluded.provider_name,
        api_model = excluded.api_model,
        last_used_at = excluded.last_used_at
    `, {
      $day: day,
      $hour: hour,
      $providerId: sample.providerId,
      $providerName: sample.providerName,
      $modelId: sample.modelId,
      $apiModel: sample.apiModel,
      $inputTokens: sample.usage.inputTokens,
      $outputTokens: sample.usage.outputTokens,
      $cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
      $cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0,
      $lastUsedAt: now.getTime(),
    })
  }
  catch (err) {
    logger.warn({ modelId: sample.modelId, error: (err as Error).message }, '[USAGE] record model usage failed')
  }
}

interface RawUsageStatsRow {
  day: string
  hour: number
  provider_id: string
  provider_name: string
  model_id: string
  api_model: string
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  last_used_at: number
}

/** 查询用量统计 — sinceDay 为 null 查全部, 否则只返回 day >= sinceDay 的行 (升序) */
export async function queryUsageStats(sinceDay: string | null): Promise<UsageStatsRow[]> {
  const sql = `
    SELECT day, hour, provider_id, provider_name, model_id, api_model,
           request_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, last_used_at
    FROM model_usage_stats
    ${sinceDay !== null ? 'WHERE day >= $sinceDay' : ''}
    ORDER BY day ASC, hour ASC
  `
  const params = sinceDay !== null ? { $sinceDay: sinceDay } : undefined
  const rawRows = await getAgentDatabase().all<RawUsageStatsRow>(sql, params)
  return rawRows.map(row => ({
    day: row.day,
    hour: row.hour,
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    apiModel: row.api_model,
    requestCount: row.request_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    lastUsedAt: row.last_used_at,
  }))
}
