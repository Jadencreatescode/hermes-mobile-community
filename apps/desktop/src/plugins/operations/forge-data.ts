/**
 * Forge board data layer.
 *
 * The Operations plugin surfaces the active Forge pipeline (the `hermes-forge`
 * Kanban board) as a compact, read-only section. This module owns the single
 * REST call: it drives the operations plugin's own `ctx.rest` door
 * (`/api/plugins/kanban`) — NOT the kanban plugin's — so the Forge view works
 * even when the kanban plugin is disabled. It hits the same `/board` endpoint
 * the standalone board uses, pinned to `?board=hermes-forge` so we never flip
 * the server-wide current-board pointer.
 *
 * The board shape is described by ./forge-types (a local, minimal view of the
 * kanban contract) so the operations plugin obeys the plugin fence — it imports
 * only @hermes/plugin-sdk (and react), never ../kanban/* internals.
 */

import { operationsApi } from './api'
import type { ForgeBoard } from './forge-types'

/** The Forge pipeline is the one board Operations surfaces. */
export const FORGE_BOARD_SLUG = 'hermes-forge'

/**
 * Fetch the Forge board. The operations REST door throws when it is unavailable
 * (plugin not registered); callers treat that as a load error.
 */
export async function fetchForgeBoard(): Promise<ForgeBoard> {
  const rest = operationsApi()

  return rest<ForgeBoard>(`/board?board=${encodeURIComponent(FORGE_BOARD_SLUG)}`)
}
