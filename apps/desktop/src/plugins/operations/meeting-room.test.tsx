import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('opens a participant meeting conversation from a seated Bot desk when provided', () => {
    const onOpenConversation = vi.fn()

    render(<MeetingRoom agents={agents} meeting={meeting} onOpenConversation={onOpenConversation} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Research Bot meeting conversation' }))

    expect(onOpenConversation).toHaveBeenCalledWith(meeting.participants[1])
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

  it('shows thinking, latest-speaker, and idle activity cues at their desks', () => {
    render(<MeetingRoom
      agents={agents}
      meeting={{
        ...meeting,
        contributions: [
          { id: 'review-r1', round: 1, participant: meeting.participants[2], kind: 'speak', text: 'Latest evidence', evidenceRefs: [] }
        ]
      }}
      thinkingParticipant={meeting.participants[1]}
    />)

    const thinkingSeat = screen.getByRole('button', { name: 'Open Research Bot workspace' })
    const lastSpeakerSeat = screen.getByRole('button', { name: 'Open Review Bot workspace' })
    const idleSeat = screen.getByRole('button', { name: 'Open Chair Bot workspace' })

    expect(thinkingSeat.dataset.activity).toBe('thinking')
    expect(thinkingSeat.className).toContain('drop-shadow-[0_0_24px_rgba(103,232,249,1)]')
    expect(thinkingSeat.innerHTML).toContain('ring-2 ring-cyan-200')
    expect(thinkingSeat.innerHTML).toContain('motion-safe:animate-ping')
    expect(thinkingSeat.textContent).toContain('Thinking')
    expect(screen.getByRole('status', { name: 'Research Bot is thinking' })).toBeTruthy()
    expect(lastSpeakerSeat.dataset.activity).toBe('last-spoke')
    expect(lastSpeakerSeat.textContent).toContain('Last spoke')
    expect(idleSeat.dataset.activity).toBe('listening')
    expect(idleSeat.textContent).toContain('Tap desk')
  })

  it('opens meeting conversations from the touch-sized center table without a native title', () => {
    const onOpenConversations = vi.fn()

    render(<MeetingRoom agents={agents} meeting={meeting} onOpenConversations={onOpenConversations} />)

    const table = screen.getByRole('button', { name: 'Open meeting conversations' })
    const console = screen.getByTestId('meeting-room-console')

    expect(table.className).toContain('min-h-11')
    expect(table.getAttribute('title')).toBeNull()
    expect(console.className).toContain('pointer-events-none')
    fireEvent.click(table)
    expect(onOpenConversations).toHaveBeenCalledOnce()
  })

  it('replaces the round console with a completed meeting wrap up preview', () => {
    render(<MeetingRoom
      agents={agents}
      meeting={{
        ...meeting,
        actionItems: [{ title: 'Publish the verified release' }],
        decisions: [{ text: 'Proceed with the verified release plan.' }],
        state: 'completed'
      }}
    />)

    const wrapUp = screen.getByRole('region', { name: 'Meeting wrap up' })

    expect(wrapUp.textContent).toContain('Meeting wrap up')
    expect(wrapUp.textContent).toContain('Proceed with the verified release plan.')
    expect(wrapUp.textContent).toContain('Publish the verified release')
    expect(screen.queryByTestId('meeting-room-console')).toBeNull()
    expect(screen.getByTestId('meeting-room-table')).toBeTruthy()
    expect(screen.getAllByTestId('meeting-room-seat')).toHaveLength(meeting.participants.length)
  })

  it('shows touch-sized completed actions only for provided callbacks and invokes them', () => {
    const onCreateTasks = vi.fn()
    const onOpenConversations = vi.fn()
    const onOpenDetails = vi.fn()
    const completedMeeting = {
      ...meeting,
      actionItems: [{ title: 'Publish release' }, { title: 'Notify reviewers' }],
      state: 'completed' as const
    }
    const { unmount } = render(<MeetingRoom
      agents={agents}
      meeting={completedMeeting}
      onCreateTasks={onCreateTasks}
      onOpenConversations={onOpenConversations}
      onOpenDetails={onOpenDetails}
    />)

    const conversations = screen.getByRole('button', { name: 'Conversations' })
    const details = screen.getByRole('button', { name: 'Full wrap up' })
    const tasks = screen.getByRole('button', { name: 'Create 2 tasks' })

    for (const button of [conversations, details, tasks]) {
      expect(button.className).toContain('min-h-11')
      expect(button.className).toContain('min-w-11')
      expect(button.getAttribute('title')).toBeNull()
      fireEvent.click(button)
    }
    expect(onOpenConversations).toHaveBeenCalledOnce()
    expect(onOpenDetails).toHaveBeenCalledOnce()
    expect(onCreateTasks).toHaveBeenCalledOnce()

    unmount()
    render(<MeetingRoom agents={agents} meeting={completedMeeting} />)
    expect(screen.queryByRole('button', { name: 'Conversations' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Full wrap up' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create 2 tasks' })).toBeNull()
  })

  it('uses public-safe fallback previews when a completed meeting has no decision or action', () => {
    render(<MeetingRoom
      agents={agents}
      meeting={{ ...meeting, actionItems: [], decisions: [], state: 'completed' }}
      onCreateTasks={vi.fn()}
    />)

    const wrapUp = screen.getByRole('region', { name: 'Meeting wrap up' })

    expect(wrapUp.textContent).toContain('The meeting closed without a recorded conclusion.')
    expect(wrapUp.textContent).toContain('No next action was assigned.')
    expect(screen.queryByRole('button', { name: /Create \d+ tasks?/ })).toBeNull()
  })

  it.each([
    ['waiting', 'attention', 'Meeting waiting for your input'],
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

  it('renders zero seats when no participants', () => {
    const emptyMeeting: MeetingRecord = {
      ...meeting,
      participants: []
    }

    render(<MeetingRoom agents={agents} meeting={emptyMeeting} />)

    expect(screen.queryAllByTestId('meeting-room-seat')).toHaveLength(0)
  })

  it('shows running state label', () => {
    render(<MeetingRoom agents={agents} meeting={meeting} />)

    expect(screen.getByRole('status').textContent).toContain('Meeting in progress')
  })

  it('shows waiting state label', () => {
    render(<MeetingRoom agents={agents} meeting={{ ...meeting, state: 'waiting' }} />)

    expect(screen.getByRole('status').textContent).toContain('Meeting waiting for your input')
  })

  it('shows completed state label', () => {
    render(<MeetingRoom agents={agents} meeting={{ ...meeting, state: 'completed' }} />)

    expect(screen.getByRole('status').textContent).toContain('Meeting completed')
  })

  it('handles agent leave gracefully by removing seat', () => {
    const leaveMeeting: MeetingRecord = {
      ...meeting,
      participants: [
        { connectionId: 'vps', profile: 'chair' }
      ]
    }

    render(<MeetingRoom agents={agents} meeting={leaveMeeting} />)

    expect(screen.getAllByTestId('meeting-room-seat')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open Chair Bot workspace' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Research Bot workspace' })).toBeNull()
  })

  it('renders round table with no participants as empty', () => {
    const emptyMeeting: MeetingRecord = {
      ...meeting,
      participants: [],
      currentRound: 0
    }

    render(<MeetingRoom agents={agents} meeting={emptyMeeting} />)

    const progress = screen.getByRole('img', { name: 'Round 0 of 3' })
    const segments = progress.querySelectorAll('[data-round-segment]')
    expect(segments).toHaveLength(3)
    expect([...segments].filter(segment => (segment as HTMLElement).dataset.illuminated === 'true')).toHaveLength(0)
  })

  it('highlights chair participant with special indicator', () => {
    render(<MeetingRoom agents={agents} meeting={meeting} />)

    const chair = screen.getByRole('button', { name: 'Open Chair Bot workspace' })
    expect(chair.getAttribute('aria-description')).toBe('Meeting chair')
  })

  it('shows correct lighting for running state', () => {
    render(<MeetingRoom agents={agents} meeting={meeting} />)

    const room = screen.getByRole('region', { name: 'Bot meeting room' })
    expect(room.dataset.meetingState).toBe('running')
    expect(room.dataset.lighting).toBe('live')
  })
})
