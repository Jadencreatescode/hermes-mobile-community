export interface WebsiteAuditPolicyResult {
  errors: string[]
  passed: boolean
}

export function validateWebsiteLock(lock: Record<string, unknown>): string[]

export function evaluateWebsiteAuditReport(
  report: Record<string, unknown>,
  lock: Record<string, unknown>
): WebsiteAuditPolicyResult
