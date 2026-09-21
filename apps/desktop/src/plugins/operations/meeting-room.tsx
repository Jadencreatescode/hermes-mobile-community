import type { CSSProperties } from 'react'

import { BotAvatar } from './bot-avatar'
import type { OperationsAgentModel } from './data'
import type { MeetingRecord } from './meetings'

const MEETING_CUES: Record<MeetingRecord['state'], { accent: string; label: string; lighting: string; orb: string }> = {
  cancelled: { accent: 'bg-slate-400', label: 'Meeting cancelled', lighting: 'dimmed', orb: 'bg-slate-400/60' },
  completed: { accent: 'bg-emerald-300', label: 'Meeting completed', lighting: 'settled', orb: 'bg-emerald-300/80' },
  draft: { accent: 'bg-sky-300', label: 'Meeting draft', lighting: 'standby', orb: 'bg-sky-300/70' },
  failed: { accent: 'bg-red-400', label: 'Meeting failed', lighting: 'alert', orb: 'bg-red-400/80' },
  running: { accent: 'bg-cyan-300', label: 'Meeting in progress', lighting: 'live', orb: 'bg-cyan-300/90' },
  waiting: { accent: 'bg-amber-300', label: 'Meeting waiting for your input', lighting: 'attention', orb: 'bg-amber-300/90' }
}

const SEAT_POSITIONS = [
  'left-1/2 top-[7%] -translate-x-1/2 md:top-[6%]',
  'left-[2%] top-[31%] md:left-[8%] md:top-[34%]',
  'right-[2%] top-[31%] md:right-[8%] md:top-[34%]',
  'bottom-[10%] left-[4%] md:bottom-[7%] md:left-[18%]',
  'right-[4%] bottom-[10%] md:right-[18%] md:bottom-[7%]',
  'bottom-[2%] left-1/2 -translate-x-1/2 md:bottom-[2%]'
] as const

const ROOM_LIGHTING: Record<MeetingRecord['state'], string> = {
  cancelled: 'from-slate-950 via-slate-950 to-slate-900',
  completed: 'from-emerald-950/80 via-slate-950 to-emerald-950/40',
  draft: 'from-sky-950/70 via-slate-950 to-slate-900',
  failed: 'from-red-950/80 via-slate-950 to-red-950/30',
  running: 'from-cyan-950/70 via-slate-950 to-indigo-950/60',
  waiting: 'from-amber-950/80 via-slate-950 to-orange-950/30'
}

function participantAgent(
  agents: OperationsAgentModel[],
  participant: MeetingRecord['participants'][number]
): OperationsAgentModel | undefined {
  return agents.find(agent => agent.sourceId === participant.connectionId && agent.profile === participant.profile)
}

function latestSpeaker(meeting: MeetingRecord): MeetingRecord['participants'][number] | undefined {
  for (let index = meeting.contributions.length - 1; index >= 0; index -= 1) {
    const contribution = meeting.contributions[index]

    if (!contribution || typeof contribution !== 'object' || (contribution as { kind?: unknown }).kind !== 'speak') {continue}
    const participant = (contribution as { participant?: unknown }).participant

    if (participant && typeof participant === 'object') {
      const route = participant as { connectionId?: unknown; profile?: unknown }

      if (typeof route.connectionId === 'string' && typeof route.profile === 'string') {
        return { connectionId: route.connectionId, profile: route.profile }
      }
    }
  }

  return undefined
}

function seatStyle(index: number): CSSProperties {
  return { zIndex: index === 0 ? 40 : index >= 3 ? 35 : 25 }
}

function recordText(value: unknown, key: 'text' | 'title'): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return ''}
  const candidate = (value as Record<string, unknown>)[key]

  return typeof candidate === 'string' ? candidate.trim() : ''
}

export function MeetingRoom({
  agents,
  meeting,
  onCreateTasks,
  onOpenAgent,
  onOpenConversation,
  onOpenConversations,
  onOpenDetails,
  thinkingParticipant
}: {
  agents: OperationsAgentModel[]
  meeting: MeetingRecord
  onCreateTasks?: () => void
  onOpenAgent?: (agent: OperationsAgentModel) => void
  onOpenConversation?: (participant: MeetingRecord['participants'][number]) => void
  onOpenConversations?: () => void
  onOpenDetails?: () => void
  thinkingParticipant?: MeetingRecord['participants'][number] | null
}) {
  const speaker = latestSpeaker(meeting)
  const cue = MEETING_CUES[meeting.state]
  const thinkingAgent = thinkingParticipant ? participantAgent(agents, thinkingParticipant) : undefined
  const thinkingName = thinkingAgent?.displayName ?? thinkingParticipant?.profile ?? ''
  const conclusion = recordText(meeting.decisions[0], 'text') || 'The meeting closed without a recorded conclusion.'
  const nextAction = recordText(meeting.actionItems[0], 'title') || 'No next action was assigned.'

  return (
    <section
      aria-label="Bot meeting room"
      className={`relative isolate min-h-[clamp(32rem,calc(100dvh-13rem),52rem)] w-full min-w-0 overflow-hidden rounded-[1.75rem] bg-gradient-to-b ${ROOM_LIGHTING[meeting.state]} shadow-[0_26px_80px_rgba(0,0,0,.42)] ring-1 ring-white/10`}
      data-lighting={cue.lighting}
      data-meeting-state={meeting.state}
      data-room-scene
    >
      <div className="pointer-events-none absolute inset-0" data-testid="meeting-room-wall">
        <div className="absolute inset-x-0 top-0 h-[54%] bg-[radial-gradient(circle_at_50%_0%,rgba(103,232,249,.13),transparent_55%)]" />
        <div className="absolute inset-y-0 left-0 w-px bg-white/10" />
        <div className="absolute inset-y-0 right-0 w-px bg-white/10" />
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[7%] top-[8%] h-[25%] overflow-hidden border-y border-cyan-100/10 bg-gradient-to-b from-cyan-300/[0.07] to-indigo-400/[0.02] [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
        data-testid="meeting-room-window"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_68%_28%,rgba(255,255,255,.62)_0_1px,transparent_2px),radial-gradient(circle_at_28%_42%,rgba(255,255,255,.4)_0_1px,transparent_2px),linear-gradient(155deg,transparent_30%,rgba(99,102,241,.15))] bg-[length:84px_84px,112px_112px,100%_100%]" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-cyan-100/10" />
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[64%] origin-bottom bg-[linear-gradient(rgba(103,232,249,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(103,232,249,.07)_1px,transparent_1px)] bg-[length:42px_42px] [transform:perspective(650px)_rotateX(58deg)_scale(1.35)] [mask-image:linear-gradient(to_bottom,transparent,black_32%)]"
        data-testid="meeting-room-floor"
      />

      <div className="absolute left-3 top-3 z-50 flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-white/75 md:left-5 md:top-5">
        <span className={`size-2 rounded-full ${cue.accent} ${meeting.state === 'running' || meeting.state === 'waiting' ? 'motion-safe:animate-pulse' : ''}`} />
        <span role="status">{cue.label}</span>
      </div>

      {thinkingParticipant ? (
        <div
          aria-label={`${thinkingName} is thinking`}
          className="absolute right-3 top-3 z-50 flex max-w-[58%] items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-950/85 px-3 py-1.5 text-[0.68rem] font-semibold text-cyan-100 shadow-[0_8px_28px_rgba(8,145,178,.3)] backdrop-blur-md md:right-5 md:top-5"
          role="status"
        >
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-cyan-300" />
          <span className="truncate">{thinkingName} is thinking</span>
        </div>
      ) : null}

      {onOpenConversations ? (
        <button
          aria-label="Open meeting conversations"
          className="absolute inset-x-[16%] top-[38%] z-20 h-[39%] min-h-11 rounded-[50%] border border-white/15 bg-gradient-to-b from-slate-500/70 via-slate-800/95 to-black shadow-[0_34px_42px_rgba(0,0,0,.58),inset_0_5px_7px_rgba(255,255,255,.16),inset_0_-18px_24px_rgba(0,0,0,.5),0_0_65px_rgba(34,211,238,.1)] outline-none transition-[filter,scale] duration-150 hover:brightness-110 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-cyan-300 md:inset-x-[18%] md:top-[37%] md:h-[41%]"
          data-testid="meeting-room-table"
          onClick={onOpenConversations}
          type="button"
        >
          <span aria-hidden className="absolute inset-[7%] rounded-[50%] border border-cyan-100/10 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,.08),transparent_62%)]" />
          <span aria-hidden className="absolute inset-x-[24%] bottom-[-9%] h-[18%] rounded-b-[50%] bg-black/75 blur-[1px]" />
        </button>
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-[16%] top-[38%] z-20 h-[39%] rounded-[50%] border border-white/15 bg-gradient-to-b from-slate-500/70 via-slate-800/95 to-black shadow-[0_34px_42px_rgba(0,0,0,.58),inset_0_5px_7px_rgba(255,255,255,.16),inset_0_-18px_24px_rgba(0,0,0,.5),0_0_65px_rgba(34,211,238,.1)] md:inset-x-[18%] md:top-[37%] md:h-[41%]"
          data-testid="meeting-room-table"
        >
          <div className="absolute inset-[7%] rounded-[50%] border border-cyan-100/10 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,.08),transparent_62%)]" />
          <div className="absolute inset-x-[24%] bottom-[-9%] h-[18%] rounded-b-[50%] bg-black/75 blur-[1px]" />
        </div>
      )}

      {meeting.state === 'completed' ? (
        <section
          aria-label="Meeting wrap up"
          className="absolute left-1/2 top-[41%] z-30 w-[62%] -translate-x-1/2 rounded-[1.25rem] border border-emerald-200/20 bg-slate-950/95 p-3 text-left shadow-[0_16px_44px_rgba(0,0,0,.55),0_0_38px_rgba(52,211,153,.14)] backdrop-blur-md md:top-[42%] md:w-[48%] md:p-4"
          data-testid="meeting-room-wrap-up"
        >
          <p className="text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-emerald-300">Meeting wrap up</p>
          <p className="mt-1 line-clamp-2 text-xs font-medium leading-5 text-white md:text-sm">{conclusion}</p>
          <p className="mt-2 line-clamp-1 text-[0.65rem] text-white/65"><span className="font-semibold text-white/85">Next action:</span> {nextAction}</p>
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
            {onOpenConversations ? (
              <button
                className="min-h-11 min-w-11 rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 text-[0.65rem] font-semibold text-cyan-100 transition-[background-color,scale] duration-150 hover:bg-cyan-300/20 active:scale-[0.96]"
                onClick={onOpenConversations}
                type="button"
              >
                Conversations
              </button>
            ) : null}
            {onOpenDetails ? (
              <button
                className="min-h-11 min-w-11 rounded-full border border-white/15 bg-white/5 px-3 text-[0.65rem] font-semibold text-white/85 transition-[background-color,scale] duration-150 hover:bg-white/10 active:scale-[0.96]"
                onClick={onOpenDetails}
                type="button"
              >
                Full wrap up
              </button>
            ) : null}
            {meeting.actionItems.length > 0 && onCreateTasks ? (
              <button
                className="min-h-11 min-w-11 rounded-full bg-cyan-300 px-3 text-[0.65rem] font-semibold text-slate-950 transition-[background-color,scale] duration-150 hover:bg-cyan-200 active:scale-[0.96]"
                onClick={onCreateTasks}
                type="button"
              >
                Create {meeting.actionItems.length} {meeting.actionItems.length === 1 ? 'task' : 'tasks'}
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <div
          aria-label={`Round ${meeting.currentRound} of ${meeting.maxRounds}`}
          className={`absolute left-1/2 top-[52%] z-30 grid size-20 -translate-x-1/2 place-items-center rounded-full border border-cyan-100/20 bg-slate-950/90 shadow-[0_8px_24px_rgba(0,0,0,.5),0_0_35px_rgba(34,211,238,.2),inset_0_0_18px_rgba(255,255,255,.05)] md:top-[51%] md:size-28 ${onOpenConversations ? 'pointer-events-none' : ''}`}
          data-testid="meeting-room-console"
          role="img"
        >
          <div className={`absolute size-9 rounded-full blur-sm ${cue.orb} ${meeting.state === 'running' || meeting.state === 'waiting' ? 'motion-safe:animate-pulse' : ''}`} />
          <div className="absolute inset-x-3 bottom-3 flex justify-center gap-1.5 md:bottom-4">
            {Array.from({ length: Math.max(1, meeting.maxRounds) }, (_, index) => (
              <span
                className={`h-1.5 min-w-3 flex-1 rounded-full ${index < meeting.currentRound ? cue.accent : 'bg-white/15'}`}
                data-illuminated={index < meeting.currentRound ? 'true' : 'false'}
                data-round-segment={index + 1}
                key={index}
              />
            ))}
          </div>
        </div>
      )}

      {meeting.participants.slice(0, 6).map((participant, index) => {
        const agent = participantAgent(agents, participant)
        const name = agent?.displayName ?? participant.profile
        const chair = index === 0
        const speaking = speaker?.connectionId === participant.connectionId && speaker.profile === participant.profile
        const thinking = thinkingParticipant?.connectionId === participant.connectionId && thinkingParticipant.profile === participant.profile
        const opensConversation = Boolean(onOpenConversation)

        return (
          <button
            aria-description={chair ? 'Meeting chair' : undefined}
            aria-label={opensConversation ? `Open ${name} meeting conversation` : `Open ${name} workspace`}
            className={`absolute ${SEAT_POSITIONS[index]} group grid min-h-11 min-w-11 place-items-center gap-1 bg-transparent p-1 text-center outline-none transition-[scale,filter] duration-150 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-cyan-300 ${thinking ? 'drop-shadow-[0_0_24px_rgba(103,232,249,1)]' : speaking ? 'drop-shadow-[0_0_12px_rgba(52,211,153,.7)]' : ''}`}
            data-activity={thinking ? 'thinking' : speaking ? 'last-spoke' : 'listening'}
            data-seat-position={chair ? 'head' : `seat-${index + 1}`}
            data-speaker={speaking ? 'latest' : undefined}
            data-testid="meeting-room-seat"
            key={`${participant.connectionId}:${participant.profile}`}
            onClick={() => {
              if (onOpenConversation) {onOpenConversation(participant)}
              else if (agent) {onOpenAgent?.(agent)}
            }}
            style={seatStyle(index)}
            type="button"
          >
            <span aria-hidden className="absolute top-7 h-16 w-16 rounded-t-[48%] rounded-b-[32%] border border-white/15 bg-gradient-to-b from-slate-600/65 to-slate-950 shadow-[0_14px_18px_rgba(0,0,0,.5)] md:h-20 md:w-20" />
            <span aria-hidden className="absolute top-[4.7rem] h-3 w-16 rounded-[50%] bg-black/55 blur-[2px] md:top-[5.4rem] md:w-20" />
            <span className={`relative grid place-items-center rounded-full p-1.5 ${thinking ? 'ring-2 ring-cyan-200 ring-offset-2 ring-offset-slate-950' : speaking ? 'ring-2 ring-emerald-300/80 ring-offset-2 ring-offset-slate-950' : chair ? 'ring-1 ring-amber-200/70' : 'ring-1 ring-white/15'}`}>
              {thinking ? (
                <>
                  <span aria-hidden className="absolute -inset-3 rounded-full border border-cyan-200/45 motion-safe:animate-ping" />
                  <span aria-hidden className="absolute -inset-6 rounded-full border border-cyan-300/20 motion-safe:animate-pulse" />
                </>
              ) : null}
              {chair ? <span aria-hidden className="absolute -top-5 text-base text-amber-200 drop-shadow-[0_0_7px_rgba(253,230,138,.7)]">♛</span> : null}
              {agent ? <BotAvatar name={agent.displayName} size="lg" /> : <span aria-hidden className="grid size-14 place-items-center rounded-[34%] bg-slate-600 text-xl text-white md:size-16">{name.slice(0, 1).toUpperCase()}</span>}
            </span>
            <span className="max-w-24 truncate text-[0.65rem] font-semibold text-white/85 drop-shadow-[0_2px_3px_rgba(0,0,0,.9)] md:max-w-32 md:text-xs">{name}</span>
            {thinking ? (
              <span className="rounded-full border border-cyan-200/25 bg-cyan-950/85 px-2 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-cyan-100">Thinking</span>
            ) : speaking ? (
              <span className="rounded-full border border-emerald-200/20 bg-emerald-950/80 px-2 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-emerald-100">Last spoke</span>
            ) : (
              <span className="rounded-full bg-slate-950/70 px-2 py-0.5 text-[0.58rem] text-white/55">Tap desk</span>
            )}
          </button>
        )
      })}

      <div aria-hidden className="pointer-events-none absolute inset-x-[18%] bottom-2 h-6 rounded-[50%] bg-black/50 blur-xl" />
    </section>
  )
}
