import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearQuickSettings, loadQuickSettings, saveQuickSettings, type QuickSettings } from './control-room-actions'

const request = vi.fn()

afterEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('loadQuickSettings', () => {
  it('returns defaults when no config is stored', async () => {
    request.mockResolvedValue({ value: null })

    const settings = await loadQuickSettings('a2a:test', request)

    expect(settings.model).toBe('')
    expect(settings.provider).toBe('')
    expect(settings.effort).toBe('medium')
    expect(settings.fast).toBe(false)
    expect(settings.iconShape).toBe('rounded')
  })

  it('parses stored config values', async () => {
    request.mockResolvedValue({
      value: JSON.stringify({ model: 'gpt-4o', provider: 'openai', effort: 'high', fast: true, iconShape: 'circle' })
    })

    const settings = await loadQuickSettings('a2a:test', request)

    expect(settings).toMatchObject({
      model: 'gpt-4o',
      provider: 'openai',
      effort: 'high',
      fast: true,
      iconShape: 'circle'
    })
  })

  it('falls back to localStorage icon overrides when config omits them', async () => {
    window.localStorage.setItem(
      'hermes.desktop.control-room-icons',
      JSON.stringify({ 'a2a:test': { iconColor: '#ff0000', iconShape: 'square' } })
    )
    request.mockResolvedValue({ value: JSON.stringify({ model: 'x' }) })

    const settings = await loadQuickSettings('a2a:test', request)

    expect(settings.iconColor).toBe('#ff0000')
    expect(settings.iconShape).toBe('square')
  })
})

describe('saveQuickSettings', () => {
  it('writes config and persists icon overrides to localStorage', async () => {
    request.mockResolvedValue({})

    const settings: QuickSettings = {
      model: 'claude-sonnet',
      provider: 'anthropic',
      effort: 'medium',
      fast: false,
      iconColor: '#00ff00',
      iconShape: 'circle'
    }

    await saveQuickSettings('a2a:test', settings, request)

    expect(request).toHaveBeenCalledWith('config.set', {
      key: 'a2a.control_room.a2a:test',
      value: JSON.stringify({ model: 'claude-sonnet', provider: 'anthropic', effort: 'medium', fast: false })
    })

    const stored = JSON.parse(window.localStorage.getItem('hermes.desktop.control-room-icons') || '{}')

    expect(stored['a2a:test']).toEqual({ iconColor: '#00ff00', iconShape: 'circle' })
  })
})

describe('clearQuickSettings', () => {
  it('removes the agent from localStorage icon overrides', () => {
    window.localStorage.setItem(
      'hermes.desktop.control-room-icons',
      JSON.stringify({ 'a2a:keep': { iconColor: '#fff' }, 'a2a:drop': { iconColor: '#000' } })
    )

    clearQuickSettings('a2a:drop')

    const stored = JSON.parse(window.localStorage.getItem('hermes.desktop.control-room-icons') || '{}')

    expect(stored).toHaveProperty('a2a:keep')
    expect(stored).not.toHaveProperty('a2a:drop')
  })
})
