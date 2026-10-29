import type { ModelPricing } from '../usage/types'
import { describe, expect, it } from 'vitest'
import {
  CACHE_INCLUSIVE_PROVIDER_TYPES,
  calculateUsageCost,
  formatCost,
  getFreshInputTokens,
  isCacheInclusiveProvider,
  isUnpricedUsage,
} from '../usage/calculator'

const priced: ModelPricing = {
  inputCostPerMillion: '3',
  outputCostPerMillion: '15',
  cacheReadCostPerMillion: '0.3',
  cacheCreationCostPerMillion: '3.75',
  costMultiplier: '1',
}

describe('usage calculator', () => {
  it('treats openai and gemini input as cache-inclusive', () => {
    expect(CACHE_INCLUSIVE_PROVIDER_TYPES.has('openai-chat')).toBe(true)
    expect(CACHE_INCLUSIVE_PROVIDER_TYPES.has('openai-responses')).toBe(true)
    expect(CACHE_INCLUSIVE_PROVIDER_TYPES.has('gemini')).toBe(true)
    expect(isCacheInclusiveProvider('anthropic')).toBe(false)
  })

  it('does not subtract cache from anthropic fresh input', () => {
    expect(getFreshInputTokens('anthropic', 1000, 400, 100)).toBe(1000)
  })

  it('subtracts cache read and write from openai-style input', () => {
    expect(getFreshInputTokens('openai-responses', 1000, 400, 100)).toBe(500)
    expect(getFreshInputTokens('gemini', 100, 200, 0)).toBe(0)
  })

  it('prices anthropic four buckets without double-counting cache', () => {
    const result = calculateUsageCost({
      providerType: 'anthropic',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 1_000_000,
      },
      pricing: priced,
    })
    // 1M*3 + 1M*15 + 2M*0.3 + 1M*3.75 = 3+15+0.6+3.75 = 22.35
    expect(result.totalMicros).toBe(22_350_000n)
    expect(result.unpriced).toBe(false)
    expect(formatCost(result.totalMicros, 'CNY')).toBe('¥22.350000')
  })

  it('prices openai input after removing cached tokens', () => {
    const result = calculateUsageCost({
      providerType: 'openai-chat',
      usage: {
        inputTokens: 2_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
      pricing: {
        ...priced,
        outputCostPerMillion: '0',
        cacheCreationCostPerMillion: '0',
      },
    })
    // fresh 1M * 3 + cacheRead 1M * 0.3 = 3.3
    expect(result.totalMicros).toBe(3_300_000n)
  })

  it('applies multiplier only to the total', () => {
    const result = calculateUsageCost({
      providerType: 'anthropic',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing: { ...priced, costMultiplier: '1.1' },
    })
    expect(result.totalMicros).toBe(3_300_000n)
  })

  it('marks token usage with zero prices as unpriced', () => {
    const result = calculateUsageCost({
      providerType: 'anthropic',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing: {
        inputCostPerMillion: '0',
        outputCostPerMillion: '0',
        cacheReadCostPerMillion: '0',
        cacheCreationCostPerMillion: '0',
        costMultiplier: '1',
      },
    })
    expect(result.totalMicros).toBe(0n)
    expect(result.unpriced).toBe(true)
    expect(isUnpricedUsage(result)).toBe(true)
  })

  it('formats usd with a dollar sign', () => {
    expect(formatCost(1_500_000n, 'USD')).toBe('$1.500000')
  })
})
