import type { HermesApiRequest, HermesConnection } from '@/global'

import { createBrowserFileRegistry } from './files'
import {
  loadBrowserRuntimeDescriptor,
  nodeBaseUrl,
  nodeRequestUrl,
  parseBrowserRuntimeDescriptor,
  resolveBrowserNode,
  selectableBrowserNodes,
  type BrowserRuntimeDescriptor
} from './nodes'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface BrowserBridgeOptions {
  fetcher?: Fetcher
  location?: URL
  navigate?: (url: string) => void
  runtimeDescriptor?: BrowserRuntimeDescriptor
}

const PROFILE_KEY = 'hermes-mobile-profile'
const CONNECTION_KEY = 'hermes-mobile-connection-id'

function readProfile(): null | string {
  try {
    return localStorage.getItem(PROFILE_KEY) || null
  } catch {
    return null
  }
}

function writeProfile(profile: null | string): void {
  try {
    if (profile) {localStorage.setItem(PROFILE_KEY, profile)}
    else {localStorage.removeItem(PROFILE_KEY)}
  } catch {
    // Browser storage may be unavailable in private browsing.
  }
}

function readConnectionId(runtimeDescriptor: BrowserRuntimeDescriptor): string {
  try {
    return selectableBrowserNodes(runtimeDescriptor).find(node => node.id === localStorage.getItem(CONNECTION_KEY))?.id
      ?? runtimeDescriptor.backend.id
  } catch {
    return runtimeDescriptor.backend.id
  }
}

function writeConnectionId(runtimeDescriptor: BrowserRuntimeDescriptor, connectionId: string): void {
  const node = selectableBrowserNodes(runtimeDescriptor).find(candidate => candidate.id === connectionId)

  if (!node) {
    throw new Error('That Hermes node is unavailable for interactive control')
  }

  try {
    localStorage.setItem(CONNECTION_KEY, node.id)
  } catch {
    // Browser storage may be unavailable in private browsing.
  }
}


async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `Hermes request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

export function createBrowserBridge(options: BrowserBridgeOptions = {}): Window['hermesDesktop'] {
  const location = options.location ?? new URL(window.location.href)
  const fetcher = options.fetcher ?? window.fetch.bind(window)
  const navigate = options.navigate ?? (url => window.location.assign(url))
  const origin = location.origin
  const files = createBrowserFileRegistry()
  const runtimeDescriptor = parseBrowserRuntimeDescriptor(options.runtimeDescriptor)

  const remoteAuthUrl = (remoteUrl: string, path: '/auth/logout' | '/login'): string => {
    const base = new URL(remoteUrl, origin)
    base.pathname = `${base.pathname.replace(/\/$/, '')}${path}`
    base.search = ''
    base.hash = ''

    return base.toString()
  }

  const downloadBlob = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const connection = (connectionId: null | string = readConnectionId(runtimeDescriptor), profile?: null | string): HermesConnection => {
    const node = resolveBrowserNode(runtimeDescriptor, connectionId)

    const baseUrl = nodeBaseUrl(location, runtimeDescriptor, node.id)
    const wsBase = new URL(baseUrl)
    wsBase.protocol = wsBase.protocol === 'https:' ? 'wss:' : 'ws:'

    return {
    authMode: 'oauth',
    baseUrl,
    connectionId: node.id,
    isFullscreen: false,
    logs: [],
    mode: 'remote',
    nativeOverlayWidth: 0,
    profile: profile ?? readProfile() ?? undefined,
    registryScoped: true,
    source: 'settings',
    token: '',
    windowButtonPosition: null,
    wsUrl: `${wsBase.origin}${wsBase.pathname.replace(/\/$/, '')}/api/ws`
    }
  }

  const api = async <T>(request: HermesApiRequest): Promise<T> => {
    const connectionId = request.connectionId ?? readConnectionId(runtimeDescriptor)
    resolveBrowserNode(runtimeDescriptor, connectionId)
    const method = request.method ?? 'GET'

    const url = new URL(nodeRequestUrl(location, runtimeDescriptor, connectionId, request.path))

    if (request.profile) {url.searchParams.set('profile', request.profile)}

    const hasBody = request.body !== undefined && method !== 'GET' && method !== 'HEAD'

    const response = await fetcher(url.toString(), {
      body: hasBody ? JSON.stringify(request.body) : undefined,
      credentials: 'include',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      method
    })

    return readJson<T>(response)
  }

  const getGatewayWsUrl = async (request?: { connectionId?: null | string }) => {
    const connectionId = request?.connectionId ?? readConnectionId(runtimeDescriptor)
    resolveBrowserNode(runtimeDescriptor, connectionId)

    const baseUrl = nodeBaseUrl(location, runtimeDescriptor, connectionId)

    try {
      const response = await fetcher(`${baseUrl}/api/auth/ws-ticket`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        method: 'POST'
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')

        return {
          error: detail || `Gateway returned HTTP ${response.status}`,
          needsOauthLogin: response.status === 401 || response.status === 403,
          ok: false as const
        }
      }

      const payload = await response.json().catch(() => null)

      if (!payload?.ticket) {return { error: 'Gateway returned no WebSocket ticket.', ok: false as const }}

      return {
        ok: true as const,
        wsUrl: `${baseUrl.replace(/^http/, 'ws')}/api/ws?ticket=${encodeURIComponent(payload.ticket)}`
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        needsOauthLogin: error instanceof Error && /401|unauthorized/i.test(error.message),
        ok: false as const
      }
    }
  }

  const noSubscription = () => () => undefined

  const bridge = {
    api,
    connections: {
      list: async () => ({
        connections: selectableBrowserNodes(runtimeDescriptor).map(node => ({
          authMode: 'oauth' as const,
          id: node.id,
          kind: 'remote' as const,
          label: node.label,
          tokenPreview: null,
          tokenSet: false,
          url: nodeBaseUrl(location, runtimeDescriptor, node.id)
        })),
        launchMode: 'last-used' as const,
        lastUsed: readConnectionId(runtimeDescriptor),
        primary: runtimeDescriptor.backend.id,
        secureTokenStorage: false,
        version: 2
      }),
      onChanged: noSubscription,
      remove: async () => { throw new Error('Mobile node registry is managed by the relay') },
      save: async () => { throw new Error('Mobile node registry is managed by the relay') },
      setLaunchMode: async () => { throw new Error('Mobile node registry is managed by the relay') },
      setLastUsed: async (id: string) => {
        writeConnectionId(runtimeDescriptor, id)

        return { ok: true, registry: await bridge.connections.list() }
      },
      setPrimary: async () => { throw new Error('Mobile node registry is managed by the relay') },
      test: async (id: string) => {
        const response = await fetcher(`${nodeBaseUrl(location, runtimeDescriptor, id)}/api/status`, { credentials: 'include' })

        return { ok: response.ok, reachable: response.ok }
      }
    },
    getAgentRoster: async () => {
      const sources = await Promise.all(
        selectableBrowserNodes(runtimeDescriptor).map(async node => {
          try {
            const response = await fetcher(`${nodeBaseUrl(location, runtimeDescriptor, node.id)}/api/status`, { credentials: 'include' })
            const status = response.ok ? await response.json() : null

            return {
              agents: response.ok
                ? ((Array.isArray(status?.profiles) ? status.profiles : node.profiles) as string[]).map(profile => ({
                    connectionId: node.id,
                    connectionKind: 'remote' as const,
                    connectionLabel: node.label,
                    handle: `@${profile}-${node.id}`,
                    profile
                  }))
                : [],
              source: {
                connectionId: node.id,
                installId: status?.install_id,
                kind: 'remote' as const,
                label: node.label,
                reachable: response.ok
              }
            }
          } catch (error) {
            return {
              agents: [],
              source: {
                connectionId: node.id,
                error: error instanceof Error ? error.message : String(error),
                kind: 'remote' as const,
                label: node.label,
                reachable: false
              }
            }
          }
        })
      )

      return { agents: sources.flatMap(item => item.agents), sources: sources.map(item => item.source) }
    },
    getBootProgress: async () => ({ message: 'Connecting to Hermes', phase: 'browser.ready', progress: 90 }),
    getConnection: async (profile?: null | string) => connection(readConnectionId(runtimeDescriptor), profile),
    getConnectionConfig: async () => ({
      envOverride: false,
      mode: 'remote',
      profile: null,
      remoteAuthMode: 'oauth',
      remoteOauthConnected: true,
      remoteTokenPreview: null,
      remoteTokenSet: false,
      remoteUrl: origin,
      safeStorageAvailable: false
    }),
    getConnectionFor: async (request?: { connectionId?: string; profile?: string }) =>
      connection(request?.connectionId, request?.profile),
    getGatewayWsUrl,
    getGatewayWsUrlFor: getGatewayWsUrl,
    gatewayMediaStreamUrl: (payload: {
      connectionId?: null | string
      path: string
      profile?: null | string
    }) => {
      const url = new URL(nodeRequestUrl(
        location,
        runtimeDescriptor,
        payload.connectionId ?? readConnectionId(runtimeDescriptor),
        '/api/files/stream'
      ))
      url.searchParams.set('path', payload.path)
      if (payload.profile) {url.searchParams.set('profile', payload.profile)}

      return url.toString()
    },
    getPathForFile: files.getPathForFile,
    getProfileRoutes: async () => [],
    getRecentLogs: async () => ({ lines: [] }),
    notify: async () => undefined,
    oauthLoginConnectionConfig: async (remoteUrl: string) => {
      const baseUrl = new URL(remoteUrl, origin).toString().replace(/\/$/, '')
      const login = new URL(remoteAuthUrl(baseUrl, '/login'))
      login.searchParams.set('next', '/')
      navigate(login.toString())

      return { ok: true, baseUrl, connected: false }
    },
    oauthLogoutConnectionConfig: async (remoteUrl = origin) => {
      try {
        await fetcher(remoteAuthUrl(remoteUrl, '/auth/logout'), {
          credentials: 'include',
          method: 'POST',
          redirect: 'manual'
        })

        return { ok: true, connected: false }
      } catch {
        // Continue to the explicit login page even if an expired session cannot
        // be revoked. A successful login replaces the stale browser cookies.
        return { ok: false, connected: false }
      }
    },
    onBackendExit: noSubscription,
    onBootProgress: noSubscription,
    onConnectionApplied: noSubscription,
    onPowerResume: noSubscription,
    onPreviewFileChanged: noSubscription,
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    openPreviewInBrowser: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    revealLogs: async () => false,
    profile: {
      get: async () => ({ profile: readProfile() }),
      set: async (profile: string) => {
        writeProfile(profile || null)

        return { ok: true, profile: profile || null }
      }
    },
    readClipboard: async () => navigator.clipboard?.readText?.() ?? '',
    readFileDataUrl: files.readDataUrl,
    readFileDataUrlForAttach: files.readDataUrl,
    readFileText: files.readText,
    releaseBrowserFile: files.release,
    revalidateConnection: async () => connection(),
    requestMicrophoneAccess: async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return false
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(track => track.stop())

        return true
      } catch {
        return false
      }
    },
    saveClipboardImage: files.saveClipboardImage,
    saveGatewayFile: async (payload: {
      connectionId?: null | string
      path: string
      profile?: null | string
      suggestedName?: string
    }) => {
      const url = new URL(nodeRequestUrl(
        location,
        runtimeDescriptor,
        payload.connectionId ?? readConnectionId(runtimeDescriptor),
        '/api/fs/download'
      ))
      url.searchParams.set('path', payload.path)

      if (payload.profile) {url.searchParams.set('profile', payload.profile)}
      const response = await fetcher(url, { credentials: 'include' })

      if (!response.ok) {
        throw new Error((await response.text().catch(() => '')) || `Download failed with HTTP ${response.status}`)
      }

      const name = payload.suggestedName || payload.path.split(/[\\/]/).pop() || 'download'
      downloadBlob(await response.blob(), name)

      return { path: name, saved: true }
    },
    saveImageBuffer: files.saveBuffer,
    saveImageFromUrl: async (url: string) => {
      const response = await fetcher(url, { credentials: 'include' })

      if (!response.ok) {return false}
      downloadBlob(await response.blob(), url.split('/').pop() || 'image')

      return true
    },
    selectPaths: files.selectPaths,
    setActiveWork: () => undefined,
    setDisableF12: () => undefined,
    setKeepAwake: () => undefined,
    setNativeTheme: () => undefined,
    setTitleBarTheme: () => undefined,
    setTranslucency: () => undefined,
    touchBackend: async () => undefined,
    writeClipboard: async (text: string) => {
      await navigator.clipboard?.writeText?.(text)

      return true
    }
  }

  return bridge as unknown as Window['hermesDesktop']
}

export async function installBrowserBridge(options: BrowserBridgeOptions = {}): Promise<Window['hermesDesktop']> {
  if (window.hermesDesktop) {
    return window.hermesDesktop
  }

  const location = options.location ?? new URL(window.location.href)
  const fetcher = options.fetcher ?? window.fetch.bind(window)
  const runtimeDescriptor = await loadBrowserRuntimeDescriptor(fetcher, location)
  const bridge = createBrowserBridge({ ...options, location, runtimeDescriptor })
  window.hermesDesktop = bridge
  document.documentElement.dataset.hermesBrowser = 'true'

  return bridge
}
