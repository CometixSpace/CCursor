import type { ClientBlobResult } from './clientBlobFetch'
import type { CheckpointDelivery } from './checkpointDelivery'
import type { AgentSession } from './session'
import { setMaxListeners } from 'node:events'
import { blobIdFromBytes } from './blob'
import { BlobInactiveError, BlobResourceLimitError, RunBlobStore } from './blobStore'
import { discardSessionMessages, isSessionCancelled } from './session'
import { RunKvGate, type RunResourceBudget } from './runResources'
import type { CheckpointWriteScope } from '../../database/checkpoints'

// Initial operational defaults, not protocol guarantees or official client limits.
export const BLOB_KV_BATCH_SIZE = 32
export const BLOB_KV_TIMEOUT_MS = 10_000
export const BLOB_KV_OVERALL_TIMEOUT_MS = 60_000

export interface BlobRunOptions {
    conversationId?: string
    resourceBudget?: RunResourceBudget
    inheritedBlobIds?: Iterable<string>
    /** Approximate payload bound; excludes decoded objects and collection overhead. */
    maxBytes?: number
    /** Maximum distinct blob identities, including failed/empty Gets; default 100,000. */
    maxRecords?: number
    batchSize?: number
    timeoutMs?: number
    overallTimeoutMs?: number
}

export interface RunClientBlobRead {
    readonly promise: Promise<ClientBlobResult>
    readonly result: ClientBlobResult | undefined
    complete: (result: ClientBlobResult) => void
}

export function normalizeBlobBatchSize(batchSize: number): number {
    if (!Number.isFinite(batchSize) || batchSize <= 0)
        throw new BlobResourceLimitError(`Invalid blob KV batch size: ${batchSize}`)
    return Math.min(BLOB_KV_BATCH_SIZE, Math.max(1, Math.floor(batchSize)))
}

export function validateBlobTimeout(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
        throw new BlobResourceLimitError(`Invalid blob KV timeout: ${timeoutMs}`)
    return timeoutMs
}

/** All blob bytes, decoded values, requests and cancellation belong to one run. */
export class BlobRunContext {
    readonly blobs: RunBlobStore
    readonly abortController = new AbortController()
    readonly signal = this.abortController.signal
    readonly batchSize: number
    readonly timeoutMs: number
    readonly overallTimeoutMs: number
    readonly conversationId: string
    readonly kvGate = new RunKvGate()
    checkpointWriteScope?: CheckpointWriteScope
    checkpointDelivery?: CheckpointDelivery
    private readonly resourceLease?: ReturnType<RunResourceBudget['acquire']>

    private readonly clientBlobReads = new Map<string, RunClientBlobRead>()
    private readonly activeRequestIds = new Set<number>()
    // Zero is a valid protocol default, but reserved and never allocated here.
    // Positive ids avoid ambiguity with default-zero replies whose JSON omits id.
    private nextBlobRequestId = 900_000
    private nextInteractionId = 1
    private sentGetRequestCount = 0
    private disposed = false

    constructor(readonly session: AgentSession | null, options: BlobRunOptions = {}) {
        this.batchSize = normalizeBlobBatchSize(options.batchSize ?? BLOB_KV_BATCH_SIZE)
        this.timeoutMs = validateBlobTimeout(options.timeoutMs ?? BLOB_KV_TIMEOUT_MS)
        this.overallTimeoutMs = validateBlobTimeout(options.overallTimeoutMs ?? BLOB_KV_OVERALL_TIMEOUT_MS)
        this.conversationId = options.conversationId ?? ''
        this.resourceLease = options.resourceBudget?.acquire()
        try {
            this.blobs = new RunBlobStore({
                maxBytes: options.maxBytes,
                maxRecords: options.maxRecords,
                onRetainedBytes: this.resourceLease?.resize,
            })
            this.blobs.addInheritedReferences(options.inheritedBlobIds ?? [])
        }
        catch (error) {
            this.resourceLease?.release()
            throw error
        }
        // Concurrent operation listeners are scoped to this signal and cleaned up.
        setMaxListeners(0, this.signal)
        this.signal.addEventListener('abort', this.handleAbort, { once: true })
        session?.listeners.add(this.handleSessionChange)
        this.handleSessionChange()
    }

    allocateBlobId(): number {
        if (this.disposed || this.signal.aborted)
            throw new BlobInactiveError('Cannot allocate a blob KV id for an inactive run')
        const requestId = Math.max(900_000, this.session?.nextBlobRequestId ?? this.nextBlobRequestId)
        if (!Number.isSafeInteger(requestId) || requestId > 0xFFFF_FFFF)
            throw new BlobResourceLimitError(`Blob KV request id space exhausted or invalid: ${requestId}`)
        if (this.session) {
            this.session.nextBlobRequestId = requestId + 1
            this.session.activeBlobRequestIds ??= new Set()
            this.session.activeBlobRequestIds.add(requestId)
        }
        else
            this.nextBlobRequestId = requestId + 1
        this.activeRequestIds.add(requestId)
        return requestId
    }

    requireCheckpointWriteScope(): CheckpointWriteScope {
        if (!this.checkpointWriteScope)
            throw new Error('Checkpoint write scope must be captured at run admission')
        return this.checkpointWriteScope
    }

    allocateInteractionId(): number {
        if (this.disposed || this.signal.aborted)
            throw new BlobInactiveError('Cannot allocate an interaction for an inactive run')
        return this.nextInteractionId++
    }

    /** Drop only this request's unmatched/duplicate KV frames, never other consumers. */
    retireBlobRequest(requestId: number): void {
        if (!this.activeRequestIds.delete(requestId))
            return
        this.session?.activeBlobRequestIds?.delete(requestId)
        if (this.session) {
            discardSessionMessages(this.session, message => {
                const envelope = message.kvClientMessage as Record<string, unknown> | undefined
                return envelope?.id === requestId
            })
        }
    }

    getCompletedClientBlobResult(blobId: Uint8Array): ClientBlobResult | undefined {
        return this.clientBlobReads.get(Buffer.from(blobId).toString('hex'))?.result
    }

    /** Claim synchronously, before yielding frames, so concurrent readers deduplicate. */
    claimClientBlobRead(blobId: Uint8Array): { read: RunClientBlobRead, owned: boolean } {
        const wireKey = Buffer.from(blobId).toString('hex')
        const cached = this.clientBlobReads.get(wireKey)
        if (cached)
            return { read: cached, owned: false }
        const canonicalBlobId = blobIdFromBytes(blobId)
        if (!this.disposed)
            this.blobs.reserveBlobRecord(canonicalBlobId)

        let settled = false
        let result: ClientBlobResult | undefined
        let resolveResult!: (result: ClientBlobResult) => void
        let rejectResult!: (error: unknown) => void
        const promise = new Promise<ClientBlobResult>((resolve, reject) => {
            resolveResult = resolve
            rejectResult = reject
        })
        // A retention-limit failure may precede the consumer reaching this batch.
        void promise.catch(() => {})
        const read: RunClientBlobRead = {
            promise,
            get result() {
                return result
            },
            complete: (completedResult) => {
                if (settled)
                    return
                settled = true
                try {
                    if (completedResult.status === 'ok') {
                        this.blobs.retainClientResultBytes(completedResult.bytes.byteLength, wireKey)
                        this.blobs.markClientSaved(canonicalBlobId)
                    }
                    result = completedResult
                    resolveResult(completedResult)
                }
                catch (error) {
                    rejectResult(error)
                }
            },
        }
        if (!this.disposed)
            this.clientBlobReads.set(wireKey, read)
        if (this.signal.aborted)
            read.complete({ status: 'cancelled', message: 'Blob run has been cancelled or disposed' })
        return { read, owned: true }
    }

    getClientReadCount(): number {
        return this.clientBlobReads.size
    }

    getSentGetRequestCount(): number {
        return this.sentGetRequestCount
    }

    /** Call immediately before yielding a Get, never when merely reserving an id. */
    recordGetRequestSent(): void {
        if (this.disposed || this.signal.aborted)
            throw new BlobInactiveError('Cannot send a blob Get request for an inactive run')
        this.sentGetRequestCount++
    }

    dispose(): void {
        if (this.disposed)
            return
        this.disposed = true
        this.abortController.abort()
        this.session?.listeners.delete(this.handleSessionChange)
        this.signal.removeEventListener('abort', this.handleAbort)
        for (const requestId of this.activeRequestIds)
            this.retireBlobRequest(requestId)
        this.clientBlobReads.clear()
        this.sentGetRequestCount = 0
        this.blobs.dispose()
        this.resourceLease?.release()
    }

    private readonly handleSessionChange = (): void => {
        if (this.session && (this.session.closed || isSessionCancelled(this.session)))
            this.abortController.abort()
    }

    private readonly handleAbort = (): void => {
        this.session?.listeners.delete(this.handleSessionChange)
        for (const read of this.clientBlobReads.values())
            read.complete({ status: 'cancelled', message: 'Blob run has been cancelled or disposed' })
    }
}
