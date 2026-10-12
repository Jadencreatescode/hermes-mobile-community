import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import { evaluateWebsiteAuditReport, validateWebsiteLock } from '../scripts/release-security/website-audit-policy.mjs'

const bracesUrl = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
const httpCacheUrl = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../website/package-lock.json', import.meta.url), 'utf8')
) as Record<string, unknown>

function knownReport() {
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0, info: 0, total: 2 }
    },
    vulnerabilities: {
      braces: {
        severity: 'high',
        nodes: ['node_modules/braces'],
        via: [{ severity: 'high', url: bracesUrl }]
      },
      chokidar: {
        severity: 'high',
        nodes: ['node_modules/chokidar'],
        via: ['braces']
      }
    }
  }
}

function cleanReport() {
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 }
    },
    vulnerabilities: {}
  }
}

describe('website npm audit policy', () => {
  test('accepts the no-patch braces closure against the repository lock', () => {
    assert.deepEqual(evaluateWebsiteAuditReport(knownReport(), repositoryLock), {
      errors: [],
      passed: true
    })
  })

  test('binds the retained advisory to the exact locked artifact', () => {
    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, { integrity?: string }>
    }

    delete lock.packages['node_modules/braces'].integrity

    const result = evaluateWebsiteAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /braces integrity/i)
  })

  test('requires the patchable http-cache-semantics fix in the real lock', () => {
    assert.deepEqual(validateWebsiteLock(repositoryLock), [])

    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, { version?: string }>
    }

    lock.packages['node_modules/http-cache-semantics'].version = '4.2.0'

    assert.match(validateWebsiteLock(lock).join('\n'), /http-cache-semantics.*4\.3\.0/i)
  })

  test('rejects the removed http-cache-semantics advisory exception', () => {
    const report = knownReport() as {
      metadata: { vulnerabilities: Record<string, number> }
      vulnerabilities: Record<string, unknown>
    }

    report.metadata.vulnerabilities.high = 3
    report.metadata.vulnerabilities.total = 3
    report.vulnerabilities['http-cache-semantics'] = {
      severity: 'high',
      nodes: ['node_modules/http-cache-semantics'],
      via: [{ severity: 'high', url: httpCacheUrl }]
    }

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved vulnerable package: http-cache-semantics/i)
  })

  test('rejects an unknown advisory even when transitive', () => {
    const report = knownReport()
    report.vulnerabilities.braces.via.push({
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-unknown'
    })

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved advisory/i)
  })

  test('rejects a package outside the reviewed closure', () => {
    const report: Record<string, unknown> = knownReport()
    const vulnerabilities = report.vulnerabilities as Record<string, unknown>
    vulnerabilities.axios = {
      severity: 'high',
      nodes: ['node_modules/axios'],
      via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-axios-example' }]
    }

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved vulnerable package: axios/i)
  })

  test('rejects a transitive reference that escapes the reviewed closure', () => {
    const report = knownReport()
    report.vulnerabilities.chokidar.via = ['some-unreviewed-package']

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved transitive reference/i)
  })

  test('rejects critical findings without exception', () => {
    const report = knownReport()
    report.metadata.vulnerabilities.critical = 1

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /critical/i)
  })

  test('rejects a structurally incomplete audit report', () => {
    const result = evaluateWebsiteAuditReport({}, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing audit metadata/i)
    assert.match(result.errors.join('\n'), /missing vulnerability map/i)
  })

  test('accepts a clean audit report only when the lock is patched', () => {
    assert.deepEqual(evaluateWebsiteAuditReport(cleanReport(), repositoryLock), {
      errors: [],
      passed: true
    })
  })
})
