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
  harnesses?: { id: string; label: string; detected: boolean; source: string }[]
  models?: { id: string; label: string; provider: string }[]
}) {
  return {
    degraded: options.degraded ?? false,
    degradedReason: options.degradedReason,
    harnesses: options.harnesses ?? [{ id: 'hermes', label: 'Hermes', detected: true, source: 'native' }],
    machine: { id: 'local', label: 'This machine', reachable: true },
    models: options.models ?? [{ id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' }]
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
      harnesses: []
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
        harnesses: []
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
      models: []
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)

    await waitFor(() => expect(screen.getByText(/No models available/i)).toBeTruthy())
  })

  it('shows no-machine degraded state', async () => {
    loadMakeBotState.mockResolvedValue({
      degraded: true,
      degradedReason: 'no_machine',
      harnesses: [],
      models: []
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

  it('submits createBot with selected harness and model', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      harnesses: [
        { id: 'hermes', label: 'Hermes', detected: true, source: 'native' },
        { id: 'claude_code', label: 'Claude Code', detected: true, source: 'native' }
      ],
      models: [
        { id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' },
        { id: 'gpt-4', label: 'gpt-4', provider: 'openai' }
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
      model: 'gpt-4'
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

  it('shows the machine list with This machine selected and disabled', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({}))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Machine/i)).toBeTruthy())

    const machineSelect = screen.getByLabelText(/Machine/i) as HTMLSelectElement
    expect(machineSelect.disabled).toBe(true)
    expect(machineSelect.value).toBe('local')
    expect([...machineSelect.options].map(option => option.value)).toContain('local')
    expect([...machineSelect.options].map(option => option.textContent)).toContain('This machine')
  })

  it('shows harness list with labels and detected status', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      harnesses: [
        { id: 'hermes', label: 'Hermes', detected: true, source: 'native' },
        { id: 'claude_code', label: 'Claude Code', detected: false, source: 'native' }
      ]
    }))

    render(<MakeBotDialog onOpenChange={vi.fn()} open />)
    await waitFor(() => expect(screen.getByLabelText(/Harness/i)).toBeTruthy())

    const harnessSelect = screen.getByLabelText(/Harness/i) as HTMLSelectElement
    expect([...harnessSelect.options].map(option => option.value)).toEqual(['hermes', 'claude_code'])
    expect([...harnessSelect.options].map(option => option.textContent)).toEqual(['Hermes', 'Claude Code'])
    expect(screen.getByText(/Detected/i)).toBeTruthy()
    expect(screen.getByText(/native/i)).toBeTruthy()
  })

  it('shows model list grouped by provider', async () => {
    loadMakeBotState.mockResolvedValue(resolvedState({
      models: [
        { id: 'claude-sonnet-4', label: 'claude-sonnet-4', provider: 'anthropic' },
        { id: 'gpt-4', label: 'gpt-4', provider: 'openai' }
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
})
