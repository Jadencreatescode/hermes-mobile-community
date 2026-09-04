/**
 * Forge board types — a minimal, self-contained view of the Kanban board the
 * Forge section renders. These mirror the kanban plugin's `KanbanBoard` /
 * `KanbanTask` shapes (see `plugins/kanban/types.ts`) but are declared here so
 * the operations plugin obeys the plugin fence: plugins import only
 * `@hermes/plugin-sdk` (and react), never `../kanban/*` internals.
 *
 * Only the fields the Forge view actually reads are typed; a backend schema
 * addition never breaks the build.
 */

/** One card. `status` is the column id (see the column names the backend
 *  returns — triage/todo/ready/running/blocked/review/done). */
export interface ForgeTask {
  id: string
  title: string
  body?: null | string
  status: string
  assignee?: null | string
  priority?: number
  latest_summary?: null | string
}

/** One column: a named lane holding the tasks currently in it. */
export interface ForgeColumn {
  name: string
  tasks: ForgeTask[]
}

/** The slice of the board the Forge section renders. */
export interface ForgeBoard {
  columns: ForgeColumn[]
  assignees: string[]
  tenants: string[]
}
