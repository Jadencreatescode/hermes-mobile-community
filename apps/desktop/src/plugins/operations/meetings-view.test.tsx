import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import type { OperationsAgentModel, OperationsSnapshot } from './data'
import { MeetingsView } from './meetings-view'

const { notify, requestProfile } = vi.hoisted(() => ({ notify: vi.fn(), requestProfile: vi.fn() }))

vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  host: { notify, requestProfile }
}))

let unbind: (() => void) | undefined

afterEach(() => {
  cleanup()
  unbind?.()
  unbind = undefined
  vi.clearAllMocks()
})

const chair: OperationsAgentModel = {
  assignments: [],
  displayName: 'Chair Bot',
  id: 'local::chair',
  profile: 'chair',
  sourceId: 'local',
  sourceKind: 'local',
  sourceLabel: 'This device',
  state: 'working',
  workSummary: 'Chairing the meeting'
}

const reviewer: OperationsAgentModel = {
  assignments: [],
  displayName: 'Review Bot',
  id: 'local::reviewer',
  profile: 'reviewer',
  sourceId: 'local',
  sourceKind: 'local',
  sourceLabel: 'This device',
  state: 'reviewing',
  workSummary: 'Reviewing the decision'
}

const a2aAgent: OperationsAgentModel = {
  assignments: [],
  displayName: 'A2A Harness Bot',
  id: 'a2a::agent-1',
  profile: 'agent-1',
  sourceId: 'a2a',
  sourceKind: 'a2a',
  sourceLabel: 'A2A Harness',
  state: 'idle',
  workSummary: 'Connected via A2A'
}

const snapshot: OperationsSnapshot = {
  agents: [chair, reviewer, a2aAgent],
  partialFailures: [],
  sources: [{ id: 'local', kind: 'local', label: 'This device', reachable: true, status: 'online' }]
}

const meeting = {
  action_items: [],
  agenda: 'Choose the verified release plan.',
  chair: { connection: 'local', profile: 'chair' },
  contributions: [{
    evidence_refs: [],
    id: 'review-r1',
    kind: 'speak',
    participant: { connection: 'local', profile: 'reviewer' },
    round: 1,
    text: 'Ship the visual room.'
  }],
  current_round: 1,
  decisions: [],
  dissent: [],
  evidence: [],
  id: 'meeting-room-1',
  max_rounds: 3,
  participants: [
    { connection: 'local', profile: 'chair' },
    { connection: 'local', profile: 'reviewer' }
  ],
  source: { connection: 'local', profile: 'chair' },
  state: 'running',
  title: 'Release council'
}

beforeEach(() => {
  vi.clearAllMocks()
  requestProfile.mockImplementation(async (method: string) => {
    if (method === 'operations.meetings.list') {return { meetings: [{ meeting, version: 1 }] }}
    throw new Error(`Unexpected request: ${method}`)
  })
})

afterEach(cleanup)

describe('Meetings graphical room integration', () => {
  it('opens the latest durable meeting as a literal room and routes Bot seats', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    const onOpenAgent = vi.fn()

    render(<MeetingsView onOpenAgent={onOpenAgent} snapshot={snapshot} />)

    const room = await screen.findByRole('region', { name: 'Bot meeting room' })

    expect(room.getAttribute('data-room-scene')).not.toBeNull()
    expect(screen.queryByText('The council chamber is empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot workspace' }))
    expect(onOpenAgent).toHaveBeenCalledWith(reviewer)
  })

  it('keeps setup and meeting records behind deliberate controls', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    expect(screen.queryByText('Agenda and decision required')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'Set the meeting table' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Agenda and decision required')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = screen.getByRole('dialog', { name: 'Meeting details' })
    expect(details.textContent).toContain('Choose the verified release plan.')
    expect(details.textContent).toContain('Ship the visual room.')
  })

  it('keeps room controls touch sized and state specific', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    const runRound = screen.getByRole('button', { name: 'Run meeting round' })
    expect(runRound.className).toContain('min-h-11')
    expect(runRound.className).toContain('min-w-11')
    await waitFor(() => expect(rest).toHaveBeenCalledWith(expect.stringMatching(/^\/meetings\?/)))
  })

  it('renders A2A harness agents in council seats when they are meeting participants', async () => {
    const a2aMeeting = {
      ...meeting,
      participants: [
        { connection: 'local', profile: 'chair' },
        { connection: 'a2a', profile: 'agent-1' }
      ],
      contributions: [{
        evidence_refs: [],
        id: 'agent-r1',
        kind: 'speak',
        participant: { connection: 'a2a', profile: 'agent-1' },
        round: 1,
        text: 'A2A agent contribution.'
      }]
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: a2aMeeting, version: 1 }] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    expect(screen.getByRole('button', { name: 'Open Chair Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open A2A Harness Bot workspace' })).toBeTruthy()
  })

  it('shows empty state when no meetings exist', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)

    expect(await screen.findByText('The council chamber is empty')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Bot meeting room' })).toBeNull()
  })
})
