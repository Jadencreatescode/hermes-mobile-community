import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { evaluateAuditReport } from '../scripts/npm-audit-policy.mjs'

const electronUrl = 'https://github.com/advisories/GHSA-9f4c-93c8-jc8g'
const protocolUrl = 'https://github.com/advisories/GHSA-r4w5-6pfg-jxp5'
const extractUrl = 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv'

function knownReport() {
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: 2, moderate: 0, low: 0, info: 0, total: 2 }
    },
    vulnerabilities: {
      electron: {
        severity: 'high',
        nodes: ['apps/desktop/node_modules/electron'],
        via: [
          { severity: 'high', url: electronUrl },
          { severity: 'moderate', url: protocolUrl },
          'extract-zip'
        ]
      },
      'extract-zip': {
        severity: 'high',
        nodes: ['node_modules/extract-zip'],
        via: [{ severity: 'high', url: extractUrl }]
      }
    }
  }
}

function developmentLock() {
  return {
    packages: {
      'apps/desktop/node_modules/electron': { dev: true, version: '40.10.2' },
      'node_modules/extract-zip': { dev: true, version: '2.0.1' }
    }
  }
}

describe('npm audit policy', () => {
  test('accepts only the documented Electron development advisories', () => {
    assert.deepEqual(evaluateAuditReport(knownReport(), developmentLock()), {
      errors: [],
      passed: true
    })
  })

  test('rejects an unknown advisory even when it is transitive', () => {
    const report = knownReport()
    report.vulnerabilities.electron.via.push({
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-unknown'
    })

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved advisory/i)
  })

  test('rejects a documented package when advisory details are missing', () => {
    const report = knownReport()
    report.vulnerabilities['extract-zip'].via = []

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /no advisory details/i)
  })

  test('rejects a documented advisory when it reaches a shipped dependency', () => {
    const lock = developmentLock()
    lock.packages['node_modules/extract-zip'].dev = false

    const result = evaluateAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /not development only/i)
  })

  test('rejects critical findings without exception', () => {
    const report = knownReport()
    report.metadata.vulnerabilities.critical = 1

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /critical/i)
  })

  test('rejects a structurally incomplete audit report', () => {
    const result = evaluateAuditReport({}, { packages: {} })

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

    assert.deepEqual(evaluateAuditReport(report, { packages: {} }), {
      errors: [],
      passed: true
    })
  })
})
