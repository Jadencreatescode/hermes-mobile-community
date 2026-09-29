// Bots endpoints (/api/bots/*) are mounted on the main app, not under the
// operations plugin namespace, so they are reachable only through the general
// REST client.
// eslint-disable-next-line no-restricted-imports
import { hermesApi } from '@/api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DesktopConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'

export interface MakeBotHarness {
  id: string
  label: string
  detected: boolean
  selectable: boolean
  source: string
  downloadUrl?: string | null
}

export interface MakeBotModel {
  id: string
  label: string
  provider: string
}

export type MachineState = 'online' | 'offline' | 'unreachable'

export interface MakeBotMachine {
  id: string
  label: string
  kind: DesktopConnectionKind
  state: MachineState
}

export interface MachineCatalog {
  machine: MakeBotMachine
  harnesses: MakeBotHarness[]
  models: MakeBotModel[]
}

export interface MakeBotCatalog {
  harnesses: MakeBotHarness[]
  models: MakeBotModel[]
}

export interface CreateBotRequest {
  name: string
  description?: string
  harness?: string
  model?: string
  connectionId?: string
}

export interface CreateBotResult {
  name: string
  path: string
  harness: string
  model: string
}

export type MakeBotDegradedReason = 'no_harness' | 'no_machine' | 'no_model'

export interface MakeBotState {
  degraded: boolean
  degradedReason?: MakeBotDegradedReason
  machines: MachineCatalog[]
}

// ---------------------------------------------------------------------------
// Install commands for well-known harnesses (public knowledge, not Owner
// private logic). Shown when a harness is missing so the user can install it
// and check again — the public rule is: never auto-install.
// ---------------------------------------------------------------------------

export const HARNESS_INSTALL_COMMANDS: Record<string, string> = {
  claude_code: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: 'Install Cursor from https://cursor.com',
  github_copilot: 'Install GitHub CLI and run: gh extension install github/copilot',
  opencode: 'npm install -g opencode-ai',
  pi: 'curl -fsSL https://pi.dev/install.sh | sh'
}

export function installCommandForHarness(harnessId: string): string | null {
  return HARNESS_INSTALL_COMMANDS[harnessId] ?? null
}

export function suggestedInstallCommands(harnesses: MakeBotHarness[]): string[] {
  const known = Object.keys(HARNESS_INSTALL_COMMANDS)
  const present = new Set(harnesses.map(h => h.id))

  return known
    .filter(id => !present.has(id))
    .map(id => HARNESS_INSTALL_COMMANDS[id])
    .filter((cmd): cmd is string => Boolean(cmd))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function normalizeHarness(entry: unknown): MakeBotHarness | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const row = entry as Record<string, unknown>

  const id = isString(row.id) ? row.id.trim() : ''

  if (!id) {
    return null
  }

  return {
    id,
    label: isString(row.label) ? row.label : id,
    detected: isBoolean(row.detected) ? row.detected : false,
    selectable: isBoolean(row.selectable) ? row.selectable : false,
    source: isString(row.source) ? row.source : 'unknown',
    downloadUrl: isString(row.download_url) ? row.download_url : undefined
  }
}

function normalizeModel(entry: unknown): MakeBotModel | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const row = entry as Record<string, unknown>

  const id = isString(row.id) ? row.id.trim() : ''

  if (!id) {
    return null
  }

  return {
    id,
    label: isString(row.label) ? row.label : id,
    provider: isString(row.provider) ? row.provider : 'unknown'
  }
}

function normalizeArray<T>(value: unknown, normalize: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map(normalize).filter((item): item is T => item !== null)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchMakeBotCatalog(): Promise<MakeBotCatalog> {
  const response = await hermesApi<{
    harnesses?: unknown
    models?: unknown
  }>({ path: '/api/bots/catalog' })

  return {
    harnesses: normalizeArray(response.harnesses, normalizeHarness),
    models: normalizeArray(response.models, normalizeModel)
  }
}

export async function fetchMakeBotCatalogForConnection(
  connectionId: string | null,
  timeoutMs?: number
): Promise<MakeBotCatalog> {
  const response = await hermesApi<{
    harnesses?: unknown
    models?: unknown
  }>({
    path: '/api/bots/catalog',
    connectionId: connectionId ?? undefined,
    timeoutMs
  })

  return {
    harnesses: normalizeArray(response.harnesses, normalizeHarness),
    models: normalizeArray(response.models, normalizeModel)
  }
}

// ---------------------------------------------------------------------------
// Single resolver for the machine roster policy
// ---------------------------------------------------------------------------

const PER_MACHINE_TIMEOUT_MS = 8_000
const OVERALL_BUDGET_MS = 25_000

interface RegistryLike {
  connections: Array<{
    id: string
    kind: DesktopConnectionKind
    label: string
  }>
}

export async function resolveMachineRoster(registry: RegistryLike): Promise<MachineCatalog[]> {
  const machines: MachineCatalog[] = []
  const startTime = Date.now()

  for (const connection of registry.connections) {
    const elapsed = Date.now() - startTime
    const remainingBudget = OVERALL_BUDGET_MS - elapsed

    if (remainingBudget <= 0) {
      for (const remaining of registry.connections.slice(machines.length)) {
        machines.push({
          machine: { id: remaining.id, label: remaining.label, kind: remaining.kind, state: 'offline' },
          harnesses: [],
          models: []
        })
      }
      break
    }

    const timeoutMs = Math.min(PER_MACHINE_TIMEOUT_MS, remainingBudget)

    try {
      const catalog = await fetchMakeBotCatalogForConnection(connection.id, timeoutMs)
      machines.push({
        machine: { id: connection.id, label: connection.label, kind: connection.kind, state: 'online' },
        harnesses: catalog.harnesses,
        models: catalog.models
      })
    } catch {
      machines.push({
        machine: { id: connection.id, label: connection.label, kind: connection.kind, state: 'unreachable' },
        harnesses: [],
        models: []
      })
    }
  }

  // Ensure local is always first
  const localIndex = machines.findIndex(m => m.machine.id === 'local')
  if (localIndex > 0) {
    const [local] = machines.splice(localIndex, 1)
    machines.unshift(local)
  }

  return machines
}

// ---------------------------------------------------------------------------
// State load
// ---------------------------------------------------------------------------

export async function loadMakeBotState(): Promise<MakeBotState> {
  let registry: RegistryLike | null = null

  try {
    const result = await window.hermesDesktop?.connections?.list()

    if (result && Array.isArray(result.connections)) {
      registry = result as RegistryLike
    }
  } catch {
    // registry unavailable — degrade below
  }

  if (!registry) {
    return {
      degraded: true,
      degradedReason: 'no_machine',
      machines: []
    }
  }

  const machines = await resolveMachineRoster(registry)
  const onlineMachines = machines.filter(m => m.machine.state === 'online')

  if (onlineMachines.length === 0) {
    return {
      degraded: true,
      degradedReason: 'no_machine',
      machines
    }
  }

  const anyHarness = onlineMachines.some(m => m.harnesses.length > 0)
  const anyModel = onlineMachines.some(m => m.models.length > 0)

  if (!anyHarness) {
    return {
      degraded: true,
      degradedReason: 'no_harness',
      machines
    }
  }

  if (!anyModel) {
    return {
      degraded: true,
      degradedReason: 'no_model',
      machines
    }
  }

  return { degraded: false, machines }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createBot(request: CreateBotRequest): Promise<CreateBotResult> {
  const response = await hermesApi<{
    harness?: unknown
    model?: unknown
    name?: unknown
    path?: unknown
  }>({
    body: {
      description: request.description ?? '',
      harness: request.harness ?? '',
      model: request.model ?? '',
      name: request.name
    },
    connectionId: request.connectionId,
    method: 'POST',
    path: '/api/bots'
  })

  return {
    harness: isString(response.harness) ? response.harness : '',
    model: isString(response.model) ? response.model : '',
    name: isString(response.name) ? response.name : request.name,
    path: isString(response.path) ? response.path : ''
  }
}
