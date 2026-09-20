import { host } from '@hermes/plugin-sdk'
import { cleanup } from '@testing-library/react'
import { isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getA2AAgentStatus, listA2AAgents } = vi.hoisted(() => ({
  getA2AAgentStatus: vi.fn(),
  listA2AAgents: vi.fn()
}))

vi.mock('./data', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./data')),
  getA2AAgentStatus,
  listA2AAgents
}))

import { a2aBotRosterProvider, disposeA2ABotWorkspaces } from './bot-roster-provider'
import { ConnectedAgentChatSurface } from './connected-agent-chat'
import plugin, { routeRequestsOnboarding } from './plugin'

afterEach(() => {
  disposeA2ABotWorkspaces()
  cleanup()
  window.location.hash = '#/'
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('public A2A Bot roster provider', () => {
  it('lists only agents verified by the public Operations endpoint', async () => {
    listA2AAgents.mockResolvedValue([
      { agentId: 'a2a:reviewer', capabilities: ['chat.send'], name: 'Release Reviewer', status: 'verified' },
      { agentId: 'a2a:pending', capabilities: ['chat.send'], name: 'Pending Agent', status: 'pending' },
      { agentId: 'a2a:degraded', capabilities: ['chat.send'], name: 'Degraded Agent', status: 'degraded' }
    ])

    await expect(a2aBotRosterProvider.list_verified_agents()).resolves.toEqual([
      {
        capabilities: ['chat.send'],
        description: 'Verified A2A agent',
        handle: 'a2a:reviewer',
        harness: 'a2a',
        host_id: 'operations',
        host_label: 'Hermes Operations',
        id: 'a2a:reviewer',
        name: 'Release Reviewer',
        verification_state: 'verified'
      }
    ])
  })

  it('opens the real connected-agent chat surface in a workspace', () => {
    const openWorkspace = vi.spyOn(host, 'openWorkspace').mockImplementation(() => () => undefined)

    const agent = {
      capabilities: ['chat.send'],
      description: 'Verified A2A agent',
      handle: 'a2a:reviewer',
      harness: 'a2a',
      host_id: 'operations',
      host_label: 'Hermes Operations',
      id: 'a2a:reviewer',
      name: 'Release Reviewer',
      verification_state: 'verified' as const
    }

    a2aBotRosterProvider.open_bot_chat(agent)

    expect(openWorkspace).toHaveBeenCalledWith(
      'connected-a2a-agent:a2a:reviewer',
      expect.objectContaining({ minWidth: '24rem', title: 'Release Reviewer' })
    )

    const rendered = openWorkspace.mock.calls[0]?.[1].render()
    expect(isValidElement(rendered)).toBe(true)

    if (!isValidElement(rendered)) {
      throw new Error('Connected A2A workspace must render one React element')
    }

    expect(rendered.type).toBe(ConnectedAgentChatSurface)
    expect(rendered.props).toMatchObject({
      agent: {
        agentId: 'a2a:reviewer',
        capabilities: ['chat.send'],
        name: 'Release Reviewer',
        status: 'verified'
      }
    })
  })

  it('closes connected-agent workspaces with the Operations plugin lifecycle', () => {
    const closeWorkspace = vi.fn()

    vi.spyOn(host, 'openWorkspace').mockReturnValue(closeWorkspace)
    a2aBotRosterProvider.open_bot_chat({
      capabilities: ['chat.send'],
      id: 'a2a:reviewer',
      name: 'Release Reviewer',
      verification_state: 'verified'
    })

    disposeA2ABotWorkspaces()

    expect(closeWorkspace).toHaveBeenCalledOnce()
  })

  it('forgets a workspace after the user closes its tab', () => {
    const closeWorkspace = vi.fn()
    let onClose: (() => void) | undefined

    vi.spyOn(host, 'openWorkspace').mockImplementation((_id, options) => {
      onClose = options.onClose

      return closeWorkspace
    })
    a2aBotRosterProvider.open_bot_chat({
      capabilities: ['chat.send'],
      id: 'a2a:reviewer',
      name: 'Release Reviewer',
      verification_state: 'verified'
    })

    onClose?.()
    disposeA2ABotWorkspaces()

    expect(closeWorkspace).not.toHaveBeenCalled()
  })

  it('routes settings to trusted bridge onboarding', () => {
    const navigate = vi.spyOn(host, 'navigate').mockImplementation(() => undefined)

    a2aBotRosterProvider.open_settings?.({} as never)

    expect(navigate).toHaveBeenCalledWith('/operations?onboard=1')
  })

  it('opens trusted bridge onboarding when the Operations route requests it', () => {
    window.location.hash = '#/operations?onboard=1'

    expect(routeRequestsOnboarding()).toBe(true)
  })

  it('refreshes through the public A2A status endpoint', async () => {
    getA2AAgentStatus.mockResolvedValue({
      agentId: 'a2a:reviewer', capabilities: ['chat.send'], name: 'Release Reviewer', status: 'verified'
    })

    await a2aBotRosterProvider.refresh_agent?.({ id: 'a2a:reviewer' } as never)

    expect(getA2AAgentStatus).toHaveBeenCalledWith('a2a:reviewer')
  })

  it('registers the Operations provider in the public SDK area', () => {
    const contributions: Array<{ area: string; data?: unknown; id: string }> = []
    const onDispose = vi.fn()

    plugin.register({
      i18n: { register: vi.fn(), t: (key: string) => key },
      onDispose,
      registerMany: (items: typeof contributions) => {
        contributions.push(...items)

        return () => undefined
      },
      rest: vi.fn()
    } as never)

    expect(contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        area: 'bots.roster.providers',
        data: a2aBotRosterProvider,
        id: 'verified-a2a-agents'
      })
    ]))
    expect(onDispose).toHaveBeenCalledWith(disposeA2ABotWorkspaces)
  })
})