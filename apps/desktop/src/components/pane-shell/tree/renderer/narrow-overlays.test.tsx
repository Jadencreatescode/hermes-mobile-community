import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { registry } from '@/contrib/registry'
import { toggleFileBrowserOpen } from '@/store/layout'
import { stubResizeObserver } from '@/test/jsdom'

import { allPaneIds, group, split } from '../model'
import {
  $dismissedPanes,
  $hiddenTreePanes,
  $layoutTree,
  $narrowViewport,
  declareDefaultTree
} from '../store'

import { NarrowOverlays } from './narrow-overlays'

// Ground truth for "the Bots tab is still visible when the sessions sidebar
// collapses on a narrow window". A collapsible pane DOCKED into the sessions
// zone (SESSIONS | BOTS) must leave the grid with the zone, and the narrow
// edge overlay must mirror the zone's tab strip so the docked pane stays
// reachable — not just the zone's first pane.

beforeAll(() => {
  stubResizeObserver()
})

const disposers: (() => void)[] = []

const registerPane = (id: string, title: string, data: Record<string, unknown>, body: string) => {
  disposers.push(
    registry.register({
      area: 'panes',
      data,
      id,
      render: () => <div data-testid={`${id}-body`}>{body}</div>,
      title
    })
  )
}

beforeEach(() => {
  window.localStorage.clear()
  $dismissedPanes.set(new Set())
  $hiddenTreePanes.set(new Set())

  registerPane('sessions', 'sessions', { collapsible: true, placement: 'left', width: '237px' }, 'session rows')
  registerPane('bots', 'Bots', { collapsible: true, placement: 'left', width: '260px' }, 'bot roster')
  registerPane('workspace', 'workspace', { placement: 'main', uncloseable: true }, 'chat')

  declareDefaultTree(split('row', [group(['sessions', 'bots']), group(['workspace'])]))
  $narrowViewport.set(true)
})

afterEach(() => {
  cleanup()
  $narrowViewport.set(false)
  $layoutTree.set(null)
  disposers.splice(0).forEach(dispose => dispose())
})

const revealPane = (id: string) => {
  act(() => {
    window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode: 'open' } }))
  })
}

const overlayTab = (paneId: string) => document.querySelector<HTMLElement>(`[data-narrow-overlay-tab="${paneId}"]`)

describe('narrow overlay of a stacked zone', () => {
  it('mirrors the zone tab strip so every stacked collapsible stays reachable', () => {
    const { getByTestId, queryByTestId } = render(<NarrowOverlays />)

    revealPane('sessions')

    // Both zone-mates surface as tabs; the revealed pane's body is on screen.
    expect(overlayTab('sessions')).toBeTruthy()
    expect(overlayTab('bots')).toBeTruthy()
    expect(getByTestId('sessions-body')).toBeTruthy()
    expect(queryByTestId('bots-body')).toBeNull()

    // Clicking the BOTS tab swaps the overlay to the docked pane.
    fireEvent.pointerDown(overlayTab('bots')!, { button: 0 })
    expect(getByTestId('bots-body')).toBeTruthy()
    expect(queryByTestId('sessions-body')).toBeNull()
  })

  it('keeps the stripless form for a zone with a single collapsible', () => {
    // Direct set: declareDefaultTree only ADOPTS into an existing tree — it
    // would keep the beforeEach zone (with bots) instead of replacing it.
    $layoutTree.set(split('row', [group(['sessions']), group(['workspace'])]))

    const { getByTestId } = render(<NarrowOverlays />)

    revealPane('sessions')

    expect(getByTestId('sessions-body')).toBeTruthy()
    expect(overlayTab('sessions')).toBeNull()
  })

  it('reveals an absent-from-tree collapsible as a narrow overlay without adopting it back', () => {
    const originalMatchMedia = window.matchMedia

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }))
    })

    try {
      registerPane(
        'files',
        'files',
        {
          collapsible: true,
          dock: { pane: 'workspace', pos: 'right' },
          placement: 'right',
          revealAliases: ['file-browser'],
          width: '237px'
        },
        'file browser'
      )
      // The pane is registered but absent from the tree (the portrait regression
      // scenario: the user dismissed the right sidebar, or it was never opened).
      $layoutTree.set(group(['workspace']))

      expect(allPaneIds($layoutTree.get()!)).not.toContain('files')

      const { getByTestId, queryByTestId } = render(<NarrowOverlays />)

      expect(queryByTestId('files-body')).toBeNull()

      // Tapping the right sidebar toggle in portrait must show the overlay — the
      // button must not be unresponsive just because the pane is absent from the
      // tree.
      act(() => toggleFileBrowserOpen())
      expect(getByTestId('files-body')).toBeTruthy()

      // A second tap closes it.
      act(() => toggleFileBrowserOpen())
      expect(queryByTestId('files-body')).toBeNull()
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
    }
  })
})
