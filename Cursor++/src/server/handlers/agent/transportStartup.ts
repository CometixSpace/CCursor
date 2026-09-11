import { Code, ConnectError } from '@connectrpc/connect'
import type { AgentSession } from './session'
import { discardSessionMessages, waitForMessageMatching } from './session'

// Local startup budget, not an official Cursor timeout. Keep one absolute
// deadline: heartbeats, ACKs and queued actions must not extend it.
export const AGENT_STARTUP_TIMEOUT_MS = 30_000

function unsupportedStartup(detail: string): ConnectError {
  return new ConnectError(`Unsupported queued agent actions: ${detail}. No user action was submitted to the model.`, Code.FailedPrecondition)
}

function applyQueuedAction(
  runMessage: Record<string, unknown>,
  queuedActions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (queuedActions.length === 0)
    return runMessage
  if (queuedActions.length !== 1)
    throw unsupportedStartup('multiple actions arrived before RunRequest; cannot combine them without changing user intent')

  const queuedAction = queuedActions[0]!
  const userAction = queuedAction.userMessageAction as Record<string, unknown> | undefined
  const runRequest = runMessage.runRequest as Record<string, unknown>
  const initialAction = runRequest.action as Record<string, unknown> | undefined
  const resumeAction = initialAction?.resumeAction as Record<string, unknown> | undefined
  if (!userAction?.userMessage || !resumeAction)
    throw unsupportedStartup('only one complete UserMessageAction followed by ResumeAction is supported')

  // This is a compatibility adapter, not a claim about cloud orchestration.
  // Preserve the entire action (selected images, prepends, resolutions, parts
  // and metadata). A ref-only queued action must not inherit an inline context
  // from resume, which would take precedence over its own dynamic context.
  const hasQueuedContext = userAction.requestContext !== undefined || queuedAction.requestContextParts !== undefined
  return {
    ...runMessage,
    runRequest: {
      ...runRequest,
      action: {
        ...initialAction,
        ...queuedAction,
        resumeAction: undefined,
        userMessageAction: hasQueuedContext
          ? userAction
          : { ...userAction, requestContext: resumeAction.requestContext },
        requestContextParts: hasQueuedContext
          ? queuedAction.requestContextParts
          : initialAction?.requestContextParts,
      },
    },
  }
}

/** Both real transports enter orchestration only through a live RunRequest. */
export async function waitForRunRequest(session: AgentSession): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + AGENT_STARTUP_TIMEOUT_MS
  let precedingMessages: Array<Record<string, unknown>> = []
  // Keep queued user intent in the charged session queue until RunRequest.
  // Consuming it into a local variable while waiting would bypass the global
  // transport budget across many idle startup streams.
  const message = await waitForMessageMatching(session, candidate => {
    if ('runRequest' in candidate) {
      precedingMessages = session.messages.slice(0, session.messages.indexOf(candidate))
      return true
    }
    if (!('conversationAction' in candidate))
      return false
    let actionCount = 0
    for (const queuedMessage of session.messages) {
      if ('runRequest' in queuedMessage)
        break
      if ('conversationAction' in queuedMessage && ++actionCount > 1)
        return true
    }
    return false
  }, AGENT_STARTUP_TIMEOUT_MS)
  if (session.closed || session.cancelledReason !== undefined)
    return null
  if (!message || Date.now() >= deadline)
    throw new ConnectError('Agent startup timed out waiting for RunRequest', Code.DeadlineExceeded)
  if (!('runRequest' in message))
    throw unsupportedStartup('multiple actions arrived before RunRequest; cannot combine them without changing user intent')
  const queuedActions = precedingMessages.flatMap(queuedMessage => 'conversationAction' in queuedMessage
    ? [queuedMessage.conversationAction as Record<string, unknown>] : [])
  const runMessage = applyQueuedAction(message, queuedActions)
  const consumedMessages = new Set(precedingMessages)
  discardSessionMessages(session, queuedMessage => consumedMessages.has(queuedMessage))
  return runMessage
}
