export interface WorkspaceAgent {
  displayName: string
  openSessionId?: string
  openSessionKind?: 'bot-chat' | 'session'
  profile: string
  sourceId: string
}

interface WorkspaceHost {
  ensureAgent(connectionId: null | string, profile: string): Promise<void>
  newChat(profile?: null | string): void
  openSession(
    storedSessionId: string,
    options?: {
      awaitHydration?: boolean
      expectHistory?: boolean
      keepAllProfilesScope?: boolean
      profile?: null | string
      retryHydrationTimeoutOnce?: boolean
    }
  ): Promise<void>
}

export async function openAgentWorkspace(host: WorkspaceHost, agent: WorkspaceAgent): Promise<void> {
  await host.ensureAgent(agent.sourceId, agent.profile)

  if (agent.openSessionId) {
    await host.openSession(agent.openSessionId, {
      awaitHydration: true,
      expectHistory: agent.openSessionKind === 'bot-chat',
      keepAllProfilesScope: false,
      profile: agent.profile,
      retryHydrationTimeoutOnce: true
    })

    return
  }

  host.newChat(agent.profile)
}
