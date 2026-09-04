import { mapOperationsAgentState, type OperationsAgentState, type OperationsAssignmentEvidence } from './state'

interface RosterAgent {
  connectionId: string
  connectionKind: string
  connectionLabel: string
  handle: string
  profile: string
}

interface RosterSource {
  connectionId: string
  error?: string
  kind: string
  label: string
  reachable: boolean
}

interface OperationsHost {
  agents(): Promise<{ agents: RosterAgent[]; sources: RosterSource[] }>
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>
  requestProfile<T>(
    route: { connectionId: string; mode: 'local' | 'remote'; profile: string; targetProfile: string },
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>
  status(): Promise<unknown>
}

interface SessionSummary {
  id?: string
  preview?: string
  resolved_id?: string
  title?: string
}

interface ProfileSummary {
  canonical_session?: SessionSummary | null
  display_name?: string
  last_session?: SessionSummary | null
  name?: string
  ui_meta?: Record<string, { title?: string }>
  worker_session?: { last_active?: number } | null
}

interface LiveSession {
  id?: string
  preview?: string
  session_key?: string
  status?: string
  title?: string
}

interface DelegatedAgentEvidence {
  status?: string
}

interface CliResult {
  blocked?: boolean
  code?: number
  output?: string
}

interface KanbanTask {
  assignee?: string
  diagnostics?: Array<{ resolved?: boolean; severity?: string }>
  id?: string
  latest_summary?: string
  status?: string
  title?: string
}

export interface OperationsSourceModel {
  error?: string
  id: string
  kind: string
  label: string
  reachable: boolean
  status: 'degraded' | 'offline' | 'online'
}

export interface OperationsAgentModel {
  assignments: Array<{ id: string; status: string; summary: string; title: string }>
  displayName: string
  id: string
  openSessionId?: string
  openSessionKind?: 'bot-chat' | 'session'
  profile: string
  sourceId: string
  sourceKind: string
  sourceLabel: string
  state: OperationsAgentState
  workSummary: string
}

export interface OperationsSnapshot {
  agents: OperationsAgentModel[]
  partialFailures: string[]
  sources: OperationsSourceModel[]
}

function parseCliList<T>(value: unknown): T[] {
  const result = value as CliResult | undefined

  if (!result || result.blocked || result.code !== 0) {
    throw new Error(result?.output || 'Kanban read failed')
  }

  const parsed = JSON.parse(result.output || '[]')

  return Array.isArray(parsed) ? parsed : []
}

function displayName(profile: ProfileSummary | undefined, agent: RosterAgent): string {
  const botTitle = profile?.ui_meta?.['hermes-bots']?.title?.trim()
  const named = botTitle || profile?.display_name?.trim()

  if (named) {return named}

  if (agent.profile === 'default') {return agent.connectionLabel || 'Hermes'}

  return agent.profile.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function routeFor(agent: RosterAgent) {
  return {
    connectionId: agent.connectionId,
    mode: (agent.connectionKind === 'local' ? 'local' : 'remote') as 'local' | 'remote',
    profile: agent.profile,
    targetProfile: agent.profile
  }
}

export async function loadOperationsSnapshot(
  host: OperationsHost,
  options: {
    delegatedBySession?: Record<string, DelegatedAgentEvidence[]>
    nowMs?: number
  } = {}
): Promise<OperationsSnapshot> {
  const [rosterResult, statusResult] = await Promise.allSettled([host.agents(), host.status()])

  if (rosterResult.status === 'rejected') {
    throw rosterResult.reason instanceof Error ? rosterResult.reason : new Error('Agent roster unavailable')
  }

  const roster = rosterResult.value

  const partialFailures = roster.sources
    .filter(source => !source.reachable || source.error)
    .map(source => `${source.label}: ${source.error || 'unreachable'}`)

  if (statusResult.status === 'rejected') {partialFailures.push('Hermes status unavailable')}

  const degraded = new Set<string>()

  const agents = await Promise.all(
    roster.agents.map(async agent => {
      const route = routeFor(agent)
      let profile: ProfileSummary | undefined
      let live: LiveSession[] = []
      let tasks: KanbanTask[] = []
      let detailsReachable = true

      try {
        const [profilesResult, sessionsResult, tasksResult, diagnosticsResult] = await Promise.all([
          host.requestProfile<{ profiles?: ProfileSummary[] }>(route, 'profiles.list', { include_sessions: true }),
          host.requestProfile<{ sessions?: LiveSession[] }>(route, 'session.active_list', {}),
          host.requestProfile<{ tasks?: KanbanTask[]; count?: number }>(route, 'kanban.board', { assignee: agent.profile }),
          host.requestProfile<{ diagnostics?: Array<{ task_id?: string; diagnostics?: Array<{ resolved?: boolean; severity?: string }> }>; count?: number }>(route, 'kanban.diagnostics', {})
        ])

        profile = profilesResult.profiles?.find(row => row.name === agent.profile)
        live = sessionsResult.sessions ?? []
        tasks = (tasksResult.tasks ?? []).filter(task => task.assignee === agent.profile)

        const diagnosticsRows = diagnosticsResult.diagnostics ?? []

        const byTask = new Map(diagnosticsRows.map(row => [row.task_id, row.diagnostics ?? []]))
        tasks = tasks.map(task => ({ ...task, diagnostics: byTask.get(task.id) ?? task.diagnostics }))
      } catch (error) {
        detailsReachable = false
        degraded.add(agent.connectionId)
        partialFailures.push(`${agent.connectionLabel} / ${agent.profile}: ${error instanceof Error ? error.message : String(error)}`)
      }

      const canonical = profile?.canonical_session || undefined
      const related = live.find(session => session.status === 'waiting' || session.status === 'working')
      const fallback = profile?.last_session || undefined

      const ownerSessionIds = new Set(
        [
          canonical?.id,
          canonical?.resolved_id,
          fallback?.id,
          ...live.flatMap(session => [session.id, session.session_key])
        ].filter((id): id is string => Boolean(id))
      )

      const activeDelegation = [...ownerSessionIds].some(sessionId =>
        options.delegatedBySession?.[sessionId]?.some(item => item.status === 'queued' || item.status === 'running')
      )

      const assignments: OperationsAssignmentEvidence[] = tasks.map(task => ({
        diagnostics: task.diagnostics,
        status: task.status
      }))

      const state = mapOperationsAgentState({
        activeDelegation,
        activeSession: related?.status === 'working',
        assignments,
        nowMs: options.nowMs,
        pendingInput: related?.status === 'waiting',
        sourceReachable: detailsReachable,
        workerHeartbeatAt: profile?.worker_session?.last_active
      })

      const assignment = tasks.find(task => task.status === 'blocked') || tasks.find(task => task.status === 'review') || tasks[0]
      const openSessionId = canonical?.resolved_id || canonical?.id || related?.session_key || fallback?.id

      return {
        assignments: tasks.map(task => ({
          id: task.id || `${agent.connectionId}:${agent.profile}:${task.title || 'task'}`,
          status: task.status || 'unknown',
          summary: task.latest_summary || '',
          title: task.title || 'Untitled task'
        })),
        displayName: displayName(profile, agent),
        id: `${agent.connectionId}::${agent.profile}`,
        ...(openSessionId ? { openSessionId } : {}),
        ...(openSessionId ? { openSessionKind: canonical ? ('bot-chat' as const) : ('session' as const) } : {}),
        profile: agent.profile,
        sourceId: agent.connectionId,
        sourceKind: agent.connectionKind,
        sourceLabel: agent.connectionLabel,
        state,
        workSummary:
          canonical?.preview || related?.preview || assignment?.latest_summary || assignment?.title || fallback?.preview || 'No active work'
      }
    })
  )

  const sources = roster.sources.map(source => ({
    error: source.error,
    id: source.connectionId,
    kind: source.kind,
    label: source.label,
    reachable: source.reachable,
    status: (!source.reachable ? 'offline' : degraded.has(source.connectionId) ? 'degraded' : 'online') as
      | 'degraded'
      | 'offline'
      | 'online'
  }))

  return { agents, partialFailures: [...new Set(partialFailures)], sources }
}
