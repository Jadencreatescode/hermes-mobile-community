// Bots endpoints (/api/bots/*) are mounted on the main app, not under the
// operations plugin namespace, so they are reachable only through the general
// REST client.
// eslint-disable-next-line no-restricted-imports
import { hermesApi } from '@/api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface MakeBotMachine {
  id: string
  label: string
  reachable: boolean
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
  harnesses: MakeBotHarness[]
  machine?: MakeBotMachine
  models: MakeBotModel[]
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

// ---------------------------------------------------------------------------
// State load
// ---------------------------------------------------------------------------

export async function loadMakeBotState(): Promise<MakeBotState> {
  let catalog: MakeBotCatalog

  try {
    catalog = await fetchMakeBotCatalog()
  } catch {
    return {
      degraded: true,
      degradedReason: 'no_machine',
      harnesses: [],
      models: []
    }
  }

  const degraded = catalog.harnesses.length === 0 || catalog.models.length === 0
  let degradedReason: MakeBotDegradedReason | undefined

  if (catalog.harnesses.length === 0) {
    degradedReason = 'no_harness'
  } else if (catalog.models.length === 0) {
    degradedReason = 'no_model'
  }

  return {
    degraded,
    degradedReason,
    harnesses: catalog.harnesses,
    machine: {
      id: 'local',
      label: 'This machine',
      reachable: true
    },
    models: catalog.models
  }
}
