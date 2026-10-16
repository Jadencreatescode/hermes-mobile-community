const MAX_PROVIDERS = 16
const MAX_AGENTS_PER_PROVIDER = 64

function validAgent(agent) {
  return Boolean(
    agent &&
    typeof agent === 'object' &&
    typeof agent.id === 'string' &&
    agent.id.trim() &&
    typeof agent.name === 'string' &&
    agent.name.trim() &&
    agent.verification_state === 'verified'
  )
}

export async function loadProviderRoster(contributions) {
  const rows = []
  const boundedContributions = Array.from(contributions || []).slice(0, MAX_PROVIDERS)

  for (const [providerIndex, contribution] of boundedContributions.entries()) {
    const provider = contribution?.data

    if (
      !provider ||
      typeof provider.list_verified_agents !== 'function' ||
      typeof provider.open_bot_chat !== 'function'
    ) {
      continue
    }

    try {
      const agents = await provider.list_verified_agents()

      for (const agent of (Array.isArray(agents) ? agents : []).slice(0, MAX_AGENTS_PER_PROVIDER)) {
        if (!validAgent(agent)) {
          continue
        }

        rows.push({
          active: false,
          activity: 0,
          agent,
          kind: 'provider-bot',
          pinned: false,
          provider,
          providerKey: JSON.stringify([
            String(contribution?.source || 'core'),
            String(contribution?.id || providerIndex)
          ])
        })
      }
    } catch {
      // Provider reads are isolated: one broken integration must not erase
      // verified agents returned by the remaining providers.
    }
  }

  return rows
}

export function openProviderBot(row) {
  return row.provider.open_bot_chat(row.agent)
}

export function providerBotMatches(row, query) {
  const needle = String(query || '').trim().toLowerCase()

  if (!needle) {
    return true
  }

  const agent = row?.agent || {}

  return [agent.name, agent.handle, agent.harness, agent.host_label, agent.description]
    .some(value => String(value || '').toLowerCase().includes(needle))
}

export function providerRosterRowKind(row) {
  if (row?.kind === 'provider-bot') {
    return 'provider'
  }

  return row?.kind === 'group' ? 'group' : 'bot'
}
