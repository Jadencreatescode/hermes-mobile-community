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

  it('reports a refused name from the backend as a human reason', async () => {
    const rest = vi.fn().mockRejectedValue(
      new Error('400: {"detail":{"error":"a2a_name_rejected","reason":"agent name must use letters, spaces, apostrophes, or hyphens"}}')
    )
    unbind = bindOperationsApi(rest)

    let caught: unknown
    try {
      await renameA2AAgent('a2a:one', 'Darrell!')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('agent name must use letters, spaces, apostrophes, or hyphens')
    expect((caught as Error).message).not.toMatch(/^\d+:/)
    expect((caught as Error).message).not.toContain('{')
  })

  it('surfaces a plain string detail when no reason is present', async () => {
    const rest = vi.fn().mockRejectedValue(new Error('404: {"detail":"a2a_agent_not_found"}'))
    unbind = bindOperationsApi(rest)

    let caught: unknown
    try {
      await renameA2AAgent('a2a:one', 'Darrell')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('a2a_agent_not_found')
    expect((caught as Error).message).not.toMatch(/^\d+:/)
    expect((caught as Error).message).not.toContain('{')
  })

  it('falls back to the raw body when the response is not structured JSON', async () => {
    const rest = vi.fn().mockRejectedValue(new Error('400: plain error text'))
    unbind = bindOperationsApi(rest)

    let caught: unknown
    try {
      await renameA2AAgent('a2a:one', 'Darrell')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('plain error text')
  })

  it('falls back to a degraded status when the backend omits one', async () => {
    const rest = vi.fn().mockResolvedValue({ agent_id: 'a2a:one', name: 'Darrell' })
    unbind = bindOperationsApi(rest)

    const result = await renameA2AAgent('a2a:one', 'Darrell')

    expect(result.agent.status).toBe('degraded')
  })
})
