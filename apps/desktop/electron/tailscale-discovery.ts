/**
 * tailscale-discovery.ts
 *
 * Read-only enumeration of the user's own tailnet peers through the locally
 * installed Tailscale client. Pure Node.js — no Electron imports — so it
 * unit-tests without a renderer or main process.
 *
 * Security rules:
 *   - No shell interpolation of peer names.
 *   - No writes, no administration, no auth keys, no tailnet API tokens.
 *   - Bounded timeout; absent client degrades silently to empty list.
 *   - Parsed output is treated as untrusted input.
 */

import { execFile } from 'node:child_process'

export const TAILSCALE_PEER_ID_PREFIX = 'tailscale:'

export interface TailscalePeer {
  /** Synthetic id, prefixed to avoid collision with registry connection ids. */
  id: string
  /** Display name — the peer's hostname or DNS name. */
  label: string
  /** Whether the peer is currently online according to the local client. */
  online: boolean
}

interface TailscaleStatusPeer {
  HostName?: string
  DNSName?: string
  Online?: boolean
}

interface TailscaleStatus {
  Peer?: Record<string, TailscaleStatusPeer>
  Self?: TailscaleStatusPeer
}

const DEFAULT_TIMEOUT_MS = 5_000

function runTailscaleStatus(timeoutMs: number, execFileFn = execFile): Promise<string | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      resolve(null)
    }, timeoutMs)

    execFileFn(
      'tailscale',
      ['status', '--json'],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        clearTimeout(timer)

        if (err) {
          resolve(null)

          return
        }

        resolve(String(stdout || ''))
      }
    )
  })
}

function normalizePeerLabel(peer: TailscaleStatusPeer): string {
  const host = String(peer.HostName || '').trim()

  if (host) {
    return host
  }

  const dns = String(peer.DNSName || '').trim()

  if (dns) {
    // Drop the trailing dot and any tailnet suffix for a clean label.
    return dns.replace(/\.$/, '').split('.')[0] || dns
  }

  return ''
}

export function parseTailscaleStatus(jsonText: string): TailscalePeer[] {
  let payload: unknown

  try {
    payload = JSON.parse(jsonText)
  } catch {
    return []
  }

  if (!payload || typeof payload !== 'object') {
    return []
  }

  const status = payload as TailscaleStatus
  const peers = status.Peer

  if (!peers || typeof peers !== 'object') {
    return []
  }

  const result: TailscalePeer[] = []
  const seenLabels = new Set<string>()

  for (const [, rawPeer] of Object.entries(peers)) {
    if (!rawPeer || typeof rawPeer !== 'object') {
      continue
    }

    const peer = rawPeer as TailscaleStatusPeer
    const label = normalizePeerLabel(peer)

    if (!label) {
      continue
    }

    const online = peer.Online === true

    // Deduplicate by label within the discovered set.
    if (seenLabels.has(label)) {
      continue
    }

    seenLabels.add(label)

    result.push({
      id: `${TAILSCALE_PEER_ID_PREFIX}${label}`,
      label,
      online
    })
  }

  return result
}

export async function discoverTailscalePeers(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFileFn = execFile
): Promise<TailscalePeer[]> {
  const raw = await runTailscaleStatus(timeoutMs, execFileFn)

  if (!raw) {
    return []
  }

  return parseTailscaleStatus(raw)
}
