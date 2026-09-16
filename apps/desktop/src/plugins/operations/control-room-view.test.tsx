import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { loadQuickSettings, removeA2AAgent, saveQuickSettings } = vi.hoisted(() => ({
  loadQuickSettings: vi.fn(),
  removeA2AAgent: vi.fn(),
  saveQuickSettings: vi.fn()
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeA2AAgent
}))

vi.mock('./control-room-actions', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadQuickSettings,
  saveQuickSettings,
  clearQuickSettings: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    host: {
      notifyError: vi.fn(),
      request: vi.fn()
    }
  }
})

import { ControlRoomView } from './control-room-view'
import type { OperationsSnapshot } from './data'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const emptySnapshot: OperationsSnapshot = {
  agents: [],
  partialFailures: [],
  sources: []
}

const populatedSnapshot: OperationsSnapshot = {
  agents: [
    {
      assignments: [],
      displayName: 'Release Bot',
      id: 'local::release',
      profile: 'release',
      sourceId: 'local',
      sourceKind: 'local',
      sourceLabel: 'Local Hermes',
      state: 'idle',
      workSummary: 'No active work'
    },
    {
      assignments: [],
      displayName: 'Builder Bot',
      id: 'local::builder',
      profile: 'builder',
      sourceId: 'local',
      sourceKind: 'local',
      sourceLabel: 'Local Hermes',
      state: 'working',
      workSummary: 'Building the release'
    },
    {
      assignments: [],
      displayName: 'Agent One',
      id: 'a2a::a2a:one',
      profile: 'a2a:one',
      sourceId: 'a2a',
      sourceKind: 'a2a',
      sourceLabel: 'A2A Harness',
      state: 'idle',
      workSummary: 'chat'
    }
  ],
  partialFailures: [],
  sources: [{ id: 'local', kind: 'local', label: 'Local Hermes', reachable: true, status: 'online' }]
}

describe('ControlRoomView visual shell', () => {
  it('renders the Live visual headquarters hero, department doors, and every room even when empty', async () => {
    render(<ControlRoomView snapshot={emptySnapshot} />)

    expect(screen.getByText('Live visual headquarters')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Control Room' })).toBeTruthy()
    expect(screen.getByText('Every room is driven by real session, task, review, input, and source evidence.')).toBeTruthy()

    for (const room of ['Live Floor', 'Needs You', 'Review Desk', 'Blocked Bay', 'Idle Lounge', 'Offline Station']) {
      expect(screen.getByRole('heading', { name: room })).toBeTruthy()
    }

    expect(screen.getAllByText('No Bots in this room').length).toBeGreaterThanOrEqual(6)
  })

  it('renders source pills from the public snapshot', async () => {
    render(<ControlRoomView snapshot={populatedSnapshot} />)

    expect(screen.getByText(/Local Hermes\s+online/)).toBeTruthy()
  })

  it('opens the department door callback for a real public section', async () => {
    const onOpenSection = vi.fn()

    render(<ControlRoomView onOpenSection={onOpenSection} snapshot={populatedSnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Mailroom' }))
    expect(onOpenSection).toHaveBeenCalledWith('mailroom')

    fireEvent.click(screen.getByRole('button', { name: 'Open Meetings' }))
    expect(onOpenSection).toHaveBeenCalledWith('meetings')

    fireEvent.click(screen.getByRole('button', { name: 'Open Agent Workspace' }))
    expect(onOpenSection).toHaveBeenCalledWith('workspace')
    expect(screen.queryByRole('button', { name: 'Open Teach a Task' })).toBeNull()
    expect(screen.getByLabelText('Operations departments').lastElementChild?.className).toContain('md:grid-cols-3')
  })

  it('places idle and working agents in their rooms with station cards', async () => {
    render(<ControlRoomView snapshot={populatedSnapshot} />)

    const idleLounge = screen.getByRole('heading', { name: 'Idle Lounge' }).closest('section') as HTMLElement
    const liveFloor = screen.getByRole('heading', { name: 'Live Floor' }).closest('section') as HTMLElement

    expect(idleLounge.textContent).toContain('Release Bot')
    expect(idleLounge.textContent).toContain('Agent One')
    expect(liveFloor.textContent).toContain('Builder Bot')
  })

  it('opens the onboarding dialog from the Connect a Bot hero action', async () => {
    render(<ControlRoomView snapshot={emptySnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect a Bot' }))

    expect(screen.getByLabelText('Agent card URL')).toBeTruthy()
  })

  it('shows the Details action when requested and routes it through the callback', async () => {
    const onShowDetails = vi.fn()

    render(<ControlRoomView onShowDetails={onShowDetails} snapshot={populatedSnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'View detailed Operations' }))
    expect(onShowDetails).toHaveBeenCalledOnce()
  })

  it('opens a local Bot station into the inspector Overview with an Open workspace action', async () => {
    const onOpenAgent = vi.fn()

    render(<ControlRoomView onOpenAgent={onOpenAgent} snapshot={populatedSnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Release Bot workspace' }))
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeTruthy()
    expect(screen.getAllByText('Release Bot').length).toBeGreaterThanOrEqual(2)

    fireEvent.click(screen.getByRole('button', { name: 'Open Release Bot Bot workspace' }))
    expect(onOpenAgent).toHaveBeenCalledOnce()
  })

  it('lets an A2A peer open Quick Settings from its inspector', async () => {
    loadQuickSettings.mockResolvedValue({
      model: 'gpt-4o',
      provider: 'openai',
      effort: 'medium',
      fast: false,
      iconColor: '#ff0000',
      iconShape: 'rounded'
    })

    render(<ControlRoomView snapshot={populatedSnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Agent One workspace' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open Agent One Quick Settings' }))

    await waitFor(() => expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy())
    expect(screen.getByDisplayValue('openai')).toBeTruthy()
  })

  it('removes an A2A peer from its inspector and clears settings', async () => {
    removeA2AAgent.mockResolvedValue({ agentId: 'a2a:one', deleted: true })

    render(<ControlRoomView snapshot={populatedSnapshot} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Agent One workspace' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Agent One' }))

    await waitFor(() => expect(removeA2AAgent).toHaveBeenCalledWith('a2a:one'))
  })

  it('surfaces an A2A registry error banner passed by the page', async () => {
    render(<ControlRoomView a2aError="Could not load A2A agents" snapshot={emptySnapshot} />)

    expect(screen.getByRole('alert').textContent).toContain('Could not load A2A agents')
  })
})
