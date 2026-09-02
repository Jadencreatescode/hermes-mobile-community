import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FORGE_BOARD_SLUG, fetchForgeBoard } from './forge-data'

afterEach(cleanup)

const mockRest = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({
  operationsApi: () => mockRest
}))

describe('forge-data', () => {
  it('pins the REST call to the hermes-forge board', async () => {
    mockRest.mockResolvedValue({ columns: [], assignees: [], tenants: [] })

    await fetchForgeBoard()

    expect(mockRest).toHaveBeenCalledTimes(1)
    const [path] = mockRest.mock.calls[0]

    expect(path).toContain(`board=${encodeURIComponent(FORGE_BOARD_SLUG)}`)
    expect(path).toContain('/board')
  })

  it('exposes the canonical board slug', () => {
    expect(FORGE_BOARD_SLUG).toBe('hermes-forge')
  })
})
