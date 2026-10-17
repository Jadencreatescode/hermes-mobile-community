import { operationsApi } from './api'
import { record } from './contracts'

export interface OperationsRoom {
  createdAt: string
  floor: string
  id: string
  memberCount: number
  members: string[]
  name: string
}

export interface OperationsRoomMessage {
  at: string
  id: number
  kind: string
  speaker: string
  text: string
}

export interface OperationsRoomSnapshot {
  room: OperationsRoom
  transcript: OperationsRoomMessage[]
}

export const MAX_ROOM_MEMBERS = 6

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function normalizeRoom(value: unknown): OperationsRoom | null {
  const row = record(value)
  const id = text(row.id)

  if (!id) {
    return null
  }
  const members = strings(row.members)

  return {
    createdAt: text(row.created_at),
    floor: text(row.floor) || 'owner',
    id,
    memberCount: members.length || Number(row.member_count) || 0,
    members,
    name: text(row.name) || 'Room'
  }
}

export function normalizeRoomMessage(value: unknown): OperationsRoomMessage | null {
  const row = record(value)
  const body = text(row.text)

  if (!body.trim()) {
    return null
  }

  return {
    at: text(row.at),
    id: Number(row.id) || 0,
    kind: text(row.kind) || 'message',
    speaker: text(row.speaker) || 'owner',
    text: body
  }
}

export async function listRooms(): Promise<OperationsRoom[]> {
  const response = await operationsApi()<{ rooms?: unknown[] }>('/rooms')

  return (response.rooms ?? []).map(normalizeRoom).filter((room): room is OperationsRoom => Boolean(room))
}

export async function readRoom(roomId: string, limit = 100): Promise<OperationsRoomSnapshot> {
  const response = await operationsApi()<unknown>(`/rooms/${encodeURIComponent(roomId)}?limit=${limit}`)
  const row = record(response)
  const room = normalizeRoom(row.room)

  if (!room) {
    throw new Error('That room is no longer there.')
  }
  const transcript = Array.isArray(row.transcript) ? row.transcript : []

  return {
    room,
    transcript: transcript.map(normalizeRoomMessage).filter((entry): entry is OperationsRoomMessage => Boolean(entry))
  }
}

export async function createRoom(name: string): Promise<OperationsRoom> {
  const response = await operationsApi()<unknown>('/rooms', {
    method: 'POST',
    body: { confirm: true, name: name.trim() }
  })

  const room = normalizeRoom(record(response).room)

  if (!room) {
    throw new Error('The room did not come back with an identity.')
  }

  return room
}

export async function addRoomMember(roomId: string, agentId: string): Promise<void> {
  await operationsApi()(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(agentId)}`, {
    method: 'POST',
    body: { confirm: true }
  })
}

export async function removeRoomMember(roomId: string, agentId: string): Promise<void> {
  await operationsApi()(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(agentId)}?confirm=true`, {
    method: 'DELETE'
  })
}

export async function postRoomMessage(
  roomId: string,
  message: string,
  requestId: string = crypto.randomUUID()
): Promise<void> {
  await operationsApi()(`/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    body: { message: message.trim(), request_id: requestId }
  })
}

export async function handoffRoom(roomId: string, agentId: string): Promise<void> {
  await operationsApi()(`/rooms/${encodeURIComponent(roomId)}/handoff`, {
    method: 'POST',
    body: { agent_id: agentId, confirm: true }
  })
}

export async function runRoomTurn(
  roomId: string,
  agentId: string,
  message: string,
  requestId: string = crypto.randomUUID()
): Promise<void> {
  await operationsApi()(`/rooms/${encodeURIComponent(roomId)}/turns`, {
    method: 'POST',
    body: { agent_id: agentId, message: message.trim(), request_id: requestId }
  })
}

export function roomActorLabel(speaker: string, agents: Array<{ id: string; label: string }>): string {
  if (!speaker || speaker === 'owner') {
    return 'You'
  }

  return agents.find(agent => agent.id === speaker)?.label ?? speaker
}
