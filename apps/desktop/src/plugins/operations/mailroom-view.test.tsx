import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import { MailroomView } from './mailroom-view'

const wire = {
  id: 'mail_1',
  source_profile: 'default',
  target_profile: 'builder',
  body: 'Review release.',
  urgency: 'priority',
  status: 'queued',
  created_at: 10,
  updated_at: 10,
  session_ref: null,
  dedupe_key: 'review-1',
  duplicate: false,
  history: [{ sequence: 1, status: 'queued', at: 10 }]
}

let unbind: (() => void) | undefined

afterEach(() => {
  cleanup()
  unbind?.()
  unbind = undefined
})

describe('MailroomView', () => {
  it('keeps compose, filters, and envelope actions touch safe on iPhone', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/mailroom?')) {
        return { envelopes: [wire] }
      }

      if (path === '/mailroom') {
        return { envelope: wire, delivery: { status: 'started', to: 'builder' } }
      }

      return { envelope: wire }
    })

    unbind = bindOperationsApi(rest as never)

    const { container } = render(<MailroomView activeProfile="default" profiles={['default', 'builder']} />)

    expect(await screen.findByText('Review release.')).toBeTruthy()
    expect(screen.getByLabelText('Mailroom status').className).toContain('min-h-11')
    expect(screen.getByLabelText('Mailroom target').className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Send through Mailroom' }).className).toContain('min-h-11')
    expect(container.firstElementChild?.className).toContain('min-w-0')

    fireEvent.change(screen.getByLabelText('Mailroom message'), { target: { value: 'Please check the release.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send through Mailroom' }))

    await waitFor(() => expect(rest).toHaveBeenCalledWith('/mailroom', expect.objectContaining({ method: 'POST' })))
  })

  it('keeps Critical unavailable until the exact route policy is explicitly approved', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.startsWith('/mailroom?')) {
        return { envelopes: [] }
      }

      if (path === '/mailroom/critical-policy') {
        return { source_profile: 'default', target_profile: 'builder', created_at: 10, expires_at: 70 }
      }

      return { envelope: wire, delivery: { status: 'started', to: 'builder' } }
    })

    unbind = bindOperationsApi(rest as never)

    render(<MailroomView activeProfile="default" profiles={['default', 'builder']} />)
    await screen.findByText('No Mailroom messages yet.')
    fireEvent.change(screen.getByLabelText('Mailroom urgency'), { target: { value: 'critical' } })

    const approve = screen.getByRole('button', { name: 'Approve Critical route for one hour' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('I approve Critical delivery from default to builder for one hour.'))
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)

    await waitFor(() => expect(rest).toHaveBeenCalledWith('/mailroom/critical-policy', expect.objectContaining({ method: 'PUT' })))
    expect(await screen.findByText(/Critical route approved until/i)).toBeTruthy()
  })

  it('shows backend failures visibly instead of collapsing to an empty state', async () => {
    unbind = bindOperationsApi(vi.fn().mockRejectedValue(new Error('Mailroom unavailable')) as never)

    render(<MailroomView activeProfile="default" profiles={['default', 'builder']} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Mailroom unavailable')
    expect(screen.queryByText('No Mailroom messages yet.')).toBeNull()
  })
})
