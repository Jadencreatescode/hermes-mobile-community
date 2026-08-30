import { Button, Loader, Textarea } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MailEnvelope, MailStatus, MailUrgency } from './contracts'
import {
  acknowledgeMail,
  cancelMail,
  listMail,
  putCriticalPolicy,
  retryMail,
  sendMail
} from './mailroom'

const STATUS_OPTIONS: Array<{ label: string; value: '' | MailStatus }> = [
  { label: 'All', value: '' },
  { label: 'Queued', value: 'queued' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Acknowledged', value: 'acknowledged' },
  { label: 'Failed', value: 'failed' },
  { label: 'Expired', value: 'expired' },
  { label: 'Cancelled', value: 'cancelled' }
]

export function MailroomView({ activeProfile, profiles }: { activeProfile: string; profiles: string[] }) {
  const uniqueProfiles = useMemo(() => [...new Set(profiles.filter(Boolean))], [profiles])
  const defaultTarget = uniqueProfiles.find(profile => profile !== activeProfile) ?? ''
  const [target, setTarget] = useState(defaultTarget)
  const [urgency, setUrgency] = useState<MailUrgency>('normal')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'' | MailStatus>('')
  const [rows, setRows] = useState<MailEnvelope[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [criticalConfirmed, setCriticalConfirmed] = useState(false)
  const [criticalExpiry, setCriticalExpiry] = useState(0)
  const [criticalNow, setCriticalNow] = useState(() => Date.now() / 1000)
  const criticalExpired = criticalExpiry > 0 && criticalExpiry <= criticalNow
  const criticalLive = criticalExpiry > criticalNow

  useEffect(() => {
    if (!target || target === activeProfile || !uniqueProfiles.includes(target)) {
      setTarget(defaultTarget)
    }
  }, [activeProfile, defaultTarget, target, uniqueProfiles])

  useEffect(() => {
    setCriticalConfirmed(false)
    setCriticalExpiry(0)
  }, [activeProfile, target])

  useEffect(() => {
    setCriticalNow(Date.now() / 1000)

    if (criticalExpiry <= 0) {
      return
    }

    const timer = window.setInterval(() => setCriticalNow(Date.now() / 1000), 1_000)

    return () => window.clearInterval(timer)
  }, [criticalExpiry])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      setRows(await listMail({ limit: 100, ...(status ? { status } : {}) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const approveCritical = async () => {
    if (!criticalConfirmed || !target || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const policy = await putCriticalPolicy(activeProfile, target, 3_600)
      setCriticalExpiry(policy.expiresAt)
      setCriticalNow(Date.now() / 1000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!target || !message.trim() || busy || (urgency === 'critical' && !criticalLive)) {
      return
    }

    setBusy(true)
    setError('')

    try {
      await sendMail({
        sourceProfile: activeProfile,
        targetProfile: target,
        body: message,
        urgency
      })
      setMessage('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const transition = async (row: MailEnvelope, action: 'acknowledge' | 'cancel' | 'retry') => {
    setBusy(true)
    setError('')

    try {
      if (action === 'acknowledge') {
        await acknowledgeMail(row.id)
      } else if (action === 'cancel') {
        await cancelMail(row.id)
      } else {
        await retryMail(row.id)
      }

      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(20rem,1.1fr)]">
      <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary)">
        <header className="border-b border-(--ui-stroke-tertiary) p-3">
          <h2 className="text-sm font-semibold">Mailroom</h2>
          <p className="text-xs text-(--ui-text-tertiary)">Durable, ordered Bot correspondence</p>
        </header>
        <div className="space-y-3 border-b border-(--ui-stroke-tertiary) p-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span>Target</span>
              <select
                aria-label="Mailroom target"
                className="min-h-11 w-full min-w-0 rounded-md border border-(--ui-stroke-secondary) bg-background px-3 text-sm"
                onChange={event => setTarget(event.currentTarget.value)}
                value={target}
              >
                {uniqueProfiles.filter(profile => profile !== activeProfile).map(profile => (
                  <option key={profile} value={profile}>{profile}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span>Urgency</span>
              <select
                aria-label="Mailroom urgency"
                className="min-h-11 w-full min-w-0 rounded-md border border-(--ui-stroke-secondary) bg-background px-3 text-sm"
                onChange={event => setUrgency(event.currentTarget.value as MailUrgency)}
                value={urgency}
              >
                <option value="normal">Normal</option>
                <option value="priority">Priority</option>
                <option value="critical">Critical</option>
              </select>
            </label>
          </div>
          <label className="space-y-1 text-xs">
            <span>Message</span>
            <Textarea
              aria-label="Mailroom message"
              maxLength={4_000}
              onChange={event => setMessage(event.currentTarget.value)}
              placeholder="Message a Bot through durable Mailroom"
              rows={4}
              value={message}
            />
          </label>
          {urgency === 'critical' && (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  aria-label={`I approve Critical delivery from ${activeProfile} to ${target} for one hour.`}
                  checked={criticalConfirmed}
                  className="size-5"
                  onChange={event => setCriticalConfirmed(event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>I approve this exact Critical route for one hour. It requests a cooperative checkpoint and never forcibly cancels work.</span>
              </label>
              <Button
                className="min-h-11 w-full"
                disabled={!criticalConfirmed || !target || busy}
                onClick={() => void approveCritical()}
                variant="outline"
              >
                Approve Critical route for one hour
              </Button>
              {criticalExpiry > 0 && !criticalExpired && (
                <p>Critical route approved until {new Date(criticalExpiry * 1000).toLocaleTimeString()}.</p>
              )}
              {criticalExpired && (
                <p role="status">Critical route approval expired. Approve this exact route again.</p>
              )}
            </div>
          )}
          <Button
            className="min-h-11 w-full"
            disabled={!target || !message.trim() || busy || (urgency === 'critical' && !criticalLive)}
            onClick={() => void send()}
          >
            Send through Mailroom
          </Button>
        </div>
      </section>

      <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary)">
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) p-3">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <span>Status</span>
            <select
              aria-label="Mailroom status"
              className="min-h-11 min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-background px-3 text-sm"
              onChange={event => setStatus(event.currentTarget.value as '' | MailStatus)}
              value={status}
            >
              {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button className="min-h-11" disabled={loading} onClick={() => void refresh()} variant="ghost">Refresh</Button>
        </header>
        {error && <p className="border-b border-destructive/40 p-3 text-sm text-destructive" role="alert">{error}</p>}
        {loading ? (
          <div className="grid min-h-40 place-items-center"><Loader label="Loading Mailroom" /></div>
        ) : error ? null : rows.length > 0 ? (
          <div className="max-h-[60vh] overflow-y-auto">
            {rows.map(row => (
              <article className="min-w-0 border-b border-(--ui-stroke-tertiary) p-3 last:border-b-0" key={row.id}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium">@{row.sourceProfile} → @{row.targetProfile}</span>
                  <span>{row.urgency} · {row.status}</span>
                </div>
                <p className="mt-2 break-words text-sm">{row.body}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {row.status === 'failed' && <Button className="min-h-11" disabled={busy} onClick={() => void transition(row, 'retry')} size="sm" variant="outline">Retry</Button>}
                  {row.status === 'queued' && <Button className="min-h-11" disabled={busy} onClick={() => void transition(row, 'cancel')} size="sm" variant="outline">Cancel</Button>}
                  {row.status === 'delivered' && <Button className="min-h-11" disabled={busy} onClick={() => void transition(row, 'acknowledge')} size="sm" variant="outline">Acknowledge</Button>}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-(--ui-text-tertiary)">No Mailroom messages yet.</p>
        )}
      </section>
    </div>
  )
}
