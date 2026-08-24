import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Intro } from './intro'

afterEach(cleanup)

describe('Intro mobile wordmark', () => {
  it('uses a phone-safe fit minimum and restores desktop sizing at the small breakpoint', () => {
    render(<Intro personality="default" seed={0} />)

    const wordmark = screen.getByLabelText('HERMES AGENT')
    expect(wordmark.className).toContain('[--fit-min:1.75rem]')
    expect(wordmark.className).toContain('sm:[--fit-min:2.75rem]')
  })
})
