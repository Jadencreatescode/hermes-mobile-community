import { describe, expect, it, vi } from 'vitest'

import plugin from './plugin'

describe('Training Mode plugin registration', () => {
  it('ships enabled with an iPhone-safe route, sidebar entry, and command palette action', () => {
    const registerMany = vi.fn()
    const onDispose = vi.fn()
    const rest = vi.fn()
    plugin.register({ onDispose, registerMany, rest } as never)

    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(plugin).toMatchObject({
      id: 'training-mode',
      name: 'Training Mode',
      defaultEnabled: true
    })
    const contributions = registerMany.mock.calls[0][0]
    expect(contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: 'routes', data: expect.objectContaining({ path: '/training' }) }),
        expect.objectContaining({
          area: 'sidebar.nav',
          data: expect.objectContaining({ label: 'Training', path: '/training' })
        }),
        expect.objectContaining({
          area: 'palette',
          data: expect.objectContaining({ id: 'training-mode.open' })
        })
      ])
    )
  })
})
