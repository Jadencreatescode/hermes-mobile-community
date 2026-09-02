import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPERATIONS_SECTIONS, OperationsNavigation } from './navigation'

afterEach(cleanup)

describe('Operations responsive navigation', () => {
  it('offers public Operations surfaces in compact and rail controls without page overflow', () => {
    const onChange = vi.fn()
    const { container } = render(<OperationsNavigation active="overview" onChange={onChange} />)

    expect(OPERATIONS_SECTIONS.map(section => section.id)).toEqual([
      'overview',
      'mailroom',
      'meetings',
      'workspace',
      'forge',
      'training'
    ])

    const compact = screen.getByLabelText('Operations section')
    expect(compact.className).toContain('w-full')
    expect(compact.className).toContain('min-h-11')
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist?.className).toContain('hidden')
    expect(tablist?.className).toContain('md:flex')
    expect(Array.from((compact as HTMLSelectElement).options, option => option.textContent)).toEqual(
      OPERATIONS_SECTIONS.map(section => section.label)
    )
    expect(container.firstElementChild?.className).toContain('min-w-0')

    fireEvent.change(compact, { target: { value: 'mailroom' } })
    expect(onChange).toHaveBeenCalledWith('mailroom')
  })
})
