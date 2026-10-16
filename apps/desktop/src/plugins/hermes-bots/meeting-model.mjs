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
  maxSeatInstructionsLength: 4_000,
  maxAcceptanceStatementLength: 4_000,
  minProductionParticipants: 3
})

// Canonical public meeting schema version. New records are always v2; a legacy
// record with no schemaVersion hydrates as an ordinary conclusion meeting.
export const MEETING_SCHEMA_VERSION = 2

// The public package kinds a production meeting may order. The produced output
// kind is tracked separately as deliverable_package_v1, so the package schema
// and the product category are never conflated.
export const MEETING_PRODUCT_KINDS = Object.freeze([
  'interactive_web_app',
  'three_scene',
  'audio_asset',
  'video_asset',
  'document'
])

const _PRODUCT_KIND_SET = new Set(MEETING_PRODUCT_KINDS)

// The complete production bundle. A meeting is a production meeting only when
// every one of these is present; a partial bundle is refused outright.
const _PRODUCTION_BUNDLE_FIELDS = Object.freeze([
  'orchestrator',
  'producer',
  'seats',
  'productKind',
  'outputTitle',
  'acceptanceStatement'
])

// Every field a conclusion meeting must not carry.
const _PRODUCTION_ONLY_FIELDS = Object.freeze([
  ..._PRODUCTION_BUNDLE_FIELDS,
  'productionStage',
  'artifactBinding'
])

// The non-identifying public approver label. The real principal lives only in
// the protected server database, never in a renderer record.
export const MEETING_APPROVED_BY_LABEL = 'Owner'

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

// Server-owned stage ladder. `completed` is deliberately absent as a target:
// it is reached only by the exact owner approval transaction on the server.
const _STAGE_TRANSITIONS = Object.freeze({
  briefing: Object.freeze(['working']),
  working: Object.freeze(['production_ready']),
  production_ready: Object.freeze(['producing']),
  producing: Object.freeze(['reviewing']),
  reviewing: Object.freeze(['changes_requested', 'approval_ready']),
  changes_requested: Object.freeze(['producing']),
  approval_ready: Object.freeze(['reviewing']),
  completed: Object.freeze([])
})

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

/** Validate a SERVER-DERIVED artifact binding. The renderer never authors one:
 *  this only checks that a record the server already wrote is well formed, and
 *  it refuses any approver other than the non-identifying Owner label. */
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
  if (value.approvedBy !== MEETING_APPROVED_BY_LABEL) {
    fail(`${field}.approvedBy must be the non-identifying ${MEETING_APPROVED_BY_LABEL} label`)
  }
  if (!Number.isInteger(value.approvedAt) || value.approvedAt < 1) {
    fail(`${field}.approvedAt must be a positive integer timestamp`)
  }
  return Object.freeze({
    outputId,
    artifactVersion: value.artifactVersion,
    gameSha256: value.gameSha256,
    manifestSha256: value.manifestSha256,
    zipSha256: value.zipSha256,
    approvedBy: MEETING_APPROVED_BY_LABEL,
    approvedAt: value.approvedAt
  })
}

/** True when a record carries the production bundle. A meeting is production
 *  or conclusion; there is no partial shape. */
export function isProductionMeeting(meeting) {
  return Boolean(meeting && meeting.orchestrator && meeting.producer && meeting.productKind)
}

function presentProductionFields(candidate) {
  return _PRODUCTION_ONLY_FIELDS.filter(field => candidate[field] != null)
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

/** Build a draft meeting.
 *
 *  `serverOwned` is an INTERNAL flag used only by hydrateMeeting, which is
 *  reading a record the server already wrote. A client call always leaves it
 *  false, so a renderer can never author productionStage or artifactBinding. */
export function createMeeting(input, { serverOwned = false } = {}) {
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

  // The production bundle is all-or-none. A meeting is either a conclusion
  // meeting (no production field at all) or a complete production meeting.
  const present = presentProductionFields(candidate)
  const production = present.length > 0

  if (production) {
    const missing = _PRODUCTION_BUNDLE_FIELDS.filter(field => candidate[field] == null)
    if (missing.length) {
      fail(`a production meeting requires the complete production bundle; missing: ${missing.join(', ')}`)
    }
    if (participants.length < MEETING_LIMITS.minProductionParticipants) {
      fail(`a production meeting requires at least ${MEETING_LIMITS.minProductionParticipants} participant routes`)
    }
    // A client never authors approval evidence.
    if (!serverOwned && candidate.artifactBinding != null) {
      fail('artifactBinding is server owned and cannot be authored by a client')
    }
  }

  const orchestrator = production ? validateRoute(candidate.orchestrator, 'orchestrator') : null
  const producer = production ? validateRoute(candidate.producer, 'producer') : null

  if (production) {
    if (!participants.some(route => routeKey(route) === routeKey(orchestrator))) {
      fail('orchestrator must be a participant')
    }
    if (!participants.some(route => routeKey(route) === routeKey(producer))) {
      fail('producer must be a participant')
    }
    if (routeKey(orchestrator) === routeKey(producer)) {
      fail('orchestrator and producer must be distinct participants')
    }
  }

  // Ordered seat bijection: every participant occupies exactly one seat, and
  // at least one reviewer seat differs from both the orchestrator and producer.
  const seats = []
  if (production) {
    if (!Array.isArray(candidate.seats)) fail('seats must be an array')
    if (candidate.seats.length !== participants.length) {
      fail('production seats must assign every participant exactly once')
    }
    const participantKeys = new Set(participants.map(routeKey))
    const seenBotKeys = new Set()
    const reviewerKeys = []
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
      if (!participantKeys.has(botKey)) fail('every seat bot must be a meeting participant')
      if (seenBotKeys.has(botKey)) fail('production seats must assign every participant exactly once')
      seenBotKeys.add(botKey)
      if (role === 'reviewer') reviewerKeys.push(botKey)
      seats.push(Object.freeze({ bot: copyRoute(bot), role, label, ...(instructions !== undefined ? { instructions } : {}) }))
    }
    if (seenBotKeys.size !== participantKeys.size) {
      fail('production seats must assign every participant exactly once')
    }
    if (!reviewerKeys.length) fail('production requires at least one independent reviewer seat')
    const excluded = new Set([routeKey(orchestrator), routeKey(producer)])
    if (reviewerKeys.some(key => excluded.has(key))) {
      fail('a reviewer seat must differ from both the orchestrator and the producer')
    }
  }

  let productKind
  let outputTitle
  let acceptanceStatement
  let productionStage

  if (production) {
    productKind = requireString(candidate.productKind, 'productKind', 64, { noWhitespace: true })
    if (!_PRODUCT_KIND_SET.has(productKind)) fail('productKind is not a public package kind')
    outputTitle = requireString(candidate.outputTitle, 'outputTitle', MEETING_LIMITS.maxTitleLength)
    acceptanceStatement = requireString(
      candidate.acceptanceStatement,
      'acceptanceStatement',
      MEETING_LIMITS.maxAcceptanceStatementLength
    )
    // productionStage is server owned. A new client draft may only declare
    // briefing; hydration accepts whatever stage the server advanced to.
    productionStage = MEETING_PRODUCTION_STAGES[0]
    if (candidate.productionStage != null) {
      const stage = String(candidate.productionStage)
      if (!_PRODUCTION_STAGE_SET.has(stage)) fail('productionStage is not a valid production stage')
      if (!serverOwned && stage !== productionStage) {
        fail('productionStage is server owned; a new production meeting starts at briefing')
      }
      productionStage = stage
    }
  }

  return Object.freeze({
    schemaVersion: MEETING_SCHEMA_VERSION,
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
    ...(production
      ? {
          orchestrator: copyRoute(orchestrator),
          producer: copyRoute(producer),
          seats: Object.freeze(seats),
          productKind,
          outputTitle,
          acceptanceStatement,
          productionStage
        }
      : {})
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

/** Advance one legal production stage. This mirrors the server ladder so the
 *  renderer can predict eligibility; the server remains the only writer, and
 *  `completed` is unreachable here because only owner approval reaches it. */
export function advanceProductionStage(meeting, stage) {
  if (!isProductionMeeting(meeting)) {
    throw new MeetingTransitionError('advanceProductionStage requires a production meeting')
  }
  if (!_PRODUCTION_STAGE_SET.has(stage)) {
    throw new MeetingValidationError('productionStage is not a valid production stage')
  }
  if (stage === 'completed') {
    throw new MeetingTransitionError(
      'the completed stage is reached only through the exact owner approval transaction'
    )
  }
  if (['completed', 'cancelled', 'failed'].includes(meeting.state)) {
    throw new MeetingTransitionError('a terminal meeting cannot advance its production stage')
  }
  const current = meeting.productionStage ?? MEETING_PRODUCTION_STAGES[0]
  if (!_STAGE_TRANSITIONS[current].includes(stage)) {
    throw new MeetingTransitionError(`production stage ${current} cannot advance to ${stage}`)
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
  // The generic conclude path belongs to ordinary discussion meetings. A
  // production meeting completes only through the exact owner approval
  // transaction, which the server performs atomically with the binding.
  if (isProductionMeeting(meeting)) {
    throw new MeetingTransitionError(
      'a production meeting completes only through the exact owner approval transaction'
    )
  }
  const candidate = requireRecord(input, 'conclusion')
  const chair = validateRoute(candidate.chair, 'conclusion.chair')
  if (routeKey(chair) !== routeKey(meeting.chair)) throw new MeetingTransitionError('only the chair can conclude the meeting')
  const decisions = Object.freeze(boundedArray(candidate.decisions, 'decisions', MEETING_LIMITS.maxDecisionCount).map(copyDecision))
  const dissent = Object.freeze(boundedArray(candidate.dissent, 'dissent', MEETING_LIMITS.maxDissentCount).map((row, index) => copyDissent(row, index, meeting.participants)))
  const actionItems = Object.freeze(boundedArray(candidate.actionItems, 'actionItems', MEETING_LIMITS.maxActionItemCount).map((row, index) => copyActionItem(meeting.id, row, index, meeting.participants)))

  return Object.freeze({
    ...meeting,
    decisions,
    dissent,
    actionItems,
    state: 'completed'
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
    ...(record.productKind !== undefined ? { productKind: record.productKind } : {}),
    ...(record.outputTitle !== undefined ? { outputTitle: record.outputTitle } : {}),
    ...(record.acceptanceStatement !== undefined ? { acceptanceStatement: record.acceptanceStatement } : {}),
    ...(record.productionStage !== undefined ? { productionStage: record.productionStage } : {}),
    ...(record.artifactBinding !== undefined ? { artifactBinding: Object.freeze({ ...record.artifactBinding }) } : {})
  })
}

export function hydrateMeeting(serialized) {
  if (typeof serialized !== 'string' || serialized.length > MEETING_LIMITS.maxSerializedBytes) fail('meeting payload is too large')
  let record
  try { record = JSON.parse(serialized) } catch { fail('meeting payload is not valid JSON') }
  const candidate = requireRecord(record, 'meeting')
  const base = createMeeting(candidate, { serverOwned: true })
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

  // production_stage and artifact_binding are SERVER truth. Hydration accepts
  // whatever stage the server advanced to and revalidates the binding shape,
  // but a completed production meeting must carry an approved binding and a
  // completed stage — nothing else can present itself as approved.
  const production = isProductionMeeting(base)
  let productionStage = base.productionStage
  if (production && candidate.productionStage != null) {
    const stage = String(candidate.productionStage)
    if (!_PRODUCTION_STAGE_SET.has(stage)) fail('productionStage is not a valid production stage')
    productionStage = stage
  }

  let artifactBinding
  if (candidate.artifactBinding != null) {
    if (!production) fail('artifactBinding requires a production meeting')
    artifactBinding = validateArtifactBinding(candidate.artifactBinding)
  }

  if (production && candidate.state === 'completed') {
    if (artifactBinding == null) {
      fail('a completed production meeting requires an approved artifact binding')
    }
    if (productionStage !== 'completed') {
      fail('a completed production meeting requires the completed production stage')
    }
  }
  if (artifactBinding != null && (candidate.state !== 'completed' || productionStage !== 'completed')) {
    fail('artifactBinding requires a completed production meeting')
  }

  const hydrated = {
    ...rebuilt,
    state: candidate.state,
    ...(production ? { productionStage } : {}),
    currentRound: candidate.currentRound,
    evidenceRefs: copyEvidenceRefs(candidate.evidenceRefs),
    decisions: Object.freeze(decisions),
    dissent: Object.freeze(dissent),
    actionItems: Object.freeze(actions),
    ...(artifactBinding !== undefined ? { artifactBinding } : {})
  }
  return freezeHydrated(hydrated)
}
