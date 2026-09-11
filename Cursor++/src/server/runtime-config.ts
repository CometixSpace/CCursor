/**
 * Runtime config 兼容垫片
 *
 * 历史:此文件曾承载所有 LLM provider 的 baseUrl + apiKey + host/port,
 * 在 BYOK 重新设计后,Provider 凭据移交给 ~/.ccursor/providers.json,
 * server host/port 移交给 ~/.ccursor/routes.json。
 *
 * 本文件保留:
 *   - `Provider` 类型别名 (映射到 ProviderType, 部分历史代码仍引用)
 *   - `config.server.{host,port}` 只读视图 (读取 routesStore)
 *   - `initRuntimeConfig()` 兼容签名 (现在仅持久化 host/port 到 routes.json)
 *
 * 不再持有任何 LLM provider 凭据。
 */
import type { ProviderType } from './data/defaults'
import { loadRoutes, setServerHost, setServerPort } from './config/routesStore'

export type Provider = ProviderType

/** 只读视图: 调用方读 config.server.host/port 时实时取自 routes.json */
export const config = {
  server: {
    get host() {
      return loadRoutes().server.host
    },
    get port() {
      return loadRoutes().server.port
    },
  },
}

export interface RuntimeConfigInit {
  host?: string
  port?: number
}

export async function initRuntimeConfig(init: RuntimeConfigInit): Promise<void> {
  if (init.host !== undefined)
    await setServerHost(init.host)
  if (init.port !== undefined)
    await setServerPort(init.port)
}
