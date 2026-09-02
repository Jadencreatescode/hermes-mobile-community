/**
 * ForgeView — the compact, read-only Kanban board that lives inside the
 * Operations tab. It surfaces the active Forge pipeline (the `hermes-forge`
 * board) as a responsive grid of columns, each holding a stack of cards.
 *
 * It reuses the kanban plugin's REST contract (`/board?board=hermes-forge`)
 * through the operations plugin's own REST door (see ./forge-data) and its
 * types (./types), so it works whether or not the kanban plugin is enabled.
 *
 * Deliberately lean vs. the standalone /kanban page: no drag-and-drop, no
 * create/edit, no board switcher. It's a glanceable fleet-status strip —
 * columns as a grid, one card per task showing title, status, assignee,
 * priority, and a truncated summary — tuned for mobile/PWA viewports.
 */

import {
  Button,
  Codicon,
  ErrorState,
  Loader,
  profileColor,
  profileColorSoft,
  useQuery
} from '@hermes/plugin-sdk'
import { useMemo } from 'react'

import { fetchForgeBoard, FORGE_BOARD_SLUG } from './forge-data'
import type { ForgeTask } from './forge-types'

/** Column presentation — codicon + tone only. Mirrors the kanban plugin's
 *  COLUMN_META so a Forge column reads the same hue it would standalone. */
const COLUMN_META: Record<string, { codicon: string; tone: string }> = {
  triage: { codicon: 'inbox', tone: 'var(--ui-text-tertiary)' },
  todo: { codicon: 'circle-outline', tone: 'var(--ui-text-secondary)' },
  scheduled: { codicon: 'watch', tone: '#a78bfa' },
  ready: { codicon: 'play-circle', tone: '#60a5fa' },
  running: { codicon: 'sync', tone: '#34d399' },
  blocked: { codicon: 'error', tone: '#f87171' },
  review: { codicon: 'eye', tone: '#fbbf24' },
  done: { codicon: 'pass', tone: 'var(--ui-text-tertiary)' },
  archived: { codicon: 'archive', tone: 'var(--ui-text-quaternary)' }
}

const columnMeta = (name: string) =>
  COLUMN_META[name] ?? { codicon: 'circle-outline', tone: 'var(--ui-text-secondary)' }

/** Backend timestamps are epoch SECONDS; the canonical formatter takes ms. */
const ago = (seconds?: null | number): null | string => (seconds ? new Date(seconds * 1000).toLocaleString() : '')

/** Deterministic initials for an unavatar'd assignee. */
function initials(name: string): string {
  const parts = name.trim().split(/[\s_\-./]+/).filter(Boolean)

  return `${parts[0]?.[0] ?? '?'}${parts[1]?.[0] ?? ''}`.toUpperCase()
}

/** The Forge pipeline's canonical column order; any extra column the backend
 *  adds renders after, so a new lane never disappears. */
const FORGE_COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done'] as const

function Avatar({ name, size = '1.5rem' }: { name: string; size?: string }) {
  const color = profileColor(name)

  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold"
      style={{
        backgroundColor: color ? profileColorSoft(color, 22) : 'var(--ui-bg-quaternary)',
        color: color ?? 'var(--ui-text-secondary)',
        fontSize: '0.625rem',
        height: size,
        width: size
      }}
    >
      {initials(name)}
    </span>
  )
}

function Card({ task }: { task: ForgeTask }) {
  const summary = task.body ?? ''

  return (
    <article
      aria-label={`Task: ${task.title}`}
      className="relative flex flex-col gap-1.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-2"
    >
      <span className="line-clamp-2 text-[0.8125rem] font-medium leading-snug text-foreground">
        {task.title || task.id}
      </span>
      {summary && (
        <span className="line-clamp-2 text-[0.6875rem] leading-snug text-(--ui-text-tertiary)">
          {summary}
        </span>
      )}
      <div className="mt-auto flex items-center gap-2 whitespace-nowrap text-[0.625rem] text-(--ui-text-tertiary)">
        {typeof task.priority === 'number' && task.priority > 0 && (
          <span className="inline-flex items-center gap-0.5 text-amber-500">
            <Codicon name="arrow-up" size="0.7rem" />
            {task.priority}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 min-w-0">
          {task.assignee ? (
            <span className="inline-flex items-center gap-1" title={task.assignee}>
              <Avatar name={task.assignee} size="1.25rem" />
              <span className="truncate">{task.assignee}</span>
            </span>
          ) : (
            <span className="text-(--ui-text-quaternary)">unassigned</span>
          )}
          <span className="min-w-0 truncate font-mono text-(--ui-text-quaternary)">
            {task.id.replace(/^t_/, '').slice(0, 6)}
          </span>
        </div>
      </div>
    </article>
  )
}

function Column({ name, tasks }: { name: string; tasks: ForgeTask[] }) {
  const meta = columnMeta(name)
  const label = name.charAt(0).toUpperCase() + name.slice(1)

  return (
    <section
      aria-label={`${name} column, ${tasks.length} tasks`}
      className="flex min-h-0 flex-col rounded-lg bg-(--ui-bg-quinary) p-2"
    >
      <header className="mb-1.5 flex items-center gap-1.5 px-1 pb-1.5">
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: meta.tone }} />
        <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">
          {label}
        </span>
        <span className="ml-auto text-[0.625rem] tabular-nums text-(--ui-text-quaternary)">
          {tasks.length}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {tasks.map(task => (
          <Card key={task.id} task={task} />
        ))}
        {tasks.length === 0 && (
          <div className="pointer-events-none grid place-items-center py-4 text-[0.6875rem] text-(--ui-text-quaternary)">
            Empty
          </div>
        )}
      </div>
    </section>
  )
}

/** The Forge board — a compact, read-only, responsive Kanban grid. */
export function ForgeView() {
  const { data, error, isLoading } = useQuery({
    queryFn: fetchForgeBoard,
    queryKey: ['operations', 'forge', FORGE_BOARD_SLUG],
    refetchInterval: 8_000
  })

  const columns = useMemo(() => {
    if (!data) {
      return []
    }

    // Canonical order first, then any extra columns the backend added.
    const byName = new Map(data.columns.map(col => [col.name, col.tasks]))
    const ordered = [...FORGE_COLUMNS.filter(name => byName.has(name)), ...data.columns.map(col => col.name).filter(name => !FORGE_COLUMNS.includes(name as never))]

    return ordered.map(name => ({ name, tasks: byName.get(name) ?? [] }))
  }, [data])

  const total = columns.reduce((sum, col) => sum + col.tasks.length, 0)

  if (isLoading) {
    return (
      <div className="grid h-full min-h-[12rem] place-items-center">
        <Loader label="Loading Forge" type="lemniscate-bloom" />
      </div>
    )
  }

  if (error) {
    return (
      <ErrorState
        description={error.message}
        title="Forge board could not load"
      >
        <Button className="min-h-11" onClick={() => window.location.reload()} variant="outline">
          Retry
        </Button>
      </ErrorState>
    )
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Forge</h2>
          <p className="text-sm text-(--ui-text-secondary)">
            The active hermes-forge pipeline — {total} task{total === 1 ? '' : 's'} across every lane.
          </p>
        </div>
      </header>
      <div className="grid min-w-0 gap-2 auto-rows-fr grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
        {columns.map(col => (
          <Column key={col.name} name={col.name} tasks={col.tasks} />
        ))}
      </div>
    </div>
  )
}
