import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getA2AChatHistory, sendA2AChatMessage } = vi.hoisted(() => ({
  getA2AChatHistory: vi.fn(),
  sendA2AChatMessage: vi.fn()
}))

vi.mock('./data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getA2AChatHistory,
  sendA2AChatMessage
}))

import { ConnectedAgentChat, ConnectedAgentChatSurface } from './connected-agent-chat'
import type { HarnessAgent } from './data'

const harnessAgent = (capabilities: string[] = ['chat.send']): HarnessAgent => ({
  agentId: 'a2a:claude-reviewer',
  capabilities,
  name: 'Claude Reviewer',
  status: 'verified'
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
})

describe('ConnectedAgentChat', () => {
  it('ignores legacy plaintext outbox entries instead of restoring secret-bearing content', async () => {
    window.localStorage.setItem('hermes.operations.connected-agent.outbox.v1', JSON.stringify({
      agentId: 'a2a:claude-reviewer', message: 'token=legacy-secret', requestId: 'durable-request'
    }))
    getA2AChatHistory.mockResolvedValue({ messages: [], mirror_session_id: 'mirror_1' })
    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)
    await screen.findByLabelText('Message Claude Reviewer')
    expect(screen.queryByDisplayValue('token=legacy-secret')).toBeNull()
    await waitFor(() => expect(window.localStorage.getItem('hermes.operations.connected-agent.outbox.v1')).toBeNull())
  })

  it('never stores message plaintext and keeps request identity for authoritative reload readback', async () => {
    const secretMessage = 'deploy with token=renderer-secret-value'

    getA2AChatHistory.mockResolvedValue({ messages: [], mirror_session_id: 'mirror_1' })
    sendA2AChatMessage.mockRejectedValue(new Error('accepted but response lost'))

    const first = render(<ConnectedAgentChatSurface agent={harnessAgent()} />)
    const composer = await screen.findByLabelText('Message Claude Reviewer')
    fireEvent.change(composer, { target: { value: secretMessage } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Reviewer' }))
    await screen.findByRole('alert')
    const persisted = window.localStorage.getItem('hermes.operations.connected-agent.outbox.v1') || ''
    expect(persisted).not.toContain(secretMessage)
    expect(persisted).not.toContain('renderer-secret-value')
    const requestId = JSON.parse(persisted).requestId
    expect(requestId).toBeTruthy()
    first.unmount()

    getA2AChatHistory.mockImplementation(async (_agentId: string, reqId?: string) => ({
      messages: [],
      mirror_session_id: 'mirror_1',
      request_status: reqId === requestId ? 'committed' : undefined
    }))

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)
    await waitFor(() => expect(getA2AChatHistory).toHaveBeenCalledWith('a2a:claude-reviewer', requestId))
    await waitFor(() => expect(window.localStorage.getItem('hermes.operations.connected-agent.outbox.v1')).toBeNull())
  })

  it('keeps only opaque request metadata through an uncertain send failure', async () => {
    getA2AChatHistory.mockResolvedValue({ messages: [], mirror_session_id: 'mirror_1' })
    sendA2AChatMessage.mockRejectedValue(new Error('connection closed after acceptance'))

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)
    const composer = await screen.findByRole('textbox', { name: 'Message Claude Reviewer' })
    fireEvent.change(composer, { target: { value: 'Crash-safe message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Reviewer' }))
    expect((await screen.findByRole('alert')).textContent).toContain('connection closed after acceptance')
    expect(JSON.parse(window.localStorage.getItem('hermes.operations.connected-agent.outbox.v1') || '{}')).toMatchObject({
      agentId: 'a2a:claude-reviewer', requestId: expect.any(String)
    })
    expect(window.localStorage.getItem('hermes.operations.connected-agent.outbox.v1')).not.toContain('Crash-safe message')
  })

  it('renders the connected conversation as plain workspace content', async () => {
    getA2AChatHistory.mockResolvedValue({
      messages: [
        { role: 'assistant', content: 'Workspace history is ready.' },
        { role: 'user', content: 'Review the contrast.' }
      ],
      mirror_session_id: 'mirror_1'
    })

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)

    expect(await screen.findByText('Workspace history is ready.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    const composer = screen.getByRole('textbox', { name: 'Message Claude Reviewer' })
    const outgoing = screen.getByText('Review the contrast.').closest('article')

    expect(composer.className).toContain('placeholder:text-(--ui-text-secondary)')
    expect(outgoing?.className).toContain('bg-primary')
    expect(outgoing?.className).toContain('text-primary-foreground')
  })

  it('loads mirrored history and sends through the A2A chat API', async () => {
    const messages: Array<{ role: 'assistant' | 'user'; content: string }> = [
      { role: 'assistant', content: 'Ready to review.' }
    ]

    getA2AChatHistory.mockImplementation(async (_agentId: string, requestId?: string) => {
      if (requestId) {
        return { messages: [...messages], mirror_session_id: 'mirror_1', request_status: 'committed' }
      }
      return { messages: [...messages], mirror_session_id: 'mirror_1' }
    })

    sendA2AChatMessage.mockImplementation(async (_agentId: string, message: string) => {
      messages.push({ role: 'user', content: message })
      messages.push({ role: 'assistant', content: 'The exact diff passes.' })
      return {
        reply: 'The exact diff passes.',
        state: 'completed',
        request_status: 'committed',
        native_session_id: 'mirror_1',
        connector_event_id: 'evt-1'
      }
    })

    render(<ConnectedAgentChat agent={harnessAgent()} onClose={() => undefined} />)

    expect(await screen.findByText('Ready to review.')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude Reviewer' }), {
      target: { value: 'Review this release.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Reviewer' }))

    expect(await screen.findByText('The exact diff passes.')).toBeTruthy()
    expect(sendA2AChatMessage).toHaveBeenCalledWith('a2a:claude-reviewer', 'Review this release.', expect.any(String))
    expect(getA2AChatHistory).toHaveBeenLastCalledWith('a2a:claude-reviewer', expect.any(String))
  })

  it('keeps the conversation readable but disables sending without chat.send', async () => {
    getA2AChatHistory.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Read only history.' }],
      mirror_session_id: 'mirror_1'
    })

    render(<ConnectedAgentChat agent={harnessAgent(['chat.read'])} onClose={() => undefined} />)

    expect(await screen.findByText('Read only history.')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Message Claude Reviewer' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByText('This connector did not advertise chat.send.')).toBeTruthy()
  })

  it('handles send error gracefully', async () => {
    getA2AChatHistory.mockResolvedValue({ messages: [], mirror_session_id: 'mirror_1' })
    sendA2AChatMessage.mockRejectedValue(new Error('Send failed'))

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)

    const composer = await screen.findByRole('textbox', { name: 'Message Claude Reviewer' })
    fireEvent.change(composer, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Reviewer' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Send failed'))
  })

  it('clears input after successful send', async () => {
    getA2AChatHistory.mockImplementation(async (_agentId: string, requestId?: string) => ({
      messages: [],
      mirror_session_id: 'mirror_1',
      request_status: requestId ? 'committed' : undefined
    }))
    sendA2AChatMessage.mockResolvedValue({ reply: 'Got it', state: 'completed', request_status: 'committed', native_session_id: 'mirror_1', connector_event_id: 'evt-1' })

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)

    const composer = await screen.findByRole('textbox', { name: 'Message Claude Reviewer' })
    fireEvent.change(composer, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Reviewer' }))

    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''))
  })

  it('disables send button for empty or whitespace-only draft', async () => {
    getA2AChatHistory.mockResolvedValue({ messages: [], mirror_session_id: 'mirror_1' })

    render(<ConnectedAgentChatSurface agent={harnessAgent()} />)

    const composer = await screen.findByRole('textbox', { name: 'Message Claude Reviewer' })
    fireEvent.change(composer, { target: { value: '   ' } })

    expect((screen.getByRole('button', { name: 'Send to Claude Reviewer' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows degraded status in agent metadata', async () => {
    getA2AChatHistory.mockResolvedValue({ messages: [{ role: 'assistant', content: 'Last message.' }], mirror_session_id: 'mirror_1' })

    render(<ConnectedAgentChatSurface agent={{ ...harnessAgent(), status: 'degraded' }} />)

    expect(await screen.findByText('Last message.')).toBeTruthy()
    expect(screen.getByText(/degraded/)).toBeTruthy()
  })
})
