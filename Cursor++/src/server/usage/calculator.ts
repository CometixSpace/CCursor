import type { ProviderType } from '../data/defaults'
import type { CostBreakdown, ModelPricing, NormalizedUsage, UsageCurrency } from './types'

export const CACHE_INCLUSIVE_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  'openai-chat',
  'openai-responses',
  'gemini',
])

const MICROS_PER_UNIT = 1_000_000n

interface ScaledDecimal {
  value: bigint
  scale: number
}

export function isCacheInclusiveProvider(providerType: string): boolean {
  return CACHE_INCLUSIVE_PROVIDER_TYPES.has(providerType as ProviderType)
}

export function getFreshInputTokens(
  providerType: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  if (!isCacheInclusiveProvider(providerType))
    return Math.max(0, inputTokens)
  return Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
}

export function calculateUsageCost(params: {
  providerType: string
  usage: NormalizedUsage
  pricing: ModelPricing
}): CostBreakdown {
  const freshInputTokens = getFreshInputTokens(
    params.providerType,
    params.usage.inputTokens,
    params.usage.cacheReadTokens,
    params.usage.cacheWriteTokens,
  )
  const inputMicros = tokensToMicros(freshInputTokens, params.pricing.inputCostPerMillion)
  const outputMicros = tokensToMicros(params.usage.outputTokens, params.pricing.outputCostPerMillion)
  const cacheReadMicros = tokensToMicros(params.usage.cacheReadTokens, params.pricing.cacheReadCostPerMillion)
  const cacheCreationMicros = tokensToMicros(params.usage.cacheWriteTokens, params.pricing.cacheCreationCostPerMillion)
  const baseTotal = inputMicros + outputMicros + cacheReadMicros + cacheCreationMicros
  const totalMicros = applyMultiplier(baseTotal, params.pricing.costMultiplier)
  const hasTokens = params.usage.inputTokens > 0
    || params.usage.outputTokens > 0
    || params.usage.cacheReadTokens > 0
    || params.usage.cacheWriteTokens > 0
  return {
    inputMicros,
    outputMicros,
    cacheReadMicros,
    cacheCreationMicros,
    totalMicros,
    unpriced: hasTokens && totalMicros === 0n,
    freshInputTokens,
  }
}

export function isUnpricedUsage(result: Pick<CostBreakdown, 'unpriced'>): boolean {
  return result.unpriced
}

export function formatCost(micros: bigint, currency: UsageCurrency): string {
  const sign = currency === 'USD' ? '$' : '¥'
  const negative = micros < 0n
  const absolute = negative ? -micros : micros
  const whole = absolute / MICROS_PER_UNIT
  const fraction = (absolute % MICROS_PER_UNIT).toString().padStart(6, '0')
  return `${negative ? '-' : ''}${sign}${whole.toString()}.${fraction}`
}

function tokensToMicros(tokens: number, pricePerMillion: string): bigint {
  const price = parseNonNegativeDecimal(pricePerMillion)
  if (tokens <= 0 || price.value === 0n)
    return 0n
  // cost = tokens * price / 1e6  → micros = tokens * price
  // price is value / 10^scale, so micros = tokens * value / 10^scale
  const numerator = BigInt(tokens) * price.value
  const denominator = pow10(price.scale)
  return divRound(numerator, denominator)
}

function applyMultiplier(micros: bigint, multiplier: string): bigint {
  const parsed = parseNonNegativeDecimal(multiplier.trim() === '' ? '1' : multiplier)
  if (parsed.value === 0n)
    return 0n
  if (parsed.value === 1n && parsed.scale === 0)
    return micros
  return divRound(micros * parsed.value, pow10(parsed.scale))
}

function parseNonNegativeDecimal(raw: string): ScaledDecimal {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed))
    return { value: 0n, scale: 0 }
  const [whole, fraction = ''] = trimmed.split('.')
  return {
    value: BigInt(`${whole}${fraction}` || '0'),
    scale: fraction.length,
  }
}

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale)
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n)
    return 0n
  const half = denominator / 2n
  return (numerator + half) / denominator
}
