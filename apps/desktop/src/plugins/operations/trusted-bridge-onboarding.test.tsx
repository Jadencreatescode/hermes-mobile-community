import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { registerA2AAgent } = vi.hoisted(() => ({
  registerA2AAgent: vi.fn()
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerA2AAgent
}))

import { TrustedBridgeOnboarding } from './trusted-bridge-onboarding'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TrustedBridgeOnboarding', () => {
  it('renders the paste step and validates the URL', async () => {
    render(<TrustedBridgeOnboarding onOpenChange={vi.fn()} open />)

    expect(screen.getByLabelText('Agent card URL')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Review endpoint' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'not-a-url' } })

    expect((screen.getByRole('button', { name: 'Review endpoint' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'https://example.com/agent' } })

    expect((screen.getByRole('button', { name: 'Review endpoint' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('reviews the endpoint and moves to the confirm step', async () => {
    registerA2AAgent.mockResolvedValueOnce({
      agentId: 'a2a:preview1',
      name: 'Preview Bot',
      status: 'pending',
      capabilities: ['chat']
    })

    render(<TrustedBridgeOnboarding onOpenChange={vi.fn()} open />)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'https://example.com/agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review endpoint' }))

    await waitFor(() => expect(screen.getByText('Preview Bot')).toBeTruthy())
    expect(screen.getByText('Capabilities: chat')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Confirm and connect' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirms registration and calls onRegistered', async () => {
    registerA2AAgent
      .mockResolvedValueOnce({ agentId: 'a2a:preview1', name: 'Preview Bot', status: 'pending', capabilities: [] })
      .mockResolvedValueOnce({ agentId: 'a2a:preview1', name: 'Preview Bot', status: 'verified', capabilities: [] })

    const onRegistered = vi.fn()
    render(<TrustedBridgeOnboarding onOpenChange={vi.fn()} onRegistered={onRegistered} open />)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'https://example.com/agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review endpoint' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm and connect' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and connect' }))

    await waitFor(() => expect(screen.getByText(/Connected Preview Bot/i)).toBeTruthy())
    expect(onRegistered).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a2a:preview1', status: 'verified' }))
  })

  it('shows an error when review fails and stays on the paste step', async () => {
    registerA2AAgent.mockRejectedValueOnce(new Error('Invalid agent card'))

    render(<TrustedBridgeOnboarding onOpenChange={vi.fn()} open />)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'https://bad.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review endpoint' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid agent card'))
    expect((screen.getByLabelText('Agent card URL') as HTMLInputElement).disabled).toBe(false)
  })

  it('closes and resets state', async () => {
    registerA2AAgent.mockResolvedValueOnce({
      agentId: 'a2a:x',
      name: 'X',
      status: 'pending',
      capabilities: []
    })

    const onOpenChange = vi.fn()
    render(<TrustedBridgeOnboarding onOpenChange={onOpenChange} open />)

    fireEvent.change(screen.getByLabelText('Agent card URL'), { target: { value: 'https://example.com/agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review endpoint' }))
    await waitFor(() => expect(screen.getByText('X')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
