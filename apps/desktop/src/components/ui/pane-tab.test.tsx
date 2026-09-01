import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaneTab, PaneTabLabel } from './pane-tab'

afterEach(cleanup)

describe('PaneTab close gestures', () => {
  it('middle-click closes — pointer events only, no auxclick', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    const tab = screen.getByText('tab')
    fireEvent.pointerDown(tab, { button: 1 })
    fireEvent.pointerUp(tab, { button: 1 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('⌘-click (metaKey + button 0) closes — the Mac middle-click equivalent', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('⌘-click preempts the shell drag/activate pointerdown handler', () => {
    const onClose = vi.fn()
    const onPointerDown = vi.fn()
    render(
      <PaneTab onClose={onClose} onPointerDown={onPointerDown}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('⌘-click swallows the follow-up activation click (capture phase)', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel as="button" onClick={onActivate}>
          tab
        </PaneTabLabel>
      </PaneTab>
    )

    fireEvent.click(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('plain left-click neither closes nor blocks activation', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    const onPointerDown = vi.fn()
    render(
      <PaneTab onClose={onClose} onPointerDown={onPointerDown}>
        <PaneTabLabel as="button" onClick={onActivate}>
          tab
        </PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0 })
    fireEvent.click(screen.getByText('tab'), { button: 0 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onPointerDown).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('does nothing without an onClose (uncloseable workspace tab)', () => {
    const onPointerDown = vi.fn()
    render(
      <PaneTab onPointerDown={onPointerDown}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })
})

describe('PaneTab hover close button', () => {
  it('clicking the ✕ closes without activating or dragging the tab', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    const onPointerDown = vi.fn()
    render(
      <PaneTab onClose={onClose} onPointerDown={onPointerDown}>
        <PaneTabLabel as="button" onClick={onActivate}>
          tab
        </PaneTabLabel>
      </PaneTab>
    )

    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.pointerDown(close, { button: 0 })
    fireEvent.click(close, { button: 0 })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('renders no ✕ without an onClose', () => {
    render(
      <PaneTab>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('a closeable horizontal tab always shows its ✕ — the chip and the pointer gestures are one affordance', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()

    const tab = screen.getByText('tab')
    fireEvent.pointerDown(tab, { button: 1 })
    fireEvent.pointerUp(tab, { button: 1 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders no ✕ on a vertical rail tab (middle/⌘-click only there)', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose} vertical>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

describe('PaneTab always-visible close (narrow / touch viewport)', () => {
  it('shows the ✕ without hovering when alwaysClose is set', () => {
    const onClose = vi.fn()
    render(
      <PaneTab alwaysClose onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('tapping the always-visible ✕ closes the tab', () => {
    const onClose = vi.fn()
    render(
      <PaneTab alwaysClose onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the ✕ hidden without a pointer when alwaysClose is not set', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    // The ✕ is always in the DOM — the desktop reveal is a CSS opacity toggle,
    // so it sits at opacity-0 (hidden) until the tab is hovered.
    const close = screen.getByRole('button', { name: 'Close' })
    const wrap = close.closest('span')!
    expect(wrap.className).toContain('opacity-0')
    expect(wrap.className).toContain('group-hover/tab:pointer-events-auto')
  })

  it('shows the ✕ at full opacity without a pointer when alwaysClose is set', () => {
    const onClose = vi.fn()
    render(
      <PaneTab alwaysClose onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    const close = screen.getByRole('button', { name: 'Close' })
    const wrap = close.closest('span')!
    expect(wrap.className).toContain('opacity-100')
    expect(wrap.className).not.toContain('opacity-0')
    expect(wrap.className).not.toContain('group-hover/tab')
  })
})

describe('PaneTabLabel reserveClose padding', () => {
  it('does not pad the right edge by default (hover-revealed ✕ keeps full label width)', () => {
    const { container } = render(<PaneTabLabel>long-filename</PaneTabLabel>)

    // The outer Comp is the first span in the tree.
    expect(container.querySelector('span')!.className).not.toContain('pr-6')
  })

  it('pads the right edge to reserve room for the always-visible ✕', () => {
    const { container } = render(<PaneTabLabel reserveClose>long-filename</PaneTabLabel>)

    expect(container.querySelector('span')!.className).toContain('pr-6')
  })
})
