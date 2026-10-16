export type MailUrgency = 'normal' | 'priority' | 'critical'
export type MailStatus = 'queued' | 'delivered' | 'acknowledged' | 'failed' | 'expired' | 'cancelled'

export interface MailHistoryEvent {
  at: number
  sequence: number
  status: MailStatus
}

export interface MailEnvelope {
  body: string
  createdAt: number
  dedupeKey?: string
  duplicate: boolean
  history: MailHistoryEvent[]
  id: string
  sessionRef?: string
  sourceProfile: string
  status: MailStatus
  targetProfile: string
  updatedAt: number
  urgency: MailUrgency
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const URGENCIES = new Set<MailUrgency>(['normal', 'priority', 'critical'])
const STATUSES = new Set<MailStatus>(['queued', 'delivered', 'acknowledged', 'failed', 'expired', 'cancelled'])

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function required(value: unknown, label: string, pattern: RegExp): string {
  const result = typeof value === 'string' ? value : ''

  if (!pattern.test(result)) {
    throw new Error(`${label} is invalid`)
  }

  return result
}

function boundedBody(value: unknown): string {
  const body = typeof value === 'string' ? value : ''

  if (!body || body.length > 4_000) {
    throw new Error('Mailroom body is invalid')
  }

  return body
}

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function optionalReference(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    return undefined
  }

  return value
}

export function normalizeMailEnvelope(value: unknown): MailEnvelope {
  const row = record(value)
  const sourceProfile = required(row.source_profile ?? row.sourceProfile, 'source profile', PROFILE_RE)
  const targetProfile = required(row.target_profile ?? row.targetProfile, 'target profile', PROFILE_RE)
  const urgency = URGENCIES.has(row.urgency as MailUrgency) ? row.urgency as MailUrgency : 'normal'
  const status = STATUSES.has(row.status as MailStatus) ? row.status as MailStatus : 'queued'
  const rawHistory = Array.isArray(row.history) ? row.history.slice(0, 32) : []

  const history = rawHistory.flatMap<MailHistoryEvent>(entry => {
    const event = record(entry)
    const eventStatus = STATUSES.has(event.status as MailStatus) ? event.status as MailStatus : null

    const sequence = typeof event.sequence === 'number' && Number.isInteger(event.sequence) && event.sequence > 0
      ? event.sequence
      : 0

    if (!eventStatus || sequence === 0) {
      return []
    }

    return [{ at: finiteTimestamp(event.at), sequence, status: eventStatus }]
  })

  const sessionRef = optionalReference(row.session_ref ?? row.sessionRef)
  const dedupeKey = optionalReference(row.dedupe_key ?? row.dedupeKey)

  return {
    id: required(row.id, 'Mailroom id', ID_RE),
    sourceProfile,
    targetProfile,
    body: boundedBody(row.body),
    urgency,
    status,
    createdAt: finiteTimestamp(row.created_at ?? row.createdAt),
    updatedAt: finiteTimestamp(row.updated_at ?? row.updatedAt),
    ...(sessionRef ? { sessionRef } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    duplicate: row.duplicate === true,
    history
  }
}
