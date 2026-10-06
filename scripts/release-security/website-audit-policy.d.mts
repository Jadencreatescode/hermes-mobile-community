export interface WebsiteAuditPolicyResult {
  errors: string[]
  passed: boolean
}

export function evaluateWebsiteAuditReport(
  report: Record<string, unknown>
): WebsiteAuditPolicyResult
