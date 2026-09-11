/**
 * SQLite 持久层 — @vscode/sqlite3 (Cursor 内置)
 *
 * 通过 createRequire 从 Cursor app 路径动态加载 @vscode/sqlite3，
 * 避免 bundle 原生模块。该模块的 native binding 已与 Cursor 的 Electron ABI 匹配。
 *
 * API 说明:
 * - @vscode/sqlite3 基于 node-sqlite3，是异步回调 API
 * - 本 wrapper 提供 Promise 化的 AsyncDatabase 接口
 * - getAgentDatabase() 保持同步返回已打开的实例
 * - initDatabase() 为异步，必须在 startServer() 时先调用
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getDatabaseFilePath } from '../config/paths'
import { logger } from '../logger'

// ---------- dynamic require of @vscode/sqlite3 ----------

type Sqlite3Module = any

let sqlite3Module: Sqlite3Module | null = null

/**
 * 候选 Cursor resources/app 目录
 *
 * 策略 (按优先级):
 *   1. 测试用 env override: CURSOR_APP_ROOT
 *   2. 相对定位: 从扩展自身的 __dirname 往上 3 层
 *      我们装在 <cursorRoot>/resources/app/extensions/cursor2plus/dist/extension.js
 *      __dirname = .../extensions/cursor2plus/dist
 *      ../../.. = .../app  ← target
 *      这一条天然跨平台 (mac/linux/win 无关),优先级最高的自动路径
 *   3. 平台硬编码 fallback: 当 1/2 都失败时的防御性兜底
 *      包括 Windows 的常见安装路径 (per-user / system-wide / scoop)
 */
function getCursorAppCandidates(): string[] {
  const candidates: string[] = []

  const envPath = process.env.CURSOR_APP_ROOT
  if (envPath && existsSync(join(envPath, 'package.json')))
    candidates.push(envPath)

  // 相对扩展自身位置反推 —— 真正的跨平台方案
  try {
    const relFromSelf = resolve(__dirname, '..', '..', '..')
    candidates.push(relFromSelf)
  }
  catch {}

  const home = homedir()
  switch (platform()) {
    case 'darwin':
      candidates.push(
        '/Applications/Cursor.app/Contents/Resources/app',
        join(home, 'Applications/Cursor.app/Contents/Resources/app'),
      )
      break
    case 'linux':
      candidates.push(
        '/opt/Cursor/resources/app',
        '/opt/cursor/resources/app',
        '/usr/share/cursor/resources/app',
        '/usr/lib/cursor/resources/app',
        join(home, '.local/share/cursor/resources/app'),
      )
      break
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
      candidates.push(
        join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
        join(localAppData, 'Programs', 'Cursor', 'resources', 'app'),
        join(programFiles, 'Cursor', 'resources', 'app'),
        join(programFilesX86, 'Cursor', 'resources', 'app'),
        join(home, 'scoop', 'apps', 'cursor', 'current', 'resources', 'app'),
      )
      break
    }
  }

  return candidates
}

function loadSqlite3(): Sqlite3Module {
  if (sqlite3Module)
    return sqlite3Module

  const candidates = getCursorAppCandidates()
  const tried: Array<{ path: string, error: string }> = []

  for (const candidate of candidates) {
    const pkgJson = join(candidate, 'package.json')
    if (!existsSync(pkgJson)) {
      tried.push({ path: candidate, error: 'no package.json' })
      continue
    }
    try {
      const req = createRequire(pkgJson)
      const mod = req('@vscode/sqlite3')
      logger.info({ source: candidate }, '[DB] loaded @vscode/sqlite3 from Cursor app')
      sqlite3Module = mod
      return mod
    }
    catch (e) {
      tried.push({ path: candidate, error: (e as Error).message })
    }
  }

  logger.error({ tried }, '[DB] failed to load @vscode/sqlite3 from any candidate')
  throw new Error(
    `Failed to load @vscode/sqlite3. Tried ${candidates.length} paths — see logs.`
    + ' Set CURSOR_APP_ROOT env var to override.',
  )
}

// ---------- wrapper types ----------

export interface RunResult {
  lastID: number
  changes: number
}

export interface AsyncDatabase {
  exec: (sql: string) => Promise<void>
  run: (sql: string, params?: unknown) => Promise<RunResult>
  get: <T = unknown>(sql: string, params?: unknown) => Promise<T | undefined>
  all: <T = unknown>(sql: string, params?: unknown) => Promise<T[]>
  transaction: <T>(fn: () => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

// ---------- wrapper implementation ----------

function wrapDatabase(rawDb: any): AsyncDatabase {
  const db: AsyncDatabase = {
    exec(sql: string): Promise<void> {
      return new Promise((resolve, reject) => {
        rawDb.exec(sql, (err: Error | null) => err ? reject(err) : resolve())
      })
    },
    run(sql: string, params?: unknown): Promise<RunResult> {
      return new Promise((resolve, reject) => {
        const cb = function (this: any, err: Error | null) {
          if (err)
            reject(err)
          else resolve({ lastID: this.lastID as number, changes: this.changes as number })
        }
        if (params === undefined)
          rawDb.run(sql, cb)
        else
          rawDb.run(sql, params, cb)
      })
    },
    get<T = unknown>(sql: string, params?: unknown): Promise<T | undefined> {
      return new Promise((resolve, reject) => {
        const cb = (err: Error | null, row: T | undefined) => {
          if (err)
            reject(err)
          else resolve(row)
        }
        if (params === undefined)
          rawDb.get(sql, cb)
        else
          rawDb.get(sql, params, cb)
      })
    },
    all<T = unknown>(sql: string, params?: unknown): Promise<T[]> {
      return new Promise((resolve, reject) => {
        const cb = (err: Error | null, rows: T[] | undefined) => {
          if (err)
            reject(err)
          else resolve(rows || [])
        }
        if (params === undefined)
          rawDb.all(sql, cb)
        else
          rawDb.all(sql, params, cb)
      })
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // 手动 BEGIN/COMMIT/ROLLBACK，注意 fn 内的 db 操作必须严格 await
      await db.exec('BEGIN')
      try {
        const result = await fn()
        await db.exec('COMMIT')
        return result
      }
      catch (e) {
        try {
          await db.exec('ROLLBACK')
        }
        catch {}
        throw e
      }
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        rawDb.close((err: Error | null) => err ? reject(err) : resolve())
      })
    },
  }
  return db
}

// ---------- module state ----------

let db: AsyncDatabase | null = null
let checkpointDatabase: AsyncDatabase | null = null
let dbPath: string | null = null

export function resolveAgentDatabasePath(): string {
  return process.env.BYOK_AGENT_DB_PATH || getDatabaseFilePath()
}

async function openDatabaseConnection(databasePath: string): Promise<AsyncDatabase> {
  const sqlite3 = loadSqlite3()
  const rawDatabase = await new Promise<unknown>((resolve, reject) => {
    const instance = new sqlite3.Database(databasePath, (error: Error | null) => {
      if (error)
        reject(error)
      else resolve(instance)
    })
  })
  const database = wrapDatabase(rawDatabase)
  try {
    await database.exec('PRAGMA busy_timeout = 5000')
    await database.exec('PRAGMA journal_mode = WAL')
    await database.exec('PRAGMA synchronous = NORMAL')
    await database.exec('PRAGMA foreign_keys = ON')
    return database
  }
  catch (error) {
    await database.close()
    throw error
  }
}

async function initializeSchema(database: AsyncDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_checkpoints (
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'committed',
      root_blob_ids_json TEXT NOT NULL,
      turn_blob_ids_json TEXT NOT NULL DEFAULT '[]',
      summary_archive_ids_json TEXT NOT NULL,
      used_tokens INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      write_token TEXT NOT NULL DEFAULT '',
      is_deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_checkpoints_updated_at
      ON conversation_checkpoints(updated_at);

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      truncation_bubble_id_inclusive TEXT NOT NULL,
      resume_bubble_id_inclusive TEXT NOT NULL,
      previous_summary_bubble_id TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      includes_tool_results INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, kind, truncation_bubble_id_inclusive)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_lookup
      ON conversation_summaries(conversation_id, kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS model_usage_stats (
      day TEXT NOT NULL,
      hour INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      api_model TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (day, hour, provider_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_model_usage_stats_day
      ON model_usage_stats(day);
  `)

  // ── Schema 迁移: conversation_checkpoints 新增 kind 列 ──
  // 旧表 PRIMARY KEY 是 conversation_id (单列), 新表需要 (conversation_id, kind) 复合键。
  // SQLite 不支持 ALTER PRIMARY KEY, 只能重建表。
  try {
    await database.get(`SELECT kind FROM conversation_checkpoints LIMIT 1`)
  }
  catch {
    // kind 列不存在 → 旧 schema, 需要迁移
    await database.exec(`
      ALTER TABLE conversation_checkpoints RENAME TO conversation_checkpoints_old;
      CREATE TABLE conversation_checkpoints (
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'committed',
        root_blob_ids_json TEXT NOT NULL,
        turn_blob_ids_json TEXT NOT NULL DEFAULT '[]',
        summary_archive_ids_json TEXT NOT NULL,
        used_tokens INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, kind)
      );
      INSERT INTO conversation_checkpoints
        SELECT conversation_id, 'committed', root_blob_ids_json, '[]', summary_archive_ids_json,
               used_tokens, max_tokens, mode, updated_at
        FROM conversation_checkpoints_old;
      DROP TABLE conversation_checkpoints_old;
    `)
  }

  // ── Schema 迁移: conversation_checkpoints 新增 turn_blob_ids_json 列 ──
  try {
    await database.get(`SELECT turn_blob_ids_json FROM conversation_checkpoints LIMIT 1`)
  }
  catch {
    await database.exec(`
      ALTER TABLE conversation_checkpoints
      ADD COLUMN turn_blob_ids_json TEXT NOT NULL DEFAULT '[]';
    `)
  }

  // Add the ownership token after older table rebuilds so their row shape stays valid.
  const checkpointColumns = await database.all<{ name: string }>('PRAGMA table_info(conversation_checkpoints)')
  if (!checkpointColumns.some(column => column.name === 'write_token')) {
    await database.exec(`
      ALTER TABLE conversation_checkpoints
      ADD COLUMN write_token TEXT NOT NULL DEFAULT '';
    `)
  }
  // Deleted checkpoints retain their tokens so old run scopes cannot resurrect them.
  if (!checkpointColumns.some(column => column.name === 'is_deleted')) {
    await database.exec(`
      ALTER TABLE conversation_checkpoints
      ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
    `)
  }
  if (!checkpointColumns.some(column => column.name === 'terminal_receipt_json')) {
    await database.exec(`
      ALTER TABLE conversation_checkpoints
      ADD COLUMN terminal_receipt_json TEXT NOT NULL DEFAULT '';
    `)
  }

  // Recovery snapshots are metadata, not a second blob store. Never prune them
  // during upgrades: they retain both candidates before a conditional adoption.
  await database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_checkpoint_recovery (
      snapshot_id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      checkpoint_rows_json TEXT NOT NULL,
      preserved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoint_recovery_conversation
      ON conversation_checkpoint_recovery(conversation_id);
  `)
}

/**
 * 异步初始化 DB。必须在 getAgentDatabase() 首次使用前调用。
 * 在 startServer() 中调用。
 */
export async function initDatabase(): Promise<void> {
  const nextPath = resolveAgentDatabasePath()
  if (db && dbPath === nextPath)
    return

  await closeAgentDatabase()

  mkdirSync(dirname(nextPath), { recursive: true })

  const nextDatabase = await openDatabaseConnection(nextPath)
  try {
    // Legacy blob tables are left untouched; runtime blob storage is not SQLite.
    await initializeSchema(nextDatabase)
    // Checkpoint acceptance must not join a summary/usage transaction on the shared
    // connection. This connection is autocommit-only; each CAS is one statement.
    checkpointDatabase = await openDatabaseConnection(nextPath)
  }
  catch (error) {
    try {
      await nextDatabase.close()
    }
    catch (closeError) {
      logger.warn({ error: (closeError as Error).message }, '[DB] failed to close database after schema initialization failed')
    }
    throw error
  }

  db = nextDatabase
  dbPath = nextPath
  logger.info({ agentDbPath: nextPath }, '[DB] agent sqlite persistence ready')
}

/**
 * 同步获取已初始化的 DB 实例。
 * 调用前必须确保 initDatabase() 已完成。
 */
export function getAgentDatabase(): AsyncDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

/** Only single-statement operations; never expose transaction/exec to checkpoint callers. */
export function getCheckpointDatabase(): Pick<AsyncDatabase, 'get' | 'all' | 'run'> {
  if (!checkpointDatabase) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return checkpointDatabase
}

export async function closeAgentDatabase(): Promise<void> {
  if (checkpointDatabase) {
    await checkpointDatabase.close()
    checkpointDatabase = null
  }
  if (!db)
    return
  await db.close()
  db = null
  dbPath = null
}

/**
 * 测试用：关闭并重建 DB 实例。
 *
 * 语义等价于 close + init —— 测试每次 setUp 调用后,
 * getAgentDatabase() 立即可用,无需再显式 await initDatabase()。
 *
 * 这样老 server 仓库里"resetForTests 后直接访问 DB"的测试代码
 * 可以原样迁入,只需将调用点包成 async/await 即可。
 */
export async function resetAgentDatabaseForTests(): Promise<void> {
  await closeAgentDatabase()
  await initDatabase()
}
