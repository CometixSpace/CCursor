/**
 * web-tools.json 配置存储 — Search + Fetch Provider 管理
 */
import type { WebToolsConfig } from '../data/defaults'
import { DEFAULT_WEB_TOOLS } from '../data/defaults'
import { logger } from '../logger'
import { readJsonOrNull, withSerial, writeJsonAtomic } from './atomic'
import { getWebToolsFilePath } from './paths'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: WebToolsConfig | null = null

function withFallback(loaded: Partial<WebToolsConfig> | null): WebToolsConfig {
  if (!loaded)
    return clone(DEFAULT_WEB_TOOLS)
  return {
    $schemaVersion: loaded.$schemaVersion ?? DEFAULT_WEB_TOOLS.$schemaVersion,
    search: {
      providers: loaded.search?.providers ?? clone(DEFAULT_WEB_TOOLS.search.providers),
      parallel: loaded.search?.parallel ?? DEFAULT_WEB_TOOLS.search.parallel,
      maxResults: loaded.search?.maxResults ?? DEFAULT_WEB_TOOLS.search.maxResults,
    },
    fetch: {
      provider: loaded.fetch?.provider ?? DEFAULT_WEB_TOOLS.fetch.provider,
      ...(loaded.fetch?.jina ? { jina: loaded.fetch.jina } : {}),
      ...(loaded.fetch?.firecrawl ? { firecrawl: loaded.fetch.firecrawl } : {}),
    },
  }
}

export function loadWebTools(): WebToolsConfig {
  if (cache)
    return cache
  const loaded = readJsonOrNull<Partial<WebToolsConfig>>(getWebToolsFilePath())
  cache = withFallback(loaded)
  return cache
}

export function updateWebTools(updater: (draft: WebToolsConfig) => void): Promise<WebToolsConfig> {
  return withSerial('web-tools', async () => {
    const path = getWebToolsFilePath()
    const existing = readJsonOrNull<Partial<WebToolsConfig>>(path)
    cache = withFallback(existing)
    const draft = clone(cache)
    updater(draft)
    writeJsonAtomic(path, draft)
    cache = draft
    logger.info({ searchProviders: draft.search.providers.length, fetchProvider: draft.fetch.provider }, '[CFG] web-tools updated')
    return clone(cache)
  })
}

export function getWebTools(): WebToolsConfig {
  return cache ?? loadWebTools()
}

// Backward compat aliases
export function getSearchConfig() {
  return getWebTools().search
}

export function getFetchConfig() {
  return getWebTools().fetch
}
