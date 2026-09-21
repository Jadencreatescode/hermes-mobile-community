import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import {
  convertMeetingActions,
  createMeetingDraft,
  getMeetingParticipantConversation,
  injectMeetingParticipantPrompt,
  isMeetingRoundRunFresh,
  listMeetings,
  MEETING_ROUND_RUN_LEASE_MS,
  meetingFromWire,
  type MeetingRecord,
  meetingToWire,
  persistMeetingTransition,
  putMeeting,
  runMeetingRound
} from './meetings'

const participants = [
  { connectionId: 'vps', profile: 'chair' },
  { connectionId: 'bridge', profile: 'research' }
]

const a2aParticipant = { connectionId: 'a2a', profile: 'agent-1' }
const a2aAgent = {
  assignments: [],
  displayName: 'A2A Harness Bot',
  id: 'a2a::agent-1',
  profile: 'agent-1',
  sourceId: 'a2a',
  sourceKind: 'a2a',
  sourceLabel: 'A2A Harness',
  state: 'idle' as const,
  workSummary: 'Connected via A2A'
}

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
  vi.useRealTimers()
})

function draft() {
  return createMeetingDraft({
    agenda: 'Choose a release plan',
    chair: participants[0],
    id: 'meeting-1',
    maxRounds: 3,
    participants,
    source: participants[0],
    title: 'Release council'
  })
}

describe('Operations structured meeting client', () => {
  it.each([
    { caseName: 'blank', text: '' },
    { caseName: 'too-long', text: 'x'.repeat(8_001) }
  ])('rejects a $caseName meeting prompt before any request', async ({ text }) => {
    const requestProfile = vi.fn()

    await expect(injectMeetingParticipantPrompt(
      { requestProfile } as never,
      { ...draft(), state: 'running' as const },
      participants[1],
      { bridge: 'remote' },
      text,
      []
    )).rejects.toThrow('1 through 8000')
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('rejects prompt injection when the authoritative runner binding changed', async () => {
    const meeting = {
      ...draft(),
      participants: [...participants, a2aParticipant],
      runnerSessions: { 'a2a::agent-1': 'agent-1' },
      state: 'running' as const
    }
    const { runnerSessions: _staleBinding, ...meetingWithoutBinding } = meeting
    const rest = vi.fn().mockResolvedValue({
      meeting: {
        ...meetingWithoutBinding,
        runner_sessions: { 'a2a::agent-1': 'agent-2' }
      },
      version: 2
    })

    unbind = bindOperationsApi(rest)
    await expect(injectMeetingParticipantPrompt(
      { requestProfile: vi.fn() } as never,
      meeting,
      a2aParticipant,
      {},
      'Continue with the decision.',
      [a2aAgent],
      'request-1'
    )).rejects.toThrow('binding')
    expect(rest).toHaveBeenCalledTimes(1)
    expect(rest).toHaveBeenCalledWith('/meetings/meeting-1')
  })

  it('sends an A2A prompt and refreshes history with the same caller request identity', async () => {
    const meeting = {
      ...draft(),
      participants: [...participants, a2aParticipant],
      runnerSessions: { 'a2a::agent-1': 'agent-1' },
      state: 'running' as const
    }
    const rest = vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === '/meetings/meeting-1') {
        return { meeting, version: 3 }
      }

      if (options?.method === 'POST') {
        return {
          connector_event_id: 'private-event',
          native_session_id: 'private-session',
          reply: 'Review accepted.',
          request_status: 'running',
          state: 'working'
        }
      }

      return {
        messages: [
          { role: 'user', content: '<hermes-meeting id="meeting-1">\nReview the release evidence.' },
          { role: 'assistant', content: 'Review accepted.' }
        ],
        mirror_session_id: 'private-mirror',
        request_status: 'running'
      }
    })

    unbind = bindOperationsApi(rest as never)
    const requestProfile = vi.fn()
    const result = await injectMeetingParticipantPrompt(
      { requestProfile } as never,
      meeting,
      a2aParticipant,
      {},
      '  Review the release evidence.  ',
      [a2aAgent],
      'request-1'
    )

    expect(rest).toHaveBeenNthCalledWith(1, '/meetings/meeting-1')
    expect(rest).toHaveBeenNthCalledWith(2, '/agents/a2a/agent-1/chat', {
      method: 'POST',
      body: {
        message: '<hermes-meeting id="meeting-1">\nReview the release evidence.',
        request_id: 'request-1'
      }
    })
    expect(rest).toHaveBeenNthCalledWith(3, '/agents/a2a/agent-1/chat?request_id=request-1')
    expect(requestProfile).not.toHaveBeenCalled()
    expect(result).toEqual({
      messages: [
        { role: 'user', content: 'Review the release evidence.' },
        { role: 'assistant', content: 'Review accepted.' }
      ],
      requestStatus: 'running',
      runtimeSessionId: null,
      status: 'working',
      storedSessionId: 'agent-1'
    })
    expect(result).not.toHaveProperty('nativeSessionId')
    expect(result).not.toHaveProperty('connectorEventId')
  })

  it('queues a marked native prompt on the exact runtime session and shows the visible prompt', async () => {
    const meeting = {
      ...draft(),
      runnerSessions: { 'bridge::research': 'stored-research' },
      state: 'running' as const
    }
    const rest = vi.fn().mockResolvedValue({ meeting, version: 4 })
    let resumes = 0
    const requestProfile = vi.fn(async (_route, method: string) => {
      if (method === 'prompt.submit') {return { ok: true }}

      resumes += 1

      return {
        messages: [
          { role: 'assistant', content: 'Earlier evidence.' },
          ...(resumes === 2
            ? [{ role: 'user', content: '<hermes-meeting id="meeting-1">\nCheck the final evidence.' }]
            : [])
        ],
        running: false,
        session_id: 'runtime-research'
      }
    })

    unbind = bindOperationsApi(rest)
    const result = await injectMeetingParticipantPrompt(
      { requestProfile } as never,
      meeting,
      participants[1],
      { bridge: 'remote' },
      '  Check the final evidence.  ',
      []
    )

    expect(requestProfile).toHaveBeenNthCalledWith(
      2,
      { connectionId: 'bridge', mode: 'remote', profile: 'research', targetProfile: 'research' },
      'prompt.submit',
      {
        queued: true,
        session_id: 'runtime-research',
        text: '<hermes-meeting id="meeting-1">\nCheck the final evidence.'
      }
    )
    expect(requestProfile).toHaveBeenCalledTimes(3)
    expect(result.messages).toEqual([
      { role: 'assistant', content: 'Earlier evidence.' },
      { role: 'user', content: 'Check the final evidence.' }
    ])
    expect(result.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(result.runtimeSessionId).toBe('runtime-research')
  })

  it('reads a public A2A participant conversation by its exact public identity', async () => {
    const meeting = {
      ...draft(),
      participants: [...participants, a2aParticipant],
      runnerSessions: { 'a2a::agent-1': 'agent-1' },
      state: 'running' as const
    }
    const rest = vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: 'Unrelated private conversation.' },
        { role: 'assistant', content: 'Private answer.' },
        { role: 'user', content: '<hermes-meeting id="meeting-1">\nCheck the public evidence.' },
        { role: 'assistant', content: 'Public evidence checked.' },
        { role: 'user', content: 'Another unrelated request.' },
        { role: 'assistant', content: 'Another private answer.' }
      ],
      mirror_session_id: 'private-mirror',
      request_status: 'running'
    })

    unbind = bindOperationsApi(rest)
    const result = await getMeetingParticipantConversation(
      { requestProfile: vi.fn() } as never,
      meeting,
      a2aParticipant,
      {},
      [a2aAgent]
    )

    expect(rest).toHaveBeenCalledWith('/agents/a2a/agent-1/chat')
    expect(result).toEqual({
      messages: [
        { role: 'user', content: 'Check the public evidence.' },
        { role: 'assistant', content: 'Public evidence checked.' }
      ],
      requestStatus: 'running',
      runtimeSessionId: null,
      status: 'working',
      storedSessionId: 'agent-1'
    })
    expect(result).not.toHaveProperty('mirrorSessionId')
  })

  it('reads the hidden native participant conversation with meeting-safe presentation', async () => {
    const meeting = {
      ...draft(),
      runnerSessions: { 'bridge::research': 'stored-research' },
      state: 'running' as const
    }
    const requestProfile = vi.fn().mockResolvedValue({
      messages: [
        { role: 'user', content: '<hermes-meeting id="meeting-1">\nCheck the release evidence.' },
        { role: 'assistant', content: [{ text: 'Evidence checked.' }] }
      ],
      running: false,
      session_id: 'runtime-research'
    })

    const result = await getMeetingParticipantConversation(
      { requestProfile } as never,
      meeting,
      participants[1],
      { bridge: 'remote' },
      []
    )

    expect(requestProfile).toHaveBeenCalledWith(
      { connectionId: 'bridge', mode: 'remote', profile: 'research', targetProfile: 'research' },
      'session.resume',
      {
        enabled_toolsets: ['clarify'],
        profile: 'research',
        session_id: 'stored-research',
        skip_background_review: true,
        skip_context_files: true,
        skip_memory: true,
        source: 'meeting'
      }
    )
    expect(result).toEqual({
      messages: [
        { role: 'user', content: 'Check the release evidence.' },
        { role: 'assistant', content: 'Evidence checked.' }
      ],
      runtimeSessionId: 'runtime-research',
      status: 'ready',
      storedSessionId: 'stored-research'
    })
  })

  it('rejects a generic connected participant instead of routing it as native', async () => {
    const meeting = {
      ...draft(),
      runnerSessions: { 'bridge::research': 'stored-research' },
      state: 'running' as const
    }
    const requestProfile = vi.fn().mockResolvedValue({ messages: [] })
    const connectedAgent = {
      ...a2aAgent,
      id: 'bridge::research',
      profile: 'research',
      sourceId: 'bridge',
      sourceKind: 'connected'
    }

    await expect(getMeetingParticipantConversation(
      { requestProfile } as never,
      meeting,
      participants[1],
      { bridge: 'remote' },
      [connectedAgent]
    )).rejects.toThrow('unsupported')
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('rejects a native participant when its exact connection mode is missing', async () => {
    const meeting = {
      ...draft(),
      runnerSessions: { 'bridge::research': 'stored-research' },
      state: 'running' as const
    }
    const requestProfile = vi.fn().mockResolvedValue({ messages: [] })

    await expect(getMeetingParticipantConversation(
      { requestProfile } as never,
      meeting,
      participants[1],
      {},
      []
    )).rejects.toThrow('connection mode')
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('reports a seated participant conversation as not started without a runner session', async () => {
    const requestProfile = vi.fn()

    const result = await getMeetingParticipantConversation(
      { requestProfile } as never,
      { ...draft(), state: 'running' as const },
      participants[1],
      { bridge: 'remote' },
      []
    )

    expect(result).toEqual({
      messages: [],
      runtimeSessionId: null,
      status: 'not-started',
      storedSessionId: null
    })
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('rejects conversation access for a route that is not seated', async () => {
    const requestProfile = vi.fn()

    await expect(getMeetingParticipantConversation(
      { requestProfile } as never,
      {
        ...draft(),
        runnerSessions: { 'bridge::intruder': 'stored-intruder' },
        state: 'running' as const
      },
      { connectionId: 'bridge', profile: 'intruder' },
      { bridge: 'remote' },
      []
    )).rejects.toThrow('not seated')
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('creates an immutable source-qualified draft through the shared model', () => {
    const meeting = draft()

    expect(meeting).toMatchObject({
      chair: participants[0],
      currentRound: 0,
      id: 'meeting-1',
      participants,
      source: participants[0],
      state: 'draft'
    })
    expect(Object.isFrozen(meeting)).toBe(true)
    expect(Object.isFrozen(meeting.participants)).toBe(true)
    expect(Object.isFrozen(meeting.participants[0])).toBe(true)
  })

  it('round-trips a public round run marker through the REST wire shape', () => {
    const parsed = meetingFromWire({
      ...meetingToWire(draft()),
      current_round: 1,
      round_run: {
        participant: { connection: 'bridge', profile: 'research' },
        round: 1,
        started_at: 1_800_000_000_123
      },
      state: 'running'
    })

    expect(parsed.roundRun).toEqual({
      participant: participants[1],
      round: 1,
      startedAt: 1_800_000_000_123
    })
    expect(meetingToWire(parsed)).toEqual(expect.objectContaining({
      round_run: {
        participant: { connection: 'bridge', profile: 'research' },
        round: 1,
        started_at: 1_800_000_000_123
      }
    }))

    expect(meetingFromWire({
      ...meetingToWire(draft()),
      roundRun: {
        participant: participants[0],
        round: 2,
        startedAt: 1_800_000_000_456
      }
    }).roundRun).toEqual({
      participant: participants[0],
      round: 2,
      startedAt: 1_800_000_000_456
    })
  })

  it.each([
    { caseName: 'absent', marker: undefined },
    { caseName: 'partial', marker: { participant: { connection: 'bridge', profile: 'research' }, round: 1 } },
    { caseName: 'invalid participant', marker: { participant: { connection: '', profile: 'research' }, round: 1, started_at: 1 } },
    { caseName: 'non-integer round', marker: { participant: { connection: 'bridge', profile: 'research' }, round: 1.5, started_at: 1 } },
    { caseName: 'non-positive timestamp', marker: { participant: { connection: 'bridge', profile: 'research' }, round: 1, started_at: 0 } }
  ])('drops an $caseName round run marker from the public wire shape', ({ marker }) => {
    expect(meetingFromWire({
      ...meetingToWire(draft()),
      round_run: marker
    }).roundRun).toBeUndefined()
  })

  it('applies every meeting round run freshness boundary', () => {
    const now = 2_000_000_000_000
    const freshMarker = {
      participant: participants[1],
      round: 2,
      startedAt: now - MEETING_ROUND_RUN_LEASE_MS + 1
    }
    const running: MeetingRecord = {
      ...draft(),
      currentRound: 2,
      roundRun: freshMarker,
      state: 'running'
    }
    const cases: Array<{ caseName: string; expected: boolean; meeting: MeetingRecord }> = [
      { caseName: 'one millisecond inside the lease', expected: true, meeting: running },
      {
        caseName: 'at the current time',
        expected: true,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: now } }
      },
      {
        caseName: 'at the lease boundary',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: now - MEETING_ROUND_RUN_LEASE_MS } }
      },
      {
        caseName: 'in the future',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: now + 1 } }
      },
      {
        caseName: 'with a zero timestamp',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: 0 } }
      },
      {
        caseName: 'with a non-integer timestamp',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: now - 0.5 } }
      },
      {
        caseName: 'with a non-finite timestamp',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, startedAt: Number.POSITIVE_INFINITY } }
      },
      {
        caseName: 'for another round',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, round: 1 } }
      },
      {
        caseName: 'for a participant no longer seated',
        expected: false,
        meeting: { ...running, roundRun: { ...freshMarker, participant: { connectionId: 'bridge', profile: 'former' } } }
      },
      { caseName: 'while waiting', expected: false, meeting: { ...running, state: 'waiting' } },
      { caseName: 'without a marker', expected: false, meeting: { ...running, roundRun: undefined } }
    ]

    expect(MEETING_ROUND_RUN_LEASE_MS).toBe(10 * 60 * 1000)

    for (const testCase of cases) {
      expect(isMeetingRoundRunFresh(testCase.meeting, now), testCase.caseName).toBe(testCase.expected)
    }
  })

  it('lists at most 100 authoritative meetings through authenticated plugin REST', async () => {
    const wire = {
      action_items: [],
      agenda: 'Choose a release plan',
      chair: { connection: 'vps', profile: 'chair' },
      contributions: [],
      current_round: 0,
      decisions: [],
      dissent: [],
      evidence: [],
      id: 'meeting-1',
      max_rounds: 3,
      participants: [
        { connection: 'vps', profile: 'chair' },
        { connection: 'bridge', profile: 'research' }
      ],
      source: { connection: 'vps', profile: 'chair' },
      state: 'draft',
      title: 'Release council'
    }

    const rest = vi.fn().mockResolvedValue({ meetings: [{ meeting: wire, version: 4 }] })

    unbind = bindOperationsApi(rest)
    const listed = await listMeetings()

    expect(rest).toHaveBeenCalledOnce()
    expect(rest).toHaveBeenCalledWith('/meetings?limit=100')
    expect(listed).toMatchObject([{ meeting: { id: 'meeting-1', participants }, version: 4 }])
    expect(Object.isFrozen(listed[0].meeting)).toBe(true)
    expect(Object.isFrozen(listed[0].meeting.participants)).toBe(true)
  })

  it('puts the wire record and CAS version through the meeting REST resource', async () => {
    const rest = vi.fn(async (_path: string, options?: { body?: unknown }) => {
      const body = options?.body as { record: unknown }

      return { meeting: body.record, version: 1 }
    })

    unbind = bindOperationsApi(rest as never)
    const saved = await putMeeting(draft(), 0)

    expect(rest).toHaveBeenCalledWith('/meetings/meeting-1', {
      method: 'PUT',
      body: {
        expected_version: 0,
        record: expect.objectContaining({
          current_round: 0,
          id: 'meeting-1',
          max_rounds: 3,
          participants: [
            { connection: 'vps', profile: 'chair' },
            { connection: 'bridge', profile: 'research' }
          ]
        })
      }
    })
    expect(saved).toMatchObject({ meeting: { id: 'meeting-1', state: 'draft' }, version: 1 })
    expect(Object.isFrozen(saved.meeting)).toBe(true)
  })

  it('applies a model transition immutably and persists it with the current CAS version', async () => {
    const original = draft()

    const rest = vi.fn(async (_path: string, options?: { body?: unknown }) => {
      const body = options?.body as { record: unknown }

      return { meeting: body.record, version: 8 }
    })

    unbind = bindOperationsApi(rest as never)
    const saved = await persistMeetingTransition(original, 7, 'start')

    expect(original).toMatchObject({ currentRound: 0, state: 'draft' })
    expect(rest).toHaveBeenCalledWith('/meetings/meeting-1', {
      method: 'PUT',
      body: {
        expected_version: 7,
        record: expect.objectContaining({ current_round: 1, state: 'running' })
      }
    })
    expect(saved).toMatchObject({
      conflict: false,
      meeting: { currentRound: 1, state: 'running' },
      version: 8
    })
  })

  it('rejects a direct pending resume before any durable write can discard recovery state', async () => {
    const waiting = {
      ...draft(),
      currentRound: 1,
      pending: { participant: participants[1], requestId: 'request-1' },
      state: 'waiting' as const
    }
    const rest = vi.fn()

    unbind = bindOperationsApi(rest as never)

    await expect(persistMeetingTransition(waiting, 3, 'resume'))
      .rejects.toThrow('meeting round runner')
    expect(rest).not.toHaveBeenCalled()
  })

  it('recovers the authoritative REST record after a CAS conflict without replaying the stale write', async () => {
    const original = { ...draft(), currentRound: 1, state: 'running' as const }
    const authoritative = { ...original, state: 'waiting' as const }

    const rest = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('409 Meeting version conflict'), { status: 409 }))
      .mockResolvedValueOnce({ meeting: {
        ...authoritative,
        source: { connection: 'vps', profile: 'chair' },
        chair: { connection: 'vps', profile: 'chair' },
        participants: [
          { connection: 'vps', profile: 'chair' },
          { connection: 'bridge', profile: 'research' }
        ],
        max_rounds: 3,
        current_round: 1,
        evidence: [],
        action_items: []
      }, version: 12 })

    unbind = bindOperationsApi(rest as never)

    const recovered = await persistMeetingTransition(original, 11, 'wait')

    expect(rest).toHaveBeenNthCalledWith(2, '/meetings/meeting-1')
    expect(recovered).toMatchObject({ conflict: true, meeting: { state: 'waiting' }, version: 12 })
  })

  it('rejects a connected sourceId a2a round without calling public A2A REST', async () => {
    const running: MeetingRecord = {
      ...draft(),
      contributions: [{
        evidenceRefs: [],
        id: 'meeting-1:r1:vps:chair',
        kind: 'pass',
        participant: participants[0],
        round: 1
      }],
      currentRound: 1,
      participants: [participants[0], a2aParticipant],
      state: 'running'
    }
    const connectedA2A = {
      ...a2aAgent,
      sourceKind: 'connected'
    }
    const writes: Array<Record<string, unknown>> = []
    const rest = vi.fn(async (path: string, options?: { body?: { record?: Record<string, unknown> } }) => {
      if (path.startsWith('/agents/a2a/')) {
        throw new Error('public A2A REST must not be called')
      }

      const record = options?.body?.record

      if (!record) {throw new Error('unexpected meeting read')}
      writes.push(record)

      return { meeting: record, version: 5 + writes.length }
    })
    const requestProfile = vi.fn()

    unbind = bindOperationsApi(rest as never)

    await expect(runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      {},
      { agents: [connectedA2A], now: () => 2_000_000_000_000 }
    )).rejects.toThrow('Generic connected meeting participants are unsupported')
    expect(rest.mock.calls.some(([path]) => String(path).startsWith('/agents/a2a/'))).toBe(false)
    expect(requestProfile).not.toHaveBeenCalled()
    expect(writes).toHaveLength(2)
    expect(writes[0]).toHaveProperty('round_run')
    expect(writes[1]).not.toHaveProperty('round_run')
  })

  it('completes a public A2A round with one deterministic request identity and a durable contribution', async () => {
    vi.useFakeTimers()
    const running: MeetingRecord = {
      ...draft(),
      contributions: [{
        evidenceRefs: [],
        id: 'meeting-1:r1:vps:chair',
        kind: 'pass',
        participant: participants[0],
        round: 1
      }],
      currentRound: 1,
      maxRounds: 1,
      participants: [participants[0], a2aParticipant],
      state: 'running'
    }
    const requestProfile = vi.fn()

    const executeRound = async () => {
      let historyReads = 0
      let storedVersion = 5
      const requestIds: string[] = []
      const writes: Array<Record<string, unknown>> = []
      const rest = vi.fn(async (path: string, options?: {
        body?: { message?: string; record?: Record<string, unknown>; request_id?: string }
        method?: string
      }) => {
        if (path === '/meetings/meeting-1') {
          const record = options?.body?.record

          if (!record) {throw new Error('unexpected meeting read')}
          writes.push(record)
          storedVersion += 1

          return { meeting: record, version: storedVersion }
        }

        if (options?.method === 'POST') {
          const marker = '<hermes-meeting id="meeting-1">'
          const message = String(options.body?.message ?? '')
          expect(message).toMatch(/^<hermes-meeting id="meeting-1">\n/)
          expect(message.split(marker).length - 1).toBe(1)
          requestIds.push(String(options.body?.request_id ?? ''))

          return { reply: 'Ship the signed candidate.', request_status: 'completed', state: 'completed' }
        }

        const requestId = new URL(path, 'https://operations.test').searchParams.get('request_id') ?? ''

        requestIds.push(requestId)
        historyReads += 1

        return historyReads === 1
          ? { messages: [], request_status: 'completed' }
          : {
              messages: [
                { role: 'user', content: '<hermes-meeting id="meeting-1">\nRound prompt' },
                { role: 'assistant', content: 'Ship the signed candidate.' }
              ],
              request_status: 'completed'
            }
      })

      unbind = bindOperationsApi(rest as never)
      const pending = runMeetingRound(
        { requestProfile } as never,
        running,
        5,
        { vps: 'remote' },
        { agents: [a2aAgent], now: () => 2_000_000_000_000 }
      )

      await vi.runAllTimersAsync()
      const result = await pending

      unbind()
      unbind = undefined

      return { requestIds, result, writes }
    }

    const first = await executeRound()
    const retry = await executeRound()

    expect(first.requestIds).toHaveLength(3)
    expect(new Set(first.requestIds).size).toBe(1)
    expect(first.requestIds[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(retry.requestIds).toEqual(first.requestIds)
    expect(first.result.meeting).toMatchObject({
      contributions: expect.arrayContaining([
        expect.objectContaining({
          kind: 'speak',
          participant: a2aParticipant,
          text: 'Ship the signed candidate.'
        })
      ]),
      runnerSessions: { 'a2a::agent-1': 'agent-1' },
      state: 'completed'
    })
    expect(first.result.pending).toBeNull()
    expect(first.writes).toHaveLength(2)
    expect(first.writes[0]).toHaveProperty('round_run')
    expect(first.writes[1]).not.toHaveProperty('round_run')
    expect(first.writes[1]).toMatchObject({
      runner_sessions: { 'a2a::agent-1': 'agent-1' },
      state: 'completed'
    })
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('durably waits on a public A2A waiting status without fabricating a contribution', async () => {
    const running: MeetingRecord = {
      ...draft(),
      contributions: [{
        evidenceRefs: [],
        id: 'meeting-1:r1:vps:chair',
        kind: 'pass',
        participant: participants[0],
        round: 1
      }],
      currentRound: 1,
      participants: [participants[0], a2aParticipant],
      state: 'running'
    }
    let storedVersion = 5
    const requestIds: string[] = []
    const writes: Array<Record<string, unknown>> = []
    const rest = vi.fn(async (path: string, options?: {
      body?: { record?: Record<string, unknown> }
      method?: string
    }) => {
      if (path === '/meetings/meeting-1') {
        const record = options?.body?.record

        if (!record) {throw new Error('unexpected meeting read')}
        writes.push(record)
        storedVersion += 1

        return { meeting: record, version: storedVersion }
      }

      if (options?.method === 'POST') {
        throw new Error('waiting A2A request must not be submitted again')
      }

      requestIds.push(new URL(path, 'https://operations.test').searchParams.get('request_id') ?? '')

      return { messages: [], request_status: 'waiting' }
    })
    const requestProfile = vi.fn()

    unbind = bindOperationsApi(rest as never)
    const result = await runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      { vps: 'remote' },
      { agents: [a2aAgent], now: () => 2_000_000_000_000 }
    )

    expect(requestIds).toHaveLength(1)
    expect(requestIds[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(result.meeting.state).toBe('waiting')
    expect(result.pending).toMatchObject({
      before: 0,
      kind: 'clarify',
      participant: a2aParticipant,
      requestId: requestIds[0],
      session: 'agent-1'
    })
    expect(result.meeting.contributions).toHaveLength(running.contributions.length)
    expect(result.meeting.contributions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ participant: a2aParticipant })
    ]))
    expect(result.meeting.runnerSessions).toEqual({ 'a2a::agent-1': 'agent-1' })
    expect(writes).toHaveLength(2)
    expect(writes[1]).not.toHaveProperty('round_run')
    expect(writes[1]).toMatchObject({
      pending: expect.objectContaining({
        kind: 'clarify',
        participant: a2aParticipant,
        requestId: requestIds[0]
      }),
      runner_sessions: { 'a2a::agent-1': 'agent-1' },
      state: 'waiting'
    })
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('claims before native RPC and durably checkpoints each contribution before progress', async () => {
    vi.useFakeTimers()
    const running: MeetingRecord = {
      ...draft(),
      contributions: [{
        id: 'meeting-1:r1:vps:chair',
        round: 1,
        participant: participants[0],
        kind: 'speak',
        text: 'Chair evidence',
        evidenceRefs: []
      }],
      currentRound: 1,
      state: 'running'
    }
    const events: string[] = []
    let storedVersion = 5
    const writes: Array<{ expectedVersion: number; record: Record<string, unknown> }> = []
    const rest = vi.fn(async (_path: string, options?: { body?: { expected_version?: number; record?: Record<string, unknown> } }) => {
      const expectedVersion = options?.body?.expected_version
      const record = options?.body?.record

      if (expectedVersion === undefined || !record) {throw new Error('unexpected read')}
      writes.push({ expectedVersion, record })
      events.push(record.round_run ? 'persist:marker' : 'persist:checkpoint')
      storedVersion += 1

      return { meeting: record, version: storedVersion }
    })
    const resumeCounts = new Map<string, number>()
    const requestProfile = vi.fn(async (route, method: string) => {
      events.push(`rpc:${method}:${route.profile}`)
      if (method === 'session.create') {
        return { session_id: 'runtime-research', stored_session_id: 'stored-research' }
      }
      if (method === 'session.resume') {
        const count = resumeCounts.get(route.profile) ?? 0
        resumeCounts.set(route.profile, count + 1)

        return count === 0
          ? { session_id: 'runtime-research', messages: [], running: false }
          : { session_id: 'runtime-research', messages: [{ role: 'assistant', content: '(pass)' }], running: false }
      }
      if (method === 'prompt.submit') {return { ok: true }}
      throw new Error(`unexpected ${method}`)
    })
    const onParticipantStart = vi.fn(async participant => {
      events.push(`ui:start:${participant.profile}`)
    })
    const onProgress = vi.fn(async value => {
      events.push(`ui:progress:${value.version}`)
    })

    unbind = bindOperationsApi(rest as never)
    const pendingResult = runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      { bridge: 'remote', vps: 'remote' },
      { now: () => 2_000_000_000_000, onParticipantStart, onProgress }
    )

    await vi.runAllTimersAsync()
    const result = await pendingResult

    expect(events).toEqual([
      'persist:marker',
      'ui:start:research',
      'rpc:session.create:research',
      'rpc:session.resume:research',
      'rpc:prompt.submit:research',
      'rpc:session.resume:research',
      'persist:checkpoint',
      'ui:progress:7'
    ])
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({
      expectedVersion: 5,
      record: {
        round_run: {
          participant: { connection: 'bridge', profile: 'research' },
          round: 1,
          started_at: 2_000_000_000_000
        }
      }
    })
    expect(writes[1].expectedVersion).toBe(6)
    expect(writes[1].record).not.toHaveProperty('round_run')
    expect(writes[1].record).toMatchObject({
      runner_sessions: { 'bridge::research': 'stored-research' }
    })
    expect(result).toMatchObject({ conflict: false, pending: null, version: 7 })
    expect(result.meeting.roundRun).toBeUndefined()
    expect(result.meeting.runnerSessions).toEqual({ 'bridge::research': 'stored-research' })
    expect(onParticipantStart).toHaveBeenCalledOnce()
    expect(onProgress).toHaveBeenCalledOnce()
  })

  it('recovers a waiting participant turn before prompting anyone again', async () => {
    vi.useFakeTimers()
    const waiting: MeetingRecord = {
      ...draft(),
      contributions: [{
        evidenceRefs: [],
        id: 'meeting-1:r1:vps:chair',
        kind: 'pass',
        participant: participants[0],
        round: 1
      }],
      currentRound: 1,
      pending: {
        before: 1,
        kind: 'clarify',
        participant: participants[1],
        reason: 'Participant requested clarification.',
        session: 'stored-research'
      },
      runnerSessions: { 'bridge::research': 'stored-research' },
      state: 'waiting'
    }
    let storedVersion = 5
    const writes: Array<Record<string, unknown>> = []
    const rest = vi.fn(async (_path: string, options?: { body?: { record?: Record<string, unknown> } }) => {
      const record = options?.body?.record

      if (!record) {throw new Error('unexpected meeting read')}
      writes.push(record)
      storedVersion += 1

      return { meeting: record, version: storedVersion }
    })
    const requestProfile = vi.fn(async (_route, method: string) => {
      if (method !== 'session.resume') {throw new Error(`unexpected ${method}`)}

      return {
        messages: [
          { content: 'Which release?', role: 'user' },
          { content: 'Use the verified candidate.', role: 'assistant' }
        ],
        running: false,
        session_id: 'stored-research'
      }
    })

    unbind = bindOperationsApi(rest as never)
    const pendingResult = runMeetingRound(
      { requestProfile } as never,
      waiting,
      5,
      { bridge: 'remote', vps: 'remote' },
      { now: () => 2_000_000_000_000 }
    )

    await vi.runAllTimersAsync()
    const result = await pendingResult

    expect(requestProfile.mock.calls.map(([, method]) => method)).toEqual(['session.resume'])
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toHaveProperty('pending')
    expect(writes[0]).not.toHaveProperty('round_run')
    expect(writes[0]).toMatchObject({
      contributions: expect.arrayContaining([
        expect.objectContaining({
          participant: { connection: 'bridge', profile: 'research' },
          text: 'Use the verified candidate.'
        })
      ]),
      state: 'running'
    })
    expect(result).toMatchObject({ conflict: false, pending: null, version: 6 })
  })

  it('rejects a fresh duplicate round before REST writes or native RPC', async () => {
    const now = 2_000_000_000_000
    const running: MeetingRecord = {
      ...draft(),
      currentRound: 1,
      roundRun: { participant: participants[0], round: 1, startedAt: now - 1 },
      state: 'running'
    }
    const rest = vi.fn()
    const requestProfile = vi.fn()

    unbind = bindOperationsApi(rest)

    await expect(runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      { bridge: 'remote', vps: 'remote' },
      { now: () => now }
    )).rejects.toThrow('round is already running')
    expect(rest).not.toHaveBeenCalled()
    expect(requestProfile).not.toHaveBeenCalled()
  })

  it('replaces a stale round marker with a fresh claim before native RPC', async () => {
    const now = 2_000_000_000_000
    const running: MeetingRecord = {
      ...draft(),
      currentRound: 1,
      roundRun: {
        participant: participants[1],
        round: 1,
        startedAt: now - MEETING_ROUND_RUN_LEASE_MS
      },
      state: 'running'
    }
    const writes: Array<{ expectedVersion: number; record: Record<string, unknown> }> = []
    let storedVersion = 5
    const rest = vi.fn(async (_path: string, options?: { body?: { expected_version?: number; record?: Record<string, unknown> } }) => {
      const expectedVersion = options?.body?.expected_version
      const record = options?.body?.record

      if (expectedVersion === undefined || !record) {throw new Error('unexpected read')}
      writes.push({ expectedVersion, record })
      storedVersion += 1

      return { meeting: record, version: storedVersion }
    })
    const requestProfile = vi.fn(async (_route, method: string) => {
      if (method === 'session.create') {
        return { session_id: 'runtime-chair', stored_session_id: 'stored-chair' }
      }
      if (method === 'session.resume') {
        return {
          messages: [],
          pending_clarify: { question: 'Which release?' },
          session_id: 'runtime-chair'
        }
      }
      throw new Error(`unexpected ${method}`)
    })

    unbind = bindOperationsApi(rest as never)
    const result = await runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      { bridge: 'remote', vps: 'remote' },
      { now: () => now }
    )

    expect(writes[0]).toMatchObject({
      expectedVersion: 5,
      record: {
        round_run: {
          participant: { connection: 'vps', profile: 'chair' },
          round: 1,
          started_at: now
        }
      }
    })
    expect(requestProfile.mock.invocationCallOrder[0]).toBeGreaterThan(rest.mock.invocationCallOrder[0])
    expect(result.meeting.roundRun).toBeUndefined()
    expect(result.meeting.state).toBe('waiting')
  })

  it('returns authoritative state after a claim conflict without native RPC', async () => {
    const running: MeetingRecord = {
      ...draft(),
      currentRound: 1,
      state: 'running'
    }
    const authoritative: MeetingRecord = {
      ...running,
      pending: { kind: 'clarify', question: 'Choose a target.' },
      state: 'waiting'
    }
    const rest = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('409 Meeting version conflict'), { status: 409 }))
      .mockResolvedValueOnce({ meeting: authoritative, version: 9 })
    const requestProfile = vi.fn()

    unbind = bindOperationsApi(rest as never)
    const result = await runMeetingRound(
      { requestProfile } as never,
      running,
      5,
      { bridge: 'remote', vps: 'remote' },
      { now: () => 2_000_000_000_000 }
    )

    expect(rest).toHaveBeenCalledTimes(2)
    expect(rest).toHaveBeenNthCalledWith(1, '/meetings/meeting-1', expect.objectContaining({
      body: expect.objectContaining({ expected_version: 5 }),
      method: 'PUT'
    }))
    expect(rest).toHaveBeenNthCalledWith(2, '/meetings/meeting-1')
    expect(requestProfile).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      conflict: true,
      meeting: { pending: authoritative.pending, state: 'waiting' },
      pending: authoritative.pending,
      version: 9
    })
  })

  it.each([
    { caseName: 'successful cleanup', cleanupConflict: false },
    { caseName: 'cleanup conflict', cleanupConflict: true }
  ])('clears the claimed marker once after native failure with $caseName and never retries', async ({ cleanupConflict }) => {
    const running: MeetingRecord = {
      ...draft(),
      currentRound: 1,
      state: 'running'
    }
    const nativeError = new Error('native session creation failed')
    const writes: Array<{ expectedVersion: number; record: Record<string, unknown> }> = []
    const rest = vi.fn(async (_path: string, options?: { body?: { expected_version?: number; record?: Record<string, unknown> } }) => {
      const expectedVersion = options?.body?.expected_version
      const record = options?.body?.record

      if (expectedVersion === undefined || !record) {throw new Error('unexpected read')}
      writes.push({ expectedVersion, record })
      if (writes.length === 2 && cleanupConflict) {
        throw Object.assign(new Error('409 Meeting version conflict'), { status: 409 })
      }

      return { meeting: record, version: expectedVersion + 1 }
    })
    const requestProfile = vi.fn().mockRejectedValue(nativeError)

    unbind = bindOperationsApi(rest as never)
    let caught: unknown

    try {
      await runMeetingRound(
        { requestProfile } as never,
        running,
        5,
        { bridge: 'remote', vps: 'remote' },
        { now: () => 2_000_000_000_000 }
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(nativeError)
    expect(requestProfile).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(2)
    expect(writes.map(write => write.expectedVersion)).toEqual([5, 6])
    expect(writes[0].record).toHaveProperty('round_run')
    const { round_run: discardedRoundRun, ...claimedWithoutMarker } = writes[0].record

    void discardedRoundRun
    expect(writes[1].record).toEqual(claimedWithoutMarker)
  })

  it('runs a least-privilege source-qualified round and persists pending owner input', async () => {
    const running = { ...draft(), currentRound: 1, state: 'running' as const }

    const rest = vi.fn(async (_path: string, options?: { body?: { record?: unknown } }) => ({
      meeting: options?.body?.record,
      version: 6
    }))

    unbind = bindOperationsApi(rest as never)

    const requestProfile = vi.fn(async (_route, method: string) => {
      if (method === 'session.create') {
        return { session_id: 'runtime-1', stored_session_id: 'stored-1' }
      }

      if (method === 'session.resume') {
        return { pending_clarify: { question: 'Which release?' } }
      }

      return {}
    })

    const result = await runMeetingRound({ requestProfile } as never, running, 5, {
      vps: 'remote',
      bridge: 'remote'
    })

    expect(requestProfile).toHaveBeenCalledWith(
      { connectionId: 'vps', mode: 'remote', profile: 'chair', targetProfile: 'chair' },
      'session.create',
      expect.objectContaining({
        enabled_toolsets: ['clarify'],
        skip_background_review: true,
        skip_context_files: true,
        skip_memory: true,
        source: 'meeting'
      })
    )
    expect(result.pending).toMatchObject({ kind: 'clarify', participant: participants[0] })
    expect(result.meeting.state).toBe('waiting')
    expect(rest).toHaveBeenCalledWith('/meetings/meeting-1', expect.objectContaining({
      body: expect.objectContaining({
        record: expect.objectContaining({ pending: expect.objectContaining({ kind: 'clarify' }) })
      })
    }))
  })

  it('omits cleared pending state when a successful round is persisted', async () => {
    const running = { ...draft(), currentRound: 1, state: 'running' as const }

    const rest = vi.fn(async (_path: string, options?: { body?: { record?: unknown } }) => ({
      meeting: options?.body?.record,
      version: 6
    }))

    unbind = bindOperationsApi(rest as never)
    const prompted = new Set<string>()

    const requestProfile = vi.fn(async (route, method: string) => {
      const key = `${route.connectionId}:${route.profile}`

      if (method === 'session.create') {return { session_id: `runtime-${key}`, stored_session_id: `stored-${key}` }}

      if (method === 'prompt.submit') {
        prompted.add(key)

        return { ok: true }
      }

      if (method === 'session.resume') {
        return prompted.has(key)
          ? { messages: [{ role: 'assistant', content: '(pass)' }], running: false }
          : { messages: [], running: false }
      }

      return {}
    })

    const result = await runMeetingRound({ requestProfile } as never, running, 5, {
      vps: 'remote',
      bridge: 'remote'
    })

    const put = rest.mock.calls.find(([, options]) => options?.body) as [string, { body: { record: Record<string, unknown> } }]
    expect(result.meeting.state).toBe('completed')
    expect(put[1].body.record).not.toHaveProperty('pending')
  })

  it('converts completed action items through exact routed duplicate-safe Kanban commands', async () => {
    const requestProfile = vi.fn().mockResolvedValue({ code: 0, stdout: '{}' })

    const completed = {
      ...draft(),
      actionItems: [{
        id: 'publish',
        ownerRoute: participants[1],
        title: 'Publish release',
        acceptanceCriteria: 'Signed artifact is available.',
        priority: 'high',
        dueIntent: 'Next checkpoint',
        dedupeKey: 'meeting:meeting-1:action:publish'
      }],
      state: 'completed' as const
    }

    await convertMeetingActions({ requestProfile } as never, completed, { bridge: 'remote' })

    expect(requestProfile).toHaveBeenCalledWith(
      { connectionId: 'bridge', mode: 'remote', profile: 'research', targetProfile: 'research' },
      'cli.exec',
      expect.objectContaining({
        argv: expect.arrayContaining(['--idempotency-key', 'meeting:meeting-1:action:publish'])
      })
    )
  })
})
