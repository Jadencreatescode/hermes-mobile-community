import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserBridge, installBrowserBridge } from './bridge'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const originalBridge = desktopWindow.hermesDesktop
const runtimeDescriptor = { version: 1 as const, backend: { id: 'strix-halo', label: 'Strix Halo' } }

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

afterEach(() => {
  desktopWindow.hermesDesktop = originalBridge
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('browser Desktop capability bridge', () => {
  it('never replaces the Electron preload bridge or loads mobile configuration', async () => {
    const electron = { api: vi.fn() } as unknown as Window['hermesDesktop']
    const fetcher = vi.fn()
    desktopWindow.hermesDesktop = electron

    await expect(installBrowserBridge({ fetcher })).resolves.toBe(electron)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('loads a relay descriptor before installing one same-origin backend', async () => {
    delete desktopWindow.hermesDesktop
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/.well-known/hermes-mobile-runtime.json')) {return response(runtimeDescriptor)}
      if (url.endsWith('/api/auth/ws-ticket')) {return response({ ticket: 'single-use' })}
      return response({ ok: true })
    })

    const bridge = await installBrowserBridge({
      fetcher,
      location: new URL('https://mobile.example.test/app/')
    })
    const registry = await bridge.connections.list()
    const connection = await bridge.getConnection()
    const ws = await bridge.getGatewayWsUrl?.()

    expect(registry.connections).toHaveLength(1)
    expect(registry.connections[0]).toMatchObject({ id: 'strix-halo', label: 'Strix Halo', url: 'https://mobile.example.test' })
    expect(registry.primary).toBe('strix-halo')
    expect(registry.lastUsed).toBe('strix-halo')
    expect(connection).toMatchObject({
      authMode: 'oauth',
      baseUrl: 'https://mobile.example.test',
      connectionId: 'strix-halo',
      mode: 'remote',
      wsUrl: 'wss://mobile.example.test/api/ws'
    })
    expect(ws).toEqual({ ok: true, wsUrl: 'wss://mobile.example.test/api/ws?ticket=single-use' })
  })

  it('fails closed without installing a bridge when the descriptor is invalid', async () => {
    delete desktopWindow.hermesDesktop
    const fetcher = vi.fn(async () => response({ version: 1, backend: { id: 'vps', label: 'VPS', url: 'https://owner' } }))

    await expect(
      installBrowserBridge({ fetcher, location: new URL('https://mobile.example.test/') })
    ).rejects.toThrow(/runtime descriptor/i)
    expect(desktopWindow.hermesDesktop).toBeUndefined()
  })

  it('rejects stale or unknown connection ids instead of falling back', async () => {
    localStorage.setItem('hermes-mobile-connection-id', 'vps')
    const bridge = createBrowserBridge({
      location: new URL('https://mobile.example.test/'),
      runtimeDescriptor
    })

    await expect(bridge.getConnection()).resolves.toMatchObject({ connectionId: 'strix-halo' })
    await expect(bridge.getConnectionFor?.({ connectionId: 'vps' })).rejects.toThrow(/unavailable/i)
    await expect(bridge.connections.setLastUsed?.('vps')).rejects.toThrow(/unavailable/i)
  })

  it('preserves same-origin cookie REST authentication and profile scope', async () => {
    const fetcher = vi.fn(async () => response({ model: 'ornith' }))
    const bridge = createBrowserBridge({
      fetcher,
      location: new URL('https://mobile.example.test/'),
      runtimeDescriptor
    })

    await bridge.api({
      body: { enabled: true },
      connectionId: 'strix-halo',
      method: 'PUT',
      path: '/api/model/moa',
      profile: 'coder'
    })

    expect(fetcher).toHaveBeenCalledWith(
      'https://mobile.example.test/api/model/moa?profile=coder',
      expect.objectContaining({
        body: JSON.stringify({ enabled: true }),
        credentials: 'include',
        method: 'PUT'
      })
    )
  })

  it('builds a same-origin media stream URL scoped to the selected connection and profile', () => {
    const bridge = createBrowserBridge({
      location: new URL('https://mobile.example.test/app/'),
      runtimeDescriptor
    }) as Window['hermesDesktop'] & {
      gatewayMediaStreamUrl: (payload: { connectionId?: string; path: string; profile?: string }) => string
    }

    expect(
      bridge.gatewayMediaStreamUrl({
        connectionId: 'strix-halo',
        path: '/home/me/voice memo.m4a',
        profile: 'voice reviewer'
      })
    ).toBe(
      'https://mobile.example.test/api/files/stream?path=%2Fhome%2Fme%2Fvoice+memo.m4a&profile=voice+reviewer'
    )
    expect(() =>
      bridge.gatewayMediaStreamUrl({ connectionId: 'stale-node', path: '/tmp/a.m4a', profile: 'voice' })
    ).toThrow(/unavailable/i)
  })

  it('mints a fresh same-origin WebSocket ticket with cookie credentials', async () => {
    const fetcher = vi.fn(async () => response({ ticket: 'fresh-ticket' }))
    const bridge = createBrowserBridge({
      fetcher,
      location: new URL('https://mobile.example.test/'),
      runtimeDescriptor
    })

    await expect(bridge.getGatewayWsUrlFor?.({ connectionId: 'strix-halo' })).resolves.toEqual({
      ok: true,
      wsUrl: 'wss://mobile.example.test/api/ws?ticket=fresh-ticket'
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://mobile.example.test/api/auth/ws-ticket',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    )
  })

  it('flags a 401 ws-ticket response as needing an oauth login', async () => {
    const fetcher = vi.fn(async () => new Response('session expired', { status: 401 }))
    const bridge = createBrowserBridge({
      fetcher,
      location: new URL('https://mobile.example.test/'),
      runtimeDescriptor
    })

    await expect(bridge.getGatewayWsUrl?.()).resolves.toMatchObject({ ok: false, needsOauthLogin: true })
  })

  it('clears the stale browser session and opens same-tab sign in', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302 }))
    const navigate = vi.fn()
    const bridge = createBrowserBridge({
      fetcher,
      location: new URL('https://mobile.example.test/app/'),
      navigate,
      runtimeDescriptor
    })

    await bridge.oauthLogoutConnectionConfig?.('https://mobile.example.test')
    const result = await bridge.oauthLoginConnectionConfig?.('https://mobile.example.test')

    expect(fetcher).toHaveBeenCalledWith(
      'https://mobile.example.test/auth/logout',
      expect.objectContaining({ credentials: 'include', method: 'POST', redirect: 'manual' })
    )
    expect(navigate).toHaveBeenCalledWith('https://mobile.example.test/login?next=%2F')
    expect(result).toEqual({ ok: true, baseUrl: 'https://mobile.example.test', connected: false })
  })

  it('provides browser startup and mobile file capabilities', () => {
    const bridge = createBrowserBridge({
      location: new URL('https://mobile.example.test/'),
      runtimeDescriptor
    })

    expect(bridge.onPreviewFileChanged).toBeTypeOf('function')
    expect(bridge.onBackendExit).toBeTypeOf('function')
    expect(bridge.getConnectionConfig).toBeTypeOf('function')
    expect(bridge.selectPaths).toBeTypeOf('function')
    expect(bridge.saveGatewayFile).toBeTypeOf('function')
    expect(bridge.requestMicrophoneAccess).toBeTypeOf('function')
  })
})
