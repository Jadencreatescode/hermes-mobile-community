import { host } from '@hermes/plugin-sdk'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error The bundled Bot Mode plugin is intentionally authored as runtime JavaScript.
import botsPlugin from './plugin.js'

const { ProviderBotRow } = botsPlugin.__test

function agent(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Release compliance review',
    handle: 'release-reviewer',
    harness: 'claude-code',
    host_label: 'Trusted Lab',
    id: 'verified-a',
    model: { id: 'sonnet', provider: 'anthropic' },
    name: 'Claude Reviewer',
    verification_state: 'verified',
    ...overrides
  }
}

function row(provider: Record<string, unknown>) {
  return {
    active: false,
    activity: 0,
    agent: agent(),
    kind: 'provider-bot',
    pinned: false,
    provider: {
      list_verified_agents: vi.fn(),
      open_bot_chat: vi.fn(),
      ...provider
    }
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('connected provider Bot row', () => {
  it('presents the connected agent identity and opens through its provider', () => {
    const openBotChat = vi.fn()
    const value = row({ open_bot_chat: openBotChat })

    render(<ProviderBotRow onRefresh={() => undefined} row={value} />)

    expect(screen.getByText('Claude Reviewer')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('anthropic · sonnet')).toBeTruthy()
    expect(screen.getByText('Trusted Lab · claude-code')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Claude Reviewer/ }))
    expect(openBotChat).toHaveBeenCalledWith(value.agent)
  })

  it('lets an optional provider callback mark the row selected', () => {
    const value = row({ is_agent_selected: vi.fn(() => true) })

    render(<ProviderBotRow onRefresh={() => undefined} row={value} />)

    expect(screen.getByRole('button', { name: /Claude Reviewer/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('opens provider settings from the settings control', () => {
    const openSettings = vi.fn()
    const value = row({ open_settings: openSettings })

    render(<ProviderBotRow onRefresh={() => undefined} row={value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage Claude Reviewer' }))

    expect(openSettings).toHaveBeenCalledWith(value.agent)
  })

  it('refreshes the agent and then refetches the provider query', async () => {
    const refreshAgent = vi.fn().mockResolvedValue(undefined)
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const value = row({ refresh_agent: refreshAgent })

    render(<ProviderBotRow onRefresh={onRefresh} row={value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Claude Reviewer' }))

    await waitFor(() => expect(refreshAgent).toHaveBeenCalledWith(value.agent))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('surfaces provider refresh failures without refetching stale data', async () => {
    const failure = new Error('refresh failed')
    const refreshAgent = vi.fn().mockRejectedValue(failure)
    const onRefresh = vi.fn()
    const notifyError = vi.spyOn(host, 'notifyError').mockImplementation(() => '')

    render(<ProviderBotRow onRefresh={onRefresh} row={row({ refresh_agent: refreshAgent })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Claude Reviewer' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalledWith(failure, 'Could not refresh Claude Reviewer'))
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
