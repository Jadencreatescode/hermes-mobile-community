import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  createBot,
  fetchMakeBotCatalog,
  loadMakeBotState
} = vi.hoisted(() => ({
  createBot: vi.fn(),
  fetchMakeBotCatalog: vi.fn(),
  loadMakeBotState: vi.fn()
}))

vi.mock('./make-bot-data', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createBot,
  fetchMakeBotCatalog,
  loadMakeBotState
}))

import { MakeBotDialog } from './make-bot-dialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function resolvedState(options: {
  degraded?: boolean
  degradedReason?: 'no_harness' | 'no_machine' | 'no_model'
  machines?: { machine: { id: string; label: string; kind: 'local' | 'remote' | 'ssh' | 'cloud'; state: 'online' | 'offline' | 'unreachable' }; harnesses: { id: string; label: string; detected: boolean; selectable?: boolean; source: string; downloadUrl?: string | null }[]; models: { id: string; label: string; provider: string }[] }[]
}) {
  return {
    degraded: options.degraded ?? false,
    degradedReason: options.degradedReason,
    machines: options.machines ?? [{
      machine: { id: 'local', label: 'This machine', kind: 'local' as const, state: 'online' as const },
      harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
      models: [{ id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' }]
    }]
  }
}

describe('MakeBotDialog', () => {
  it('renders loading state while reading catalog', async () => {
    loadMakeBotState.mockReturnValue(new Promise(() => {}))
    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    expect(screen.getByRole('status', { name: /Reading catalog/i })).toBeTruthy()
  })

  it('renders form fields when catalog loads', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())
    expect(screen.getByLabelText(/Machine/i)).toBeTruthy()
    expect(screen.getByLabelText(/Harness/i)).toBeTruthy()
    expect(screen.getByLabelText(/Model/i)).toBeTruthy()
  })

  it('shows missing harness state with install commands and check again', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      degraded: true,
      degradedReason: 'no_harness',
      machines: [{
        machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
        harnesses: [],
        models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
      }]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByText(/No harnesses detected/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /Check again/i })).toBeTruthy()
  })

  it('re-fetches catalog when check again is clicked', async () => {
    loadMakeBotState
      .mockResolvedValueOnce(resolvedState({
        degraded: true,
        degradedReason: 'no_harness',
        machines: [{
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }]
      }))
      .mockResolvedValueOnce(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByRole('button', { name: /Check again/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Check again/i }))

    await waitFor(() => expect(loadMakeBotState).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())
  })

  it('shows no-model degraded state', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      degraded: true,
      degradedReason: 'no_model',
      machines: [{
        machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
        harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
        models: []
      }]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByText(/No models available/i)).toBeTruthy())
  })

  it('shows no-machine degraded state', async () => {
    loadMakeBotState.mockResolvedValue({
      degraded: true,
      degradedReason: 'no_machine',
      machines: []
    })

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByText(/machine could not be reached/i)).toBeTruthy())
  })

  it('validates that name is required', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Give this Bot a name'))
  })

  it('validates name pattern', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'Bad Name!' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lowercase letters, numbers, dashes, or underscores'))
  })

  it('submits createBot with selected harness, model, and machine', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' },
            { id: 'claude_code', label: 'Claude Code', detected: true, selectable: true, source: 'native' }
          ],
          models: [
            { id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' },
            { id: 'gpt-4', label: 'gpt-4', provider: 'openai' }
          ]
        }
      ]
    }))
    createBot.mockResolvedValue({ name: 'testbot', path: '/home/user/.hermes/profiles/testbot', harness: 'claude_code', model: 'gpt-4' })

    const onCreated = vi.fn()
    const onOpenChange = vi.fn()

    render(<MakeBotDialog onCreated={onCreated} onOpenChange={onOpenChange} open />)

    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'testbot' } })
    fireEvent.change(screen.getByLabelText(/Harness/i), { target: { value: 'claude_code' } })
    fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4' } })

    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(createBot).toHaveBeenCalledWith(expect.objectContaining({
      name: 'testbot',
      harness: 'claude_code',
      model: 'gpt-4',
      connectionId: 'local'
    })))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('testbot'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('shows error when creation fails', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))
    createBot.mockRejectedValue(new Error('name taken'))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'taken' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(screen.getByText(/name taken/i)).toBeTruthy())
  })

  it('resets form when reopened', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    const { rerender } = render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'mybot' } })
    expect((screen.getByLabelText(/Bot name/i) as HTMLInputElement).value).toBe('mybot')

    rerender(<MakeBotDialog onOpenChange={vi.fn()} open={false} />)
    rerender(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect((screen.getByLabelText(/Bot name/i) as HTMLInputElement).value).toBe(''))
  })

  it('has touch-friendly sizes and no horizontal overflow classes', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    const dialog = screen.getByRole('dialog')
    expect(dialog.className.includes('overflow-y-auto')).toBe(true)
    expect(dialog.className.includes('max-w-2xl')).toBe(true)
  })

  it('shows the machine list with all machines and their states', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
          models: []
        },
        {
          machine: { id: 'homelab', label: 'Homelab', kind: 'remote', state: 'unreachable' },
          harnesses: [],
          models: []
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Machine/i)).toBeTruthy())

    const machineSelect = screen.getByLabelText(/Machine/i) as HTMLSelectElement
    expect(machineSelect.disabled).toBe(false)
    expect(machineSelect.value).toBe('local')
    expect([...machineSelect.options].map(option => option.value)).toContain('local')
    expect([...machineSelect.options].map(option => option.value)).toContain('homelab')
    expect([...machineSelect.options].some(option => option.textContent?.includes('Homelab'))).toBe(true)
  })

  it('shows harness list for the selected machine', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' },
            { id: 'claude_code', label: 'Claude Code', detected: false, selectable: false, source: 'native' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())

    const harnessSelect = screen.getByLabelText(/Harness/i) as HTMLSelectElement
    expect([...harnessSelect.options].map(option => option.value)).toEqual(['hermes'])
    expect([...harnessSelect.options].map(option => option.textContent)).toEqual(['Hermes'])
    expect(screen.getByText(/Detected · native/i)).toBeTruthy()
  })

  it('shows non-selectable harnesses outside the select with download links', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' },
            { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', downloadUrl: 'https://www.npmjs.com/package/@openai/codex' },
            { id: 'cursor', label: 'Cursor', detected: false, selectable: false, source: 'none', downloadUrl: 'https://cursor.com' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())

    expect(screen.getByText(/Available to download/i)).toBeTruthy()
    expect(screen.getByText(/Codex/i)).toBeTruthy()
    expect(screen.getByText(/Cursor/i)).toBeTruthy()

    const codexLink = screen.getByLabelText(/Download Codex/i) as HTMLAnchorElement
    expect(codexLink.href).toBe('https://www.npmjs.com/package/@openai/codex')
    expect(codexLink.target).toBe('_blank')

    const cursorLink = screen.getByLabelText(/Download Cursor/i) as HTMLAnchorElement
    expect(cursorLink.href).toContain('https://cursor.com')
  })

  it('does not show download link when downloadUrl is missing', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'generic_a2a', label: 'Generic A2A', detected: false, selectable: false, source: 'none' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByText(/Available to download/i)).toBeTruthy())

    expect(screen.queryByLabelText(/Download Generic A2A/i)).toBeNull()
  })

  it('shows no selectable harness placeholder when none are selectable', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', downloadUrl: 'https://www.npmjs.com/package/@openai/codex' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())

    const harnessSelect = screen.getByLabelText(/Harness/i) as HTMLSelectElement
    expect([...harnessSelect.options].map(option => option.textContent)).toEqual(['No harness detected'])
    expect(harnessSelect.value).toBe('')
  })

  it('re-fetches catalog when refresh is clicked', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', downloadUrl: 'https://www.npmjs.com/package/@openai/codex' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByText(/Available to download/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }))

    await waitFor(() => expect(loadMakeBotState).toHaveBeenCalledTimes(2))
  })

  it('states that Hermes never installs a harness automatically', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [
            { id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' },
            { id: 'codex', label: 'Codex', detected: false, selectable: false, source: 'none', downloadUrl: 'https://www.npmjs.com/package/@openai/codex' }
          ],
          models: [{ id: 'gpt-4', label: 'GPT-4', provider: 'openai' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())

    expect(screen.getByText(/Hermes never installs a harness automatically/i)).toBeTruthy()
  })

  it('shows model list grouped by provider', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
          models: [
            { id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' },
            { id: 'gpt-4', label: 'gpt-4', provider: 'openai' }
          ]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Model/i)).toBeTruthy())

    const modelSelect = screen.getByLabelText(/Model/i) as HTMLSelectElement
    const optgroups = [...modelSelect.querySelectorAll('optgroup')]
    expect(optgroups.map(group => group.getAttribute('label'))).toEqual(['anthropic', 'openai'])
    expect([...optgroups[0].querySelectorAll('option')].map(option => option.value)).toContain('claude-sonnet-4')
    expect([...optgroups[1].querySelectorAll('option')].map(option => option.value)).toContain('gpt-4')
  })

  it('shows duplicate name error from the backend', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))
    createBot.mockRejectedValue(new Error('A Bot named testbot already exists'))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'testbot' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(screen.getByText(/A Bot named testbot already exists/i)).toBeTruthy())
  })

  it('uses full viewport width on phone and wider on desktop', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Bot name/i)).toBeTruthy())

    const dialog = screen.getByRole('dialog')
    expect(dialog.className.includes('w-[calc(100vw-1rem)]')).toBe(true)
    expect(dialog.className.includes('sm:w-[calc(100vw-2rem)]')).toBe(true)
  })

  it('switches harness and model lists when machine is changed', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
          models: [{ id: 'gpt-4', label: 'gpt-4', provider: 'openai' }]
        },
        {
          machine: { id: 'homelab', label: 'Homelab', kind: 'remote', state: 'online' },
          harnesses: [{ id: 'codex', label: 'Codex', detected: true, selectable: true, source: 'native' }],
          models: [{ id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' }]
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Machine/i)).toBeTruthy())

    const harnessSelect = screen.getByLabelText(/Harness/i) as HTMLSelectElement
    expect([...harnessSelect.options].map(option => option.value)).toEqual(['hermes'])

    fireEvent.change(screen.getByLabelText(/Machine/i), { target: { value: 'homelab' } })

    await waitFor(() => expect([...harnessSelect.options].map(option => option.value)).toEqual(['codex']))
  })

  it('passes the selected machine connectionId to createBot', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
          models: [{ id: 'gpt-4', label: 'gpt-4', provider: 'openai' }]
        },
        {
          machine: { id: 'homelab', label: 'Homelab', kind: 'remote', state: 'online' },
          harnesses: [{ id: 'codex', label: 'Codex', detected: true, selectable: true, source: 'native' }],
          models: [{ id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' }]
        }
      ]
    }))
    createBot.mockResolvedValue({ name: 'remotebot', path: '/home/user/.hermes/profiles/remotebot', harness: 'codex', model: 'claude-sonnet-4' })

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Machine/i)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/Bot name/i), { target: { value: 'remotebot' } })
    fireEvent.change(screen.getByLabelText(/Machine/i), { target: { value: 'homelab' } })

    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Harness/i), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'claude-sonnet-4' } })

    fireEvent.click(screen.getByRole('button', { name: /Create Bot/i }))

    await waitFor(() => expect(createBot).toHaveBeenCalledWith(expect.objectContaining({
      name: 'remotebot',
      harness: 'codex',
      model: 'claude-sonnet-4',
      connectionId: 'homelab'
    })))
  })

  it('marks unreachable machines honestly in the selector', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      machines: [
        {
          machine: { id: 'local', label: 'This machine', kind: 'local', state: 'online' },
          harnesses: [{ id: 'hermes', label: 'Hermes', detected: true, selectable: true, source: 'native' }],
          models: [{ id: 'gpt-4', label: 'gpt-4', provider: 'openai' }]
        },
        {
          machine: { id: 'homelab', label: 'Homelab', kind: 'remote', state: 'unreachable' },
          harnesses: [],
          models: []
        }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Machine/i)).toBeTruthy())

    const machineSelect = screen.getByLabelText(/Machine/i) as HTMLSelectElement
    const homelabOption = [...machineSelect.options].find(option => option.value === 'homelab')
    expect(homelabOption?.textContent).toContain('Homelab')
    expect(homelabOption?.textContent?.toLowerCase()).toContain('unreachable')
  })
})
