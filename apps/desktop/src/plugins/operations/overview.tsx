import { Badge, Button, EmptyState, host, StatusDot, type StatusTone } from '@hermes/plugin-sdk'
import { useMemo } from 'react'

import type { OperationsAgentModel, OperationsSnapshot } from './data'
import {
  operationsRoutineEmptyMessage,
  type OperationsRoutinesSnapshot
} from './routines'
import type { OperationsAgentState } from './state'
import { openAgentWorkspace } from './workspace'

const STATE_LABEL: Record<OperationsAgentState, string> = {
  blocked: 'Blocked',
  idle: 'Idle',
  reviewing: 'Reviewing',
  unknown: 'Unknown',
  waiting: 'Waiting',
  working: 'Working'
}

const STATE_TONE: Record<OperationsAgentState, StatusTone> = {
  blocked: 'bad',
  idle: 'muted',
  reviewing: 'warn',
  unknown: 'muted',
  waiting: 'warn',
  working: 'good'
}

export interface OperationsDelegation {
  goal?: string
  id: string
  sessionId: string
  status?: string
}

function AgentCard({ agent }: { agent: OperationsAgentModel }) {
  const open = async () => {
    try {
      await openAgentWorkspace(host, agent)
    } catch (error) {
      host.notifyError(error, `Could not open ${agent.displayName}`)
    }
  }

  return (
    <article className="min-w-0 border-b border-(--ui-stroke-tertiary) px-3 py-3 last:border-b-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-(--ui-text-primary)">{agent.displayName}</h3>
            <span className="inline-flex items-center gap-1 text-xs text-(--ui-text-tertiary)">
              <StatusDot tone={STATE_TONE[agent.state]} />
              {STATE_LABEL[agent.state]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-(--ui-text-tertiary)">@{agent.profile} · {agent.sourceLabel}</p>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-(--ui-text-secondary)">{agent.workSummary}</p>
        </div>
        <Button
          aria-label={`Open ${agent.displayName} workspace`}
          className="min-h-11 shrink-0 px-3 coarse:min-w-11"
          onClick={() => void open()}
          size="sm"
          variant="outline"
        >
          Open
        </Button>
      </div>
    </article>
  )
}

export function OperationsOverview({
  delegations,
  routines,
  snapshot
}: {
  delegations: OperationsDelegation[]
  routines: OperationsRoutinesSnapshot
  snapshot: OperationsSnapshot
}) {
  const counts = useMemo(() => {
    const result = new Map<OperationsAgentState, number>()

    for (const agent of snapshot.agents) {
      result.set(agent.state, (result.get(agent.state) ?? 0) + 1)
    }

    return result
  }, [snapshot.agents])

  const assignments = snapshot.agents.flatMap(agent => agent.assignments.map(task => ({ agent, task })))

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden border border-(--ui-stroke-tertiary) bg-(--ui-stroke-tertiary) sm:grid-cols-3 lg:grid-cols-6">
        {(['working', 'waiting', 'blocked', 'reviewing', 'idle', 'unknown'] as OperationsAgentState[]).map(state => (
          <div className="min-w-0 bg-(--ui-chat-surface-background) p-3" key={state}>
            <p className="text-[0.68rem] uppercase tracking-wide text-(--ui-text-quaternary)">{STATE_LABEL[state]}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-(--ui-text-primary)">{counts.get(state) ?? 0}</p>
          </div>
        ))}
      </div>

      <section aria-label="Hermes sources" className="min-w-0 border border-(--ui-stroke-tertiary)">
        <div className="border-b border-(--ui-stroke-tertiary) px-3 py-2 text-xs font-medium text-(--ui-text-secondary)">Sources</div>
        <div className="flex min-w-0 flex-wrap gap-2 p-3">
          {snapshot.sources.map(source => (
            <Badge key={source.id} variant="outline">
              <StatusDot tone={source.status === 'online' ? 'good' : source.status === 'degraded' ? 'warn' : 'bad'} />
              <span>{source.label}</span>
              <span className="sr-only">{source.status}</span>
            </Badge>
          ))}
        </div>
      </section>

      {snapshot.partialFailures.length > 0 && (
        <section aria-label="Partial source failures" className="border border-(--ui-warning-border) bg-(--ui-warning-surface) p-3 text-xs text-(--ui-text-secondary)">
          <p className="font-medium text-(--ui-text-primary)">Some sources are partial</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {snapshot.partialFailures.map(failure => <li key={failure}>{failure}</li>)}
          </ul>
        </section>
      )}

      <section aria-label="Bot roster" className="min-w-0 border border-(--ui-stroke-tertiary)">
        <div className="border-b border-(--ui-stroke-tertiary) px-3 py-2 text-xs font-medium text-(--ui-text-secondary)">Bots</div>
        {snapshot.agents.length > 0 ? (
          <div className="grid min-w-0 grid-cols-1 lg:grid-cols-2">
            {snapshot.agents.map(agent => <AgentCard agent={agent} key={agent.id} />)}
          </div>
        ) : (
          <EmptyState description="Create a Bot profile or connect a reachable Hermes source." title="No Bots available" />
        )}
      </section>

      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        <section aria-label="Delegated agents" className="min-w-0 border border-(--ui-stroke-tertiary) p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--ui-text-tertiary)">Delegated agents</h2>
          {delegations.length > 0 ? (
            <div className="mt-2 space-y-2">
              {delegations.map(item => (
                <div className="border-l-2 border-(--ui-stroke-secondary) pl-2 text-xs" key={`${item.sessionId}:${item.id}`}>
                  <span className="font-medium">{item.goal || 'Delegated work'}</span>
                  <p className="text-(--ui-text-tertiary)">{item.status || 'unknown'} · session {item.sessionId.slice(0, 8)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-(--ui-text-tertiary)">No delegated agents are active or retained.</p>
          )}
        </section>

        <section aria-label="Kanban work" className="min-w-0 border border-(--ui-stroke-tertiary) p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--ui-text-tertiary)">Kanban work</h2>
          {assignments.length > 0 ? (
            <div className="mt-2 space-y-2">
              {assignments.map(({ agent, task }) => (
                <div className="text-xs" key={`${agent.id}:${task.id}`}>
                  <span className="font-medium">{task.title}</span>
                  <p className="text-(--ui-text-tertiary)">{task.status} · {agent.displayName}</p>
                  {task.summary && <p className="line-clamp-2">{task.summary}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-(--ui-text-tertiary)">No Kanban assignments are visible on reachable sources.</p>
          )}
        </section>

        <section aria-label="Routines" className="min-w-0 border border-(--ui-stroke-tertiary) p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--ui-text-tertiary)">Routines</h2>
          {routines.routines.length > 0 ? (
            <div className="mt-2 space-y-2">
              {routines.routines.map(routine => (
                <div className="text-xs" key={`${routine.connectionId}:${routine.profile}:${routine.jobId}`}>
                  <span className="font-medium">{routine.name}</span>
                  <p className="text-(--ui-text-tertiary)">
                    {routine.enabled === false ? 'paused' : 'active'}{routine.schedule ? ` · ${routine.schedule}` : ''}
                  </p>
                  <p className="text-(--ui-text-quaternary)">{routine.connectionLabel} / @{routine.profile}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-(--ui-text-tertiary)" role={routines.failures.length ? 'status' : undefined}>
              {operationsRoutineEmptyMessage(routines)}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
