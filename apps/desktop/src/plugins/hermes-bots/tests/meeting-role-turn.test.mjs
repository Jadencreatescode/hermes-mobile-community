// The role turn is the ONE session engine a production dispatch uses: the
// existing session.create / session.resume / prompt.submit contract, with the
// role policy from meetingRoleRestrictions and a checkpoint that always lands
// before the prompt does.

import assert from 'node:assert/strict'
import test from 'node:test'

import { runRoleTurn } from '../meeting-runner.mjs'

const producer = Object.freeze({ connectionId: 'local', profile: 'producer' })
const CWD = '/server/owned/workspaces/mrun_1'
const PROMPT = 'Produce the deliverable into ./output.'

function recorder({ replies = [], created = 'runtime-1', stored = 'stored-1' } = {}) {
  const calls = []
  let poll = 0

  const request = async (participant, method, params) => {
    calls.push({ method, params, participant })

    if (method === 'session.create') {
      return { session_id: created, stored_session_id: stored }
    }

    if (method === 'session.resume') {
      const reply = replies[Math.min(poll, replies.length - 1)]
      poll += 1

      return reply ?? { messages: [], session_id: created }
    }

    if (method === 'prompt.submit') {
      return { ok: true }
    }

    throw new Error(`unexpected method: ${method}`)
  }

  return { calls, request }
}

function userMessage(text) {
  return { role: 'user', content: text }
}

function assistantMessage(text) {
  return { role: 'assistant', content: text }
}

test('a producer turn creates its session with the minted cwd and file authority', async () => {
  const { calls, request } = recorder({
    replies: [
      { messages: [], session_id: 'runtime-1' },
      { messages: [userMessage(PROMPT), assistantMessage('Wrote output/index.txt.')] }
    ]
  })

  const result = await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    request,
    sleep: async () => {},
    pollMs: 0
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.text, 'Wrote output/index.txt.')
  assert.equal(result.dispatched, true)

  const created = calls.find(call => call.method === 'session.create')
  assert.deepEqual([...created.params.enabled_toolsets].sort(), ['clarify', 'file'])
  assert.equal(created.params.cwd, CWD)
  assert.equal(created.params.profile, 'producer')
  assert.equal(created.params.hidden, true)
  assert.equal(created.params.source, 'meeting')
})

test('the session binding is checkpointed BEFORE the prompt is submitted', async () => {
  const { calls, request } = recorder({
    replies: [
      { messages: [], session_id: 'runtime-1' },
      { messages: [userMessage(PROMPT), assistantMessage('Done.')] }
    ]
  })
  const order = []

  await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    request: async (participant, method, params) => {
      if (method === 'prompt.submit') {order.push('prompt')}

      return request(participant, method, params)
    },
    onCheckpoint: async checkpoint => {
      order.push('checkpoint')
      assert.equal(checkpoint.sessions['local::producer'], 'stored-1')
    },
    sleep: async () => {},
    pollMs: 0
  })

  assert.deepEqual(order, ['checkpoint', 'prompt'])
  assert.equal(calls.filter(call => call.method === 'prompt.submit').length, 1)
})

test('a reviewer turn gets no cwd and no file authority', async () => {
  const { calls, request } = recorder({
    replies: [
      { messages: [], session_id: 'runtime-1' },
      { messages: [userMessage('Review it.'), assistantMessage('verified')] }
    ]
  })

  const result = await runRoleTurn({
    role: 'reviewer',
    participant: producer,
    prompt: 'Review it.',
    request,
    sleep: async () => {},
    pollMs: 0
  })

  assert.equal(result.status, 'ready')
  const created = calls.find(call => call.method === 'session.create')
  assert.deepEqual(created.params.enabled_toolsets, ['clarify'])
  assert.equal(created.params.cwd, undefined)
})

test('a turn already carrying the prompt never submits it twice', async () => {
  // A reload finds the stored session with the dispatch already in history.
  const { calls, request } = recorder({
    replies: [
      { messages: [userMessage(PROMPT)], session_id: 'runtime-1', inflight: true },
      { messages: [userMessage(PROMPT)], session_id: 'runtime-1', inflight: true },
      { messages: [userMessage(PROMPT), assistantMessage('Finished the package.')] }
    ]
  })

  const result = await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    sessions: { 'local::producer': 'stored-1' },
    request,
    sleep: async () => {},
    pollMs: 0
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.text, 'Finished the package.')
  assert.equal(result.dispatched, false)
  assert.equal(calls.filter(call => call.method === 'prompt.submit').length, 0)
  // It resumed the stored session instead of creating a second one.
  assert.equal(calls.filter(call => call.method === 'session.create').length, 0)
})

test('an explicitly already-dispatched turn polls without re-prompting', async () => {
  const { calls, request } = recorder({
    replies: [
      // resume for the stored binding, then the baseline, then the poll.
      { session_id: 'runtime-1' },
      { messages: [], session_id: 'runtime-1', running: true },
      { messages: [assistantMessage('Done after recovery.')] }
    ]
  })

  const result = await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    sessions: { 'local::producer': 'stored-1' },
    dispatched: true,
    request,
    sleep: async () => {},
    pollMs: 0
  })

  assert.equal(result.status, 'ready')
  assert.equal(calls.filter(call => call.method === 'prompt.submit').length, 0)
})

test('a waiting participant is reported as waiting, not as a finished turn', async () => {
  const { request } = recorder({
    replies: [
      { messages: [], session_id: 'runtime-1' },
      { messages: [userMessage(PROMPT)], pending_clarify: { question: 'Which format?' } }
    ]
  })

  const result = await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    request,
    sleep: async () => {},
    pollMs: 0
  })

  assert.equal(result.status, 'waiting')
  assert.equal(result.pending.kind, 'clarify')
})

test('a turn that never replies times out instead of claiming success', async () => {
  const { request } = recorder({
    replies: [{ messages: [], session_id: 'runtime-1' }, { messages: [], running: true }]
  })

  const result = await runRoleTurn({
    role: 'producer',
    cwd: CWD,
    participant: producer,
    prompt: PROMPT,
    request,
    sleep: async () => {},
    maxPolls: 2,
    pollMs: 0
  })

  assert.equal(result.status, 'timeout')
  assert.equal(result.text, '')
})

test('a producer turn without a cwd is refused before any request is made', async () => {
  let called = false

  await assert.rejects(
    () => runRoleTurn({
      role: 'producer',
      participant: producer,
      prompt: PROMPT,
      request: async () => {
        called = true

        return {}
      }
    }),
    /server-minted workspace cwd/
  )
  assert.equal(called, false)
})

test('an empty or oversized prompt is refused', async () => {
  for (const prompt of ['', '  ', 'x'.repeat(8_001)]) {
    await assert.rejects(
      () => runRoleTurn({
        role: 'reviewer',
        participant: producer,
        prompt,
        request: async () => ({})
      }),
      /prompt/
    )
  }
})
