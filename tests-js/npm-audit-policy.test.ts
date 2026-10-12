import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import { evaluateAuditReport } from '../scripts/release-security/npm-audit-policy.mjs'

const sprintfUrl = 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
) as Record<string, unknown>

interface AuditFinding {
  nodes: string[]
  severity: string
  via: Array<Record<string, unknown> | string>
  [key: string]: unknown
}

interface AuditReport {
  metadata: { vulnerabilities: Record<string, number> }
  vulnerabilities: Record<string, AuditFinding>
  [key: string]: unknown
}

const repositoryReport = JSON.parse(
  fs.readFileSync(new URL('./fixtures/npm-audit-report.json', import.meta.url), 'utf8')
) as AuditReport

function knownReport(): AuditReport {
  return structuredClone(repositoryReport)
}

function developmentLock(): Record<string, unknown> {
  return structuredClone(repositoryLock)
}

function driftFindingField(finding: AuditFinding, field: string): unknown {
  const value = finding[field]

  if (field === 'severity') {
    return value === 'high' ? 'moderate' : 'high'
  }

  if (field === 'isDirect') {
    return !value
  }

  if (field === 'via' || field === 'effects' || field === 'nodes') {
    return [...value as unknown[], `unreviewed-${field}`]
  }

  if (field === 'fixAvailable') {
    return typeof value === 'boolean'
      ? !value
      : { ...(value as Record<string, unknown>), version: '0.0.0-drift' }
  }

  return `${String(value)}-drift`
}

describe('npm audit policy', () => {
  test('accepts only the exact development-only sprintf-js closure', () => {
    assert.deepEqual(evaluateAuditReport(knownReport(), developmentLock()), {
      errors: [],
      passed: true
    })
  })

  test('rejects an incomplete report containing only sprintf-js', () => {
    const report = knownReport()
    report.vulnerabilities = {
      'sprintf-js': report.vulnerabilities['sprintf-js']
    }
    report.metadata.vulnerabilities.moderate = 1
    report.metadata.vulnerabilities.total = 1

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing required vulnerability.*electron-builder/i)
  })

  test('rejects an allowed closure package with an incomplete via fan-out', () => {
    const report = knownReport()
    report.vulnerabilities['electron-builder'].via = []

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /electron-builder.*via/i)
  })

  test('rejects malformed advisory details even when the advisory URL is allowed', () => {
    const report = knownReport()
    report.vulnerabilities['sprintf-js'].via = [{ url: sprintfUrl }]

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /sprintf-js.*advisory.*provenance/i)
  })

  test('rejects unexpected finding fields instead of accepting malformed extras', () => {
    const report = knownReport()
    report.vulnerabilities['sprintf-js'].unexpected = true

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /sprintf-js.*missing or unexpected fields/i)
  })

  test('rejects malformed, omitted, and drifted values for every field of every retained finding', () => {
    const fields = ['name', 'severity', 'isDirect', 'via', 'effects', 'range', 'nodes', 'fixAvailable']

    for (const name of Object.keys(knownReport().vulnerabilities)) {
      for (const field of fields) {
        for (const mode of ['omitted', 'malformed', 'drift'] as const) {
          const report = knownReport()
          const finding = report.vulnerabilities[name]

          if (mode === 'omitted') {
            delete finding[field]
          } else {
            finding[field] = mode === 'malformed' ? null : driftFindingField(finding, field)
          }

          assert.equal(
            evaluateAuditReport(report, developmentLock()).passed,
            false,
            `${name} ${field} ${mode} value was accepted`
          )
        }
      }
    }
  })

  test.each([null, [], '', 0])('rejects malformed or truncated report payload %j', report => {
    assert.equal(
      evaluateAuditReport(report as unknown as Record<string, unknown>, developmentLock()).passed,
      false
    )
  })

  test('rejects unsupported versions and internally inconsistent metadata counts', () => {
    const reports = [
      (() => {
        const report = knownReport()
        delete report.auditReportVersion

        return report
      })(),
      (() => {
        const report = knownReport()
        report.auditReportVersion = 3

        return report
      })(),
      (() => {
        const report = knownReport()
        report.auditReportVersion = '2'

        return report
      })(),
      (() => {
        const report = knownReport()
        report.metadata.vulnerabilities.moderate -= 1

        return report
      })(),
      (() => {
        const report = knownReport()
        report.metadata.vulnerabilities.total -= 1

        return report
      })(),
      (() => {
        const report = knownReport()
        delete report.metadata.vulnerabilities.info

        return report
      })(),
      (() => {
        const report = knownReport()
        report.metadata.vulnerabilities.unexpected = 0

        return report
      })(),
      (() => {
        const report = knownReport() as { metadata: { vulnerabilities: Record<string, unknown> } }
        report.metadata.vulnerabilities.moderate = '8'

        return report
      })()
    ]

    for (const report of reports) {
      assert.equal(evaluateAuditReport(report, developmentLock()).passed, false)
    }
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
      auditReportVersion: 2,
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
