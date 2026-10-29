import type {
  UsageBarScope,
  UsageCurrency,
  UsageDailyStat,
  UsageDashboard,
  UsageHeroSummary,
  UsageLogRecord,
  UsageLogRow,
  UsageModelStat,
  UsageProviderStat,
  UsageRangePreset,
  UsageRecentItem,
  UsageSettings,
} from './types'
import { loadProviders } from '../config/providersStore'
import { getAgentDatabase } from '../database/sqlite'
import { logger } from '../logger'
import { formatCost, getFreshInputTokens } from './calculator'
import { modelUsageKey } from './types'

function startOfLocalDay(now = Date.now()): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfLocalMonth(now = Date.now()): number {
  const date = new Date(now)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function rangeStart(range: UsageRangePreset, now = Date.now()): number {
  if (range === 'today')
    return startOfLocalDay(now)
  if (range === 'month')
    return startOfLocalMonth(now)
  // Anchor on local midnight so "7 days" covers exactly 7 full calendar days
  // and the daily trend buckets stay one-per-day with no partial first day.
  const days = range === '7d' ? 7 : range === '14d' ? 14 : 30
  return startOfLocalDay(now - (days - 1) * 24 * 60 * 60 * 1000)
}

export async function recordUsageLog(record: UsageLogRecord): Promise<void> {
  try {
    await getAgentDatabase().run(
      `INSERT INTO usage_logs (
        request_id, provider_id, provider_name, provider_type,
        model_id, api_model, display_name, conversation_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros,
        currency, unpriced, status, error_message, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.requestId,
        record.providerId,
        record.providerName,
        record.providerType,
        record.modelId,
        record.apiModel,
        record.displayName,
        record.conversationId ?? null,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.inputCostMicros.toString(),
        record.outputCostMicros.toString(),
        record.cacheReadCostMicros.toString(),
        record.cacheCreationCostMicros.toString(),
        record.totalCostMicros.toString(),
        record.currency,
        record.unpriced,
        record.status,
        record.errorMessage ?? null,
        record.durationMs,
        record.createdAt,
      ],
    )
  }
  catch (error) {
    logger.warn({ error: (error as Error).message, requestId: record.requestId }, '[USAGE] insert failed')
  }
}

function isProviderSelected(settings: UsageSettings, providerId: string): boolean {
  if (!settings.filterCustomized)
    return true
  return settings.selectedProviderIds.includes(providerId)
}

function isModelSelected(settings: UsageSettings, providerId: string, modelId: string): boolean {
  if (!settings.filterCustomized)
    return true
  if (!isProviderSelected(settings, providerId))
    return false
  const keysForProvider = settings.selectedModelKeys.filter(key => key.startsWith(`${providerId}::`))
  if (keysForProvider.length === 0)
    return true
  return settings.selectedModelKeys.includes(modelUsageKey(providerId, modelId))
}

function matchesUsageFilter(settings: UsageSettings, row: UsageLogRow): boolean {
  if (!isProviderSelected(settings, row.provider_id))
    return false
  return isModelSelected(settings, row.provider_id, row.model_id)
}

export async function queryUsageDashboard(settings: UsageSettings): Promise<UsageDashboard> {
  const now = Date.now()
  const start = rangeStart(settings.range, now)
  const todayStart = startOfLocalDay(now)
  const rows = await getAgentDatabase().all<UsageLogRow>(
    `SELECT * FROM usage_logs WHERE created_at >= ? AND currency = ? ORDER BY created_at DESC`,
    [start, settings.currency],
  )
  const todayRows = rows.filter(row => row.created_at >= todayStart)
  const filtered = rows.filter(row => matchesUsageFilter(settings, row))
  const todayFiltered = todayRows.filter(row => matchesUsageFilter(settings, row))

  return {
    settings,
    todayCostFormatted: formatCost(sumMicros(todayFiltered), settings.currency),
    summary: summarize(filtered, settings.currency),
    providers: buildProviderStats(rows, settings),
    models: buildModelStats(rows, settings),
    daily: buildDailyStats(filtered, start, now, settings.currency),
    recent: filtered.slice(0, 30).map(toRecentItem(settings.currency)),
  }
}

/**
 * Group view-filtered rows by local calendar day, filling days without usage
 * with zero-cost buckets so the trend bars stay aligned with the time axis.
 */
function buildDailyStats(rows: UsageLogRow[], rangeStartMs: number, nowMs: number, currency: UsageCurrency): UsageDailyStat[] {
  const byDay = new Map<string, UsageDailyStat>()
  for (const row of rows) {
    const date = formatDayStamp(row.created_at)
    const current = byDay.get(date) ?? {
      date,
      requestCount: 0,
      okCount: 0,
      realTotalTokens: 0,
      totalCostMicros: 0n,
      totalCostFormatted: formatCost(0n, currency),
    }
    current.requestCount += 1
    if (row.status === 'ok')
      current.okCount += 1
    current.realTotalTokens += getFreshInputTokens(row.provider_type, row.input_tokens, row.cache_read_tokens, row.cache_write_tokens)
      + row.output_tokens + row.cache_write_tokens + row.cache_read_tokens
    current.totalCostMicros += BigInt(row.total_cost_micros || '0')
    current.totalCostFormatted = formatCost(current.totalCostMicros, currency)
    byDay.set(date, current)
  }

  const days: UsageDailyStat[] = []
  const cursor = new Date(startOfLocalDay(rangeStartMs))
  const lastDay = startOfLocalDay(nowMs)
  while (cursor.getTime() <= lastDay) {
    days.push(byDay.get(formatDayStamp(cursor.getTime())) ?? {
      date: formatDayStamp(cursor.getTime()),
      requestCount: 0,
      okCount: 0,
      realTotalTokens: 0,
      totalCostMicros: 0n,
      totalCostFormatted: formatCost(0n, currency),
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

function formatDayStamp(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

function summarize(rows: UsageLogRow[], currency: UsageCurrency): UsageHeroSummary {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let freshInputTokens = 0
  let unpricedCount = 0
  let okCount = 0
  let totalCostMicros = 0n
  for (const row of rows) {
    inputTokens += row.input_tokens
    outputTokens += row.output_tokens
    cacheReadTokens += row.cache_read_tokens
    cacheWriteTokens += row.cache_write_tokens
    freshInputTokens += getFreshInputTokens(row.provider_type, row.input_tokens, row.cache_read_tokens, row.cache_write_tokens)
    totalCostMicros += BigInt(row.total_cost_micros || '0')
    if (row.unpriced)
      unpricedCount += 1
    if (row.status === 'ok')
      okCount += 1
  }
  const cacheDenom = freshInputTokens + cacheWriteTokens + cacheReadTokens
  return {
    requestCount: rows.length,
    okCount,
    totalCostMicros,
    totalCostFormatted: formatCost(totalCostMicros, currency),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    freshInputTokens,
    realTotalTokens: freshInputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
    cacheHitRate: cacheDenom > 0 ? cacheReadTokens / cacheDenom : 0,
    unpricedCount,
  }
}

function buildProviderStats(rows: UsageLogRow[], settings: UsageSettings): UsageProviderStat[] {
  const configured = loadProviders().providers
  const byId = new Map<string, UsageProviderStat>()
  for (const provider of configured) {
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      selected: isProviderSelected(settings, provider.id),
      requestCount: 0,
      totalCostMicros: 0n,
      totalCostFormatted: formatCost(0n, settings.currency),
    })
  }
  for (const row of rows) {
    const current = byId.get(row.provider_id) ?? {
      id: row.provider_id,
      name: row.provider_name,
      type: row.provider_type,
      selected: isProviderSelected(settings, row.provider_id),
      requestCount: 0,
      totalCostMicros: 0n,
      totalCostFormatted: formatCost(0n, settings.currency),
    }
    current.requestCount += 1
    current.totalCostMicros += BigInt(row.total_cost_micros || '0')
    current.totalCostFormatted = formatCost(current.totalCostMicros, settings.currency)
    byId.set(row.provider_id, current)
  }
  return [...byId.values()].sort((a, b) => Number(b.totalCostMicros - a.totalCostMicros) || a.name.localeCompare(b.name))
}

function buildModelStats(rows: UsageLogRow[], settings: UsageSettings): UsageModelStat[] {
  const configured = loadProviders().providers
  const byKey = new Map<string, UsageModelStat>()
  for (const provider of configured) {
    for (const model of provider.models) {
      const key = modelUsageKey(provider.id, model.id)
      byKey.set(key, {
        key,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        displayName: model.displayName || model.apiModel,
        selected: isModelSelected(settings, provider.id, model.id),
        requestCount: 0,
        totalCostMicros: 0n,
        totalCostFormatted: formatCost(0n, settings.currency),
      })
    }
  }
  for (const row of rows) {
    if (!isProviderSelected(settings, row.provider_id))
      continue
    const key = modelUsageKey(row.provider_id, row.model_id)
    const current = byKey.get(key) ?? {
      key,
      providerId: row.provider_id,
      providerName: row.provider_name,
      modelId: row.model_id,
      displayName: row.display_name,
      selected: isModelSelected(settings, row.provider_id, row.model_id),
      requestCount: 0,
      totalCostMicros: 0n,
      totalCostFormatted: formatCost(0n, settings.currency),
    }
    current.requestCount += 1
    current.totalCostMicros += BigInt(row.total_cost_micros || '0')
    current.totalCostFormatted = formatCost(current.totalCostMicros, settings.currency)
    byKey.set(key, current)
  }
  return [...byKey.values()].sort((a, b) => Number(b.totalCostMicros - a.totalCostMicros) || a.displayName.localeCompare(b.displayName))
}

function toRecentItem(currency: UsageCurrency) {
  return (row: UsageLogRow): UsageRecentItem => ({
    requestId: row.request_id,
    providerName: row.provider_name,
    displayName: row.display_name,
    status: row.status,
    totalCostFormatted: formatCost(BigInt(row.total_cost_micros || '0'), currency),
    unpriced: row.unpriced === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  })
}

function sumMicros(rows: UsageLogRow[]): bigint {
  return rows.reduce((sum, row) => sum + BigInt(row.total_cost_micros || '0'), 0n)
}

/** Lightweight aggregate for the status bar over the scope window (single SQL, no rows pulled). */
export async function queryUsageSummary(scope: UsageBarScope, currency: UsageCurrency): Promise<{ requestCount: number, okCount: number, totalCostMicros: bigint, totalCostFormatted: string }> {
  const start = scope === 'month' ? startOfLocalMonth() : startOfLocalDay()
  const rows = await getAgentDatabase().all<{ n: number, ok: number, cost: string | null }>(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CAST(total_cost_micros AS INTEGER)) AS cost
     FROM usage_logs WHERE created_at >= ? AND currency = ?`,
    [start, currency],
  )
  const row = rows[0]
  const totalCostMicros = BigInt(row?.cost ?? 0)
  return {
    requestCount: row?.n ?? 0,
    okCount: row?.ok ?? 0,
    totalCostMicros,
    totalCostFormatted: formatCost(totalCostMicros, currency),
  }
}

/**
 * Delete usage logs older than the retention window (called once per
 * activation) so the table stays small no matter how long the extension runs.
 */
export async function pruneOldUsageLogs(maxAgeDays = 90): Promise<void> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  try {
    await getAgentDatabase().run('DELETE FROM usage_logs WHERE created_at < ?', [cutoff])
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[USAGE] prune failed')
  }
}

export function serializeUsageDashboard(dashboard: UsageDashboard) {
  return {
    settings: dashboard.settings,
    todayCostFormatted: dashboard.todayCostFormatted,
    summary: {
      ...dashboard.summary,
      totalCostMicros: dashboard.summary.totalCostMicros.toString(),
    },
    providers: dashboard.providers.map(provider => ({
      ...provider,
      totalCostMicros: provider.totalCostMicros.toString(),
    })),
    models: dashboard.models.map(model => ({
      ...model,
      totalCostMicros: model.totalCostMicros.toString(),
    })),
    daily: dashboard.daily.map(day => ({
      ...day,
      totalCostMicros: day.totalCostMicros.toString(),
    })),
    recent: dashboard.recent,
  }
}
