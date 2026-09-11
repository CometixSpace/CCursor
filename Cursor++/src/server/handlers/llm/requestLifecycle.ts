/** One request/attempt, never the shared provider client or owning run. */
export interface ProviderRequestLifecycle {
  signal: AbortSignal
  abort: (reason?: unknown) => void
  dispose: () => void
}

export function createProviderRequestLifecycle(parentSignal?: AbortSignal): ProviderRequestLifecycle {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parentSignal?.reason)

  if (parentSignal?.aborted)
    forwardAbort()
  else
    parentSignal?.addEventListener('abort', forwardAbort, { once: true })

  return {
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    dispose: () => parentSignal?.removeEventListener('abort', forwardAbort),
  }
}

/**
 * Abort before queueing generator.return(): return alone cannot interrupt a
 * generator awaiting an SDK request or an outstanding iterator.next().
 */
export function withProviderRequestLifecycle<Event>(
  createEvents: (lifecycle: ProviderRequestLifecycle) => AsyncIterable<Event>,
  parentSignal?: AbortSignal,
): AsyncGenerator<Event, void, unknown> {
  let lifecycle: ProviderRequestLifecycle | undefined
  let completed = false

  async function* iterate(): AsyncGenerator<Event, void, unknown> {
    lifecycle = createProviderRequestLifecycle(parentSignal)
    let iterator: AsyncIterator<Event> | undefined
    try {
      lifecycle.signal.throwIfAborted()
      iterator = createEvents(lifecycle)[Symbol.asyncIterator]()
      while (true) {
        lifecycle.signal.throwIfAborted()
        const result = await iterator.next()
        // Some SDKs turn AbortError into EOF. Do not report that as success.
        lifecycle.signal.throwIfAborted()
        if (result.done) {
          completed = true
          return
        }
        yield result.value
      }
    }
    catch (error) {
      lifecycle.signal.throwIfAborted()
      throw error
    }
    finally {
      if (!completed)
        lifecycle.abort()
      try {
        if (!completed)
          await iterator?.return?.()
      }
      finally {
        lifecycle.dispose()
      }
    }
  }

  const iterator = iterate()
  return {
    next: value => iterator.next(value),
    return(value) {
      if (!completed)
        lifecycle?.abort()
      return iterator.return(value)
    },
    throw(error) {
      if (!completed)
        lifecycle?.abort(error)
      return iterator.throw(error)
    },
    [Symbol.asyncIterator]() { return this },
  }
}
