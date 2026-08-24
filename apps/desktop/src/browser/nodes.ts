export interface BrowserHermesNode {
  id: string
  label: string
  profiles: string[]
}

export interface BrowserRuntimeDescriptor {
  version: 1
  backend: {
    id: string
    label: string
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const RUNTIME_DESCRIPTOR_PATH = '/.well-known/hermes-mobile-runtime.json'
const BACKEND_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()

  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function parseBrowserRuntimeDescriptor(value: unknown): BrowserRuntimeDescriptor {
  const invalid = (): never => {
    throw new Error('Invalid Hermes mobile runtime descriptor')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {return invalid()}
  const descriptor = value as Record<string, unknown>

  if (!exactKeys(descriptor, ['backend', 'version']) || descriptor.version !== 1) {return invalid()}
  if (!descriptor.backend || typeof descriptor.backend !== 'object' || Array.isArray(descriptor.backend)) {
    return invalid()
  }

  const backend = descriptor.backend as Record<string, unknown>
  if (!exactKeys(backend, ['id', 'label'])) {return invalid()}
  if (typeof backend.id !== 'string' || !BACKEND_ID.test(backend.id)) {return invalid()}
  if (typeof backend.label !== 'string' || backend.label.trim() !== backend.label || backend.label.length < 1 || backend.label.length > 80) {
    return invalid()
  }

  return { version: 1, backend: { id: backend.id, label: backend.label } }
}

export async function loadBrowserRuntimeDescriptor(
  fetcher: Fetcher,
  location: URL
): Promise<BrowserRuntimeDescriptor> {
  const url = new URL(RUNTIME_DESCRIPTOR_PATH, location.origin)
  let response: Response

  try {
    response = await fetcher(url.toString(), {
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
      redirect: 'error'
    })
  } catch (error) {
    throw new Error(`Unable to load Hermes mobile runtime descriptor: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    throw new Error(`Unable to load Hermes mobile runtime descriptor (HTTP ${response.status})`)
  }

  const payload = await response.json().catch(() => null)
  return parseBrowserRuntimeDescriptor(payload)
}

function configuredNode(descriptor: BrowserRuntimeDescriptor): BrowserHermesNode {
  return { ...descriptor.backend, profiles: [] }
}

export function resolveBrowserNode(
  descriptor: BrowserRuntimeDescriptor,
  id?: null | string
): BrowserHermesNode {
  if (id !== descriptor.backend.id) {
    throw new Error('That Hermes backend is unavailable')
  }

  return configuredNode(descriptor)
}

export function selectableBrowserNodes(descriptor: BrowserRuntimeDescriptor): readonly BrowserHermesNode[] {
  return [configuredNode(descriptor)]
}

export function nodeBaseUrl(
  location: URL,
  descriptor: BrowserRuntimeDescriptor,
  id?: null | string
): string {
  resolveBrowserNode(descriptor, id)
  return location.origin
}

export function nodeRequestUrl(
  location: URL,
  descriptor: BrowserRuntimeDescriptor,
  id: null | string | undefined,
  path: string
): string {
  return `${nodeBaseUrl(location, descriptor, id)}${path.startsWith('/') ? path : `/${path}`}`
}
