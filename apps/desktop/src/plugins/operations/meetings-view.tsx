import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  host,
  Input,
  Textarea
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { OperationsAgentModel, OperationsSnapshot } from './data'
import {
  freezeProductionBrief,
  getMeetingOutput,
  listMeetingOutputs,
  type MeetingOutputDetail,
  type MeetingOutputSummary,
  PRODUCT_KINDS
} from './deliverable-package'
import { DeliverablePackageOutput } from './deliverable-package-output'
import {
  producerDispatchEligibility,
  runProductionDeliverable,
  runReviewDispatch,
  runRevisionDeliverable
} from './deliverable-package-output-runner'
import { MeetingRoom } from './meeting-room'
import {
  convertMeetingActions,
  createMeetingDraft,
  getMeetingParticipantConversation,
  injectMeetingParticipantPrompt,
  isMeetingRoundRunFresh,
  isProductionMeeting,
  listMeetings,
  type MeetingConversationSnapshot,
  type MeetingRecord,
  persistMeetingTransition,
  putMeeting,
  type RouteIdentity,
  runMeetingRound,
  type SeatAssignment
} from './meetings'

function routeKey(route: { connectionId: string; profile: string }): string {
  return `${route.connectionId}::${route.profile}`
}

function participantDisplayName(
  agents: OperationsAgentModel[],
  participant: MeetingRecord['participants'][number]
): string {
  return (
    agents.find(agent => agent.sourceId === participant.connectionId && agent.profile === participant.profile)
      ?.displayName ?? participant.profile
  )
}

// Seat roles a production meeting may assign. Seats are a bijection onto the
// participants, and at least one reviewer must differ from the orchestrator
// and the producer.
const SEAT_ROLE_OPTIONS = ['contributor', 'thinker', 'specialist', 'reviewer'] as const
type MeetingKind = 'conclusion' | 'production'

// health: allow CC FUNC_LINES -- retained production meeting workflow is security reviewed; preserve its established orchestration during migration
export function MeetingsView({
  createRequested = false,
  onCreateRequestHandled,
  onOpenAgent,
  snapshot
}: {
  createRequested?: boolean
  onCreateRequestHandled?: () => void
  onOpenAgent?: (agent: OperationsAgentModel) => void
  snapshot: OperationsSnapshot
}) {
  const options = useMemo(
    () =>
      snapshot.agents
        .filter(
          agent =>
            agent.sourceKind === 'local' ||
            agent.sourceKind === 'remote' ||
            (agent.sourceKind === 'a2a' && agent.sourceId === 'a2a' && agent.state === 'idle')
        )
        .map(agent => ({
          connectionId: agent.sourceId,
          profile: agent.profile,
          label: `${agent.displayName} · ${agent.sourceLabel}`
        })),
    [snapshot.agents]
  )

  const [meetings, setMeetings] = useState<Array<{ meeting: MeetingRecord; version: number }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [title, setTitle] = useState('')
  const [agenda, setAgenda] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [decision, setDecision] = useState('')
  const [dissent, setDissent] = useState('')
  const [actionTitle, setActionTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [meetingKind, setMeetingKind] = useState<MeetingKind | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const [conversationParticipant, setConversationParticipant] = useState<MeetingRecord['participants'][number] | null>(
    null
  )
  const [conversationSnapshot, setConversationSnapshot] = useState<MeetingConversationSnapshot | null>(null)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [conversationPrompt, setConversationPrompt] = useState('')
  const [conversationSending, setConversationSending] = useState(false)
  const [conversationSendError, setConversationSendError] = useState('')
  const conversationGeneration = useRef(0)

  const [activeParticipant, setActiveParticipant] = useState<{
    meetingId: string
    participant: MeetingRecord['participants'][number]
  } | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // C3: seat role assignments per participant key during creation.
  const [seatRoles, setSeatRoles] = useState<Record<string, (typeof SEAT_ROLE_OPTIONS)[number]>>({})
  const [seatLabels, setSeatLabels] = useState<Record<string, string>>({})

  // C1: orchestrator/producer designation during creation.
  const [orchestratorKey, setOrchestratorKey] = useState('')
  const [producerKey, setProducerKey] = useState('')

  // Production brief fields collected at creation. There is deliberately no
  // hash, approver, stage, or binding input anywhere in this view: all four
  // are server owned.
  const [productKind, setProductKind] = useState<string>('')
  const [outputTitle, setOutputTitle] = useState('')
  const [acceptanceStatement, setAcceptanceStatement] = useState('')
  const [brief, setBrief] = useState('')
  const [outputs, setOutputs] = useState<MeetingOutputSummary[]>([])
  const [outputDetail, setOutputDetail] = useState<MeetingOutputDetail | null>(null)
  const [producing, setProducing] = useState(false)
  const [produceNotice, setProduceNotice] = useState('')

  useEffect(() => {
    if (!createRequested) {
      return
    }
    setError('')
    setMeetingKind(null)
    setCreating(true)
    onCreateRequestHandled?.()
  }, [createRequested, onCreateRequestHandled])

  const selected = meetings.find(item => item.meeting.id === selectedId) ?? null
  const durableRoundInProgress = Boolean(selected && isMeetingRoundRunFresh(selected.meeting))

  const localActiveParticipant =
    activeParticipant && activeParticipant.meetingId === selected?.meeting.id ? activeParticipant.participant : null

  const thinkingParticipant =
    localActiveParticipant ?? (durableRoundInProgress ? (selected?.meeting.roundRun?.participant ?? null) : null)

  const roundInProgress = Boolean(localActiveParticipant || durableRoundInProgress)

  // Produce is offered from the STAGE, not from the output list: the first run
  // is exactly the case where no output exists yet. An in-flight run keeps the
  // control mounted so a reload can resume it instead of starting a second one.
  const productionStage =
    selected && isProductionMeeting(selected.meeting) ? (selected.meeting.productionStage ?? '') : ''

  const produceOffered = productionStage === 'production_ready' || outputs.some(detail => detail.eligibility.produce)

  const connectionModes = useMemo(
    () =>
      Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>,
    [snapshot.sources]
  )

  const producerEligibility = useMemo(
    () =>
      selected && isProductionMeeting(selected.meeting)
        ? producerDispatchEligibility(selected.meeting, connectionModes, snapshot.agents)
        : { eligible: false, reason: '' },
    [connectionModes, selected, snapshot.agents]
  )

  const refresh = useCallback(async () => {
    try {
      const next = await listMeetings()
      setMeetings(next)
      setSelectedId(current => current || next[0]?.meeting.id || '')
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => void refresh(), [refresh])

  // Output lifecycle state is server truth refreshed through the existing
  // Operations REST path; it is never a second source of truth in the view.
  const refreshOutputs = useCallback(async (meetingId: string) => {
    if (!meetingId) {
      setOutputs([])
      setOutputDetail(null)

      return
    }

    try {
      const listed = await listMeetingOutputs(meetingId)

      setOutputs(listed)
      // The list route answers with a SUMMARY: the output row plus the
      // server's eligibility flags, and nothing else. The panel renders
      // versions, reviews, and lineage, so the selected output's full detail
      // is fetched explicitly rather than assumed to be in the list.
      setOutputDetail(listed.length ? await getMeetingOutput(listed[0].output.outputId) : null)
    } catch {
      // A missing or unreadable output list must not blank the room.
      setOutputs([])
      setOutputDetail(null)
    }
  }, [])

  useEffect(() => {
    if (!selected || !isProductionMeeting(selected.meeting)) {
      setOutputs([])
      setOutputDetail(null)

      return
    }

    void refreshOutputs(selected.meeting.id)
  }, [refreshOutputs, selected])

  useEffect(() => {
    if (!selected || !conversationParticipant) {
      return
    }

    const generation = ++conversationGeneration.current
    setConversationSnapshot(null)
    setConversationError('')

    const load = () => {
      setConversationLoading(true)
      void getMeetingParticipantConversation(
        host,
        selected.meeting,
        conversationParticipant,
        connectionModes,
        snapshot.agents
      )
        .then(result => {
          if (generation !== conversationGeneration.current) {
            return
          }
          setConversationSnapshot(result)
          setConversationError('')
        })
        .catch(cause => {
          if (generation !== conversationGeneration.current) {
            return
          }
          setConversationError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (generation !== conversationGeneration.current) {
            return
          }
          setConversationLoading(false)
        })
    }

    load()
    const poll = window.setInterval(load, 2_500)

    return () => {
      ++conversationGeneration.current
      window.clearInterval(poll)
    }
  }, [connectionModes, conversationParticipant, selected, snapshot.agents])

  // health: allow CC -- retained meeting creation validation is migration scoped and contract tested
  const create = async () => {
    const routes = options.filter(option => selectedParticipants.includes(routeKey(option)))

    if (!title.trim() || !agenda.trim() || routes.length < 2 || routes.length > 6) {
      setError('Add a title, an agenda, and two to six source-qualified participants.')

      return
    }

    if (!meetingKind) {
      setError('Choose Production or Conclusion for this meeting.')

      return
    }

    // The operator chooses the meeting contract explicitly. Production fields
    // are required only for Production and ignored for Conclusion.
    const hasOrchestrator = Boolean(orchestratorKey)
    const hasProducer = Boolean(producerKey)
    const wantsProduction = meetingKind === 'production'

    if (wantsProduction) {
      if (!hasOrchestrator || !hasProducer) {
        setError('A production meeting needs both an orchestrator and a producer.')

        return
      }

      if (orchestratorKey === producerKey) {
        setError('Orchestrator and producer must be different participants.')

        return
      }

      if (routes.length < 3) {
        setError('A production meeting needs at least three participants.')

        return
      }

      if (!productKind || !outputTitle.trim() || !acceptanceStatement.trim()) {
        setError('A production meeting needs a product kind, an output title, and an acceptance statement.')

        return
      }

      const seated = routes.filter(route => seatRoles[routeKey(route)])

      if (seated.length !== routes.length) {
        setError('Give every participant exactly one seat role.')

        return
      }

      const reviewers = routes.filter(
        route =>
          seatRoles[routeKey(route)] === 'reviewer' &&
          routeKey(route) !== orchestratorKey &&
          routeKey(route) !== producerKey
      )

      if (!reviewers.length) {
        setError('A production meeting needs a reviewer seat that is neither the orchestrator nor the producer.')

        return
      }
    }

    setBusy(true)

    try {
      const orchestratorRoute = hasOrchestrator ? routes.find(r => routeKey(r) === orchestratorKey) : undefined

      const producerRoute = hasProducer ? routes.find(r => routeKey(r) === producerKey) : undefined

      // C3: build seat assignments from per-participant role/label state.
      const seats: Array<{ bot: RouteIdentity; role: string; label: string }> = routes
        .filter(r => seatRoles[routeKey(r)])
        .map(r => {
          const key = routeKey(r)

          return {
            bot: r,
            role: seatRoles[key],
            label: (seatLabels[key] ?? '').trim() || r.profile
          }
        })

      const draft = createMeetingDraft({
        agenda: agenda.trim(),
        chair: routes[0],
        id: `meeting-${Date.now().toString(36)}`,
        maxRounds: 3,
        participants: routes,
        source: routes[0],
        title: title.trim(),
        ...(wantsProduction && orchestratorRoute && producerRoute
          ? {
              acceptanceStatement: acceptanceStatement.trim(),
              orchestrator: orchestratorRoute,
              outputTitle: outputTitle.trim(),
              producer: producerRoute,
              productKind,
              seats
            }
          : {})
      })

      const saved = await putMeeting(draft, 0)

      setMeetings(current => [saved, ...current])
      setSelectedId(saved.meeting.id)
      setTitle('')
      setAgenda('')
      setSelectedParticipants([])
      setSeatRoles({})
      setSeatLabels({})
      setMeetingKind(null)
      setOrchestratorKey('')
      setProducerKey('')
      setProductKind('')
      setOutputTitle('')
      setAcceptanceStatement('')
      setCreating(false)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const transition = async (kind: 'start' | 'resume' | 'cancel' | 'conclude') => {
    if (!selected) {
      return
    }
    setBusy(true)

    try {
      let payload: Record<string, unknown> | undefined

      if (kind === 'conclude') {
        payload = {
          chair: selected.meeting.chair,
          decisions: decision.trim()
            ? [{ id: `decision-${Date.now().toString(36)}`, text: decision.trim(), evidenceRefs: [] }]
            : [],
          dissent:
            dissent.trim() && selected.meeting.participants[1]
              ? [{ participant: selected.meeting.participants[1], text: dissent.trim(), evidenceRefs: [] }]
              : [],
          actionItems: actionTitle.trim()
            ? [
                {
                  id: `action-${Date.now().toString(36)}`,
                  ownerRoute: selected.meeting.participants[0],
                  title: actionTitle.trim(),
                  acceptanceCriteria: 'Verify the completed result.',
                  priority: 'normal',
                  dueIntent: 'Next operations checkpoint'
                }
              ]
            : []
        }

        // A production meeting never concludes here. It completes only through
        // the exact owner approval transaction in the output panel.
        if (isProductionMeeting(selected.meeting)) {
          setError('A production meeting completes through artifact approval, not the conclude form.')
          setBusy(false)

          return
        }
      }

      const saved = await persistMeetingTransition(selected.meeting, selected.version, kind, payload)

      setMeetings(current => current.map(item => (item.meeting.id === selected.meeting.id ? saved : item)))
      setError(saved.conflict ? 'The durable meeting changed elsewhere. The latest version was loaded.' : '')

      if (kind === 'conclude') {
        setDetailsOpen(false)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const freezeBrief = async () => {
    if (!selected || !isProductionMeeting(selected.meeting)) {
      return
    }

    const text = brief.trim()

    if (!text) {
      setError('Write the production brief the producer will work from.')

      return
    }

    setBusy(true)

    try {
      await freezeProductionBrief({
        brief: text,
        evidenceRefs: selected.meeting.evidenceRefs.slice(0, 32),
        expectedVersion: selected.version,
        meetingId: selected.meeting.id,
        idempotencyKey: `brief-${selected.meeting.id}-${selected.version}`
      })
      setBrief('')
      setError('')
      await refresh()
      await refreshOutputs(selected.meeting.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // The production run. Everything load-bearing is server-owned: the
  // workspace, the collection claim, and the stage. The renderer only
  // dispatches the producer Bot into the workspace the server minted, then
  // asks for collection.
  const produce = async () => {
    if (!selected || !isProductionMeeting(selected.meeting)) {
      return
    }

    const eligibility = producerDispatchEligibility(selected.meeting, connectionModes, snapshot.agents)

    if (!eligibility.eligible) {
      setError(eligibility.reason)

      return
    }

    const meetingId = selected.meeting.id
    setProducing(true)
    setProduceNotice('')
    setError('')

    try {
      const result = await runProductionDeliverable({
        agents: snapshot.agents,
        connectionModes,
        host,
        meeting: selected.meeting,
        meetingVersion: selected.version,
        onStage: setProduceNotice,
        ...(outputs[0] ? { output: outputs[0].output } : {})
      })

      setProduceNotice(result.message)
      await refresh()
      await refreshOutputs(meetingId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProducing(false)
    }
  }

  const revise = async (detail: MeetingOutputDetail) => {
    if (!selected || !isProductionMeeting(selected.meeting)) {
      throw new Error('This meeting has no deliverable to revise.')
    }

    const eligibility = producerDispatchEligibility(selected.meeting, connectionModes, snapshot.agents)

    if (!eligibility.eligible) {
      throw new Error(eligibility.reason)
    }

    const result = await runRevisionDeliverable({
      agents: snapshot.agents,
      connectionModes,
      findings: detail.output.findings,
      host,
      meeting: selected.meeting,
      meetingVersion: selected.version,
      outputId: detail.output.outputId
    })

    return result.message
  }

  const review = async (detail: MeetingOutputDetail) => {
    if (!selected || !isProductionMeeting(selected.meeting)) {
      throw new Error('This meeting has no deliverable to review.')
    }

    const result = await runReviewDispatch({
      agents: snapshot.agents,
      connectionModes,
      detail,
      host,
      meeting: selected.meeting,
      meetingVersion: selected.version
    })

    return result.message
  }

  const runRound = async () => {
    if (!selected) {
      return
    }
    const runningMeetingId = selected.meeting.id
    setBusy(true)

    try {
      const saved = await runMeetingRound(host, selected.meeting, selected.version, connectionModes, {
        agents: snapshot.agents,
        onParticipantStart: participant => {
          setActiveParticipant({ meetingId: runningMeetingId, participant })
        },
        onProgress: progress => {
          setMeetings(current => current.map(item => (item.meeting.id === runningMeetingId ? progress : item)))
        }
      })

      setMeetings(current => current.map(item => (item.meeting.id === runningMeetingId ? saved : item)))
      setActiveParticipant(current => (current?.meetingId === runningMeetingId ? null : current))
      setError(saved.pending ? 'A participant is waiting for your input in its Bot session.' : '')
    } catch (cause) {
      setActiveParticipant(current => (current?.meetingId === runningMeetingId ? null : current))
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const convertActions = async () => {
    if (!selected || selected.meeting.state !== 'completed') {
      return
    }
    setBusy(true)

    try {
      const modes = Object.fromEntries(
        snapshot.sources.map(source => [source.id, source.kind === 'local' ? 'local' : 'remote'])
      ) as Record<string, 'local' | 'remote'>

      await convertMeetingActions(host, selected.meeting, modes)
      host.notify({ kind: 'success', message: 'Meeting action items added to Kanban' })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openConversation = (participant: MeetingRecord['participants'][number]) => {
    ++conversationGeneration.current
    setConversationsOpen(false)
    setConversationSnapshot(null)
    setConversationLoading(true)
    setConversationError('')
    setConversationPrompt('')
    setConversationSending(false)
    setConversationSendError('')
    setConversationParticipant(participant)
  }

  const sendConversationPrompt = async () => {
    const prompt = conversationPrompt.trim()

    if (!selected || !conversationParticipant || !prompt || conversationSending) {
      return
    }

    const generation = conversationGeneration.current
    setConversationSending(true)

    try {
      const result = await injectMeetingParticipantPrompt(
        host,
        selected.meeting,
        conversationParticipant,
        connectionModes,
        prompt,
        snapshot.agents,
        crypto.randomUUID()
      )

      if (generation !== conversationGeneration.current) {
        return
      }
      setConversationSnapshot(result)
      setConversationPrompt('')
      setConversationSendError('')
    } catch (cause) {
      if (generation !== conversationGeneration.current) {
        return
      }
      setConversationSendError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === conversationGeneration.current) {
        setConversationSending(false)
      }
    }
  }

  return (
    <div className="min-w-0 space-y-3 text-white" data-testid="meetings-room-view">
      <header className="flex min-w-0 items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-cyan-300">Live council chamber</p>
          <h2 className="truncate text-lg font-semibold text-white">{selected?.meeting.title || 'Meeting room'}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected ? (
            <Button
              aria-label="Meeting details"
              className="min-h-11 min-w-11 rounded-full border-white/20 bg-white/5 px-0 text-white hover:bg-white/10"
              onClick={() => setDetailsOpen(true)}
              variant="outline"
            >
              <Codicon name="info" />
              <span className="sr-only">Meeting details</span>
            </Button>
          ) : null}
          <Button
            aria-label="New meeting"
            className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-0 text-slate-950 hover:bg-cyan-200"
            onClick={() => {
              setError('')
              setMeetingKind(null)
              setCreating(true)
            }}
          >
            <Codicon name="add" />
            <span className="sr-only">New meeting</span>
          </Button>
        </div>
      </header>

      {meetings.length ? (
        <nav
          aria-label="Meeting rooms"
          className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {meetings.map(item => (
            <button
              aria-current={item.meeting.id === selectedId ? 'page' : undefined}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3 text-xs transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${item.meeting.id === selectedId ? 'bg-cyan-300 text-slate-950' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}
              key={item.meeting.id}
              onClick={() => {
                ++conversationGeneration.current
                setSelectedId(item.meeting.id)
              }}
              type="button"
            >
              <Codicon name="organization" />
              <span>{item.meeting.title}</span>
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${item.meeting.state === 'running' ? 'bg-cyan-300' : item.meeting.state === 'waiting' ? 'bg-amber-300' : item.meeting.state === 'completed' ? 'bg-emerald-300' : 'bg-slate-400'}`}
              />
            </button>
          ))}
        </nav>
      ) : null}

      {selected ? (
        <>
          <MeetingRoom
            agents={snapshot.agents}
            meeting={selected.meeting}
            onCreateTasks={() => void convertActions()}
            onOpenAgent={onOpenAgent}
            onOpenConversation={openConversation}
            onOpenConversations={() => setConversationsOpen(true)}
            onOpenDetails={() => setDetailsOpen(true)}
            output={
              outputDetail ? (
                <DeliverablePackageOutput
                  detail={outputDetail}
                  meeting={selected.meeting}
                  meetingVersion={selected.version}
                  onChanged={async () => {
                    await refresh()
                    await refreshOutputs(selected.meeting.id)
                  }}
                  onReview={() => review(outputDetail)}
                  onRevise={() => revise(outputDetail)}
                />
              ) : null
            }
            thinkingParticipant={thinkingParticipant}
          />
          {roundInProgress ? (
            <span className="sr-only" role="status">
              Meeting round in progress
            </span>
          ) : null}
          <div
            aria-label="Meeting controls"
            className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-white/10 bg-black/35 p-2 shadow-[0_12px_34px_rgba(0,0,0,.28)] backdrop-blur-md"
          >
            {selected.meeting.state === 'draft' ? (
              <Button
                aria-label="Start meeting"
                className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                disabled={busy}
                onClick={() => void transition('start')}
              >
                <Codicon name="play" />
                <span className="hidden sm:inline">Start</span>
              </Button>
            ) : null}
            {selected.meeting.state === 'running' ? (
              <Button
                aria-label="Run meeting round"
                className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                disabled={busy || durableRoundInProgress}
                onClick={() => void runRound()}
              >
                <Codicon name="sync" />
                <span className="hidden sm:inline">Run round</span>
              </Button>
            ) : null}
            {selected.meeting.state === 'waiting' ? (
              <Button
                aria-label="Resume meeting"
                className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                disabled={busy}
                onClick={() => void runRound()}
              >
                <Codicon name="debug-continue" />
                <span className="hidden sm:inline">Resume</span>
              </Button>
            ) : null}
            {['draft', 'running', 'waiting'].includes(selected.meeting.state) ? (
              <Button
                aria-label="Cancel meeting"
                className="min-h-11 min-w-11 rounded-full border-white/20 bg-white/5 px-3 text-white hover:bg-white/10"
                disabled={busy}
                onClick={() => void transition('cancel')}
                variant="outline"
              >
                <Codicon name="close" />
                <span className="sr-only">Cancel meeting</span>
              </Button>
            ) : null}
            {isProductionMeeting(selected.meeting) &&
            ['briefing', 'working'].includes(selected.meeting.productionStage ?? '') ? (
              <>
                <input
                  aria-label="Production brief"
                  className="min-h-11 min-w-0 max-w-64 flex-1 rounded-full border border-white/20 bg-black/40 px-3 text-xs text-white"
                  maxLength={8_000}
                  onChange={event => setBrief(event.currentTarget.value)}
                  placeholder="Production brief"
                  value={brief}
                />
                <Button
                  aria-label="Freeze the production brief"
                  className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                  disabled={busy}
                  onClick={() => void freezeBrief()}
                >
                  <Codicon name="lock" />
                  <span className="hidden sm:inline">Freeze brief</span>
                </Button>
              </>
            ) : null}
            {produceOffered ? (
              producerEligibility.eligible ? (
                <Button
                  aria-label="Produce the deliverable"
                  className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                  disabled={busy || producing}
                  onClick={() => void produce()}
                >
                  <Codicon name="rocket" />
                  <span className="hidden sm:inline">{producing ? 'Producing…' : 'Produce'}</span>
                </Button>
              ) : (
                <p
                  className="max-w-80 px-2 text-[0.7rem] leading-4 text-amber-200"
                  data-testid="producer-ineligible"
                  role="status"
                >
                  {producerEligibility.reason}
                </p>
              )
            ) : null}
            {selected.meeting.state === 'completed' && selected.meeting.actionItems.length ? (
              <Button
                aria-label="Create Kanban cards"
                className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-slate-950 hover:bg-cyan-200"
                disabled={busy}
                onClick={() => void convertActions()}
              >
                <Codicon name="project" />
                <span className="hidden sm:inline">Create tasks</span>
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="grid min-h-[28rem] place-items-center overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_50%_20%,rgba(34,211,238,.12),transparent_45%),linear-gradient(to_bottom,#07111e,#020617)] p-6 text-center">
          <div>
            <Codicon className="text-5xl text-cyan-200/70" name="organization" />
            <p className="mt-3 text-sm font-medium text-(--ui-text-primary)">The council chamber is empty</p>
            <Button
              className="mt-4 min-h-11 rounded-full"
              onClick={() => {
                setError('')
                setMeetingKind(null)
                setCreating(true)
              }}
            >
              <Codicon name="add" /> Set the table
            </Button>
          </div>
        </div>
      )}

      <Dialog onOpenChange={setConversationsOpen} open={conversationsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Meeting conversations</DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">
              Choose a participant to view or direct their meeting conversation.
            </p>
          </DialogHeader>
          <div className="space-y-1">
            {selected?.meeting.participants.map((participant, index) => {
              const displayName = participantDisplayName(snapshot.agents, participant)
              const participantKey = routeKey(participant)
              const ready = Boolean(selected.meeting.runnerSessions?.[participantKey])

              return (
                <Button
                  aria-label={`Open ${displayName} meeting conversation`}
                  className="w-full justify-between"
                  key={participantKey}
                  onClick={() => openConversation(participant)}
                  variant="ghost"
                >
                  <span className="min-w-0 text-left">
                    <span className="block truncate">{displayName}</span>
                    <span className="block truncate text-xs text-(--ui-text-tertiary)">
                      {participantKey} · {ready ? 'Conversation ready' : 'No meeting turn yet'}
                    </span>
                  </span>
                  {index === 0 ? (
                    <span className="shrink-0 rounded-full bg-amber-300/10 px-2 py-1 text-[0.65rem] font-semibold text-amber-200">
                      Chair
                    </span>
                  ) : null}
                </Button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={open => {
          if (!open) {
            ++conversationGeneration.current
            setConversationParticipant(null)
          }
        }}
        open={conversationParticipant !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {conversationParticipant
                ? participantDisplayName(snapshot.agents, conversationParticipant)
                : 'Meeting conversation'}
            </DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">
              Messages from this participant's meeting turn. Prompts run only in this meeting context.
            </p>
          </DialogHeader>
          {conversationLoading && !conversationSnapshot ? (
            <p className="text-sm text-(--ui-text-tertiary)" role="status">
              Loading meeting messages…
            </p>
          ) : null}
          {conversationSnapshot ? (
            <div className="space-y-3">
              <p className="text-sm text-(--ui-text-secondary)" role="status">
                {
                  {
                    'not-started': 'Not started',
                    ready: 'Ready',
                    waiting: 'Waiting',
                    working: 'Working'
                  }[conversationSnapshot.status]
                }
              </p>
              {conversationSnapshot.messages.length ? (
                conversationSnapshot.messages.map((message, index) => (
                  <article className="rounded-lg border border-(--ui-stroke-tertiary) p-3" key={index}>
                    <p className="text-xs font-semibold text-(--ui-text-tertiary)">
                      {message.role === 'user'
                        ? 'You'
                        : conversationParticipant
                          ? participantDisplayName(snapshot.agents, conversationParticipant)
                          : ''}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-(--ui-text-secondary)">{message.content}</p>
                  </article>
                ))
              ) : (
                <p className="text-sm text-(--ui-text-tertiary)">
                  {conversationSnapshot.status === 'not-started'
                    ? 'This Bot has not started its meeting turn yet.'
                    : 'No meeting messages yet.'}
                </p>
              )}
            </div>
          ) : null}
          {conversationError ? (
            <p className="text-sm text-destructive" role="alert">
              {conversationError}
            </p>
          ) : null}
          {selected && conversationParticipant && ['running', 'waiting'].includes(selected.meeting.state) ? (
            <div className="space-y-2 border-t border-(--ui-stroke-tertiary) pt-3">
              <Textarea
                aria-label={`Message ${participantDisplayName(snapshot.agents, conversationParticipant)} in this meeting`}
                maxLength={8_000}
                onChange={event => setConversationPrompt(event.currentTarget.value)}
                rows={3}
                value={conversationPrompt}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs tabular-nums text-(--ui-text-tertiary)">{conversationPrompt.length} / 8000</p>
                <Button
                  disabled={!conversationPrompt.trim() || conversationSending || conversationLoading}
                  onClick={() => void sendConversationPrompt()}
                >
                  Send meeting prompt
                </Button>
              </div>
              {conversationSendError ? (
                <p className="text-sm text-destructive" role="alert">
                  {conversationSendError}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Create-meeting dialog ── */}
      <Dialog
        onOpenChange={(open: boolean) => {
          setCreating(open)

          if (open) {
            setError('')
          }
        }}
        open={creating}
      >
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>Make a Meeting</DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">
              Choose whether the Bots should create a concrete output or reach a conclusion.
            </p>
          </DialogHeader>
          <div className="space-y-3">
            <fieldset aria-label="Meeting type" className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                Meeting type
              </legend>
              <Button
                aria-describedby="meeting-type-production-description"
                aria-labelledby="meeting-type-production-label"
                aria-pressed={meetingKind === 'production'}
                className="h-auto min-h-20 flex-col items-start gap-1 whitespace-normal px-3 py-3 text-left"
                onClick={() => {
                  setError('')
                  setMeetingKind('production')
                }}
                variant={meetingKind === 'production' ? 'secondary' : 'outline'}
              >
                <span className="font-semibold" id="meeting-type-production-label">
                  Production
                </span>
                <span
                  className="text-xs font-normal text-(--ui-text-secondary)"
                  id="meeting-type-production-description"
                >
                  Create code, an app, a document, or another reviewable output.
                </span>
              </Button>
              <Button
                aria-describedby="meeting-type-conclusion-description"
                aria-labelledby="meeting-type-conclusion-label"
                aria-pressed={meetingKind === 'conclusion'}
                className="h-auto min-h-20 flex-col items-start gap-1 whitespace-normal px-3 py-3 text-left"
                onClick={() => {
                  setError('')
                  setMeetingKind('conclusion')
                  setOrchestratorKey('')
                  setProducerKey('')
                  setSeatRoles({})
                  setSeatLabels({})
                }}
                variant={meetingKind === 'conclusion' ? 'secondary' : 'outline'}
              >
                <span className="font-semibold" id="meeting-type-conclusion-label">
                  Conclusion
                </span>
                <span
                  className="text-xs font-normal text-(--ui-text-secondary)"
                  id="meeting-type-conclusion-description"
                >
                  Discuss the question, reach a conclusion, and record decisions or actions.
                </span>
              </Button>
            </fieldset>
            <Input
              aria-label="Meeting title"
              className="min-h-11"
              onChange={event => setTitle(event.currentTarget.value)}
              placeholder="Meeting title"
              value={title}
            />
            <textarea
              aria-label="Meeting agenda"
              className="min-h-28 w-full resize-y rounded-lg border border-(--ui-stroke-tertiary) bg-transparent p-3 text-sm"
              onChange={event => setAgenda(event.currentTarget.value)}
              placeholder="Agenda and decision required"
              value={agenda}
            />

            {/* Participant checkboxes with per-seat role/label (C3) */}
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                Choose Bot seats
              </legend>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-(--ui-stroke-tertiary) p-2">
                {options.map(option => {
                  const key = routeKey(option)
                  const checked = selectedParticipants.includes(key)

                  return (
                    <div className="space-y-1.5 rounded-lg px-2 py-1.5 hover:bg-(--ui-bg-hover)" key={key}>
                      <label className="flex min-h-11 items-center gap-3 text-sm">
                        <input
                          checked={checked}
                          onChange={event => {
                            setSelectedParticipants(current =>
                              event.target.checked ? [...current, key] : current.filter(value => value !== key)
                            )

                            if (!event.target.checked) {
                              setSeatRoles(current => {
                                const next = { ...current }
                                delete next[key]

                                return next
                              })
                              setSeatLabels(current => {
                                const next = { ...current }
                                delete next[key]

                                return next
                              })

                              if (orchestratorKey === key) {
                                setOrchestratorKey('')
                              }

                              if (producerKey === key) {
                                setProducerKey('')
                              }
                            }
                          }}
                          type="checkbox"
                        />
                        <span>{option.label}</span>
                      </label>
                      {/* C3: role/label controls shown only when participant is selected */}
                      {checked && meetingKind === 'production' ? (
                        <div aria-label={`Seat settings for ${option.label}`} className="flex gap-2 pl-7">
                          <select
                            aria-label={`Role for ${option.label}`}
                            className="min-h-9 flex-1 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-xs"
                            onChange={event => {
                              const role = event.currentTarget.value as (typeof SEAT_ROLE_OPTIONS)[number]
                              setSeatRoles(current =>
                                role
                                  ? { ...current, [key]: role }
                                  : (() => {
                                      const next = { ...current }
                                      delete next[key]

                                      return next
                                    })()
                              )
                            }}
                            value={seatRoles[key] ?? ''}
                          >
                            <option value="">— no seat role —</option>
                            {SEAT_ROLE_OPTIONS.map(role => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          {seatRoles[key] ? (
                            <Input
                              aria-label={`Seat label for ${option.label}`}
                              className="min-h-9 flex-1 text-xs"
                              onChange={event =>
                                setSeatLabels(current => ({ ...current, [key]: event.currentTarget.value }))
                              }
                              placeholder="Seat label"
                              value={seatLabels[key] ?? ''}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </fieldset>

            {/* Production has a complete server-validated bundle. Conclusion
                never sends production roles or artifact requirements. */}
            {meetingKind === 'production' && selectedParticipants.length >= 3 ? (
              <fieldset aria-label="Production roles">
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                  Production brief
                </legend>
                <div className="space-y-2 rounded-xl border border-(--ui-stroke-tertiary) p-3">
                  <div className="flex items-center gap-2">
                    <label className="w-24 shrink-0 text-xs text-(--ui-text-secondary)">Orchestrator</label>
                    <select
                      aria-label="Orchestrator"
                      className="min-h-9 flex-1 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-xs"
                      onChange={event => setOrchestratorKey(event.currentTarget.value)}
                      value={orchestratorKey}
                    >
                      <option value="">— none —</option>
                      {options
                        .filter(option => selectedParticipants.includes(routeKey(option)))
                        .map(option => {
                          const key = routeKey(option)

                          return (
                            <option key={key} value={key}>
                              {option.label}
                            </option>
                          )
                        })}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-24 shrink-0 text-xs text-(--ui-text-secondary)">Producer</label>
                    <select
                      aria-label="Producer"
                      className="min-h-9 flex-1 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-xs"
                      onChange={event => setProducerKey(event.currentTarget.value)}
                      value={producerKey}
                    >
                      <option value="">— none —</option>
                      {options
                        .filter(
                          option =>
                            selectedParticipants.includes(routeKey(option)) && routeKey(option) !== orchestratorKey
                        )
                        .map(option => {
                          const key = routeKey(option)

                          return (
                            <option key={key} value={key}>
                              {option.label}
                            </option>
                          )
                        })}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-24 shrink-0 text-xs text-(--ui-text-secondary)">Product kind</label>
                    <select
                      aria-label="Product kind"
                      className="min-h-9 flex-1 rounded-md border border-(--ui-stroke-tertiary) bg-transparent px-2 text-xs"
                      onChange={event => setProductKind(event.currentTarget.value)}
                      value={productKind}
                    >
                      <option value="">— none —</option>
                      {PRODUCT_KINDS.map(kind => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Input
                    aria-label="Output title"
                    className="min-h-9 text-xs"
                    maxLength={200}
                    onChange={event => setOutputTitle(event.currentTarget.value)}
                    placeholder="Output title"
                    value={outputTitle}
                  />
                  <textarea
                    aria-label="Acceptance statement"
                    className="min-h-20 w-full resize-y rounded-md border border-(--ui-stroke-tertiary) bg-transparent p-2 text-xs"
                    maxLength={4_000}
                    onChange={event => setAcceptanceStatement(event.currentTarget.value)}
                    placeholder="What an independent reviewer must confirm"
                    value={acceptanceStatement}
                  />
                </div>
              </fieldset>
            ) : null}

            {meetingKind === 'production' && selectedParticipants.length < 3 ? (
              <p className="rounded-xl border border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-secondary)">
                Choose at least three Bot seats to assign an orchestrator, producer, and reviewer.
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                aria-label="Cancel setup"
                className="min-h-11"
                onClick={() => {
                  setCreating(false)
                  setError('')
                }}
                variant="ghost"
              >
                Cancel
              </Button>
              <Button className="min-h-11" disabled={busy} onClick={() => void create()}>
                <Codicon name="organization" /> Create room
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Meeting details dialog ── */}
      <Dialog onOpenChange={setDetailsOpen} open={detailsOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)]">
          <DialogHeader className="shrink-0 border-b border-(--ui-stroke-tertiary) px-4 py-3">
            <DialogTitle>Meeting details</DialogTitle>
            <p className="text-sm text-(--ui-text-secondary)">{selected?.meeting.title}</p>
          </DialogHeader>
          {selected ? (
            <div className="min-h-0 space-y-4 overflow-y-auto p-4">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Agenda</h3>
                <p className="mt-2 text-sm leading-6 text-(--ui-text-secondary)">{selected.meeting.agenda}</p>
              </section>

              {/* C1/C3: show orchestrator/producer and seats when present */}
              {isProductionMeeting(selected.meeting) ? (
                <section aria-label="Production meeting details">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                    Production roles
                  </h3>
                  <dl className="mt-2 space-y-1 text-sm text-(--ui-text-secondary)">
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-(--ui-text-tertiary)">Orchestrator</dt>
                      <dd>
                        {selected.meeting.orchestrator?.profile} · {selected.meeting.orchestrator?.connectionId}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-(--ui-text-tertiary)">Producer</dt>
                      <dd>
                        {selected.meeting.producer?.profile} · {selected.meeting.producer?.connectionId}
                      </dd>
                    </div>
                    {selected.meeting.productionStage ? (
                      <div className="flex gap-2">
                        <dt className="w-24 shrink-0 text-(--ui-text-tertiary)">Stage</dt>
                        <dd>{selected.meeting.productionStage}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
              ) : null}

              {selected.meeting.seats && selected.meeting.seats.length ? (
                <section aria-label="Seat assignments">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">Seats</h3>
                  <ul className="mt-2 space-y-1">
                    {(selected.meeting.seats as SeatAssignment[]).map((seat, index) => (
                      <li className="flex items-center gap-2 text-sm text-(--ui-text-secondary)" key={index}>
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{seat.role}</span>
                        <span>{seat.label}</span>
                        <span className="text-xs text-(--ui-text-tertiary)">
                          {seat.bot.profile} · {seat.bot.connectionId}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                  Contributions
                </h3>
                <div className="mt-2 space-y-3">
                  {selected.meeting.contributions.length ? (
                    selected.meeting.contributions.map((raw, index) => {
                      const item = raw as any

                      return (
                        <div className="border-l-2 border-(--ui-accent) pl-3 text-sm" key={item.id || index}>
                          <span className="font-medium">
                            {item.participant?.profile} · {item.participant?.connectionId}
                          </span>
                          <p className="mt-1 text-(--ui-text-secondary)">
                            {item.kind === 'pass' ? '(pass)' : item.text}
                          </p>
                        </div>
                      )
                    })
                  ) : (
                    <p className="text-sm text-(--ui-text-tertiary)">No one has spoken yet.</p>
                  )}
                </div>
              </section>
              {['running', 'waiting'].includes(selected.meeting.state) && !isProductionMeeting(selected.meeting) ? (
                <section className="space-y-3 border-t border-(--ui-stroke-tertiary) pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                    Close the meeting
                  </h3>
                  <Input
                    aria-label="Meeting decision"
                    className="min-h-11"
                    onChange={event => setDecision(event.currentTarget.value)}
                    placeholder="Decision"
                    value={decision}
                  />
                  <Input
                    aria-label="Meeting dissent"
                    className="min-h-11"
                    onChange={event => setDissent(event.currentTarget.value)}
                    placeholder="Explicit dissent"
                    value={dissent}
                  />
                  <Input
                    aria-label="Meeting action item"
                    className="min-h-11"
                    onChange={event => setActionTitle(event.currentTarget.value)}
                    placeholder="Action item"
                    value={actionTitle}
                  />
                  <Button className="min-h-11 w-full" disabled={busy} onClick={() => void transition('conclude')}>
                    <Codicon name="check-all" /> Conclude meeting
                  </Button>
                </section>
              ) : null}
              {isProductionMeeting(selected.meeting) ? (
                <section
                  aria-label="Production completion"
                  className="space-y-2 border-t border-(--ui-stroke-tertiary) pt-4"
                >
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                    Production completion
                  </h3>
                  <p className="text-xs leading-5 text-(--ui-text-secondary)">
                    This meeting completes only when the owner approves a verified artifact version. Approval lives in
                    the deliverable package panel in the room — the server derives the approver and writes every hash
                    itself.
                  </p>
                  <dl className="space-y-1 text-xs text-(--ui-text-secondary)">
                    <div className="flex gap-2">
                      <dt className="w-32 shrink-0 text-(--ui-text-tertiary)">Product kind</dt>
                      <dd>{selected.meeting.productKind}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-32 shrink-0 text-(--ui-text-tertiary)">Output title</dt>
                      <dd>{selected.meeting.outputTitle}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-32 shrink-0 text-(--ui-text-tertiary)">Acceptance</dt>
                      <dd className="min-w-0">{selected.meeting.acceptanceStatement}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {produceNotice ? (
        <p className="text-sm text-emerald-200" data-testid="produce-notice" role="status">
          {produceNotice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
