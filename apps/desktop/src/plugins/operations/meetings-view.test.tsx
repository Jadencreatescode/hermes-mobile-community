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
      contributions: [{
        evidence_refs: [],
        id: 'chair-r1',
        kind: 'pass',
        participant: { connection: 'local', profile: 'chair' },
        round: 1
      }],
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

      if (!record) {throw new Error(`Unexpected REST call: ${path}`)}
      writes.push(record)
      version += 1

      return { meeting: record, version }
    })

    requestProfile.mockImplementation(async (_route: unknown, method: string) => {
      if (method !== 'session.resume') {throw new Error(`Unexpected request: ${method}`)}

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

    await waitFor(() => expect(requestProfile).toHaveBeenCalledWith(
      { connectionId: 'local', mode: 'local', profile: 'reviewer', targetProfile: 'reviewer' },
      'session.resume',
      expect.objectContaining({ profile: 'reviewer', session_id: 'stored-reviewer', source: 'meeting' })
    ))
    expect(within(conversation).getByRole('status').textContent).toContain('Working')
    expect(within(conversation).getByText('You').closest('article')?.textContent).toContain('Check the release evidence.')
    expect(within(conversation).getByText('Review Bot', { selector: 'article p' }).closest('article')?.textContent).toContain('Evidence verified.')
    expect(conversation.textContent).toContain("Messages from this participant's meeting turn. Prompts run only in this meeting context.")

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
      if (method === 'prompt.submit') {return { ok: true }}
      if (method === 'session.resume') {
        resumes += 1

        return {
          messages: resumes >= 3
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

    await waitFor(() => expect(requestProfile).toHaveBeenCalledWith(
      { connectionId: 'local', mode: 'local', profile: 'reviewer', targetProfile: 'reviewer' },
      'prompt.submit',
      {
        queued: true,
        session_id: 'runtime-reviewer',
        text: '<hermes-meeting id="meeting-room-1">\nCheck the final release evidence.'
      }
    ))
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
    const deliveryWarning = 'Your prompt may have been submitted, but delivery could not be confirmed. It was not retried.'
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
      if (method === 'prompt.submit') {throw new Error('Connection dropped after submit.')}
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
    const chairResponse = new Promise(resolve => { resolveChair = resolve })
    const reviewerResponse = new Promise(resolve => { resolveReviewer = resolve })

    requestProfile.mockImplementation((route: { profile: string }) => route.profile === 'reviewer'
      ? reviewerResponse
      : chairResponse)
    unbind = bindOperationsApi(rest as never)

    render(<MeetingsView snapshot={snapshot} />)
    await screen.findByRole('region', { name: 'Bot meeting room' })
    const openChair = screen.getByRole('button', { name: 'Open Chair Bot meeting conversation' })

    fireEvent.click(screen.getByRole('button', { name: 'Open Review Bot meeting conversation' }))
    await waitFor(() => expect(requestProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'reviewer' }),
      'session.resume',
      expect.any(Object)
    ))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Review Bot' })).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review Bot' })).toBeNull())

    fireEvent.click(openChair)
    await waitFor(() => expect(requestProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'chair' }),
      'session.resume',
      expect.any(Object)
    ))
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

    const setup = screen.getByRole('dialog', { name: 'Set the meeting table' })
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
    expect(putBody?.record?.action_items?.[0]?.acceptanceCriteria).toBe('Verify the completed result.')
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
      contributions: [{
        ...meeting.contributions[0],
        participant: { connection: 'local', profile: 'chair' }
      }]
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
    const participantRequest = new Promise((_resolve, reject) => { rejectRequest = reject })

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
        started_at: Date.now() - (10 * 60 * 1000) - 1
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
