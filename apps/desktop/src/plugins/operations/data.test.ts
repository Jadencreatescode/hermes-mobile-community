import { describe, expect, it, vi } from 'vitest'

import { loadOperationsSnapshot } from './data'

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
