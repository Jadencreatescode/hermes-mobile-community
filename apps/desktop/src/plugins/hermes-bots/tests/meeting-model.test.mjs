import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildKanbanCreatePayloads,
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  failMeeting,
  hydrateMeeting,
  MEETING_LIMITS,
  MeetingTransitionError,
  MeetingValidationError,
  resumeMeeting,
  serializeMeeting,
  startMeeting,
  submitContribution,
  waitMeeting
} from '../meeting-model.mjs'

const vpsResearch = Object.freeze({ connectionId: 'vps', profile: 'research' })
const bridgeOps = Object.freeze({ connectionId: 'bridge', profile: 'ops' })

function draft(overrides = {}) {
  return createMeeting({
    id: 'meeting-release-1',
    source: { connectionId: 'vps', profile: 'default' },
    title: 'Release readiness',
    agenda: 'Review evidence and decide whether to release.',
    chair: vpsResearch,
    participants: [vpsResearch, bridgeOps],
    maxRounds: 3,
    ...overrides
  })
}

test('createMeeting returns a stable source-qualified draft record', () => {
  const meeting = draft()

  assert.equal(meeting.id, 'meeting-release-1')
  assert.deepEqual(meeting.source, { connectionId: 'vps', profile: 'default' })
  assert.equal(meeting.state, 'draft')
  assert.equal(meeting.currentRound, 0)
  assert.equal(meeting.maxRounds, 3)
  assert.deepEqual(meeting.participants, [vpsResearch, bridgeOps])
  assert.deepEqual(meeting.contributions, [])
  assert.deepEqual(meeting.evidenceRefs, [])
  assert.deepEqual(meeting.decisions, [])
  assert.deepEqual(meeting.dissent, [])
  assert.deepEqual(meeting.actionItems, [])
})

test('duplicate participants collapse by connection and profile in first-seen order', () => {
  const meeting = draft({
    participants: [vpsResearch, { ...vpsResearch }, bridgeOps, { ...bridgeOps }]
  })

  assert.deepEqual(meeting.participants, [vpsResearch, bridgeOps])
})

test('malformed, ambiguous, and out-of-bounds meeting identities fail closed', () => {
  const invalid = [
    { id: '' },
    { source: { profile: 'default' } },
    { chair: { profile: 'research' } },
    { participants: [vpsResearch, { profile: 'ops' }] },
    { participants: [vpsResearch, { ...vpsResearch }] },
    { chair: { connectionId: 'helm', profile: 'chair' } },
    { participants: Array.from({ length: MEETING_LIMITS.maxParticipants + 1 }, (_, index) => ({ connectionId: 'vps', profile: `p${index}` })) },
    { maxRounds: MEETING_LIMITS.maxRounds + 1 },
    { agenda: 'x'.repeat(MEETING_LIMITS.maxAgendaLength + 1) }
  ]

  for (const override of invalid) {
    assert.throws(() => draft(override), MeetingValidationError)
  }
})

test('startMeeting transitions an unchanged draft into round one running', () => {
  const original = draft()
  const started = startMeeting(original)

  assert.equal(original.state, 'draft')
  assert.equal(original.currentRound, 0)
  assert.equal(started.state, 'running')
  assert.equal(started.currentRound, 1)
  assert.notEqual(started, original)
})

test('submitContribution appends an immutable source-qualified speaking turn', () => {
  const submission = {
    participant: { ...vpsResearch },
    kind: 'speak',
    text: 'The release checks are green.',
    evidenceRefs: ['run:desktop-tests']
  }
  const started = startMeeting(draft())
  const updated = submitContribution(started, submission)

  assert.equal(started.contributions.length, 0)
  assert.equal(updated.contributions.length, 1)
  assert.deepEqual(updated.contributions[0], {
    id: 'meeting-release-1:r1:vps:research',
    round: 1,
    participant: vpsResearch,
    kind: 'speak',
    text: 'The release checks are green.',
    evidenceRefs: ['run:desktop-tests']
  })
  assert.equal(Object.isFrozen(updated.contributions[0]), true)
  assert.equal(Object.isFrozen(updated.contributions[0].participant), true)
  assert.equal(Object.isFrozen(updated.contributions[0].evidenceRefs), true)

  submission.participant.profile = 'changed'
  submission.evidenceRefs.push('forged')
  submission.text = 'rewritten'
  assert.equal(updated.contributions[0].participant.profile, 'research')
  assert.deepEqual(updated.contributions[0].evidenceRefs, ['run:desktop-tests'])
  assert.equal(updated.contributions[0].text, 'The release checks are green.')
})

test('rounds accept one speak or pass per participant and only advance after everyone contributes', () => {
  const started = startMeeting(draft())
  const first = submitContribution(started, { participant: vpsResearch, kind: 'speak', text: 'Ready.' })
  const snapshot = JSON.stringify(first)

  assert.equal(first.currentRound, 1)
  assert.throws(
    () => submitContribution(first, { participant: vpsResearch, kind: 'pass' }),
    MeetingTransitionError
  )
  assert.equal(JSON.stringify(first), snapshot)

  const second = submitContribution(first, { participant: bridgeOps, kind: 'pass' })
  assert.equal(second.currentRound, 2)
  assert.equal(second.state, 'running')
  assert.deepEqual(second.contributions.map(entry => entry.kind), ['speak', 'pass'])
})

test('unanimous pass and the hard round cap complete without opening another round', () => {
  let allPass = startMeeting(draft())
  allPass = submitContribution(allPass, { participant: vpsResearch, kind: 'pass' })
  allPass = submitContribution(allPass, { participant: bridgeOps, kind: 'pass' })
  assert.equal(allPass.state, 'completed')
  assert.equal(allPass.currentRound, 1)

  let capped = startMeeting(draft({ maxRounds: 1 }))
  capped = submitContribution(capped, { participant: vpsResearch, kind: 'speak', text: 'Ship.' })
  capped = submitContribution(capped, { participant: bridgeOps, kind: 'pass' })
  assert.equal(capped.state, 'completed')
  assert.equal(capped.currentRound, 1)
  assert.throws(
    () => submitContribution(capped, { participant: vpsResearch, kind: 'pass' }),
    MeetingTransitionError
  )
})

test('waiting resumes while cancellation and failure are terminal and mutation safe', () => {
  const running = startMeeting(draft())
  const waiting = waitMeeting(running)
  assert.equal(waiting.state, 'waiting')
  assert.equal(resumeMeeting(waiting).state, 'running')

  for (const terminal of [cancelMeeting(waiting), failMeeting(running)]) {
    const snapshot = JSON.stringify(terminal)
    assert.throws(() => startMeeting(terminal), MeetingTransitionError)
    assert.throws(() => resumeMeeting(terminal), MeetingTransitionError)
    assert.throws(
      () => submitContribution(terminal, { participant: vpsResearch, kind: 'pass' }),
      MeetingTransitionError
    )
    assert.equal(JSON.stringify(terminal), snapshot)
  }
})

test('chair conclusion records decisions, dissent, and action items without rewriting contributions', () => {
  const contributed = submitContribution(startMeeting(draft()), {
    participant: vpsResearch,
    kind: 'speak',
    text: 'Release evidence is complete.',
    evidenceRefs: ['run:release-suite']
  })
  const originalContribution = contributed.contributions[0]
  const concluded = concludeMeeting(contributed, {
    chair: vpsResearch,
    decisions: [{ id: 'decision-ship', text: 'Ship the release.', evidenceRefs: ['run:release-suite'] }],
    dissent: [{ participant: bridgeOps, text: 'Prefer one more soak cycle.', evidenceRefs: ['risk:soak'] }],
    actionItems: [{
      id: 'publish',
      ownerRoute: bridgeOps,
      title: 'Publish the signed release',
      acceptanceCriteria: 'The signed artifact is available on the private route.',
      priority: 'high',
      dueIntent: 'Before the next owner checkpoint.'
    }]
  })

  assert.equal(concluded.state, 'completed')
  assert.equal(concluded.contributions[0], originalContribution)
  assert.equal(concluded.contributions[0].text, 'Release evidence is complete.')
  assert.deepEqual(concluded.decisions[0], {
    id: 'decision-ship',
    text: 'Ship the release.',
    evidenceRefs: ['run:release-suite']
  })
  assert.deepEqual(concluded.dissent[0].participant, bridgeOps)
  assert.equal(concluded.dissent[0].text, 'Prefer one more soak cycle.')
  assert.equal(concluded.actionItems[0].dedupeKey, 'meeting:meeting-release-1:action:publish')
  assert.throws(
    () => concludeMeeting(contributed, { chair: bridgeOps, decisions: [], dissent: [], actionItems: [] }),
    MeetingTransitionError
  )
})

test('Kanban conversion payloads are deterministic, source-routed, and idempotent', () => {
  const completed = concludeMeeting(startMeeting(draft()), {
    chair: vpsResearch,
    decisions: [],
    dissent: [],
    actionItems: [{
      id: 'publish',
      ownerRoute: bridgeOps,
      title: 'Publish the signed release',
      acceptanceCriteria: 'The signed artifact is available on the private route.',
      priority: 'high',
      dueIntent: 'Before the next owner checkpoint.'
    }]
  })

  const first = buildKanbanCreatePayloads(completed)
  const second = buildKanbanCreatePayloads(completed)
  assert.deepEqual(first, second)
  assert.deepEqual(first, [{
    route: bridgeOps,
    request: {
      title: 'Publish the signed release',
      body: 'Acceptance criteria:\nThe signed artifact is available on the private route.\n\nDue intent:\nBefore the next owner checkpoint.\n\nMeeting: meeting-release-1',
      assignee: 'ops',
      priority: 2,
      idempotency_key: 'meeting:meeting-release-1:action:publish'
    }
  }])
  assert.equal(Object.isFrozen(first[0].request), true)
})

test('serialize and hydrate round trip immutable records and reject malformed or oversized payloads', () => {
  let record = startMeeting(draft())
  record = submitContribution(record, {
    participant: vpsResearch,
    kind: 'speak',
    text: 'Evidence attached.',
    evidenceRefs: ['run:focused']
  })
  const serialized = serializeMeeting(record)
  const hydrated = hydrateMeeting(serialized)

  assert.deepEqual(hydrated, record)
  assert.equal(Object.isFrozen(hydrated), true)
  assert.equal(Object.isFrozen(hydrated.contributions[0]), true)

  const malformed = JSON.parse(serialized)
  malformed.participants[0] = { profile: 'research' }
  assert.throws(() => hydrateMeeting(JSON.stringify(malformed)), MeetingValidationError)

  const duplicateTurn = JSON.parse(serialized)
  duplicateTurn.contributions.push({ ...duplicateTurn.contributions[0] })
  assert.throws(() => hydrateMeeting(JSON.stringify(duplicateTurn)), MeetingValidationError)

  assert.throws(
    () => hydrateMeeting(' '.repeat(MEETING_LIMITS.maxSerializedBytes + 1)),
    MeetingValidationError
  )
})
