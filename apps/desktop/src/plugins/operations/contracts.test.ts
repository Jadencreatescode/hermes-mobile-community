import { describe, expect, it } from 'vitest'

import { normalizeMailEnvelope } from './contracts'

describe('public Operations wire contracts', () => {
  it('allowlists Mailroom fields and strips commands, credentials, endpoints, and process handles', () => {
    const envelope = normalizeMailEnvelope({
      id: 'mail_1',
      source_profile: 'planner',
      target_profile: 'builder',
      body: 'Review the release.',
      urgency: 'priority',
      status: 'queued',
      created_at: 10,
      updated_at: 11,
      session_ref: 'session-1',
      dedupe_key: 'review-1',
      history: [{ sequence: 1, status: 'queued', at: 10, token: 'secret' }],
      command: 'hermes -p builder chat',
      process_id: 'proc-private',
      endpoint: 'https://private.invalid',
      credential: 'secret'
    })

    expect(envelope).toEqual({
      id: 'mail_1',
      sourceProfile: 'planner',
      targetProfile: 'builder',
      body: 'Review the release.',
      urgency: 'priority',
      status: 'queued',
      createdAt: 10,
      updatedAt: 11,
      sessionRef: 'session-1',
      dedupeKey: 'review-1',
      duplicate: false,
      history: [{ sequence: 1, status: 'queued', at: 10 }]
    })
    expect(JSON.stringify(envelope)).not.toContain('secret')
    expect(JSON.stringify(envelope)).not.toContain('proc-private')
    expect(JSON.stringify(envelope)).not.toContain('private.invalid')
  })

  it('fails closed to safe enum defaults while rejecting missing identity', () => {
    expect(() => normalizeMailEnvelope({ id: '', source_profile: 'planner', target_profile: 'builder' })).toThrow()
    expect(() => normalizeMailEnvelope({ id: 'mail_1', source_profile: '', target_profile: 'builder' })).toThrow()
  })
})
