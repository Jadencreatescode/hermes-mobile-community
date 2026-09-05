import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listA2AAgents, loadQuickSettings, removeA2AAgent, saveQuickSettings } = vi.hoisted(() => ({
  listA2AAgents: vi.fn(),
  loadQuickSettings: vi.fn(),
  removeA2AAgent: vi.fn(),
  saveQuickSettings: vi.fn(),
  registerA2AAgent: vi.fn()
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listA2AAgents,
  removeA2AAgent
}))

vi.mock('./control-room-actions', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadQuickSettings,
  saveQuickSettings,
  clearQuickSettings: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()

  return {
    ...actual,
    host: {
      notifyError: vi.fn(),
      request: vi.fn()
    }
  }
})

import { ControlRoomView } from './control-room-view'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ControlRoomView', () => {
  it('lists A2A agents with avatars and status', async () => {
    listA2AAgents.mockResolvedValue([
      { agentId: 'a2a:one', name: 'Agent One', status: 'verified', capabilities: ['chat'] },
      { agentId: 'a2a:two', name: 'Agent Two', status: 'pending', capabilities: [] }
    ])

    render(<ControlRoomView />)

    await waitFor(() => expect(screen.getByText('Agent One')).toBeTruthy())
    expect(screen.getByText('Agent Two')).toBeTruthy()
    expect(screen.getByText('Capabilities: chat')).toBeTruthy()
  })

  it('opens the onboarding dialog and adds a new agent', async () => {
    listA2AAgents.mockResolvedValue([])

    render(<ControlRoomView />)
    await waitFor(() => expect(screen.getByText('No A2A agents connected')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Connect agent' }))

    expect(screen.getByLabelText('Agent card URL')).toBeTruthy()
  })

  it('expands quick settings for an agent', async () => {
    listA2AAgents.mockResolvedValue([
      { agentId: 'a2a:one', name: 'Agent One', status: 'verified', capabilities: [] }
    ])
    loadQuickSettings.mockResolvedValue({
      model: 'gpt-4o',
      provider: 'openai',
      effort: 'medium',
      fast: false,
      iconColor: '#ff0000',
      iconShape: 'rounded'
    })

    render(<ControlRoomView />)
    await waitFor(() => expect(screen.getByText('Agent One')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Expand settings for Agent One/i }))

    await waitFor(() => expect(screen.getByDisplayValue('gpt-4o')).toBeTruthy())
    expect(screen.getByDisplayValue('openai')).toBeTruthy()
  })

  it('removes an agent and clears its settings', async () => {
    listA2AAgents.mockResolvedValue([
      { agentId: 'a2a:one', name: 'Agent One', status: 'verified', capabilities: [] }
    ])
    removeA2AAgent.mockResolvedValue({ agentId: 'a2a:one', deleted: true })

    render(<ControlRoomView />)
    await waitFor(() => expect(screen.getByText('Agent One')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Remove Agent One/i }))

    await waitFor(() => expect(screen.queryByText('Agent One')).toBeNull())
  })

  it('shows an error when the agent list fails', async () => {
    listA2AAgents.mockRejectedValue(new Error('network'))

    render(<ControlRoomView />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load A2A agents'))
  })
})
