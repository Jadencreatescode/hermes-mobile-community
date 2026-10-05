/**
 * machine-roster.ts
 *
 * Pure builder for the unified machine roster returned by the
 * hermes:machine-roster IPC handler. Separated from main.ts so it
 * unit-tests without Electron or the filesystem.
 */

import { labelKey } from './connection-registry'
import type { ConnectionRegistry } from './connection-registry'
import type { TailscalePeer } from './tailscale-discovery'

export interface MachineRosterEntry {
  id: string
  label: string
  kind: string
  state: 'offline' | 'online' | 'unreachable' | 'not_connected'
  connected: boolean
}

export function buildMachineRoster(
  registry: ConnectionRegistry,
  peers: TailscalePeer[]
): { machines: MachineRosterEntry[] } {
  const registryLabels = new Set(
    registry.connections.map((c: { label: string }) => labelKey(c.label))
  )

  const machines: MachineRosterEntry[] = registry.connections.map(
    (c: { id: string; label: string; kind: string }) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      state: 'offline',
      connected: true
    })
  )

  for (const peer of peers) {
    if (registryLabels.has(labelKey(peer.label))) {
      continue
    }

    machines.push({
      id: peer.id,
      label: peer.label,
      kind: 'tailscale',
      state: peer.online ? 'not_connected' : 'offline',
      connected: false
    })
  }

  return { machines }
}
