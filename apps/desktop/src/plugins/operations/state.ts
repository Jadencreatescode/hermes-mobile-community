export const OPERATIONS_STATES = ['idle', 'working', 'waiting', 'blocked', 'reviewing', 'unknown'] as const

export type OperationsAgentState = (typeof OPERATIONS_STATES)[number]

export interface OperationsDiagnosticEvidence {
  resolved?: boolean
  severity?: string
}

export interface OperationsAssignmentEvidence {
  diagnostics?: OperationsDiagnosticEvidence[]
  status?: string
}

export interface OperationsAgentEvidence {
  activeDelegation?: boolean
  activeSession?: boolean
  assignments?: OperationsAssignmentEvidence[]
  nowMs?: number
  pendingInput?: boolean
  sourceReachable: boolean
  workerHeartbeatAt?: number
}

export const OPERATIONS_WORKER_ACTIVE_WINDOW_MS = 150_000

export function mapOperationsAgentState(evidence: OperationsAgentEvidence): OperationsAgentState {
  if (!evidence.sourceReachable) {
    return 'unknown'
  }

  if (evidence.pendingInput) {
    return 'waiting'
  }

  const assignments = evidence.assignments ?? []
  const blocked = assignments.some(
    assignment =>
      assignment.status === 'blocked' ||
      assignment.diagnostics?.some(diagnostic => diagnostic.severity === 'critical' && diagnostic.resolved !== true)
  )

  if (blocked) {
    return 'blocked'
  }

  if (assignments.some(assignment => assignment.status === 'review')) {
    return 'reviewing'
  }

  const nowMs = evidence.nowMs ?? Date.now()
  const heartbeatMs = Number(evidence.workerHeartbeatAt || 0) * 1000
  const freshWorker =
    heartbeatMs > 0 && nowMs >= heartbeatMs && nowMs - heartbeatMs < OPERATIONS_WORKER_ACTIVE_WINDOW_MS

  if (evidence.activeSession || evidence.activeDelegation || freshWorker) {
    return 'working'
  }

  return 'idle'
}
