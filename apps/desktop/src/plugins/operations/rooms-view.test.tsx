import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listRooms, readRoom } = vi.hoisted(() => ({
  listRooms: vi.fn(),
  readRoom: vi.fn()
}))

vi.mock('./rooms', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listRooms,
  readRoom
}))

import { RoomsView } from './rooms-view'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RoomsView', () => {
  it('enables only the action that owns the durable room floor', async () => {
    const room = {
      createdAt: '',
      floor: 'a2a:review',
      id: 'room-1',
      memberCount: 1,
      members: ['a2a:review'],
      name: 'Release'
    }

    listRooms.mockResolvedValue([room])
    readRoom.mockResolvedValue({ room, transcript: [] })

    render(<RoomsView agents={[{ id: 'a2a:review', label: 'Review Bot' }]} />)

    expect(await screen.findByText('Floor: Review Bot')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Room message' }), {
      target: { value: 'Review this release.' }
    })

    expect((screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Ask this Bot' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
