import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOperationsApi } from './api'
import { renameA2AAgent } from './data'

let unbind: null | (() => void) = null

afterEach(() => {
  unbind?.()
  unbind = null
})

describe('renameA2AAgent', () => {
  it('sends the trimmed name to the agent and returns the stored Bot', async () => {
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:one',
      capabilities: ['chat'],
      name: 'Darrell',
      status: 'verified',
      warnings: []
    })
    unbind = bindOperationsApi(rest)

    const result = await renameA2AAgent('a2a:one', '  Darrell  ')

    expect(rest).toHaveBeenCalledWith('/agents/a2a/a2a%3Aone', {
      method: 'PATCH',
      body: { name: 'Darrell' }
    })
    expect(result.agent).toEqual({
      agentId: 'a2a:one',
      capabilities: ['chat'],
      name: 'Darrell',
      status: 'verified'
    })
    expect(result.warnings).toEqual([])
  })

  it('escapes the agent id so a colon cannot break the path', async () => {
    const rest = vi.fn().mockResolvedValue({ agent_id: 'a2a:one', name: 'Darrell', status: 'pending' })
    unbind = bindOperationsApi(rest)

    await renameA2AAgent('a2a:one', 'Darrell')

    expect(rest.mock.calls[0][0]).toBe('/agents/a2a/a2a%3Aone')
  })

  it('carries the duplicate name warning back to the caller', async () => {
    const warning = 'another Bot already uses this name (laptop), so the two are hard to tell apart'
    const rest = vi.fn().mockResolvedValue({
      agent_id: 'a2a:one',
      name: 'Darrell',
      status: 'verified',
      warnings: [warning, 42, null]
    })
    unbind = bindOperationsApi(rest)

    const result = await renameA2AAgent('a2a:one', 'Darrell')

    expect(result.warnings).toEqual([warning])
  })

  it('refuses an empty name before it reaches the backend', async () => {
    const rest = vi.fn()
    unbind = bindOperationsApi(rest)

    await expect(renameA2AAgent('a2a:one', '   ')).rejects.toThrow('Enter a name for this Bot.')
    expect(rest).not.toHaveBeenCalled()
  })

  it('reports a refused name from the backend as a failure', async () => {
    const rest = vi.fn().mockRejectedValue(new Error('a2a_name_rejected'))
    unbind = bindOperationsApi(rest)

    await expect(renameA2AAgent('a2a:one', 'Darrell!')).rejects.toThrow('a2a_name_rejected')
  })

  it('falls back to a degraded status when the backend omits one', async () => {
    const rest = vi.fn().mockResolvedValue({ agent_id: 'a2a:one', name: 'Darrell' })
    unbind = bindOperationsApi(rest)

    const result = await renameA2AAgent('a2a:one', 'Darrell')

    expect(result.agent.status).toBe('degraded')
  })
})
