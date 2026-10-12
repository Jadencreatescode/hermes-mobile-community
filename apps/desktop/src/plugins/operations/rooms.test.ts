import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import {
  addRoomMember,
  createRoom,
  handoffRoom,
  listRooms,
  normalizeRoom,
  postRoomMessage,
  readRoom,
  removeRoomMember,
  roomActorLabel,
  runRoomTurn
} from './rooms'

let unbind: (() => void) | undefined

afterEach(() => {
  unbind?.()
  unbind = undefined
})

describe('public Operations rooms', () => {
  it('normalizes room authority without inventing floor or members', () => {
    expect(normalizeRoom({ id: 'room-1', name: 'Release', floor: 'a2a:review', members: ['a2a:review'] }))
      .toMatchObject({ id: 'room-1', name: 'Release', floor: 'a2a:review', memberCount: 1 })
    expect(normalizeRoom({ name: 'missing id' })).toBeNull()
    expect(roomActorLabel('owner', [])).toBe('You')
  })

  it('uses only the bounded explicit REST routes', async () => {
    const rest = vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === '/rooms' && !options) {
        return { rooms: [{ id: 'room-1', name: 'Release', members: [] }] }
      }

      if (path.startsWith('/rooms/room-1?')) {
        return {
          room: { id: 'room-1', name: 'Release', members: ['a2a:review'] },
          transcript: [{ id: 1, speaker: 'owner', text: 'Review it.' }]
        }
      }

      return { room: { id: 'room-2', name: 'New room', members: [] } }
    })

    unbind = bindOperationsApi(rest as never)

    await expect(listRooms()).resolves.toHaveLength(1)
    await expect(readRoom('room-1')).resolves.toMatchObject({ transcript: [{ text: 'Review it.' }] })
    await createRoom('New room')
    await addRoomMember('room-1', 'a2a:review')
    await removeRoomMember('room-1', 'a2a:review')
    await postRoomMessage('room-1', 'Status?', 'message-1')
    await handoffRoom('room-1', 'a2a:review')
    await runRoomTurn('room-1', 'a2a:review', 'Answer this.', 'turn-1')

    expect(rest).toHaveBeenCalledWith('/rooms', { method: 'POST', body: { confirm: true, name: 'New room' } })
    expect(rest).toHaveBeenCalledWith('/rooms/room-1/members/a2a%3Areview', { method: 'POST', body: { confirm: true } })
    expect(rest).toHaveBeenCalledWith('/rooms/room-1/members/a2a%3Areview?confirm=true', { method: 'DELETE' })
    expect(rest).toHaveBeenCalledWith('/rooms/room-1/messages', {
      method: 'POST', body: { message: 'Status?', request_id: 'message-1' }
    })
    expect(rest).toHaveBeenCalledWith('/rooms/room-1/handoff', {
      method: 'POST', body: { agent_id: 'a2a:review', confirm: true }
    })
    expect(rest).toHaveBeenCalledWith('/rooms/room-1/turns', {
      method: 'POST', body: { agent_id: 'a2a:review', message: 'Answer this.', request_id: 'turn-1' }
    })
  })
})
