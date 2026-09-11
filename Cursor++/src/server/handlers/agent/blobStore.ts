import type { HistoryEntry } from './historyManager'
import type { TurnBaseline } from './turnTracker'
import { BlobIntegrityError, type BlobFailure } from './blobErrors'

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 100_000

/** Required working-set data cannot be evicted to recover from a resource limit. */
export class BlobResourceLimitError extends Error {
    readonly retryable = false

    constructor(message: string) {
        super(message)
        this.name = 'BlobResourceLimitError'
    }
}

export class BlobInactiveError extends BlobIntegrityError {
    constructor(message: string) {
        super([{ blobId: '(blob-run)', status: 'inactive-run', message }])
        this.name = 'BlobInactiveError'
        this.message = message
    }
}

export interface RetainedBlob {
    blobId: string
    /** Normalized base64 data, independent of the original client wire encoding. */
    blobData: string
    /** Exact wire bytes when known, including client JSON as well as protobuf. */
    blobDataRaw?: Uint8Array
    dependencies: string[]
}

/**
 * A run retains its entire working set until disposal; no required data is evicted.
 * maxBytes bounds raw and normalized payload bytes, not JavaScript heap usage:
 * decoded objects, map/set overhead and reference strings are not byte-counted.
 * maxRecords separately bounds distinct blob identities, including empty results,
 * inherited references and dependencies. Decoded caches use those same identities.
 */
export class RunBlobStore {
    readonly historyEntries = new Map<string, HistoryEntry>()
    readonly turnBaselines = new Map<string, TurnBaseline>()

    private readonly retainedBlobs = new Map<string, RetainedBlob>()
    private readonly inheritedReferences = new Set<string>()
    private readonly clientSavedIds = new Set<string>()
    private readonly recordedBlobIds = new Set<string>()
    private readonly maxBytes: number
    private readonly maxRecords: number
    private readonly onRetainedBytes?: (bytes: number) => void
    private retainedBytes = 0
    private clientResultBytes = 0
    private disposed = false

    constructor(options: { maxBytes?: number, maxRecords?: number, onRetainedBytes?: (bytes: number) => void } = {}) {
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
        this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
        this.onRetainedBytes = options.onRetainedBytes
        if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0)
            throw new BlobResourceLimitError(`Invalid run blob retention limit: ${this.maxBytes}`)
        if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 0)
            throw new BlobResourceLimitError(`Invalid run blob record limit: ${this.maxRecords}`)
    }

    cacheBlob(blobId: string, blobData: string, blobDataRaw?: Uint8Array, dependencies?: string[]): void {
        this.assertActive()
        const previous = this.retainedBlobs.get(blobId)
        if (previous && previous.blobData !== blobData) {
            throw new BlobIntegrityError([{ blobId, status: 'content-conflict', message: `Run blob content changed for retained id ${blobId}` }])
        }
        if (previous?.blobDataRaw && blobDataRaw && !Buffer.from(previous.blobDataRaw).equals(blobDataRaw)) {
            throw new BlobIntegrityError([{ blobId, status: 'content-conflict', message: `Run blob raw bytes changed for retained id ${blobId}` }])
        }

        const rawBytes = blobDataRaw ?? previous?.blobDataRaw
        const nextBytes = Buffer.byteLength(blobData) + (rawBytes?.byteLength ?? 0)
        const previousBytes = previous
            ? Buffer.byteLength(previous.blobData) + (previous.blobDataRaw?.byteLength ?? 0)
            : 0
        this.assertWithinLimit(this.retainedBytes - previousBytes + nextBytes + this.clientResultBytes, blobId)
        this.reserveBlobRecords([blobId, ...(dependencies ?? [])])
        this.onRetainedBytes?.(this.retainedBytes - previousBytes + nextBytes + this.clientResultBytes)

        this.retainedBlobs.set(blobId, {
            blobId,
            blobData,
            // Re-encoding a turn can revisit this entry; do not copy identical bytes again.
            blobDataRaw: previous?.blobDataRaw ?? (rawBytes ? new Uint8Array(rawBytes) : undefined),
            dependencies: [...new Set([...(previous?.dependencies ?? []), ...(dependencies ?? [])])],
        })
        this.retainedBytes += nextBytes - previousBytes
    }

    getCachedBlob(blobId: string): string | undefined {
        return this.retainedBlobs.get(blobId)?.blobData
    }

    getBlob(blobId: string): RetainedBlob | undefined {
        return this.retainedBlobs.get(blobId)
    }

    markClientSaved(blobId: string): void {
        this.reserveBlobRecord(blobId)
        this.clientSavedIds.add(blobId)
    }

    isClientSaved(blobId: string): boolean {
        return this.clientSavedIds.has(blobId)
    }

    addInheritedReferences(blobIds: Iterable<string>): void {
        this.assertActive()
        for (const blobId of blobIds) {
            this.reserveBlobRecord(blobId)
            this.inheritedReferences.add(blobId)
        }
    }

    getPendingBlobs(): RetainedBlob[] {
        return [...this.retainedBlobs.values()].filter(blob => !this.clientSavedIds.has(blob.blobId))
    }

    assertCheckpointReferences(blobIds: string[]): void {
        this.assertActive()
        // Also validate unsummarized originals: all pending data must be sent, even
        // when reachable only through a newly generated summary/archive blob.
        const remaining: Array<{ blobId: string, owner?: string }> = [...blobIds, ...this.retainedBlobs.keys()].map(blobId => ({ blobId }))
        const checked = new Set<string>()
        const failures: BlobFailure[] = []
        while (remaining.length > 0) {
            const reference = remaining.pop()!
            const checkIdentity = `${reference.owner === undefined ? 'inherited' : 'required'}:${reference.blobId}`
            if (checked.has(checkIdentity))
                continue
            checked.add(checkIdentity)
            const blob = this.retainedBlobs.get(reference.blobId)
            // Inheritance permits only untouched checkpoint edges, never dependencies
            // of content this run has restored, re-encoded or accepted for upload.
            if (!blob && (reference.owner !== undefined || !this.inheritedReferences.has(reference.blobId))) {
                failures.push({
                    blobId: reference.blobId,
                    status: reference.owner === undefined ? 'missing-reference' : 'missing-dependency',
                    message: `Checkpoint references unavailable blob ${reference.blobId} (referenced by ${reference.owner ?? 'checkpoint'})`,
                })
            }
            for (const dependency of blob?.dependencies ?? [])
                remaining.push({ blobId: dependency, owner: reference.blobId })
        }
        if (failures.length > 0)
            throw new BlobIntegrityError(failures)
    }

    /** Reserve a shared identity for raw Get results, including failures/empty data. */
    reserveBlobRecord(blobId: string): void {
        this.assertActive()
        this.reserveBlobRecords([blobId])
    }

    /** Raw Get results share the same payload budget as normalized retained blobs. */
    retainClientResultBytes(byteLength: number, wireKey: string): void {
        this.assertActive()
        this.assertWithinLimit(this.retainedBytes + this.clientResultBytes + byteLength, `wire key ${wireKey}`)
        this.onRetainedBytes?.(this.retainedBytes + this.clientResultBytes + byteLength)
        this.clientResultBytes += byteLength
    }

    getStats(): { entries: number, records: number, bytes: number, clientResultBytes: number, pending: number } {
        return {
            entries: this.retainedBlobs.size,
            records: this.recordedBlobIds.size,
            bytes: this.retainedBytes + this.clientResultBytes,
            clientResultBytes: this.clientResultBytes,
            pending: this.getPendingBlobs().length,
        }
    }

    dispose(): void {
        this.disposed = true
        this.retainedBlobs.clear()
        this.inheritedReferences.clear()
        this.clientSavedIds.clear()
        this.recordedBlobIds.clear()
        this.historyEntries.clear()
        this.turnBaselines.clear()
        this.retainedBytes = 0
        this.clientResultBytes = 0
    }

    private assertWithinLimit(requiredBytes: number, blobId: string): void {
        if (requiredBytes > this.maxBytes) {
            throw new BlobResourceLimitError(`Run blob retention limit exceeded for ${blobId}: requires ${requiredBytes} bytes, limit ${this.maxBytes}; required blobs cannot be evicted`)
        }
    }

    private reserveBlobRecords(blobIds: Iterable<string>): void {
        const additionalBlobIds = new Set<string>()
        for (const blobId of blobIds) {
            if (this.recordedBlobIds.has(blobId) || additionalBlobIds.has(blobId))
                continue
            const requiredRecords = this.recordedBlobIds.size + additionalBlobIds.size + 1
            if (requiredRecords > this.maxRecords) {
                throw new BlobResourceLimitError(`Run blob record limit exceeded for ${blobId}: requires ${requiredRecords} records, limit ${this.maxRecords}; required blobs cannot be evicted`)
            }
            additionalBlobIds.add(blobId)
        }
        for (const blobId of additionalBlobIds)
            this.recordedBlobIds.add(blobId)
    }

    private assertActive(): void {
        if (this.disposed)
            throw new BlobInactiveError('Run blob store has been disposed')
    }
}
