import { Code, ConnectError } from '@connectrpc/connect'

interface UploadEntry {
  bytes: Uint8Array
  expiresAt: number
}

interface UploadChunk {
  conversationId: string
  blobs: Array<{ id: Uint8Array, value: Uint8Array }>
  chunkIndex: number
  totalChunks: number
}

/**
 * Pre-run RPC handoff only. Accepted, unexpired uploads are not evicted to admit
 * another upload. Reads copy rather than consume: concurrent runs can share an
 * upload, but never own or clear each other's working data.
 */
export class UploadHandoff {
  private readonly conversations = new Map<string, Map<string, UploadEntry>>()
  private retainedBytes = 0
  private retainedEntries = 0
  private retainedKeyBytes = 0

  constructor(private readonly options: {
    maxBytes?: number
    maxEntries?: number
    /** Separate bound for hex keys and conversation identities, including empty values. */
    maxKeyBytes?: number
    ttlMs?: number
    now?: () => number
  } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  pruneExpired(): void {
    const now = this.now()
    for (const [conversationId, entries] of this.conversations) {
      for (const [key, entry] of entries) {
        if (entry.expiresAt > now)
          continue
        entries.delete(key)
        this.retainedBytes -= entry.bytes.byteLength
        this.retainedEntries--
        this.retainedKeyBytes -= key.length
      }
      if (entries.size === 0) {
        this.conversations.delete(conversationId)
        this.retainedKeyBytes -= Buffer.byteLength(conversationId)
      }
    }
  }

  putChunk(chunk: UploadChunk): void {
    if (!chunk.conversationId)
      throw new ConnectError('UploadConversationBlobs requires conversationId for isolation', Code.InvalidArgument)
    this.pruneExpired()
    const existing = this.conversations.get(chunk.conversationId)
    const incoming = new Map<string, Uint8Array>()
    let additionalBytes = 0
    let additionalEntries = 0
    let additionalKeyBytes = existing || chunk.blobs.length === 0 ? 0 : Buffer.byteLength(chunk.conversationId)
    const keyBudget = this.options.maxKeyBytes ?? 8 * 1024 * 1024
    if (this.retainedKeyBytes + additionalKeyBytes > keyBudget)
      throw new ConnectError('Pre-run upload identity capacity exceeded', Code.ResourceExhausted)
    for (const blob of chunk.blobs) {
      if (blob.id.byteLength === 0)
        throw new ConnectError('Uploaded blob key is empty', Code.InvalidArgument)
      if (blob.id.byteLength * 2 > keyBudget)
        throw new ConnectError('Pre-run upload identity capacity exceeded', Code.ResourceExhausted)
      const key = Buffer.from(blob.id.buffer, blob.id.byteOffset, blob.id.byteLength).toString('hex')
      const previous = incoming.get(key) ?? existing?.get(key)?.bytes
      if (previous) {
        if (!Buffer.from(previous.buffer, previous.byteOffset, previous.byteLength).equals(blob.value))
          throw new ConnectError('Conflicting upload for the same conversation and blob key', Code.FailedPrecondition)
      }
      else {
        additionalBytes += blob.value.byteLength
        additionalEntries++
        additionalKeyBytes += key.length
      }
      if (this.retainedKeyBytes + additionalKeyBytes > keyBudget)
        throw new ConnectError('Pre-run upload identity capacity exceeded', Code.ResourceExhausted)
      incoming.set(key, blob.value)
    }
    if (this.retainedBytes + additionalBytes > (this.options.maxBytes ?? 128 * 1024 * 1024)
      || this.retainedEntries + additionalEntries > (this.options.maxEntries ?? 16_384)) {
      throw new ConnectError('Pre-run upload capacity exceeded; retry after active uploads expire', Code.ResourceExhausted)
    }
    const entries = existing ?? new Map<string, UploadEntry>()
    const expiresAt = this.now() + (this.options.ttlMs ?? 5 * 60_000)
    for (const [key, bytes] of incoming)
      entries.set(key, { bytes: entries.get(key)?.bytes ?? Uint8Array.from(bytes), expiresAt })
    if (entries.size > 0)
      this.conversations.set(chunk.conversationId, entries)
    this.retainedBytes += additionalBytes
    this.retainedEntries += additionalEntries
    this.retainedKeyBytes += additionalKeyBytes
  }

  read(conversationId: string, blobId: Uint8Array): Uint8Array | undefined {
    if (blobId.byteLength * 2 > (this.options.maxKeyBytes ?? 8 * 1024 * 1024))
      return undefined
    const entries = this.conversations.get(conversationId)
    const key = Buffer.from(blobId.buffer, blobId.byteOffset, blobId.byteLength).toString('hex')
    const entry = entries?.get(key)
    if (!entry)
      return undefined
    if (entry.expiresAt <= this.now()) {
      entries!.delete(key)
      this.retainedBytes -= entry.bytes.byteLength
      this.retainedEntries--
      this.retainedKeyBytes -= key.length
      if (entries!.size === 0) {
        this.conversations.delete(conversationId)
        this.retainedKeyBytes -= Buffer.byteLength(conversationId)
      }
      return undefined
    }
    return Uint8Array.from(entry.bytes)
  }

  getStats(): { entries: number, bytes: number } {
    this.pruneExpired()
    return { entries: this.retainedEntries, bytes: this.retainedBytes }
  }
}

// This is deliberately the only cross-RPC blob data, not a history hot cache.
export const uploadHandoff = new UploadHandoff()
