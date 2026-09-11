import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { blobIdToBytes } from './blob'
import type { ParsedRunRequest } from './protocol'
import type { BlobRunContext } from './runContext'
import { restoreRequiredBlobGraph, type RequiredBlobReference } from './requiredBlobGraph'
import { uploadHandoff } from './uploadHandoff'

/** Upload acceptance creates required edges; absent child uploads need client KV. */
export async function* claimUploadedConversationBlobs(parsed: ParsedRunRequest, run: BlobRunContext): AsyncGenerator<AgentServerMessage, void, void> {
  const referenceGroups: Array<{ blobIds: string[], kind: RequiredBlobReference['kind'] }> = [
    { blobIds: parsed.historyBlobIds, kind: 'history' },
    { blobIds: parsed.historyTurnBlobIds, kind: 'turn' },
    { blobIds: parsed.historySummaryArchiveIds, kind: 'archive' },
  ]
  const visited = new Set<string>()
  for (const { blobIds, kind } of referenceGroups) {
    for (const blobId of blobIds) {
      const identity = `${kind}:${blobId}`
      if (visited.has(identity))
        continue
      visited.add(identity)
      // Deduplicate before read() copies bytes, and charge each retained upload
      // before claiming another. Original checkpoint ordering stays untouched.
      const bytes = run.blobs.getBlob(blobId)?.blobDataRaw
        ?? uploadHandoff.read(parsed.conversationId, blobIdToBytes(blobId))
      if (bytes !== undefined)
        yield* restoreRequiredBlobGraph(run, [{ blobId, kind, bytes }])
    }
  }
}
