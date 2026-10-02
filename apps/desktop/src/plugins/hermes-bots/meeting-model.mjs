export const MEETING_LIMITS = Object.freeze({
  maxIdLength: 128,
  maxRoutePartLength: 128,
  maxTitleLength: 200,
  maxAgendaLength: 8_000,
  maxContributionLength: 8_000,
  maxEvidenceRefs: 32,
  maxEvidenceRefLength: 2_048,
  maxDecisionCount: 32,
  maxDissentCount: 32,
  maxActionItemCount: 64,
  maxSerializedBytes: 256_000,
  minParticipants: 2,
  maxParticipants: 6,
  maxRounds: 5,
  maxSeats: 6,
  maxSeatLabelLength: 256,
  maxSeatInstructionsLength: 4_000
})

export const MEETING_SEAT_ROLES = Object.freeze({
  contributor: 'contributor',
  thinker: 'thinker',
  specialist: 'specialist',
  reviewer: 'reviewer'
})

// C6: legal production-stage names — only valid on production meetings (orchestrator+producer present).
export const MEETING_PRODUCTION_STAGES = Object.freeze([
  'briefing',
  'working',
  'production_ready',
  'producing',
  'reviewing',
  'changes_requested',
  'approval_ready',
  'completed'
])

const _PRODUCTION_STAGE_SET = new Set(MEETING_PRODUCTION_STAGES)

// C5: SHA-256 digest pattern.
const _SHA256_RE = /^[0-9a-f]{64}$/

export class MeetingValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MeetingValidationError'
  }
}

export class MeetingTransitionError extends MeetingValidationError {
  constructor(message) {
    super(message)
    this.name = 'MeetingTransitionError'
  }
}

function fail(message) {
  throw new MeetingValidationError(message)
}

// C5: validate an artifact binding object. Returns a frozen copy or throws.
function validateArtifactBinding(value, field = 'artifactBinding') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`)
  }
  const required = ['outputId', 'artifactVersion', 'gameSha256', 'manifestSha256', 'zipSha256', 'approvedBy', 'approvedAt']
  for (const key of required) {
    if (!(key in value)) fail(`${field}.${key} is required`)
  }
  const outputId = requireString(value.outputId, `${field}.outputId`, MEETING_LIMITS.maxIdLength, { noWhitespace: true })
  if (!Number.isInteger(value.artifactVersion) || value.artifactVersion < 1) {
    fail(`${field}.artifactVersion must be a positive integer`)
  }
  for (const digestKey of ['gameSha256', 'manifestSha256', 'zipSha256']) {
    if (typeof value[digestKey] !== 'string' || !_SHA256_RE.test(value[digestKey])) {
      fail(`${field}.${digestKey} must be a 64-character lowercase hex SHA-256 digest`)
    }
  }
  const approvedBy = requireString(value.approvedBy, `${field}.approvedBy`, MEETING_LIMITS.maxIdLength)
  if (typeof value.approvedAt !== 'number') fail(`${field}.approvedAt must be a number`)
  return Object.freeze({
    outputId,
    artifactVersion: value.artifactVersion,
    gameSha256: value.gameSha256,
    manifestSha256: value.manifestSha256,
    zipSha256: value.zipSha256,
    approvedBy,
    approvedAt: value.approvedAt
  })
}

// Helper: returns true if the meeting is a production meeting (both orchestrator and producer present).
function isProductionMeeting(meeting) {
  return Boolean(meeting.orchestrator && meeting.producer)
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`)
  }
  return value
}

function requireString(value, field, maxLength, { noWhitespace = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\u0000')) {
    fail(`${field} must be a non-empty bounded string`)
  }
  if (noWhitespace && /\s/u.test(value)) {
    fail(`${field} cannot contain whitespace`)
  }
  return value
}

function validateRoute(value, field) {
  const route = requireRecord(value, field)
  requireString(route.connectionId, `${field}.connectionId`, MEETING_LIMITS.maxRoutePartLength, { noWhitespace: true })
  requireString(route.profile, `${field}.profile`, MEETING_LIMITS.maxRoutePartLength, { noWhitespace: true })
  return route
}

function copyRoute(route) {
  return Object.freeze({ connectionId: route.connectionId, profile: route.profile })
}

function routeKey(route) {
  return `${route.connectionId}\u0000${route.profile}`
}

function uniqueRoutes(routes) {
  const seen = new Set()
  return routes.filter(route => {
    const key = routeKey(route)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function startMeeting(meeting) {
  if (meeting?.state !== 'draft') throw new MeetingTransitionError('only a draft meeting can start')
  return Object.freeze({ ...meeting, currentRound: 1, state: 'running' })
}

function copyEvidenceRefs(value, field = 'evidenceRefs') {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MEETING_LIMITS.maxEvidenceRefs) {
    fail(`${field} must be a bounded array`)
  }
  return Object.freeze(value.map((reference, index) =>
    requireString(reference, `${field}[${index}]`, MEETING_LIMITS.maxEvidenceRefLength)
  ))
}

export function submitContribution(meeting, input) {
  if (meeting?.state !== 'running') throw new MeetingTransitionError('contributions require a running meeting')
  const candidate = requireRecord(input, 'contribution')
  const participant = validateRoute(candidate.participant, 'contribution.participant')
  if (!meeting.participants.some(route => routeKey(route) === routeKey(participant))) {
    fail('contributor must be a participant')
  }
  if (meeting.contributions.some(entry => entry.round === meeting.currentRound && routeKey(entry.participant) === routeKey(participant))) {
    throw new MeetingTransitionError('participant already contributed this round')
  }
  // C7: five legal contribution kinds; non-pass kinds require non-empty text.
  if (candidate.kind !== 'speak' && candidate.kind !== 'pass' &&
      candidate.kind !== 'brief' && candidate.kind !== 'produce' && candidate.kind !== 'review') {
    fail('contribution kind must be speak, pass, brief, produce, or review')
  }
  const text = (candidate.kind === 'speak' || candidate.kind === 'brief' ||
      candidate.kind === 'produce' || candidate.kind === 'review')
    ? requireString(candidate.text, 'contribution.text', MEETING_LIMITS.maxContributionLength)
    : ''
  const evidenceRefs = copyEvidenceRefs(candidate.evidenceRefs, 'contribution.evidenceRefs')
  const contribution = Object.freeze({
    id: `${meeting.id}:r${meeting.currentRound}:${encodeURIComponent(participant.connectionId)}:${encodeURIComponent(participant.profile)}`,
    round: meeting.currentRound,
    participant: copyRoute(participant),
    kind: candidate.kind,
    text,
    evidenceRefs
  })
  const contributions = Object.freeze([...meeting.contributions, contribution])
  const current = contributions.filter(entry => entry.round === meeting.currentRound)
  const roundComplete = current.length === meeting.participants.length
  const allPassed = roundComplete && current.every(entry => entry.kind === 'pass')
  const capped = roundComplete && meeting.currentRound >= meeting.maxRounds
  // C4: production meetings (orchestrator+producer present) must NOT auto-complete via rounds —
  // they require explicit concludeMeeting with a valid artifactBinding.
  const autoComplete = (allPassed || capped) && !isProductionMeeting(meeting)
  return Object.freeze({
    ...meeting,
    contributions,
    currentRound: roundComplete && !allPassed && !capped ? meeting.currentRound + 1 : meeting.currentRound,
    evidenceRefs: Object.freeze([...new Set([...meeting.evidenceRefs, ...evidenceRefs])]),
    state: autoComplete ? 'completed' : meeting.state
  })
}

export function createMeeting(input) {
  const candidate = requireRecord(input, 'meeting')
  requireString(candidate.id, 'id', MEETING_LIMITS.maxIdLength, { noWhitespace: true })
  validateRoute(candidate.source, 'source')
  requireString(candidate.title, 'title', MEETING_LIMITS.maxTitleLength)
  requireString(candidate.agenda, 'agenda', MEETING_LIMITS.maxAgendaLength)
  validateRoute(candidate.chair, 'chair')
  if (!Array.isArray(candidate.participants)) fail('participants must be an array')
  candidate.participants.forEach((participant, index) => validateRoute(participant, `participants[${index}]`))
  const participants = uniqueRoutes(candidate.participants)
  if (participants.length < MEETING_LIMITS.minParticipants || participants.length > MEETING_LIMITS.maxParticipants) {
    fail(`participants must contain ${MEETING_LIMITS.minParticipants} to ${MEETING_LIMITS.maxParticipants} unique routes`)
  }
  if (!participants.some(participant => routeKey(participant) === routeKey(candidate.chair))) {
    fail('chair must be a participant')
  }
  if (!Number.isInteger(candidate.maxRounds) || candidate.maxRounds < 1 || candidate.maxRounds > MEETING_LIMITS.maxRounds) {
    fail(`maxRounds must be an integer from 1 to ${MEETING_LIMITS.maxRounds}`)
  }

  // C1: orchestrator+producer mandatory pairing — both present or both absent, and must be distinct.
  const orchestrator = candidate.orchestrator ? validateRoute(candidate.orchestrator, 'orchestrator') : null
  const producer = candidate.producer ? validateRoute(candidate.producer, 'producer') : null
  if (orchestrator && !producer) fail('producer is required when orchestrator is present')
  if (producer && !orchestrator) fail('orchestrator is required when producer is present')
  if (orchestrator && producer && routeKey(orchestrator) === routeKey(producer)) {
    fail('orchestrator and producer must be distinct')
  }

  // C3: ordered seats — optional array, each bot unique, roles restricted, max 6 seats.
  const seats = []
  if (candidate.seats != null) {
    if (!Array.isArray(candidate.seats)) fail('seats must be an array')
    if (candidate.seats.length > MEETING_LIMITS.maxSeats) fail(`seats must contain at most ${MEETING_LIMITS.maxSeats} items`)
    const seenBotKeys = new Set()
    for (let index = 0; index < candidate.seats.length; index++) {
      const rawSeat = candidate.seats[index]
      if (rawSeat == null || typeof rawSeat !== 'object' || Array.isArray(rawSeat)) {
        fail(`seats[${index}] must be an object`)
      }
      const bot = validateRoute(rawSeat.bot, `seats[${index}].bot`)
      const role = requireString(rawSeat.role, `seats[${index}].role`, 32, { noWhitespace: true })
      if (!Object.prototype.hasOwnProperty.call(MEETING_SEAT_ROLES, role)) {
        fail(`seats[${index}].role is not allowed`)
      }
      const label = requireString(rawSeat.label, `seats[${index}].label`, MEETING_LIMITS.maxSeatLabelLength)
      const instructions = rawSeat.instructions != null
        ? requireString(rawSeat.instructions, `seats[${index}].instructions`, MEETING_LIMITS.maxSeatInstructionsLength)
        : undefined
      const botKey = routeKey(bot)
      if (seenBotKeys.has(botKey)) fail('seats must contain unique bots')
      seenBotKeys.add(botKey)
      // C2: reviewer seat cannot be the producer.
      if (role === 'reviewer' && producer && botKey === routeKey(producer)) {
        fail('reviewer seat cannot be the producer')
      }
      seats.push(Object.freeze({ bot: copyRoute(bot), role, label, ...(instructions !== undefined ? { instructions } : {}) }))
    }
  }

  // C6: productionStage — optional, only valid on production meetings.
  let productionStage
  if (candidate.productionStage != null) {
    if (!orchestrator || !producer) fail('productionStage requires orchestrator and producer')
    const stage = String(candidate.productionStage)
    if (!_PRODUCTION_STAGE_SET.has(stage)) fail('productionStage is not a valid production stage')
    productionStage = stage
  }

  // C5: artifactBinding — optional, only valid on production meetings.
  let artifactBinding
  if (candidate.artifactBinding != null) {
    if (!orchestrator || !producer) fail('artifactBinding requires orchestrator and producer')
    artifactBinding = validateArtifactBinding(candidate.artifactBinding)
  }

  return Object.freeze({
    id: candidate.id,
    source: copyRoute(candidate.source),
    title: candidate.title,
    agenda: candidate.agenda,
    chair: copyRoute(candidate.chair),
    participants: Object.freeze(participants.map(copyRoute)),
    maxRounds: candidate.maxRounds,
    currentRound: 0,
    contributions: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
    decisions: Object.freeze([]),
    dissent: Object.freeze([]),
    actionItems: Object.freeze([]),
    state: 'draft',
    ...(orchestrator ? { orchestrator: copyRoute(orchestrator) } : {}),
    ...(producer ? { producer: copyRoute(producer) } : {}),
    ...(seats.length ? { seats: Object.freeze(seats) } : {}),
    ...(productionStage !== undefined ? { productionStage } : {}),
    ...(artifactBinding !== undefined ? { artifactBinding } : {})
  })
}

function transitionMeeting(meeting, from, to) {
  if (!from.includes(meeting?.state)) throw new MeetingTransitionError(`cannot transition ${meeting?.state || 'unknown'} to ${to}`)
  return Object.freeze({ ...meeting, state: to })
}

export const waitMeeting = meeting => transitionMeeting(meeting, ['running'], 'waiting')
export const resumeMeeting = meeting => transitionMeeting(meeting, ['waiting'], 'running')
export const cancelMeeting = meeting => transitionMeeting(meeting, ['draft', 'running', 'waiting'], 'cancelled')
export const failMeeting = meeting => transitionMeeting(meeting, ['draft', 'running', 'waiting'], 'failed')

// C6: advance production stage. Both orchestrator and producer must be present.
export function advanceProductionStage(meeting, stage) {
  if (!isProductionMeeting(meeting)) {
    throw new MeetingTransitionError('advanceProductionStage requires orchestrator and producer')
  }
  if (!_PRODUCTION_STAGE_SET.has(stage)) {
    throw new MeetingValidationError('productionStage is not a valid production stage')
  }
  return Object.freeze({ ...meeting, productionStage: stage })
}

function boundedArray(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${field} must be a bounded array`)
  return value
}

function copyDecision(value, index) {
  const row = requireRecord(value, `decisions[${index}]`)
  return Object.freeze({
    id: requireString(row.id, `decisions[${index}].id`, MEETING_LIMITS.maxIdLength, { noWhitespace: true }),
    text: requireString(row.text, `decisions[${index}].text`, MEETING_LIMITS.maxContributionLength),
    evidenceRefs: copyEvidenceRefs(row.evidenceRefs, `decisions[${index}].evidenceRefs`)
  })
}

function copyDissent(value, index, participants) {
  const row = requireRecord(value, `dissent[${index}]`)
  const participant = validateRoute(row.participant, `dissent[${index}].participant`)
  if (!participants.some(route => routeKey(route) === routeKey(participant))) fail('dissent participant must be in the meeting')
  return Object.freeze({
    participant: copyRoute(participant),
    text: requireString(row.text, `dissent[${index}].text`, MEETING_LIMITS.maxContributionLength),
    evidenceRefs: copyEvidenceRefs(row.evidenceRefs, `dissent[${index}].evidenceRefs`)
  })
}

const PRIORITY_NUMBER = Object.freeze({ low: 0, normal: 1, high: 2, critical: 3 })

function copyActionItem(meetingId, value, index, participants) {
  const row = requireRecord(value, `actionItems[${index}]`)
  const ownerRoute = validateRoute(row.ownerRoute, `actionItems[${index}].ownerRoute`)
  if (!participants.some(route => routeKey(route) === routeKey(ownerRoute))) fail('action item owner must be in the meeting')
  const id = requireString(row.id, `actionItems[${index}].id`, MEETING_LIMITS.maxIdLength, { noWhitespace: true })
  const priority = requireString(row.priority, `actionItems[${index}].priority`, 16, { noWhitespace: true })
  if (!(priority in PRIORITY_NUMBER)) fail('action item priority is invalid')
  return Object.freeze({
    id,
    ownerRoute: copyRoute(ownerRoute),
    title: requireString(row.title, `actionItems[${index}].title`, MEETING_LIMITS.maxTitleLength),
    acceptanceCriteria: requireString(row.acceptanceCriteria, `actionItems[${index}].acceptanceCriteria`, MEETING_LIMITS.maxAgendaLength),
    priority,
    dueIntent: requireString(row.dueIntent, `actionItems[${index}].dueIntent`, MEETING_LIMITS.maxContributionLength),
    dedupeKey: `meeting:${meetingId}:action:${id}`
  })
}

export function concludeMeeting(meeting, input) {
  if (!['running', 'waiting'].includes(meeting?.state)) throw new MeetingTransitionError('only an active meeting can conclude')
  const candidate = requireRecord(input, 'conclusion')
  const chair = validateRoute(candidate.chair, 'conclusion.chair')
  if (routeKey(chair) !== routeKey(meeting.chair)) throw new MeetingTransitionError('only the chair can conclude the meeting')
  const decisions = Object.freeze(boundedArray(candidate.decisions, 'decisions', MEETING_LIMITS.maxDecisionCount).map(copyDecision))
  const dissent = Object.freeze(boundedArray(candidate.dissent, 'dissent', MEETING_LIMITS.maxDissentCount).map((row, index) => copyDissent(row, index, meeting.participants)))
  const actionItems = Object.freeze(boundedArray(candidate.actionItems, 'actionItems', MEETING_LIMITS.maxActionItemCount).map((row, index) => copyActionItem(meeting.id, row, index, meeting.participants)))

  // C4: production meetings cannot reach completed without a valid artifactBinding.
  let artifactBinding = meeting.artifactBinding
  if (isProductionMeeting(meeting)) {
    const bindingInput = candidate.artifactBinding != null ? candidate.artifactBinding : meeting.artifactBinding
    if (bindingInput == null) {
      throw new MeetingTransitionError('production meeting cannot complete without an approved artifact binding')
    }
    artifactBinding = validateArtifactBinding(bindingInput)
  }

  return Object.freeze({
    ...meeting,
    decisions,
    dissent,
    actionItems,
    state: 'completed',
    ...(artifactBinding !== undefined ? { artifactBinding } : {})
  })
}

export function buildKanbanCreatePayloads(meeting) {
  if (meeting?.state !== 'completed') throw new MeetingTransitionError('meeting must be completed before Kanban conversion')
  return Object.freeze(meeting.actionItems.map(item => Object.freeze({
    route: item.ownerRoute,
    request: Object.freeze({
      title: item.title,
      body: `Acceptance criteria:\n${item.acceptanceCriteria}\n\nDue intent:\n${item.dueIntent}\n\nMeeting: ${meeting.id}`,
      assignee: item.ownerRoute.profile,
      priority: PRIORITY_NUMBER[item.priority],
      idempotency_key: item.dedupeKey
    })
  })))
}

export function serializeMeeting(meeting) {
  const serialized = JSON.stringify(meeting)
  if (serialized.length > MEETING_LIMITS.maxSerializedBytes) fail('meeting payload is too large')
  return serialized
}

function freezeHydrated(record) {
  return Object.freeze({
    ...record,
    source: copyRoute(record.source),
    chair: copyRoute(record.chair),
    participants: Object.freeze(record.participants.map(copyRoute)),
    contributions: Object.freeze(record.contributions.map(entry => Object.freeze({
      ...entry,
      participant: copyRoute(entry.participant),
      evidenceRefs: Object.freeze([...entry.evidenceRefs])
    }))),
    evidenceRefs: Object.freeze([...record.evidenceRefs]),
    decisions: Object.freeze(record.decisions.map(entry => Object.freeze({ ...entry, evidenceRefs: Object.freeze([...entry.evidenceRefs]) }))),
    dissent: Object.freeze(record.dissent.map(entry => Object.freeze({ ...entry, participant: copyRoute(entry.participant), evidenceRefs: Object.freeze([...entry.evidenceRefs]) }))),
    actionItems: Object.freeze(record.actionItems.map(entry => Object.freeze({ ...entry, ownerRoute: copyRoute(entry.ownerRoute) }))),
    ...(record.orchestrator ? { orchestrator: copyRoute(record.orchestrator) } : {}),
    ...(record.producer ? { producer: copyRoute(record.producer) } : {}),
    ...(record.seats ? { seats: Object.freeze(record.seats.map(seat => Object.freeze({
      ...seat,
      bot: copyRoute(seat.bot)
    }))) } : {}),
    ...(record.productionStage !== undefined ? { productionStage: record.productionStage } : {}),
    ...(record.artifactBinding !== undefined ? { artifactBinding: Object.freeze({ ...record.artifactBinding }) } : {})
  })
}

export function hydrateMeeting(serialized) {
  if (typeof serialized !== 'string' || serialized.length > MEETING_LIMITS.maxSerializedBytes) fail('meeting payload is too large')
  let record
  try { record = JSON.parse(serialized) } catch { fail('meeting payload is not valid JSON') }
  const candidate = requireRecord(record, 'meeting')
  const base = createMeeting(candidate)
  const allowedStates = new Set(['draft', 'running', 'waiting', 'completed', 'cancelled', 'failed'])
  if (!allowedStates.has(candidate.state)) fail('meeting state is invalid')
  if (!Number.isInteger(candidate.currentRound) || candidate.currentRound < 0 || candidate.currentRound > base.maxRounds) fail('currentRound is invalid')
  const contributions = boundedArray(candidate.contributions, 'contributions', base.maxRounds * base.participants.length)
  let rebuilt = base
  if (candidate.state !== 'draft' || candidate.currentRound > 0 || contributions.length) rebuilt = startMeeting(base)
  for (const entry of contributions) {
    if (rebuilt.state !== 'running') fail('contribution follows a terminal round')
    if (entry.round !== rebuilt.currentRound) fail('contribution round is invalid')
    rebuilt = submitContribution(rebuilt, entry)
  }
  const decisions = boundedArray(candidate.decisions, 'decisions', MEETING_LIMITS.maxDecisionCount).map(copyDecision)
  const dissent = boundedArray(candidate.dissent, 'dissent', MEETING_LIMITS.maxDissentCount).map((row, index) => copyDissent(row, index, base.participants))
  const actions = boundedArray(candidate.actionItems, 'actionItems', MEETING_LIMITS.maxActionItemCount).map((row, index) => copyActionItem(base.id, row, index, base.participants))

  // C6: restore productionStage if present (already validated inside createMeeting above).
  // C5: restore artifactBinding if present.
  let artifactBinding
  if (candidate.artifactBinding != null) {
    artifactBinding = validateArtifactBinding(candidate.artifactBinding)
  }

  // C4: production meetings in completed state must have an artifact binding.
  if (candidate.state === 'completed' && base.orchestrator && base.producer) {
    if (artifactBinding == null) fail('production meeting cannot complete without an approved artifact binding')
  }

  const hydrated = {
    ...rebuilt,
    state: candidate.state,
    currentRound: candidate.currentRound,
    evidenceRefs: copyEvidenceRefs(candidate.evidenceRefs),
    decisions: Object.freeze(decisions),
    dissent: Object.freeze(dissent),
    actionItems: Object.freeze(actions),
    ...(artifactBinding !== undefined ? { artifactBinding } : {})
  }
  return freezeHydrated(hydrated)
}
