import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import {
  convertMeetingActions,
  createMeetingDraft,
  listMeetings,
  persistMeetingTransition,
  putMeeting,
  runMeetingRound
} from './meetings'

const participants = [
  { connectionId: 'vps', profile: 'chair' },
  { connectionId: 'bridge', profile: 'research' }
]

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
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
