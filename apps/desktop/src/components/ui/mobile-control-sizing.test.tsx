import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { buttonVariants } from './button'
import { controlVariants } from './control'
import { Switch } from './switch'

afterEach(cleanup)

describe('mobile control sizing', () => {
  it('gives standard buttons and form controls a 44px phone minimum', () => {
    expect(buttonVariants({ size: 'sm' })).toContain('max-sm:min-h-11')
    expect(buttonVariants({ size: 'icon-sm' })).toContain('max-sm:size-11')
    expect(controlVariants({ size: 'sm' })).toContain('max-sm:min-h-11')
  })

  it('extends a compact switch to a centered 44px phone hit area', () => {
    render(<Switch aria-label="Enabled" />)

    const control = screen.getByRole('switch', { name: 'Enabled' })
    expect(control.className).toContain('max-sm:before:size-11')
    expect(control.className).toContain('max-sm:before:content-[\'\']')
  })
})
