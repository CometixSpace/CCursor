export interface BlobFailure {
  blobId: string
  status: string
  message?: string
}

/** Missing or corrupt required history must never turn into a shorter prompt. */
export class BlobIntegrityError extends Error {
  readonly retryable: boolean

  constructor(readonly failures: BlobFailure[]) {
    super(`Required conversation blobs are unavailable: ${failures.map(failure => `${failure.blobId} (${failure.status})`).join(', ')}`)
    this.name = 'BlobIntegrityError'
    this.retryable = failures.every(failure => ['timeout', 'overall-timeout', 'client-error', 'cancelled'].includes(failure.status))
  }
}
