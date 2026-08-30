import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import {
  acknowledgeMail,
  cancelMail,
  getMail,
  listMail,
  putCriticalPolicy,
  retryMail,
  sendMail
} from './mailroom'

const wire = {
  id: 'mail_1',
  source_profile: 'planner',
  target_profile: 'builder',
  body: 'Review release.',
  urgency: 'normal',
  status: 'queued',
  created_at: 10,
  updated_at: 10,
  session_ref: null,
  dedupe_key: null,
  duplicate: false,
  history: [{ sequence: 1, status: 'queued', at: 10 }]
}

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
})

describe('Operations Mailroom client', () => {
  it('uses only the plugin REST namespace for public Mailroom reads and mutations', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/mailroom?')) {
        return { envelopes: [wire] }
      }
      if (path === '/mailroom/mail_1') {
        return { envelope: wire }
      }
      if (path === '/mailroom/critical-policy') {
        return { source_profile: 'planner', target_profile: 'builder', created_at: 10, expires_at: 70 }
      }
      return { envelope: wire, delivery: { status: 'started', to: 'builder', process_id: 'strip-me' } }
    })
    unbind = bindOperationsApi(rest as never)

    expect(await listMail({ status: 'queued', limit: 10 })).toHaveLength(1)
    expect(await getMail('mail_1')).toMatchObject({ id: 'mail_1' })
    await sendMail({ sourceProfile: 'planner', targetProfile: 'builder', body: 'Review release.' })
    await retryMail('mail_1')
    await acknowledgeMail('mail_1')
    await cancelMail('mail_1')
    expect(await putCriticalPolicy('planner', 'builder', 60)).toMatchObject({ expiresAt: 70 })

    expect(rest).toHaveBeenCalledWith('/mailroom?status=queued&limit=10')
    expect(rest).toHaveBeenCalledWith('/mailroom', expect.objectContaining({ method: 'POST' }))
    expect(rest).toHaveBeenCalledWith('/mailroom/mail_1/retry', { method: 'POST' })
    expect(rest).toHaveBeenCalledWith('/mailroom/mail_1/acknowledge', { method: 'POST' })
    expect(rest).toHaveBeenCalledWith('/mailroom/mail_1/cancel', { method: 'POST' })
    expect(JSON.stringify(await sendMail({ sourceProfile: 'planner', targetProfile: 'builder', body: 'Again.' }))).not.toContain('process_id')
  })

  it('validates ids and bounded input before any request', async () => {
    const rest = vi.fn()
    unbind = bindOperationsApi(rest as never)

    await expect(getMail('../secret')).rejects.toThrow()
    await expect(sendMail({ sourceProfile: 'planner', targetProfile: 'builder', body: '' })).rejects.toThrow()
    await expect(putCriticalPolicy('planner', 'builder', 86_400)).rejects.toThrow()
    expect(rest).not.toHaveBeenCalled()
  })
})
