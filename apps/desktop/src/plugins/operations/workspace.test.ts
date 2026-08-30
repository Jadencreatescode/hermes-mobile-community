import { describe, expect, it, vi } from 'vitest'

import { openAgentWorkspace, type WorkspaceAgent } from './workspace'

const agent: WorkspaceAgent = {
  displayName: 'Release Bot',
  openSessionId: 'stored-bot-chat',
  openSessionKind: 'bot-chat',
  profile: 'release',
  sourceId: 'vps'
}

describe('openAgentWorkspace', () => {
  it('opens the exact source profile and existing session through the normal Hermes workspace', async () => {
    const host = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      newChat: vi.fn(),
      openSession: vi.fn().mockResolvedValue(undefined)
    }

    await openAgentWorkspace(host, agent)

    expect(host.ensureAgent).toHaveBeenCalledWith('vps', 'release')
    expect(host.openSession).toHaveBeenCalledWith('stored-bot-chat', {
      awaitHydration: true,
      expectHistory: true,
      keepAllProfilesScope: false,
      profile: 'release',
      retryHydrationTimeoutOnce: true
    })
    expect(host.newChat).not.toHaveBeenCalled()
  })

  it('starts a normal chat when no durable session exists', async () => {
    const host = {
      ensureAgent: vi.fn().mockResolvedValue(undefined),
      newChat: vi.fn(),
      openSession: vi.fn()
    }

    await openAgentWorkspace(host, { ...agent, openSessionId: undefined, openSessionKind: undefined })

    expect(host.ensureAgent).toHaveBeenCalledWith('vps', 'release')
    expect(host.newChat).toHaveBeenCalledWith('release')
    expect(host.openSession).not.toHaveBeenCalled()
  })

  it('does not expose a screen input or takeover method', () => {
    expect(Object.keys({ openAgentWorkspace })).toEqual(['openAgentWorkspace'])
  })
})
