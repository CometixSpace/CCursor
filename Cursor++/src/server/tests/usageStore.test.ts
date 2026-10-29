import type { UsageBarScope, UsageLogRecord } from '../usage/types'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAgentDatabaseForTests } from '../database/sqlite'
import { pruneOldUsageLogs, queryUsageDashboard, queryUsageSummary, recordUsageLog } from '../usage/store'

let tmpDbPath = ''

beforeEach(async () => {
  tmpDbPath = join(tmpdir(), `.tmp-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  process.env.BYOK_AGENT_DB_PATH = tmpDbPath
  await resetAgentDatabaseForTests()
})

afterEach(async () => {
  await resetAgentDatabaseForTests()
  delete process.env.BYOK_AGENT_DB_PATH
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${tmpDbPath}${suffix}`)
    }
    catch {}
  }
})

function log(partial: Partial<UsageLogRecord>): UsageLogRecord {
  return {
    requestId: partial.requestId ?? `req-${Math.random().toString(36).slice(2, 8)}`,
    providerId: partial.providerId ?? 'provider-alpha',
    providerName: partial.providerName ?? 'Provider Alpha',
    providerType: partial.providerType ?? 'anthropic',
    modelId: partial.modelId ?? 'model-flash',
    apiModel: partial.apiModel ?? 'vendor/model-x',
    displayName: partial.displayName ?? 'Model X',
    conversationId: partial.conversationId,
    inputTokens: partial.inputTokens ?? 1000,
    outputTokens: partial.outputTokens ?? 200,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    inputCostMicros: partial.inputCostMicros ?? 3_000n,
    outputCostMicros: partial.outputCostMicros ?? 3_000n,
    cacheReadCostMicros: partial.cacheReadCostMicros ?? 0n,
    cacheCreationCostMicros: partial.cacheCreationCostMicros ?? 0n,
    totalCostMicros: partial.totalCostMicros ?? 6_000n,
    currency: partial.currency ?? 'CNY',
    unpriced: partial.unpriced ?? 0,
    status: partial.status ?? 'ok',
    errorMessage: partial.errorMessage,
    durationMs: partial.durationMs ?? 12,
    createdAt: partial.createdAt ?? Date.now(),
  }
}

describe('usage store', () => {
  it('aggregates selected providers and models only', async () => {
    const now = Date.now()
    await recordUsageLog(log({
      requestId: 'a',
      providerId: 'provider-alpha',
      modelId: 'flash',
      displayName: 'flash',
      totalCostMicros: 10_000n,
      createdAt: now,
    }))
    await recordUsageLog(log({
      requestId: 'b',
      providerId: 'provider-alpha',
      modelId: 'kimi',
      displayName: 'kimi',
      totalCostMicros: 20_000n,
      createdAt: now,
    }))
    await recordUsageLog(log({
      requestId: 'c',
      providerId: 'provider-beta',
      providerName: 'Provider Beta',
      modelId: 'gpt',
      displayName: 'gpt',
      totalCostMicros: 99_000n,
      createdAt: now,
    }))

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: 'today',
      filterCustomized: true,
      selectedProviderIds: ['provider-alpha'],
      selectedModelKeys: ['provider-alpha::flash'],
    })

    expect(dashboard.summary.requestCount).toBe(1)
    expect(dashboard.summary.totalCostMicros).toBe(10_000n)
    expect(dashboard.summary.totalCostFormatted).toBe('¥0.010000')
    expect(dashboard.recent).toHaveLength(1)
    expect(dashboard.recent[0].displayName).toBe('flash')
    expect(dashboard.providers.find(p => p.id === 'provider-alpha')?.selected).toBe(true)
    expect(dashboard.providers.find(p => p.id === 'provider-beta')?.selected).toBe(false)
    expect(dashboard.models.find(m => m.modelId === 'flash')?.selected).toBe(true)
  })

  it('treats empty selection as all providers', async () => {
    await recordUsageLog(log({ requestId: 'a', providerId: 'p1', modelId: 'm1', totalCostMicros: 1_000n }))
    await recordUsageLog(log({ requestId: 'b', providerId: 'p2', providerName: 'p2', modelId: 'm2', totalCostMicros: 2_000n }))
    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: 'today',
      selectedProviderIds: [],
      selectedModelKeys: [],
    })
    expect(dashboard.summary.requestCount).toBe(2)
    expect(dashboard.summary.totalCostMicros).toBe(3_000n)
  })

  it('treats empty selection as none after the user has customized filters', async () => {
    await recordUsageLog(log({
      requestId: 'a',
      providerId: 'provider-alpha',
      modelId: 'flash',
      totalCostMicros: 10_000n,
    }))
    await recordUsageLog(log({
      requestId: 'b',
      providerId: 'provider-beta',
      providerName: 'Provider Beta',
      modelId: 'gpt',
      totalCostMicros: 99_000n,
    }))

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: 'today',
      filterCustomized: true,
      selectedProviderIds: [],
      selectedModelKeys: [],
    })

    expect(dashboard.summary.requestCount).toBe(0)
    expect(dashboard.summary.totalCostMicros).toBe(0n)
    expect(dashboard.recent).toHaveLength(0)
    expect(dashboard.providers.every(provider => !provider.selected)).toBe(true)
  })

  it('includes all models of a rechecked provider even if their keys were previously excluded', async () => {
    await recordUsageLog(log({
      requestId: 'a',
      providerId: 'provider-alpha',
      modelId: 'flash',
      displayName: 'flash',
      totalCostMicros: 10_000n,
    }))
    await recordUsageLog(log({
      requestId: 'b',
      providerId: 'provider-alpha',
      modelId: 'kimi',
      displayName: 'kimi',
      totalCostMicros: 20_000n,
    }))
    await recordUsageLog(log({
      requestId: 'c',
      providerId: 'provider-beta',
      providerName: 'Provider Beta',
      modelId: 'gpt',
      displayName: 'gpt',
      totalCostMicros: 99_000n,
    }))

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: 'today',
      filterCustomized: true,
      selectedProviderIds: ['provider-alpha'],
      selectedModelKeys: ['provider-beta::gpt'],
    })

    expect(dashboard.summary.requestCount).toBe(2)
    expect(dashboard.summary.totalCostMicros).toBe(30_000n)
    expect(dashboard.recent.map(item => item.displayName).sort()).toEqual(['flash', 'kimi'])
    expect(dashboard.models.find(model => model.modelId === 'kimi')?.selected).toBe(true)
  })

  it('rolls up daily buckets across the selected range with zero-filled gaps', async () => {
    const now = Date.now()
    const yesterday = now - 24 * 60 * 60 * 1000
    await recordUsageLog(log({
      requestId: 'a',
      inputTokens: 1000,
      outputTokens: 200,
      totalCostMicros: 10_000n,
      createdAt: now,
    }))
    await recordUsageLog(log({
      requestId: 'b',
      status: 'error',
      inputTokens: 100,
      outputTokens: 0,
      totalCostMicros: 1_000n,
      createdAt: yesterday,
    }))

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: '7d',
      selectedProviderIds: [],
      selectedModelKeys: [],
    })

    expect(dashboard.daily).toHaveLength(7)
    expect(dashboard.daily[6].date).toBe(dashboard.daily.at(-1)?.date)
    const today = dashboard.daily.at(-1)
    expect(today?.requestCount).toBe(1)
    expect(today?.okCount).toBe(1)
    expect(today?.totalCostMicros).toBe(10_000n)
    const errorDay = dashboard.daily[5]
    expect(errorDay.requestCount).toBe(1)
    expect(errorDay.okCount).toBe(0)
    expect(errorDay.totalCostMicros).toBe(1_000n)
    expect(dashboard.daily.slice(0, 5).every(day => day.requestCount === 0)).toBe(true)
  })

  it('keeps daily buckets aligned with the view filter', async () => {
    const now = Date.now()
    await recordUsageLog(log({
      requestId: 'a',
      providerId: 'provider-alpha',
      modelId: 'flash',
      totalCostMicros: 10_000n,
      createdAt: now,
    }))
    await recordUsageLog(log({
      requestId: 'b',
      providerId: 'provider-beta',
      providerName: 'Provider Beta',
      modelId: 'gpt',
      totalCostMicros: 99_000n,
      createdAt: now,
    }))

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: 'today',
      filterCustomized: true,
      selectedProviderIds: ['provider-alpha'],
      selectedModelKeys: [],
    })

    expect(dashboard.daily).toHaveLength(1)
    expect(dashboard.daily[0].requestCount).toBe(1)
    expect(dashboard.daily[0].totalCostMicros).toBe(10_000n)
  })

  it('summarizes per scope (today/month) and currency for the status bar', async () => {
    const now = Date.now()
    const lastMonth = now - 45 * 24 * 60 * 60 * 1000
    await recordUsageLog(log({ requestId: 'a', totalCostMicros: 10_000n, createdAt: now }))
    await recordUsageLog(log({ requestId: 'b', status: 'error', totalCostMicros: 2_500n, createdAt: now }))
    await recordUsageLog(log({ requestId: 'old', totalCostMicros: 99_000n, createdAt: lastMonth }))

    const today = await queryUsageSummary('today' as UsageBarScope, 'CNY')
    expect(today.requestCount).toBe(2)
    expect(today.okCount).toBe(1)
    expect(today.totalCostMicros).toBe(12_500n)
    expect(today.totalCostFormatted).toBe('¥0.012500')

    const month = await queryUsageSummary('month' as UsageBarScope, 'CNY')
    expect(month.requestCount).toBe(2)
    expect(month.totalCostMicros).toBe(12_500n)

    const usd = await queryUsageSummary('today' as UsageBarScope, 'USD')
    expect(usd.requestCount).toBe(0)
    expect(usd.totalCostMicros).toBe(0n)
  })

  it('prunes usage logs older than the retention window', async () => {
    const now = Date.now()
    await recordUsageLog(log({ requestId: 'old', totalCostMicros: 1_000n, createdAt: now - 91 * 24 * 60 * 60 * 1000 }))
    await recordUsageLog(log({ requestId: 'new', totalCostMicros: 2_000n, createdAt: now }))

    await pruneOldUsageLogs(90)

    const dashboard = await queryUsageDashboard({
      $schemaVersion: 1,
      currency: 'CNY',
      range: '30d',
      selectedProviderIds: [],
      selectedModelKeys: [],
    })
    expect(dashboard.summary.requestCount).toBe(1)
    expect(dashboard.recent[0].requestId).toBe('new')
  })
})
