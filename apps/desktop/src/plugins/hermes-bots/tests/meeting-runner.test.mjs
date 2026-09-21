import assert from 'node:assert/strict'
import test from 'node:test'

import { createMeeting, startMeeting } from '../meeting-model.mjs'
import { filterMeetingHistory, meetingMarker, runStructuredMeetingRound, stripMeetingMarkers } from '../meeting-runner.mjs'

const chair = { connectionId: 'vps', profile: 'research' }
const reviewer = { connectionId: 'bridge', profile: 'reviewer' }

function meeting() {
  return startMeeting(createMeeting({
    id: 'meeting-integration-1',
    source: { connectionId: 'vps', profile: 'default' },
    title: 'Release review',
    agenda: 'Review the evidence and decide whether the release is ready.',
    chair,
    participants: [chair, reviewer],
    maxRounds: 2
  }))
}

test('meeting markers are exact and stripped only from matching user prompts', () => {
  assert.equal(meetingMarker('meeting-1'), '<hermes-meeting id="meeting-1">')
  assert.deepEqual(stripMeetingMarkers([
    { role: 'user', content: '<hermes-meeting id="meeting-1">\nMeeting direction' },
    { role: 'assistant', content: 'Meeting reply' },
    { role: 'user', content: '<hermes-meeting id="other">\nPrivate direction' }
  ], 'meeting-1'), [
    { role: 'user', content: 'Meeting direction' },
    { role: 'assistant', content: 'Meeting reply' },
    { role: 'user', content: '<hermes-meeting id="other">\nPrivate direction' }
  ])
})

test('meeting history keeps only the exact marked conversation segment', () => {
  assert.deepEqual(filterMeetingHistory([
    { role: 'user', content: 'General request' },
    { role: 'assistant', content: 'Private reply' },
    { role: 'user', content: '<hermes-meeting id="meeting-1">\nMeeting direction' },
    { role: 'assistant', content: 'Meeting reply' },
    { role: 'system', content: 'Meeting status' },
    { role: 'user', content: 'Later general request' },
    { role: 'assistant', content: 'Later private reply' }
  ], 'meeting-1'), [
    { role: 'user', content: 'Meeting direction' },
    { role: 'assistant', content: 'Meeting reply' },
    { role: 'system', content: 'Meeting status' }
  ])
})

test('runner creates source-scoped hidden sessions and records one ordered round', async () => {
  const calls = []
  const replies = new Map([
    ['vps::research', 'Evidence is complete.'],
    ['bridge::reviewer', '(pass)']
  ])
  const messageCounts = new Map()
  const request = async (route, method, params) => {
    const key = `${route.connectionId}::${route.profile}`
    calls.push({ key, method, params })
    if (method === 'session.create') {
      return { session_id: `runtime-${key}`, stored_session_id: `stored-${key}` }
    }
    if (method === 'session.resume') {
      const count = messageCounts.get(key) || 0
      return count
        ? { session_id: `runtime-${key}`, messages: [{ role: 'assistant', content: replies.get(key) }], running: false }
        : { session_id: `runtime-${key}`, messages: [], running: false }
    }
    if (method === 'prompt.submit') {
      messageCounts.set(key, 1)
      return { ok: true }
    }
    throw new Error(`unexpected ${method}`)
  }

  const result = await runStructuredMeetingRound(meeting(), {
    request,
    sleep: async () => undefined,
    maxPolls: 2
  })

  assert.equal(result.meeting.currentRound, 2)
  assert.deepEqual(result.meeting.contributions.map(entry => [entry.participant, entry.kind, entry.text]), [
    [chair, 'speak', 'Evidence is complete.'],
    [reviewer, 'pass', '']
  ])
  assert.deepEqual(result.sessions, {
    'vps::research': 'stored-vps::research',
    'bridge::reviewer': 'stored-bridge::reviewer'
  })
  const creates = calls.filter(call => call.method === 'session.create')
  assert.deepEqual(creates.map(call => [call.key, call.params.hidden, call.params.title]), [
    ['vps::research', true, 'Meeting: meeting-integration-1'],
    ['bridge::reviewer', true, 'Meeting: meeting-integration-1']
  ])
  const firstPrompt = calls.find(call => call.method === 'prompt.submit').params.text
  assert.ok(firstPrompt.startsWith(`${meetingMarker('meeting-integration-1')}\n`))
  assert.equal(firstPrompt.split(meetingMarker('meeting-integration-1')).length - 1, 1)
  assert.ok(firstPrompt.includes('Round 1 of 2'))
})

test('participant start is awaited immediately before each incomplete seat and skips completed seats', async () => {
  const current = {
    ...meeting(),
    contributions: [{
      id: 'chair-complete',
      round: 1,
      participant: chair,
      kind: 'speak',
      text: 'Chair evidence',
      evidenceRefs: []
    }]
  }
  const events = []
  let resumes = 0
  const request = async (route, method) => {
    events.push(`${method}:${route.profile}`)
    if (method === 'session.create') return { session_id: 'runtime-reviewer', stored_session_id: 'stored-reviewer' }
    if (method === 'session.resume') {
      resumes += 1
      return resumes === 1
        ? { session_id: 'runtime-reviewer', messages: [], running: false }
        : { session_id: 'runtime-reviewer', messages: [{ role: 'assistant', content: '(pass)' }], running: false }
    }
    if (method === 'prompt.submit') return { ok: true }
    throw new Error(`unexpected ${method}`)
  }

  await runStructuredMeetingRound(current, {
    request,
    sleep: async () => undefined,
    maxPolls: 1,
    onParticipantStart: async participant => {
      events.push(`start:${participant.profile}`)
      await Promise.resolve()
      events.push(`started:${participant.profile}`)
    }
  })

  assert.deepEqual(events, [
    'start:reviewer',
    'started:reviewer',
    'session.create:reviewer',
    'session.resume:reviewer',
    'prompt.submit:reviewer',
    'session.resume:reviewer'
  ])
})

test('checkpoint callback receives contribution and waiting states with copied sessions', async () => {
  const checkpoints = []
  const events = []
  const onCheckpoint = async ({ meeting: checkpointMeeting, pending, sessions }) => {
    const label = `${checkpointMeeting.contributions.length}:${pending?.kind || 'none'}`
    checkpoints.push({
      state: checkpointMeeting.state,
      contributionCount: checkpointMeeting.contributions.length,
      pendingKind: pending?.kind || null,
      sessions,
      sessionValues: { ...sessions }
    })
    sessions.__checkpointMutation = label
    events.push(`checkpoint:start:${label}`)
    await new Promise(resolve => setImmediate(resolve))
    events.push(`checkpoint:end:${label}`)
  }

  const resumeCounts = new Map()
  const normalResult = await runStructuredMeetingRound(meeting(), {
    request: async (route, method) => {
      const key = `${route.connectionId}::${route.profile}`
      events.push(`${method}:${key}`)
      if (method === 'session.create') {
        return { session_id: `runtime-${key}`, stored_session_id: `stored-${key}` }
      }
      if (method === 'session.resume') {
        const count = resumeCounts.get(key) || 0
        resumeCounts.set(key, count + 1)
        if (key === 'bridge::reviewer') {
          return {
            session_id: `runtime-${key}`,
            messages: [],
            running: false,
            pending_clarify: { request_id: 'clarify-reviewer', question: 'Which artifact?' }
          }
        }
        return count === 0
          ? { session_id: `runtime-${key}`, messages: [], running: false }
          : { session_id: `runtime-${key}`, messages: [{ role: 'assistant', content: 'Chair evidence' }], running: false }
      }
      if (method === 'prompt.submit') return { ok: true }
      throw new Error(`unexpected ${method}`)
    },
    sleep: async () => undefined,
    maxPolls: 1,
    onCheckpoint
  })

  const recoveredWaiting = {
    ...meeting(),
    pending: {
      kind: 'timeout',
      participant: reviewer,
      session: 'stored-reviewer',
      before: 0
    }
  }
  const recoveredWaitingResult = await runStructuredMeetingRound(recoveredWaiting, {
    request: async (_route, method) => {
      if (method === 'session.resume') {
        return { session_id: 'runtime-reviewer', messages: [], running: true }
      }
      throw new Error(`unexpected ${method}`)
    },
    sessions: { 'bridge::reviewer': 'stored-reviewer' },
    sleep: async () => undefined,
    maxPolls: 1,
    onCheckpoint
  })

  const recoveredContribution = {
    ...meeting(),
    contributions: [{
      id: 'chair-complete',
      round: 1,
      participant: chair,
      kind: 'speak',
      text: 'Chair evidence',
      evidenceRefs: []
    }],
    pending: {
      kind: 'timeout',
      participant: reviewer,
      session: 'stored-reviewer',
      before: 0
    }
  }
  const recoveredContributionResult = await runStructuredMeetingRound(recoveredContribution, {
    request: async (_route, method) => {
      if (method === 'session.resume') {
        return {
          session_id: 'runtime-reviewer',
          messages: [{ role: 'assistant', content: 'Recovered reviewer evidence' }],
          running: false
        }
      }
      throw new Error(`unexpected ${method}`)
    },
    sessions: { 'bridge::reviewer': 'stored-reviewer' },
    sleep: async () => undefined,
    maxPolls: 1,
    onCheckpoint
  })

  assert.deepEqual(checkpoints.map(checkpoint => [
    checkpoint.state,
    checkpoint.contributionCount,
    checkpoint.pendingKind,
    checkpoint.sessionValues
  ]), [
    ['running', 1, null, { 'vps::research': 'stored-vps::research' }],
    ['waiting', 1, 'clarify', {
      'vps::research': 'stored-vps::research',
      'bridge::reviewer': 'stored-bridge::reviewer'
    }],
    ['waiting', 0, 'timeout', { 'bridge::reviewer': 'stored-reviewer' }],
    ['running', 2, null, { 'bridge::reviewer': 'stored-reviewer' }]
  ])
  assert.equal(new Set(checkpoints.map(checkpoint => checkpoint.sessions)).size, checkpoints.length)
  assert.equal(events.indexOf('checkpoint:end:1:none') < events.indexOf('session.create:bridge::reviewer'), true)
  assert.equal(events.at(-1), 'checkpoint:end:2:none')
  assert.equal(normalResult.sessions.__checkpointMutation, undefined)
  assert.equal(recoveredWaitingResult.sessions.__checkpointMutation, undefined)
  assert.equal(recoveredContributionResult.sessions.__checkpointMutation, undefined)
})

test('pending human input waits the meeting instead of inventing a pass', async () => {
  const request = async (route, method) => {
    if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored' }
    if (method === 'session.resume') {
      return {
        session_id: 'runtime',
        messages: [],
        running: false,
        pending_clarify: { request_id: 'clarify-1', question: 'Which release target?' }
      }
    }
    if (method === 'prompt.submit') return { ok: true }
    throw new Error(`${route.connectionId}:${method}`)
  }

  const result = await runStructuredMeetingRound(meeting(), {
    request,
    sleep: async () => undefined,
    maxPolls: 1
  })

  assert.equal(result.meeting.state, 'waiting')
  assert.equal(result.meeting.contributions.length, 0)
  assert.equal(result.pending.kind, 'clarify')
  assert.deepEqual(result.pending.participant, chair)
})

test('a bounded timeout waits for owner recovery and never invents a pass', async () => {
  let polls = 0
  const request = async (_route, method) => {
    if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored' }
    if (method === 'session.resume') {
      polls += 1
      return { session_id: 'runtime', messages: [], running: true }
    }
    if (method === 'prompt.submit') return { ok: true }
    return {}
  }

  const result = await runStructuredMeetingRound(meeting(), {
    request,
    sleep: async () => undefined,
    maxPolls: 2
  })

  assert.ok(polls <= 6)
  assert.equal(result.meeting.state, 'waiting')
  assert.equal(result.meeting.contributions.length, 0)
  assert.equal(result.pending.kind, 'timeout')
})

test('a prompt without a new assistant reply never reuses an older round response', async () => {
  let resumes = 0
  const oldReply = { role: 'assistant', content: 'Old evidence from another round.' }
  const request = async (_route, method) => {
    if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored' }
    if (method === 'session.resume') {
      resumes += 1
      return resumes === 1
        ? { session_id: 'runtime', messages: [oldReply], running: false }
        : {
            session_id: 'runtime',
            messages: [oldReply, { role: 'user', content: 'Current round prompt.' }],
            running: false
          }
    }
    if (method === 'prompt.submit') return { ok: true }
    throw new Error(`unexpected ${method}`)
  }

  const result = await runStructuredMeetingRound(meeting(), {
    request,
    sleep: async () => undefined,
    maxPolls: 1
  })

  assert.equal(result.meeting.state, 'waiting')
  assert.equal(result.meeting.contributions.length, 0)
  assert.equal(result.pending.kind, 'timeout')
})


test('a failed baseline resume waits without submitting or replaying old history', async () => {
  let submits = 0
  const request = async (_route, method) => {
    if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored' }
    if (method === 'session.resume') throw new Error('temporary resume failure')
    if (method === 'prompt.submit') {
      submits += 1
      return { ok: true }
    }
    throw new Error(`unexpected ${method}`)
  }

  const result = await runStructuredMeetingRound(meeting(), {
    request,
    sleep: async () => undefined,
    maxPolls: 1
  })

  assert.equal(submits, 0)
  assert.equal(result.meeting.state, 'waiting')
  assert.equal(result.meeting.contributions.length, 0)
  assert.equal(result.pending.kind, 'baseline')
  assert.equal(result.pending.before, null)
})


test('resume harvests the pending participant and never replays completed seats', async () => {
  let current = meeting()
  current = {
    ...current,
    contributions: [{
      id: 'first',
      round: 1,
      participant: chair,
      kind: 'speak',
      text: 'Chair evidence',
      evidenceRefs: []
    }],
    pending: {
      kind: 'timeout',
      participant: reviewer,
      session: 'stored-reviewer',
      before: 0
    }
  }
  let submits = 0
  const request = async (_route, method) => {
    if (method === 'prompt.submit') {
      submits += 1
      return { ok: true }
    }
    if (method === 'session.resume') {
      return {
        session_id: 'runtime-reviewer',
        messages: [{ role: 'assistant', content: 'Reviewer evidence' }],
        running: false
      }
    }
    throw new Error(`unexpected ${method}`)
  }

  const result = await runStructuredMeetingRound(current, {
    request,
    sessions: { 'bridge::reviewer': 'stored-reviewer' },
    sleep: async () => undefined,
    maxPolls: 1
  })

  assert.equal(submits, 0)
  assert.equal(result.meeting.currentRound, 2)
  assert.deepEqual(result.meeting.contributions.map(entry => entry.text), ['Chair evidence', 'Reviewer evidence'])
  assert.equal(result.pending, null)
})
