import type { UsageSettingsConfig } from '../data/defaults'
import type { UsageCurrency, UsageRangePreset, UsageSettings } from './types'
import { existsSync, unwatchFile, watchFile } from 'node:fs'
import { readJsonOrNull, withSerial, writeJsonAtomic } from '../config/atomic'
import { getUsageSettingsFilePath } from '../config/paths'
import { DEFAULT_USAGE_SETTINGS } from '../data/defaults'
import { logger } from '../logger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: UsageSettings | null = null

function withFallback(loaded: Partial<UsageSettingsConfig> | null): UsageSettings {
  const currency: UsageCurrency = loaded?.currency === 'USD' ? 'USD' : 'CNY'
  const range: UsageRangePreset = loaded?.range === '7d' || loaded?.range === '14d' || loaded?.range === '30d' || loaded?.range === 'month'
    ? loaded.range
    : 'today'
  const statusBarScope: 'today' | 'month' = loaded?.statusBarScope === 'today' ? 'today' : 'month'
  return {
    $schemaVersion: 1,
    currency,
    range,
    statusBarScope,
    filterCustomized: loaded?.filterCustomized === true,
    selectedProviderIds: Array.isArray(loaded?.selectedProviderIds) ? loaded.selectedProviderIds.filter(id => typeof id === 'string') : [],
    selectedModelKeys: Array.isArray(loaded?.selectedModelKeys) ? loaded.selectedModelKeys.filter(id => typeof id === 'string') : [],
  }
}

export function loadUsageSettings(): UsageSettings {
  if (cache)
    return cache
  cache = withFallback(readJsonOrNull<Partial<UsageSettingsConfig>>(getUsageSettingsFilePath()))
  return cache
}

export async function updateUsageSettings(updater: (draft: UsageSettings) => void): Promise<UsageSettings> {
  const path = getUsageSettingsFilePath()
  return withSerial(path, () => {
    const current = withFallback(readJsonOrNull<Partial<UsageSettingsConfig>>(path))
    updater(current)
    writeJsonAtomic(path, current)
    cache = current
    return clone(cache)
  })
}

export function resetUsageSettingsCacheForTests(): void {
  cache = null
}

let watching = false
const listeners: Array<() => void> = []

export function startUsageSettingsWatcher(): void {
  if (watching)
    return
  const path = getUsageSettingsFilePath()
  if (!existsSync(path))
    return
  watchFile(path, { interval: 2000, persistent: false }, () => {
    cache = withFallback(readJsonOrNull<Partial<UsageSettingsConfig>>(path))
    logger.info('[CFG] usage-settings.json changed, reloading')
    for (const fn of listeners)
      fn()
  })
  watching = true
}

export function stopUsageSettingsWatcher(): void {
  if (!watching)
    return
  unwatchFile(getUsageSettingsFilePath())
  watching = false
}

export function onUsageSettingsChange(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    const idx = listeners.indexOf(fn)
    if (idx >= 0)
      listeners.splice(idx, 1)
  }
}

export function ensureUsageSettingsFile(): UsageSettings {
  const path = getUsageSettingsFilePath()
  if (!existsSync(path)) {
    const seed = clone(DEFAULT_USAGE_SETTINGS)
    writeJsonAtomic(path, seed)
    cache = seed
    return seed
  }
  return loadUsageSettings()
}
