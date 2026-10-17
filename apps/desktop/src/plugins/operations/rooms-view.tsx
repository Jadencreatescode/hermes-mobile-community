import { Button } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  addRoomMember,
  createRoom,
  handoffRoom,
  listRooms,
  MAX_ROOM_MEMBERS,
  type OperationsRoom,
  type OperationsRoomMessage,
  postRoomMessage,
  readRoom,
  removeRoomMember,
  roomActorLabel,
  runRoomTurn
} from './rooms'

interface RoomAgent {
  id: string
  label: string
}

export function RoomsView({ agents }: { agents: RoomAgent[] }) {
  const [rooms, setRooms] = useState<OperationsRoom[]>([])
  const [room, setRoom] = useState<OperationsRoom | null>(null)
  const [transcript, setTranscript] = useState<OperationsRoomMessage[]>([])
  const [newName, setNewName] = useState('')
  const [member, setMember] = useState('')
  const [speaker, setSpeaker] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reloadRoom = useCallback(async (id: string) => {
    if (!id) {
      setRoom(null)
      setTranscript([])

      return
    }

    const snapshot = await readRoom(id)
    setRoom(snapshot.room)
    setTranscript(snapshot.transcript)
  }, [])

  const reload = useCallback(
    async (preferred = '') => {
      const listed = await listRooms()
      setRooms(listed)
      const id = listed.some(item => item.id === preferred) ? preferred : (listed[0]?.id ?? '')
      await reloadRoom(id)
    },
    [reloadRoom]
  )

  useEffect(() => {
    void reload().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [reload])

  const candidates = useMemo(() => agents.filter(agent => !room?.members.includes(agent.id)), [agents, room])

  const selectedSpeaker = room?.members.includes(speaker) ? speaker : (room?.members[0] ?? '')

  const act = async (work: () => Promise<void>) => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')

    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 md:flex-row">
      <aside className="shrink-0 md:w-64">
        <h2 className="font-semibold">Rooms</h2>
        <p className="text-xs text-(--ui-text-tertiary)">Up to six verified Bots, one durable conversation.</p>
        <div className="mt-3 flex gap-2">
          <input
            aria-label="New room"
            className="min-w-0 flex-1 border border-(--ui-stroke-tertiary) bg-transparent px-2"
            onChange={event => setNewName(event.target.value)}
            value={newName}
          />
          <Button
            disabled={busy || !newName.trim()}
            onClick={() =>
              void act(async () => {
                const created = await createRoom(newName)
                setNewName('')
                await reload(created.id)
              })
            }
            size="sm"
          >
            Open
          </Button>
        </div>
        <div aria-label="Rooms" className="mt-3 flex flex-col gap-1" role="list">
          {rooms.map(item => (
            <Button
              className="justify-start"
              key={item.id}
              onClick={() => void act(() => reloadRoom(item.id))}
              size="sm"
              variant={room?.id === item.id ? 'secondary' : 'ghost'}
            >
              {item.name} · {item.memberCount}/{MAX_ROOM_MEMBERS}
            </Button>
          ))}
        </div>
      </aside>

      <section aria-label="Multi-Bot room" className="min-w-0 flex-1">
        {room ? (
          <>
            <header>
              <h2 className="text-base font-semibold">{room.name}</h2>
              <p className="text-xs text-(--ui-text-tertiary)" role="status">
                Floor: {roomActorLabel(room.floor, agents)}
              </p>
            </header>
            <div className="mt-2 flex flex-wrap gap-2">
              {room.members.map(agentId => (
                <span className="border border-(--ui-stroke-tertiary) px-2 py-1 text-xs" key={agentId}>
                  {roomActorLabel(agentId, agents)}
                  <button
                    className="ml-2 underline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await handoffRoom(room.id, agentId)
                        await reloadRoom(room.id)
                      })
                    }
                    type="button"
                  >
                    hand off
                  </button>
                  <button
                    className="ml-2 underline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await removeRoomMember(room.id, agentId)
                        await reloadRoom(room.id)
                      })
                    }
                    type="button"
                  >
                    remove
                  </button>
                </span>
              ))}
            </div>
            {room.members.length < MAX_ROOM_MEMBERS ? (
              <div className="mt-2 flex gap-2">
                <select
                  aria-label="Invite a Bot"
                  className="border border-(--ui-stroke-tertiary) bg-transparent px-2"
                  onChange={event => setMember(event.target.value)}
                  value={member}
                >
                  <option value="">Choose a verified Bot</option>
                  {candidates.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.label}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={busy || !member}
                  onClick={() =>
                    void act(async () => {
                      await addRoomMember(room.id, member)
                      setMember('')
                      await reloadRoom(room.id)
                    })
                  }
                  size="sm"
                >
                  Invite
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-xs">This room is full at six Bots.</p>
            )}

            <ol aria-label="Room conversation" className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              {transcript.map(entry => (
                <li className={entry.kind === 'handoff' ? 'text-xs text-(--ui-text-tertiary)' : ''} key={entry.id}>
                  <strong className="text-xs">{roomActorLabel(entry.speaker, agents)}</strong>
                  <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                </li>
              ))}
            </ol>
            <textarea
              aria-label="Room message"
              className="mt-3 min-h-20 w-full border border-(--ui-stroke-tertiary) bg-transparent p-2"
              onChange={event => setDraft(event.target.value)}
              value={draft}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={busy || !draft.trim() || room.floor !== 'owner'}
                onClick={() =>
                  void act(async () => {
                    await postRoomMessage(room.id, draft)
                    setDraft('')
                    await reloadRoom(room.id)
                  })
                }
                size="sm"
              >
                Post
              </Button>
              <select
                aria-label="Ask a Bot"
                className="border border-(--ui-stroke-tertiary) bg-transparent px-2"
                onChange={event => setSpeaker(event.target.value)}
                value={selectedSpeaker}
              >
                {room.members.map(agentId => (
                  <option key={agentId} value={agentId}>
                    {roomActorLabel(agentId, agents)}
                  </option>
                ))}
              </select>
              <Button
                disabled={busy || !draft.trim() || !selectedSpeaker || room.floor !== selectedSpeaker}
                onClick={() =>
                  void act(async () => {
                    await runRoomTurn(room.id, selectedSpeaker, draft)
                    setDraft('')
                    await reloadRoom(room.id)
                  })
                }
                size="sm"
              >
                Ask this Bot
              </Button>
            </div>
          </>
        ) : (
          <p>No rooms yet.</p>
        )}
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  )
}
