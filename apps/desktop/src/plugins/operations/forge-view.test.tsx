import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeBoard, ForgeTask } from './forge-types'

// A hoisted, mutable holder the hoisted `vi.mock` factories can reach. `phase`
// drives the mocked `useQuery` result: 'loading' (no data yet), 'data' (a
// board), or 'error' (a failed load).
const state = vi.hoisted(() => ({
  board: null as ForgeBoard | null,
  phase: 'loading' as 'loading' | 'data' | 'error',
  error: null as Error | null
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    useQuery: () => {
      if (state.phase === 'loading') {
        return { data: undefined, isLoading: true, error: null }
      }

      if (state.phase === 'error') {
        return { data: undefined, isLoading: false, error: state.error }
      }

      return { data: state.board, isLoading: false, error: null }
    }
  }
})

vi.mock('./forge-data', () => ({
  FORGE_BOARD_SLUG: 'hermes-forge',
  fetchForgeBoard: vi.fn(async () => {
    if (state.phase === 'error') {
      throw state.error ?? new Error('Forge board unavailable')
    }

    return state.board
  })
}))

import { ForgeView } from './forge-view'

afterEach(cleanup)

const boardWith = (columns: ForgeBoard['columns']): ForgeBoard => ({
  columns,
  assignees: [],
  tenants: []
})

const task = (
  overrides: { assignee?: null | string; body?: null | string; id?: string; priority?: number; status?: string; title?: string } = {}
): ForgeTask => ({
  assignee: null,
  body: null,
  id: 't_000000',
  status: 'triage',
  title: 'Untitled',
  ...overrides
})

describe('ForgeView', () => {
  beforeEach(() => {
    state.phase = 'data'
    state.board = boardWith([
      { name: 'triage', tasks: [] },
      {
        name: 'ready',
        tasks: [task({ id: 't_abc123', title: 'Triage this', assignee: 'builder', priority: 2, body: 'A summary' })]
      },
      { name: 'running', tasks: [task({ id: 't_def456', title: 'Working now', assignee: 'release', body: '' })] },
      { name: 'review', tasks: [] },
      { name: 'done', tasks: [] }
    ])
  })

  it('renders Forge columns and cards with title, status, assignee, and summary', () => {
    render(<ForgeView />)

    expect(screen.getByText('Forge')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Triage this')).toBeTruthy()
    expect(screen.getByText('Working now')).toBeTruthy()
    expect(screen.getByText('A summary')).toBeTruthy()
    expect(screen.getByText('builder')).toBeTruthy()
    expect(screen.getByText('release')).toBeTruthy()
  })

  it('orders columns in the canonical Forge lane order', () => {
    render(<ForgeView />)

    const headings = ['Triage', 'Todo', 'Ready', 'Running', 'Blocked', 'Review', 'Done']
    const indices = headings
      .map(label => screen.queryByText(label))
      .map((node, index) => (node ? index : -1))
      .filter(index => index !== -1)

    const first = indices[0]
    const last = indices[indices.length - 1]

    expect(first).toBeLessThan(last)
  })

  it('renders an empty state per empty column', () => {
    state.board = boardWith([{ name: 'triage', tasks: [] }])
    render(<ForgeView />)

    expect(screen.getByText('Empty')).toBeTruthy()
  })

  it('shows a visible error when the board fails to load', async () => {
    state.phase = 'error'
    state.error = new Error('Forge board unavailable')

    render(<ForgeView />)

    expect(await screen.findByText('Forge board could not load')).toBeTruthy()
    expect(await screen.findByText('Forge board unavailable')).toBeTruthy()
  })
})
