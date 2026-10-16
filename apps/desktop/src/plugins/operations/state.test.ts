import { describe, expect, it } from 'vitest'

import { mapOperationsAgentState } from './state'

describe('mapOperationsAgentState', () => {
  it('never reports an unreachable source as idle', () => {
    expect(mapOperationsAgentState({ sourceReachable: false })).toBe('unknown')
  })

  it('uses the authoritative evidence precedence', () => {
    expect(
      mapOperationsAgentState({
        activeSession: true,
        assignments: [{ status: 'review' }, { status: 'blocked' }],
        pendingInput: true,
        sourceReachable: true
      })
    ).toBe('waiting')

    expect(
      mapOperationsAgentState({
        activeSession: true,
        assignments: [{ status: 'review' }, { status: 'blocked' }],
        sourceReachable: true
      })
    ).toBe('blocked')

    expect(
      mapOperationsAgentState({
        activeSession: true,
        assignments: [{ status: 'review' }],
        sourceReachable: true
      })
    ).toBe('reviewing')

    expect(mapOperationsAgentState({ activeSession: true, sourceReachable: true })).toBe('working')
    expect(mapOperationsAgentState({ activeDelegation: true, sourceReachable: true })).toBe('working')
    expect(mapOperationsAgentState({ sourceReachable: true })).toBe('idle')
  })

  it('treats an unresolved critical diagnostic as blocked', () => {
    expect(
      mapOperationsAgentState({
        assignments: [{ diagnostics: [{ resolved: false, severity: 'critical' }], status: 'running' }],
        sourceReachable: true
      })
    ).toBe('blocked')
  })

  it('requires a fresh worker heartbeat before reporting working', () => {
    const nowMs = 2_000_000

    expect(
      mapOperationsAgentState({ nowMs, sourceReachable: true, workerHeartbeatAt: (nowMs - 149_000) / 1000 })
    ).toBe('working')
    expect(
      mapOperationsAgentState({ nowMs, sourceReachable: true, workerHeartbeatAt: (nowMs - 151_000) / 1000 })
    ).toBe('idle')
  })
})
