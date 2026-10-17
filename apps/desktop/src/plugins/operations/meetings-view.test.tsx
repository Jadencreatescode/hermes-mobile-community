import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  vi.useRealTimers()
  cleanup()
  unbind?.()
  unbind = undefined
  vi.restoreAllMocks()
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
  contributions: [
    {
      evidence_refs: [],
      id: 'review-r1',
      kind: 'speak',
      participant: { connection: 'local', profile: 'reviewer' },
      round: 1,
      text: 'Ship the visual room.'
    }
  ],
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
    if (method === 'operations.meetings.list') {
      return { meetings: [{ meeting, version: 1 }] }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
})

afterEach(cleanup)

describe('Meetings graphical room integration', () => {
  it('opens the latest durable meeting as a literal room with conversation-ready Bot seats', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)

    const room = await screen.findByRole('region', { name: 'Bot meeting room' })

    expect(room.getAttribute('data-room-scene')).not.toBeNull()
    expect(screen.queryByText('The council chamber is empty')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' })).toBeTruthy()
  })

  it('resumes a waiting participant turn through recovery instead of dropping it', async () => {
    const waitingMeeting = {
      ...meeting,
      contributions: [
        {
          evidence_refs: [],
          id: 'chair-r1',
          kind: 'pass',
          participant: { connection: 'local', profile: 'chair' },
          round: 1
        }
      ],
      pending: {
        before: 1,
        kind: 'clarify',
        participant: { connection: 'local', profile: 'reviewer' },
        reason: 'Participant requested clarification.',
        session: 'stored-reviewer'
      },
      max_rounds: 1,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' },
      state: 'waiting'
    }

    const writes: Array<Record<string, unknown>> = []
    let version = 1

    const rest = vi.fn(async (path: string, options?: { body?: { record?: Record<string, unknown> } }) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: waitingMeeting, version }] }
      }

      const record = options?.body?.record

      if (!record) {
        throw new Error(`Unexpected REST call: ${path}`)
      }
      writes.push(record)
      version += 1

      return { meeting: record, version }
    })

    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method !== 'session.resume') {
        throw new Error(`Unexpected request: ${method}`)
      }

      return {
        messages: [
          { content: 'Which release?', role: 'user' },
          { content: 'Use the verified candidate.', role: 'assistant' }
        ],
        running: false,
        session_id: 'stored-reviewer'
      }
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    const resume = await screen.findByRole('button', { name: 'Resume meeting' })

    fireEvent.click(resume)
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5_000 })

    expect(requestProfile.mock.calls.map(([, method]) => method)).toEqual(['session.resume'])
    expect(writes[0]).not.toHaveProperty('pending')
    expect(writes[0]).toMatchObject({ state: 'completed' })
  })

  it('opens a source-qualified conversation chooser from the table and a participant conversation directly from its desk', async () => {
    const chooserMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: chooserMeeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Open meeting conversations' }))

    const chooser = screen.getByRole('dialog', { name: 'Meeting conversations' })
    const choices = within(chooser).getAllByRole('button', { name: /meeting conversation$/ })

    expect(choices.map(choice => choice.getAttribute('aria-label'))).toEqual([
      'Open Chair Bot meeting conversation',
      'Open Review Bot meeting conversation'
    ])
    expect(choices[0]?.textContent).toContain('Chair Bot')
    expect(choices[0]?.textContent).toContain('local::chair')
    expect(choices[0]?.textContent).toContain('Chair')
    expect(choices[0]?.textContent).toContain('No meeting turn yet')
    expect(choices[1]?.textContent).toContain('Review Bot')
    expect(choices[1]?.textContent).toContain('local::reviewer')
    expect(choices[1]?.textContent).toContain('Conversation ready')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Meeting conversations' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))

    expect(screen.getByRole('dialog', { name: 'Review Bot' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Meeting conversations' })).toBeNull()
  })

  it('loads a native participant transcript with public read-only labels and status', async () => {
    const nativeMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: nativeMeeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method === 'session.resume') {
        return {
          messages: [
            { role: 'user', content: '<hermes-meeting id="meeting-room-1">\nCheck the release evidence.' },
            { role: 'assistant', content: 'Evidence verified.' }
          ],
          running: true,
          session_id: 'runtime-reviewer'
        }
      }

      throw new Error(`Unexpected request: ${method}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))

    const conversation = screen.getByRole('dialog', { name: 'Review Bot' })

    await waitFor(() =>
      expect(requestProfile).toHaveBeenCalledWith(
        { connectionId: 'local', mode: 'local', profile: 'reviewer', targetProfile: 'reviewer' },
        'session.resume',
        expect.objectContaining({ profile: 'reviewer', session_id: 'stored-reviewer', source: 'meeting' })
      )
    )
    expect(within(conversation).getByRole('status').textContent).toContain('Working')
    expect(within(conversation).getByText('You').closest('article')?.textContent).toContain(
      'Check the release evidence.'
    )
    expect(
      within(conversation).getByText('Review Bot', { selector: 'article p' }).closest('article')?.textContent
    ).toContain('Evidence verified.')
    expect(conversation.textContent).toContain(
      "Messages from this participant's meeting turn. Prompts run only in this meeting context."
    )
  })

  it('sends a marked native meeting prompt once and replaces the transcript after confirmation', async () => {
    const nativeMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' }
    }

    const prompt = '  Check the final release evidence.  '
    const requestIdentity = '00000000-0000-4000-8000-000000000001'
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(requestIdentity)

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: nativeMeeting, version: 1 }] }
      }

      if (path === '/meetings/meeting-room-1') {
        return { meeting: nativeMeeting, version: 2 }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    let resumes = 0

    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method === 'prompt.submit') {
        return { ok: true }
      }

      if (method === 'session.resume') {
        resumes += 1

        return {
          messages:
            resumes >= 3
              ? [
                  { role: 'assistant', content: 'Earlier evidence.' },
                  { role: 'user', content: '<hermes-meeting id="meeting-room-1">\nCheck the final release evidence.' },
                  { role: 'assistant', content: 'Final evidence verified.' }
                ]
              : [{ role: 'assistant', content: 'Earlier evidence.' }],
          running: false,
          session_id: 'runtime-reviewer'
        }
      }

      throw new Error(`Unexpected request: ${method}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))

    const conversation = screen.getByRole('dialog', { name: 'Review Bot' })
    const composer = within(conversation).getByLabelText('Message Review Bot in this meeting') as HTMLTextAreaElement

    await waitFor(() => expect(within(conversation).getByText('Earlier evidence.')).toBeTruthy())
    fireEvent.change(composer, { target: { value: prompt } })
    expect(within(conversation).getByText(`${prompt.length} / 8000`)).toBeTruthy()
    fireEvent.click(within(conversation).getByRole('button', { name: 'Send meeting prompt' }))

    await waitFor(() =>
      expect(requestProfile).toHaveBeenCalledWith(
        { connectionId: 'local', mode: 'local', profile: 'reviewer', targetProfile: 'reviewer' },
        'prompt.submit',
        {
          queued: true,
          session_id: 'runtime-reviewer',
          text: '<hermes-meeting id="meeting-room-1">\nCheck the final release evidence.'
        }
      )
    )
    const submit = requestProfile.mock.calls.find(([, method]) => method === 'prompt.submit')

    expect(submit?.[2].text.match(/<hermes-meeting id="meeting-room-1">/g)).toHaveLength(1)
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(await within(conversation).findByText('Final evidence verified.')).toBeTruthy()
    expect(composer.value).toBe('')
    expect(within(conversation).queryByRole('alert')).toBeNull()
  })

  it('warns after ambiguous native delivery without clearing or retrying the prompt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const nativeMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' }
    }

    const typedPrompt = '  Decide whether to send this again.  '
    const deliveryWarning =
      'Your prompt may have been submitted, but delivery could not be confirmed. It was not retried.'

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: nativeMeeting, version: 1 }] }
      }

      if (path === '/meetings/meeting-room-1') {
        return { meeting: nativeMeeting, version: 2 }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method === 'prompt.submit') {
        throw new Error('Connection dropped after submit.')
      }

      if (method === 'session.resume') {
        return {
          messages: [{ role: 'assistant', content: 'Earlier evidence.' }],
          running: false,
          session_id: 'runtime-reviewer'
        }
      }

      throw new Error(`Unexpected request: ${method}`)
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))

    const conversation = screen.getByRole('dialog', { name: 'Review Bot' })
    const composer = within(conversation).getByLabelText('Message Review Bot in this meeting') as HTMLTextAreaElement

    await waitFor(() => expect(within(conversation).getByText('Earlier evidence.')).toBeTruthy())
    fireEvent.change(composer, { target: { value: typedPrompt } })
    fireEvent.click(within(conversation).getByRole('button', { name: 'Send meeting prompt' }))

    expect((await within(conversation).findByRole('alert')).textContent).toContain(deliveryWarning)
    expect(composer.value).toBe(typedPrompt)
    expect(screen.getByRole('dialog', { name: 'Review Bot' })).toBeTruthy()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(requestProfile.mock.calls.filter(([, method]) => method === 'prompt.submit')).toHaveLength(1)
    expect(composer.value).toBe(typedPrompt)
    expect(screen.getByRole('dialog', { name: 'Review Bot' })).toBeTruthy()
  })

  it('shows a completed meeting transcript without a prompt composer', async () => {
    const completedMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' },
      state: 'completed'
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: completedMeeting, version: 2 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    requestProfile.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'The completed recommendation.' }],
      running: false,
      session_id: 'runtime-reviewer'
    })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))

    const conversation = screen.getByRole('dialog', { name: 'Review Bot' })

    expect(await within(conversation).findByText('The completed recommendation.')).toBeTruthy()
    expect(within(conversation).queryByLabelText('Message Review Bot in this meeting')).toBeNull()
    expect(within(conversation).queryByRole('button', { name: 'Send meeting prompt' })).toBeNull()
  })

  it('polls an open participant conversation every 2500ms and stops after close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const nativeMeeting = {
      ...meeting,
      runner_sessions: { 'local::reviewer': 'stored-reviewer' }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: nativeMeeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    requestProfile.mockResolvedValue({ messages: [], running: false, session_id: 'runtime-reviewer' })
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))
    await waitFor(() => expect(requestProfile).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(2_500)
    expect(requestProfile).toHaveBeenCalledTimes(2)

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Review Bot' })).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review Bot' })).toBeNull())
    requestProfile.mockClear()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('ignores a deferred response from a closed participant after another participant opens', async () => {
    const nativeMeeting = {
      ...meeting,
      runner_sessions: {
        'local::chair': 'stored-chair',
        'local::reviewer': 'stored-reviewer'
      }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: nativeMeeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    let resolveChair!: (value: unknown) => void
    let resolveReviewer!: (value: unknown) => void
    const chairResponse = new Promise(resolve => {
      resolveChair = resolve
    })
    const reviewerResponse = new Promise(resolve => {
      resolveReviewer = resolve
    })

    requestProfile.mockImplementation((route: { profile: string }) =>
      route.profile === 'reviewer' ? reviewerResponse : chairResponse
    )
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    const openChair = screen.getByRole('button', { name: 'Open Chair Bot meeting conversation' })

    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))
    await waitFor(() =>
      expect(requestProfile).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'reviewer' }),
        'session.resume',
        expect.any(Object)
      )
    )
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Review Bot' })).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review Bot' })).toBeNull())

    fireEvent.click(openChair)
    await waitFor(() =>
      expect(requestProfile).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'chair' }),
        'session.resume',
        expect.any(Object)
      )
    )
    await act(async () => {
      resolveChair({
        messages: [{ role: 'assistant', content: 'Current chair message.' }],
        running: false,
        session_id: 'runtime-chair'
      })
      await chairResponse
    })
    expect(await screen.findByText('Current chair message.')).toBeTruthy()

    await act(async () => {
      resolveReviewer({
        messages: [{ role: 'assistant', content: 'Stale reviewer message.' }],
        running: true,
        session_id: 'runtime-reviewer'
      })
      await reviewerResponse
    })

    const conversation = screen.getByRole('dialog', { name: 'Chair Bot' })

    expect(within(conversation).getByText('Current chair message.')).toBeTruthy()
    expect(within(conversation).getByRole('status').textContent).toContain('Ready')
    expect(within(conversation).queryByText('Stale reviewer message.')).toBeNull()
    expect(within(conversation).queryByRole('alert')).toBeNull()
  })

  it('offers only runnable public meeting sources in snapshot order', async () => {
    const unsupportedAgents: OperationsAgentModel[] = [
      {
        ...reviewer,
        displayName: 'Generic Connected Bot',
        id: 'connected::generic',
        profile: 'generic',
        sourceId: 'provider',
        sourceKind: 'connected',
        sourceLabel: 'Provider',
        state: 'idle'
      },
      {
        ...a2aAgent,
        displayName: 'Pending A2A Bot',
        id: 'a2a::pending',
        profile: 'pending',
        state: 'waiting'
      },
      {
        ...a2aAgent,
        displayName: 'Degraded A2A Bot',
        id: 'a2a::degraded',
        profile: 'degraded',
        state: 'unknown'
      },
      {
        ...a2aAgent,
        displayName: 'A2A Impostor Bot',
        id: 'connected::a2a-impostor',
        profile: 'a2a-impostor',
        sourceKind: 'connected'
      },
      {
        ...reviewer,
        displayName: 'Unknown Source Bot',
        id: 'mystery::unknown',
        profile: 'unknown',
        sourceId: 'mystery',
        sourceKind: 'mystery',
        sourceLabel: 'Mystery',
        state: 'idle'
      }
    ]

    const eligibilitySnapshot: OperationsSnapshot = {
      ...snapshot,
      agents: [chair, unsupportedAgents[0], reviewer, unsupportedAgents[1], a2aAgent, ...unsupportedAgents.slice(2)]
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={eligibilitySnapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))

    const setup = screen.getByRole('dialog', { name: 'Make a Meeting' })
    const options = within(setup).getAllByRole('checkbox')

    expect(options.map(option => option.parentElement?.textContent)).toEqual([
      'Chair Bot · This device',
      'Review Bot · This device',
      'A2A Harness Bot · A2A Harness'
    ])

    for (const agent of unsupportedAgents) {
      expect(within(setup).queryByText(new RegExp(agent.displayName))).toBeNull()
    }
  })

  it('uses public neutral acceptance criteria when concluding with an action item', async () => {
    let putBody: { record?: { action_items?: Array<{ acceptanceCriteria?: string }> } } | undefined

    const rest = vi.fn(async (path: string, options?: { body?: typeof putBody }) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }

      if (path === '/meetings/meeting-room-1' && options?.body?.record) {
        putBody = options.body

        return { meeting: options.body.record, version: 2 }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Meeting action item' }), {
      target: { value: 'Publish the verified release.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Conclude meeting' }))

    await waitFor(() => expect(putBody).toBeDefined())
    expect((putBody?.record?.action_items?.[0] as Record<string, unknown> | undefined)?.acceptance_criteria).toBe(
      'Verify the completed result.'
    )
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
    expect(screen.getByRole('dialog', { name: 'Make a Meeting' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Agenda and decision required')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = screen.getByRole('dialog', { name: 'Meeting details' })
    expect(details.textContent).toContain('Choose the verified release plan.')
    expect(details.textContent).toContain('Ship the visual room.')
  })

  it('restores fresh durable round progress and the active source-qualified participant after reload', async () => {
    const freshMeeting = {
      ...meeting,
      round_run: {
        participant: { connection: 'local', profile: 'reviewer' },
        round: 1,
        started_at: Date.now()
      }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: freshMeeting, version: 2 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    const room = await screen.findByRole('region', { name: 'Bot meeting room' })
    const reviewerDesk = screen.getByRole('button', { name: 'Open Review Bot meeting conversation' })
    const runRound = screen.getByRole('button', { name: 'Run meeting round' }) as HTMLButtonElement

    expect(reviewerDesk.textContent).toContain('Thinking')
    expect(within(room).getByText('Meeting in progress')).toBeTruthy()
    expect(runRound.disabled).toBe(true)
    expect(screen.getByText('Meeting round in progress').className).toContain('sr-only')
  })

  it('shows the live participant before network work and clears only that cue after failure', async () => {
    const liveMeeting = {
      ...meeting,
      contributions: [
        {
          ...meeting.contributions[0],
          participant: { connection: 'local', profile: 'chair' }
        }
      ]
    }

    const rest = vi.fn(async (path: string, options?: { body?: { record?: unknown } }) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: liveMeeting, version: 1 }] }
      }

      if (path === '/meetings/meeting-room-1' && options?.body?.record) {
        return { meeting: options.body.record, version: 2 }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    let rejectRequest!: (cause: Error) => void
    const participantRequest = new Promise((_resolve, reject) => {
      rejectRequest = reject
    })

    requestProfile.mockReturnValue(participantRequest)
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    fireEvent.click(screen.getByRole('button', { name: 'Run meeting round' }))

    const reviewerDesk = screen.getByRole('button', { name: 'Open Review Bot meeting conversation' })

    await waitFor(() => expect(reviewerDesk.textContent).toContain('Thinking'))
    expect(screen.getByText('Meeting round in progress').className).toContain('sr-only')
    expect(requestProfile).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'local', profile: 'reviewer' }),
      'session.create',
      expect.any(Object)
    )

    await act(async () => {
      rejectRequest(new Error('Participant request failed'))
      await participantRequest.catch(() => undefined)
    })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Participant request failed'))
    expect(reviewerDesk.textContent).not.toContain('Thinking')
    expect(screen.queryByText('Meeting round in progress')).toBeNull()
  })

  it('ignores a stale durable round marker', async () => {
    const staleMeeting = {
      ...meeting,
      round_run: {
        participant: { connection: 'local', profile: 'reviewer' },
        round: 1,
        started_at: Date.now() - 10 * 60 * 1000 - 1
      }
    }

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: staleMeeting, version: 2 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    const reviewerDesk = screen.getByRole('button', { name: 'Open Review Bot meeting conversation' })
    const runRound = screen.getByRole('button', { name: 'Run meeting round' }) as HTMLButtonElement

    expect(reviewerDesk.textContent).not.toContain('Thinking')
    expect(screen.queryByText('Meeting round in progress')).toBeNull()
    expect(runRound.disabled).toBe(false)
  })

  it('does not add native title tooltips to buttons', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }

      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    const { container } = render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    expect(container.querySelectorAll('button[title]')).toHaveLength(0)
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
      contributions: [
        {
          evidence_refs: [],
          id: 'agent-r1',
          kind: 'speak',
          participant: { connection: 'a2a', profile: 'agent-1' },
          round: 1,
          text: 'A2A agent contribution.'
        }
      ]
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

    expect(screen.getByRole('button', { name: 'Open Chair Bot meeting conversation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open A2A Harness Bot meeting conversation' })).toBeTruthy()
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
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    expect(screen.getByRole('dialog', { name: 'Make a Meeting' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))

    // Check Chair Bot — role selector should appear
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check Chair Bot

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy()
    })
  })

  it('seat label input appears only after a non-empty role is chosen', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check Chair Bot

    await waitFor(() => expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy())

    // Before choosing a role, label input should NOT be present
    expect(screen.queryByPlaceholderText('Seat label')).toBeNull()

    // Choose a role
    fireEvent.change(screen.getByRole('combobox', { name: /Role for Chair Bot/i }), {
      target: { value: 'contributor' }
    })

    await waitFor(() => expect(screen.getByPlaceholderText('Seat label')).toBeTruthy())
  })

  it('role selector disappears when participant is unchecked', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))
    const allCheckboxes = screen.getAllByRole('checkbox')
    fireEvent.click(allCheckboxes[0]) // check
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Role for Chair Bot/i })).toBeTruthy())

    fireEvent.click(allCheckboxes[0]) // uncheck
    await waitFor(() => expect(screen.queryByRole('combobox', { name: /Role for Chair Bot/i })).toBeNull())
  })
})

const productionMeetingWire = {
  ...meeting,
  state: 'running',
  participants: [
    { connection: 'local', profile: 'chair' },
    { connection: 'local', profile: 'reviewer' },
    { connection: 'a2a', profile: 'agent-1' }
  ],
  contributions: [],
  current_round: 1,
  orchestrator: { connection: 'local', profile: 'chair' },
  producer: { connection: 'local', profile: 'reviewer' },
  seats: [
    { bot: { connection: 'local', profile: 'chair' }, role: 'specialist', label: 'Orchestrator' },
    { bot: { connection: 'local', profile: 'reviewer' }, role: 'contributor', label: 'Producer' },
    { bot: { connection: 'a2a', profile: 'agent-1' }, role: 'reviewer', label: 'Independent reviewer' }
  ],
  product_kind: 'document',
  output_title: 'Onboarding guide',
  acceptance_statement: 'A reviewer confirms every onboarding step is reproducible.',
  production_stage: 'production_ready'
}

const outputWire = {
  output_id: 'mout_1',
  meeting_id: 'meeting-room-1',
  kind: 'deliverable_package_v1',
  product_kind: 'document',
  title: 'Onboarding guide',
  summary: 'A reviewer confirms every onboarding step is reproducible.',
  brief: 'Produce the guide.',
  brief_hash: 'd'.repeat(64),
  producer: { connection: 'local', profile: 'reviewer' },
  source_meeting_version: 1,
  current_artifact_version: 1,
  verified_artifact_version: 1,
  approved_artifact_version: 0,
  state: 'verified',
  version: 4,
  findings: [],
  created_at: 1,
  updated_at: 2
}

const outputVersionWire = {
  output_id: 'mout_1',
  artifact_version: 1,
  schema_version: 1,
  runtime_version: '1',
  game_sha256: 'a'.repeat(64),
  manifest_sha256: 'b'.repeat(64),
  zip_sha256: 'c'.repeat(64),
  total_byte_size: 31,
  parent_artifact_version: null,
  manifest: {
    product_kind: 'document',
    title: 'Onboarding guide',
    summary: 'A one-page guide.',
    primary_file: 'index.txt',
    files: [
      {
        path: 'index.txt',
        media_type: 'text/plain',
        role: 'primary',
        preview_policy: 'text',
        byte_size: 31,
        sha256: 'a'.repeat(64)
      }
    ]
  },
  created_at: 1
}

describe('production brief collection at creation', () => {
  async function openCreateDialog() {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')
    fireEvent.click(screen.getByRole('button', { name: 'New meeting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Production' }))

    return rest
  }

  it('opens a neutral Production or Conclusion choice from every in-page entry', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)
    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('The council chamber is empty')

    for (const entry of ['New meeting', 'Set the table']) {
      fireEvent.click(screen.getByRole('button', { name: entry }))
      const dialog = screen.getByRole('dialog', { name: 'Make a Meeting' })
      expect(within(dialog).getByRole('button', { name: 'Production' }).getAttribute('aria-pressed')).toBe('false')
      expect(within(dialog).getByRole('button', { name: 'Conclusion' }).getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel setup' }))
    }
  })

  it('opens a neutral Production or Conclusion choice when requested from the Control Room', async () => {
    const onCreateRequestHandled = vi.fn()

    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)
    render(<MeetingsView createRequested onCreateRequestHandled={onCreateRequestHandled} snapshot={snapshot} />)

    const dialog = await screen.findByRole('dialog', { name: 'Make a Meeting' })
    const production = within(dialog).getByRole('button', { name: 'Production' })
    const conclusion = within(dialog).getByRole('button', { name: 'Conclusion' })

    expect(production.getAttribute('aria-pressed')).toBe('false')
    expect(conclusion.getAttribute('aria-pressed')).toBe('false')
    expect(onCreateRequestHandled).toHaveBeenCalledOnce()

    fireEvent.click(production)
    expect(production.getAttribute('aria-pressed')).toBe('true')
    expect(conclusion.getAttribute('aria-pressed')).toBe('false')
  })

  it('hides the production brief until three participants are chosen', async () => {
    await openCreateDialog()

    expect(screen.queryByRole('group', { name: /Production roles/i })).toBeNull()

    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    expect(screen.queryByRole('group', { name: /Production roles/i })).toBeNull()

    fireEvent.click(boxes[2])
    await waitFor(() => expect(screen.getByRole('group', { name: /Production roles/i })).toBeTruthy())
  })

  it('collects product kind, output title, and acceptance statement', async () => {
    await openCreateDialog()
    const boxes = screen.getAllByRole('checkbox')
    boxes.slice(0, 3).forEach(box => fireEvent.click(box))

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Product kind' })).toBeTruthy())

    const kinds = Array.from(screen.getByRole('combobox', { name: 'Product kind' }).querySelectorAll('option')).map(
      option => (option as HTMLOptionElement).value
    )

    expect(kinds).toContain('document')
    expect(kinds).toContain('interactive_web_app')
    expect(screen.getByLabelText('Output title')).toBeTruthy()
    expect(screen.getByLabelText('Acceptance statement')).toBeTruthy()
  })

  it('never offers a production stage, hash, or approver input', async () => {
    await openCreateDialog()
    const boxes = screen.getAllByRole('checkbox')
    boxes.slice(0, 3).forEach(box => fireEvent.click(box))

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Product kind' })).toBeTruthy())

    for (const label of [
      /production stage/i,
      /game sha/i,
      /manifest sha/i,
      /zip sha/i,
      /approved by/i,
      /approved at/i,
      /output id/i
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
  })

  it('refuses a partial production bundle without writing anything', async () => {
    const rest = await openCreateDialog()
    const boxes = screen.getAllByRole('checkbox')
    boxes.slice(0, 3).forEach(box => fireEvent.click(box))

    fireEvent.change(screen.getByPlaceholderText('Meeting title'), { target: { value: 'Prod test' } })
    fireEvent.change(screen.getByPlaceholderText('Agenda and decision required'), { target: { value: 'Agenda here' } })

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Orchestrator' })).toBeTruthy())

    const orchestrator = screen.getByRole('combobox', { name: 'Orchestrator' })

    const option = Array.from(orchestrator.querySelectorAll('option')).find(
      row => (row as HTMLOptionElement).value !== ''
    ) as HTMLOptionElement

    fireEvent.change(orchestrator, { target: { value: option.value } })
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await waitFor(() => {
      expect(screen.getByRole('alert', { hidden: true }).textContent).toContain(
        'needs both an orchestrator and a producer'
      )
    })
    expect(rest.mock.calls.every(([path]) => String(path).startsWith('/meetings?'))).toBe(true)
  })

  it('requires an independent reviewer seat before creating a production meeting', async () => {
    const rest = await openCreateDialog()
    const boxes = screen.getAllByRole('checkbox')
    boxes.slice(0, 3).forEach(box => fireEvent.click(box))

    fireEvent.change(screen.getByPlaceholderText('Meeting title'), { target: { value: 'Prod test' } })
    fireEvent.change(screen.getByPlaceholderText('Agenda and decision required'), { target: { value: 'Agenda here' } })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Orchestrator' })).toBeTruthy())

    const orchestrator = screen.getByRole('combobox', { name: 'Orchestrator' })

    const orchestratorValues = Array.from(orchestrator.querySelectorAll('option'))
      .map(row => (row as HTMLOptionElement).value)
      .filter(Boolean)

    fireEvent.change(orchestrator, { target: { value: orchestratorValues[0] } })

    const producer = screen.getByRole('combobox', { name: 'Producer' })

    const producerValues = Array.from(producer.querySelectorAll('option'))
      .map(row => (row as HTMLOptionElement).value)
      .filter(Boolean)

    fireEvent.change(producer, { target: { value: producerValues[0] } })

    fireEvent.change(screen.getByRole('combobox', { name: 'Product kind' }), { target: { value: 'document' } })
    fireEvent.change(screen.getByLabelText('Output title'), { target: { value: 'Onboarding guide' } })
    fireEvent.change(screen.getByLabelText('Acceptance statement'), {
      target: { value: 'A reviewer confirms every step.' }
    })

    // Every participant is seated, but no seat is an independent reviewer.
    for (const name of ['Chair Bot', 'Review Bot', 'A2A Harness Bot']) {
      fireEvent.change(screen.getByRole('combobox', { name: new RegExp(`Role for ${name}`, 'i') }), {
        target: { value: 'contributor' }
      })
    }

    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))

    await waitFor(() => {
      expect(screen.getByRole('alert', { hidden: true }).textContent).toContain(
        'reviewer seat that is neither the orchestrator nor the producer'
      )
    })
    expect(rest.mock.calls.every(([path]) => String(path).startsWith('/meetings?'))).toBe(true)
  })
})

describe('production meeting completion is approval only', () => {
  function bindProduction(outputs: unknown[] = []) {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: productionMeetingWire, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return { outputs }
      }

      if (path.startsWith('/meetings/')) {
        return { meeting: productionMeetingWire, version: 1 }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    return rest
  }

  it('offers no conclude form and no artifact-binding fields for a production meeting', async () => {
    bindProduction()

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = await screen.findByRole('dialog', { name: 'Meeting details' })

    await waitFor(() => expect(details.textContent).toContain('Production completion'))
    expect(screen.queryByRole('button', { name: /Conclude meeting/i })).toBeNull()
    expect(screen.queryByRole('group', { name: /Artifact binding/i })).toBeNull()

    for (const label of [/output id/i, /game sha/i, /manifest sha/i, /zip sha/i, /approved by/i, /approved at/i]) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }

    expect(details.textContent).toContain('document')
    expect(details.textContent).toContain('Onboarding guide')
  })

  it('keeps the conclude form for an ordinary conclusion meeting', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return { outputs: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Conclude meeting/i })).toBeTruthy())
    expect(screen.queryByRole('group', { name: /Artifact binding/i })).toBeNull()
    // An ordinary meeting never asks the output lifecycle for anything.
    expect(rest.mock.calls.every(([path]) => !String(path).endsWith('/outputs?limit=20'))).toBe(true)
  })

  it('mounts the deliverable package panel inside the existing meeting room', async () => {
    // The real list route answers with output + eligibility only, so the view
    // must fetch the selected output's DETAIL to render versions and reviews.
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: productionMeetingWire, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return {
          meeting_id: 'meeting-room-1',
          outputs: [
            {
              output: outputWire,
              eligibility: { approve: true, download: true, preview: true }
            }
          ]
        }
      }

      if (path === '/meeting-outputs/mout_1') {
        return {
          output: outputWire,
          eligibility: { approve: true, download: true, preview: true },
          versions: [outputVersionWire],
          reviews: []
        }
      }

      if (path.startsWith('/meetings/')) {
        return { meeting: productionMeetingWire, version: 1 }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    const panel = await screen.findByTestId('deliverable-package-output')

    expect(screen.getByTestId('meeting-room-output').contains(panel)).toBe(true)
    expect(screen.getByTestId('output-state').textContent).toBe('Verified')
    expect(panel.textContent).toContain('game_sha256')
    expect(screen.getByRole('button', { name: /Approve this artifact version/ })).toBeTruthy()
  })

  it('freezes the production brief through the authenticated brief route', async () => {
    const briefed = { ...productionMeetingWire, production_stage: 'briefing' }

    const rest = vi.fn(async (path: string, options?: { body?: unknown }) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: briefed, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return { outputs: [] }
      }

      if (path.endsWith('/production-brief')) {
        return {
          meeting_version: 3,
          brief_hash: 'd'.repeat(64),
          production_stage: 'production_ready',
          acceptance_statement: briefed.acceptance_statement,
          evidence_refs: []
        }
      }

      if (path.startsWith('/meetings/')) {
        return { meeting: briefed, version: 1 }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.change(screen.getByLabelText('Production brief'), {
      target: { value: 'Produce a one-page onboarding guide.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Freeze the production brief' }))

    await waitFor(() => {
      expect(rest.mock.calls.some(([path]) => String(path).endsWith('/production-brief'))).toBe(true)
    })

    const call = rest.mock.calls.find(([path]) => String(path).endsWith('/production-brief'))!
    expect(call[0]).toBe('/meetings/meeting-room-1/production-brief')
    expect((call[1] as { body: Record<string, unknown> }).body).toEqual({
      expected_version: 1,
      brief: 'Produce a one-page onboarding guide.',
      evidence_refs: []
    })
    // The freeze is replay-safe for the exact meeting version it saw.
    expect((call[1] as { headers: Record<string, string> }).headers).toEqual({
      'Idempotency-Key': 'brief-meeting-room-1-1'
    })
  })
})

describe('the produce action for a production_ready meeting', () => {
  const remoteProducerWire = {
    ...productionMeetingWire,
    participants: [
      { connection: 'local', profile: 'chair' },
      { connection: 'remote-1', profile: 'reviewer' },
      { connection: 'a2a', profile: 'agent-1' }
    ],
    producer: { connection: 'remote-1', profile: 'reviewer' },
    seats: [
      { bot: { connection: 'local', profile: 'chair' }, role: 'specialist', label: 'Orchestrator' },
      { bot: { connection: 'remote-1', profile: 'reviewer' }, role: 'contributor', label: 'Producer' },
      { bot: { connection: 'a2a', profile: 'agent-1' }, role: 'reviewer', label: 'Independent reviewer' }
    ]
  }

  it('renders Produce with zero outputs and drives the real dispatch route', async () => {
    const paths: string[] = []

    const rest = vi.fn(async (path: string, _init?: { body?: unknown; headers?: Record<string, string> }) => {
      paths.push(path)

      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: productionMeetingWire, version: 1 }] }
      }

      // The real list response: output + eligibility only, no versions/reviews.
      if (path.endsWith('/outputs?limit=20')) {
        return { outputs: [] }
      }

      if (path.endsWith('/production-runs')) {
        return {
          run_id: 'mrun_1',
          output_id: 'mout_1',
          kind: 'production',
          meeting_id: 'meeting-room-1',
          meeting_version: 2,
          parent_artifact_version: null,
          cwd: '/server/owned/workspaces/mrun_1'
        }
      }

      if (path.endsWith('/claim')) {
        return {
          run_id: 'mrun_1',
          output_id: 'mout_1',
          kind: 'production',
          session_id: 'stored-session-1',
          claim: { claim_id: 'mclaim_1', renewals: 0, expires_at: 9 },
          producer: { connection: 'local', profile: 'reviewer' },
          workspace: { cwd: '/server/owned/workspaces/mrun_1' },
          collection_claim: 'collection-claim-token-value',
          brief: 'Produce the guide.',
          brief_hash: 'd'.repeat(64),
          acceptance_statement: 'A reviewer confirms every step.',
          parent_artifact_version: null
        }
      }

      if (path.endsWith('/collect')) {
        return {
          receipt: {
            run_id: 'mrun_1',
            output_id: 'mout_1',
            artifact_version: 1,
            parent_artifact_version: null,
            game_sha256: 'a'.repeat(64),
            manifest_sha256: 'b'.repeat(64),
            zip_sha256: 'c'.repeat(64),
            total_byte_size: 31,
            collected_at: 4
          },
          output: outputWire,
          eligibility: { review: true, preview: true, download: true }
        }
      }

      // The runner reads the authoritative brief back from the output.
      if (path === '/meeting-outputs/mout_1') {
        return { output: outputWire, eligibility: { review: true }, versions: [], reviews: [] }
      }

      if (path.startsWith('/meetings/')) {
        return { meeting: productionMeetingWire, version: 1 }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    const dispatched: string[] = []
    const history: Array<{ content: string; role: string }> = []
    requestProfile.mockImplementation(async (_route: unknown, method: string, params?: Record<string, unknown>) => {
      dispatched.push(method)

      if (method === 'session.create') {
        return { session_id: 'runtime-session-1', stored_session_id: 'stored-session-1' }
      }

      if (method === 'prompt.submit') {
        // The producer writes its package and answers once.
        history.push({ content: String(params?.text ?? ''), role: 'user' })
        history.push({ content: 'Wrote output/deliverable.json.', role: 'assistant' })

        return { ok: true }
      }

      return {
        session_id: 'runtime-session-1',
        inflight: false,
        running: false,
        messages: [...history]
      }
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    // No artifact exists yet, so the package panel is not mounted — but the
    // produce control is, because the stage says the meeting is ready.
    expect(screen.queryByTestId('deliverable-package-output')).toBeNull()
    const produce = await screen.findByRole('button', { name: 'Produce the deliverable' })

    fireEvent.click(produce)

    await waitFor(() => expect(paths.some(path => path.endsWith('/collect'))).toBe(true), { timeout: 10_000 })

    const created = rest.mock.calls.find(([path]) => String(path).endsWith('/production-runs'))!

    expect(created[0]).toBe('/meetings/meeting-room-1/production-runs')
    // The run opens with a bounded PROVISIONAL reference: the real session id
    // cannot exist yet, because creating it needs the cwd this call mints.
    expect((created[1] as { body: Record<string, unknown> }).body).toEqual({
      expected_version: 1,
      producer_session_id: 'provisional-production-meeting-room-1',
      submission_id: 'submission-meeting-room-1-1'
    })

    // The claim carried the ACTUAL session id, and it happened before the prompt.
    const claim = rest.mock.calls.find(([path]) => String(path).endsWith('/claim'))!

    expect((claim[1] as { body: Record<string, unknown> }).body).toEqual({
      request_id: 'dispatch-mrun_1',
      session_id: 'stored-session-1'
    })
    expect(dispatched.indexOf('session.create')).toBeLessThan(dispatched.indexOf('prompt.submit'))
    // The claim is taken before the prompt, with the real session id.
    expect(paths.indexOf('/meeting-output-runs/mrun_1/claim')).toBeGreaterThanOrEqual(0)
    expect(dispatched.filter(method => method === 'prompt.submit')).toHaveLength(1)

    // The producer session was confined to the server-assigned cwd.
    const params = requestProfile.mock.calls.find(call => call[1] === 'session.create')?.[2] as Record<string, unknown>

    expect(params.cwd).toBe('/server/owned/workspaces/mrun_1')
    expect(params.enabled_toolsets).toEqual(['clarify', 'file'])

    // Collecting refreshes meetings AND the output list.
    await waitFor(() => {
      const after = paths.slice(paths.findIndex(path => path.endsWith('/collect')))

      expect(after.some(path => path.startsWith('/meetings?'))).toBe(true)
      expect(after.some(path => path.endsWith('/outputs?limit=20'))).toBe(true)
    })
  })

  it('shows a remote producer as visibly ineligible instead of offering Produce', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: remoteProducerWire, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return { outputs: [] }
      }

      if (path.startsWith('/meetings/')) {
        return { meeting: remoteProducerWire, version: 1 }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(
      <MeetingsView
        snapshot={{
          ...snapshot,
          sources: [
            ...snapshot.sources,
            { id: 'remote-1', kind: 'remote', label: 'Remote host', reachable: true, status: 'online' }
          ]
        }}
      />
    )
    await screen.findByRole('region', { name: 'Bot meeting room' })

    const notice = await screen.findByTestId('producer-ineligible')

    expect(notice.textContent).toContain('Only a producer Bot on this device')
    expect(notice.textContent).toContain('remote Bot')
    expect(screen.queryByRole('button', { name: 'Produce the deliverable' })).toBeNull()
    // Nothing was dispatched and no run was created.
    expect(requestProfile.mock.calls.every(call => call[0] === 'operations.meetings.list')).toBe(true)
    expect(rest.mock.calls.every(([path]) => !String(path).endsWith('/production-runs'))).toBe(true)
  })
})

describe('seat assignments shown in details view', () => {
  it('displays seat role badges for every seated participant', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [{ meeting: productionMeetingWire, version: 1 }] }
      }

      if (path.endsWith('/outputs?limit=20')) {
        return { outputs: [] }
      }
      throw new Error(`Unexpected REST call: ${path}`)
    })

    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })

    fireEvent.click(screen.getByRole('button', { name: 'Meeting details' }))
    const details = screen.getByRole('dialog', { name: 'Meeting details' })

    await waitFor(() => {
      expect(details.textContent).toContain('Seats')
      expect(details.textContent).toContain('specialist')
      expect(details.textContent).toContain('Orchestrator')
      expect(details.textContent).toContain('reviewer')
      expect(details.textContent).toContain('Independent reviewer')
    })
  })
})
