import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchForgeBoard, FORGE_BOARD_SLUG, isForgeUnavailable } from './forge-data'

afterEach(cleanup)

const mockReadKanbanBoard = vi.hoisted(() => vi.fn())

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const actualHost = actual.host as Record<string, unknown>

  return {
    ...actual,
    host: {
      ...actualHost,
      readKanbanBoard: mockReadKanbanBoard
    }
  }
})

describe('forge-data', () => {
  it('calls the kanban plugin’s own REST door pinned to the hermes-forge board', async () => {
    mockReadKanbanBoard.mockResolvedValue({ columns: [], assignees: [], tenants: [] })

    await fetchForgeBoard()

    expect(mockReadKanbanBoard).toHaveBeenCalledExactlyOnceWith(FORGE_BOARD_SLUG)
  })

  it('exposes the canonical board slug', () => {
    expect(FORGE_BOARD_SLUG).toBe('hermes-forge')
  })
})

describe('isForgeUnavailable', () => {
  it('matches the backend’s disabled-plugin 404 verdict', () => {
    expect(isForgeUnavailable(new Error('404: {"detail":"No such API endpoint: /api/plugins/kanban/board"}'))).toBe(true)
    expect(isForgeUnavailable(new Error("Error invoking remote method 'hermes:api': Error: 404: No such API endpoint"))).toBe(true)
    expect(isForgeUnavailable('no such api endpoint')).toBe(true)
  })

  it('does not match transient failures or a missing Forge board', () => {
    expect(isForgeUnavailable(new Error("404: board 'hermes-forge' does not exist"))).toBe(false)
    expect(isForgeUnavailable(new Error('500: Internal Server Error'))).toBe(false)
    expect(isForgeUnavailable(new Error('request timed out'))).toBe(false)
    expect(isForgeUnavailable(new Error('ECONNREFUSED'))).toBe(false)
    expect(isForgeUnavailable(new Error('task t_abc123 not found'))).toBe(false)
  })
})
