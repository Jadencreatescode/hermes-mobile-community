import { describe, expect, it, vi } from 'vitest'

import {
  loadBrowserRuntimeDescriptor,
  nodeBaseUrl,
  nodeRequestUrl,
  parseBrowserRuntimeDescriptor,
  resolveBrowserNode,
  selectableBrowserNodes
} from './nodes'

const descriptor = {
  version: 1 as const,
  backend: { id: 'strix-halo', label: 'Strix Halo' }
}

describe('browser runtime descriptor', () => {
  it('accepts one relay-supplied backend and exposes only that backend', () => {
    const parsed = parseBrowserRuntimeDescriptor(descriptor)

    expect(selectableBrowserNodes(parsed)).toEqual([{ id: 'strix-halo', label: 'Strix Halo', profiles: [] }])
    expect(resolveBrowserNode(parsed, 'strix-halo')).toEqual({ id: 'strix-halo', label: 'Strix Halo', profiles: [] })
    expect(nodeBaseUrl(new URL('https://mobile.example.test/app/'), parsed, 'strix-halo')).toBe(
      'https://mobile.example.test'
    )
    expect(nodeRequestUrl(new URL('https://mobile.example.test/'), parsed, 'strix-halo', '/api/status')).toBe(
      'https://mobile.example.test/api/status'
    )
  })

  it('fails closed for missing, malformed, or extra backend data', () => {
    const invalid = [
      null,
      {},
      { version: 2, backend: descriptor.backend },
      { version: 1, backend: { id: 'vps/../../other', label: 'Other' } },
      { version: 1, backend: { id: 'local', label: '' } },
      { version: 1, backend: { id: 'local', label: 'Local', url: 'https://attacker.example' } },
      { version: 1, backend: descriptor.backend, backends: [descriptor.backend] }
    ]

    for (const value of invalid) {
      expect(() => parseBrowserRuntimeDescriptor(value)).toThrow(/runtime descriptor/i)
    }
  })

  it('rejects unknown connection ids instead of falling back to an owner node', () => {
    const parsed = parseBrowserRuntimeDescriptor(descriptor)

    expect(() => resolveBrowserNode(parsed, 'vps')).toThrow(/unavailable/i)
    expect(() => nodeBaseUrl(new URL('https://mobile.example.test/'), parsed, null)).toThrow(/unavailable/i)
  })

  it('loads the descriptor from the fixed same-origin relay endpoint with cookies', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(descriptor), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(loadBrowserRuntimeDescriptor(fetcher, new URL('https://mobile.example.test/app/'))).resolves.toEqual(
      descriptor
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://mobile.example.test/.well-known/hermes-mobile-runtime.json',
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('fails closed when the relay descriptor cannot be loaded', async () => {
    const fetcher = vi.fn(async () => new Response('missing', { status: 404 }))

    await expect(loadBrowserRuntimeDescriptor(fetcher, new URL('https://mobile.example.test/'))).rejects.toThrow(
      /runtime descriptor/i
    )
  })
})
