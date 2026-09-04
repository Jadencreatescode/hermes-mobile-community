import { Button, Codicon, ErrorState, host, Loader, useValue } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadOperationsSnapshot, type OperationsSnapshot } from './data'
import { ForgeView } from './forge-view'
import { MailroomView } from './mailroom-view'
import { MeetingsView } from './meetings-view'
import { OperationsNavigation, type OperationsSection } from './navigation'
import { type OperationsDelegation, OperationsOverview } from './overview'
import { loadOperationsRoutines, type OperationsRoutinesSnapshot } from './routines'
import { WorkspaceView } from './workspace-view'

const REFRESH_MS = 60_000

const EMPTY_ROUTINES: OperationsRoutinesSnapshot = {
  failures: [],
  routines: [],
  successfulSources: 0
}

function TrainingPanel() {
  return (
    <section className="mx-auto max-w-2xl space-y-3 rounded-xl border border-(--ui-stroke-secondary) p-4">
      <div className="flex items-center gap-2">
        <Codicon name="mortar-board" size="1.1rem" />
        <h2 className="text-base font-semibold">Training</h2>
      </div>
      <p className="text-sm text-(--ui-text-secondary)">
        Use the public review first Training Mode to turn semantic steps into a reusable skill. It does not run or schedule the task.
      </p>
      <Button className="min-h-11 w-full sm:w-auto" onClick={() => host.navigate('/training')}>
        Open Training Mode
      </Button>
    </section>
  )
}

export function OperationsPage() {
  const activeConnectionId = useValue(host.state.connectionId)
  const activeProfile = useValue(host.state.profile)
  const gatewayState = useValue(host.state.gateway)
  const delegatedBySession = useValue(host.state.subagents)
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [routines, setRoutines] = useState<OperationsRoutinesSnapshot>(EMPTY_ROUTINES)
  const [error, setError] = useState<Error | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [section, setSection] = useState<OperationsSection>('overview')
  const refreshGeneration = useRef(0)
  const foregroundGeneration = useRef(0)

  const delegations = useMemo<OperationsDelegation[]>(
    () => Object.entries(delegatedBySession as Record<string, Array<{ goal?: string; id: string; status?: string }>>)
      .flatMap(([sessionId, items]) => items.map(item => ({ ...item, sessionId }))),
    [delegatedBySession]
  )

  const refresh = useCallback(async (quiet = false) => {
    void activeConnectionId
    void activeProfile
    const generation = ++refreshGeneration.current
    const foreground = quiet ? 0 : ++foregroundGeneration.current

    if (!quiet) {
      setRefreshing(true)
    }

    try {
      const [nextSnapshot, nextRoutines] = await Promise.all([
        loadOperationsSnapshot(host, { delegatedBySession: delegatedBySession as never }),
        loadOperationsRoutines(host)
      ])

      if (generation !== refreshGeneration.current) {
        return
      }

      setSnapshot(nextSnapshot)
      setRoutines(nextRoutines)
      setError(null)
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      }
    } finally {
      if (!quiet && foreground === foregroundGeneration.current) {
        setRefreshing(false)
      }
    }
  }, [activeConnectionId, activeProfile, delegatedBySession])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), REFRESH_MS)

    return () => window.clearInterval(timer)
  }, [refresh])

  if (!snapshot && !error) {
    return <div className="grid h-full place-items-center"><Loader label="Loading Operations" type="lemniscate-bloom" /></div>
  }

  if (!snapshot && error) {
    return (
      <ErrorState description={error.message} title="Operations could not load">
        <Button className="min-h-11" onClick={() => void refresh()} variant="outline">Retry</Button>
      </ErrorState>
    )
  }

  const stableSnapshot = snapshot as OperationsSnapshot

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--ui-stroke-tertiary) px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Operations</h1>
          <p className="text-sm text-(--ui-text-secondary)">Bots, delegated workers, assignments, routines, and source health.</p>
        </div>
        <Button
          aria-label="Refresh Operations"
          className="min-h-11 min-w-11"
          disabled={refreshing}
          onClick={() => void refresh()}
          size="sm"
          variant="ghost"
        >
          <Codicon className={refreshing ? 'animate-spin' : ''} name="refresh" />
          Refresh
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
        <OperationsNavigation active={section} onChange={setSection} />
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4">
          {gatewayState !== 'open' && (
            <div className="mb-4 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">
              Gateway {gatewayState === 'connecting' ? 'reconnecting' : gatewayState}. Operations data may be stale until the connection recovers.
            </div>
          )}
          {error && (
            <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              Refresh failed: {error.message}. The last verified snapshot remains visible.
            </div>
          )}
          {section === 'overview' && (
            <OperationsOverview delegations={delegations} routines={routines} snapshot={stableSnapshot} />
          )}
          {section === 'mailroom' && (
            <MailroomView
              activeProfile={activeProfile}
              profiles={[
                activeProfile,
                ...stableSnapshot.agents
                  .filter(agent => agent.sourceId === activeConnectionId)
                  .map(agent => agent.profile)
              ]}
            />
          )}
          {section === 'meetings' && <MeetingsView snapshot={stableSnapshot} />}
          {section === 'workspace' && <WorkspaceView agents={stableSnapshot.agents} />}
          {section === 'forge' && <ForgeView />}
          {section === 'training' && <TrainingPanel />}
        </section>
      </div>
    </main>
  )
}
