import { Badge, Button, EmptyState, host, Input, Textarea } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OperationsSnapshot } from './data'
import {
  convertMeetingActions,
  createMeetingDraft,
  listMeetings,
  type MeetingRecord,
  persistMeetingTransition,
  putMeeting,
  type RouteIdentity,
  runMeetingRound,
  type VersionedMeeting
} from './meetings'

function routeKey(route: RouteIdentity): string {
  return `${route.connectionId}::${route.profile}`
}

function newMeetingId(): string {
  return `meeting_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function MeetingsView({ snapshot }: { snapshot: OperationsSnapshot }) {
  const options = useMemo(
    () => snapshot.agents.map(agent => ({
      connectionId: agent.sourceId,
      profile: agent.profile,
      label: `${agent.displayName} · ${agent.sourceLabel}`
    })),
    [snapshot.agents]
  )

  const [meetings, setMeetings] = useState<VersionedMeeting[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [maxRounds, setMaxRounds] = useState(3)
  const [decision, setDecision] = useState('')
  const [dissent, setDissent] = useState('')
  const [actionTitle, setActionTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const selected = meetings.find(item => item.meeting.id === selectedId) ?? null

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      setMeetings(await listMeetings())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const replaceMeeting = (saved: VersionedMeeting) => {
    setMeetings(current => {
      const existing = current.some(item => item.meeting.id === saved.meeting.id)

      return existing
        ? current.map(item => item.meeting.id === saved.meeting.id ? saved : item)
        : [saved, ...current]
    })
  }

  const create = async () => {
    const routes = options.filter(option => selectedParticipants.includes(routeKey(option)))

    if (!title.trim() || !agenda.trim() || routes.length < 2 || routes.length > 6) {
      setError('Add a title, an agenda, and two to six source-qualified participants.')

      return
    }

    setBusy(true)
    setError('')

    try {
      const draft = createMeetingDraft({
        agenda: agenda.trim(),
        chair: routes[0],
        id: newMeetingId(),
        maxRounds,
        participants: routes,
        source: routes[0],
        title: title.trim()
      })

      const saved = await putMeeting(draft, 0)
      replaceMeeting(saved)
      setSelectedId(saved.meeting.id)
      setTitle('')
      setAgenda('')
      setSelectedParticipants([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const transition = async (kind: 'start' | 'resume' | 'cancel' | 'conclude') => {
    if (!selected) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const payload = kind === 'conclude'
        ? {
            chair: selected.meeting.chair,
            decisions: decision.trim()
              ? [{ id: `decision_${Date.now().toString(36)}`, text: decision.trim(), evidenceRefs: [] }]
              : [],
            dissent: dissent.trim() && selected.meeting.participants[1]
              ? [{ participant: selected.meeting.participants[1], text: dissent.trim(), evidenceRefs: [] }]
              : [],
            actionItems: actionTitle.trim()
              ? [{
                  id: `action_${Date.now().toString(36)}`,
                  ownerRoute: selected.meeting.participants[0],
                  title: actionTitle.trim(),
                  acceptanceCriteria: 'Verify the completed result.',
                  priority: 'normal',
                  dueIntent: 'Next operations checkpoint'
                }]
              : []
          }
        : undefined

      const saved = await persistMeetingTransition(selected.meeting, selected.version, kind, payload)
      replaceMeeting(saved)

      if (saved.conflict) {
        setError('The meeting changed elsewhere. The latest version was loaded.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runRound = async () => {
    if (!selected) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const modes = Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>

      const saved = await runMeetingRound(host, selected.meeting, selected.version, modes)
      replaceMeeting(saved)

      if (saved.pending) {
        setError('A participant is waiting for your input in its Hermes session.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const createActions = async () => {
    if (!selected || selected.meeting.state !== 'completed') {
      return
    }

    setBusy(true)
    setError('')

    try {
      const modes = Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>

      await convertMeetingActions(host, selected.meeting, modes)
      host.notify({ kind: 'success', message: 'Meeting action items added to Kanban' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,0.75fr)_minmax(24rem,1.25fr)]">
      <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) p-3">
        <h2 className="text-sm font-semibold">New specialist meeting</h2>
        <div className="mt-3 space-y-3">
          <label className="space-y-1 text-xs">
            <span>Title</span>
            <Input aria-label="Meeting title" className="min-h-11" maxLength={200} onChange={event => setTitle(event.currentTarget.value)} value={title} />
          </label>
          <label className="space-y-1 text-xs">
            <span>Agenda</span>
            <Textarea aria-label="Meeting agenda" maxLength={8_000} onChange={event => setAgenda(event.currentTarget.value)} rows={4} value={agenda} />
          </label>
          <label className="space-y-1 text-xs">
            <span>Maximum rounds</span>
            <select
              aria-label="Maximum meeting rounds"
              className="min-h-11 w-full rounded-md border border-(--ui-stroke-secondary) bg-background px-3 text-sm"
              onChange={event => setMaxRounds(Number(event.currentTarget.value))}
              value={maxRounds}
            >
              {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <fieldset>
            <legend className="mb-1 text-xs text-(--ui-text-tertiary)">Participants, first selected chairs</legend>
            <div className="max-h-52 overflow-y-auto rounded-md border border-(--ui-stroke-tertiary)">
              {options.map(option => {
                const key = routeKey(option)

                return (
                  <label className="flex min-h-11 items-center gap-2 px-3 text-xs" key={key}>
                    <input
                      aria-label={`Select ${option.label.split(' · ')[0]} as a meeting participant`}
                      checked={selectedParticipants.includes(key)}
                      className="size-5"
                      onChange={event => {
                        const checked = event.currentTarget.checked
                        setSelectedParticipants(current =>
                          checked ? [...current, key] : current.filter(value => value !== key)
                        )
                      }}
                      type="checkbox"
                    />
                    <span className="truncate">{option.label}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <Button className="min-h-11 w-full" disabled={busy} onClick={() => void create()}>Create meeting draft</Button>
        </div>
        <div className="mt-4 border-t border-(--ui-stroke-tertiary) pt-2">
          {loading ? <p className="p-2 text-xs">Loading meetings…</p> : error && meetings.length === 0 ? null : meetings.length > 0 ? (
            meetings.map(item => (
              <button
                className="min-h-11 w-full truncate rounded-md px-2 text-left text-sm hover:bg-(--ui-bg-hover)"
                key={item.meeting.id}
                onClick={() => setSelectedId(item.meeting.id)}
                type="button"
              >
                {item.meeting.title} · {item.meeting.state}
              </button>
            ))
          ) : <p className="p-2 text-xs text-(--ui-text-tertiary)">No meetings yet.</p>}
        </div>
      </section>

      <section className="min-w-0 rounded-xl border border-(--ui-stroke-tertiary) p-3">
        {error && <p className="mb-3 border border-destructive/40 p-3 text-sm text-destructive" role="alert">{error}</p>}
        {selected ? (
          <MeetingDetail
            actionTitle={actionTitle}
            busy={busy}
            decision={decision}
            dissent={dissent}
            meeting={selected.meeting}
            onActionTitle={setActionTitle}
            onCreateActions={() => void createActions()}
            onDecision={setDecision}
            onDissent={setDissent}
            onRunRound={() => void runRound()}
            onTransition={kind => void transition(kind)}
          />
        ) : (
          <EmptyState description="Create or select a durable source-qualified meeting." title="No meeting selected" />
        )}
      </section>
    </div>
  )
}

function MeetingDetail({
  actionTitle,
  busy,
  decision,
  dissent,
  meeting,
  onActionTitle,
  onCreateActions,
  onDecision,
  onDissent,
  onRunRound,
  onTransition
}: {
  actionTitle: string
  busy: boolean
  decision: string
  dissent: string
  meeting: MeetingRecord
  onActionTitle(value: string): void
  onCreateActions(): void
  onDecision(value: string): void
  onDissent(value: string): void
  onRunRound(): void
  onTransition(kind: 'start' | 'resume' | 'cancel' | 'conclude'): void
}) {
  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{meeting.title}</h2>
        <Badge variant="outline">{meeting.state}</Badge>
        <Badge variant="outline">Round {meeting.currentRound}/{meeting.maxRounds}</Badge>
      </div>
      <p className="text-sm text-(--ui-text-secondary)">{meeting.agenda}</p>
      <div className="flex flex-wrap gap-2">
        {meeting.participants.map(route => <Badge key={routeKey(route)} variant="outline">{route.profile} · {route.connectionId}</Badge>)}
      </div>
      <div className="flex flex-wrap gap-2">
        {meeting.state === 'draft' && <Button aria-label="Start meeting" className="min-h-11" disabled={busy} onClick={() => onTransition('start')}>Start</Button>}
        {meeting.state === 'running' && <Button className="min-h-11" disabled={busy} onClick={onRunRound}>Run round</Button>}
        {meeting.state === 'waiting' && <Button className="min-h-11" disabled={busy} onClick={() => onTransition('resume')}>Resume</Button>}
        {['draft', 'running', 'waiting'].includes(meeting.state) && <Button className="min-h-11" disabled={busy} onClick={() => onTransition('cancel')} variant="outline">Cancel</Button>}
      </div>
      <section className="space-y-2 border-y border-(--ui-stroke-tertiary) py-3">
        <h3 className="text-xs font-medium uppercase text-(--ui-text-tertiary)">Contributions</h3>
        {meeting.contributions.length > 0 ? meeting.contributions.map((raw, index) => {
          const item = raw as { id?: string; kind?: string; participant?: RouteIdentity; text?: string }

          return (
            <div className="border-l-2 border-(--ui-stroke-secondary) pl-3 text-sm" key={item.id || index}>
              <span className="font-medium">{item.participant?.profile} · {item.participant?.connectionId}</span>
              <p>{item.kind === 'pass' ? '(pass)' : item.text}</p>
            </div>
          )
        }) : <p className="text-xs text-(--ui-text-tertiary)">No one has spoken yet.</p>}
      </section>
      {['running', 'waiting'].includes(meeting.state) && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Input aria-label="Meeting decision" className="min-h-11" onChange={event => onDecision(event.currentTarget.value)} placeholder="Decision" value={decision} />
          <Input aria-label="Meeting dissent" className="min-h-11" onChange={event => onDissent(event.currentTarget.value)} placeholder="Explicit dissent" value={dissent} />
          <Input aria-label="Meeting action item" className="min-h-11" onChange={event => onActionTitle(event.currentTarget.value)} placeholder="Action item" value={actionTitle} />
          <Button className="min-h-11 sm:col-span-3" disabled={busy} onClick={() => onTransition('conclude')}>Conclude meeting</Button>
        </div>
      )}
      {meeting.state === 'completed' && meeting.actionItems.length > 0 && (
        <Button className="min-h-11" disabled={busy} onClick={onCreateActions}>Create duplicate-safe Kanban cards</Button>
      )}
    </div>
  )
}
