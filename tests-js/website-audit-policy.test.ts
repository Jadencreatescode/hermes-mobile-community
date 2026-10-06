import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { evaluateWebsiteAuditReport } from '../scripts/release-security/website-audit-policy.mjs'

const bracesUrl = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
const httpCacheUrl = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp'

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

describe('website npm audit policy', () => {
  test('accepts the documented Docusaurus-internal advisories', () => {
    assert.deepEqual(evaluateWebsiteAuditReport(knownReport()), { errors: [], passed: true })
  })

  test('rejects an unknown advisory even when transitive', () => {
    const report = knownReport()
    report.vulnerabilities.braces.via.push({ severity: 'high', url: 'https://github.com/advisories/GHSA-unknown' })

    const result = evaluateWebsiteAuditReport(report)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved advisory/i)
  })

  test('rejects a package outside the reviewed closure', () => {
    const report = knownReport()
    report.vulnerabilities.axios = {
      severity: 'high',
      nodes: ['node_modules/axios'],
      via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-axios-example' }]
    }

    const result = evaluateWebsiteAuditReport(report)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved vulnerable package: axios/i)
  })

  test('rejects a transitive reference that escapes the reviewed closure', () => {
    const report = knownReport()
    report.vulnerabilities.chokidar.via = ['some-unreviewed-package']

    const result = evaluateWebsiteAuditReport(report)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved transitive reference/i)
  })

  test('rejects critical findings without exception', () => {
    const report = knownReport()
    report.metadata.vulnerabilities.critical = 1

    const result = evaluateWebsiteAuditReport(report)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /critical/i)
  })

  test('rejects a structurally incomplete audit report', () => {
    const result = evaluateWebsiteAuditReport({})

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing audit metadata/i)
    assert.match(result.errors.join('\n'), /missing vulnerability map/i)
  })

  test('accepts a clean audit report', () => {
    const report = {
      metadata: {
        vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 }
      },
      vulnerabilities: {}
    }

    assert.deepEqual(evaluateWebsiteAuditReport(report), { errors: [], passed: true })
  })
})
