import { profileColor } from '@hermes/plugin-sdk'

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

const STORAGE_KEY = 'hermes.desktop.control-room-icons'

export interface QuickSettings {
  effort: string
  fast: boolean
  iconColor: string
  iconShape: 'circle' | 'rounded' | 'square'
  model: string
  provider: string
}

function settingsKey(agentId: string): string {
  return `a2a.control_room.${agentId}`
}

function loadIconOverrides(): Record<string, { iconColor?: string; iconShape?: string }> {
  const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null

  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveIconOverride(
  agentId: string,
  patch: { iconColor?: string; iconShape?: string }
): void {
  const current = loadIconOverrides()
  const next = { ...current, [agentId]: { ...current[agentId], ...patch } }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function safeJsonParse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function loadQuickSettings(
  agentId: string,
  request: RequestGateway
): Promise<QuickSettings> {
  const result = await request<{ value?: string | null }>('config.get', { key: settingsKey(agentId) })
  const parsed = safeJsonParse(result?.value)
  const iconOverrides = loadIconOverrides()[agentId] ?? {}

  return {
    model: typeof parsed.model === 'string' ? parsed.model : '',
    provider: typeof parsed.provider === 'string' ? parsed.provider : '',
    effort: typeof parsed.effort === 'string' ? parsed.effort : 'medium',
    fast: typeof parsed.fast === 'boolean' ? parsed.fast : false,
    iconColor: iconOverrides.iconColor || profileColor(agentId) || '#6b7280',
    iconShape: ['circle', 'square', 'rounded'].includes(parsed.iconShape as string)
      ? (parsed.iconShape as 'circle' | 'rounded' | 'square')
      : (iconOverrides.iconShape as 'circle' | 'rounded' | 'square') ?? 'rounded'
  }
}

export async function saveQuickSettings(
  agentId: string,
  settings: QuickSettings,
  request: RequestGateway
): Promise<void> {
  const { iconColor, iconShape, ...configSettings } = settings

  saveIconOverride(agentId, { iconColor, iconShape })

  await request('config.set', {
    key: settingsKey(agentId),
    value: JSON.stringify(configSettings)
  })
}

export function clearQuickSettings(agentId: string): void {
  const current = loadIconOverrides()
  const { [agentId]: _removed, ...rest } = current

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
  }
}
