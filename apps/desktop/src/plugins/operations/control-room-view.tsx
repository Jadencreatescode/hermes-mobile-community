import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  host,
  Input,
  Loader,
  SegmentedControl,
  StatusDot,
  type StatusTone,
  Switch
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BotAvatar } from './bot-avatar'
import { clearQuickSettings, loadQuickSettings, type QuickSettings, saveQuickSettings } from './control-room-actions'
import { type OperationsAgentModel, type OperationsSnapshot, removeA2AAgent } from './data'
import type { OperationsSection } from './navigation'
import { TrustedBridgeOnboarding } from './trusted-bridge-onboarding'

export type ControlRoomId = 'blocked' | 'idle' | 'offline' | 'reviewing' | 'waiting' | 'working'

interface RoomDefinition {
  description: string
  icon: string
  id: ControlRoomId
  label: string
  tone: StatusTone
}

const ROOMS: RoomDefinition[] = [
  { id: 'working', label: 'Live Floor', description: 'Bots actively handling verified work', icon: 'pulse', tone: 'good' },
  { id: 'waiting', label: 'Needs You', description: 'Bots waiting for owner input', icon: 'bell-dot', tone: 'warn' },
  { id: 'reviewing', label: 'Review Desk', description: 'Bots checking work and decisions', icon: 'book', tone: 'warn' },
  { id: 'blocked', label: 'Blocked Bay', description: 'Bots stopped by a real blocker', icon: 'error', tone: 'bad' },
  { id: 'idle', label: 'Idle Lounge', description: 'Ready Bots with no active work', icon: 'coffee', tone: 'muted' },
  { id: 'offline', label: 'Offline Station', description: 'Unknown or unreachable Bot state', icon: 'debug-disconnect', tone: 'bad' }
]

const STATE_COPY: Record<OperationsAgentModel['state'], string> = {
  blocked: 'Blocked',
  idle: 'Idle',
  reviewing: 'Reviewing',
  unknown: 'Unknown',
  waiting: 'Needs input',
  working: 'Working'
}

const ROOM_TINT: Record<ControlRoomId, string> = {
  blocked: 'rgba(239,68,68,.13)',
  idle: 'rgba(100,116,139,.10)',
  offline: 'rgba(71,85,105,.16)',
  reviewing: 'rgba(245,158,11,.12)',
  waiting: 'rgba(249,115,22,.12)',
  working: 'rgba(16,185,129,.12)'
}

export function roomForAgentState(state: OperationsAgentModel['state']): ControlRoomId {
  return state === 'unknown' ? 'offline' : state
}

function plainSummary(value: string): string {
  return value
    .replace(/[`*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'No active work'
}

function StationVisual({ agent }: { agent: OperationsAgentModel }) {
  const visual = {
    blocked: { accent: 'bg-red-500/70', symbol: '!', label: 'Barrier engaged' },
    idle: { accent: 'bg-slate-400/35', symbol: '•', label: 'Station ready' },
    reviewing: { accent: 'bg-amber-400/60', symbol: '✓', label: 'Review document' },
    unknown: { accent: 'bg-slate-500/35', symbol: '×', label: 'Connection unavailable' },
    waiting: { accent: 'bg-orange-400/60', symbol: '?', label: 'Input requested' },
    working: { accent: 'bg-emerald-400/65', symbol: '⌁', label: 'Console active' }
  }[agent.state]

  return (
    <div aria-label={visual.label} className="relative mt-3 h-10 w-full" role="img">
      <div className="absolute inset-x-3 bottom-0 h-3 rounded-sm bg-black/20 shadow-[0_8px_16px_rgba(0,0,0,.18)]" />
      <div className="absolute bottom-2 left-1/2 grid h-8 w-14 -translate-x-1/2 place-items-center rounded-md border border-white/10 bg-(--ui-bg-primary) shadow-[0_8px_22px_rgba(0,0,0,.24)]">
        <span className={`grid size-5 place-items-center rounded text-[0.65rem] font-black text-white ${visual.accent}`}>{visual.symbol}</span>
      </div>
    </div>
  )
}

function AgentStation({
  agent,
  onQuickSettings,
  onSelect
}: {
  agent: OperationsAgentModel
  onQuickSettings: (agent: OperationsAgentModel) => void
  onSelect: (agent: OperationsAgentModel) => void
}) {
  const longPressTimer = useRef<number | null>(null)
  const longPressTriggered = useRef(false)

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  return (
    <button
      aria-label={`Open ${agent.displayName} workspace`}
      className="group relative min-w-0 overflow-hidden rounded-xl border border-white/10 bg-black/15 p-3 text-left shadow-[0_16px_34px_rgba(0,0,0,.16)] outline-none transition-[scale,border-color,background-color] duration-150 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-(--ui-accent) hover:border-white/20 hover:bg-white/[0.06]"
      data-testid="control-room-agent"
      onClick={event => {
        if (longPressTriggered.current) {
          event.preventDefault()
          longPressTriggered.current = false

          return
        }

        onSelect(agent)
      }}
      onContextMenu={event => {
        event.preventDefault()
        clearLongPress()
        onQuickSettings(agent)
      }}
      onPointerCancel={clearLongPress}
      onPointerDown={event => {
        if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) {return}

        clearLongPress()
        longPressTriggered.current = false
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null
          longPressTriggered.current = true
          onQuickSettings(agent)
        }, 600)
      }}
      onPointerLeave={clearLongPress}
      onPointerUp={clearLongPress}
      type="button"
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] [background-size:18px_18px]" />
      <div className="relative flex min-w-0 items-start gap-3">
        <BotAvatar name={agent.displayName} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-(--ui-text-primary)">{agent.displayName}</span>
            <StatusDot tone={agent.state === 'working' ? 'good' : agent.state === 'blocked' || agent.state === 'unknown' ? 'bad' : agent.state === 'idle' ? 'muted' : 'warn'} />
          </div>
          <p className="truncate text-[0.68rem] text-(--ui-text-quaternary)">@{agent.profile} · {agent.sourceLabel}</p>
          <p className="mt-1 text-[0.68rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">{STATE_COPY[agent.state]}</p>
        </div>
      </div>
      <StationVisual agent={agent} />
      <p className="relative mt-2 line-clamp-2 min-h-9 text-xs leading-[1.125rem] text-(--ui-text-secondary)">{plainSummary(agent.workSummary)}</p>
      {agent.assignments.length ? <p className="relative mt-2 truncate text-[0.65rem] text-(--ui-accent)">{plainSummary(agent.assignments[0].title)}</p> : null}
    </button>
  )
}

function Room({ definition, agents, onQuickSettings, onSelect, expanded = false }: { definition: RoomDefinition; agents: OperationsAgentModel[]; onQuickSettings: (agent: OperationsAgentModel) => void; onSelect: (agent: OperationsAgentModel) => void; expanded?: boolean }) {
  return (
    <section
      aria-label={definition.label}
      className={`relative min-w-0 overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) p-3 shadow-[0_24px_60px_rgba(0,0,0,.16)] sm:p-4 ${expanded ? 'md:col-span-2' : ''}`}
      style={{ background: `linear-gradient(145deg, ${ROOM_TINT[definition.id]}, color-mix(in srgb, var(--ui-chat-surface-background) 94%, transparent))` }}
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(135deg,rgba(255,255,255,.035)_25%,transparent_25%),linear-gradient(315deg,rgba(255,255,255,.025)_25%,transparent_25%)] [background-position:0_0,18px_18px] [background-size:36px_36px]" />
      <header className="relative flex min-w-0 items-start justify-between gap-3 border-b border-white/8 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-black/20 text-(--ui-text-secondary)"><Codicon name={definition.icon} /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-(--ui-text-primary)">{definition.label}</h2>
            <p className="text-xs text-(--ui-text-secondary)">{definition.description}</p>
          </div>
        </div>
        <span className="rounded-full border border-white/10 bg-black/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-(--ui-text-secondary)">{agents.length}</span>
      </header>
      {agents.length ? (
        <div className={`relative mt-3 grid min-w-0 gap-3 ${expanded ? 'sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'}`}>
          {agents.map(agent => <AgentStation agent={agent} key={agent.id} onQuickSettings={onQuickSettings} onSelect={onSelect} />)}
        </div>
      ) : (
        <div className="relative grid min-h-16 place-items-center text-center text-xs text-(--ui-text-tertiary)">No Bots in this room</div>
      )}
    </section>
  )
}

const DEPARTMENT_DOORS: Array<{ description: string; icon: string; id: Exclude<OperationsSection, 'overview' | 'control-room'>; label: string }> = [
  { id: 'mailroom', label: 'Mailroom', description: 'Durable Bot messages', icon: 'mail' },
  { id: 'meetings', label: 'Meetings', description: 'Structured decisions', icon: 'organization' },
  { id: 'workspace', label: 'Agent Workspace', description: 'Chat, screen, and work', icon: 'remote-explorer' }
]

function DepartmentDoors({ onOpenSection }: { onOpenSection?: (section: Exclude<OperationsSection, 'overview' | 'control-room'>) => void }) {
  if (!onOpenSection) {return null}

  return (
    <section aria-label="Operations departments" className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-3 md:hidden">
        <p className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Departments</p>
        <p className="text-xs text-(--ui-text-quaternary)">Swipe for more →</p>
      </div>
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-2 md:grid md:grid-cols-3 md:overflow-visible md:pb-0">
        {DEPARTMENT_DOORS.map(department => (
          <button
            aria-label={`Open ${department.label}`}
            className="group min-h-18 min-w-36 shrink-0 rounded-xl border border-(--ui-stroke-tertiary) bg-black/10 p-3 text-left transition-[scale,background-color,border-color] active:scale-[0.96] hover:border-white/20 hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-(--ui-accent) md:min-w-0"
            key={department.id}
            onClick={() => onOpenSection(department.id)}
            type="button"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-(--ui-text-primary)"><Codicon name={department.icon} />{department.label}</span>
            <span className="mt-1 block text-xs text-(--ui-text-tertiary)">{department.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

const ICON_SHAPES = [
  { id: 'circle' as const, label: 'Circle' },
  { id: 'rounded' as const, label: 'Rounded' },
  { id: 'square' as const, label: 'Square' }
]

function QuickSettingsPanel({
  agent,
  onUpdated
}: {
  agent: { agentId: string; displayName: string }
  onUpdated?: () => void
}) {
  const [settings, setSettings] = useState<QuickSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await loadQuickSettings(agent.agentId, host.request)

        if (!cancelled) {
          setSettings(result)
        }
      } catch {
        if (!cancelled) {
          setError('Could not load settings')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()

    return () => { cancelled = true }
  }, [agent.agentId])

  const commit = useCallback(
    async (patch: Partial<QuickSettings>) => {
      if (!settings) {
        return
      }

      const next = { ...settings, ...patch }
      setSettings(next)
      setSaving(true)
      setError('')

      try {
        await saveQuickSettings(agent.agentId, next, host.request)
        onUpdated?.()
      } catch {
        setError('Save failed')
      } finally {
        setSaving(false)
      }
    },
    [agent.agentId, settings, onUpdated]
  )

  if (loading) {
    return <Loader label="Loading settings" />
  }

  if (!settings) {
    return <p className="text-xs text-destructive">{error || 'Settings unavailable'}</p>
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-xs">
          <span className="text-(--ui-text-secondary)">Model</span>
          <Input onChange={event => commit({ model: event.target.value })} size="sm" value={settings.model} />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-(--ui-text-secondary)">Provider</span>
          <Input onChange={event => commit({ provider: event.target.value })} size="sm" value={settings.provider} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-xs">
          <span className="text-(--ui-text-secondary)">Effort</span>
          <Input onChange={event => commit({ effort: event.target.value })} size="sm" value={settings.effort} />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={settings.fast} onCheckedChange={checked => commit({ fast: checked })} />
          <span className="text-(--ui-text-secondary)">Fast mode</span>
        </label>
      </div>
      <div className="space-y-1">
        <span className="text-xs text-(--ui-text-secondary)">Icon shape</span>
        <SegmentedControl
          onChange={value => commit({ iconShape: value })}
          options={ICON_SHAPES}
          value={settings.iconShape}
        />
      </div>
      <div className="space-y-1">
        <span className="text-xs text-(--ui-text-secondary)">Icon color</span>
        <div className="flex items-center gap-2">
          <input
            onChange={event => commit({ iconColor: event.target.value })}
            type="color"
            value={settings.iconColor}
          />
          <span className="text-xs font-mono text-(--ui-text-tertiary)">{settings.iconColor}</span>
        </div>
      </div>
      {saving && <p className="text-xs text-(--ui-text-tertiary)">Saving…</p>}
    </div>
  )
}

function AgentInspector({
  agent,
  initialPanel,
  onChanged,
  onClose,
  onOpenAgent
}: {
  agent: OperationsAgentModel | null
  initialPanel: 'overview' | 'settings'
  onChanged?: () => void
  onClose: () => void
  onOpenAgent?: (agent: OperationsAgentModel) => void
}) {
  const [panel, setPanel] = useState<'overview' | 'settings'>(initialPanel)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')

  const isA2APeer = agent?.sourceKind === 'a2a'
  const agentId = isA2APeer && agent ? agent.profile : ''

  useEffect(() => {
    if (!agent) {return}

    setPanel(initialPanel)
    setError('')
  }, [agent, initialPanel])

  const inspectorTabs: Array<['overview' | 'settings', string]> = isA2APeer
    ? [['overview', 'Overview'], ['settings', 'Settings']]
    : [['overview', 'Overview']]

  const handleRemove = useCallback(async () => {
    if (!agentId) {return}

    setRemoving(true)
    setError('')

    try {
      await removeA2AAgent(agentId)
      clearQuickSettings(agentId)
      onChanged?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setRemoving(false)
    }
  }, [agentId, onChanged, onClose])

  const openWorkspace = useCallback(async () => {
    if (!agent || !onOpenAgent) {return}

    try {
      await onOpenAgent(agent)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [agent, onClose, onOpenAgent])

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(agent)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl overflow-y-auto">
        {agent ? (
          <>
            <DialogHeader><DialogTitle>{agent.displayName}</DialogTitle></DialogHeader>
            <div aria-label="Bot inspector sections" className={`grid gap-1 rounded-lg bg-(--ui-bg-secondary) p-1 ${isA2APeer ? 'grid-cols-2' : 'grid-cols-1'}`} role="tablist">
              {inspectorTabs.map(([id, label]) => (
                <button aria-selected={panel === id} className={`min-h-11 rounded-md px-2 text-xs font-semibold ${panel === id ? 'bg-(--ui-control-active-background) text-(--ui-text-primary)' : 'text-(--ui-text-tertiary)'}`} key={id} onClick={() => setPanel(id)} role="tab" type="button">{label}</button>
              ))}
            </div>

            {panel === 'overview' ? (
              <>
                <div className="flex min-w-0 flex-col items-start gap-4 overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) p-4 sm:flex-row sm:items-center">
                  <BotAvatar name={agent.displayName} size="lg" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-(--ui-text-primary)">{STATE_COPY[agent.state]} · {agent.sourceLabel}</p>
                    <p className="mt-1 text-sm text-(--ui-text-secondary)">{plainSummary(agent.workSummary)}</p>
                    <p className="mt-1 break-all text-xs text-(--ui-text-tertiary)">Handle: @{agent.profile}</p>
                    {agent.openSessionId ? <p className="mt-1 break-all text-xs text-(--ui-text-tertiary)">Session: {agent.openSessionId}</p> : null}
                    {isA2APeer ? <p className="mt-1 break-all text-xs text-(--ui-text-tertiary)">A2A registry peer · managed here</p> : null}
                    {agent.assignments.length ? <p className="mt-2 text-xs text-(--ui-text-tertiary)">Assignment: {plainSummary(agent.assignments[0].title)} ({agent.assignments[0].status})</p> : null}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {!isA2APeer ? <Button aria-label={`Open ${agent.displayName} Bot workspace`} className="min-h-11" onClick={() => void openWorkspace()}><Codicon name="comment-discussion" /> Open workspace</Button> : null}
                  {isA2APeer ? <Button aria-label={`Open ${agent.displayName} Quick Settings`} className="min-h-11" onClick={() => setPanel('settings')} variant="outline"><Codicon name="settings-gear" /> Quick Settings</Button> : null}
                  {isA2APeer ? <Button aria-label={`Remove ${agent.displayName}`} className="min-h-11" disabled={removing} onClick={() => void handleRemove()} variant="outline"><Codicon name="trash" /> Remove agent</Button> : null}
                </div>
                {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
              </>
            ) : null}

            {panel === 'settings' && isA2APeer ? (
              <section aria-label="Bot Quick Settings" className="space-y-3">
                <QuickSettingsPanel agent={{ agentId, displayName: agent.displayName }} onUpdated={onChanged} />
                {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
              </section>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export function ControlRoomView({
  a2aError,
  layoutMode,
  onChanged,
  onOpenAgent,
  onOpenSection,
  onShowDetails,
  snapshot
}: {
  a2aError?: string
  layoutMode?: 'map' | 'phone'
  onChanged?: () => void
  onOpenAgent?: (agent: OperationsAgentModel) => void
  onOpenSection?: (section: Exclude<OperationsSection, 'overview' | 'control-room'>) => void
  onShowDetails?: () => void
  snapshot: OperationsSnapshot
}) {
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [inspectorPanel, setInspectorPanel] = useState<'overview' | 'settings'>('overview')
  const [selectedAgent, setSelectedAgent] = useState<OperationsAgentModel | null>(null)

  const grouped = useMemo(() => {
    const next = new Map<ControlRoomId, OperationsAgentModel[]>(ROOMS.map(room => [room.id, []]))

    for (const agent of snapshot.agents) {next.get(roomForAgentState(agent.state))!.push(agent)}

    return next
  }, [snapshot.agents])

  const firstOccupiedRoom = ROOMS.find(room => grouped.get(room.id)!.length)?.id ?? 'working'
  const [activeRoom, setActiveRoom] = useState<ControlRoomId>(firstOccupiedRoom)

  useEffect(() => {
    if (!grouped.get(activeRoom)?.length && grouped.get(firstOccupiedRoom)?.length) {setActiveRoom(firstOccupiedRoom)}
  }, [activeRoom, firstOccupiedRoom, grouped])

  const activeDefinition = ROOMS.find(room => room.id === activeRoom) ?? ROOMS[0]

  const inspectAgent = (agent: OperationsAgentModel) => {
    setInspectorPanel('overview')
    setSelectedAgent(agent)
  }

  const inspectQuickSettings = (agent: OperationsAgentModel) => {
    setInspectorPanel('settings')
    setSelectedAgent(agent)
  }

  const handleRegistered = useCallback(() => {
    onChanged?.()
  }, [onChanged])

  const handleInspectorChanged = useCallback(() => {
    onChanged?.()
  }, [onChanged])

  const openAgent = useCallback((agent: OperationsAgentModel) => {
    if (!onOpenAgent) {return}

    void onOpenAgent(agent)
  }, [onOpenAgent])

  const isNarrowViewport = typeof window !== 'undefined' && window.innerWidth < 768
  const phone = layoutMode === 'phone' ? true : layoutMode === 'map' ? false : isNarrowViewport

  return (
    <div className="mx-auto flex w-full max-w-[100rem] min-w-0 flex-col gap-3 p-0 pb-6 sm:p-0 sm:pb-6" data-control-room>
      <section className="relative overflow-hidden rounded-2xl border border-(--ui-stroke-tertiary) bg-[linear-gradient(120deg,color-mix(in_srgb,var(--ui-accent)_16%,var(--ui-chat-surface-background)),var(--ui-chat-surface-background)_58%)] p-4 shadow-[0_24px_70px_rgba(0,0,0,.18)] sm:p-5">
        <div className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-(--ui-accent)/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-(--ui-accent)">Live visual headquarters</p>
            <h2 className="mt-1 text-xl font-semibold text-(--ui-text-primary)">Control Room</h2>
            <p className="mt-1 max-w-2xl text-sm text-(--ui-text-secondary)">Every room is driven by real session, task, review, input, and source evidence.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button aria-label="Connect a Bot" className="min-h-11" onClick={() => setOnboardingOpen(true)} size="sm"><Codicon name="plug" /> Connect a Bot</Button>
            {onShowDetails ? <Button aria-label="View detailed Operations" className="min-h-11" onClick={onShowDetails} size="sm" variant="outline"><Codicon name="list-tree" /> Details</Button> : null}
          </div>
        </div>
        <div className="relative mt-4 flex min-w-0 flex-wrap gap-2">
          {snapshot.sources.map(source => (
            <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/10 bg-black/15 px-3 text-xs text-(--ui-text-secondary)" key={source.id}>
              <StatusDot tone={source.status === 'online' ? 'good' : source.status === 'degraded' ? 'warn' : 'bad'} />
              {source.label} {source.status === 'degraded' ? 'partial' : source.status}
            </span>
          ))}
        </div>
      </section>

      {a2aError ? (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {a2aError}
        </div>
      ) : null}

      <DepartmentDoors onOpenSection={onOpenSection} />

      {phone ? (
        <div data-testid="control-room-phone-room">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Rooms</p>
            <p className="text-xs text-(--ui-text-quaternary)">Swipe rooms →</p>
          </div>
          <nav aria-label="Control room room selector" className="flex min-h-12 snap-x gap-2 overflow-x-auto pb-2">
            {ROOMS.map(room => (
              <button aria-pressed={activeRoom === room.id} className={`inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-full border px-3 text-xs font-semibold ${activeRoom === room.id ? 'border-(--ui-accent) bg-(--ui-accent)/12 text-(--ui-text-primary)' : 'border-(--ui-stroke-tertiary) text-(--ui-text-secondary)'}`} key={room.id} onClick={() => setActiveRoom(room.id)} type="button">
                <StatusDot tone={room.tone} /> {room.label} <span className="tabular-nums">{grouped.get(room.id)!.length}</span>
              </button>
            ))}
          </nav>
          <Room agents={grouped.get(activeRoom)!} definition={activeDefinition} expanded onQuickSettings={inspectQuickSettings} onSelect={inspectAgent} />
        </div>
      ) : (
        <div className="grid min-w-0 gap-3 md:grid-cols-2" data-testid="control-room-map">
          {ROOMS.map(definition => {
            const agents = grouped.get(definition.id)!

            return <Room agents={agents} definition={definition} expanded={agents.length > 6} key={definition.id} onQuickSettings={inspectQuickSettings} onSelect={inspectAgent} />
          })}
        </div>
      )}

      <AgentInspector
        agent={selectedAgent}
        initialPanel={inspectorPanel}
        onChanged={handleInspectorChanged}
        onClose={() => setSelectedAgent(null)}
        onOpenAgent={openAgent}
      />

      <TrustedBridgeOnboarding onOpenChange={setOnboardingOpen} onRegistered={handleRegistered} open={onboardingOpen} />
    </div>
  )
}
