export interface AuditPolicyResult {
  errors: string[]
  passed: boolean
}

export function evaluateAuditReport(
  report: Record<string, unknown>,
  lock: Record<string, unknown>
): AuditPolicyResult
