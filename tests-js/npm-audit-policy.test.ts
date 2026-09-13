import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { evaluateAuditReport } from '../scripts/release-security/npm-audit-policy.mjs'

const electronUrl = 'https://github.com/advisories/GHSA-9f4c-93c8-jc8g'
const protocolUrl = 'https://github.com/advisories/GHSA-r4w5-6pfg-jxp5'
const extractUrl = 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv'
const extractWriteUrl = 'https://github.com/advisories/GHSA-7pqw-9j4j-h8q3'

type LockPackage = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dev?: boolean
  integrity?: string
  resolved?: string
  version?: string
}

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
        via: [
          { severity: 'high', url: extractUrl },
          { severity: 'high', url: extractWriteUrl }
        ]
      }
    }
  }
}

function developmentLock(): { packages: Record<string, LockPackage> } {
  return {
    packages: {
      '': {},
      'apps/desktop': { devDependencies: { electron: '40.10.2' } },
      'apps/desktop/node_modules/electron': {
        dependencies: { 'extract-zip': '^2.0.1' },
        dev: true,
        integrity: 'sha512-Xj3Hy0Imbu4g0gDIW55w/jJYz94nMO2JRSGYA3LyAn5SwaERCelgZrA21vfH+Bi//SWAWQXddHsMwCqauyMT8g==',
        resolved: 'https://registry.npmjs.org/electron/-/electron-40.10.2.tgz',
        version: '40.10.2'
      },
      'node_modules/extract-zip': {
        dev: true,
        integrity: 'sha512-GDhU9ntwuKyGXdZBUgTIe+vXnWj0fppUEtMDL0+idd5Sta8TGpHssn/eusA9mrPr9qNDym6SxAYZjNvCn/9RBg==',
        resolved: 'https://registry.npmjs.org/extract-zip/-/extract-zip-2.0.1.tgz',
        version: '2.0.1'
      }
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

  test('rejects an exception package reached through an unreviewed dependency edge', () => {
    const lock = developmentLock()
    lock.packages[''].devDependencies = { 'extract-zip': '2.0.1' }

    const result = evaluateAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unreviewed dependency edge/i)
  })

  test('rejects an exception package whose registry identity or integrity is missing', () => {
    const lock = developmentLock()
    delete lock.packages['apps/desktop/node_modules/electron'].resolved
    delete lock.packages['node_modules/extract-zip'].integrity

    const result = evaluateAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /registry identity/i)
    assert.match(result.errors.join('\n'), /integrity/i)
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
