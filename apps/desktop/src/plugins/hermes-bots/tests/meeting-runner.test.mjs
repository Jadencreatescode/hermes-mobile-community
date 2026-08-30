import assert from 'node:assert/strict'
import test from 'node:test'

import { createMeeting, startMeeting } from '../meeting-model.mjs'
import { runStructuredMeetingRound } from '../meeting-runner.mjs'

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
  assert.ok(calls.find(call => call.method === 'prompt.submit').params.text.includes('Round 1 of 2'))
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
