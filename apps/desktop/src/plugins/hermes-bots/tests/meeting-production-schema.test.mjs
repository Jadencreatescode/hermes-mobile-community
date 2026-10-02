import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceProductionStage,
  concludeMeeting,
  createMeeting,
  hydrateMeeting,
  MEETING_LIMITS,
  MEETING_PRODUCTION_STAGES,
  MEETING_SEAT_ROLES,
  MeetingTransitionError,
  MeetingValidationError,
  serializeMeeting,
  startMeeting,
  submitContribution
} from '../meeting-model.mjs'

// ---------------------------------------------------------------------------
// Shared route fixtures
// ---------------------------------------------------------------------------

const alice = Object.freeze({ connectionId: 'vps', profile: 'alice' })
const bob = Object.freeze({ connectionId: 'vps', profile: 'bob' })
const orch = Object.freeze({ connectionId: 'bridge', profile: 'orchestrator' })
const prod = Object.freeze({ connectionId: 'bridge', profile: 'producer' })
const reviewer = Object.freeze({ connectionId: 'vps', profile: 'reviewer' })

function base(overrides = {}) {
  return {
    id: 'meeting-prod-1',
    source: { connectionId: 'vps', profile: 'default' },
    title: 'Production meeting',
    agenda: 'Build the thing.',
    chair: alice,
    participants: [alice, bob],
    maxRounds: 3,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// C1 — orchestrator+producer mandatory pairing
// ---------------------------------------------------------------------------

test('C1: orchestrator and producer both absent — creates a plain meeting without production anchors', () => {
  const meeting = createMeeting(base())
  assert.equal(meeting.orchestrator, undefined)
  assert.equal(meeting.producer, undefined)
})

test('C1: orchestrator and producer both present and distinct — creates a production meeting', () => {
  const meeting = createMeeting(base({ orchestrator: orch, producer: prod }))
  assert.deepEqual(meeting.orchestrator, orch)
  assert.deepEqual(meeting.producer, prod)
})

test('C1: orchestrator without producer is rejected', () => {
  assert.throws(
    () => createMeeting(base({ orchestrator: orch })),
    err => err instanceof MeetingValidationError && /producer is required when orchestrator is present/.test(err.message)
  )
})

test('C1: producer without orchestrator is rejected', () => {
  assert.throws(
    () => createMeeting(base({ producer: prod })),
    err => err instanceof MeetingValidationError && /orchestrator is required when producer is present/.test(err.message)
  )
})

test('C1: orchestrator and producer identical routes are rejected', () => {
  assert.throws(
    () => createMeeting(base({ orchestrator: orch, producer: orch })),
    err => err instanceof MeetingValidationError && /orchestrator and producer must be distinct/.test(err.message)
  )
})

test('C1: orchestrator with malformed route is rejected', () => {
  assert.throws(
    () => createMeeting(base({ orchestrator: { connectionId: '' }, producer: prod })),
    MeetingValidationError
  )
})

// ---------------------------------------------------------------------------
// C2 — reviewer seat cannot equal producer route
// ---------------------------------------------------------------------------

test('C2: reviewer seat with a different bot than producer is accepted', () => {
  const meeting = createMeeting(base({
    orchestrator: orch,
    producer: prod,
    seats: [
      { bot: reviewer, role: 'reviewer', label: 'Review seat' }
    ]
  }))
  assert.equal(meeting.seats.length, 1)
  assert.equal(meeting.seats[0].role, 'reviewer')
})

test('C2: reviewer seat whose bot equals the producer route is rejected at creation', () => {
  assert.throws(
    () => createMeeting(base({
      orchestrator: orch,
      producer: prod,
      seats: [
        { bot: prod, role: 'reviewer', label: 'Bad seat' }
      ]
    })),
    err => err instanceof MeetingValidationError && /reviewer seat cannot be the producer/.test(err.message)
  )
})

test('C2: reviewer seat without producer present is accepted (no producer = no restriction)', () => {
  // No orchestrator/producer — reviewer seats are unrestricted.
  const meeting = createMeeting(base({
    seats: [
      { bot: alice, role: 'reviewer', label: 'Review seat' }
    ]
  }))
  assert.equal(meeting.seats[0].role, 'reviewer')
})

test('C2: reviewer-cannot-be-producer is also enforced at hydration', () => {
  // Build a valid meeting, then tamper its serialization to inject the violation.
  const meeting = createMeeting(base({
    orchestrator: orch,
    producer: prod,
    seats: [
      { bot: reviewer, role: 'reviewer', label: 'Review seat' }
    ]
  }))
  const raw = JSON.parse(serializeMeeting(meeting))
  // Replace the reviewer bot with the producer route.
  raw.seats[0].bot = { ...prod }
  assert.throws(
    () => hydrateMeeting(JSON.stringify(raw)),
    err => err instanceof MeetingValidationError && /reviewer seat cannot be the producer/.test(err.message)
  )
})

// ---------------------------------------------------------------------------
// C3 — ordered seats model
// ---------------------------------------------------------------------------

test('C3: seats omitted — meeting has no seats property', () => {
  const meeting = createMeeting(base())
  assert.equal(meeting.seats, undefined)
})

test('C3: seats present with all valid roles — preserved and frozen in order', () => {
  const seatDefs = [
    { bot: { connectionId: 'vps', profile: 'p1' }, role: 'contributor', label: 'Contributor seat' },
    { bot: { connectionId: 'vps', profile: 'p2' }, role: 'thinker', label: 'Thinker seat' },
    { bot: { connectionId: 'vps', profile: 'p3' }, role: 'specialist', label: 'Specialist seat' },
    { bot: reviewer, role: 'reviewer', label: 'Reviewer seat', instructions: 'Review carefully.' }
  ]
  const meeting = createMeeting(base({ seats: seatDefs }))
  assert.equal(meeting.seats.length, 4)
  assert.equal(meeting.seats[0].role, 'contributor')
  assert.equal(meeting.seats[1].role, 'thinker')
  assert.equal(meeting.seats[2].role, 'specialist')
  assert.equal(meeting.seats[3].role, 'reviewer')
  assert.equal(meeting.seats[3].instructions, 'Review carefully.')
  assert.equal(Object.isFrozen(meeting.seats), true)
  assert.equal(Object.isFrozen(meeting.seats[0]), true)
})

test('C3: seats with instructions=undefined are stored without the key', () => {
  const meeting = createMeeting(base({
    seats: [{ bot: alice, role: 'contributor', label: 'A seat' }]
  }))
  assert.equal(Object.prototype.hasOwnProperty.call(meeting.seats[0], 'instructions'), false)
})

test('C3: duplicate bots in seats are rejected', () => {
  assert.throws(
    () => createMeeting(base({
      seats: [
        { bot: alice, role: 'contributor', label: 'First' },
        { bot: alice, role: 'thinker', label: 'Dup' }
      ]
    })),
    err => err instanceof MeetingValidationError && /seats must contain unique bots/.test(err.message)
  )
})

test('C3: more than maxSeats items are rejected', () => {
  const tooMany = Array.from({ length: MEETING_LIMITS.maxSeats + 1 }, (_, i) => ({
    bot: { connectionId: 'vps', profile: `bot${i}` },
    role: 'contributor',
    label: `Seat ${i}`
  }))
  assert.throws(
    () => createMeeting(base({ seats: tooMany })),
    err => err instanceof MeetingValidationError && new RegExp(`seats must contain at most ${MEETING_LIMITS.maxSeats}`).test(err.message)
  )
})

test('C3: invalid role is rejected', () => {
  assert.throws(
    () => createMeeting(base({
      seats: [{ bot: alice, role: 'unknown_role', label: 'Bad seat' }]
    })),
    err => err instanceof MeetingValidationError && /role is not allowed/.test(err.message)
  )
})

test('C3: seats must be an array (not an object)', () => {
  assert.throws(
    () => createMeeting(base({ seats: { bot: alice, role: 'contributor', label: 'Bad' } })),
    MeetingValidationError
  )
})

test('C3: seats round-trip through serialize/hydrate intact', () => {
  const meeting = createMeeting(base({
    orchestrator: orch,
    producer: prod,
    seats: [
      { bot: alice, role: 'contributor', label: 'Contributor' },
      { bot: reviewer, role: 'reviewer', label: 'Review', instructions: 'Be thorough.' }
    ]
  }))
  const hydrated = hydrateMeeting(serializeMeeting(meeting))
  assert.deepEqual(hydrated.seats, meeting.seats)
  assert.equal(Object.isFrozen(hydrated.seats), true)
  assert.equal(Object.isFrozen(hydrated.seats[1]), true)
  assert.deepEqual(hydrated.orchestrator, orch)
  assert.deepEqual(hydrated.producer, prod)
})

// ---------------------------------------------------------------------------
// MEETING_SEAT_ROLES export
// ---------------------------------------------------------------------------

test('MEETING_SEAT_ROLES exports exactly the four allowed roles', () => {
  assert.deepEqual(Object.keys(MEETING_SEAT_ROLES).sort(), ['contributor', 'reviewer', 'specialist', 'thinker'])
  assert.equal(Object.isFrozen(MEETING_SEAT_ROLES), true)
})

// ---------------------------------------------------------------------------
// Non-regression: ordinary (no orchestrator/producer) meetings are unchanged
// ---------------------------------------------------------------------------

test('Non-regression: ordinary meeting auto-completes on all-pass without any production fields', () => {
  let m = startMeeting(createMeeting(base()))
  m = submitContribution(m, { participant: alice, kind: 'pass' })
  m = submitContribution(m, { participant: bob, kind: 'pass' })
  assert.equal(m.state, 'completed')
  assert.equal(m.orchestrator, undefined)
  assert.equal(m.producer, undefined)
})

test('Non-regression: ordinary meeting auto-completes at round cap without production fields', () => {
  let m = startMeeting(createMeeting(base({ maxRounds: 1 })))
  m = submitContribution(m, { participant: alice, kind: 'speak', text: 'Go.' })
  m = submitContribution(m, { participant: bob, kind: 'pass' })
  assert.equal(m.state, 'completed')
})

test('Non-regression: hydrate/serialize of an ordinary meeting remains stable', () => {
  const original = startMeeting(createMeeting(base()))
  const withContrib = submitContribution(original, { participant: alice, kind: 'speak', text: 'Evidence.' })
  const hydrated = hydrateMeeting(serializeMeeting(withContrib))
  assert.deepEqual(hydrated, withContrib)
  assert.equal(hydrated.orchestrator, undefined)
  assert.equal(hydrated.seats, undefined)
})

// ---------------------------------------------------------------------------
// Shared valid artifact binding fixture
// ---------------------------------------------------------------------------

const validBinding = Object.freeze({
  outputId: 'game-v1.0',
  artifactVersion: 1,
  gameSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  zipSha256: 'c'.repeat(64),
  approvedBy: 'boss',
  approvedAt: 1_700_000_000
})

function prodBase(overrides = {}) {
  return base({ orchestrator: orch, producer: prod, ...overrides })
}

function prodConclusion(bindingOverride) {
  return {
    chair: alice,
    decisions: [],
    dissent: [],
    actionItems: [],
    ...(bindingOverride !== undefined ? { artifactBinding: bindingOverride } : { artifactBinding: validBinding })
  }
}

// ---------------------------------------------------------------------------
// C5 — artifact-binding schema validation
// ---------------------------------------------------------------------------

test('C5: valid artifact binding is accepted on createMeeting', () => {
  const meeting = createMeeting(prodBase({ artifactBinding: validBinding }))
  assert.equal(meeting.artifactBinding.outputId, 'game-v1.0')
  assert.equal(meeting.artifactBinding.artifactVersion, 1)
  assert.equal(Object.isFrozen(meeting.artifactBinding), true)
})

test('C5: artifact binding without outputId is rejected', () => {
  const noId = {
    artifactVersion: validBinding.artifactVersion,
    gameSha256: validBinding.gameSha256,
    manifestSha256: validBinding.manifestSha256,
    zipSha256: validBinding.zipSha256,
    approvedBy: validBinding.approvedBy,
    approvedAt: validBinding.approvedAt
  }
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: noId })),
    err => err instanceof MeetingValidationError && /outputId is required/.test(err.message)
  )
})

test('C5: artifact binding with non-positive artifactVersion is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: { ...validBinding, artifactVersion: 0 } })),
    err => err instanceof MeetingValidationError && /artifactVersion must be a positive integer/.test(err.message)
  )
})

test('C5: artifact binding with non-integer artifactVersion is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: { ...validBinding, artifactVersion: 1.5 } })),
    err => err instanceof MeetingValidationError && /artifactVersion must be a positive integer/.test(err.message)
  )
})

test('C5: artifact binding with invalid gameSha256 (not 64 hex chars) is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: { ...validBinding, gameSha256: 'ZZZZ' } })),
    err => err instanceof MeetingValidationError && /gameSha256/.test(err.message)
  )
})

test('C5: artifact binding with uppercase hex in sha256 is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: { ...validBinding, manifestSha256: 'A'.repeat(64) } })),
    err => err instanceof MeetingValidationError && /manifestSha256/.test(err.message)
  )
})

test('C5: artifact binding without approvedBy is rejected', () => {
  const noApprovedBy = {
    outputId: validBinding.outputId,
    artifactVersion: validBinding.artifactVersion,
    gameSha256: validBinding.gameSha256,
    manifestSha256: validBinding.manifestSha256,
    zipSha256: validBinding.zipSha256,
    approvedAt: validBinding.approvedAt
  }
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: noApprovedBy })),
    err => err instanceof MeetingValidationError && /approvedBy is required/.test(err.message)
  )
})

test('C5: artifact binding with non-number approvedAt is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ artifactBinding: { ...validBinding, approvedAt: 'now' } })),
    err => err instanceof MeetingValidationError && /approvedAt must be a number/.test(err.message)
  )
})

test('C5: artifact binding on a non-production meeting (no orchestrator) is rejected', () => {
  assert.throws(
    () => createMeeting(base({ artifactBinding: validBinding })),
    err => err instanceof MeetingValidationError && /artifactBinding requires orchestrator and producer/.test(err.message)
  )
})

test('C5: artifact binding round-trips through serialize/hydrate', () => {
  const meeting = createMeeting(prodBase({ artifactBinding: validBinding }))
  const hydrated = hydrateMeeting(serializeMeeting(meeting))
  assert.deepEqual(hydrated.artifactBinding, meeting.artifactBinding)
  assert.equal(Object.isFrozen(hydrated.artifactBinding), true)
})

// ---------------------------------------------------------------------------
// C6 — production stages FSM
// ---------------------------------------------------------------------------

test('C6: MEETING_PRODUCTION_STAGES exports all 8 stages as a frozen array', () => {
  const expected = ['briefing', 'working', 'production_ready', 'producing', 'reviewing', 'changes_requested', 'approval_ready', 'completed']
  assert.deepEqual([...MEETING_PRODUCTION_STAGES], expected)
  assert.equal(Object.isFrozen(MEETING_PRODUCTION_STAGES), true)
})

test('C6: productionStage is set on createMeeting', () => {
  const meeting = createMeeting(prodBase({ productionStage: 'briefing' }))
  assert.equal(meeting.productionStage, 'briefing')
})

test('C6: productionStage on non-production meeting is rejected', () => {
  assert.throws(
    () => createMeeting(base({ productionStage: 'briefing' })),
    err => err instanceof MeetingValidationError && /productionStage requires orchestrator and producer/.test(err.message)
  )
})

test('C6: invalid productionStage value is rejected', () => {
  assert.throws(
    () => createMeeting(prodBase({ productionStage: 'unknown_stage' })),
    err => err instanceof MeetingValidationError && /not a valid production stage/.test(err.message)
  )
})

test('C6: advanceProductionStage advances stage on production meeting', () => {
  const meeting = createMeeting(prodBase({ productionStage: 'briefing' }))
  const advanced = advanceProductionStage(meeting, 'working')
  assert.equal(advanced.productionStage, 'working')
  // original unchanged
  assert.equal(meeting.productionStage, 'briefing')
})

test('C6: advanceProductionStage rejects invalid stage', () => {
  const meeting = createMeeting(prodBase())
  assert.throws(
    () => advanceProductionStage(meeting, 'nonexistent'),
    err => err instanceof MeetingValidationError && /not a valid production stage/.test(err.message)
  )
})

test('C6: advanceProductionStage rejects non-production meeting', () => {
  const meeting = createMeeting(base())
  assert.throws(
    () => advanceProductionStage(meeting, 'briefing'),
    err => err instanceof MeetingTransitionError && /requires orchestrator and producer/.test(err.message)
  )
})

test('C6: productionStage round-trips through serialize/hydrate', () => {
  const meeting = createMeeting(prodBase({ productionStage: 'producing' }))
  const hydrated = hydrateMeeting(serializeMeeting(meeting))
  assert.equal(hydrated.productionStage, 'producing')
})

test('C6: productionStage absent on ordinary meeting after hydrate', () => {
  const meeting = createMeeting(base())
  const hydrated = hydrateMeeting(serializeMeeting(meeting))
  assert.equal(hydrated.productionStage, undefined)
})

// ---------------------------------------------------------------------------
// C4 — hard completion gate
// ---------------------------------------------------------------------------

test('C4: production meeting with valid artifactBinding can be concluded', () => {
  const m = startMeeting(createMeeting(prodBase()))
  const concluded = concludeMeeting(m, prodConclusion())
  assert.equal(concluded.state, 'completed')
  assert.deepEqual(concluded.artifactBinding.outputId, validBinding.outputId)
})

test('C4: production meeting without artifactBinding cannot be concluded', () => {
  const m = startMeeting(createMeeting(prodBase()))
  assert.throws(
    () => concludeMeeting(m, prodConclusion(null)),
    err => err instanceof MeetingTransitionError && /cannot complete without an approved artifact binding/.test(err.message)
  )
})

test('C4: production meeting with invalid artifactBinding (bad sha) is rejected at conclude', () => {
  const badBinding = { ...validBinding, zipSha256: 'not-valid' }
  const m = startMeeting(createMeeting(prodBase()))
  assert.throws(
    () => concludeMeeting(m, prodConclusion(badBinding)),
    err => err instanceof MeetingValidationError && /zipSha256/.test(err.message)
  )
})

test('C4: ordinary meeting concludes without any artifact binding', () => {
  const m = startMeeting(createMeeting(base()))
  const concluded = concludeMeeting(m, {
    chair: alice,
    decisions: [],
    dissent: [],
    actionItems: []
  })
  assert.equal(concluded.state, 'completed')
  assert.equal(concluded.artifactBinding, undefined)
})

test('C4: production meeting pre-loaded with artifactBinding can conclude without passing binding again', () => {
  const m = startMeeting(createMeeting(prodBase({ artifactBinding: validBinding })))
  const concluded = concludeMeeting(m, { chair: alice, decisions: [], dissent: [], actionItems: [] })
  assert.equal(concluded.state, 'completed')
  assert.deepEqual(concluded.artifactBinding.outputId, validBinding.outputId)
})

test('C4: production meeting at completed state cannot be hydrated without artifactBinding', () => {
  const m = startMeeting(createMeeting(prodBase()))
  const concluded = concludeMeeting(m, prodConclusion())
  const raw = JSON.parse(serializeMeeting(concluded))
  delete raw.artifactBinding
  assert.throws(
    () => hydrateMeeting(JSON.stringify(raw)),
    err => err instanceof MeetingValidationError && /cannot complete without an approved artifact binding/.test(err.message)
  )
})

test('C4: production meeting with valid artifact binding round-trips through hydrate in completed state', () => {
  const m = startMeeting(createMeeting(prodBase()))
  const concluded = concludeMeeting(m, prodConclusion())
  const hydrated = hydrateMeeting(serializeMeeting(concluded))
  assert.equal(hydrated.state, 'completed')
  assert.deepEqual(hydrated.artifactBinding.gameSha256, validBinding.gameSha256)
})

test('C4: production meeting does NOT auto-complete via all-pass rounds', () => {
  let m = startMeeting(createMeeting(prodBase()))
  m = submitContribution(m, { participant: alice, kind: 'pass' })
  m = submitContribution(m, { participant: bob, kind: 'pass' })
  // rounds exhaust but production meetings must not auto-complete
  assert.notEqual(m.state, 'completed')
})

test('C4: production meeting does NOT auto-complete at round cap', () => {
  let m = startMeeting(createMeeting(prodBase({ maxRounds: 1 })))
  m = submitContribution(m, { participant: alice, kind: 'speak', text: 'Progress.' })
  m = submitContribution(m, { participant: bob, kind: 'pass' })
  assert.notEqual(m.state, 'completed')
})
