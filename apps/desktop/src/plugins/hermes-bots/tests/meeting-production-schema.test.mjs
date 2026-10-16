import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceProductionStage,
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  hydrateMeeting,
  isProductionMeeting,
  MEETING_LIMITS,
  MEETING_PRODUCT_KINDS,
  MEETING_PRODUCTION_STAGES,
  MEETING_SCHEMA_VERSION,
  MEETING_SEAT_ROLES,
  MeetingTransitionError,
  MeetingValidationError,
  serializeMeeting,
  startMeeting,
  submitContribution
} from '../meeting-model.mjs'
import { meetingRoleRestrictions } from '../meeting-runner.mjs'

// ---------------------------------------------------------------------------
// Shared dummy route fixtures
// ---------------------------------------------------------------------------

const orchestrator = Object.freeze({ connectionId: 'local', profile: 'orchestrator' })
const producer = Object.freeze({ connectionId: 'local', profile: 'producer' })
const reviewer = Object.freeze({ connectionId: 'local', profile: 'reviewer' })
const analyst = Object.freeze({ connectionId: 'local', profile: 'analyst' })

function conclusionInput(overrides = {}) {
  return {
    id: 'meeting-conclusion-1',
    source: { connectionId: 'local', profile: 'default' },
    title: 'Weekly review',
    agenda: 'Decide whether to publish.',
    chair: orchestrator,
    participants: [orchestrator, producer],
    maxRounds: 3,
    ...overrides
  }
}

function productionInput(overrides = {}) {
  return {
    id: 'meeting-production-1',
    source: { connectionId: 'local', profile: 'default' },
    title: 'Ship the onboarding guide',
    agenda: 'Produce and review the onboarding guide.',
    chair: orchestrator,
    participants: [orchestrator, producer, reviewer],
    maxRounds: 3,
    orchestrator,
    producer,
    seats: [
      { bot: orchestrator, role: 'specialist', label: 'Orchestrator' },
      { bot: producer, role: 'contributor', label: 'Producer' },
      { bot: reviewer, role: 'reviewer', label: 'Independent reviewer' }
    ],
    productKind: 'document',
    outputTitle: 'Onboarding guide',
    acceptanceStatement: 'A reviewer confirms every onboarding step is reproducible.',
    ...overrides
  }
}

const binding = Object.freeze({
  outputId: 'mout_1',
  artifactVersion: 1,
  gameSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  zipSha256: 'c'.repeat(64),
  approvedBy: 'Owner',
  approvedAt: 1_800_000_000
})

// ---------------------------------------------------------------------------
// canonical schema v2
// ---------------------------------------------------------------------------

test('every new meeting carries canonical schema version 2', () => {
  assert.equal(MEETING_SCHEMA_VERSION, 2)
  assert.equal(createMeeting(conclusionInput()).schemaVersion, 2)
  assert.equal(createMeeting(productionInput()).schemaVersion, 2)
})

test('a production meeting keeps the complete bundle and starts at briefing', () => {
  const meeting = createMeeting(productionInput())

  assert.equal(isProductionMeeting(meeting), true)
  assert.deepEqual(meeting.orchestrator, orchestrator)
  assert.deepEqual(meeting.producer, producer)
  assert.equal(meeting.productKind, 'document')
  assert.equal(meeting.outputTitle, 'Onboarding guide')
  assert.equal(meeting.productionStage, 'briefing')
  assert.equal(meeting.seats.length, 3)
  assert.equal(meeting.artifactBinding, undefined)
})

test('a conclusion meeting carries no production field at all', () => {
  const meeting = createMeeting(conclusionInput())

  assert.equal(isProductionMeeting(meeting), false)
  for (const field of [
    'orchestrator', 'producer', 'seats', 'productKind', 'outputTitle',
    'acceptanceStatement', 'productionStage', 'artifactBinding'
  ]) {
    assert.equal(meeting[field], undefined, field)
  }
})

test('the legal production stages and product kinds are bounded', () => {
  assert.deepEqual(MEETING_PRODUCTION_STAGES, [
    'briefing', 'working', 'production_ready', 'producing',
    'reviewing', 'changes_requested', 'approval_ready', 'completed'
  ])
  assert.deepEqual([...MEETING_PRODUCT_KINDS].sort(), [
    'audio_asset', 'document', 'interactive_web_app', 'three_scene', 'video_asset'
  ])
  assert.ok(Object.prototype.hasOwnProperty.call(MEETING_SEAT_ROLES, 'reviewer'))
})

// ---------------------------------------------------------------------------
// all-or-none production bundle
// ---------------------------------------------------------------------------

for (const missing of ['orchestrator', 'producer', 'seats', 'productKind', 'outputTitle', 'acceptanceStatement']) {
  test(`a production bundle missing ${missing} is refused`, () => {
    const input = productionInput()
    delete input[missing]
    assert.throws(() => createMeeting(input), MeetingValidationError)
  })
}

test('production-only fields on a conclusion meeting are refused', () => {
  for (const [field, value] of [
    ['productKind', 'document'],
    ['outputTitle', 'Guide'],
    ['acceptanceStatement', 'Reviewed.'],
    ['productionStage', 'briefing'],
    ['artifactBinding', binding],
    ['seats', [{ bot: orchestrator, role: 'reviewer', label: 'O' }]]
  ]) {
    assert.throws(
      () => createMeeting(conclusionInput({ [field]: value })),
      MeetingValidationError,
      field
    )
  }
})

test('orchestrator and producer must be distinct participants', () => {
  assert.throws(
    () => createMeeting(productionInput({ producer: orchestrator })),
    MeetingValidationError
  )
  assert.throws(
    () => createMeeting(productionInput({ orchestrator: { connectionId: 'local', profile: 'stranger' } })),
    MeetingValidationError
  )
})

test('seats must be an ordered one-to-one assignment of the participants', () => {
  const cases = [
    [
      { bot: orchestrator, role: 'specialist', label: 'O' },
      { bot: orchestrator, role: 'contributor', label: 'O again' },
      { bot: reviewer, role: 'reviewer', label: 'R' }
    ],
    [
      { bot: orchestrator, role: 'specialist', label: 'O' },
      { bot: reviewer, role: 'reviewer', label: 'R' }
    ],
    [
      { bot: orchestrator, role: 'specialist', label: 'O' },
      { bot: producer, role: 'contributor', label: 'P' },
      { bot: analyst, role: 'reviewer', label: 'Stranger' }
    ]
  ]

  for (const seats of cases) {
    assert.throws(() => createMeeting(productionInput({ seats })), MeetingValidationError)
  }
})

test('at least one reviewer seat is required and must be independent', () => {
  assert.throws(() => createMeeting(productionInput({
    seats: [
      { bot: orchestrator, role: 'specialist', label: 'O' },
      { bot: producer, role: 'contributor', label: 'P' },
      { bot: reviewer, role: 'thinker', label: 'R' }
    ]
  })), MeetingValidationError)

  for (const impostor of [orchestrator, producer]) {
    assert.throws(() => createMeeting(productionInput({
      seats: [
        { bot: orchestrator, role: impostor === orchestrator ? 'reviewer' : 'specialist', label: 'O' },
        { bot: producer, role: impostor === producer ? 'reviewer' : 'contributor', label: 'P' },
        { bot: reviewer, role: 'contributor', label: 'R' }
      ]
    })), MeetingValidationError)
  }
})

test('production requires at least three source-qualified participants', () => {
  assert.throws(() => createMeeting(productionInput({
    participants: [orchestrator, producer],
    seats: [
      { bot: orchestrator, role: 'specialist', label: 'O' },
      { bot: producer, role: 'reviewer', label: 'P' }
    ]
  })), MeetingValidationError)
})

test('product kind, output title, and acceptance statement are bounded', () => {
  assert.throws(() => createMeeting(productionInput({ productKind: 'nuclear_reactor' })), MeetingValidationError)
  assert.throws(
    () => createMeeting(productionInput({ outputTitle: 'x'.repeat(MEETING_LIMITS.maxTitleLength + 1) })),
    MeetingValidationError
  )
  assert.throws(
    () => createMeeting(productionInput({
      acceptanceStatement: 'x'.repeat(MEETING_LIMITS.maxAcceptanceStatementLength + 1)
    })),
    MeetingValidationError
  )
})

// ---------------------------------------------------------------------------
// server-owned artifact binding
// ---------------------------------------------------------------------------

test('a client cannot author an artifact binding at creation', () => {
  assert.throws(
    () => createMeeting(productionInput({ artifactBinding: binding })),
    MeetingValidationError
  )
})

test('a client cannot choose any production stage other than briefing at creation', () => {
  assert.equal(createMeeting(productionInput({ productionStage: 'briefing' })).productionStage, 'briefing')
  for (const stage of ['working', 'producing', 'approval_ready', 'completed']) {
    assert.throws(
      () => createMeeting(productionInput({ productionStage: stage })),
      MeetingValidationError,
      stage
    )
  }
})

test('a hydrated artifact binding must carry the non-identifying Owner label', () => {
  const approved = {
    ...createMeeting(productionInput()),
    state: 'completed',
    currentRound: 1,
    productionStage: 'completed',
    artifactBinding: binding
  }

  assert.deepEqual(hydrateMeeting(JSON.stringify(approved)).artifactBinding, binding)

  for (const bad of [
    { ...binding, approvedBy: 'jane@example.test' },
    { ...binding, approvedBy: '' },
    { ...binding, gameSha256: 'not-a-digest' },
    { ...binding, artifactVersion: 0 },
    { ...binding, approvedAt: -1 }
  ]) {
    assert.throws(
      () => hydrateMeeting(JSON.stringify({ ...approved, artifactBinding: bad })),
      MeetingValidationError
    )
  }
})

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

test('the generic conclude path refuses a production meeting', () => {
  const running = startMeeting(createMeeting(productionInput()))

  assert.throws(
    () => concludeMeeting(running, {
      chair: orchestrator,
      decisions: [],
      dissent: [],
      actionItems: []
    }),
    MeetingTransitionError
  )
  assert.throws(
    () => concludeMeeting(running, {
      artifactBinding: binding,
      chair: orchestrator,
      decisions: [],
      dissent: [],
      actionItems: []
    }),
    MeetingTransitionError
  )
})

test('a conclusion meeting still concludes through the existing path', () => {
  const running = startMeeting(createMeeting(conclusionInput()))
  const completed = concludeMeeting(running, {
    chair: orchestrator,
    decisions: [{ id: 'd1', text: 'Publish.', evidenceRefs: [] }],
    dissent: [],
    actionItems: [{
      id: 'publish',
      ownerRoute: producer,
      title: 'Publish the changelog',
      acceptanceCriteria: 'The changelog is live.',
      priority: 'normal',
      dueIntent: 'This week'
    }]
  })

  assert.equal(completed.state, 'completed')
  assert.equal(completed.decisions.length, 1)
  assert.equal(completed.actionItems[0].dedupeKey, 'meeting:meeting-conclusion-1:action:publish')
  assert.equal(completed.artifactBinding, undefined)
  assert.equal(completed.productionStage, undefined)
})

test('a production meeting does not auto-complete on all-pass or max round', () => {
  let meeting = startMeeting(createMeeting(productionInput({ maxRounds: 1 })))
  for (const participant of [orchestrator, producer, reviewer]) {
    meeting = submitContribution(meeting, { participant, kind: 'pass' })
  }

  assert.equal(meeting.state, 'running')
  assert.equal(meeting.productionStage, 'briefing')
})

test('a conclusion meeting still auto-completes on all-pass', () => {
  let meeting = startMeeting(createMeeting(conclusionInput({ maxRounds: 1 })))
  for (const participant of [orchestrator, producer]) {
    meeting = submitContribution(meeting, { participant, kind: 'pass' })
  }

  assert.equal(meeting.state, 'completed')
})

test('the production stage ladder is exact and never reaches completed locally', () => {
  const running = startMeeting(createMeeting(productionInput()))

  const working = advanceProductionStage(running, 'working')
  assert.equal(working.productionStage, 'working')
  assert.equal(advanceProductionStage(working, 'production_ready').productionStage, 'production_ready')

  assert.throws(() => advanceProductionStage(running, 'producing'), MeetingTransitionError)
  assert.throws(() => advanceProductionStage(running, 'completed'), MeetingTransitionError)
  assert.throws(() => advanceProductionStage(running, 'not_a_stage'), MeetingValidationError)
  assert.throws(
    () => advanceProductionStage(startMeeting(createMeeting(conclusionInput())), 'working'),
    MeetingTransitionError
  )
})

test('cancellation freezes a production lifecycle without completing it', () => {
  const cancelled = cancelMeeting(startMeeting(createMeeting(productionInput())))

  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.artifactBinding, undefined)
  assert.throws(() => advanceProductionStage(cancelled, 'working'), MeetingTransitionError)
})

// ---------------------------------------------------------------------------
// hydration
// ---------------------------------------------------------------------------

test('a production meeting round-trips through serialize and hydrate', () => {
  const meeting = startMeeting(createMeeting(productionInput()))
  const hydrated = hydrateMeeting(serializeMeeting(meeting))

  assert.deepEqual(hydrated.seats.map(seat => seat.role), ['specialist', 'contributor', 'reviewer'])
  assert.equal(hydrated.productKind, 'document')
  assert.equal(hydrated.acceptanceStatement, meeting.acceptanceStatement)
  assert.equal(hydrated.productionStage, 'briefing')
  assert.equal(Object.isFrozen(hydrated.seats), true)
})

test('a hydrated production meeting preserves a server-advanced stage', () => {
  const meeting = {
    ...startMeeting(createMeeting(productionInput())),
    productionStage: 'reviewing'
  }

  assert.equal(hydrateMeeting(JSON.stringify(meeting)).productionStage, 'reviewing')
})

test('a legacy record without a schema version hydrates as a conclusion meeting', () => {
  const legacy = {
    id: 'meeting-legacy-1',
    source: { connectionId: 'local', profile: 'default' },
    title: 'Legacy meeting',
    agenda: 'Legacy agenda.',
    chair: orchestrator,
    participants: [orchestrator, producer],
    maxRounds: 3,
    currentRound: 1,
    contributions: [{
      id: 'c1',
      round: 1,
      participant: orchestrator,
      kind: 'speak',
      text: 'Legacy text.',
      evidenceRefs: []
    }],
    evidenceRefs: [],
    decisions: [],
    dissent: [],
    actionItems: [],
    state: 'running'
  }

  const hydrated = hydrateMeeting(JSON.stringify(legacy))

  assert.equal(hydrated.schemaVersion, 2)
  assert.equal(isProductionMeeting(hydrated), false)
  assert.equal(hydrated.contributions.length, 1)
})

test('a completed production meeting must carry an approved artifact binding', () => {
  const completed = {
    ...startMeeting(createMeeting(productionInput())),
    state: 'completed',
    currentRound: 1,
    productionStage: 'completed'
  }

  assert.throws(() => hydrateMeeting(JSON.stringify(completed)), MeetingValidationError)
  assert.throws(
    () => hydrateMeeting(JSON.stringify({ ...completed, productionStage: 'approval_ready', artifactBinding: binding })),
    MeetingValidationError
  )
})

// ---------------------------------------------------------------------------
// role-specific session policy
// ---------------------------------------------------------------------------

test('an ordinary discussion turn stays clarify-only with no cwd', () => {
  const policy = meetingRoleRestrictions()

  assert.deepEqual(policy.enabled_toolsets, ['clarify'])
  assert.equal(policy.cwd, undefined)
  assert.equal(policy.skip_memory, true)
  assert.equal(policy.skip_context_files, true)
  assert.equal(policy.skip_background_review, true)
  assert.equal(policy.source, 'meeting')
  assert.deepEqual(meetingRoleRestrictions('discussion'), policy)
})

test('a producer turn adds only file authority and is confined to the minted cwd', () => {
  const policy = meetingRoleRestrictions('producer', { cwd: '/server/owned/workspace' })

  assert.deepEqual([...policy.enabled_toolsets].sort(), ['clarify', 'file'])
  assert.equal(policy.cwd, '/server/owned/workspace')
  assert.equal(policy.skip_memory, true)
  // No terminal or browser authority is ever requested for a producer turn.
  for (const forbidden of ['terminal', 'browser', 'code_execution', 'delegation']) {
    assert.equal(policy.enabled_toolsets.includes(forbidden), false, forbidden)
  }
})

test('a producer turn without a server-minted cwd is refused', () => {
  assert.throws(() => meetingRoleRestrictions('producer'), /server-minted workspace cwd/)
  assert.throws(() => meetingRoleRestrictions('producer', { cwd: '' }), /server-minted workspace cwd/)
})

test('a reviewer turn receives no cwd and no file authority', () => {
  const policy = meetingRoleRestrictions('reviewer')

  assert.deepEqual(policy.enabled_toolsets, ['clarify'])
  assert.equal(policy.cwd, undefined)
  assert.equal(policy.enabled_toolsets.includes('file'), false)
})

test('an unknown turn role is refused rather than silently widened', () => {
  assert.throws(() => meetingRoleRestrictions('owner'), /unknown meeting turn role/)
})
