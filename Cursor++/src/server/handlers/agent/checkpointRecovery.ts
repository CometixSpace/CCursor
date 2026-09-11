import type { JsonValue } from '@bufbuild/protobuf'
import type { CheckpointReferences, PersistedConversationCheckpoint } from '../../database/checkpoints'
import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import type { ParsedRunRequest } from './protocol'
import type { BlobRunContext } from './runContext'
import { randomUUID } from 'node:crypto'
import { fromBinary, fromJson } from '@bufbuild/protobuf'
import { adoptConversationCheckpoint, assertCheckpointWriteScopeCurrent, CheckpointConflictError, hasMatchingCheckpointReferences } from '../../database/checkpoints'
import { AskQuestionInteractionResponseSchema, ConversationTurnStructureSchema } from '../../gen/agent_v1_pb'
import { logger } from '../../logger'
import { blobIdFromBytes, blobIdToBytes } from './blob'
import { fetchBlobsFromClient, saveCheckpointBlobs } from './clientBlobFetch'
import { restoreRequiredBlobGraph } from './requiredBlobGraph'
import { discardSessionMessages } from './session'
import { interactionQuery, toolCallCompleted, toolCallStarted, turnEnded } from './stream'
import { AgentRunAbortedError, waitForMessageMatchingWithHeartbeat } from './wait'

function isReferencePrefix(prefix: string[], sequence: string[]): boolean {
  return prefix.length <= sequence.length && prefix.every((reference, index) => reference === sequence[index])
}

async function* verifyLegacyExtension(
  run: BlobRunContext,
  previous: CheckpointReferences,
  selected: CheckpointReferences,
): AsyncGenerator<AgentServerMessage, boolean, void> {
  if (!isReferencePrefix(previous.rootBlobIds, selected.rootBlobIds)
    || previous.summaryArchiveIds.length !== selected.summaryArchiveIds.length
    || !isReferencePrefix(previous.summaryArchiveIds, selected.summaryArchiveIds)
    || previous.turnBlobIds.length > selected.turnBlobIds.length) {
    return false
  }
  for (const [index, previousTurnId] of previous.turnBlobIds.entries()) {
    const selectedTurnId = selected.turnBlobIds[index]!
    if (previousTurnId === selectedTurnId)
      continue
    // Only the formerly active last turn may have been re-encoded with more steps.
    if (index !== previous.turnBlobIds.length - 1)
      return false
    // Only inspect the discarded candidate's turn structure. Its children must
    // not become required run dependencies if the user later chooses a different
    // complete branch. The selected graph has already been fully validated.
    const [previousBytes] = yield* fetchBlobsFromClient({ run, blobIds: [blobIdToBytes(previousTurnId)] })
    run.signal.throwIfAborted()
    if (previousBytes?.status !== 'ok') {
      logger.warn({ conversationId: run.conversationId }, '[CHECKPOINT] legacy ancestry unavailable; requesting explicit recovery')
      return false
    }
    let previousTurn
    try {
      previousTurn = fromBinary(ConversationTurnStructureSchema, previousBytes.bytes).turn
    }
    catch {
      return false
    }
    const selectedTurn = fromBinary(ConversationTurnStructureSchema, Buffer.from(run.blobs.getCachedBlob(selectedTurnId)!, 'base64')).turn
    if (previousTurn.case !== 'agentConversationTurn' || selectedTurn.case !== 'agentConversationTurn'
      || blobIdFromBytes(previousTurn.value.userMessage) !== blobIdFromBytes(selectedTurn.value.userMessage)
      || !isReferencePrefix(previousTurn.value.steps.map(blobIdFromBytes), selectedTurn.value.steps.map(blobIdFromBytes))) {
      return false
    }
  }
  return true
}

async function* confirmClientStateRecovery(parsed: ParsedRunRequest, run: BlobRunContext): AsyncGenerator<AgentServerMessage, void, void> {
  if (!run.session || parsed.isSubagent || parsed.isBackgroundTaskCompletion || parsed.isSummarize)
    throw new CheckpointConflictError(run.conversationId)
  const scope = run.requireCheckpointWriteScope()
  await assertCheckpointWriteScopeCurrent(scope, run.signal)
  const interactionId = run.allocateInteractionId()
  const toolCallId = `checkpoint-recovery-${randomUUID()}`
  const questionId = 'checkpoint-recovery'
  const hasSubmittedHistory = parsed.historyBlobIds.length + parsed.historyTurnBlobIds.length + parsed.historySummaryArchiveIds.length > 0
  const submittedStateDescription = hasSubmittedHistory
    ? `Submitted state: ${parsed.historyBlobIds.length} prompt references, ${parsed.historyTurnBlobIds.length} turns, ${parsed.historySummaryArchiveIds.length} archives.`
    : 'Cursor submitted no prior history. Continuing starts with empty context, even if older messages are still visible in the chat.'
  const args = {
    title: 'Recover this conversation',
    questions: [{
      id: questionId,
      prompt: `Conversation ${run.conversationId} has a different saved checkpoint. ${submittedStateDescription} Continue from this submitted state? Existing saved checkpoints will be preserved as recovery metadata. This does not undo tools already executed; continuing an older state can repeat work.`,
      options: [
        { id: 'continue-current', label: hasSubmittedHistory ? 'Keep this chat\'s submitted history and continue here' : 'Continue with empty context; retain saved checkpoints for recovery' },
        { id: 'cancel', label: 'Cancel without changing saved history' },
      ],
      allowMultiple: false,
    }],
  }
  // No other interaction is live during admission. Unsolicited responses must
  // neither authorize this question nor linger to answer a later model question.
  discardSessionMessages(run.session, message => 'interactionResponse' in message)
  yield toolCallStarted(toolCallId, 'askQuestionToolCall', args, toolCallId)
  yield interactionQuery(interactionId, 'askQuestionInteractionQuery', { args, toolCallId })
  const response = yield* waitForMessageMatchingWithHeartbeat(run.session, (message) => {
    const interaction = message.interactionResponse as Record<string, unknown> | undefined
    return interaction?.id === interactionId && !!interaction.askQuestionInteractionResponse
  }, 5 * 60_000, undefined, run.signal)
  discardSessionMessages(run.session, message => 'interactionResponse' in message)
  run.signal.throwIfAborted()
  if (!response)
    throw new CheckpointConflictError(run.conversationId)
  const interaction = response.interactionResponse as Record<string, unknown>
  const result = fromJson(AskQuestionInteractionResponseSchema, interaction.askQuestionInteractionResponse as JsonValue).result
  yield toolCallCompleted(toolCallId, 'askQuestionToolCall', args, result ?? {}, toolCallId)
  const answers = result?.result.case === 'success' ? result.result.value.answers : []
  const selected = answers.length === 1 && answers[0]!.questionId === questionId
    && answers[0]!.selectedOptionIds.length === 1 && answers[0]!.selectedOptionIds[0] === 'continue-current'
  if (!selected) {
    // The user declined inside a still-live stream. Bare EOF would look like a
    // transport failure to Cursor and could ask the same recovery question again.
    yield turnEnded(0, 0)
    throw new AgentRunAbortedError('Checkpoint recovery was not approved; saved history is unchanged')
  }
  // The consent is for this exact snapshot, never whatever is current after waiting.
  await assertCheckpointWriteScopeCurrent(scope, run.signal)
}

/** Native client history remains the input; compatibility never substitutes SQL history. */
export async function* admitClientCheckpoint(
  parsed: ParsedRunRequest,
  run: BlobRunContext,
): AsyncGenerator<AgentServerMessage, PersistedConversationCheckpoint | null, void> {
  const scope = run.requireCheckpointWriteScope()
  if (scope.isDeleted)
    throw new CheckpointConflictError(run.conversationId)
  const incoming: CheckpointReferences = {
    rootBlobIds: parsed.historyBlobIds,
    turnBlobIds: parsed.historyTurnBlobIds,
    summaryArchiveIds: parsed.historySummaryArchiveIds,
  }
  const latest = scope.draftCheckpoint ?? scope.committedCheckpoint
  if (!scope.hasAmbiguousLegacyPair && (!latest || hasMatchingCheckpointReferences(latest, incoming)))
    return latest

  // Recovery is rare: validate its complete selected graph before any adoption.
  // Ordinary matching continuations retain the existing lazy history behavior.
  yield* restoreRequiredBlobGraph(run, [
    ...incoming.rootBlobIds.map(blobId => ({ blobId, kind: 'history' as const })),
    ...incoming.turnBlobIds.map(blobId => ({ blobId, kind: 'turn' as const })),
    ...incoming.summaryArchiveIds.map(blobId => ({ blobId, kind: 'archive' as const })),
  ])
  const matching = [scope.committedCheckpoint, scope.draftCheckpoint]
    .find(candidate => candidate !== null && hasMatchingCheckpointReferences(candidate, incoming))
  const previous = matching === scope.committedCheckpoint ? scope.draftCheckpoint : scope.committedCheckpoint
  const compatible = scope.hasAmbiguousLegacyPair && !!matching && !!previous
    && (yield* verifyLegacyExtension(run, previous, incoming))
  if (!compatible)
    yield* confirmClientStateRecovery(parsed, run)

  // Uploaded-only history may not yet exist in client KV. Adoption has the same
  // successful-Set barrier as every other accepted checkpoint.
  yield* saveCheckpointBlobs(run, [...incoming.rootBlobIds, ...incoming.turnBlobIds, ...incoming.summaryArchiveIds])
  const selected: PersistedConversationCheckpoint = {
    conversationId: run.conversationId,
    kind: 'committed',
    ...incoming,
    tokenDetails: parsed.historyTokenDetails ?? matching?.tokenDetails ?? { usedTokens: 0, maxTokens: parsed.contextTokenLimit ?? 200_000 },
    mode: parsed.mode,
    updatedAt: Date.now(),
  }
  await adoptConversationCheckpoint(selected, scope, compatible ? 'legacy-compatible' : 'user-selected', run.signal)
  logger.info({ conversationId: run.conversationId, automatic: compatible }, '[CHECKPOINT] adopted client history in place; original checkpoint candidates preserved')
  return selected
}
