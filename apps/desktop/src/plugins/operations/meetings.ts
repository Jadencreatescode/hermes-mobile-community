// The shared Bot Mode model is authored as native ESM and intentionally lives
// with the identity layer. Keep this wrapper as the only untyped boundary.
// @ts-expect-error The sibling ESM model has no declaration file.
// eslint-disable-next-line no-restricted-imports
import * as meetingModel from '../hermes-bots/meeting-model.mjs'
// @ts-expect-error The sibling ESM runner has no declaration file.
// eslint-disable-next-line no-restricted-imports
import { runStructuredMeetingRound } from '../hermes-bots/meeting-runner.mjs'

import { operationsApi } from './api'

const {
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  failMeeting,
  hydrateMeeting,
  resumeMeeting,
  startMeeting,
  submitContribution,
  waitMeeting
} = meetingModel

const { buildKanbanCreatePayloads } = meetingModel

export interface RouteIdentity {
  readonly connectionId: string
  readonly profile: string
}

export interface MeetingRecord {
  readonly actionItems: readonly unknown[]
  readonly agenda: string
  readonly chair: RouteIdentity
  readonly contributions: readonly unknown[]
  readonly currentRound: number
  readonly decisions: readonly unknown[]
  readonly dissent: readonly unknown[]
  readonly evidenceRefs: readonly string[]
  readonly id: string
  readonly maxRounds: number
  readonly participants: readonly RouteIdentity[]
  readonly pending?: unknown
  readonly runnerSessions?: Readonly<Record<string, string>>
  readonly source: RouteIdentity
  readonly state: 'draft' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed'
  readonly title: string
}

export type MeetingTransition = 'start' | 'speak' | 'pass' | 'wait' | 'resume' | 'conclude' | 'cancel' | 'fail'

export interface VersionedMeeting {
  meeting: MeetingRecord
  version: number
}

function objectRow(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function routeFromWire(value: unknown): RouteIdentity {
  const row = objectRow(value)

  return {
    connectionId: String(row.connectionId ?? row.connection ?? ''),
    profile: String(row.profile ?? '')
  }
}

function routeToWire(value: RouteIdentity): { connection: string; profile: string } {
  return { connection: value.connectionId, profile: value.profile }
}

function meetingId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('Meeting id is invalid')
  }

  return value
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function nestedRoute(value: unknown, camelKey: string, wireKey: string): Record<string, unknown> {
  const row = objectRow(value)

  return {
    ...row,
    [camelKey]: routeFromWire(row[camelKey] ?? row[wireKey])
  }
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson))
  }

  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, freezeJson(item)])
    ))
  }

  return value
}

export function meetingFromWire(value: unknown): MeetingRecord {
  const row = objectRow(value)

  const normalized = {
    id: String(row.id ?? ''),
    source: routeFromWire(row.source),
    title: String(row.title ?? ''),
    agenda: String(row.agenda ?? ''),
    chair: routeFromWire(row.chair),
    participants: array(row.participants).map(routeFromWire),
    state: String(row.state ?? 'draft'),
    maxRounds: Number(row.maxRounds ?? row.max_rounds ?? 1),
    currentRound: Number(row.currentRound ?? row.current_round ?? 0),
    contributions: array(row.contributions).map(item => nestedRoute(item, 'participant', 'participant')),
    evidenceRefs: array(row.evidenceRefs ?? row.evidence),
    decisions: array(row.decisions),
    dissent: array(row.dissent).map(item => nestedRoute(item, 'participant', 'participant')),
    actionItems: array(row.actionItems ?? row.action_items).map(item => nestedRoute(item, 'ownerRoute', 'owner_route'))
  }

  const hydrated = hydrateMeeting(JSON.stringify(normalized)) as MeetingRecord
  const pending = row.pending === undefined ? undefined : freezeJson(row.pending)
  const rawSessions = row.runnerSessions ?? row.runner_sessions

  const runnerSessions = rawSessions === undefined
    ? undefined
    : freezeJson(objectRow(rawSessions)) as Readonly<Record<string, string>>

  if (pending === undefined && runnerSessions === undefined) {
    return hydrated
  }

  return Object.freeze({
    ...hydrated,
    ...(pending === undefined ? {} : { pending }),
    ...(runnerSessions === undefined ? {} : { runnerSessions })
  })
}

export function meetingToWire(meeting: MeetingRecord): Record<string, unknown> {
  return {
    id: meeting.id,
    source: routeToWire(meeting.source),
    title: meeting.title,
    agenda: meeting.agenda,
    chair: routeToWire(meeting.chair),
    participants: meeting.participants.map(routeToWire),
    state: meeting.state,
    max_rounds: meeting.maxRounds,
    current_round: meeting.currentRound,
    contributions: meeting.contributions.map(item => {
      const row = objectRow(item)

      return { ...row, participant: routeToWire(routeFromWire(row.participant)) }
    }),
    evidence: meeting.evidenceRefs,
    decisions: meeting.decisions,
    dissent: meeting.dissent,
    action_items: meeting.actionItems,
    ...(meeting.pending === undefined ? {} : { pending: meeting.pending }),
    ...(meeting.runnerSessions === undefined ? {} : { runner_sessions: meeting.runnerSessions })
  }
}

function versioned(value: unknown): VersionedMeeting {
  const row = objectRow(value)
  const rawMeeting = objectRow(row.meeting)

  return {
    meeting: meetingFromWire(rawMeeting),
    version: Number(row.version ?? rawMeeting.version ?? 0)
  }
}

export async function listMeetings(): Promise<VersionedMeeting[]> {
  const response = await operationsApi()<{ meetings?: unknown[] }>('/meetings?limit=100')

  return (response.meetings ?? []).slice(0, 100).map(versioned)
}

export async function getMeeting(value: string): Promise<VersionedMeeting> {
  return versioned(await operationsApi()<unknown>(`/meetings/${meetingId(value)}`))
}

export async function putMeeting(
  meeting: MeetingRecord,
  expectedVersion: number
): Promise<VersionedMeeting> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error('Meeting version is invalid')
  }

  const response = await operationsApi()<unknown>(`/meetings/${meetingId(meeting.id)}`, {
    method: 'PUT',
    body: {
      record: meetingToWire(meeting),
      expected_version: expectedVersion
    }
  })

  return versioned(response)
}

export function createMeetingDraft(input: {
  agenda: string
  chair: RouteIdentity
  id: string
  maxRounds: number
  participants: RouteIdentity[]
  source: RouteIdentity
  title: string
}): MeetingRecord {
  return createMeeting(input) as MeetingRecord
}

export function applyMeetingTransition(
  meeting: MeetingRecord,
  transition: MeetingTransition,
  payload?: Record<string, unknown>
): MeetingRecord {
  switch (transition) {
    case 'start':
      return startMeeting(meeting) as MeetingRecord

    case 'speak':
      return submitContribution(meeting, { ...payload, kind: 'speak' }) as MeetingRecord

    case 'pass':
      return submitContribution(meeting, { ...payload, kind: 'pass' }) as MeetingRecord

    case 'wait':
      return waitMeeting(meeting) as MeetingRecord

    case 'resume':
      return resumeMeeting(meeting) as MeetingRecord

    case 'conclude':
      return concludeMeeting(meeting, payload) as MeetingRecord

    case 'cancel':
      return cancelMeeting(meeting) as MeetingRecord

    case 'fail':
      return failMeeting(meeting) as MeetingRecord
  }
}

export async function persistMeetingTransition(
  meeting: MeetingRecord,
  version: number,
  transition: MeetingTransition,
  payload?: Record<string, unknown>
): Promise<VersionedMeeting & { conflict: boolean }> {
  try {
    const saved = await putMeeting(applyMeetingTransition(meeting, transition, payload), version)

    return { ...saved, conflict: false }
  } catch (error) {
    const row = error as { message?: unknown; status?: unknown }

    if (row.status !== 409 && !/409|conflict|version/i.test(String(row.message ?? ''))) {
      throw error
    }

    return { ...(await getMeeting(meeting.id)), conflict: true }
  }
}

interface MeetingRpcHost {
  requestProfile<T>(
    route: { connectionId: string; mode: 'local' | 'remote'; profile: string; targetProfile: string },
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>
}

export async function runMeetingRound(
  host: MeetingRpcHost,
  meeting: MeetingRecord,
  version: number,
  connectionModes: Record<string, 'local' | 'remote'>
): Promise<VersionedMeeting & { conflict: boolean; pending: unknown }> {
  const result = await runStructuredMeetingRound(meeting, {
    sessions: meeting.runnerSessions ?? {},
    request: (participant: RouteIdentity, method: string, params: Record<string, unknown>) =>
      host.requestProfile(
        {
          connectionId: participant.connectionId,
          mode: connectionModes[participant.connectionId] ?? (participant.connectionId === 'local' ? 'local' : 'remote'),
          profile: participant.profile,
          targetProfile: participant.profile
        },
        method,
        params
      )
  })

  const { pending: discardedPending, ...meetingWithoutPending } = result.meeting
  void discardedPending

  const next = Object.freeze({
    ...meetingWithoutPending,
    ...(result.pending == null ? {} : { pending: result.pending }),
    runnerSessions: Object.freeze({ ...result.sessions })
  }) as MeetingRecord

  try {
    const saved = await putMeeting(next, version)

    return { ...saved, conflict: false, pending: result.pending }
  } catch (error) {
    const row = error as { message?: unknown; status?: unknown }

    if (row.status !== 409 && !/409|conflict|version/i.test(String(row.message ?? ''))) {
      throw error
    }

    const authoritative = await getMeeting(meeting.id)

    return {
      ...authoritative,
      conflict: true,
      pending: authoritative.meeting.pending ?? null
    }
  }
}

export async function convertMeetingActions(
  host: MeetingRpcHost,
  meeting: MeetingRecord,
  connectionModes: Record<string, 'local' | 'remote'>
): Promise<Array<{ code?: number; stdout?: string }>> {
  const payloads = buildKanbanCreatePayloads(meeting) as Array<{
    route: RouteIdentity
    request: { assignee: string; body: string; idempotency_key: string; priority: number; title: string }
  }>

  const results = await Promise.all(payloads.map(payload => host.requestProfile<{ code?: number; stdout?: string }>(
    {
      connectionId: payload.route.connectionId,
      mode: connectionModes[payload.route.connectionId] ?? (payload.route.connectionId === 'local' ? 'local' : 'remote'),
      profile: payload.route.profile,
      targetProfile: payload.route.profile
    },
    'cli.exec',
    {
      argv: [
        'kanban', 'create', payload.request.title,
        '--body', payload.request.body,
        '--assignee', payload.request.assignee,
        '--priority', String(payload.request.priority),
        '--idempotency-key', payload.request.idempotency_key,
        '--json'
      ],
      timeout: 30
    }
  )))

  const failed = results.find(result => result.code !== undefined && result.code !== 0)

  if (failed) {
    throw new Error(`Kanban conversion failed with exit ${failed.code}`)
  }

  return results
}
