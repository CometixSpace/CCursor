import type { ProviderType } from '../data/defaults'
import type { LLMUsage } from '../handlers/llm/types'

export type UsageCurrency = 'CNY' | 'USD'

export type UsageRangePreset = 'today' | '7d' | '14d' | '30d' | 'month'

/** Statistics window of the status-bar suffix: resets daily or monthly. */
export type UsageBarScope = 'today' | 'month'

export type UsageStatus = 'ok' | 'error'

export interface ModelPricing {
  inputCostPerMillion: string
  outputCostPerMillion: string
  cacheReadCostPerMillion: string
  cacheCreationCostPerMillion: string
  costMultiplier: string
}

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface CostBreakdown {
  inputMicros: bigint
  outputMicros: bigint
  cacheReadMicros: bigint
  cacheCreationMicros: bigint
  totalMicros: bigint
  unpriced: boolean
  freshInputTokens: number
}

export interface UsageSettings {
  $schemaVersion: number
  currency: UsageCurrency
  range: UsageRangePreset
  /**
   * False + empty arrays = all providers/models.
   * True + empty arrays = none (user unchecked everything).
   * Newly added providers/models stay off until checked once this is true.
   */
  filterCustomized?: boolean
  selectedProviderIds: string[]
  /** Keys are `${providerId}::${modelId}`. */
  selectedModelKeys: string[]
  /** Status-bar statistics window: resets daily or on the 1st of each month. */
  statusBarScope?: UsageBarScope
}

export interface UsageLogRecord {
  requestId: string
  providerId: string
  providerName: string
  providerType: ProviderType
  modelId: string
  apiModel: string
  displayName: string
  conversationId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputCostMicros: bigint
  outputCostMicros: bigint
  cacheReadCostMicros: bigint
  cacheCreationCostMicros: bigint
  totalCostMicros: bigint
  currency: UsageCurrency
  unpriced: number
  status: UsageStatus
  errorMessage?: string
  durationMs: number
  createdAt: number
}

export interface UsageLogRow {
  request_id: string
  provider_id: string
  provider_name: string
  provider_type: string
  model_id: string
  api_model: string
  display_name: string
  conversation_id: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  input_cost_micros: string
  output_cost_micros: string
  cache_read_cost_micros: string
  cache_creation_cost_micros: string
  total_cost_micros: string
  currency: string
  unpriced: number
  status: string
  error_message: string | null
  duration_ms: number
  created_at: number
}

export interface UsageHeroSummary {
  requestCount: number
  okCount: number
  totalCostMicros: bigint
  totalCostFormatted: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  freshInputTokens: number
  realTotalTokens: number
  cacheHitRate: number
  unpricedCount: number
}

export interface UsageProviderStat {
  id: string
  name: string
  type: string
  selected: boolean
  requestCount: number
  totalCostMicros: bigint
  totalCostFormatted: string
}

export interface UsageModelStat {
  key: string
  providerId: string
  providerName: string
  modelId: string
  displayName: string
  selected: boolean
  requestCount: number
  totalCostMicros: bigint
  totalCostFormatted: string
}

export interface UsageRecentItem {
  requestId: string
  providerName: string
  displayName: string
  status: string
  totalCostFormatted: string
  unpriced: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  durationMs: number
  createdAt: number
}

/** Per-local-day rollup used by the daily cost trend bars. */
export interface UsageDailyStat {
  /** Local date, formatted as MM-DD. */
  date: string
  requestCount: number
  okCount: number
  realTotalTokens: number
  totalCostMicros: bigint
  totalCostFormatted: string
}

export interface UsageDashboard {
  settings: UsageSettings
  todayCostFormatted: string
  summary: UsageHeroSummary
  providers: UsageProviderStat[]
  models: UsageModelStat[]
  daily: UsageDailyStat[]
  recent: UsageRecentItem[]
}

export function normalizeUsage(usage?: LLMUsage): NormalizedUsage {
  return {
    inputTokens: Math.max(0, usage?.inputTokens ?? 0),
    outputTokens: Math.max(0, usage?.outputTokens ?? 0),
    cacheReadTokens: Math.max(0, usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: Math.max(0, usage?.cacheWriteTokens ?? 0),
  }
}

export function modelUsageKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

export function pricingFromModel(model?: Partial<ModelPricing> | null): ModelPricing {
  return {
    inputCostPerMillion: model?.inputCostPerMillion ?? '0',
    outputCostPerMillion: model?.outputCostPerMillion ?? '0',
    cacheReadCostPerMillion: model?.cacheReadCostPerMillion ?? '0',
    cacheCreationCostPerMillion: model?.cacheCreationCostPerMillion ?? '0',
    costMultiplier: model?.costMultiplier ?? '1',
  }
}
