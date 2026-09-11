import { AgentMode } from '../../../gen/agent_v1_pb'

/** Accept client enum names and internal lowercase mode names. */
export function resolveAgentMode(mode: string): AgentMode {
  const normalizedMode = mode.replace('AGENT_MODE_', '').toLowerCase()
  switch (normalizedMode) {
    case 'agent': return AgentMode.AGENT
    case 'ask': return AgentMode.ASK
    case 'plan': return AgentMode.PLAN
    case 'debug': return AgentMode.DEBUG
    case 'triage': return AgentMode.TRIAGE
    default: return AgentMode.AGENT
  }
}
