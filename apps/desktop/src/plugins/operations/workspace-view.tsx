import { Button, host } from '@hermes/plugin-sdk'

import type { OperationsAgentModel } from './data'
import { openAgentWorkspace } from './workspace'

export function WorkspaceView({ agents }: { agents: OperationsAgentModel[] }) {
  const open = async (agent: OperationsAgentModel) => {
    try {
      await openAgentWorkspace(host, agent)
    } catch (error) {
      host.notifyError(error, `Could not open ${agent.displayName}`)
    }
  }

  return (
    <section className="mx-auto min-w-0 max-w-4xl space-y-4">
      <header className="rounded-xl border border-(--ui-stroke-secondary) p-4">
        <h2 className="text-base font-semibold">Agent Workspace</h2>
        <p className="mt-2 text-sm text-(--ui-text-secondary)">
          Transcript, files, changes, terminal, and preview remain in the existing Hermes workspace. Operations opens the exact source profile and session rather than cloning those surfaces.
        </p>
        <p className="mt-2 text-xs text-(--ui-text-tertiary)">
          Public Operations is read only until you enter the ordinary Hermes workspace and approve any action there.
        </p>
      </header>
      {agents.length > 0 ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {agents.map(agent => (
            <article className="min-w-0 rounded-xl border border-(--ui-stroke-secondary) p-4" key={agent.id}>
              <h3 className="truncate text-sm font-semibold">{agent.displayName}</h3>
              <p className="mt-1 truncate text-xs text-(--ui-text-tertiary)">@{agent.profile} · {agent.sourceLabel}</p>
              <p className="mt-3 line-clamp-2 text-sm text-(--ui-text-secondary)">{agent.workSummary}</p>
              <Button
                aria-label={`Open ${agent.displayName} workspace`}
                className="mt-4 min-h-11 w-full"
                onClick={() => void open(agent)}
                variant="outline"
              >
                Open workspace
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-(--ui-stroke-secondary) p-4 text-sm text-(--ui-text-tertiary)">
          No Bot workspaces available.
        </p>
      )}
    </section>
  )
}
