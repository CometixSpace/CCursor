import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { fromBinary } from '@bufbuild/protobuf'
import {
  ConversationStepSchema,
  ConversationSummaryArchiveSchema,
  ConversationTurnStructureSchema,
  ShellCommandSchema,
  ShellOutputSchema,
  UserMessageSchema,
} from '../../gen/agent_v1_pb'
import { binaryBlobDataFromClientBytes, blobIdFromBytes, blobIdToBytes, jsonBlobDataFromClientBytes } from './blob'
import { BlobIntegrityError } from './blobErrors'
import { fetchBlobsFromClient } from './clientBlobFetch'
import { decodeHistoryEntry, type HistoryEntry } from './historyManager'
import type { BlobRunContext } from './runContext'
import { uploadHandoff } from './uploadHandoff'

export interface RequiredBlobReference {
  blobId: string
  kind: 'history' | 'turn' | 'archive' | 'user' | 'step' | 'shell-command' | 'shell-output'
  bytes?: Uint8Array
}

function decodeRequiredReference(reference: RequiredBlobReference, bytes: Uint8Array): {
  blobData: string
  dependencies: RequiredBlobReference[]
  historyEntry?: HistoryEntry
} {
  const dependencies: RequiredBlobReference[] = []
  let blobData = reference.kind === 'history' ? '' : binaryBlobDataFromClientBytes(bytes)
  let historyEntry: HistoryEntry | undefined
  switch (reference.kind) {
    case 'history': {
      const normalized = jsonBlobDataFromClientBytes(bytes)
      if (normalized === null)
        throw new Error('Invalid required history encoding')
      historyEntry = decodeHistoryEntry(reference.blobId, normalized)
      blobData = normalized
      break
    }
    case 'turn': {
      const turn = fromBinary(ConversationTurnStructureSchema, bytes).turn
      if (turn.case === 'agentConversationTurn') {
        dependencies.push({ blobId: blobIdFromBytes(turn.value.userMessage), kind: 'user' })
        dependencies.push(...turn.value.steps.map(step => ({ blobId: blobIdFromBytes(step), kind: 'step' as const })))
      }
      else if (turn.case === 'shellConversationTurn') {
        dependencies.push({ blobId: blobIdFromBytes(turn.value.shellCommand), kind: 'shell-command' })
        dependencies.push({ blobId: blobIdFromBytes(turn.value.shellOutput), kind: 'shell-output' })
      }
      else {
        throw new Error('Required turn has no supported structure')
      }
      break
    }
    case 'archive': {
      const archive = fromBinary(ConversationSummaryArchiveSchema, bytes)
      dependencies.push(...archive.summarizedMessages.map(message => ({ blobId: blobIdFromBytes(message), kind: 'history' as const })))
      dependencies.push({ blobId: blobIdFromBytes(archive.summaryMessage), kind: 'history' })
      break
    }
    case 'user':
      fromBinary(UserMessageSchema, bytes)
      break
    case 'step':
      if (!fromBinary(ConversationStepSchema, bytes).message.case)
        throw new Error('Required conversation step has no supported message')
      break
    case 'shell-command':
      fromBinary(ShellCommandSchema, bytes)
      break
    case 'shell-output':
      fromBinary(ShellOutputSchema, bytes)
      break
  }
  if (dependencies.some(dependency => !dependency.blobId))
    throw new Error('Required structure contains an empty reference')
  return { blobData, dependencies, historyEntry }
}

/** Traverse only explicitly required roots, not the entire inherited checkpoint. */
export async function* restoreRequiredBlobGraph(
  run: BlobRunContext,
  references: RequiredBlobReference[],
): AsyncGenerator<AgentServerMessage, void, void> {
  const visited = new Set<string>()
  const retainReference = (reference: RequiredBlobReference, bytes: Uint8Array): RequiredBlobReference[] => {
    let decoded: ReturnType<typeof decodeRequiredReference>
    try {
      decoded = decodeRequiredReference(reference, bytes)
    }
    catch (error) {
      throw new BlobIntegrityError([{ blobId: reference.blobId, status: 'decode-error', message: (error as Error).message }])
    }
    run.blobs.cacheBlob(reference.blobId, decoded.blobData, bytes, decoded.dependencies.map(dependency => dependency.blobId))
    if (decoded.historyEntry)
      run.blobs.historyEntries.set(reference.blobId, decoded.historyEntry)
    return decoded.dependencies
  }
  let remaining = references
  while (remaining.length > 0) {
    const batch = remaining.filter((reference) => {
      const identity = `${reference.kind}:${reference.blobId}`
      if (visited.has(identity))
        return false
      visited.add(identity)
      run.blobs.reserveBlobRecord(reference.blobId)
      return true
    })
    const nextReferences: RequiredBlobReference[] = []
    const missing: RequiredBlobReference[] = []
    for (const reference of batch) {
      const retained = run.blobs.getBlob(reference.blobId)
      const bytes = reference.bytes ?? retained?.blobDataRaw
        ?? (retained ? Buffer.from(retained.blobData, reference.kind === 'history' ? 'utf8' : 'base64') : undefined)
        ?? uploadHandoff.read(run.conversationId, blobIdToBytes(reference.blobId))
      if (bytes === undefined)
        missing.push(reference)
      else
        nextReferences.push(...retainReference(reference, bytes))
    }
    const fetched = yield* fetchBlobsFromClient({ run, blobIds: missing.map(reference => blobIdToBytes(reference.blobId)) })
    const failures = fetched.flatMap((result, index) => result.status === 'ok'
      ? [] : [{ blobId: missing[index]!.blobId, status: result.status, message: result.message }])
    if (failures.length)
      throw new BlobIntegrityError(failures)
    fetched.forEach((result, index) => {
      if (result.status === 'ok')
        nextReferences.push(...retainReference(missing[index]!, result.bytes))
    })
    remaining = nextReferences
  }
}
