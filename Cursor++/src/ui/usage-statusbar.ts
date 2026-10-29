/**
 * Usage status-bar suffix — period cost appended to the BYOK item.
 *
 * Lives inside the existing BYOK status-bar item (no separate entry):
 *   `✓ BYOK ◉ ¥14`
 * The statistics window follows `usage-settings.json` `statusBarScope`
 * ('month' by default — resets on the 1st, or 'today' — resets at midnight).
 * The precise cost stays available via the item tooltip. Refreshed on every
 * usage record and on currency/scope change; data comes from a single SQL
 * aggregate. A failed query (agent DB not initialized yet) schedules retries
 * so the suffix appears without waiting for a request.
 */
import type { UsageBarScope } from '../server/usage/types'
import { onUsageRecorded } from '../server/usage/events'
import { loadUsageSettings } from '../server/usage/settings'
import { queryUsageSummary } from '../server/usage/store'

const RETRY_DELAY_MS = 10_000
const RETRY_MAX = 6

let rerenderBar: () => void = () => {}
let usageSuffix = ''
let usageTooltipLine = ''
let retryCount = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function currencySymbol(currency: 'CNY' | 'USD'): string {
  return currency === 'CNY' ? '\u00A5' : '$'
}

function scheduleRetry() {
  if (retryTimer || retryCount >= RETRY_MAX)
    return
  retryCount += 1
  retryTimer = setTimeout(() => {
    retryTimer = null
    void recompute()
  }, RETRY_DELAY_MS)
}

async function recompute() {
  try {
    const settings = loadUsageSettings()
    const scope: UsageBarScope = settings.statusBarScope === 'today' ? 'today' : 'month'
    const summary = await queryUsageSummary(scope, settings.currency)
    usageSuffix = ` ${currencySymbol(settings.currency)}${Math.round(Number(summary.totalCostMicros) / 1e6)}`
    const scopeLabel = scope === 'month' ? 'This month' : 'Today'
    usageTooltipLine = `${scopeLabel}: ${summary.totalCostFormatted} · ${summary.requestCount} requests · ${summary.okCount} ok (${settings.currency})`
    retryCount = 0
  }
  catch {
    // agent DB not ready yet (server still starting) — clear the suffix
    // and retry a few times so it appears without waiting for a request
    usageSuffix = ''
    usageTooltipLine = ''
    scheduleRetry()
  }
  rerenderBar()
}

/** Attach period-cost suffix updates to the BYOK status-bar rerender cycle. */
export function initUsageStatusBar(rerender: () => void): void {
  rerenderBar = rerender
  onUsageRecorded(() => {
    void recompute()
  })
  void recompute()
}

/** Suffix for statusBarItem.text, e.g. ` ¥14`. Empty while data is unavailable. */
export function getUsageSuffix(): string {
  return usageSuffix
}

/** One-line period summary for the status-bar tooltip. Empty while unavailable. */
export function getUsageTooltipLine(): string {
  return usageTooltipLine
}

/** Recompute suffix (e.g. after a scope/currency switch) and refresh the bar. */
export function refreshUsageStatusBar(): void {
  retryCount = 0
  void recompute()
}
