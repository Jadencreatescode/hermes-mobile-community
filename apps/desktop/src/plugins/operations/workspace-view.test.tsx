import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { ensureAgent, newChat, openSession } = vi.hoisted(() => ({
  ensureAgent: vi.fn().mockResolvedValue(undefined),
  newChat: vi.fn(),
  openSession: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  host: { ensureAgent, newChat, notifyError: vi.fn(), openSession }
}))

import { WorkspaceView } from './workspace-view'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkspaceView', () => {
  it('opens exact existing Hermes sessions and never presents public screen takeover', async () => {
    const { container } = render(
      <WorkspaceView
        agents={[
          {
            assignments: [],
            displayName: 'Release Bot',
            id: 'local::release',
            openSessionId: 'stored-release',
            openSessionKind: 'bot-chat',
            profile: 'release',
            sourceId: 'local',
            sourceKind: 'local',
            sourceLabel: 'Local Hermes',
            state: 'idle',
            workSummary: 'No active work'
          }
        ]}
      />
    )

    const open = screen.getByRole('button', { name: 'Open Release Bot workspace' })
    expect(open.className).toContain('min-h-11')
    expect(container.textContent).not.toMatch(/take over|screen input|remote control/i)
    fireEvent.click(open)

    await waitFor(() => expect(ensureAgent).toHaveBeenCalledWith('local', 'release'))
    expect(openSession).toHaveBeenCalledWith('stored-release', expect.objectContaining({ profile: 'release' }))
  })

  it('explains that workspace authority remains with existing Hermes surfaces', () => {
    render(<WorkspaceView agents={[]} />)
    expect(screen.getByText(/transcript, files, changes, terminal, and preview remain in the existing Hermes workspace/i)).toBeTruthy()
    expect(screen.getByText('No Bot workspaces available.')).toBeTruthy()
  })
})
