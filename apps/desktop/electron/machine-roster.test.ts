/**
 * Tests for machine-roster.ts
 *
 * Covers: registry connections are listed first, tailscale peers are merged,
 * duplicate labels are deduplicated, unconnected peers are marked honestly,
 * offline peers are preserved, and the local machine is always present.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { normalizeRegistry } from './connection-registry'
import { buildMachineRoster } from './machine-roster'

test('includes local and every registry connection', () => {
  const registry = normalizeRegistry({
    connections: [
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab', url: 'https://homelab.example' },
      { id: 'work-ssh', kind: 'ssh', label: 'Work', host: 'work.example', user: 'dev' }
    ]
  })

  const { machines } = buildMachineRoster(registry, [])

  assert.equal(machines.length, 3)
  assert.equal(machines[0].id, 'local')
  assert.equal(machines[0].kind, 'local')
  assert.equal(machines[0].connected, true)
  assert.equal(machines[0].state, 'offline')
  assert.equal(machines[1].id, 'homelab')
  assert.equal(machines[1].kind, 'remote')
  assert.equal(machines[2].id, 'work-ssh')
  assert.equal(machines[2].kind, 'ssh')
})

test('appends tailscale peers that are not already in the registry', () => {
  const registry = normalizeRegistry({
    connections: [
      { id: 'local', kind: 'local', label: 'This device' }
    ]
  })

  const { machines } = buildMachineRoster(registry, [
    { id: 'tailscale:mini', label: 'mini', online: true },
    { id: 'tailscale:server', label: 'server', online: false }
  ])

  assert.equal(machines.length, 3)
  assert.equal(machines[1].id, 'tailscale:mini')
  assert.equal(machines[1].kind, 'tailscale')
  assert.equal(machines[1].state, 'not_connected')
  assert.equal(machines[1].connected, false)
  assert.equal(machines[2].id, 'tailscale:server')
  assert.equal(machines[2].state, 'offline')
  assert.equal(machines[2].connected, false)
})

test('deduplicates tailscale peers by label when a registry connection shares the name', () => {
  const registry = normalizeRegistry({
    connections: [
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab', url: 'https://homelab.example' }
    ]
  })

  const { machines } = buildMachineRoster(registry, [
    { id: 'tailscale:homelab', label: 'homelab', online: true }
  ])

  assert.equal(machines.length, 2)
  assert.ok(machines.every(m => m.id !== 'tailscale:homelab'))
})

test('deduplication is case-insensitive', () => {
  const registry = normalizeRegistry({
    connections: [
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'HomeLab', url: 'https://homelab.example' }
    ]
  })

  const { machines } = buildMachineRoster(registry, [
    { id: 'tailscale:homelab', label: 'homelab', online: true }
  ])

  assert.equal(machines.length, 2)
})

test('returns only local when registry has no other connections and tailscale is absent', () => {
  const registry = normalizeRegistry(null)
  const { machines } = buildMachineRoster(registry, [])

  assert.equal(machines.length, 1)
  assert.equal(machines[0].id, 'local')
  assert.equal(machines[0].kind, 'local')
})

test('preserves an offline tailscale peer as offline', () => {
  const registry = normalizeRegistry({
    connections: [{ id: 'local', kind: 'local', label: 'This device' }]
  })

  const { machines } = buildMachineRoster(registry, [
    { id: 'tailscale:oldbox', label: 'oldbox', online: false }
  ])

  const oldbox = machines.find(m => m.id === 'tailscale:oldbox')

  assert.ok(oldbox)
  assert.equal(oldbox?.state, 'offline')
  assert.equal(oldbox?.connected, false)
})

test('never mutates the input registry or peers', () => {
  const registry = normalizeRegistry({
    connections: [{ id: 'local', kind: 'local', label: 'This device' }]
  })

  const peers = [{ id: 'tailscale:x', label: 'x', online: true }]

  buildMachineRoster(registry, peers)

  assert.equal(peers.length, 1)
  assert.equal(registry.connections.length, 1)
})
