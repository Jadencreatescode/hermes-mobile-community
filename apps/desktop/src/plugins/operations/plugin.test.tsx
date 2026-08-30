import { describe, expect, it, vi } from 'vitest'

import plugin from './plugin'

describe('public Operations plugin registration', () => {
  it('is bundled on by default with an iPhone route, sidebar entry, palette door, and scoped API', () => {
    const contributions: Array<{ area: string; data?: Record<string, unknown>; id: string }> = []
    const registerMany = vi.fn((items: typeof contributions) => contributions.push(...items))
    const registerLocales = vi.fn()
    const onDispose = vi.fn()
    const rest = vi.fn()

    plugin.register({
      i18n: { register: registerLocales, t: (key: string) => key },
      onDispose,
      registerMany,
      rest
    } as never)

    expect(plugin).toMatchObject({
      id: 'operations',
      name: 'Operations',
      defaultEnabled: true
    })
    expect(registerLocales).toHaveBeenCalledOnce()
    expect(onDispose).toHaveBeenCalledOnce()
    expect(contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: 'routes', data: { path: '/operations' }, id: 'page' }),
        expect.objectContaining({
          area: 'sidebar.nav',
          data: expect.objectContaining({ label: 'Operations', path: '/operations' }),
          id: 'nav'
        }),
        expect.objectContaining({
          area: 'palette',
          data: expect.objectContaining({ id: 'operations.open', label: 'Operations: Open control room' }),
          id: 'open'
        })
      ])
    )
  })
})
