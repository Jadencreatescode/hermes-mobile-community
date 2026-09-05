import {
  Button,
  Codicon,
  EmptyState,
  host,
  Input,
  Loader,
  SegmentedControl,
  Switch
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { BotAvatar } from './bot-avatar'
import { clearQuickSettings, loadQuickSettings, saveQuickSettings, type QuickSettings } from './control-room-actions'
import { listA2AAgents, removeA2AAgent, type HarnessAgent } from './data'
import { TrustedBridgeOnboarding } from './trusted-bridge-onboarding'

const ICON_SHAPES = [
  { id: 'circle' as const, label: 'Circle' },
  { id: 'rounded' as const, label: 'Rounded' },
  { id: 'square' as const, label: 'Square' }
]

function QuickSettingsPanel({
  agent,
  onUpdated
}: {
  agent: HarnessAgent
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
        if (!cancelled) setSettings(result)
      } catch {
        if (!cancelled) setError('Could not load settings')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()

    return () => { cancelled = true }
  }, [agent.agentId])

  const commit = useCallback(
    async (patch: Partial<QuickSettings>) => {
      if (!settings) return
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

function AgentCard({
  agent,
  onRemove,
  onUpdated
}: {
  agent: HarnessAgent
  onRemove?: (agentId: string) => void
  onUpdated?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [removing, setRemoving] = useState(false)

  const handleRemove = useCallback(async () => {
    setRemoving(true)

    try {
      await removeA2AAgent(agent.agentId)
      clearQuickSettings(agent.agentId)
      onRemove?.(agent.agentId)
    } catch {
      setRemoving(false)
    }
  }, [agent.agentId, onRemove])

  const statusIcon =
    agent.status === 'verified' ? 'pass-filled' : agent.status === 'pending' ? 'clock' : 'warning'

  return (
    <article className="min-w-0 rounded-xl border border-(--ui-stroke-secondary) p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <BotAvatar name={agent.name || agent.agentId} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">{agent.name || agent.agentId}</h3>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-(--ui-text-tertiary)">
              <Codicon name={statusIcon} size="0.75rem" />
              {agent.status}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} settings for ${agent.name}`}
            className="min-h-9 min-w-9"
            onClick={() => setExpanded(prev => !prev)}
            size="sm"
            variant="ghost"
          >
            <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          </Button>
          <Button
            aria-label={`Remove ${agent.name}`}
            className="min-h-9 min-w-9"
            disabled={removing}
            onClick={handleRemove}
            size="sm"
            variant="ghost"
          >
            <Codicon name="trash" />
          </Button>
        </div>
      </div>
      {agent.capabilities.length > 0 && (
        <p className="mt-2 text-xs text-(--ui-text-tertiary)">Capabilities: {agent.capabilities.join(', ')}</p>
      )}
      {expanded && (
        <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3">
          <QuickSettingsPanel agent={agent} onUpdated={onUpdated} />
        </div>
      )}
    </article>
  )
}

export function ControlRoomView() {
  const [agents, setAgents] = useState<HarnessAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const result = await listA2AAgents()
      setAgents(result)
    } catch {
      setError('Could not load A2A agents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRegistered = useCallback(
    (agent: HarnessAgent) => {
      setAgents(prev => [...prev, agent])
    },
    []
  )

  const handleRemove = useCallback(
    (agentId: string) => {
      setAgents(prev => prev.filter(a => a.agentId !== agentId))
    },
    []
  )

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const agent of agents) {
      map.set(agent.status, (map.get(agent.status) ?? 0) + 1)
    }
    return map
  }, [agents])

  return (
    <section className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Control Room</h2>
          <p className="text-sm text-(--ui-text-secondary)">Connected A2A peers, quick settings, and onboarding.</p>
        </div>
        <Button className="min-h-11" onClick={() => setOnboardingOpen(true)} size="sm">
          <Codicon name="add" />
          Connect agent
        </Button>
      </header>

      <div className="grid min-w-0 grid-cols-3 gap-px overflow-hidden border border-(--ui-stroke-tertiary) bg-(--ui-stroke-tertiary)">
        {(['verified', 'pending', 'degraded'] as const).map(status => (
          <div className="min-w-0 bg-(--ui-chat-surface-background) p-3" key={status}>
            <p className="text-[0.68rem] uppercase tracking-wide text-(--ui-text-quaternary)">{status}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-(--ui-text-primary)">{counts.get(status) ?? 0}</p>
          </div>
        ))}
      </div>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid h-48 place-items-center">
          <Loader label="Loading A2A agents" type="lemniscate-bloom" />
        </div>
      ) : agents.length > 0 ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {agents.map(agent => (
            <AgentCard agent={agent} key={agent.agentId} onRemove={handleRemove} onUpdated={refresh} />
          ))}
        </div>
      ) : (
        <EmptyState description="Connect an A2A agent to manage it here." title="No A2A agents connected" />
      )}

      <TrustedBridgeOnboarding onOpenChange={setOnboardingOpen} onRegistered={handleRegistered} open={onboardingOpen} />
    </section>
  )
}
