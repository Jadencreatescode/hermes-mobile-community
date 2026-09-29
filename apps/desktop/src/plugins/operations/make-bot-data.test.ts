import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createBot,
  fetchMakeBotCatalog,
  fetchMakeBotCatalogForConnection,
  installCommandForHarness,
  loadMakeBotState,
  suggestedInstallCommands
} from './make-bot-data'

vi.mock('@/api/client', () => ({
  hermesApi: vi.fn()
}))

// eslint-disable-next-line no-restricted-imports
import { hermesApi } from '@/api/client'

function mockRegistry(connections: { id: string; kind: 'local' | 'remote' | 'ssh' | 'cloud'; label: string }[]) {
  const bridge = {
    connections: {
      list: vi.fn().mockResolvedValue({
        version: 2,
        primary: connections[0]?.id ?? 'local',
        launchMode: 'primary',
        lastUsed: connections[0]?.id ?? 'local',
        connections
      })
    }
  }

  vi.stubGlobal('window', { hermesDesktop: bridge })
}

function clearRegistryMock() {
  vi.unstubAllGlobals()
}

describe('fetchMakeBotCatalog', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns harnesses and models from the backend', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 'hermes', label: 'Hermes', detected: true, source: 'native' }
      ],
      models: [
        { id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' }
      ]
    })

    const catalog = await fetchMakeBotCatalog()

    expect(hermesApi).toHaveBeenCalledWith({ path: '/api/bots/catalog' })
    expect(catalog.harnesses).toHaveLength(1)
    expect(catalog.harnesses[0]).toEqual({
      id: 'hermes',
      label: 'Hermes',
      detected: true,
      selectable: false,
      source: 'native'
    })
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0]).toEqual({
      id: 'claude-sonnet-4',
      label: 'claude-sonnet-4',
      provider: 'anthropic'
    })
  })

  it('returns empty arrays when the backend returns nothing', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({})

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.harnesses).toEqual([])
    expect(catalog.models).toEqual([])
  })

  it('returns empty arrays when fields are malformed', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 123, label: null, detected: 'yes', source: 456 },
        { label: 'missing id' }
      ],
      models: [
        { id: null, label: 123, provider: true },
        { label: 'missing id' }
      ]
    })

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.harnesses).toEqual([])
    expect(catalog.models).toEqual([])
  })

  it('reads selectable and downloadUrl from the backend', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native', download_url: 'https://github.com/NousResearch/Hermes-Agent#readme' },
        { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', download_url: 'https://www.npmjs.com/package/@openai/codex' }
      ],
      models: []
    })

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.harnesses).toHaveLength(2)
    expect(catalog.harnesses[0]).toEqual({
      id: 'hermes',
      label: 'Hermes',
      detected: true,
      selectable: true,
      source: 'native',
      downloadUrl: 'https://github.com/NousResearch/Hermes-Agent#readme'
    })
    expect(catalog.harnesses[1]).toEqual({
      id: 'codex',
      label: 'Codex',
      detected: false,
      selectable: false,
      source: 'none',
      downloadUrl: 'https://www.npmjs.com/package/@openai/codex'
    })
  })

  it('treats missing selectable as false and missing download_url as undefined', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 'generic_a2a', label: 'Generic A2A', detected: false, source: 'none' }
      ],
      models: []
    })

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.harnesses[0].selectable).toBe(false)
    expect(catalog.harnesses[0].downloadUrl).toBeUndefined()
  })

  it('filters out harness entries with missing ids', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 'hermes', label: 'Hermes', detected: true, source: 'native' },
        { label: 'No ID' }
      ],
      models: []
    })

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.harnesses).toHaveLength(1)
    expect(catalog.harnesses[0].id).toBe('hermes')
  })

  it('filters out model entries with missing ids', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [],
      models: [
        { id: 'gpt-4', label: 'GPT-4', provider: 'openai' },
        { provider: 'no-id' }
      ]
    })

    const catalog = await fetchMakeBotCatalog()

    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0].id).toBe('gpt-4')
  })

  it('throws when the backend call fails', async () => {
    vi.mocked(hermesApi).mockRejectedValueOnce(new Error('offline'))

    await expect(fetchMakeBotCatalog()).rejects.toThrow('offline')
  })
})

describe('fetchMakeBotCatalogForConnection', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('routes the catalog request through the given connection', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }],
      models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
    })

    const catalog = await fetchMakeBotCatalogForConnection('homelab')

    expect(hermesApi).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/bots/catalog',
      connectionId: 'homelab'
    }))
    expect(catalog.harnesses).toHaveLength(1)
  })

  it('passes a custom timeout to the request', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({ harnesses: [], models: [] })

    await fetchMakeBotCatalogForConnection('homelab', 5000)

    expect(hermesApi).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/bots/catalog',
      connectionId: 'homelab',
      timeoutMs: 5000
    }))
  })

  it('uses null connectionId for local', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({ harnesses: [], models: [] })

    await fetchMakeBotCatalogForConnection('local')

    expect(hermesApi).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/bots/catalog',
      connectionId: 'local'
    }))
  })
})

describe('loadMakeBotState', () => {
  afterEach(() => {
    vi.clearAllMocks()
    clearRegistryMock()
  })

  it('returns local machine first when it is the only connection', async () => {
    mockRegistry([{ id: 'local', kind: 'local', label: 'This device' }])
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
      models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
    })

    const state = await loadMakeBotState()

    expect(state.machines).toHaveLength(1)
    expect(state.machines[0].machine).toEqual({
      id: 'local',
      label: 'This device',
      kind: 'local',
      state: 'online'
    })
    expect(state.machines[0].harnesses).toHaveLength(1)
    expect(state.machines[0].models).toHaveLength(1)
    expect(state.degraded).toBe(false)
  })

  it('groups harnesses by machine', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab' }
    ])
    vi.mocked(hermesApi)
      .mockResolvedValueOnce({
        harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
        models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
      })
      .mockResolvedValueOnce({
        harnesses: [
          { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' },
          { id: 'codex', label: 'Codex', detected: true, selectable: true, source: 'native' }
        ],
        models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
      })

    const state = await loadMakeBotState()

    expect(state.machines).toHaveLength(2)
    expect(state.machines[0].machine.id).toBe('local')
    expect(state.machines[0].harnesses).toHaveLength(1)
    expect(state.machines[1].machine.id).toBe('homelab')
    expect(state.machines[1].harnesses).toHaveLength(2)
    expect(state.degraded).toBe(false)
  })

  it('marks a machine offline when the request times out', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab' }
    ])
    vi.mocked(hermesApi)
      .mockResolvedValueOnce({
        harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
        models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
      })
      .mockRejectedValueOnce(new Error('timeout'))

    const state = await loadMakeBotState()

    expect(state.machines[1].machine.state).toBe('unreachable')
    expect(state.machines[1].harnesses).toEqual([])
    expect(state.machines[1].models).toEqual([])
    expect(state.degraded).toBe(false)
  })

  it('marks a machine offline when the response is malformed', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab' }
    ])
    vi.mocked(hermesApi)
      .mockResolvedValueOnce({ harnesses: [], models: [] })
      .mockResolvedValueOnce({
        harnesses: 'not-an-array',
        models: { also: 'not-an-array' }
      })

    const state = await loadMakeBotState()

    expect(state.machines[1].machine.state).toBe('online')
    expect(state.machines[1].harnesses).toEqual([])
    expect(state.machines[1].models).toEqual([])
  })

  it('degrades to no_machine when every machine is unreachable', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab' }
    ])
    vi.mocked(hermesApi).mockRejectedValue(new Error('offline'))

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_machine')
    expect(state.machines[0].machine.state).toBe('unreachable')
    expect(state.machines[1].machine.state).toBe('unreachable')
  })

  it('degrades to no_harness when the only online machine has no harnesses', async () => {
    mockRegistry([{ id: 'local', kind: 'local', label: 'This device' }])
    vi.mocked(hermesApi).mockResolvedValueOnce({ harnesses: [], models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }] })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_harness')
  })

  it('degrades to no_model when the only online machine has no models', async () => {
    mockRegistry([{ id: 'local', kind: 'local', label: 'This device' }])
    vi.mocked(hermesApi).mockResolvedValueOnce({ harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }], models: [] })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_model')
  })

  it('does not degrade when at least one machine is online with harnesses and models', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'homelab', kind: 'remote', label: 'Homelab' }
    ])
    vi.mocked(hermesApi)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
        models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
      })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(false)
    expect(state.machines[0].machine.state).toBe('unreachable')
    expect(state.machines[1].machine.state).toBe('online')
  })

  it('places local first even when the registry lists it last', async () => {
    mockRegistry([
      { id: 'homelab', kind: 'remote', label: 'Homelab' },
      { id: 'local', kind: 'local', label: 'This device' }
    ])
    vi.mocked(hermesApi)
      .mockResolvedValueOnce({ harnesses: [], models: [] })
      .mockResolvedValueOnce({ harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }], models: [] })

    const state = await loadMakeBotState()

    expect(state.machines[0].machine.id).toBe('local')
    expect(state.machines[1].machine.id).toBe('homelab')
  })

  it('returns no_machine when the bridge is not available', async () => {
    vi.stubGlobal('window', { hermesDesktop: undefined })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_machine')
    expect(state.machines).toEqual([])
  })

  it('uses bounded per-machine timeout and overall budget', async () => {
    mockRegistry([
      { id: 'local', kind: 'local', label: 'This device' },
      { id: 'slow', kind: 'remote', label: 'Slow box' }
    ])
    vi.mocked(hermesApi)
      .mockResolvedValueOnce({ harnesses: [], models: [] })
      .mockImplementationOnce(async request => {
        expect(request).toMatchObject(expect.objectContaining({ timeoutMs: expect.any(Number) }))
        throw new Error('timeout')
      })

    const state = await loadMakeBotState()

    expect(state.machines[0].machine.state).toBe('online')
    expect(state.machines[1].machine.state).toBe('unreachable')
  })
})

describe('createBot', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('posts to /api/bots with the request body', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      name: 'testbot',
      path: '/home/user/.hermes/profiles/testbot',
      harness: 'hermes',
      model: 'claude-sonnet-4'
    })

    const result = await createBot({
      name: 'testbot',
      description: 'A test bot',
      harness: 'hermes',
      model: 'claude-sonnet-4'
    })

    expect(hermesApi).toHaveBeenCalledWith({
      path: '/api/bots',
      method: 'POST',
      body: {
        name: 'testbot',
        description: 'A test bot',
        harness: 'hermes',
        model: 'claude-sonnet-4'
      }
    })
    expect(result).toEqual({
      name: 'testbot',
      path: '/home/user/.hermes/profiles/testbot',
      harness: 'hermes',
      model: 'claude-sonnet-4'
    })
  })

  it('allows empty harness and model', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      name: 'emptybot',
      path: '/home/user/.hermes/profiles/emptybot',
      harness: '',
      model: ''
    })

    const result = await createBot({ name: 'emptybot' })

    expect(hermesApi).toHaveBeenCalledWith({
      path: '/api/bots',
      method: 'POST',
      body: {
        name: 'emptybot',
        description: '',
        harness: '',
        model: ''
      }
    })
    expect(result.harness).toBe('')
    expect(result.model).toBe('')
  })

  it('normalizes missing response fields to empty strings', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      name: 'partial'
    })

    const result = await createBot({ name: 'partial' })

    expect(result.name).toBe('partial')
    expect(result.path).toBe('')
    expect(result.harness).toBe('')
    expect(result.model).toBe('')
  })

  it('re-throws backend errors so the caller can surface them', async () => {
    vi.mocked(hermesApi).mockRejectedValueOnce(new Error('name taken'))

    await expect(createBot({ name: 'taken' })).rejects.toThrow('name taken')
  })

  it('routes the create request through the selected connection', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      name: 'remotebot',
      path: '/home/user/.hermes/profiles/remotebot',
      harness: 'hermes',
      model: 'gpt-4'
    })

    await createBot({
      name: 'remotebot',
      harness: 'hermes',
      model: 'gpt-4',
      connectionId: 'homelab'
    })

    expect(hermesApi).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/bots',
      method: 'POST',
      connectionId: 'homelab'
    }))
  })
})

describe('installCommandForHarness', () => {
  it('returns the install command for a known harness', () => {
    expect(installCommandForHarness('claude_code')).toBe('npm install -g @anthropic-ai/claude-code')
    expect(installCommandForHarness('codex')).toBe('npm install -g @openai/codex')
  })

  it('returns null for an unknown harness', () => {
    expect(installCommandForHarness('unknown_harness')).toBeNull()
  })
})

describe('suggestedInstallCommands', () => {
  it('returns commands for harnesses that are not detected', () => {
    const harnesses = [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }]
    const commands = suggestedInstallCommands(harnesses)

    expect(commands.length).toBeGreaterThan(0)
    expect(commands).toContain('npm install -g @anthropic-ai/claude-code')
    expect(commands).toContain('npm install -g opencode-ai')
  })

  it('returns an empty array when all well-known harnesses are present', () => {
    const harnesses = Object.keys({
      claude_code: '',
      codex: '',
      cursor: '',
      github_copilot: '',
      opencode: '',
      pi: ''
    }).map(id => ({ id, label: id, detected: true, selectable: true, source: 'native' }))

    expect(suggestedInstallCommands(harnesses)).toEqual([])
  })
})
