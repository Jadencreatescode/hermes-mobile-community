// The shared Bot Mode model is authored as native ESM and intentionally lives
// with the identity layer. Keep this wrapper as the only untyped boundary.
// @ts-expect-error The sibling ESM model has no declaration file.
// eslint-disable-next-line no-restricted-imports
import * as meetingModel from '../hermes-bots/meeting-model.mjs'
// @ts-expect-error The sibling ESM runner has no declaration file.
// eslint-disable-next-line no-restricted-imports
import { filterMeetingHistory, meetingMarker, runStructuredMeetingRound, stripMeetingMarkers } from '../hermes-bots/meeting-runner.mjs'

import { operationsApi } from './api'
import { getA2AChatHistory, type OperationsAgentModel, sendA2AChatMessage } from './data'

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

export interface MeetingRoundRun {
  readonly participant: RouteIdentity
  readonly round: number
  readonly startedAt: number
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
  readonly roundRun?: MeetingRoundRun
  readonly runnerSessions?: Readonly<Record<string, string>>
  readonly source: RouteIdentity
  readonly state: 'draft' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed'
  readonly title: string
}

export type MeetingTransition = 'start' | 'speak' | 'pass' | 'wait' | 'resume' | 'conclude' | 'cancel' | 'fail'

export const MEETING_ROUND_RUN_LEASE_MS = 10 * 60 * 1000

export function isMeetingRoundRunFresh(meeting: MeetingRecord, nowMs = Date.now()): boolean {
  const marker = meeting.roundRun

  if (
    meeting.state !== 'running'
    || !marker
    || marker.round !== meeting.currentRound
    || !Number.isFinite(marker.startedAt)
    || !Number.isInteger(marker.startedAt)
    || marker.startedAt <= 0
    || marker.startedAt > nowMs
    || nowMs - marker.startedAt >= MEETING_ROUND_RUN_LEASE_MS
  ) {return false}

  return meeting.participants.some(participant =>
    participant.connectionId === marker.participant.connectionId
    && participant.profile === marker.participant.profile
  )
}

export interface VersionedMeeting {
  meeting: MeetingRecord
  version: number
}

export interface MeetingConversationMessage {
  readonly content: string
  readonly role: 'assistant' | 'system' | 'user'
}

export interface MeetingConversationSnapshot {
  readonly messages: readonly MeetingConversationMessage[]
  readonly requestStatus?: string | null
  readonly runtimeSessionId: string | null
  readonly status: 'not-started' | 'ready' | 'waiting' | 'working'
  readonly storedSessionId: string | null
}

export interface MeetingAttachment {
  readonly addedAt: number
  readonly addedBy: string
  readonly attachmentId: string
  readonly kind: 'link' | 'image' | 'file'
  readonly meetingId: string
  readonly mime: string
  readonly name: string
  readonly ref: string
  readonly size: number
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

function roundRunFromWire(value: unknown): MeetingRoundRun | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined}

  const row = objectRow(value)
  const participantRow = objectRow(row.participant)
  const connectionId = participantRow.connectionId ?? participantRow.connection
  const profile = participantRow.profile
  const round = row.round
  const startedAt = row.startedAt ?? row.started_at

  if (
    typeof connectionId !== 'string'
    || !connectionId
    || typeof profile !== 'string'
    || !profile
    || !Number.isSafeInteger(round)
    || Number(round) < 1
    || !Number.isSafeInteger(startedAt)
    || Number(startedAt) < 1
  ) {return undefined}

  return Object.freeze({
    participant: Object.freeze({ connectionId, profile }),
    round: Number(round),
    startedAt: Number(startedAt)
  })
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
  const pending = row.pending === undefined
    ? undefined
    : freezeJson(nestedRoute(row.pending, 'participant', 'participant'))
  const roundRun = roundRunFromWire(row.roundRun ?? row.round_run)
  const rawSessions = row.runnerSessions ?? row.runner_sessions

  const runnerSessions = rawSessions === undefined
    ? undefined
    : freezeJson(objectRow(rawSessions)) as Readonly<Record<string, string>>

  if (pending === undefined && roundRun === undefined && runnerSessions === undefined) {
    return hydrated
  }

  return Object.freeze({
    ...hydrated,
    ...(pending === undefined ? {} : { pending }),
    ...(roundRun === undefined ? {} : { roundRun }),
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
    ...(meeting.roundRun === undefined
      ? {}
      : {
          round_run: {
            participant: routeToWire(meeting.roundRun.participant),
            round: meeting.roundRun.round,
            started_at: meeting.roundRun.startedAt
          }
        }),
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
  if (transition === 'resume' && meeting.pending !== undefined) {
    throw new Error('Resume waiting participant work through the meeting round runner.')
  }

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

function meetingParticipantKey(participant: RouteIdentity): string {
  return `${participant.connectionId}::${participant.profile}`
}

function assertMeetingParticipant(meeting: MeetingRecord, participant: RouteIdentity): void {
  if (!meeting.participants.some(item => meetingParticipantKey(item) === meetingParticipantKey(participant))) {
    throw new Error('This Bot is not seated in this meeting.')
  }
}

function meetingParticipantRoute(
  participant: RouteIdentity,
  connectionModes: Record<string, 'local' | 'remote'>
) {
  const mode = connectionModes[participant.connectionId]

  if (!mode) {
    throw new Error('The participant connection mode is missing or ambiguous.')
  }

  return {
    connectionId: participant.connectionId,
    mode,
    profile: participant.profile,
    targetProfile: participant.profile
  }
}

function meetingMessageContent(value: unknown): string {
  const row = objectRow(value)
  const content = row.content ?? row.text

  if (typeof content === 'string') {return content.trim()}
  if (!Array.isArray(content)) {return ''}

  return content.map(part => {
    if (typeof part === 'string') {return part}
    const partRow = objectRow(part)

    return typeof partRow.text === 'string' ? partRow.text : ''
  }).join('').trim()
}

function meetingMessages(value: unknown): MeetingConversationMessage[] {
  if (!Array.isArray(value)) {return []}

  return value.slice(-100).flatMap(message => {
    const row = objectRow(message)
    const role = row.role
    const content = meetingMessageContent(row)

    if (!content || !['assistant', 'system', 'user'].includes(String(role))) {return []}

    return [{ content, role: role as MeetingConversationMessage['role'] }]
  })
}

function durableParticipantMessages(meeting: MeetingRecord, participant: RouteIdentity): MeetingConversationMessage[] {
  return meeting.contributions.flatMap(value => {
    const row = objectRow(value)

    if (
      meetingParticipantKey(routeFromWire(row.participant)) !== meetingParticipantKey(participant)
      || row.kind !== 'speak'
      || typeof row.text !== 'string'
      || !row.text.trim()
    ) {return []}

    return [{ content: row.text.trim(), role: 'assistant' as const }]
  }).slice(-100)
}

function publicA2AAgent(
  participant: RouteIdentity,
  agents: OperationsAgentModel[]
): OperationsAgentModel | undefined {
  return agents.find(agent =>
    agent.sourceKind === 'a2a'
    && agent.sourceId === 'a2a'
    && agent.sourceId === participant.connectionId
    && agent.profile === participant.profile
  )
}

function meetingRequestIdentity(meeting: MeetingRecord, participant: RouteIdentity): string {
  const input = JSON.stringify([
    meeting.id,
    meeting.currentRound,
    participant.connectionId,
    participant.profile
  ])
  let hash = 0xcbf29ce484222325n

  for (const byte of new TextEncoder().encode(input)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }

  return `meeting_${hash.toString(16).padStart(16, '0')}`
}

export async function getMeetingParticipantConversation(
  host: MeetingRpcHost,
  meeting: MeetingRecord,
  participant: RouteIdentity,
  connectionModes: Record<string, 'local' | 'remote'>,
  agents: OperationsAgentModel[] = [],
  requestId = ''
): Promise<MeetingConversationSnapshot> {
  assertMeetingParticipant(meeting, participant)
  const storedSessionId = meeting.runnerSessions?.[meetingParticipantKey(participant)]?.trim() || null

  const a2aAgent = publicA2AAgent(participant, agents)

  if (a2aAgent) {
    if (storedSessionId !== a2aAgent.profile) {
      throw new Error('The public A2A participant binding is missing or changed.')
    }

    const history = await getA2AChatHistory(a2aAgent.profile, requestId)
    const messages = meetingMessages(filterMeetingHistory(history.messages, meeting.id))
    const requestStatus = history.request_status ?? null

    return {
      messages: messages.length ? messages : durableParticipantMessages(meeting, participant),
      requestStatus,
      runtimeSessionId: null,
      status: ['pending', 'running', 'waiting'].includes(requestStatus ?? '') ? 'working' : 'ready',
      storedSessionId
    }
  }

  if (agents.some(agent =>
    agent.sourceKind === 'connected'
    && agent.sourceId === participant.connectionId
    && agent.profile === participant.profile
  )) {
    throw new Error('Generic connected meeting participants are unsupported.')
  }

  if (!storedSessionId) {
    return { messages: [], runtimeSessionId: null, status: 'not-started', storedSessionId: null }
  }

  const state = objectRow(await host.requestProfile<unknown>(
    meetingParticipantRoute(participant, connectionModes),
    'session.resume',
    {
      enabled_toolsets: ['clarify'],
      profile: participant.profile,
      session_id: storedSessionId,
      skip_background_review: true,
      skip_context_files: true,
      skip_memory: true,
      source: 'meeting'
    }
  ))
  const messages = meetingMessages(stripMeetingMarkers(state.messages, meeting.id))

  return {
    messages: messages.length ? messages : durableParticipantMessages(meeting, participant),
    runtimeSessionId: typeof state.session_id === 'string' && state.session_id.trim() ? state.session_id : storedSessionId,
    status: state.pending_clarify || state.pending_approval
      ? 'waiting'
      : state.inflight || state.running ? 'working' : 'ready',
    storedSessionId
  }
}

export async function injectMeetingParticipantPrompt(
  host: MeetingRpcHost,
  meeting: MeetingRecord,
  participant: RouteIdentity,
  connectionModes: Record<string, 'local' | 'remote'>,
  text: string,
  agents: OperationsAgentModel[] = [],
  requestId?: string
): Promise<MeetingConversationSnapshot> {
  const prompt = text.trim()

  if (prompt.length < 1 || prompt.length > 8_000) {
    throw new Error('Your prompt must be 1 through 8000 characters.')
  }

  assertMeetingParticipant(meeting, participant)
  const callerBinding = meeting.runnerSessions?.[meetingParticipantKey(participant)]?.trim() || null
  const authoritative = (await getMeeting(meeting.id)).meeting

  assertMeetingParticipant(authoritative, participant)

  if (authoritative.state !== 'running' && authoritative.state !== 'waiting') {
    throw new Error('The meeting is not accepting prompts.')
  }

  const authoritativeBinding = authoritative.runnerSessions?.[meetingParticipantKey(participant)]?.trim() || null

  if (!callerBinding || authoritativeBinding !== callerBinding) {
    throw new Error('The participant runner binding is missing or changed.')
  }

  const a2aAgent = publicA2AAgent(participant, agents)

  if (a2aAgent) {
    if (callerBinding !== a2aAgent.profile) {
      throw new Error('The public A2A participant binding is missing or changed.')
    }

    const requestIdentity = requestId || crypto.randomUUID()

    await sendA2AChatMessage(
      a2aAgent.profile,
      `${meetingMarker(meeting.id)}\n${prompt}`,
      requestIdentity
    )

    return getMeetingParticipantConversation(
      host,
      authoritative,
      participant,
      connectionModes,
      agents,
      requestIdentity
    )
  }

  if (agents.some(agent =>
    agent.sourceKind === 'connected'
    && agent.sourceId === participant.connectionId
    && agent.profile === participant.profile
  )) {
    throw new Error('Generic connected meeting participants are unsupported.')
  }

  const before = await getMeetingParticipantConversation(
    host,
    authoritative,
    participant,
    connectionModes,
    agents
  )
  const runtimeSessionId = before.runtimeSessionId

  if (!runtimeSessionId) {
    throw new Error('The participant runtime session is unavailable.')
  }

  try {
    await host.requestProfile(
      meetingParticipantRoute(participant, connectionModes),
      'prompt.submit',
      {
        queued: true,
        session_id: runtimeSessionId,
        text: `${meetingMarker(meeting.id)}\n${prompt}`
      }
    )
  } catch {
    throw new Error('Your prompt may have been submitted, but delivery could not be confirmed. It was not retried.')
  }

  const refreshed = await getMeetingParticipantConversation(
    host,
    authoritative,
    participant,
    connectionModes,
    agents
  )

  if (refreshed.messages.some(message => message.role === 'user' && message.content === prompt)) {
    return refreshed
  }

  return {
    ...refreshed,
    messages: [...refreshed.messages, { content: prompt, role: 'user' }]
  }
}

export interface RunMeetingRoundOptions {
  readonly agents?: OperationsAgentModel[]
  readonly now?: () => number
  readonly onParticipantStart?: (participant: RouteIdentity) => void | Promise<void>
  readonly onProgress?: (value: VersionedMeeting) => void | Promise<void>
}

export async function runMeetingRound(
  host: MeetingRpcHost,
  meeting: MeetingRecord,
  version: number,
  connectionModes: Record<string, 'local' | 'remote'>,
  options: RunMeetingRoundOptions = {}
): Promise<VersionedMeeting & { conflict: boolean; pending: unknown }> {
  const now = options.now ?? Date.now
  const nowMs = now()
  const runnableMeeting = meeting.state === 'waiting'
    ? resumeMeeting(meeting) as MeetingRecord
    : meeting

  if (isMeetingRoundRunFresh(runnableMeeting, nowMs)) {
    throw new Error('Meeting round is already running.')
  }

  const nextParticipant = runnableMeeting.participants.find(participant =>
    !runnableMeeting.contributions.some(value => {
      const row = objectRow(value)

      return row.round === runnableMeeting.currentRound
        && meetingParticipantKey(routeFromWire(row.participant)) === meetingParticipantKey(participant)
    })
  )
  let latest: VersionedMeeting = { meeting: runnableMeeting, version }

  if (nextParticipant && runnableMeeting.pending === undefined) {
    try {
      latest = await putMeeting(Object.freeze({
        ...runnableMeeting,
        roundRun: Object.freeze({
          participant: Object.freeze({ ...nextParticipant }),
          round: runnableMeeting.currentRound,
          startedAt: nowMs
        })
      }), version)
    } catch (error) {
      const row = error as { message?: unknown; status?: unknown }

      if (row.status !== 409 && !/409|conflict|version/i.test(String(row.message ?? ''))) {
        throw error
      }

      const authoritative = await getMeeting(runnableMeeting.id)

      return {
        ...authoritative,
        conflict: true,
        pending: authoritative.meeting.pending ?? null
      }
    }
  }

  let lastCheckpointMeeting: MeetingRecord | undefined

  try {
    const result = await runStructuredMeetingRound(latest.meeting, {
    sessions: latest.meeting.runnerSessions ?? {},
    onParticipantStart: async (participant: RouteIdentity) => {
      const marker = latest.meeting.roundRun
      const identicalMarker = marker?.round === latest.meeting.currentRound
        && meetingParticipantKey(marker.participant) === meetingParticipantKey(participant)

      if (!identicalMarker) {
        latest = await putMeeting(Object.freeze({
          ...latest.meeting,
          roundRun: Object.freeze({
            participant: Object.freeze({ ...participant }),
            round: latest.meeting.currentRound,
            startedAt: now()
          })
        }), latest.version)
      }

      await options.onParticipantStart?.(participant)
    },
    onCheckpoint: async (checkpoint: {
      meeting: MeetingRecord
      pending: unknown
      sessions: Readonly<Record<string, string>>
    }) => {
      const {
        pending: discardedPending,
        roundRun: discardedRoundRun,
        runnerSessions: discardedSessions,
        ...meetingWithoutRunState
      } = checkpoint.meeting

      void discardedPending
      void discardedRoundRun
      void discardedSessions

      const durableMeeting = Object.freeze({
        ...meetingWithoutRunState,
        ...(checkpoint.pending == null ? {} : { pending: checkpoint.pending }),
        runnerSessions: Object.freeze({ ...checkpoint.sessions })
      }) as MeetingRecord

      latest = await putMeeting(durableMeeting, latest.version)
      lastCheckpointMeeting = checkpoint.meeting
      await options.onProgress?.(latest)
    },
    request: async (participant: RouteIdentity, method: string, params: Record<string, unknown>) => {
      const agents = options.agents ?? []
      const a2aAgent = publicA2AAgent(participant, agents)

      if (a2aAgent) {
        const requestId = meetingRequestIdentity(latest.meeting, participant)

        if (method === 'session.create') {
          return { session_id: a2aAgent.profile, stored_session_id: a2aAgent.profile }
        }

        if (method === 'prompt.submit') {
          await sendA2AChatMessage(
            a2aAgent.profile,
            String(params.text ?? ''),
            requestId
          )

          return { ok: true }
        }

        if (method === 'session.resume') {
          const history = await getA2AChatHistory(a2aAgent.profile, requestId)
          const messages = filterMeetingHistory(history.messages, latest.meeting.id)
          const requestStatus = history.request_status ?? null
          const active = requestStatus === 'pending' || requestStatus === 'running'

          return {
            inflight: active,
            messages,
            ...(requestStatus === 'waiting'
              ? {
                  pending_clarify: {
                    participant: { ...participant },
                    requestId
                  }
                }
              : {}),
            running: active,
            session_id: a2aAgent.profile
          }
        }

        throw new Error(`Unsupported public A2A meeting method: ${method}`)
      }

      if (agents.some(agent =>
        agent.sourceKind === 'connected'
        && agent.sourceId === participant.connectionId
        && agent.profile === participant.profile
      )) {
        throw new Error('Generic connected meeting participants are unsupported.')
      }

      return host.requestProfile(
        meetingParticipantRoute(participant, connectionModes),
        method,
        params
      )
    }
  })

  if (result.meeting !== lastCheckpointMeeting) {
    const {
      pending: discardedPending,
      roundRun: discardedRoundRun,
      runnerSessions: discardedSessions,
      ...meetingWithoutRunState
    } = result.meeting

    void discardedPending
    void discardedRoundRun
    void discardedSessions

    latest = await putMeeting(Object.freeze({
      ...meetingWithoutRunState,
      ...(result.pending == null ? {} : { pending: result.pending }),
      runnerSessions: Object.freeze({ ...result.sessions })
    }) as MeetingRecord, latest.version)
    await options.onProgress?.(latest)
  }

    return { ...latest, conflict: false, pending: result.pending }
  } catch (error) {
    if (nextParticipant && latest.meeting.roundRun) {
      const { roundRun: discardedRoundRun, ...meetingWithoutRoundRun } = latest.meeting

      void discardedRoundRun

      try {
        await putMeeting(Object.freeze(meetingWithoutRoundRun) as MeetingRecord, latest.version)
      } catch {
        // Cleanup is a single best-effort CAS. Preserve the original native error.
      }
    }

    throw error
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
    meetingParticipantRoute(payload.route, connectionModes),
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
