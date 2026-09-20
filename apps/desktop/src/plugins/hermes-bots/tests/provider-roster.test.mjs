import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadProviderRoster,
  openProviderBot,
  providerBotMatches,
  providerRosterRowKind
} from '../provider-roster.mjs'

function verifiedAgent(id, overrides = {}) {
  return {
    id,
    name: `Agent ${id}`,
    handle: id,
    harness: 'a2a',
    host_label: 'Connected host',
    verification_state: 'verified',
    ...overrides
  }
}

function provider(agents, overrides = {}) {
  return {
    list_verified_agents: async () => agents,
    open_bot_chat: () => undefined,
    ...overrides
  }
}

test('provider roster accepts verified agents without inventing private session identities', async () => {
  const opened = []
  const valid = verifiedAgent('verified-a', { name: 'Release Reviewer' })
  const rows = await loadProviderRoster([
    {
      id: 'fixture',
      data: provider(
        [
          valid,
          verifiedAgent('pending-a', { verification_state: 'pending' }),
          verifiedAgent('', { name: 'Missing id' }),
          verifiedAgent('missing-name', { name: '   ' }),
          null
        ],
        { open_bot_chat: agent => opened.push(agent.id) }
      )
    }
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'provider-bot')
  assert.equal(rows[0].agent, valid)
  assert.equal('mirror_session_id' in rows[0].agent, false)

  openProviderBot(rows[0])
  assert.deepEqual(opened, ['verified-a'])
})

test('provider roster rejects contributions without required provider operations', async () => {
  const rows = await loadProviderRoster([
    { id: 'missing-list', data: { open_bot_chat: () => undefined } },
    { id: 'missing-open', data: { list_verified_agents: async () => [verifiedAgent('ignored')] } },
    { id: 'not-an-object', data: null }
  ])

  assert.deepEqual(rows, [])
})

test('one provider failure cannot erase rows returned by another provider', async () => {
  const rows = await loadProviderRoster([
    {
      id: 'broken',
      data: provider([], { list_verified_agents: async () => { throw new Error('offline') } })
    },
    { id: 'healthy', data: provider([verifiedAgent('healthy-agent')]) }
  ])

  assert.deepEqual(rows.map(row => row.agent.id), ['healthy-agent'])
})

test('same agent ids from different providers keep distinct row identities', async () => {
  const rows = await loadProviderRoster([
    { id: 'reviewers', source: 'plugin:first', data: provider([verifiedAgent('shared')]) },
    { id: 'reviewers', source: 'plugin:second', data: provider([verifiedAgent('shared')]) }
  ])

  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].providerKey, rows[1].providerKey)
  assert.deepEqual(rows.map(row => row.agent.id), ['shared', 'shared'])
})

test('provider roster limits work to 16 providers and 64 agents per provider', async () => {
  const calls = []
  const contributions = Array.from({ length: 18 }, (_, providerIndex) => ({
    id: `provider-${providerIndex}`,
    data: provider(
      Array.from({ length: 70 }, (_, agentIndex) => verifiedAgent(`${providerIndex}-${agentIndex}`)),
      { list_verified_agents: async () => {
        calls.push(providerIndex)
        return Array.from({ length: 70 }, (_, agentIndex) => verifiedAgent(`${providerIndex}-${agentIndex}`))
      } }
    )
  }))

  const rows = await loadProviderRoster(contributions)

  assert.equal(calls.length, 16)
  assert.equal(rows.length, 16 * 64)
  assert.equal(rows.some(row => row.agent.id === '0-64'), false)
  assert.equal(rows.some(row => row.agent.id === '16-0'), false)
})

test('provider roster search matches name, handle, harness, host label, and description', () => {
  const row = {
    kind: 'provider-bot',
    agent: verifiedAgent('verified-a', {
      name: 'Claude Reviewer',
      handle: 'release-reviewer',
      harness: 'claude-code',
      host_label: 'Trusted Lab',
      description: 'Release compliance review'
    }),
    provider: { open_bot_chat: () => undefined }
  }

  for (const query of ['CLAUDE', 'release-reviewer', 'claude-code', 'trusted lab', 'compliance']) {
    assert.equal(providerBotMatches(row, query), true, query)
  }
  assert.equal(providerBotMatches(row, 'unrelated'), false)
  assert.equal(providerBotMatches(row, '   '), true)
})

test('runtime row selection keeps provider agents out of native BotRow rendering', () => {
  assert.equal(providerRosterRowKind({ kind: 'provider-bot' }), 'provider')
  assert.equal(providerRosterRowKind({ kind: 'group' }), 'group')
  assert.equal(providerRosterRowKind({ kind: 'bot', bot: { name: 'default' } }), 'bot')
})
