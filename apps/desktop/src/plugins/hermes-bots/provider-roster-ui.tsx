import { type BotsRosterProvider, type BotsRosterProviderAgent, cn, Codicon, host } from '@hermes/plugin-sdk'
import { useState } from 'react'

export interface ProviderContribution {
  data?: unknown
  id: string
  source?: string
}

export interface ProviderRosterRow {
  active: false
  activity: 0
  agent: BotsRosterProviderAgent
  kind: 'provider-bot'
  pinned: false
  provider: BotsRosterProvider
  providerKey?: string
}

export async function loadProviderRoster(contributions: readonly ProviderContribution[]): Promise<ProviderRosterRow[]> {
  // The bounded validator stays runtime JavaScript so its node:test coverage can
  // execute without the renderer toolchain.
  // @ts-expect-error The runtime module intentionally has no TypeScript declaration.
  const providerRoster = await import('./provider-roster.mjs')

  return providerRoster.loadProviderRoster(contributions) as Promise<ProviderRosterRow[]>
}

export function providerBotMatches(row: ProviderRosterRow, query: string): boolean {
  const needle = query.trim().toLowerCase()

  if (!needle) {
    return true
  }

  const agent = row.agent

  return [agent.name, agent.handle, agent.harness, agent.host_label, agent.description].some(value =>
    String(value || '')
      .toLowerCase()
      .includes(needle)
  )
}

function providerBotSelected(row: ProviderRosterRow): boolean {
  if (typeof row.provider.is_agent_selected !== 'function') {
    return false
  }

  try {
    return Boolean(row.provider.is_agent_selected(row.agent))
  } catch {
    return false
  }
}

interface ProviderBotRowProps {
  onRefresh?: () => Promise<unknown> | unknown
  row: ProviderRosterRow
}

export function ProviderBotRow({ row, onRefresh }: ProviderBotRowProps) {
  const agent = row.agent
  const source = [agent.host_label, agent.harness].filter(Boolean).join(' · ')
  const model = [agent.model?.provider, agent.model?.id].filter(Boolean).join(' · ')
  const selected = providerBotSelected(row)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = async () => {
    if (refreshing || typeof row.provider.refresh_agent !== 'function') {
      return
    }

    setRefreshing(true)

    try {
      await row.provider.refresh_agent(agent)
      await onRefresh?.()
    } catch (error) {
      host.notifyError(error, `Could not refresh ${agent.name}`)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div
      className={cn(
        'group flex w-full min-w-0 items-center rounded-md transition-colors',
        selected ? 'bg-(--ui-row-active-background)' : 'hover:bg-(--chrome-action-hover)'
      )}
    >
      <button
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
        onClick={() => row.provider.open_bot_chat(agent)}
        type="button"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary) text-(--ui-accent)">
          <Codicon name="hubot" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{agent.name}</span>
            <span className="shrink-0 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary) px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
              Connected
            </span>
          </span>
          <span className="block truncate text-[0.6875rem] text-(--ui-text-tertiary)">
            {model || source || agent.handle}
          </span>
          {source && model ? (
            <span className="block truncate text-[0.625rem] text-(--ui-text-quaternary)">{source}</span>
          ) : null}
        </span>
      </button>
      {typeof row.provider.open_settings === 'function' ? (
        <button
          aria-label={`Manage ${agent.name}`}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)"
          onClick={() => row.provider.open_settings?.(agent)}
          type="button"
        >
          <Codicon name="settings-gear" />
        </button>
      ) : null}
      {typeof row.provider.refresh_agent === 'function' ? (
        <button
          aria-label={`Refresh ${agent.name}`}
          className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary) disabled:opacity-50"
          disabled={refreshing}
          onClick={() => void refresh()}
          type="button"
        >
          <Codicon name={refreshing ? 'loading~spin' : 'refresh'} />
        </button>
      ) : null}
    </div>
  )
}
