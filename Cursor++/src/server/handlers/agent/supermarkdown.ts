type ConvertFn = (html: string, options: Record<string, unknown>) => string

type LoadResult =
  | { ok: true, convert: ConvertFn }
  | { ok: false, error: Error }

let cached: LoadResult | null = null
let notifier: ((error: Error) => void) | null = null
let notified = false

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function notify(error: Error): void {
  if (notified)
    return
  notified = true
  notifier?.(error)
}

export function isLikelyWindowsMsvcMissing(error: unknown): boolean {
  if (process.platform !== 'win32')
    return false
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return /supermarkdown\.win32-x64-msvc\.node/i.test(message)
    && (/The specified module could not be found/i.test(message) || /找不到指定的模块/i.test(message))
}

export function supermarkdownUnavailableMessage(_error?: Error): string {
  if (process.platform === 'win32') {
    return 'Built-in Web Fetch is unavailable because supermarkdown native module failed to load. On Windows, install Microsoft Visual C++ Redistributable 2015-2022 x64 and restart Cursor.'
  }
  return 'Built-in Web Fetch is unavailable because supermarkdown native module failed to load. Restart Cursor or reinstall Cursor++.'
}

export function setSupermarkdownNativeErrorNotifier(fn: (error: Error) => void): void {
  notifier = fn
  if (cached && !cached.ok)
    notify(cached.error)
}

export function loadSupermarkdown(): LoadResult {
  if (cached)
    return cached

  try {
    // Lazy-load the native module so extension activation does not fail when
    // Windows lacks the MSVC runtime required by supermarkdown.win32-x64-msvc.node.
    const mod = require('@vakra-dev/supermarkdown') as { convert?: ConvertFn }
    if (typeof mod.convert !== 'function')
      throw new TypeError('@vakra-dev/supermarkdown did not export convert()')
    cached = { ok: true, convert: mod.convert }
  }
  catch (error) {
    cached = { ok: false, error: toError(error) }
    notify(cached.error)
  }

  return cached
}

export function preflightSupermarkdown(): void {
  loadSupermarkdown()
}
