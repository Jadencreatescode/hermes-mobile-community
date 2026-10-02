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

// ── PB4: new controls ─────────────────────────────────────────────────────────

describe('PB4 – seat/role assignment controls (C3)', () => {
  it('shows role selector for each checked participant in the create dialog', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'Set the meeting table' })).toBeTruthy()

    // Check Chair Bot — role selector should appear
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check Chair Bot

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy()
    })
  })

  it('seat label input appears only after a non-empty role is chosen', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check Chair Bot

    await waitFor(() => expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy())

    // Before choosing a role, label input should NOT be present
    expect(screen.queryByPlaceholderText('Seat label')).toBeNull()

    // Choose a role
    fireEvent.change(screen.getByRole('combobox', { name: /Role for Chair Bot/i }), { target: { value: 'contributor' } })

    await waitFor(() => expect(screen.getByPlaceholderText('Seat label')).toBeTruthy())
  })

  it('role selector disappears when participant is unchecked', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy())

    fireEvent.click(allCheckboxes[0]) // uncheck
    await waitFor(() => expect(screen.queryByRole('combobox', { name: /Role for Chair Bot/i })).toBeNull())
  })
})

describe('PB4 – orchestrator/producer designation controls (C1)', () => {
  it('production roles fieldset is hidden until 2+ participants are checked', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    expect(screen.queryByRole('group', { name: /Production roles/i })).toBeNull()

    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // 1 participant — still hidden
    expect(screen.queryByRole('group', { name: /Production roles/i })).toBeNull()

    fireEvent.click(allCheckboxes[1]) // 2 participants — should appear
    await waitFor(() => expect(screen.getByRole('group', { name: /Production roles/i })).toBeTruthy())
  })

  it('orchestrator and producer selectors are present once 2+ participants are chosen', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0])
    fireEvent.click(allCheckboxes[1])

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Orchestrator/i })).toBeTruthy()
      expect(screen.getByRole('combobox', { name: /Producer/i })).toBeTruthy()
    })
  })

  it('shows validation error when only orchestrator is set but not producer', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [] } }
      if (path.startsWith('/meetings/')) { return { meeting, version: 1 } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0])
    fireEvent.click(allCheckboxes[1])

    // Fill required title/agenda
    fireEvent.change(screen.getByPlaceholderText('Meeting title'), { target: { value: 'Prod test' } })
    fireEvent.change(screen.getByPlaceholderText('Agenda and decision required'), { target: { value: 'Agenda here' } })

    await waitFor(() => expect(screen.getByRole('combobox', { name: /Orchestrator/i })).toBeTruthy())

    // Set orchestrator but leave producer empty
    const orchestratorSelect = screen.getByRole('combobox', { name: /Orchestrator/i })
    const orchestratorOptions = Array.from(orchestratorSelect.querySelectorAll('option'))
    const firstReal = orchestratorOptions.find(o => (o as HTMLOptionElement).value !== '')
    if (firstReal) {
      fireEvent.change(orchestratorSelect, { target: { value: (firstReal as HTMLOptionElement).value } })
    }

    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await waitFor(() => {
      const alert = screen.getByRole('alert', { hidden: true })
      expect(alert.textContent).toContain('Orchestrator and producer must both be set together.')
    })
  })

  it('production meeting details shows orchestrator and producer rows', async () => {
    const productionMeeting = {
      ...meeting,
      state: 'running',
      orchestrator: { connectionId: 'local', profile: 'chair' },
      producer: { connectionId: 'local', profile: 'reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting: productionMeeting, version: 1 }] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = screen.getByRole('dialog', { name: 'Meeting details' })

    await waitFor(() => {
      expect(details.textContent).toContain('Production roles')
      expect(details.textContent).toContain('Orchestrator')
      expect(details.textContent).toContain('Producer')
    })
  })
})

describe('PB4 – artifact-binding submission UI (C4/C5)', () => {
  it('artifact binding fieldset is hidden for ordinary (non-production) meetings', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting, version: 1 }] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    // The conclude section should be present (meeting is running)
    await waitFor(() => expect(screen.getByRole('button', { name: /Conclude meeting/i })).toBeTruthy())

    // But artifact binding fieldset must NOT appear for an ordinary meeting.
    expect(screen.queryByRole('group', { name: /Artifact binding/i })).toBeNull()
  })

  it('artifact binding fieldset appears for production meetings in the conclude section', async () => {
    const productionMeeting = {
      ...meeting,
      state: 'running',
      orchestrator: { connectionId: 'local', profile: 'chair' },
      producer: { connectionId: 'local', profile: 'reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting: productionMeeting, version: 1 }] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))

    await waitFor(() => {
      expect(screen.getByRole('group', { name: /Artifact binding/i })).toBeTruthy()
    })

    // All required sub-fields should be present.
    expect(screen.getByRole('textbox', { name: /Output ID/i })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: /Artifact version/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Game SHA-256/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Manifest SHA-256/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Zip SHA-256/i })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /Approved by/i })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: /Approved at/i })).toBeTruthy()
  })

  it('concluding a production meeting without artifact binding shows a validation error', async () => {
    const productionMeeting = {
      ...meeting,
      state: 'running',
      orchestrator: { connectionId: 'local', profile: 'chair' },
      producer: { connectionId: 'local', profile: 'reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting: productionMeeting, version: 1 }] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Conclude meeting/i })).toBeTruthy())

    // Click conclude without filling artifact form
    fireEvent.click(screen.getByRole('button', { name: /Conclude meeting/i }))

    await waitFor(() => {
      const alert = screen.getByRole('alert', { hidden: true })
      expect(alert.textContent).toContain('Fill in all artifact-binding fields correctly')
    })

    // Verify the PUT was never called — ordinary meeting was not created/modified.
    expect(rest).not.toHaveBeenCalledWith(expect.stringMatching(/^\/meetings\//), expect.anything())
  })

  it('zero regression — ordinary meeting conclude still works without artifact binding form', async () => {
    const concludedMeeting = { ...meeting, state: 'completed', decisions: [{ id: 'd1', text: 'Ship it', evidenceRefs: [] }], dissent: [], action_items: [] }
    const putSpy = vi.fn(async (path: string, _opts: unknown) => {
      if (path.startsWith('/meetings/')) { return { meeting: concludedMeeting, version: 2 } }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    const rest = vi.fn(async (path: string, opts?: unknown) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting, version: 1 }] } }
      if (opts) { return putSpy(path, opts) }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Conclude meeting/i })).toBeTruthy())

    // Ordinary meeting: no artifact binding fieldset, clicking conclude should attempt PUT.
    expect(screen.queryByRole('group', { name: /Artifact binding/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Conclude meeting/i }))

    // The PUT to conclude should be called (no validation gate blocks ordinary meetings).
    await waitFor(() => {
      expect(rest).toHaveBeenCalledWith(expect.stringMatching(/^\/meetings\//), expect.anything())
    })
  })
})

describe('PB4 – seat assignments shown in details view (C3)', () => {
  it('displays seat role badges in meeting details when seats are present', async () => {
    const meetingWithSeats = {
      ...meeting,
      // add a2a as a 3rd participant so we can assign it reviewer seat (C2: reviewer seat != producer)
      participants: [
        { connection: 'local', profile: 'chair' },
        { connection: 'local', profile: 'reviewer' },
        { connection: 'a2a', profile: 'agent-1' }
      ],
      orchestrator: { connectionId: 'local', profile: 'chair' },
      producer: { connectionId: 'local', profile: 'reviewer' },
      seats: [
        { bot: { connectionId: 'local', profile: 'chair' }, role: 'contributor', label: 'Lead author' },
        // C2: reviewer seat cannot be the producer — use a2a agent here
        { bot: { connectionId: 'a2a', profile: 'agent-1' }, role: 'reviewer', label: 'Code reviewer' }
      ]
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) { return { meetings: [{ meeting: meetingWithSeats, version: 1 }] } }
      throw new Error(`Unexpected REST call: ${path}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = screen.getByRole('dialog', { name: 'Meeting details' })

    await waitFor(() => {
      expect(details.textContent).toContain('Seats')
      expect(details.textContent).toContain('contributor')
      expect(details.textContent).toContain('Lead author')
      expect(details.textContent).toContain('reviewer')
      expect(details.textContent).toContain('Code reviewer')
    })
  })
})

