import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import { evaluateAuditReport } from '../scripts/release-security/npm-audit-policy.mjs'

const sprintfUrl = 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
) as Record<string, unknown>

function knownReport() {
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: 0, moderate: 8, low: 0, info: 0, total: 8 }
    },
    vulnerabilities: {
      '@electron/get': {
        severity: 'moderate',
        nodes: ['node_modules/app-builder-lib/node_modules/@electron/get'],
        via: ['global-agent']
      },
      'app-builder-lib': {
        severity: 'moderate',
        nodes: ['node_modules/app-builder-lib'],
        via: ['@electron/get', 'dmg-builder', 'electron-builder-squirrel-windows']
      },
      'dmg-builder': {
        severity: 'moderate',
        nodes: ['node_modules/dmg-builder'],
        via: ['app-builder-lib']
      },
      'electron-builder': {
        severity: 'moderate',
        nodes: ['node_modules/electron-builder'],
        via: ['app-builder-lib', 'dmg-builder']
      },
      'electron-builder-squirrel-windows': {
        severity: 'moderate',
        nodes: ['node_modules/electron-builder-squirrel-windows'],
        via: ['app-builder-lib']
      },
      'global-agent': {
        severity: 'moderate',
        nodes: ['node_modules/global-agent'],
        via: ['roarr']
      },
      roarr: {
        severity: 'moderate',
        nodes: ['node_modules/roarr'],
        via: ['sprintf-js']
      },
      'sprintf-js': {
        severity: 'moderate',
        nodes: ['node_modules/sprintf-js'],
        via: [{ severity: 'moderate', url: sprintfUrl }]
      }
    }
  }
}

function developmentLock(): Record<string, unknown> {
  return structuredClone(repositoryLock)
}

describe('npm audit policy', () => {
  test('accepts only the exact development-only sprintf-js closure', () => {
    assert.deepEqual(evaluateAuditReport(knownReport(), developmentLock()), {
      errors: [],
      passed: true
    })
  })

  test('rejects an unknown advisory even on an allowed package', () => {
    const report = knownReport()
    report.vulnerabilities['sprintf-js'].via.push({
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-unknown'
    })

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved advisory/i)
  })

  test('rejects sprintf-js when its advisory details are missing', () => {
    const report = knownReport()
    report.vulnerabilities['sprintf-js'].via = []

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /no advisory details/i)
  })

  test('rejects an exception package when it becomes a shipped dependency', () => {
    const lock = developmentLock() as { packages: Record<string, { dev?: boolean }> }
    lock.packages['node_modules/sprintf-js'].dev = false

    const result = evaluateAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /not development only/i)
  })

  test('rejects the exception through an unreviewed dependency edge', () => {
    const lock = developmentLock() as {
      packages: Record<string, { devDependencies?: Record<string, string> }>
    }

    lock.packages[''].devDependencies = { 'sprintf-js': '1.1.3' }

    const result = evaluateAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unreviewed dependency edge/i)
  })

  test('rejects an exception artifact whose registry identity or integrity is missing', () => {
    const lock = developmentLock() as {
      packages: Record<string, { integrity?: string; resolved?: string }>
    }

    delete lock.packages['node_modules/roarr'].resolved
    delete lock.packages['node_modules/sprintf-js'].integrity

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
