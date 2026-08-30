import { describe, expect, it, vi } from 'vitest'

import { loadOperationsRoutines, operationsRoutineEmptyMessage } from './routines'

describe('loadOperationsRoutines', () => {
  it('aggregates every public profile route without losing source identity', async () => {
    const routes = [
      { connectionId: 'vps-id', mode: 'remote' as const, profile: 'ops-alias', targetProfile: 'remote-ops' },
      { connectionId: 'bridge-id', mode: 'remote' as const, profile: 'default', targetProfile: 'default' }
    ]

    const host = {
      connections: vi.fn().mockResolvedValue([
        { id: 'vps-id', kind: 'remote', label: 'VPS' },
        { id: 'bridge-id', kind: 'ssh', label: 'Bridge' }
      ]),
      profileRoutes: vi.fn().mockResolvedValue(routes),
      requestProfile: vi.fn(async (route: (typeof routes)[number]) =>
        route.connectionId === 'vps-id'
          ? { jobs: [{ enabled: true, job_id: 'daily', name: 'Daily review', schedule: '0 8 * * *' }] }
          : { jobs: [] }
      )
    }

    const result = await loadOperationsRoutines(host)

    expect(host.requestProfile).toHaveBeenNthCalledWith(1, routes[0], 'cron.manage', {
      action: 'list',
      include_disabled: true
    })
    expect(result.routines).toEqual([
      {
        connectionId: 'vps-id',
        connectionLabel: 'VPS',
        enabled: true,
        jobId: 'daily',
        name: 'Daily review',
        profile: 'ops-alias',
        schedule: '0 8 * * *',
        targetProfile: 'remote-ops'
      }
    ])
    expect(result.failures).toEqual([])
  })

  it('reports failed profile sources separately from successful empty sources', async () => {
    const routes = [
      { connectionId: 'vps-id', mode: 'remote' as const, profile: 'ops', targetProfile: 'ops' },
      { connectionId: 'bridge-id', mode: 'remote' as const, profile: 'default', targetProfile: 'default' }
    ]

    const host = {
      connections: vi.fn().mockResolvedValue([
        { id: 'vps-id', kind: 'remote', label: 'VPS' },
        { id: 'bridge-id', kind: 'ssh', label: 'Bridge' },
        { id: 'helm-id', kind: 'ssh', label: 'Helm' }
      ]),
      profileRoutes: vi.fn().mockResolvedValue(routes),
      requestProfile: vi.fn(async (route: (typeof routes)[number]) => {
        if (route.connectionId === 'bridge-id') {
          throw new Error('gateway timeout')
        }

        return { jobs: [] }
      })
    }

    const result = await loadOperationsRoutines(host)

    expect(result.routines).toEqual([])
    expect(result.failures).toEqual([
      {
        connectionId: 'helm-id',
        connectionLabel: 'Helm',
        error: 'Profile inventory unavailable'
      },
      {
        connectionId: 'bridge-id',
        connectionLabel: 'Bridge',
        error: 'gateway timeout',
        profile: 'default',
        targetProfile: 'default'
      }
    ])
    expect(result.successfulSources).toBe(1)
  })

  it('labels a verified empty inventory without private node language', () => {
    expect(operationsRoutineEmptyMessage({ failures: [], routines: [], successfulSources: 2 })).toBe(
      'No routines are configured across reachable profiles.'
    )
  })

  it('labels a failed routine inventory as unavailable instead of empty', () => {
    expect(
      operationsRoutineEmptyMessage({
        failures: [
          {
            connectionId: 'bridge-id',
            connectionLabel: 'Bridge',
            error: 'gateway timeout',
            profile: 'default',
            targetProfile: 'default'
          }
        ],
        routines: [],
        successfulSources: 1
      })
    ).toBe('Routine reads failed for Bridge / @default.')
  })
})
