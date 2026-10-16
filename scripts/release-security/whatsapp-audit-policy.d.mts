export interface ProductionAuditPolicyResult {
  errors: string[]
  passed: boolean
}

export function validateWhatsAppLock(lock: Record<string, unknown>): string[]

export function evaluateProductionAuditReport(
  report: Record<string, unknown>,
  lock: Record<string, unknown>
): ProductionAuditPolicyResult
