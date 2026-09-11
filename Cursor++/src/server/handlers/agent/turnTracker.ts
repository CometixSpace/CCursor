import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  type AgentServerMessage,
  AssistantMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  SimulatedMsgReason,
  ThinkingMessageSchema,
  type ToolCall,
  type UserMessage,
  UserMessageSchema,
} from '../../gen/agent_v1_pb'
import type { ParsedRunRequest } from './protocol/types'
import { resolveAgentMode } from './protocol/agentMode'
import type { BlobRunContext } from './runContext'
import { binaryBlobDataFromClientBytes, blobIdFromBytes, blobIdToBytes, encodeBinaryBlob } from './blob'
import type { RunBlobStore } from './blobStore'
import { fetchBlobsFromClient, type ClientBlobResult } from './clientBlobFetch'
import { BlobIntegrityError } from './blobErrors'
import { logger } from '../../logger'
import { AgentRunAbortedError } from './wait'

export interface EncodedBlob {
  blobId: string
  blobData: string
  blobDataRaw: Uint8Array
  dependencies?: string[]
}

export interface TurnBaseline {
  userMessageBlobId: string
  stepBlobIds: string[]
  requestId?: string
  dynamicToolCount?: number
}

export class ActiveTurnTracker {
  private readonly stepBlobIds: string[]

  constructor(
    readonly userMessageBlobId: string,
    stepBlobIds: string[] = [],
    readonly requestId?: string,
    private dynamicToolCount?: number,
  ) {
    this.stepBlobIds = [...stepBlobIds]
  }

  static fromTurnBlobId(turnBlobId: string, store: RunBlobStore): ActiveTurnTracker {
    const baseline = readTurnBaseline(turnBlobId, store)
    return new ActiveTurnTracker(
      baseline.userMessageBlobId,
      baseline.stepBlobIds,
      baseline.requestId,
      baseline.dynamicToolCount,
    )
  }

  setDynamicToolCount(count: number): void {
    this.dynamicToolCount = count
  }

  addThinking(text: string, durationMs = 0): EncodedBlob | null {
    if (!text)
      return null
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'thinkingMessage',
        value: create(ThinkingMessageSchema, {
          text,
          durationMs,
        }),
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  addAssistantText(text: string): EncodedBlob | null {
    if (!text)
      return null
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'assistantMessage',
        value: create(AssistantMessageSchema, {
          text,
        }),
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  addCompletedToolCall(toolCall: ToolCall): EncodedBlob {
    const blob = encodeBinaryBlob(toBinary(ConversationStepSchema, create(ConversationStepSchema, {
      message: {
        case: 'toolCall',
        value: toolCall,
      },
    })))
    this.stepBlobIds.push(blob.blobId)
    return blob
  }

  materializeTurnBlob(): EncodedBlob {
    // Preserve the exact KV key bytes, including opaque IDs rewritten by client forks.
    const blob = encodeBinaryBlob(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, {
      turn: {
        case: 'agentConversationTurn',
        value: {
          userMessage: blobIdToBytes(this.userMessageBlobId),
          steps: this.stepBlobIds.map(blobId => blobIdToBytes(blobId)),
          ...(this.requestId ? { requestId: this.requestId } : {}),
          ...(this.dynamicToolCount !== undefined ? { dynamicToolCount: this.dynamicToolCount } : {}),
        },
      },
    })))
    return { ...blob, dependencies: [this.userMessageBlobId, ...this.stepBlobIds] }
  }
}

export function createCurrentTurnUserMessageBlob(params: {
  parsed: ParsedRunRequest
  fallbackMessageId: string
}): { blob: EncodedBlob, messageId: string } {
  const raw = params.parsed.rawUserMessage
  const messageId = typeof raw?.messageId === 'string' && raw.messageId.length > 0
    ? raw.messageId
    : params.fallbackMessageId

  const init: Partial<UserMessage> & Record<string, unknown> = {
    text: params.parsed.userText,
    messageId,
    mode: resolveAgentMode(params.parsed.mode),
  }

  if (typeof raw?.richText === 'string' && raw.richText.length > 0)
    init.richText = raw.richText

  if (params.parsed.isBackgroundTaskCompletion) {
    init.isSimulatedMsg = true
    init.simulatedMsgReason = SimulatedMsgReason.BACKGROUND_TASK_COMPLETION
  }

  const blob = encodeBinaryBlob(toBinary(UserMessageSchema, create(UserMessageSchema, init as any)))
  return { blob, messageId }
}

/**
 * resume 前确保 turn blob 在内存里: 未命中 (进程重启) 就向客户端取。
 * turn blob 以 raw protobuf 发给客户端 (kvMessage 的 blobDataRaw 分支), 取回时按二进制归一。
 */
export async function* ensureTurnBlobCached(
  turnBlobId: string,
  run: BlobRunContext,
): AsyncGenerator<AgentServerMessage, void, void> {
  if (run.blobs.getCachedBlob(turnBlobId) !== undefined) {
    readTurnBaseline(turnBlobId, run.blobs)
    return
  }
  const [result] = yield* fetchBlobsFromClient({ run, blobIds: [blobIdToBytes(turnBlobId)] })
  if (!result || result.status !== 'ok') {
    throw new TurnBlobReadError(
      turnBlobId,
      result?.status ?? 'not-found',
      result?.message ?? 'The client did not return the required conversation turn.',
    )
  }
  const blobData = binaryBlobDataFromClientBytes(result.bytes)
  const baseline = decodeTurnBaseline(turnBlobId, blobData)
  const dependencies = [baseline.userMessageBlobId, ...baseline.stepBlobIds]
  run.blobs.cacheBlob(turnBlobId, blobData, result.bytes, dependencies)
  run.blobs.markClientSaved(turnBlobId)
  run.blobs.turnBaselines.set(turnBlobId, baseline)
}

/** A dynamic-tools hint is not prompt history or a request to resume this turn. */
export async function* probeTurnDynamicToolCount(
  turnBlobId: string,
  run: BlobRunContext,
): AsyncGenerator<AgentServerMessage, number | undefined, void> {
  let blobData = run.blobs.getCachedBlob(turnBlobId)
  if (blobData === undefined) {
    const [result] = yield* fetchBlobsFromClient({ run, blobIds: [blobIdToBytes(turnBlobId)] })
    if (run.signal.aborted)
      throw new AgentRunAbortedError('Turn metadata probe was cancelled')
    if (result?.status !== 'ok') {
      logger.warn({ turnBlobId, status: result?.status }, '[AGENT] optional previous-turn tool-profile hint unavailable')
      return undefined
    }
    blobData = binaryBlobDataFromClientBytes(result.bytes)
  }
  try {
    const turn = fromBinary(ConversationTurnStructureSchema, Buffer.from(blobData, 'base64')).turn
    if (turn.case === 'shellConversationTurn')
      return undefined
    if (turn.case !== 'agentConversationTurn')
      throw new Error('No supported turn metadata')
    return turn.value.dynamicToolCount
  }
  catch (error) {
    logger.warn({ turnBlobId, error: (error as Error).message }, '[AGENT] optional previous-turn tool-profile hint could not be decoded')
    return undefined
  }
}

type TurnBlobReadStatus = Exclude<ClientBlobResult['status'], 'ok'>

export class TurnBlobReadError extends BlobIntegrityError {
  constructor(
    readonly turnBlobId: string,
    readonly status: TurnBlobReadStatus,
    message: string,
  ) {
    super([{ blobId: turnBlobId, status, message }])
  }
}

function decodeTurnBaseline(turnBlobId: string, blobData: string): TurnBaseline {
  try {
    const turn = fromBinary(ConversationTurnStructureSchema, Buffer.from(blobData, 'base64'))
    if (turn.turn.case !== 'agentConversationTurn')
      throw new Error('The blob does not contain an agent conversation turn.')
    const value = turn.turn.value
    if (value.userMessage.byteLength === 0 || value.steps.some(step => step.byteLength === 0))
      throw new Error('The conversation turn contains an empty user or step reference.')
    const userMessageBlobId = blobIdFromBytes(value.userMessage)
    const stepBlobIds = value.steps.map(step => blobIdFromBytes(step))
    return {
      userMessageBlobId,
      stepBlobIds,
      requestId: value.requestId,
      dynamicToolCount: value.dynamicToolCount,
    }
  }
  catch (error) {
    throw new TurnBlobReadError(turnBlobId, 'decode-error', error instanceof Error ? error.message : String(error))
  }
}

export function readTurnBaseline(turnBlobId: string, store: RunBlobStore): TurnBaseline {
  const cachedBaseline = store.turnBaselines.get(turnBlobId)
  if (cachedBaseline)
    return cachedBaseline
  const blobData = store.getCachedBlob(turnBlobId)
  if (blobData === undefined)
    throw new TurnBlobReadError(turnBlobId, 'not-found', 'The required conversation turn was not retained for this run.')
  const baseline = decodeTurnBaseline(turnBlobId, blobData)
  store.turnBaselines.set(turnBlobId, baseline)
  return baseline
}
