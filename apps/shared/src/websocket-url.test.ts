import { describe, expect, it } from 'vitest'

import { buildHermesWebSocketUrl } from './websocket-url'

describe('buildHermesWebSocketUrl', () => {
  it('trims every trailing slash from a reverse proxy base path', () => {
    expect(
      buildHermesWebSocketUrl({
        basePath: '////relay////',
        host: 'mobile.example',
        path: '/api/ws',
        protocol: 'https:'
      })
    ).toBe('wss://mobile.example////relay/api/ws')
  })
})