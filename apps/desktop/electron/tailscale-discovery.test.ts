/**
 * Tests for tailscale-discovery.ts
 *
 * Covers: parser against recorded client output shapes, malformed payload,
 * empty payload, absent client path, and the deduplication invariant.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { discoverTailscalePeers, parseTailscaleStatus, TAILSCALE_PEER_ID_PREFIX } from './tailscale-discovery'

test('parseTailscaleStatus returns peers from a well-formed client output', () => {
  const payload = JSON.stringify({
    Version: '1.72.1',
    BackendState: 'Running',
    Self: {
      HostName: 'my-laptop',
      DNSName: 'my-laptop.tailnet.ts.net.',
      Online: true
    },
    Peer: {
      'nodekey:abc': {
        HostName: 'homelab',
        DNSName: 'homelab.tailnet.ts.net.',
        Online: true
      },
      'nodekey:def': {
        HostName: 'mini',
        DNSName: 'mini.tailnet.ts.net.',
        Online: false
      }
    }
  })

  const peers = parseTailscaleStatus(payload)

  assert.equal(peers.length, 2)
  assert.equal(peers[0].label, 'homelab')
  assert.equal(peers[0].id, `${TAILSCALE_PEER_ID_PREFIX}homelab`)
  assert.equal(peers[0].online, true)
  assert.equal(peers[1].label, 'mini')
  assert.equal(peers[1].online, false)
})

test('parseTailscaleStatus falls back to DNSName when HostName is absent', () => {
  const payload = JSON.stringify({
    Peer: {
      'nodekey:abc': {
        DNSName: 'server.tailnet.ts.net.',
        Online: true
      }
    }
  })

  const peers = parseTailscaleStatus(payload)

  assert.equal(peers.length, 1)
  assert.equal(peers[0].label, 'server')
  assert.equal(peers[0].id, `${TAILSCALE_PEER_ID_PREFIX}server`)
})

test('parseTailscaleStatus returns empty array for malformed JSON', () => {
  assert.deepEqual(parseTailscaleStatus('not json'), [])
})

test('parseTailscaleStatus returns empty array when Peer is missing', () => {
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ Self: { HostName: 'me' } })), [])
})

test('parseTailscaleStatus returns empty array when Peer is not an object', () => {
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ Peer: [] })), [])
})

test('parseTailscaleStatus skips peers with no identity and returns the rest', () => {
  const payload = JSON.stringify({
    Peer: {
      'nodekey:abc': {
        HostName: 'good',
        Online: true
      },
      'nodekey:empty': {},
      'nodekey:bad': null
    }
  })

  const peers = parseTailscaleStatus(payload)

  assert.equal(peers.length, 1)
  assert.equal(peers[0].label, 'good')
})

test('parseTailscaleStatus deduplicates by label', () => {
  const payload = JSON.stringify({
    Peer: {
      'nodekey:abc': {
        HostName: 'dup',
        Online: true
      },
      'nodekey:def': {
        HostName: 'dup',
        Online: false
      }
    }
  })

  const peers = parseTailscaleStatus(payload)

  assert.equal(peers.length, 1)
  // First wins.
  assert.equal(peers[0].online, true)
})

test('parseTailscaleStatus tolerates an empty string', () => {
  assert.deepEqual(parseTailscaleStatus(''), [])
})

test('discoverTailscalePeers returns empty list when tailscale is absent', async () => {
  const execFileFn = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(new Error('ENOENT'), '', ''))

    return { stdin: { end() {} } }
  }

  const peers = await discoverTailscalePeers(500, execFileFn as any)

  assert.deepEqual(peers, [])
})

test('discoverTailscalePeers respects the timeout', async () => {
  // A very short timeout should still resolve (not hang) even if tailscale is present.
  const peers = await discoverTailscalePeers(1)

  assert.ok(Array.isArray(peers))
})
