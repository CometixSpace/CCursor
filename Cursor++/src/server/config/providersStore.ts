/**
 * providers.json 单项原子读写 + 反向索引
 *
 * 单一真源:
 *   - 内存里维护 ProvidersConfig + Map<modelId, {provider, model}>
 *   - 加载时建立反向索引,modelId 跨 provider 重名 → first-wins + warn
 *   - 写入立即重建索引
 *
 * 读: 文件不存在 → 默认种子;损坏 → 默认种子并 warn
 * 写: tmp + rename, withSerial 串行化
 */
import type { ProviderEntry, ProviderModel, ProvidersConfig } from '../data/defaults'
import { existsSync, unwatchFile, watchFile } from 'node:fs'
import { DEFAULT_PROVIDERS } from '../data/defaults'
import { logger } from '../logger'
import { readJsonOrNull, withSerial, writeJsonAtomic } from './atomic'
import { getProvidersFilePath } from './paths'

export interface ResolvedProviderModel {
  provider: ProviderEntry
  model: ProviderModel
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: ProvidersConfig | null = null
let reverseIndex: Map<string, ResolvedProviderModel> = new Map()

function rebuildIndex(config: ProvidersConfig): Map<string, ResolvedProviderModel> {
  const idx = new Map<string, ResolvedProviderModel>()
  for (const provider of config.providers) {
    if (!Array.isArray(provider.models))
      continue
    for (const model of provider.models) {
      const existing = idx.get(model.id)
      if (existing) {
        logger.warn(
          {
            modelId: model.id,
            winner: existing.provider.id,
            loser: provider.id,
          },
          '[CFG] duplicate model id across providers, keeping first',
        )
        continue
      }
      idx.set(model.id, { provider, model })
    }
  }
  return idx
}

function withFallback(loaded: Partial<ProvidersConfig> | null): ProvidersConfig {
  if (!loaded || !Array.isArray(loaded.providers))
    return clone(DEFAULT_PROVIDERS)
  return {
    $schemaVersion: loaded.$schemaVersion ?? DEFAULT_PROVIDERS.$schemaVersion,
    visionModelId: typeof loaded.visionModelId === 'string' ? loaded.visionModelId : '',
    providers: loaded.providers.map(p => ({
      id: p.id,
      name: p.name ?? p.id,
      type: p.type,
      baseUrl: p.baseUrl ?? '',
      auth: p.auth ?? { kind: 'apiKey', value: '' },
      models: Array.isArray(p.models) ? p.models : [],
      ...(p.proxyUrl ? { proxyUrl: p.proxyUrl } : {}),
      ...(p.headers && typeof p.headers === 'object' && Object.keys(p.headers).length > 0 ? { headers: p.headers } : {}),
    })),
  }
}

export function loadProviders(): ProvidersConfig {
  if (cache)
    return cache
  const loaded = readJsonOrNull<Partial<ProvidersConfig>>(getProvidersFilePath())
  cache = withFallback(loaded)
  reverseIndex = rebuildIndex(cache)
  return cache
}

/**
 * 首次启动确保 providers.json 存在 (不存在 → 写默认种子)。
 *
 * 关键: 只在文件**物理不存在**时才写种子。如果文件存在但 readJsonOrNull 返回
 * null (权限错/JSON 损坏),**不覆盖** — 避免用户手动配置被空种子冲掉。
 * macOS 26+ 上曾观测到 extension host 因安全策略读文件失败的情况。
 */
export async function ensureProvidersFile(): Promise<ProvidersConfig> {
  const path = getProvidersFilePath()
  return withSerial(path, () => {
    const existing = readJsonOrNull<Partial<ProvidersConfig>>(path)
    if (existing && Array.isArray(existing.providers)) {
      cache = withFallback(existing)
      reverseIndex = rebuildIndex(cache)
      return cache
    }
    // 文件物理存在但解析失败 → 不覆盖,用空默认值运行 (让用户修复文件)
    if (existsSync(path)) {
      logger.warn({ path }, '[CFG] providers.json exists but failed to parse — not overwriting, using empty defaults')
      cache = clone(DEFAULT_PROVIDERS)
      reverseIndex = rebuildIndex(cache)
      return cache
    }
    // 文件真的不存在 → 写入种子
    const seed = clone(DEFAULT_PROVIDERS)
    writeJsonAtomic(path, seed)
    cache = seed
    reverseIndex = rebuildIndex(cache)
    logger.info({ path }, '[CFG] providers.json seeded with defaults')
    return cache
  })
}

export async function updateProviders(updater: (draft: ProvidersConfig) => void): Promise<ProvidersConfig> {
  const path = getProvidersFilePath()
  return withSerial(path, () => {
    const current = withFallback(readJsonOrNull<Partial<ProvidersConfig>>(path))
    updater(current)
    writeJsonAtomic(path, current)
    cache = current
    reverseIndex = rebuildIndex(cache)
    return cache
  })
}

/** 反向查找: modelId → {provider, model} */
export function lookupModel(modelId: string): ResolvedProviderModel | null {
  if (!cache)
    loadProviders()
  return reverseIndex.get(modelId) ?? null
}

/** 铺平所有 provider × model, 返回展示用的列表 */
export function flattenModels(): ResolvedProviderModel[] {
  const config = cache ?? loadProviders()
  const out: ResolvedProviderModel[] = []
  for (const provider of config.providers) {
    for (const model of provider.models) {
      // 与 reverseIndex 一致: 跨 provider 重名只保留第一个
      if (out.some(x => x.model.id === model.id))
        continue
      out.push({ provider, model })
    }
  }
  return out
}

export function getProvider(providerId: string): ProviderEntry | null {
  const config = cache ?? loadProviders()
  return config.providers.find(p => p.id === providerId) ?? null
}

/** 测试用: 重置缓存 */
export function resetProvidersCacheForTests(): void {
  cache = null
  reverseIndex = new Map()
}

/** 测试用: 直接注入 in-memory providers, 跳过磁盘读写 */
export function setProvidersForTests(config: ProvidersConfig): void {
  cache = clone(config)
  reverseIndex = rebuildIndex(cache)
}

// ── 文件监听: 外部变更 (其他实例 / 手动编辑) 自动重载 ──

type ProvidersChangeListener = () => void
const changeListeners: ProvidersChangeListener[] = []
let watching = false

/** 注册 providers.json 变更回调 (用于跨实例状态同步) */
export function onProvidersChange(fn: ProvidersChangeListener): () => void {
  changeListeners.push(fn)
  return () => {
    const idx = changeListeners.indexOf(fn)
    if (idx >= 0)
      changeListeners.splice(idx, 1)
  }
}

function reloadFromDisk() {
  const loaded = readJsonOrNull<Partial<ProvidersConfig>>(getProvidersFilePath())
  cache = withFallback(loaded)
  reverseIndex = rebuildIndex(cache)
}

/** 启动 providers.json 文件监听 */
export function startProvidersWatcher(): void {
  if (watching)
    return
  const path = getProvidersFilePath()
  watchFile(path, { interval: 2000, persistent: false }, () => {
    logger.info('[CFG] providers.json changed externally, reloading')
    reloadFromDisk()
    for (const fn of changeListeners)
      fn()
  })
  watching = true
}

/** 停止文件监听 */
export function stopProvidersWatcher(): void {
  if (!watching)
    return
  unwatchFile(getProvidersFilePath())
  watching = false
}
