import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationsOverview } from './overview'

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    host: {
      ensureAgent: vi.fn(),
      newChat: vi.fn(),
      notifyError: vi.fn(),
      openSession: vi.fn()
    }
  }
})

afterEach(cleanup)

describe('OperationsOverview', () => {
  it('shows truthful public Bot, source, delegation, Kanban, and routine state', () => {
    const { container } = render(
      <OperationsOverview
        delegations={[{ goal: 'Review release', id: 'worker-1', sessionId: 'runtime-1', status: 'running' }]}
        routines={{
          failures: [],
          routines: [
            {
              connectionId: 'local',
              connectionLabel: 'Local Hermes',
              enabled: true,
              jobId: 'daily',
              name: 'Daily review',
              profile: 'release',
              schedule: '0 8 * * *',
              targetProfile: 'release'
            }
          ],
          successfulSources: 1
        }}
        snapshot={{
          agents: [
            {
              assignments: [{ id: 'task-1', status: 'review', summary: 'Ready', title: 'Review release' }],
              displayName: 'Release Bot',
              id: 'local::release',
              openSessionId: 'stored-release',
              openSessionKind: 'bot-chat',
              profile: 'release',
              sourceId: 'local',
              sourceKind: 'local',
              sourceLabel: 'Local Hermes',
              state: 'reviewing',
              workSummary: 'Checking release'
            }
          ],
          partialFailures: ['Remote Hermes: unreachable'],
          sources: [
            { id: 'local', kind: 'local', label: 'Local Hermes', reachable: true, status: 'online' },
            { id: 'remote', kind: 'remote', label: 'Remote Hermes', reachable: false, status: 'offline' }
          ]
        }}
      />
    )

    expect(screen.getByText('Release Bot')).toBeTruthy()
    expect(screen.getAllByText('Reviewing')).toHaveLength(2)
    expect(screen.getAllByText('Review release')).toHaveLength(2)
    expect(screen.getByText('Daily review')).toBeTruthy()
    expect(screen.getByText('Some sources are partial')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Release Bot workspace' }).className).toContain('min-h-11')
    expect(container.textContent).not.toContain('fixed owner')
    expect(container.textContent).not.toContain('Tailscale')
  })

  it('shows verified empty states without turning an offline source idle', () => {
    render(
      <OperationsOverview
        delegations={[]}
        routines={{ failures: [], routines: [], successfulSources: 1 }}
        snapshot={{
          agents: [],
          partialFailures: ['Remote Hermes: unreachable'],
          sources: [{ id: 'remote', kind: 'remote', label: 'Remote Hermes', reachable: false, status: 'offline' }]
        }}
      />
    )

    expect(screen.getByText('No Bots available')).toBeTruthy()
    expect(screen.getByText('No delegated agents are active or retained.')).toBeTruthy()
    expect(screen.getByText('No Kanban assignments are visible on reachable sources.')).toBeTruthy()
    expect(screen.getByText('No routines are configured across reachable profiles.')).toBeTruthy()
  })
})
