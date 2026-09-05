import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { OperationsAgentModel } from './data'
import { MeetingRoom } from './meeting-room'
import type { MeetingRecord } from './meetings'

const agents: OperationsAgentModel[] = [
  {
    assignments: [],
    displayName: 'Chair Bot',
    id: 'vps::chair',
    profile: 'chair',
    sourceId: 'vps',
    sourceKind: 'remote',
    sourceLabel: 'VPS',
    state: 'working',
    workSummary: 'Chairing the release decision'
  },
  {
    assignments: [],
    displayName: 'Research Bot',
    id: 'local::research',
    profile: 'research',
    sourceId: 'local',
    sourceKind: 'local',
    sourceLabel: 'This device',
    state: 'idle',
    workSummary: 'Ready'
  },
  {
    assignments: [],
    displayName: 'Review Bot',
    id: 'vps::review',
    profile: 'review',
    sourceId: 'vps',
    sourceKind: 'remote',
    sourceLabel: 'VPS',
    state: 'reviewing',
    workSummary: 'Reviewing evidence'
  },
  {
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
]

const meeting: MeetingRecord = {
  actionItems: [],
  agenda: 'Choose the verified release plan.',
  chair: { connectionId: 'vps', profile: 'chair' },
  contributions: [],
  currentRound: 1,
  decisions: [],
  dissent: [],
  evidenceRefs: [],
  id: 'meeting-1',
  maxRounds: 3,
  participants: [
    { connectionId: 'vps', profile: 'chair' },
    { connectionId: 'local', profile: 'research' },
    { connectionId: 'vps', profile: 'review' }
  ],
  source: { connectionId: 'vps', profile: 'chair' },
  state: 'running',
  title: 'Release council'
}

afterEach(cleanup)

describe('graphical Bot meeting room', () => {
  it('maps every source-qualified participant to exactly one Bot seat', () => {
    render(<MeetingRoom agents={agents} meeting={meeting} />)

    expect(screen.getAllByTestId('meeting-room-seat')).toHaveLength(meeting.participants.length)
    expect(screen.getByRole('button', { name: 'Open Chair Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Research Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Review Bot workspace' })).toBeTruthy()
  })

  it('places the first participant at the head of the table as chair', () => {
    render(<MeetingRoom agents={agents} meeting={meeting} />)

    const chair = screen.getByRole('button', { name: 'Open Chair Bot workspace' })

    expect(chair.dataset.seatPosition).toBe('head')
    expect(chair.getAttribute('aria-description')).toBe('Meeting chair')
  })

  it('highlights only the latest participant with a real speaking contribution', () => {
    render(<MeetingRoom agents={agents} meeting={{
      ...meeting,
      contributions: [
        { id: 'chair-r1', round: 1, participant: meeting.participants[0], kind: 'speak', text: 'Opening position', evidenceRefs: [] },
        { id: 'review-r1', round: 1, participant: meeting.participants[2], kind: 'speak', text: 'Latest evidence', evidenceRefs: [] },
        { id: 'research-r1', round: 1, participant: meeting.participants[1], kind: 'pass', text: '', evidenceRefs: [] }
      ]
    }} />)

    expect(screen.getByRole('button', { name: 'Open Review Bot workspace' }).dataset.speaker).toBe('latest')
    expect(screen.getAllByTestId('meeting-room-seat').filter(seat => seat.dataset.speaker === 'latest')).toHaveLength(1)
  })

  it.each([
    ['waiting', 'attention', 'Meeting waiting for owner input'],
    ['completed', 'settled', 'Meeting completed']
  ] as const)('renders a static %s state cue sourced from the meeting record', (state, lighting, label) => {
    render(<MeetingRoom agents={agents} meeting={{ ...meeting, state }} />)

    const room = screen.getByRole('region', { name: 'Bot meeting room' })

    expect(room.dataset.meetingState).toBe(state)
    expect(room.dataset.lighting).toBe(lighting)
    expect(screen.getByRole('status').textContent).toContain(label)
  })

  it('renders round progression as illuminated table-console segments', () => {
    render(<MeetingRoom agents={agents} meeting={{ ...meeting, currentRound: 2, maxRounds: 3 }} />)

    const progress = screen.getByRole('img', { name: 'Round 2 of 3' })
    const segments = progress.querySelectorAll('[data-round-segment]')

    expect(segments).toHaveLength(3)
    expect([...segments].filter(segment => (segment as HTMLElement).dataset.illuminated === 'true')).toHaveLength(2)
  })

  it('keeps a literal spatial room dominant instead of rendering participant cards', () => {
    const { container } = render(<MeetingRoom agents={agents} meeting={meeting} />)

    expect(screen.getByTestId('meeting-room-window')).toBeTruthy()
    expect(screen.getByTestId('meeting-room-wall')).toBeTruthy()
    expect(screen.getByTestId('meeting-room-floor')).toBeTruthy()
    expect(screen.getByTestId('meeting-room-table')).toBeTruthy()
    expect(screen.getByTestId('meeting-room-console')).toBeTruthy()
    expect(container.querySelector('[data-room-scene]')?.className).toContain('min-h-[clamp(32rem,calc(100dvh-13rem),52rem)]')
    expect(container.querySelector('[data-participant-card]')).toBeNull()
  })

  it('renders A2A harness agents at assigned seats when they match participants', () => {
    const a2aMeeting: MeetingRecord = {
      ...meeting,
      participants: [
        { connectionId: 'vps', profile: 'chair' },
        { connectionId: 'a2a', profile: 'agent-1' }
      ]
    }

    render(<MeetingRoom agents={agents} meeting={a2aMeeting} />)

    expect(screen.getAllByTestId('meeting-room-seat')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Open Chair Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open A2A Harness Bot workspace' })).toBeTruthy()
  })

  it('falls back to profile monogram when no matching agent is found', () => {
    const noAgentMeeting: MeetingRecord = {
      ...meeting,
      participants: [
        { connectionId: 'vps', profile: 'chair' },
        { connectionId: 'unknown', profile: 'ghost' }
      ]
    }

    render(<MeetingRoom agents={agents} meeting={noAgentMeeting} />)

    const ghostSeat = screen.getByRole('button', { name: 'Open ghost workspace' })
    expect(ghostSeat).toBeTruthy()
    // Fallback renders a monogram span when no agent matches
    expect(ghostSeat.textContent).toContain('G')
  })
})
