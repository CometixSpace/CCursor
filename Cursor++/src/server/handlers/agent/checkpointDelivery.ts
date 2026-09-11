import type { JsonValue } from '@bufbuild/protobuf'
import type { CheckpointReferences } from '../../database/checkpoints'
import type { AgentServerMessage, ConversationStateStructure } from '../../gen/agent_v1_pb'
import type { BlobRunContext } from './runContext'
import { createHash } from 'node:crypto'
import { fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf'
import { assertCheckpointWriteScopeCurrent, CheckpointConflictError, hasMatchingCheckpointReferences } from '../../database/checkpoints'
import { AgentServerMessageSchema, ConversationStateStructureSchema } from '../../gen/agent_v1_pb'
import { logger } from '../../logger'
import { blobIdFromBytes } from './blob'
import { saveCheckpointBlobs } from './clientBlobFetch'
import { restoreRequiredBlobGraph } from './requiredBlobGraph'

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const MAX_RESUME_SOURCES = 256

interface TerminalReceipt {
  version: 1
  runId: string
  requestFingerprint: string
  modelFingerprint: string
  inputFingerprint: string
  resumeSources: string[]
  frames: string[]
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return value
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function stateFingerprint(state: ConversationStateStructure): string {
  return fingerprint(toJson(ConversationStateStructureSchema, state))
}

export function checkpointReferences(state: ConversationStateStructure): CheckpointReferences {
  return {
    rootBlobIds: state.rootPromptMessagesJson.map(blobIdFromBytes),
    turnBlobIds: state.turns.map(blobIdFromBytes),
    summaryArchiveIds: state.summaryArchives.map(blobIdFromBytes),
  }
}

function encodeFrame(frame: AgentServerMessage): string {
  return Buffer.from(toBinary(AgentServerMessageSchema, frame)).toString('base64')
}

/** A bounded terminal receipt, not a stream log or an exactly-once execution ledger. */
export class CheckpointDelivery {
  private readonly runId: string
  private readonly requestFingerprint: string
  private readonly modelFingerprint: string
  private readonly inputFingerprint: string
  private readonly isPlainResume: boolean
  private readonly resumeSources = new Set<string>()
  private lastStepCompleted?: string
  private lastTurnEnded?: string
  private exceededSourceLimit = false

  constructor(request: Record<string, unknown>) {
    this.runId = typeof request.runId === 'string' ? request.runId : ''
    const { runId: _runId, conversationState, ...actionRequest } = request
    this.requestFingerprint = fingerprint(actionRequest)
    this.modelFingerprint = fingerprint({
      requestedModel: request.requestedModel,
      modelDetails: request.modelDetails,
      conversationId: request.conversationId,
      conversationGroupId: request.conversationGroupId,
      subagentTypeName: request.subagentTypeName,
    })
    this.inputFingerprint = stateFingerprint(fromJson(ConversationStateStructureSchema, (conversationState ?? {}) as JsonValue))
    this.resumeSources.add(this.inputFingerprint)
    const action = request.action as Record<string, unknown> | undefined
    const resume = action?.resumeAction as Record<string, unknown> | undefined
    this.isPlainResume = !!resume
      && Object.keys(action!).every(key => key === 'resumeAction' || key === 'requestContextParts')
      && Object.keys(resume).every(key => key === 'requestContext')
      && !request.prependUserMessages
  }

  observe(frame: AgentServerMessage): void {
    if (frame.message.case === 'conversationCheckpointUpdate') {
      if (this.resumeSources.size >= MAX_RESUME_SOURCES) {
        this.exceededSourceLimit = true
        return
      }
      this.resumeSources.add(stateFingerprint(frame.message.value))
    }
    if (frame.message.case !== 'interactionUpdate')
      return
    const update = frame.message.value.message
    if (update.case === 'stepCompleted') {
      this.lastStepCompleted = encodeFrame(frame)
      this.lastTurnEnded = undefined
    }
    if (update.case === 'turnEnded')
      this.lastTurnEnded = encodeFrame(frame)
  }

  createTerminalReceipt(frame: AgentServerMessage): string | undefined {
    if (!this.runId || !this.lastStepCompleted || !this.lastTurnEnded || this.exceededSourceLimit
      || frame.message.case !== 'conversationCheckpointUpdate') {
      return undefined
    }
    const receipt: TerminalReceipt = {
      version: 1,
      runId: this.runId,
      requestFingerprint: this.requestFingerprint,
      modelFingerprint: this.modelFingerprint,
      inputFingerprint: this.inputFingerprint,
      resumeSources: [...new Set([...this.resumeSources, stateFingerprint(frame.message.value)])],
      frames: [this.lastStepCompleted, this.lastTurnEnded, encodeFrame(frame)],
    }
    const serialized = JSON.stringify(receipt)
    if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) {
      logger.warn({ runId: this.runId }, '[CHECKPOINT] terminal receipt exceeds replay budget; explicit recovery remains available')
      return undefined
    }
    return serialized
  }

  private matchReceipt(serialized: string): AgentServerMessage[] | undefined {
    if (!serialized || !this.runId || Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES)
      return undefined
    try {
      const receipt = JSON.parse(serialized) as TerminalReceipt
      if (receipt.version !== 1 || receipt.runId !== this.runId || receipt.modelFingerprint !== this.modelFingerprint
        || !Array.isArray(receipt.resumeSources) || receipt.resumeSources.length > MAX_RESUME_SOURCES + 1
        || !receipt.resumeSources.every(source => typeof source === 'string')
        || !Array.isArray(receipt.frames) || receipt.frames.length !== 3
        || !receipt.frames.every(frame => typeof frame === 'string')) {
        return undefined
      }
      const exactRetry = receipt.requestFingerprint === this.requestFingerprint && receipt.inputFingerprint === this.inputFingerprint
      const nativeResume = this.isPlainResume && receipt.resumeSources.includes(this.inputFingerprint)
      if (!exactRetry && !nativeResume)
        return undefined
      const frames = receipt.frames.map(frame => fromBinary(AgentServerMessageSchema, Buffer.from(frame, 'base64')))
      if (frames[0]!.message.case !== 'interactionUpdate' || frames[0]!.message.value.message.case !== 'stepCompleted'
        || frames[1]!.message.case !== 'interactionUpdate' || frames[1]!.message.value.message.case !== 'turnEnded'
        || frames[2]!.message.case !== 'conversationCheckpointUpdate') {
        return undefined
      }
      return frames
    }
    catch {
      // A malformed receipt is not permission to replace client history.
      return undefined
    }
  }

  async* replayTerminalCheckpoint(run: BlobRunContext): AsyncGenerator<AgentServerMessage, boolean, void> {
    const scope = run.requireCheckpointWriteScope()
    const frames = this.matchReceipt(scope.terminalReceiptJson)
    if (!frames)
      return false
    const finalFrame = frames[2]!
    if (finalFrame.message.case !== 'conversationCheckpointUpdate')
      return false
    const references = checkpointReferences(finalFrame.message.value)
    if (!hasMatchingCheckpointReferences(scope.committedCheckpoint, references))
      throw new CheckpointConflictError(run.conversationId)

    // Previous Set replies do not prove current availability. Redelivery restores
    // the entire published graph without generating content or rerunning tools.
    yield* restoreRequiredBlobGraph(run, [
      ...references.rootBlobIds.map(blobId => ({ blobId, kind: 'history' as const })),
      ...references.turnBlobIds.map(blobId => ({ blobId, kind: 'turn' as const })),
      ...references.summaryArchiveIds.map(blobId => ({ blobId, kind: 'archive' as const })),
    ])
    yield* saveCheckpointBlobs(run, [...references.rootBlobIds, ...references.turnBlobIds, ...references.summaryArchiveIds])
    await assertCheckpointWriteScopeCurrent(scope, run.signal)
    for (const frame of frames) {
      run.signal.throwIfAborted()
      yield frame
    }
    logger.info({ conversationId: run.conversationId, runId: this.runId }, '[CHECKPOINT] redelivered correlated terminal checkpoint without generation')
    return true
  }
}
