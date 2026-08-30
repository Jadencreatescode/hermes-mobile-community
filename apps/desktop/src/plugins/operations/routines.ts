interface OperationsConnection {
  id: string
  kind: string
  label: string
}

export interface OperationsProfileRoute {
  connectionId: string
  mode: 'local' | 'remote'
  profile: string
  targetProfile: string
}

interface OperationsRoutinesHost {
  connections(): Promise<OperationsConnection[]>
  profileRoutes(): Promise<OperationsProfileRoute[]>
  requestProfile(
    route: OperationsProfileRoute,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>
}

interface RoutineJob {
  enabled?: boolean
  job_id?: string
  name?: string
  schedule?: string
}

export interface OperationsRoutineModel {
  connectionId: string
  connectionLabel: string
  enabled?: boolean
  jobId: string
  name: string
  profile: string
  schedule?: string
  targetProfile: string
}

export interface OperationsRoutineFailure {
  connectionId: string
  connectionLabel: string
  error: string
  profile?: string
  targetProfile?: string
}

export interface OperationsRoutinesSnapshot {
  failures: OperationsRoutineFailure[]
  routines: OperationsRoutineModel[]
  successfulSources: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function operationsRoutineEmptyMessage(snapshot: OperationsRoutinesSnapshot): string {
  if (snapshot.failures.length > 0) {
    const sources = snapshot.failures
      .map(failure => failure.profile ? `${failure.connectionLabel} / @${failure.profile}` : failure.connectionLabel)
      .join(', ')

    return `Routine reads failed for ${sources}.`
  }

  return 'No routines are configured across reachable profiles.'
}

export async function loadOperationsRoutines(host: OperationsRoutinesHost): Promise<OperationsRoutinesSnapshot> {
  const [connections, routes] = await Promise.all([host.connections(), host.profileRoutes()])
  const connectionById = new Map(connections.map(connection => [connection.id, connection]))
  const routedConnections = new Set(routes.map(route => route.connectionId))

  const failures: OperationsRoutineFailure[] = connections
    .filter(connection => !routedConnections.has(connection.id))
    .map(connection => ({
      connectionId: connection.id,
      connectionLabel: connection.label,
      error: 'Profile inventory unavailable'
    }))

  const routines: OperationsRoutineModel[] = []
  let successfulSources = 0

  const results = await Promise.allSettled(
    routes.map(route =>
      host.requestProfile(route, 'cron.manage', { action: 'list', include_disabled: true })
    )
  )

  for (const [index, result] of results.entries()) {
    const route = routes[index]
    const connectionLabel = connectionById.get(route.connectionId)?.label ?? route.connectionId

    if (result.status === 'rejected') {
      failures.push({
        connectionId: route.connectionId,
        connectionLabel,
        error: errorMessage(result.reason),
        profile: route.profile,
        targetProfile: route.targetProfile
      })

      continue
    }

    successfulSources += 1
    const response = result.value as { jobs?: RoutineJob[] } | undefined

    for (const [jobIndex, job] of (response?.jobs ?? []).entries()) {
      routines.push({
        connectionId: route.connectionId,
        connectionLabel,
        enabled: job.enabled,
        jobId: job.job_id || `${route.connectionId}:${route.profile}:${jobIndex}`,
        name: job.name || 'Routine',
        profile: route.profile,
        schedule: job.schedule,
        targetProfile: route.targetProfile
      })
    }
  }

  return { failures, routines, successfulSources }
}
