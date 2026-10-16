import {
  type BotsRosterProvider,
  type BotsRosterProviderAgent,
  host
} from '@hermes/plugin-sdk'

import { ConnectedAgentChatSurface } from './connected-agent-chat'
import { getA2AAgentStatus, type HarnessAgent, listA2AAgents } from './data'

const PUBLIC_A2A_HARNESS = 'a2a'
const PUBLIC_A2A_HOST_ID = 'operations'
const PUBLIC_A2A_HOST_LABEL = 'Hermes Operations'
const openWorkspaceClosers = new Map<string, () => void>()

function toProviderAgent(agent: HarnessAgent): BotsRosterProviderAgent | null {
  if (agent.status !== 'verified' || !agent.agentId || !agent.name) {
    return null
  }

  return {
    capabilities: agent.capabilities,
    description: 'Verified A2A agent',
    handle: agent.agentId,
    harness: PUBLIC_A2A_HARNESS,
    host_id: PUBLIC_A2A_HOST_ID,
    host_label: PUBLIC_A2A_HOST_LABEL,
    id: agent.agentId,
    name: agent.name,
    verification_state: 'verified'
  }
}

function toHarnessAgent(agent: BotsRosterProviderAgent): HarnessAgent {
  return {
    agentId: agent.id,
    capabilities: agent.capabilities,
    name: agent.name,
    status: 'verified'
  }
}

export const a2aBotRosterProvider: BotsRosterProvider = {
  list_verified_agents: async () => (await listA2AAgents())
    .map(toProviderAgent)
    .filter((agent): agent is BotsRosterProviderAgent => agent !== null),

  open_bot_chat: agent => {
    const workspaceId = `connected-a2a-agent:${agent.id}`
    let closeWorkspace: () => void

    closeWorkspace = host.openWorkspace(workspaceId, {
      minWidth: '24rem',
      onClose: () => {
        if (openWorkspaceClosers.get(workspaceId) === closeWorkspace) {
          openWorkspaceClosers.delete(workspaceId)
        }
      },
      render: () => <ConnectedAgentChatSurface agent={toHarnessAgent(agent)} />,
      title: agent.name
    })
    openWorkspaceClosers.set(workspaceId, closeWorkspace)
  },

  open_settings: () => host.navigate('/operations?onboard=1'),

  refresh_agent: async agent => {
    await getA2AAgentStatus(agent.id)
  }
}

export function disposeA2ABotWorkspaces(): void {
  const closers = [...openWorkspaceClosers.values()]

  openWorkspaceClosers.clear()

  for (const closeWorkspace of closers) {
    closeWorkspace()
  }
}