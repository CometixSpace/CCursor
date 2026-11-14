import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { resetAgentDatabaseForTests } from '../database/sqlite'
import { encodeBlob } from '../handlers/agent/blob'
import { cacheBlob, resetBlobCacheForTests } from '../handlers/agent/blobStore'

/** 每条用例用一个全新的临时库和空的 blob 缓存, 不碰 ~/.ccursor 下的真实数据 */
export function useTempAgentDatabase(): void {
  let dbPath = ''

  beforeEach(async () => {
    dbPath = join(tmpdir(), `.tmp-agent-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    process.env.BYOK_AGENT_DB_PATH = dbPath
    await resetAgentDatabaseForTests()
    resetBlobCacheForTests()
  })

  afterEach(async () => {
    await resetAgentDatabaseForTests()
    resetBlobCacheForTests()
    delete process.env.BYOK_AGENT_DB_PATH
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`)
      }
      catch {}
    }
  })
}

/** 把一条消息放进 blob 缓存, 返回它的 blobId */
export function cacheMessage(role: 'system' | 'user' | 'assistant', content: string): string {
  const blob = encodeBlob({ role, content })
  cacheBlob(blob.blobId, blob.blobData)
  return blob.blobId
}

/** 缓存里的一段长历史: 系统提示 + 10 条各约 500 token 的往来, 返回各自的 blobId */
export function longHistory(): string[] {
  return [
    cacheMessage('system', 'sys prompt'),
    ...Array.from({ length: 10 }, (_, i) => cacheMessage(i % 2 ? 'assistant' : 'user', `message ${i}: ${'x'.repeat(2_000)}`)),
  ]
}
