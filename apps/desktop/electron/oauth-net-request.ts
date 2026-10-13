/**
 * Helpers for Electron net.request calls that ride the OAuth session partition.
 *
 * Electron's ClientRequest forbids app-set restricted headers such as
 * Content-Length. Let Chromium frame the body itself; only set the JSON content
 * type here.
 */

function serializeJsonBody(body) {
  return body === undefined ? undefined : Buffer.from(JSON.stringify(body))
}

function setJsonRequestHeaders(request) {
  request.setHeader('Content-Type', 'application/json')
}

/** Lowercase every response header name and flatten repeated values, so a
 *  caller can read `x-hermes-artifact-sha256` without knowing which transport
 *  (node https or electron.net) served the response. */
function normalizeResponseHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? '')
    ])
  )
}

/**
 * Shape ONE binary REST response for the renderer: the exact bytes, the
 * response media type, and the normalized headers a caller needs to verify a
 * digest. Shared by both authenticated transports so neither one can drift
 * into JSON-parsing a ZIP.
 *
 * An HTTP error is returned as an Error carrying its status, so each transport
 * rejects with it rather than resolving with a body that is really an error
 * page. The returned ArrayBuffer is a copy of just this response's bytes: a
 * pooled Buffer's `.buffer` would otherwise expose unrelated memory.
 */
function binaryTransportResponse(
  statusCode: number,
  headers: Record<string, unknown>,
  payload: Buffer
): { bytes: ArrayBuffer; mediaType: string; status: number; headers: Record<string, string> } | Error {
  const status = statusCode || 500
  const normalized = normalizeResponseHeaders(headers)

  if (status >= 400) {
    const error = new Error(`${status}: ${payload.toString('utf8').slice(0, 500)}`) as any
    error.statusCode = status

    return error
  }

  // Copy into a standalone ArrayBuffer: a pooled Buffer's own `.buffer` can be
  // larger than this response and shared with unrelated reads.
  const bytes = new Uint8Array(payload.byteLength)
  bytes.set(payload)

  return {
    bytes: bytes.buffer as ArrayBuffer,
    mediaType: normalized['content-type'] || 'application/octet-stream',
    status,
    headers: normalized
  }
}

export { binaryTransportResponse, normalizeResponseHeaders, serializeJsonBody, setJsonRequestHeaders }
