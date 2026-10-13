/**
 * Binary REST responses over BOTH authenticated transports.
 *
 * Artifact previews and package downloads ride the same authenticated REST
 * path as every other call, so each transport must return raw bytes when the
 * caller asks for them instead of JSON-parsing a ZIP. The shaping logic is
 * unit-tested here; the two main-process transports pull in main-process
 * singletons (https/http, electronNet, the OAuth session), so their wiring is
 * asserted on source shape — the same approach as
 * gateway-file-download-transport.test.ts.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import { binaryTransportResponse, normalizeResponseHeaders } from './oauth-net-request'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

function extract(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${startMarker} should exist`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `boundary after ${startMarker} should exist`)

  return source.slice(start, end)
}

test('normalizeResponseHeaders lowercases names and flattens repeats', () => {
  assert.deepEqual(
    normalizeResponseHeaders({
      'X-Hermes-Artifact-Sha256': 'abc',
      'Set-Cookie': ['a=1', 'b=2'],
      'content-type': 'application/zip',
      empty: undefined
    }),
    {
      'x-hermes-artifact-sha256': 'abc',
      'set-cookie': 'a=1, b=2',
      'content-type': 'application/zip',
      empty: ''
    }
  )
})

/** Narrow the transport union: a success must not be an Error. */
function shaped(statusCode: number, headers: Record<string, unknown>, payload: Buffer) {
  const response = binaryTransportResponse(statusCode, headers, payload)

  assert.ok(!(response instanceof Error), 'expected a shaped binary response')

  return response as Exclude<typeof response, Error>
}

test('binaryTransportResponse returns the exact bytes, media type, and headers', () => {
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])

  const response = shaped(200, {
    'Content-Type': 'application/zip',
    'X-Hermes-Artifact-Sha256': 'd'.repeat(64)
  }, payload)

  assert.equal(Object.prototype.toString.call(response.bytes), '[object ArrayBuffer]')
  assert.deepEqual([...new Uint8Array(response.bytes)], [...payload])
  assert.equal(response.mediaType, 'application/zip')
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-hermes-artifact-sha256'], 'd'.repeat(64))
})

test('binaryTransportResponse never JSON-parses and never slices a shared buffer', () => {
  // A Buffer taken from a pool carries a byteOffset; the returned ArrayBuffer
  // must contain ONLY this response's bytes.
  const pool = Buffer.from('XXXXhello')
  const view = pool.subarray(4)
  const response = shaped(200, {}, view)

  assert.equal(Buffer.from(response.bytes).toString('utf8'), 'hello')
  assert.equal(response.mediaType, 'application/octet-stream')
})

test('binaryTransportResponse surfaces an HTTP error with its status attached', () => {
  const error = binaryTransportResponse(404, {}, Buffer.from('missing member'))

  assert.ok(error instanceof Error)
  assert.equal((error as any).statusCode, 404)
  assert.match((error as Error).message, /404/)
  assert.match((error as Error).message, /missing member/)
})

test('the OAuth cookie transport honors responseType instead of parsing bytes', () => {
  const fn = extract('function fetchJsonViaOauthSession', '\n// ---')

  // The binary branch is taken BEFORE any utf8 decode / JSON.parse.
  const binaryBranch = fn.indexOf("options.responseType === 'binary'")
  assert.notEqual(binaryBranch, -1, 'cookie transport should branch on responseType')
  assert.ok(binaryBranch < fn.indexOf('JSON.parse'), 'binary must short-circuit JSON parsing')
  assert.match(fn, /binaryTransportResponse\(/)
})

test('both renderer-facing cookie fallbacks forward responseType and the header allowlist', () => {
  // The two paths a renderer REST call can take into cookie mode: the
  // descriptor path (fetchJsonForBackend) and the window-backend path
  // (handleHermesApiRequest). Neither may drop the caller's response type or
  // its allowlisted Idempotency-Key just because no native bearer was held.
  const descriptorPath = extract('async function fetchJsonForBackend', '\nipcMain.handle')
  const windowPath = extract('async function handleHermesApiRequest', '\n  } catch (error) {')

  for (const [label, body] of [
    ['fetchJsonForBackend', descriptorPath],
    ['handleHermesApiRequest', windowPath]
  ] as const) {
    const fallback = body.slice(body.indexOf('fetchJsonViaOauthSession'))

    assert.notEqual(fallback, '', `${label} should have a cookie fallback`)
    assert.match(fallback, /responseType:/, label)
    assert.match(fallback, /headers:/, label)
  }

  // Every branch a renderer call can leave through — registry-pinned, native
  // bearer, OAuth cookie, token/local — forwards the same two helpers. A new
  // branch that forgets one is a visible count change here.
  assert.equal(windowPath.match(/headers: apiRequestHeaders\(request\)/g)?.length, 4)
  assert.equal(windowPath.match(/apiRequestResponseType\(request\)/g)?.length, 4)
})

test('the bearer transport shares the one binary response shaper', () => {
  const fn = extract('function fetchJson(url, token, options: any = {})', '\nfunction ')

  assert.match(fn, /options\.responseType === 'binary'/)
  assert.match(fn, /binaryTransportResponse\(/)
})
