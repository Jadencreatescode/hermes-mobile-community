import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'

import { getA2AChatHistory, sendA2AChatMessage, type A2AChatMessage, type HarnessAgent } from './data'

interface PendingConnectedTurn {
  agentId: string
  requestId: string
}

const OUTBOX_KEY = 'hermes.operations.connected-agent.outbox.v1'

function readPendingTurn(agentId: string): PendingConnectedTurn | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(OUTBOX_KEY) || 'null') as (PendingConnectedTurn & { message?: unknown }) | null

    if (value && 'message' in value) {
      window.localStorage.removeItem(OUTBOX_KEY)

      return null
    }

    return value?.agentId === agentId && value.requestId ? value : null
  } catch {
    return null
  }
}

function persistPendingTurn(turn: PendingConnectedTurn) {
  window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(turn))
}

function clearPendingTurn(turn: PendingConnectedTurn) {
  const current = readPendingTurn(turn.agentId)

  if (current?.requestId === turn.requestId) {
    window.localStorage.removeItem(OUTBOX_KEY)
  }
}

function AgentMetadata({ agent }: { agent: HarnessAgent }) {
  return (
    <p className="text-xs text-(--ui-text-tertiary)">
      {agent.status} {agent.capabilities.length > 0 ? `· ${agent.capabilities.join(', ')}` : ''}
    </p>
  )
}

export function ConnectedAgentChatSurface({
  agent,
  showHeader = true
}: {
  agent: HarnessAgent
  showHeader?: boolean
}) {
  const [messages, setMessages] = useState<A2AChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingRequestId, setPendingRequestId] = useState('')
  const [restored, setRestored] = useState(false)
  const canSend = agent.capabilities.includes('chat.send')

  const refresh = useCallback(async (requestId = '') => {
    const result = await getA2AChatHistory(agent.agentId, requestId)

    setMessages(result.messages)

    return result
  }, [agent.agentId])

  useEffect(() => {
    setDraft('')
    setError('')
    setLoading(true)
    void refresh()
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false))
  }, [refresh])

  useEffect(() => {
    if (restored || loading || busy) {return}
    setRestored(true)
    const pending = readPendingTurn(agent.agentId)

    if (!pending) {return}
    setPendingRequestId(pending.requestId)
    void refresh(pending.requestId).then(result => {
      if (result.request_status === 'committed') {
        clearPendingTurn(pending)
        setPendingRequestId('')
      }
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [agent.agentId, busy, loading, refresh, restored])

  const send = async () => {
    const message = draft.trim()

    if (!canSend || !message || busy) {return}

    setBusy(true)
    setError('')

    try {
      const requestId = pendingRequestId || crypto.randomUUID()
      setPendingRequestId(requestId)

      const pending = {
        agentId: agent.agentId,
        requestId
      }

      persistPendingTurn(pending)
      await sendA2AChatMessage(agent.agentId, message, requestId)
      const mirrored = await refresh(requestId)

      if (mirrored.request_status === 'committed') {
        clearPendingTurn(pending)
        setPendingRequestId('')
        setDraft('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-(--ui-bg-primary) ${showHeader ? 'h-full' : ''}`}>
      {showHeader ? (
        <header className="shrink-0 border-b border-(--ui-stroke-tertiary) px-4 py-3">
          <h2 className="truncate text-sm font-semibold text-(--ui-text-primary)">{agent.name || agent.agentId}</h2>
          <AgentMetadata agent={agent} />
        </header>
      ) : null}

      <section
        aria-label={`${agent.name || agent.agentId} conversation`}
        className="flex min-h-48 flex-1 flex-col gap-3 overflow-y-auto bg-(--ui-chat-surface-background) p-3 sm:p-4"
      >
        {loading ? <p className="text-sm text-(--ui-text-tertiary)">Loading mirrored conversation…</p> : null}
        {!loading && !messages.length ? (
          <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-(--ui-stroke-tertiary) p-4 text-center">
            <div>
              <Codicon className="text-xl text-(--ui-accent)" name="comment-discussion" />
              <p className="mt-2 text-sm font-medium text-(--ui-text-primary)">Start the connected agent conversation</p>
              <p className="mt-1 text-xs text-(--ui-text-tertiary)">Messages stay attached to this agent’s native harness context.</p>
            </div>
          </div>
        ) : null}
        {messages.map((message, index) => (
          <article
            className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-6 ${message.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'mr-auto border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary) text-(--ui-text-primary)'}`}
            key={`${message.role}-${index}`}
          >
            <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide opacity-70">
              {message.role === 'user' ? 'You' : agent.name || agent.agentId}
            </p>
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </article>
        ))}
      </section>

      <form
        className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) p-3"
        onSubmit={event => {
          event.preventDefault()
          void send()
        }}
      >
        {!canSend ? (
          <p className="mb-2 text-xs text-(--ui-text-tertiary)">This connector did not advertise chat.send.</p>
        ) : null}
        {error ? <p className="mb-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex min-w-0 items-end gap-2">
          <textarea
            aria-label={`Message ${agent.name || agent.agentId}`}
            className="max-h-40 min-h-12 min-w-0 flex-1 resize-y rounded-xl border border-(--ui-stroke-tertiary) bg-transparent px-3 py-2 text-sm outline-none placeholder:text-(--ui-text-secondary) focus:border-(--ui-accent)"
            disabled={!canSend || busy}
            onChange={event => setDraft(event.target.value)}
            placeholder={canSend ? `Message ${agent.name || agent.agentId}` : 'Read only connector'}
            value={draft}
          />
          <Button
            aria-label={`Send to ${agent.name || agent.agentId}`}
            className="min-h-12 min-w-12 shrink-0"
            disabled={!canSend || busy || !draft.trim()}
            type="submit"
          >
            <Codicon className={busy ? 'animate-spin' : ''} name={busy ? 'loading' : 'send'} />
            <span className="hidden sm:inline">Send</span>
          </Button>
        </div>
      </form>
    </div>
  )
}

export function ConnectedAgentChat({
  agent,
  onClose
}: {
  agent: HarnessAgent
  onClose: () => void
}) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="shrink-0 border-b border-(--ui-stroke-tertiary) px-4 py-3">
          <DialogTitle>{agent.name || agent.agentId}</DialogTitle>
          <AgentMetadata agent={agent} />
        </DialogHeader>
        <ConnectedAgentChatSurface agent={agent} showHeader={false} />
      </DialogContent>
    </Dialog>
  )
}
