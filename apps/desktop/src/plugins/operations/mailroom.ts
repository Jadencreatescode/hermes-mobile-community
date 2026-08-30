import { operationsApi } from './api'
import { normalizeMailEnvelope, type MailEnvelope, type MailStatus, type MailUrgency } from './contracts'

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

function profile(value: string, label: string): string {
  const normalized = String(value ?? '').trim()
  if (!PROFILE_RE.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function id(value: string): string {
  const normalized = String(value ?? '').trim()
  if (!ID_RE.test(normalized)) {
    throw new Error('Mailroom id is invalid')
  }
  return normalized
}

function body(value: string): string {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 4_000) {
    throw new Error('Mailroom body is invalid')
  }
  return normalized
}

function optionalReference(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = String(value).trim()
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

export async function listMail(options: { limit?: number; status?: MailStatus } = {}): Promise<MailEnvelope[]> {
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Mailroom limit is invalid')
  }
  const query = new URLSearchParams()
  if (options.status) {
    query.set('status', options.status)
  }
  query.set('limit', String(limit))
  const response = await operationsApi()<{ envelopes?: unknown[] }>(`/mailroom?${query.toString()}`)
  return (response.envelopes ?? []).map(normalizeMailEnvelope)
}

export async function getMail(envelopeId: string): Promise<MailEnvelope> {
  const response = await operationsApi()<{ envelope: unknown }>(`/mailroom/${id(envelopeId)}`)
  return normalizeMailEnvelope(response.envelope)
}

export async function sendMail(input: {
  body: string
  dedupeKey?: string
  sessionRef?: string
  sourceProfile: string
  targetProfile: string
  urgency?: MailUrgency
}): Promise<{ delivery: { status: string; to: string }; envelope: MailEnvelope }> {
  const response = await operationsApi()<{
    delivery?: { status?: unknown; to?: unknown }
    envelope: unknown
  }>('/mailroom', {
    method: 'POST',
    body: {
      source_profile: profile(input.sourceProfile, 'source profile'),
      target_profile: profile(input.targetProfile, 'target profile'),
      body: body(input.body),
      urgency: input.urgency ?? 'normal',
      ...(optionalReference(input.sessionRef, 'session reference') ? { session_ref: optionalReference(input.sessionRef, 'session reference') } : {}),
      ...(optionalReference(input.dedupeKey, 'dedupe key') ? { dedupe_key: optionalReference(input.dedupeKey, 'dedupe key') } : {})
    }
  })

  return {
    envelope: normalizeMailEnvelope(response.envelope),
    delivery: {
      status: typeof response.delivery?.status === 'string' ? response.delivery.status : 'unknown',
      to: typeof response.delivery?.to === 'string' ? response.delivery.to : ''
    }
  }
}

async function transitionMail(envelopeId: string, action: 'acknowledge' | 'cancel' | 'retry'): Promise<MailEnvelope> {
  const response = await operationsApi()<{ envelope: unknown }>(`/mailroom/${id(envelopeId)}/${action}`, { method: 'POST' })
  return normalizeMailEnvelope(response.envelope)
}

export const retryMail = (envelopeId: string) => transitionMail(envelopeId, 'retry')
export const acknowledgeMail = (envelopeId: string) => transitionMail(envelopeId, 'acknowledge')
export const cancelMail = (envelopeId: string) => transitionMail(envelopeId, 'cancel')

export async function putCriticalPolicy(
  sourceProfile: string,
  targetProfile: string,
  ttlSeconds: number
): Promise<{ createdAt: number; expiresAt: number; sourceProfile: string; targetProfile: string }> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3_600) {
    throw new Error('Critical policy lifetime is invalid')
  }
  const response = await operationsApi()<Record<string, unknown>>('/mailroom/critical-policy', {
    method: 'PUT',
    body: {
      source_profile: profile(sourceProfile, 'source profile'),
      target_profile: profile(targetProfile, 'target profile'),
      ttl_seconds: ttlSeconds
    }
  })
  return {
    sourceProfile: profile(String(response.source_profile ?? ''), 'source profile'),
    targetProfile: profile(String(response.target_profile ?? ''), 'target profile'),
    createdAt: typeof response.created_at === 'number' ? response.created_at : 0,
    expiresAt: typeof response.expires_at === 'number' ? response.expires_at : 0
  }
}
