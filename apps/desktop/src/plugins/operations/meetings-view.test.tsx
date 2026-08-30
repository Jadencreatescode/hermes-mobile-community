import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { notify, requestProfile } = vi.hoisted(() => ({ notify: vi.fn(), requestProfile: vi.fn() }))

vi.mock('@hermes/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  host: { notify, requestProfile }
}))

import { bindOperationsApi } from './api'
import type { OperationsSnapshot } from './data'
import { MeetingsView } from './meetings-view'

let unbind: (() => void) | undefined

afterEach(() => {
  cleanup()
  unbind?.()
  unbind = undefined
  vi.clearAllMocks()
})

const snapshot: OperationsSnapshot = {
  agents: [
    {
      assignments: [], displayName: 'Reviewer', id: 'local::reviewer', profile: 'reviewer', sourceId: 'local',
      sourceKind: 'local', sourceLabel: 'Local Hermes', state: 'idle', workSummary: 'Ready'
    },
    {
      assignments: [], displayName: 'Builder', id: 'local::builder', profile: 'builder', sourceId: 'local',
      sourceKind: 'local', sourceLabel: 'Local Hermes', state: 'idle', workSummary: 'Ready'
    }
  ],
  partialFailures: [],
  sources: [{ id: 'local', kind: 'local', label: 'Local Hermes', reachable: true, status: 'online' }]
}

describe('MeetingsView', () => {
  it('creates a bounded source-qualified meeting with touch-safe controls', async () => {
    const rest = vi.fn(async (path: string, options?: { body?: { record?: unknown } }) => {
      if (path.startsWith('/meetings?')) {
        return { meetings: [] }
      }

      return { meeting: options?.body?.record, version: 1 }
    })

    unbind = bindOperationsApi(rest as never)

    const { container } = render(<MeetingsView snapshot={snapshot} />)
    await screen.findByText('No meetings yet.')
    fireEvent.change(screen.getByLabelText('Meeting title'), { target: { value: 'Release council' } })
    fireEvent.change(screen.getByLabelText('Meeting agenda'), { target: { value: 'Decide whether to release.' } })
    fireEvent.click(screen.getByLabelText('Select Reviewer as a meeting participant'))
    fireEvent.click(screen.getByLabelText('Select Builder as a meeting participant'))
    const create = screen.getByRole('button', { name: 'Create meeting draft' })
    expect(create.className).toContain('min-h-11')
    fireEvent.click(create)

    await waitFor(() => expect(rest).toHaveBeenCalledWith(expect.stringMatching(/^\/meetings\/meeting_/), expect.objectContaining({ method: 'PUT' })))
    expect(await screen.findByText('Release council')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start meeting' }).className).toContain('min-h-11')
    expect(container.textContent).not.toMatch(/fixed owner|private node|take over/i)
  })

  it('shows meeting service failures explicitly rather than as verified empty data', async () => {
    unbind = bindOperationsApi(vi.fn().mockRejectedValue(new Error('Meeting service unavailable')) as never)

    render(<MeetingsView snapshot={snapshot} />)

    expect((await screen.findByRole('alert')).textContent).toContain('Meeting service unavailable')
    expect(screen.queryByText('No meetings yet.')).toBeNull()
  })
})
