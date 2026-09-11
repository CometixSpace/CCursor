import type { JsonObject } from '@bufbuild/protobuf'
import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { BlobFailure } from './blobErrors'
import type { BlobRunContext, RunClientBlobRead } from './runContext'
import { setMaxListeners } from 'node:events'
import { fromJson } from '@bufbuild/protobuf'
import { GetBlobResultSchema, SetBlobResultSchema } from '../../gen/agent_v1_pb'
import { BLOB_KV_BATCH_SIZE, normalizeBlobBatchSize, validateBlobTimeout } from './runContext'
import { waitForMessageMatching } from './session'
import { kvGetBlob, kvMessage } from './stream'
import { AgentRunAbortedError, waitForPromiseWithHeartbeat } from './wait'

export const CLIENT_BLOB_FETCH_BATCH_SIZE = BLOB_KV_BATCH_SIZE

export type ClientBlobResult =
  | { status: 'ok', bytes: Uint8Array }
  | { status: 'not-found' | 'client-error' | 'timeout' | 'cancelled' | 'decode-error' | 'no-session' | 'overall-timeout', message?: string }

export interface BlobTransferFailure extends BlobFailure {
  /** Allocated KV id; absent if preparation never reached request allocation. */
  requestId?: number
  message: string
}

/** A checkpoint cannot be published unless every required Set completed. */
export class BlobTransferError extends Error {
  readonly retryable: boolean

  constructor(readonly failures: BlobTransferFailure[]) {
    super(`Checkpoint blob transfer failed: ${failures.map(failure => `${failure.blobId}${failure.requestId === undefined ? '' : ` Set request ${failure.requestId}`} (${failure.status}): ${failure.message ?? 'no successful client acknowledgement'}`).join('; ')}`)
    this.name = 'BlobTransferError'
    this.retryable = failures.length > 0 && failures.every(failure => ['timeout', 'overall-timeout', 'client-error', 'cancelled', 'no-session'].includes(failure.status))
  }
}

type ClientBlobFailure = Exclude<ClientBlobResult, { status: 'ok' }>
type KvResultKind = 'getBlobResult' | 'setBlobResult'
type KvReply = { status: 'received', message: Record<string, unknown> } | ClientBlobFailure
type SetBlobOutcome = { status: 'ok' } | ClientBlobFailure

export interface ClientBlobFetchParams {
  run: BlobRunContext
  blobIds: Uint8Array[]
  batchSize?: number
  timeoutMs?: number
  overallTimeoutMs?: number
  /** Per-invocation count; unlike run totals it excludes concurrent callers. */
  onRequestSent?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string' && error.message)
    return error.message
  return error instanceof Error ? error.message : JSON.stringify(error) ?? String(error)
}

/**
 * Match only the envelope. Never decode bytes while scanning unrelated replies.
 * Protocol id=0 is valid (and omitted by toJson), but reserved by this allocator:
 * default-zero replies must never satisfy one of our positive-id requests.
 */
function matchesKvReply(message: Record<string, unknown>, kind: KvResultKind, requestId: number): boolean {
  const envelope = message.kvClientMessage
  return isRecord(envelope)
    && typeof envelope.id === 'number'
    && Number.isInteger(envelope.id)
    && envelope.id > 0
    && envelope.id === requestId
    && Object.hasOwn(envelope, kind)
}

function decodeGetBlobReply(message: Record<string, unknown>): ClientBlobResult {
  try {
    const envelope = message.kvClientMessage as Record<string, unknown>
    if (!isRecord(envelope.getBlobResult))
      throw new Error('getBlobResult must be an object')
    const { blobData, ...metadata } = envelope.getBlobResult
    const hasRawBytes = blobData instanceof Uint8Array
    const json = hasRawBytes || blobData === undefined ? metadata : { ...metadata, blobData }
    const decoded = fromJson(GetBlobResultSchema, json as JsonObject)
    if (decoded.error)
      return { status: 'client-error', message: describeError(decoded.error) }
    if (hasRawBytes)
      return { status: 'ok', bytes: new Uint8Array(blobData) }
    // Optional bytes distinguish an absent value from a valid empty blob.
    return decoded.blobData === undefined
      ? { status: 'not-found' }
      : { status: 'ok', bytes: decoded.blobData }
  }
  catch (error) {
    return { status: 'decode-error', message: describeError(error) }
  }
}

function decodeSetBlobReply(message: Record<string, unknown>): SetBlobOutcome {
  try {
    const envelope = message.kvClientMessage as Record<string, unknown>
    if (!isRecord(envelope.setBlobResult))
      throw new Error('setBlobResult must be an object')
    // In this schema, SetBlobResult has optional error, not a success oneof.
    // An explicit empty result acknowledges the client's local set method only.
    const decoded = fromJson(SetBlobResultSchema, envelope.setBlobResult as JsonObject)
    return decoded.error ? { status: 'client-error', message: describeError(decoded.error) } : { status: 'ok' }
  }
  catch (error) {
    return { status: 'decode-error', message: describeError(error) }
  }
}

/** A budget covers all batches, including time paused at a yielded send. */
class BlobKvOperation {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly deadline: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private failureResult: ClientBlobFailure = { status: 'cancelled', message: 'Blob KV operation was cancelled' }

  constructor(private readonly run: BlobRunContext, private readonly overallTimeoutMs: number) {
    this.deadline = Date.now() + overallTimeoutMs
    // These listeners belong to bounded request batches and are always removed.
    setMaxListeners(0, this.signal)
    run.signal.addEventListener('abort', this.cancelFromRun, { once: true })
    if (run.signal.aborted)
      this.cancelFromRun()
    else
      this.timer = setTimeout(() => this.expire(), overallTimeoutMs)
  }

  get cancelled(): boolean {
    if (this.run.session?.closed || this.run.session?.cancelledReason !== undefined)
      this.run.abortController.abort()
    if (!this.signal.aborted && Date.now() >= this.deadline)
      this.expire()
    return this.signal.aborted
  }

  get failure(): ClientBlobFailure {
    return this.failureResult
  }

  dispose(): void {
    this.run.signal.removeEventListener('abort', this.cancelFromRun)
    this.abort({ status: 'cancelled', message: 'Blob KV operation finished or was abandoned' })
  }

  private readonly cancelFromRun = (): void => {
    this.abort({ status: 'cancelled', message: 'Blob run was cancelled, disposed, or disconnected' })
  }

  private expire(): void {
    this.abort({ status: 'overall-timeout', message: `Blob KV operation exceeded ${this.overallTimeoutMs}ms overall budget` })
  }

  private abort(failure: ClientBlobFailure): void {
    if (this.timer !== undefined)
      clearTimeout(this.timer)
    if (this.signal.aborted)
      return
    this.failureResult = failure
    this.controller.abort()
  }
}

/** Register now, but start the individual deadline immediately before its send. */
function prepareKvRequest(run: BlobRunContext, operation: BlobKvOperation, kind: KvResultKind, requestId: number, timeoutMs: number): {
  reply: Promise<KvReply>
  start: () => void
} {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let failure: ClientBlobFailure | undefined
  const abortFromOperation = (): void => {
    failure = operation.failure
    if (timer !== undefined)
      clearTimeout(timer)
    controller.abort()
  }
  operation.signal.addEventListener('abort', abortFromOperation, { once: true })
  if (operation.cancelled)
    abortFromOperation()

  const reply = waitForMessageMatching(run.session!, message => matchesKvReply(message, kind, requestId), null, controller.signal)
    .then((message): KvReply => {
      settled = true
      if (timer !== undefined)
        clearTimeout(timer)
      operation.signal.removeEventListener('abort', abortFromOperation)
      run.retireBlobRequest(requestId)
      return message
        ? { status: 'received', message }
        : failure ?? { status: 'cancelled', message: `Blob KV ${kind} request ${requestId} lost its session` }
    })

  return {
    reply,
    start: () => {
      if (settled || controller.signal.aborted)
        return
      timer = setTimeout(() => {
        failure = { status: 'timeout', message: `Blob KV ${kind} request ${requestId} exceeded ${timeoutMs}ms after send` }
        controller.abort()
      }, timeoutMs)
    },
  }
}

/** A duplicate reader's deadline must not cancel another operation's owned Get. */
function waitForReadWithinOperation(read: RunClientBlobRead, operation: BlobKvOperation): Promise<ClientBlobResult> {
  if (read.result)
    return Promise.resolve(read.result)
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      operation.signal.removeEventListener('abort', abort)
      resolve(read.result ?? operation.failure)
    }
    operation.signal.addEventListener('abort', abort, { once: true })
    read.promise.then(
      (result) => {
        operation.signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error) => {
        operation.signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (operation.cancelled)
      abort()
  })
}

/** Results retain input order. Each wire key is requested at most once per run. */
export async function* fetchBlobsFromClient(params: ClientBlobFetchParams): AsyncGenerator<AgentServerMessage, ClientBlobResult[], void> {
  if (params.blobIds.length === 0)
    return []
  const { run } = params
  const batchSize = normalizeBlobBatchSize(params.batchSize ?? run.batchSize)
  const timeoutMs = validateBlobTimeout(params.timeoutMs ?? run.timeoutMs)
  const overallTimeoutMs = validateBlobTimeout(params.overallTimeoutMs ?? run.overallTimeoutMs)
  const reads: Array<{ blobId: Uint8Array, read: RunClientBlobRead }> = []
  const ownedReads: typeof reads = []
  let operation: BlobKvOperation | undefined
  const cancelOwnedReads = (): void => {
    for (const request of ownedReads)
      request.read.complete(operation?.failure ?? { status: 'cancelled', message: 'Blob Get preparation was abandoned' })
  }
  try {
    // Preparation can itself exceed the record cap. Its partial reservations
    // belong to this operation and must not leave unresolved shared reads.
    for (const blobId of params.blobIds) {
      const wireBlobId = new Uint8Array(blobId)
      const claimed = run.claimClientBlobRead(wireBlobId)
      const request = { blobId: wireBlobId, read: claimed.read }
      reads.push(request)
      if (claimed.owned)
        ownedReads.push(request)
    }
    if (!run.session) {
      for (const request of ownedReads)
        request.read.complete({ status: 'no-session', message: 'Cannot fetch a client blob without a session' })
      return await Promise.all(reads.map(request => request.read.promise))
    }

    operation = new BlobKvOperation(run, overallTimeoutMs)
    operation.signal.addEventListener('abort', cancelOwnedReads, { once: true })
    for (let offset = 0; offset < ownedReads.length; offset += batchSize) {
      if (operation.cancelled) {
        cancelOwnedReads()
        break
      }
      const releaseBatch = yield* waitForPromiseWithHeartbeat(run.kvGate.acquire(operation.signal))
      if (!releaseBatch) {
        cancelOwnedReads()
        break
      }
      try {
        const batch = ownedReads.slice(offset, offset + batchSize)
        const requests = batch.map((request) => {
          const requestId = run.allocateBlobId()
          const pending = prepareKvRequest(run, operation!, 'getBlobResult', requestId, timeoutMs)
          void pending.reply.then(reply => request.read.complete(reply.status === 'received' ? decodeGetBlobReply(reply.message) : reply))
          return { ...pending, frame: kvGetBlob(requestId, request.blobId) }
        })
        // Every waiter is registered before the first frame of this batch is sent.
        for (const request of requests) {
          if (operation.cancelled)
            break
          request.start()
          run.recordGetRequestSent()
          params.onRequestSent?.()
          yield request.frame
        }
        yield* waitForPromiseWithHeartbeat(Promise.all(batch.map(request => request.read.promise)))
      }
      finally {
        releaseBatch()
      }
    }
    return yield* waitForPromiseWithHeartbeat(Promise.all(reads.map(request => waitForReadWithinOperation(request.read, operation!))))
  }
  finally {
    operation?.dispose()
    operation?.signal.removeEventListener('abort', cancelOwnedReads)
    cancelOwnedReads()
  }
}

function throwIfRunCancelled(run: BlobRunContext): void {
  if (run.signal.aborted || run.session?.closed || run.session?.cancelledReason !== undefined)
    throw new AgentRunAbortedError('Cannot save checkpoint blobs: blob run was cancelled, disposed, or disconnected')
}

function buildPendingTransferError(run: BlobRunContext, failure: ClientBlobFailure): BlobTransferError {
  const pendingBlobIds = run.blobs.getPendingBlobs().map(blob => blob.blobId)
  return new BlobTransferError((pendingBlobIds.length > 0 ? pendingBlobIds : ['(checkpoint-barrier)']).map(blobId => ({
    blobId,
    status: failure.status,
    message: failure.message ?? 'Checkpoint blob transfer could not complete',
  })))
}

/** Confirm all pending data before the caller persists or emits a checkpoint. */
export async function* saveCheckpointBlobs(run: BlobRunContext, referencedBlobIds: string[]): AsyncGenerator<AgentServerMessage, void, void> {
  throwIfRunCancelled(run)
  run.blobs.assertCheckpointReferences(referencedBlobIds)
  if (run.blobs.getPendingBlobs().length === 0)
    return
  if (!run.session) {
    throw buildPendingTransferError(run, {
      status: 'no-session',
      message: `Cannot save checkpoint blobs without a session (${run.blobs.getPendingBlobs().length} pending blobs)`,
    })
  }

  const operation = new BlobKvOperation(run, run.overallTimeoutMs)
  try {
    while (run.blobs.getPendingBlobs().length > 0) {
      throwIfRunCancelled(run)
      if (operation.cancelled)
        throw buildPendingTransferError(run, operation.failure)
      const releaseBatch = yield* waitForPromiseWithHeartbeat(run.kvGate.acquire(operation.signal))
      if (!releaseBatch)
        throw buildPendingTransferError(run, operation.failure)
      try {
        run.blobs.assertCheckpointReferences(referencedBlobIds)
        const batch = run.blobs.getPendingBlobs().slice(0, run.batchSize)
        const requests = batch.map((blob) => {
          const requestId = run.allocateBlobId()
          const pending = prepareKvRequest(run, operation, 'setBlobResult', requestId, run.timeoutMs)
          const result = pending.reply.then((reply) => {
            const outcome = reply.status === 'received' ? decodeSetBlobReply(reply.message) : reply
            if (outcome.status === 'ok' && !run.signal.aborted)
              run.blobs.markClientSaved(blob.blobId)
            return { requestId, blobId: blob.blobId, outcome }
          })
          // A consumer may be paused on an earlier frame when an ACK is processed.
          void result.catch(() => {})
          return { ...pending, result, requestId, blob }
        })
        for (const request of requests) {
          if (operation.cancelled)
            break
          request.start()
          yield kvMessage(request.requestId, request.blob.blobId, request.blob.blobData, request.blob.blobDataRaw)
        }
        const results = yield* waitForPromiseWithHeartbeat(Promise.all(requests.map(request => request.result)))
        throwIfRunCancelled(run)
        const failures: BlobTransferFailure[] = []
        for (const result of results) {
          if (result.outcome.status !== 'ok') {
            failures.push({
              blobId: result.blobId,
              requestId: result.requestId,
              status: result.outcome.status,
              message: result.outcome.message ?? 'No successful client acknowledgement',
            })
          }
        }
        if (failures.length > 0) {
          if (operation.cancelled) {
            const batchBlobIds = new Set(batch.map(blob => blob.blobId))
            for (const blob of run.blobs.getPendingBlobs()) {
              if (!batchBlobIds.has(blob.blobId))
                failures.push({ blobId: blob.blobId, status: operation.failure.status, message: operation.failure.message ?? 'Checkpoint blob transfer could not complete' })
            }
          }
          throw new BlobTransferError(failures)
        }
        if (operation.cancelled)
          throw buildPendingTransferError(run, operation.failure)
      }
      finally {
        releaseBatch()
      }
    }
    throwIfRunCancelled(run)
    run.blobs.assertCheckpointReferences(referencedBlobIds)
  }
  finally {
    operation.dispose()
  }
}
