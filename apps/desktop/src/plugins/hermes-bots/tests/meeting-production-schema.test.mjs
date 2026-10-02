import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMeeting,
  hydrateMeeting,
  MEETING_LIMITS,
  MEETING_SEAT_ROLES,
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
