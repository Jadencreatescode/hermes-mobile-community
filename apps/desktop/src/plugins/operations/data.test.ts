import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import { getA2AAgentStatus, listA2AAgents, loadOperationsSnapshot, registerA2AAgent, removeA2AAgent } from './data'

describe('loadOperationsSnapshot', () => {
  it('keeps reachable agents visible beside a failed source and maps authoritative work', async () => {
    const requestProfile = vi.fn(async (route: { connectionId: string }, method: string, params: unknown) => {
      if (route.connectionId === 'dead') {
        throw new Error('offline')
      }

      if (method === 'profiles.list') {
        return {
          profiles: [
            {
              canonical_session: { id: 'bot-chat', preview: 'Checking the release', resolved_id: 'bot-chat-tip' },
              display_name: 'Release Bot',
              name: 'release',
              worker_session: { last_active: 1_000 }
            }
          ]
        }
      }

      if (method === 'session.active_list') {
        return { sessions: [{ id: 'runtime-1', session_key: 'bot-chat-tip', status: 'waiting', title: 'Bot Chat' }] }
      }

      if (method === 'cli.exec') {
        const argv = (params as { argv: string[] }).argv

        return argv.includes('diagnostics')
          ? { code: 0, output: '[]' }
          : { code: 0, output: '[{"id":"task-1","assignee":"release","status":"review","title":"Review release"}]' }
      }

      return {}
    })

    const host = {
      agents: vi.fn().mockResolvedValue({
        agents: [
          { connectionId: 'vps', connectionKind: 'remote', connectionLabel: 'VPS', handle: 'release', profile: 'release' }
        ],
        sources: [
          { connectionId: 'vps', kind: 'remote', label: 'VPS', reachable: true },
          { connectionId: 'dead', error: 'offline', kind: 'ssh', label: 'Bridge', reachable: false }
        ]
      }),
      requestProfile,
      status: vi.fn().mockResolvedValue({ active_sessions: 1 })
    }

    const snapshot = await loadOperationsSnapshot(host as never, { nowMs: 1_020_000 })

    expect(snapshot.sources.map(source => [source.label, source.status])).toEqual([
      ['VPS', 'online'],
      ['Bridge', 'offline']
    ])
    expect(snapshot.agents[0]).toMatchObject({
      displayName: 'Release Bot',
      openSessionId: 'bot-chat-tip',
      profile: 'release',
      sourceLabel: 'VPS',
      state: 'waiting',
      workSummary: 'Checking the release'
    })
    expect(snapshot.partialFailures).toContain('Bridge: offline')
  })

  it('maps a live delegated agent to the owning Operations agent', async () => {
    const host = {
      agents: vi.fn().mockResolvedValue({
        agents: [{ connectionId: 'vps', connectionKind: 'remote', connectionLabel: 'VPS', handle: 'ops', profile: 'ops' }],
        sources: [{ connectionId: 'vps', kind: 'remote', label: 'VPS', reachable: true }]
      }),
      requestProfile: vi.fn(async (_route, method: string) => {
        if (method === 'profiles.list') {
          return { profiles: [{ name: 'ops' }] }
        }

        if (method === 'session.active_list') {
          return { sessions: [{ id: 'runtime-owner', status: 'idle' }] }
        }

        return { code: 0, output: '[]' }
      }),
      status: vi.fn().mockResolvedValue({})
    }

    const snapshot = await loadOperationsSnapshot(host as never, {
      delegatedBySession: {
        'runtime-owner': [{ status: 'running' }]
      }
    })

    expect(snapshot.agents[0]).toMatchObject({ profile: 'ops', state: 'working' })
  })

  it('keeps a reachable identity unknown when its detail request fails', async () => {
    const host = {
      agents: vi.fn().mockResolvedValue({
        agents: [{ connectionId: 'vps', connectionKind: 'remote', connectionLabel: 'VPS', handle: 'ops', profile: 'ops' }],
        sources: [{ connectionId: 'vps', kind: 'remote', label: 'VPS', reachable: true }]
      }),
      requestProfile: vi.fn().mockRejectedValue(new Error('detail timeout')),
      status: vi.fn().mockResolvedValue({})
    }

    const snapshot = await loadOperationsSnapshot(host as never)

    expect(snapshot.agents[0]).toMatchObject({ profile: 'ops', state: 'unknown' })
    expect(snapshot.sources[0].status).toBe('degraded')
  })
})

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
})

describe('A2A harness agent data layer', () => {
  it('lists agents through the operations plugin REST namespace', async () => {
    const rest = vi.fn().mockResolvedValue({
      agents: [
        { agent_id: 'a2a:abc123', name: 'Test Agent', status: 'pending', capabilities: ['chat'] },
        { agent_id: 'a2a:def456', name: 'Other Agent', status: 'verified', capabilities: [] }
      ]
    })

    unbind = bindOperationsApi(rest)
    const agents = await listA2AAgents()

    expect(rest).toHaveBeenCalledWith('/agents/a2a')
    expect(agents).toHaveLength(2)
    expect(agents[0]).toMatchObject({ agentId: 'a2a:abc123', name: 'Test Agent', status: 'pending', capabilities: ['chat'] })
    expect(agents[1]).toMatchObject({ agentId: 'a2a:def456', name: 'Other Agent', status: 'verified', capabilities: [] })
  })

  it('fetches a single agent status', async () => {
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:status1',
      name: 'Status Agent',
      status: 'verified',
      capabilities: ['send']
    })

    unbind = bindOperationsApi(rest)
    const agent = await getA2AAgentStatus('a2a:status1')

    expect(rest).toHaveBeenCalledWith('/agents/a2a/a2a%3Astatus1/status')
    expect(agent).toMatchObject({ agentId: 'a2a:status1', name: 'Status Agent', status: 'verified', capabilities: ['send'] })
  })

  it('registers an agent with URL validation', async () => {
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:reg1',
      name: 'Registered Agent',
      status: 'pending',
      capabilities: []
    })

    unbind = bindOperationsApi(rest)
    const agent = await registerA2AAgent('https://example.com/agent')

    expect(rest).toHaveBeenCalledWith('/agents/a2a/register', {
      method: 'POST',
      body: { url: 'https://example.com/agent', confirm: false }
    })
    expect(agent).toMatchObject({ agentId: 'a2a:reg1', name: 'Registered Agent', status: 'pending' })
  })

  it('registers with confirm flag', async () => {
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:reg2',
      name: 'Confirmed Agent',
      status: 'verified',
      capabilities: ['chat']
    })

    unbind = bindOperationsApi(rest)
    const agent = await registerA2AAgent('https://example.com/agent', true)

    expect(rest).toHaveBeenCalledWith('/agents/a2a/register', {
      method: 'POST',
      body: { url: 'https://example.com/agent', confirm: true }
    })
    expect(agent.status).toBe('verified')
  })

  it('rejects an invalid URL before calling the API', async () => {
    const rest = vi.fn()
    unbind = bindOperationsApi(rest)

    await expect(registerA2AAgent('')).rejects.toThrow('A2A URL is invalid')
    await expect(registerA2AAgent('not-a-url')).rejects.toThrow('A2A URL is invalid')
    await expect(registerA2AAgent('ftp://example.com/agent')).rejects.toThrow('A2A URL is invalid')
    expect(rest).not.toHaveBeenCalled()
  })

  it('removes an agent and parses the response', async () => {
    const rest = vi.fn().mockResolvedValue({ agent_id: 'a2a:del1', deleted: true })

    unbind = bindOperationsApi(rest)
    const result = await removeA2AAgent('a2a:del1')

    expect(rest).toHaveBeenCalledWith('/agents/a2a/a2a%3Adel1', { method: 'DELETE' })
    expect(result).toEqual({ agentId: 'a2a:del1', deleted: true })
  })

  it('normalizes malformed responses to degraded with empty capabilities', async () => {
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:bad',
      name: 123,
      status: 'unknown_status',
      capabilities: [1, true, 'keep']
    })

    unbind = bindOperationsApi(rest)
    const agent = await getA2AAgentStatus('a2a:bad')

    expect(agent).toMatchObject({ agentId: 'a2a:bad', name: '', status: 'degraded', capabilities: ['keep'] })
  })

  it('returns empty agents array when the list response lacks agents', async () => {
    const rest = vi.fn().mockResolvedValue({})

    unbind = bindOperationsApi(rest)
    const agents = await listA2AAgents()

    expect(agents).toEqual([])
  })
})
