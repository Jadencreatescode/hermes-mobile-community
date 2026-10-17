/**
 * Binary REST responses over BOTH authenticated transports.
 *
 * Artifact previews and package downloads ride the same authenticated REST
 * path as every other call, so each transport must return raw bytes when the
 * caller asks for them instead of JSON-parsing a ZIP. The shaping logic is
 * unit-tested here; the two main-process transports pull in main-process
 * singletons (https/http, electronNet, the OAuth session), so their wiring is
 * asserted at the named-function boundary. Function bodies are located by
 * balanced braces rather than neighboring source markers, keeping the checks
 * stable when unrelated handlers or centralized response helpers move.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import { binaryTransportResponse, normalizeResponseHeaders } from './oauth-net-request'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

function matchingDelimiter(start: number, open: string, close: string): number {
  let depth = 0
  let quote = ''
  let lineComment = false
  let blockComment = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (char === '\n') {
        lineComment = false
      }

      continue
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }

      continue
    }

    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = ''
      }

      continue
    }

    if (char === '/' && next === '/') {
      lineComment = true
      index += 1

      continue
    }

    if (char === '/' && next === '*') {
      blockComment = true
      index += 1

      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char

      continue
    }

    if (char === open) {
      depth += 1
    }

    if (char === close) {
      depth -= 1
    }

    if (depth === 0) {
      return index
    }
  }

  return -1
}

function functionSource(name: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = signature.exec(source)
  assert.ok(match, `${name} should exist`)

  const start = match.index
  const parametersStart = source.indexOf('(', start)
  const parametersEnd = matchingDelimiter(parametersStart, '(', ')')
  assert.notEqual(parametersEnd, -1, `${name} parameters should be balanced`)

  const bodyStart = source.indexOf('{', parametersEnd)
  const bodyEnd = matchingDelimiter(bodyStart, '{', '}')
  assert.notEqual(bodyEnd, -1, `${name} body should be balanced`)

  return source.slice(start, bodyEnd + 1)
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

  const response = shaped(
    200,
    {
      'Content-Type': 'application/zip',
      'X-Hermes-Artifact-Sha256': 'd'.repeat(64)
    },
    payload
  )

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

test('the OAuth cookie transport handles binary before centralized JSON response wiring', () => {
  const fn = functionSource('fetchJsonViaOauthSession')

  // JSON parsing now lives in wireOauthSessionResponse. The binary branch must
  // still short-circuit before that helper receives the response stream.
  const binaryBranch = fn.indexOf("options.responseType === 'binary'")
  const jsonWiring = fn.indexOf('wireOauthSessionResponse(res,')
  assert.notEqual(binaryBranch, -1, 'cookie transport should branch on responseType')
  assert.notEqual(jsonWiring, -1, 'cookie transport should delegate JSON response handling')
  assert.ok(binaryBranch < jsonWiring, 'binary must short-circuit centralized JSON response handling')
  assert.match(fn.slice(binaryBranch, jsonWiring), /binaryTransportResponse\(/)
  assert.match(fn.slice(binaryBranch, jsonWiring), /\n\s+return\n/)
})

test('renderer routes preserve responseType and allowlisted headers through the centralized descriptor transport', () => {
  const descriptorPath = functionSource('fetchJsonForBackend')
  const registryPath = functionSource('dispatchRegistryApiRequest')
  const windowPath = functionSource('handleHermesApiRequest')
  const headerAllowlist = functionSource('apiRequestHeaders')

  // Renderer entry points normalize untrusted request fields exactly once,
  // then hand them to the shared descriptor transport.
  for (const [label, body] of [
    ['dispatchRegistryApiRequest', registryPath],
    ['handleHermesApiRequest', windowPath]
  ] as const) {
    assert.match(body, /fetchJsonForBackend\(/, `${label} should use the centralized transport`)
    assert.match(body, /headers: apiRequestHeaders\(request\)/, label)
    assert.match(body, /responseType: apiRequestResponseType\(request\)/, label)
  }

  assert.match(windowPath, /return dispatchRegistryApiRequest\(request, registryConnectionId\)/)
  assert.match(headerAllowlist, /\['Idempotency-Key'\]/)
  assert.match(headerAllowlist, /\{ 'Idempotency-Key': key \}/)

  // The descriptor transport owns the auth split. One options object carries
  // responseType and merged descriptor/allowlisted headers through both OAuth
  // branches; the token/local branch forwards the same fields explicitly.
  assert.match(descriptorPath, /responseType: opts\.responseType/)
  assert.match(descriptorPath, /headers: \{ \.\.\.descriptor\.headers, \.\.\.\(opts\.headers \|\| \{\}\) \}/)
  assert.match(descriptorPath, /requestWithBearer: .*fetchJson\(url, null, \{ \.\.\.options, bearer \}\)/)
  assert.match(descriptorPath, /requestWithCookie: \(\) => fetchJsonViaOauthSession\(url, options\)/)
})

test('the bearer transport shares the one binary response shaper', () => {
  const fn = functionSource('fetchJson')

  assert.match(fn, /options\.responseType === 'binary'/)
  assert.match(fn, /binaryTransportResponse\(/)
})
