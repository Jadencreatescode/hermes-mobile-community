/**
 * Forge board data layer.
 *
 * The Operations plugin surfaces the active Forge pipeline (the `hermes-forge`
 * Kanban board) as a compact, read-only section. This module owns the single
 * REST call, made through the KANBAN plugin's own REST door
 * (`/api/plugins/kanban/board?board=hermes-forge`) via the SDK's narrow,
 * read-only `host.readKanbanBoard` capability — the Forge section renders the same board the standalone
 * kanban page does, pinned to `?board=hermes-forge` so we never flip the
 * server-wide current-board pointer.
 *
 * Because the call goes through kanban's namespace, the Forge section only
 * works when the kanban plugin is enabled: a disabled plugin's router is not
 * mounted on the backend, so the call rejects with the dashboard's 404
 * "No such API endpoint". `isForgeUnavailable` classifies that verdict so the
 * view can tell the user to enable the plugin instead of showing a generic
 * failure.
 *
 * The board shape is described by ./forge-types (a local, minimal view of the
 * kanban contract) so the operations plugin obeys the plugin fence — it imports
 * only @hermes/plugin-sdk (and react), never ../kanban/* internals.
 */

import { host } from '@hermes/plugin-sdk'

import type { ForgeBoard } from './forge-types'

/** The Forge pipeline is the one board Operations surfaces. */
export const FORGE_BOARD_SLUG = 'hermes-forge'

/** The kanban plugin's id — its backend namespace (see plugins/kanban/plugin.tsx)
 *  and its key in the desktop plugin inventory (`host.state.plugins`). */
export const KANBAN_PLUGIN_ID = 'kanban'

/** True when the Forge call failed because the kanban plugin is not enabled —
 *  its router is unmounted, so the backend answers 404 "No such API endpoint"
 *  (wrapped as `404: {"detail":"No such API endpoint: …"}` by the bridge).
 *  Transient failures (timeouts, 5xx, connection refused) must NOT match:
 *  those are retryable, not an enable-Kanban verdict. */
export function isForgeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /no such api endpoint/i.test(message) || /endpoint is likely missing/i.test(message)
}

/** Fetch the Forge board through the kanban plugin's REST door. Rejects with a
 *  404-style error when the kanban plugin is disabled (see
 *  `isForgeUnavailable`); other rejections are ordinary load failures. */
export async function fetchForgeBoard(): Promise<ForgeBoard> {
  return host.readKanbanBoard<ForgeBoard>(FORGE_BOARD_SLUG)
}
