import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadOperationsRoutines, loadOperationsSnapshot, navigate } = vi.hoisted(() => ({
  loadOperationsRoutines: vi.fn(),
  loadOperationsSnapshot: vi.fn(),
  navigate: vi.fn()
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadOperationsSnapshot
}))

vi.mock('./routines', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadOperationsRoutines
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const atom = <T,>(value: T) => ({ get: () => value, listen: vi.fn(), subscribe: vi.fn() })

  return {
    ...actual,
    host: {
      agents: vi.fn(),
      connections: vi.fn(),
      ensureAgent: vi.fn(),
      navigate,
      newChat: vi.fn(),
      notifyError: vi.fn(),
      openSession: vi.fn(),
      profileRoutes: vi.fn(),
      requestProfile: vi.fn(),
      state: {
        connectionId: atom('local'),
        gateway: atom('open'),
        profile: atom('default'),
        subagents: atom({})
      },
      status: vi.fn()
    }
  }
})

import { OperationsPage } from './page'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const snapshot = {
  agents: [
    {
      assignments: [],
      displayName: 'Release Bot',
      id: 'local::release',
      profile: 'release',
      sourceId: 'local',
      sourceKind: 'local',
      sourceLabel: 'Local Hermes',
      state: 'idle' as const,
      workSummary: 'No active work'
    }
  ],
  partialFailures: [],
  sources: [{ id: 'local', kind: 'local', label: 'Local Hermes', reachable: true, status: 'online' as const }]
}

const routines = { failures: [], routines: [], successfulSources: 1 }

describe('OperationsPage', () => {
  it('loads the existing Hermes authorities and renders the verified overview', async () => {
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)

    expect(screen.getByRole('status', { name: 'Loading Operations' })).toBeTruthy()
    expect(await screen.findByText('Release Bot')).toBeTruthy()
    expect(loadOperationsSnapshot).toHaveBeenCalledOnce()
    expect(loadOperationsRoutines).toHaveBeenCalledOnce()
    expect(screen.getByText(/Bots, delegated workers, assignments, routines, and source health/i)).toBeTruthy()
  })

  it('links Training to the existing public Training Mode rather than a private capture implementation', async () => {
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'training' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Training Mode' }))

    expect(navigate).toHaveBeenCalledWith('/training')
    expect(screen.getByText(/does not run or schedule the task/i)).toBeTruthy()
  })

  it('renders the touch-safe Mailroom for the active and reachable Bot profiles', async () => {
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'mailroom' } })

    expect(await screen.findByText('Durable, ordered Bot correspondence')).toBeTruthy()
    expect((screen.getByLabelText('Mailroom target') as HTMLSelectElement).value).toBe('release')
  })

  it('opens the exact public Agent Workspace surface without exposing takeover controls', async () => {
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    const { container } = render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'workspace' } })

    expect(await screen.findByRole('heading', { name: 'Agent Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Release Bot workspace' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/screen takeover|remote control/i)
  })

  it('renders bounded structured meetings over the existing public Bot roster', async () => {
    loadOperationsSnapshot.mockResolvedValue({
      ...snapshot,
      agents: [
        ...snapshot.agents,
        {
          ...snapshot.agents[0],
          displayName: 'Builder Bot',
          id: 'local::builder',
          profile: 'builder'
        }
      ]
    })
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'meetings' } })

    expect(await screen.findByRole('heading', { name: 'New specialist meeting' })).toBeTruthy()
    expect(screen.getByLabelText('Select Release Bot as a meeting participant')).toBeTruthy()
    expect(screen.getByLabelText('Select Builder Bot as a meeting participant')).toBeTruthy()
  })

  it('keeps the last verified snapshot visible when a later refresh fails', async () => {
    loadOperationsSnapshot.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('refresh failed'))
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Operations' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refresh failed'))
    expect(screen.getByText('Release Bot')).toBeTruthy()
  })
})
