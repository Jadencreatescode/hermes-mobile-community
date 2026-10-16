import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPluginRest = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pluginRest: mockPluginRest
}))

import * as sdk from './index'

describe('plugin SDK Kanban board capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes a narrow read-only Kanban board capability without exporting raw cross-plugin REST', async () => {
    mockPluginRest.mockResolvedValue({ columns: [] })

    await sdk.host.readKanbanBoard('hermes-forge')

    expect(mockPluginRest).toHaveBeenCalledExactlyOnceWith('kanban', '/board?board=hermes-forge')
    expect('pluginRest' in sdk).toBe(false)
  })

  it('rejects invalid board slugs before making a request', async () => {
    await expect(sdk.host.readKanbanBoard('../private')).rejects.toThrow(/invalid kanban board slug/i)
    expect(mockPluginRest).not.toHaveBeenCalled()
  })
})