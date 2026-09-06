import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadConnectedAgents, loadOperationsRoutines, loadOperationsSnapshot, listA2AAgents, navigate } = vi.hoisted(() => ({
  loadConnectedAgents: vi.fn(),
  loadOperationsRoutines: vi.fn(),
  loadOperationsSnapshot: vi.fn(),
  listA2AAgents: vi.fn(async () => [] as unknown[]),
  navigate: vi.fn()
}))

const forgeBoard = vi.hoisted(() => ({
  columns: [
    { name: 'ready', tasks: [{ id: 't_forge01', title: 'Ship the forge panel', status: 'ready' }] }
  ],
  assignees: [],
  tenants: []
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConnectedAgents,
  loadOperationsSnapshot,
  listA2AAgents
}))

vi.mock('./forge-data', () => ({
  FORGE_BOARD_SLUG: 'hermes-forge',
  fetchForgeBoard: vi.fn(async () => forgeBoard)
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
    },
    useQuery: () => ({ data: forgeBoard, error: null, isLoading: false })
  }
})

import { OperationsPage } from './page'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
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
    loadConnectedAgents.mockResolvedValue([])
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
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'training' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Training Mode' }))

    expect(navigate).toHaveBeenCalledWith('/training')
    expect(screen.getByText(/does not run or schedule the task/i)).toBeTruthy()
  })

  it('renders the touch-safe Mailroom only for profiles local to its authenticated API host', async () => {
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValue({
      ...snapshot,
      agents: [
        ...snapshot.agents,
        {
          ...snapshot.agents[0],
          displayName: 'Remote Bot',
          id: 'remote::remote-only',
          profile: 'remote-only',
          sourceId: 'remote',
          sourceKind: 'remote',
          sourceLabel: 'Remote Hermes'
        }
      ]
    })
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'mailroom' } })

    expect(await screen.findByText('Durable, ordered Bot correspondence')).toBeTruthy()
    expect((screen.getByLabelText('Mailroom target') as HTMLSelectElement).value).toBe('release')
    expect(screen.queryByRole('option', { name: 'remote-only' })).toBeNull()
  })

  it('opens the exact public Agent Workspace surface without exposing takeover controls', async () => {
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    const { container } = render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'workspace' } })

    expect(await screen.findByRole('heading', { name: 'Agent Workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Release Bot workspace' })).toBeTruthy()
    expect(container.textContent).not.toMatch(/screen takeover|remote control/i)
  })

  it('routes the forge section to the read-only Forge Kanban view', async () => {
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'forge' } })

    expect(await screen.findByRole('heading', { name: 'Forge' })).toBeTruthy()
    expect(await screen.findByText('Ship the forge panel')).toBeTruthy()
  })

  it('renders bounded structured meetings over the existing public Bot roster', async () => {
    loadConnectedAgents.mockResolvedValue([])
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

    expect(await screen.findByText('The council chamber is empty')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set the table' })).toBeTruthy()
  })

  it('keeps the last verified snapshot visible when a later refresh fails', async () => {
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('refresh failed'))
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Operations' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refresh failed'))
    expect(screen.getByText('Release Bot')).toBeTruthy()
  })

  it('never lets an older overlapping refresh replace newer source state', async () => {
    vi.useFakeTimers()
    let resolveOlder: (value: typeof snapshot) => void = () => undefined
    const older = new Promise<typeof snapshot>(resolve => { resolveOlder = resolve })

    const newest = {
      ...snapshot,
      agents: [{ ...snapshot.agents[0], displayName: 'Newest Bot', profile: 'newest' }]
    }

    const stale = {
      ...snapshot,
      agents: [{ ...snapshot.agents[0], displayName: 'Stale Bot', profile: 'stale' }]
    }

    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce(newest)
    loadOperationsRoutines.mockResolvedValue(routines)

    render(<OperationsPage />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Release Bot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Operations' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_010)
      await Promise.resolve()
    })
    expect(screen.getByText('Newest Bot')).toBeTruthy()
    await act(async () => { resolveOlder(stale); await Promise.resolve() })

    expect(screen.getByText('Newest Bot')).toBeTruthy()
    expect(screen.queryByText('Stale Bot')).toBeNull()
  })

  it('renders the Control Room v2 section with A2A agents', async () => {
    loadConnectedAgents.mockResolvedValue([])
    loadOperationsSnapshot.mockResolvedValue(snapshot)
    loadOperationsRoutines.mockResolvedValue(routines)
    listA2AAgents.mockResolvedValue([
      { agentId: 'a2a:test', name: 'Test Agent', status: 'verified', capabilities: ['chat'] }
    ])

    render(<OperationsPage />)
    await screen.findByText('Release Bot')
    fireEvent.change(screen.getByLabelText('Operations section'), { target: { value: 'control-room' } })

    await waitFor(() => expect(screen.getByText('Test Agent')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Control Room' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect agent' })).toBeTruthy()
  })
})
