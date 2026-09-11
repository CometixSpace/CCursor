/**
 * models-catalog.json —— 只读的上游模型清单快照 (安装器从 models.dev 抓取)
 *
 * 用途: 面板"添加模型"时给出模糊搜索补全 + 默认值预填,
 *       特别是 contextTokenLimit 这种查官方文档才知道的数字。
 *
 * 格式 (部分字段):
 *   {
 *     [providerKey]: {
 *       id, name, npm, doc, env,
 *       models: {
 *         [modelId]: { id, name, reasoning, tool_call, modalities, limit: { context, output }, ... }
 *       }
 *     }
 *   }
 *
 * 设计:
 *   - 懒加载 + 进程内缓存,面板不在用时零开销
 *   - 扁平化 + 按 id 去重 (first-wins, 跨 provider 同模型参数一致)
 *   - 模糊搜索走 fuse.js,只索引 id + name —— 符合用户"按模型名找"的直觉
 *   - 文件 1.7MB / 4000+ 模型, 全量推给 webview 太重 → 只推搜索结果
 */
import { readFileSync } from 'node:fs'
import Fuse from 'fuse.js'
import { logger } from '../logger'
import { getModelsCatalogFilePath } from './paths'

export interface CatalogEntry {
  /** 上游 provider key, e.g. "anthropic", "openai", "moark" */
  providerKey: string
  /** 上游 provider 展示名, e.g. "Anthropic" */
  providerName: string
  /** 模型 id, e.g. "claude-opus-4-5" */
  id: string
  /** 展示名, e.g. "Claude Opus 4.5 (latest)" */
  name: string
  /** 上下文 token 限制 (catalog.limit.context) */
  contextLimit: number
  /** 输出 token 限制 (catalog.limit.output) — 暂未使用,保留以便未来扩展 */
  outputLimit?: number
  /** 原生 reasoning / thinking 支持 */
  reasoning: boolean
  /** 原生 tool_call 支持 */
  toolCall: boolean
  /** 输入模态含 image → 可映射到 supportsImages */
  hasImages: boolean
  /** 发布日期 (YYYY-MM-DD) — 用于搜索结果降序排列 */
  releaseDate?: string
}

interface CatalogRaw {
  [providerKey: string]: {
    id?: string
    name?: string
    models?: {
      [modelId: string]: {
        id?: string
        name?: string
        reasoning?: boolean
        tool_call?: boolean
        release_date?: string
        modalities?: { input?: string[], output?: string[] }
        limit?: { context?: number, output?: number }
      }
    }
  }
}

let cache: CatalogEntry[] | null = null
let fuse: Fuse<CatalogEntry> | null = null
let loadAttempted = false

function buildFuse(entries: CatalogEntry[]): Fuse<CatalogEntry> {
  return new Fuse(entries, {
    keys: [
      { name: 'id', weight: 2 },
      { name: 'name', weight: 1 },
    ],
    threshold: 0.4, // 0 = exact, 1 = match anything
    ignoreLocation: true, // 命中位置无所谓 (不偏好开头)
    minMatchCharLength: 2,
    includeScore: false,
  })
}

function flatten(raw: CatalogRaw): CatalogEntry[] {
  // 不做 id 去重 —— 不同聚合商对同一模型的 contextLimit 可能不一致 (catalog 未清理),
  // 全部保留让用户自己挑正确的来源。
  const out: CatalogEntry[] = []
  for (const [providerKey, prov] of Object.entries(raw)) {
    if (!prov || typeof prov !== 'object')
      continue
    const providerName = prov.name || providerKey
    const models = prov.models
    if (!models)
      continue
    for (const [modelId, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object')
        continue
      const ctx = m.limit?.context
      if (typeof ctx !== 'number')
        continue // 只保留有 context 的条目,否则预填意义不大
      out.push({
        providerKey,
        providerName,
        id: m.id || modelId,
        name: m.name || m.id || modelId,
        contextLimit: ctx,
        outputLimit: typeof m.limit?.output === 'number' ? m.limit.output : undefined,
        reasoning: m.reasoning === true,
        toolCall: m.tool_call === true,
        hasImages: Array.isArray(m.modalities?.input) && m.modalities!.input!.includes('image'),
        releaseDate: typeof m.release_date === 'string' ? m.release_date : undefined,
      })
    }
  }
  return out
}

function loadCatalog(): CatalogEntry[] {
  if (cache)
    return cache
  if (loadAttempted)
    return []
  loadAttempted = true
  try {
    const path = getModelsCatalogFilePath()
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as CatalogRaw
    cache = flatten(parsed)
    fuse = buildFuse(cache)
    logger.info({ count: cache.length }, '[CFG] models catalog loaded')
    return cache
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn({ err: msg }, '[CFG] models catalog unavailable (autocomplete disabled)')
    cache = []
    fuse = buildFuse(cache)
    return cache
  }
}

/**
 * Fuse.js 模糊搜索 id + name,返回前 N 条。
 * query 为空时返回按 releaseDate 降序的最新条目 (browse 模式)。
 */
export function searchCatalog(query: string, limit = 20): CatalogEntry[] {
  const entries = loadCatalog()
  if (!query.trim()) {
    return [...entries]
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
      .slice(0, limit)
  }
  if (!fuse)
    return []
  return fuse.search(query, { limit })
    .map(r => r.item)
    .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
}
