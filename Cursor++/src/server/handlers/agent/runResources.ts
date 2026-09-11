import { BlobResourceLimitError } from './blobStore'

// Project starting limits, not heap limits or official Cursor parameters.
export const MAX_ACTIVE_BLOB_RUNS = 4
export const MAX_PROCESS_BLOB_BYTES = 256 * 1024 * 1024

/** Admission is immediate: no hidden process-wide run queue or history eviction. */
export class RunResourceBudget {
  private activeRuns = 0
  private retainedBytes = 0

  constructor(private readonly limits = { maxRuns: MAX_ACTIVE_BLOB_RUNS, maxBytes: MAX_PROCESS_BLOB_BYTES }) {}

  acquire(): { resize: (bytes: number) => void, release: () => void } {
    if (this.activeRuns >= this.limits.maxRuns)
      throw new BlobResourceLimitError(`Active run capacity reached (${this.limits.maxRuns}); retry after another run finishes`)
    this.activeRuns++
    let ownedBytes = 0
    let released = false
    return {
      resize: (bytes) => {
        if (released)
          throw new BlobResourceLimitError('Cannot retain data after releasing run resources')
        const nextTotal = this.retainedBytes - ownedBytes + bytes
        if (nextTotal > this.limits.maxBytes)
          throw new BlobResourceLimitError(`Process blob payload capacity exceeded (${this.limits.maxBytes} bytes); required history cannot be evicted`)
        this.retainedBytes = nextTotal
        ownedBytes = bytes
      },
      release: () => {
        if (released)
          return
        released = true
        this.activeRuns--
        this.retainedBytes -= ownedBytes
      },
    }
  }

  getStats(): { activeRuns: number, retainedBytes: number } {
    return { activeRuns: this.activeRuns, retainedBytes: this.retainedBytes }
  }
}

export const processRunResources = new RunResourceBudget()

/** One bounded KV batch owns the wire slots, across every helper in a run. */
export class RunKvGate {
  private occupied = false
  private readonly waiters: Array<() => void> = []

  acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted)
      return Promise.resolve(undefined)
    if (this.occupied && this.waiters.length >= 32)
      throw new BlobResourceLimitError('Run KV operation queue is full (32 waiting batches)')
    const waiters = this.waiters
    return new Promise((resolve) => {
      const cancel = (): void => {
        removeWaiter()
        resolve(undefined)
      }
      const grant = (): void => {
        removeWaiter()
        if (signal.aborted) {
          resolve(undefined)
          this.release()
          return
        }
        this.occupied = true
        let released = false
        const releaseLease = (): void => {
          if (!released) {
            released = true
            signal.removeEventListener('abort', releaseLease)
            this.release()
          }
        }
        // The consumer may be suspended at a heartbeat when this grant resolves.
        // Its operation still owns cleanup even before it receives the callback.
        signal.addEventListener('abort', releaseLease, { once: true })
        resolve(releaseLease)
      }
      function removeWaiter(): void {
        const position = waiters.indexOf(grant)
        if (position >= 0)
          waiters.splice(position, 1)
        signal.removeEventListener('abort', cancel)
      }
      signal.addEventListener('abort', cancel, { once: true })
      if (this.occupied)
        this.waiters.push(grant)
      else
        grant()
    })
  }

  private release(): void {
    this.occupied = false
    this.waiters.shift()?.()
  }
}
