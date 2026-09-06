import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BotAvatar } from './bot-avatar'

describe('BotAvatar', () => {
  it('renders a monogram from the first two characters of the name', () => {
    render(<BotAvatar name="Alpha Bot" />)

    expect(screen.getByText('AL')).toBeTruthy()
  })

  it('uses the passed name for screen-reader accessibility', () => {
    render(<BotAvatar name="Test Agent" />)

    expect(screen.getByLabelText('Test Agent')).toBeTruthy()
  })

  it('applies size classes', () => {
    const { container } = render(<BotAvatar name="A" size="lg" />)

    expect(container.querySelector('.size-10')).toBeTruthy()
  })
})
