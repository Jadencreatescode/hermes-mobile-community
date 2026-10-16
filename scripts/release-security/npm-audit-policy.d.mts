export interface AuditPolicyResult {
  errors: string[]
  passed: boolean
}

export function validateRootLock(lock: Record<string, unknown>): string[]

export function evaluateAuditReport(
  report: Record<string, unknown>,
  lock: Record<string, unknown>
): AuditPolicyResult
