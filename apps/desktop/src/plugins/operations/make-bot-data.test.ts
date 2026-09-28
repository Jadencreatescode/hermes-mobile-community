import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBot, fetchMakeBotCatalog, installCommandForHarness, loadMakeBotState, suggestedInstallCommands } from './make-bot-data'

vi.mock('@/api/client', () => ({
  hermesApi: vi.fn()
}))

// eslint-disable-next-line no-restricted-imports
import { hermesApi } from '@/api/client'

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
})

describe('loadMakeBotState', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns machine, harnesses and models when everything is available', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }],
      models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
    })

    const state = await loadMakeBotState()

    expect(state.machine).toEqual({
      id: 'local',
      label: 'This machine',
      reachable: true
    })
    expect(state.harnesses).toHaveLength(1)
    expect(state.models).toHaveLength(1)
    expect(state.degraded).toBe(false)
    expect(state.degradedReason).toBeUndefined()
  })

  it('returns degraded state when no harness is available', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [],
      models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
    })

    const state = await loadMakeBotState()

    expect(state.machine).toEqual({
      id: 'local',
      label: 'This machine',
      reachable: true
    })
    expect(state.harnesses).toHaveLength(0)
    expect(state.models).toHaveLength(1)
    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_harness')
  })

  it('returns degraded state when no model is available', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }],
      models: []
    })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_model')
  })

  it('does not degrade when harnesses exist but none are selectable', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [
        { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', download_url: 'https://www.npmjs.com/package/@openai/codex' }
      ],
      models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
    })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(false)
    expect(state.degradedReason).toBeUndefined()
    expect(state.harnesses).toHaveLength(1)
    expect(state.harnesses[0].selectable).toBe(false)
  })

  it('returns no machine when the backend is unreachable', async () => {
    vi.mocked(hermesApi).mockRejectedValueOnce(new Error('offline'))

    const state = await loadMakeBotState()

    expect(state.machine).toBeUndefined()
    expect(state.harnesses).toEqual([])
    expect(state.models).toEqual([])
    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_machine')
  })

  it('prefers no_harness over no_model when both are missing', async () => {
    vi.mocked(hermesApi).mockResolvedValueOnce({
      harnesses: [],
      models: []
    })

    const state = await loadMakeBotState()

    expect(state.degraded).toBe(true)
    expect(state.degradedReason).toBe('no_harness')
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
