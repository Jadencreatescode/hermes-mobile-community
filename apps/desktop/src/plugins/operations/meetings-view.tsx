import { Button, Codicon, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyState, host, Input } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OperationsAgentModel, OperationsSnapshot } from './data'
import { MeetingRoom } from './meeting-room'
import {
  convertMeetingActions,
  createMeetingDraft,
  listMeetings,
  type MeetingRecord,
  persistMeetingTransition,
  putMeeting,
  runMeetingRound
} from './meetings'

function routeKey(route: { connectionId: string; profile: string }): string {
  return `${route.connectionId}::${route.profile}`
}

export function MeetingsView({
  onOpenAgent,
  snapshot
}: {
  onOpenAgent?: (agent: OperationsAgentModel) => void
  snapshot: OperationsSnapshot
}) {
  const options = useMemo(
    () => snapshot.agents.map(agent => ({ connectionId: agent.sourceId, profile: agent.profile, label: `${agent.displayName} · ${agent.sourceLabel}` })),
    [snapshot.agents]
  )
  const [meetings, setMeetings] = useState<Array<{ meeting: MeetingRecord; version: number }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [decision, setDecision] = useState('')
  const [dissent, setDissent] = useState('')
  const [actionTitle, setActionTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = meetings.find(item => item.meeting.id === selectedId) ?? null

  const refresh = useCallback(async () => {
    try {
      const next = await listMeetings()
      setMeetings(next)
      setSelectedId(current => current || next[0]?.meeting.id || '')
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => void refresh(), [refresh])

  const create = async () => {
    const routes = options.filter(option => selectedParticipants.includes(routeKey(option)))

    if (!title.trim() || !agenda.trim() || routes.length < 2 || routes.length > 6) {
      setError('Add a title, an agenda, and two to six source-qualified participants.')

      return
    }

    setBusy(true)

    try {
      const draft = createMeetingDraft({
        agenda: agenda.trim(),
        chair: routes[0],
        id: `meeting-${Date.now().toString(36)}`,
        maxRounds: 3,
        participants: routes,
        source: routes[0],
        title: title.trim()
      })

      const saved = await putMeeting(draft, 0)

      setMeetings(current => [saved, ...current])
      setSelectedId(saved.meeting.id)
      setTitle('')
      setAgenda('')
      setSelectedParticipants([])
      setCreating(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const transition = async (kind: 'start' | 'resume' | 'cancel' | 'conclude') => {
    if (!selected) {return}
    setBusy(true)

    try {
      const payload = kind === 'conclude' ? {
        chair: selected.meeting.chair,
        decisions: decision.trim() ? [{ id: `decision-${Date.now().toString(36)}`, text: decision.trim(), evidenceRefs: [] }] : [],
        dissent: dissent.trim() && selected.meeting.participants[1] ? [{ participant: selected.meeting.participants[1], text: dissent.trim(), evidenceRefs: [] }] : [],
        actionItems: actionTitle.trim() ? [{ id: `action-${Date.now().toString(36)}`, ownerRoute: selected.meeting.participants[0], title: actionTitle.trim(), acceptanceCriteria: 'Owner verifies the completed result.', priority: 'normal', dueIntent: 'Next operations checkpoint' }] : []
      } : undefined

      const saved = await persistMeetingTransition(selected.meeting, selected.version, kind, payload)

      setMeetings(current => current.map(item => item.meeting.id === selected.meeting.id ? saved : item))
      setError(saved.conflict ? 'The durable meeting changed elsewhere. The latest version was loaded.' : '')

      if (kind === 'conclude') {setDetailsOpen(false)}
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runRound = async () => {
    if (!selected) {return}
    setBusy(true)

    try {
      const modes = Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>

      const saved = await runMeetingRound(host, selected.meeting, selected.version, modes)

      setMeetings(current => current.map(item => item.meeting.id === selected.meeting.id ? saved : item))
      setError(saved.pending ? 'A participant is waiting for owner input in its Bot session.' : '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const convertActions = async () => {
    if (!selected || selected.meeting.state !== 'completed') {return}
    setBusy(true)

    try {
      const modes = Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>

      await convertMeetingActions(host, selected.meeting, modes)
      host.notify({ kind: 'success', message: 'Meeting action items added to Kanban' })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0 space-y-3 text-white" data-testid="meetings-room-view">
      <header className="flex min-w-0 items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-cyan-300">Live council chamber</p>
          <h2 className="truncate text-lg font-semibold text-white">{selected?.meeting.title || 'Meeting room'}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected ? (
            <Button aria-label="Meeting details" className="min-h-11 min-w-11 rounded-full border-white/20 bg-white/5 px-0 text-white hover:bg-white/10" onClick={() => setDetailsOpen(true)} title="Meeting details" variant="outline">
              <Codicon name="info" />
              <span className="sr-only">Meeting details</span>
            </Button>
          ) : null}
          <Button aria-label="New meeting" className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-0 text-slate-950 hover:bg-cyan-200" onClick={() => setCreating(true)} title="New meeting">
            <Codicon name="add" />
            <span className="sr-only">New meeting</span>
          </Button>
        </div>
      </header>

      {meetings.length ? (
        <nav aria-label="Meeting rooms" className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {meetings.map(item => (
            <button
              aria-current={item.meeting.id === selectedId ? 'page' : undefined}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3 text-xs transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${item.meeting.id === selectedId ? 'bg-cyan-300 text-slate-950' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}
              key={item.meeting.id}
              onClick={() => setSelectedId(item.meeting.id)}
              type="button"
            >
              <Codicon name="organization" />
              <span>{item.meeting.title}</span>
              <span aria-hidden className={`size-1.5 rounded-full ${item.meeting.state === 'running' ? 'bg-cyan-300' : item.meeting.state === 'waiting' ? 'bg-amber-300' : item.meeting.state === 'completed' ? 'bg-emerald-300' : 'bg-slate-400'}`} />
            </button>
          ))}
        </nav>
      ) : null}

      {selected ? (
        <>
          <MeetingRoom agents={snapshot.agents} meeting={selected.meeting} onOpenAgent={onOpenAgent} />
          <div aria-label="Meeting controls" className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-white/10 bg-black/35 p-2 shadow-[0_12px_34px_rgba(0,0,0,.28)] backdrop-blur-md">
            {selected.meeting.state === 'draft' ? (
              <Button aria-label="Start meeting" className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200" disabled={busy} onClick={() => void transition('start')} title="Start meeting"><Codicon name="play" /><span className="hidden sm:inline">Start</span></Button>
            ) : null}
            {selected.meeting.state === 'running' ? (
              <Button aria-label="Run meeting round" className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200" disabled={busy} onClick={() => void runRound()} title="Run meeting round"><Codicon name="sync" /><span className="hidden sm:inline">Run round</span></Button>
            ) : null}
            {selected.meeting.state === 'waiting' ? (
              <Button aria-label="Resume meeting" className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200" disabled={busy} onClick={() => void transition('resume')} title="Resume meeting"><Codicon name="debug-continue" /><span className="hidden sm:inline">Resume</span></Button>
            ) : null}
            {['draft', 'running', 'waiting'].includes(selected.meeting.state) ? (
              <Button aria-label="Cancel meeting" className="min-h-11 min-w-11 rounded-full border-white/20 bg-white/5 px-3 text-white hover:bg-white/10" disabled={busy} onClick={() => void transition('cancel')} title="Cancel meeting" variant="outline"><Codicon name="close" /><span className="sr-only">Cancel meeting</span></Button>
            ) : null}
            {selected.meeting.state === 'completed' && selected.meeting.actionItems.length ? (
              <Button aria-label="Create Kanban cards" className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200" disabled={busy} onClick={() => void convertActions()} title="Create Kanban cards"><Codicon name="project" /><span className="hidden sm:inline">Create tasks</span></Button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="grid min-h-[28rem] place-items-center overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_50%_20%,rgba(34,211,238,.12),transparent_45%),linear-gradient(to_bottom,#07111e,#020617)] p-6 text-center">
          <div>
            <Codicon className="text-5xl text-cyan-200/70" name="organization" />
            <p className="mt-3 text-sm font-medium text-(--ui-text-primary)">The council chamber is empty</p>
            <Button className="mt-4 min-h-11 rounded-full" onClick={() => setCreating(true)}><Codicon name="add" /> Set the table</Button>
          </div>
        </div>
      )}

      <Dialog onOpenChange={setCreating} open={creating}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>Set the meeting table</DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">Choose two to six Bots. The first selected Bot chairs the meeting.</p>
          </DialogHeader>
          <div className="space-y-3">
            <Input aria-label="Meeting title" className="min-h-11" onChange={event => setTitle(event.currentTarget.value)} placeholder="Meeting title" value={title} />
            <textarea aria-label="Meeting agenda" className="min-h-28 w-full resize-y rounded-lg border border-(--ui-stroke-tertiary) bg-transparent p-3 text-sm" onChange={event => setAgenda(event.currentTarget.value)} placeholder="Agenda and decision required" value={agenda} />
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Choose Bot seats</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-(--ui-stroke-tertiary) p-2">
                {options.map(option => {
                  const key = routeKey(option)

                  return (
                    <label className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm hover:bg-(--ui-bg-hover)" key={key}>
                      <input checked={selectedParticipants.includes(key)} onChange={event => setSelectedParticipants(current => event.target.checked ? [...current, key] : current.filter(value => value !== key))} type="checkbox" />
                      <span>{option.label}</span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button aria-label="Cancel setup" className="min-h-11" onClick={() => setCreating(false)} variant="ghost">Cancel</Button>
              <Button className="min-h-11" disabled={busy} onClick={() => void create()}><Codicon name="organization" /> Create room</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setDetailsOpen} open={detailsOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
          <DialogHeader className="shrink-0 border-b border-(--ui-stroke-tertiary) px-4 py-3">
            <DialogTitle>Meeting details</DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">{selected?.meeting.title}</p>
          </DialogHeader>
          {selected ? (
            <div className="min-h-0 space-y-4 overflow-y-auto p-4">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Agenda</h3>
                <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)">{selected.meeting.agenda}</p>
              </section>
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Contributions</h3>
                <div className="mt-2 space-y-3">
                  {selected.meeting.contributions.length ? selected.meeting.contributions.map((raw, index) => {
                    const item = raw as any

                    return (
                      <div className="border-l-2 border-(--ui-accent) pl-3 text-sm" key={item.id || index}>
                        <span className="font-medium">{item.participant?.profile} · {item.participant?.connectionId}</span>
                        <p className="mt-1 text-(--ui-text-secondary)">{item.kind === 'pass' ? '(pass)' : item.text}</p>
                      </div>
                    )
                  }) : <p className="text-sm text-(--ui-text-tertiary)">No one has spoken yet.</p>}
                </div>
              </section>
              {['running', 'waiting'].includes(selected.meeting.state) ? (
                <section className="space-y-3 border-t border-(--ui-stroke-tertiary) pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Close the meeting</h3>
                  <Input aria-label="Meeting decision" className="min-h-11" onChange={event => setDecision(event.currentTarget.value)} placeholder="Decision" value={decision} />
                  <Input aria-label="Meeting dissent" className="min-h-11" onChange={event => setDissent(event.currentTarget.value)} placeholder="Explicit dissent" value={dissent} />
                  <Input aria-label="Meeting action item" className="min-h-11" onChange={event => setActionTitle(event.currentTarget.value)} placeholder="Action item" value={actionTitle} />
                  <Button className="min-h-11 w-full" disabled={busy} onClick={() => void transition('conclude')}><Codicon name="check-all" /> Conclude meeting</Button>
                </section>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    </div>
  )
}
