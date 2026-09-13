import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeBoard, ForgeTask } from './forge-types'

// A hoisted, mutable holder the hoisted `vi.mock` factories can reach. `phase`
// drives the mocked `useQuery` result: 'loading' (no data yet), 'data' (a
// board), or 'error' (a failed load). `kanbanStatus` drives the mocked plugin
// inventory atom: 'loaded' (kanban enabled) or 'disabled'.
const state = vi.hoisted(() => ({
  board: null as ForgeBoard | null,
  kanbanStatus: 'loaded' as 'disabled' | 'loaded',
  phase: 'loading' as 'loading' | 'data' | 'error',
  error: null as Error | null
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const actualHost = actual.host as Record<string, unknown>

  return {
    ...actual,
    host: {
      ...actualHost,
      state: {
        ...(actualHost.state as Record<string, unknown>),
        // Static-shape atom mirroring the real plugin inventory; the tests set
        // state.kanbanStatus before render.
        plugins: {
          get: () => ({ kanban: { id: 'kanban', kind: 'bundled', name: 'Kanban', status: state.kanbanStatus } }),
          listen: vi.fn(),
          subscribe: vi.fn()
        }
      }
    },
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

// Mock the network fetch but keep the REAL `isForgeUnavailable` matcher so the
// disabled-state assertions exercise the genuine 404 classification.
vi.mock('./forge-data', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    fetchForgeBoard: vi.fn(async () => {
      if (state.phase === 'error') {
        throw state.error ?? new Error('Forge board unavailable')
      }

      return state.board
    })
  }
})

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
    state.error = null
    state.kanbanStatus = 'loaded'
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

  it('shows a loading indicator before the board resolves', () => {
    state.phase = 'loading'

    render(<ForgeView />)

    expect(screen.getByRole('status', { name: 'Loading Forge' })).toBeTruthy()
    expect(screen.queryByText('Forge board could not load')).toBeNull()
    expect(screen.queryByText('Triage this')).toBeNull()
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

  it('tells the user to enable Kanban when the kanban plugin is disabled', () => {
    state.kanbanStatus = 'disabled'

    render(<ForgeView />)

    expect(screen.getByText('Enable Kanban to use Forge')).toBeTruthy()
    expect(screen.getByText(/Forge only works when the Kanban plugin is enabled/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'How to enable Kanban' })).toBeTruthy()
    // The board never renders while the plugin is off.
    expect(screen.queryByText('Triage this')).toBeNull()
  })

  it('also reads a backend 404 verdict as the enable-Kanban state', async () => {
    // Defence in depth: desktop says loaded but the backend router is unmounted
    // (kanban disabled in the backend config) — same capability state.
    state.phase = 'error'
    state.error = new Error('404: {"detail":"No such API endpoint: /api/plugins/kanban/board"}')

    render(<ForgeView />)

    expect(await screen.findByText('Enable Kanban to use Forge')).toBeTruthy()
    expect(screen.queryByText('Forge board could not load')).toBeNull()
  })

  it('opens the enable-Kanban instructions overlay from the link', async () => {
    state.kanbanStatus = 'disabled'

    render(<ForgeView />)

    fireEvent.click(screen.getByRole('button', { name: 'How to enable Kanban' }))

    const dialog = await screen.findByRole('dialog')

    expect(dialog).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'How to enable Kanban' })).toBeTruthy()
    expect(screen.getByText('Find the Kanban plugin in the list.')).toBeTruthy()
    expect(screen.getByText('Flip its switch on.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open Settings/ })).toBeTruthy()
  })
})
