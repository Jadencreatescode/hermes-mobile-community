import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import {
  evaluateAuditReport,
  validateRootLock
} from '../scripts/release-security/npm-audit-policy.mjs'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')
) as Record<string, unknown>

interface AuditFinding {
  severity: string
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

function cleanReport(): AuditReport {
  return structuredClone(repositoryReport)
}

function developmentLock(): Record<string, unknown> {
  return structuredClone(repositoryLock)
}

function packages(lock: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (lock as { packages: Record<string, Record<string, unknown>> }).packages
}

function formerSprintfFinding(): AuditFinding {
  return {
    name: 'sprintf-js',
    severity: 'moderate',
    isDirect: false,
    via: [{
      source: 1241202,
      name: 'sprintf-js',
      dependency: 'sprintf-js',
      title: 'sprintf-js vulnerable to denial of service through unbounded precision specifiers',
      url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c',
      severity: 'moderate',
      cwe: ['CWE-1284'],
      cvss: {
        score: 5.3,
        vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L'
      },
      range: '<=1.1.3'
    }],
    effects: ['roarr'],
    range: '*',
    nodes: ['node_modules/sprintf-js'],
    fixAvailable: false
  }
}

describe('npm audit policy', () => {
  test('accepts a clean audit only against the exact reviewed Electron Builder 27 lock graph', () => {
    assert.deepEqual(evaluateAuditReport(cleanReport(), developmentLock()), {
      errors: [],
      passed: true
    })
  })

  test('binds the patched Electron Builder closure to exact upgraded versions', () => {
    assert.deepEqual(validateRootLock(developmentLock()), [])

    const locked = packages(developmentLock())
    assert.equal(locked['node_modules/@electron/get'].version, '5.1.0')
    assert.equal(locked['apps/desktop/node_modules/app-builder-lib'].version, '27.0.0-alpha.6')
    assert.equal(locked['apps/desktop/node_modules/dmg-builder'].version, '27.0.0-alpha.6')
    assert.equal(locked['apps/desktop/node_modules/electron-builder'].version, '27.0.0-alpha.6')
    assert.equal(
      locked['apps/desktop/node_modules/electron-builder-squirrel-windows'].version,
      '27.0.0-alpha.6'
    )
  })

  test('rejects even a newer Electron Builder version until it is reviewed exactly', () => {
    const lock = developmentLock()
    packages(lock)['apps/desktop/node_modules/electron-builder'].version = '27.0.0-alpha.7'

    const result = evaluateAuditReport(cleanReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /electron-builder.*27\.0\.0-alpha\.6/i)
  })

  test('rejects registry, integrity, and development-scope drift in reviewed artifacts', () => {
    for (const field of ['resolved', 'integrity', 'dev'] as const) {
      const lock = developmentLock()
      packages(lock)['apps/desktop/node_modules/app-builder-lib'][field] =
        field === 'dev' ? false : 'drift'

      const result = evaluateAuditReport(cleanReport(), lock)

      assert.equal(result.passed, false, `${field} drift was accepted`)

      const expectedError = field === 'dev'
        ? /app-builder-lib.*development only/i
        : field === 'resolved'
          ? /app-builder-lib.*registry identity/i
          : /app-builder-lib.*integrity/i

      assert.match(result.errors.join('\n'), expectedError)
    }
  })

  test('rejects missing and unreviewed dependency edges', () => {
    const missing = developmentLock()

    const desktop = packages(missing)['apps/desktop'] as {
      devDependencies: Record<string, string>
    }

    delete desktop.devDependencies['electron-builder']

    assert.match(validateRootLock(missing).join('\n'), /electron-builder.*unreviewed dependency edge|lost a reviewed edge/i)

    const added = developmentLock()
    const root = packages(added)[''] as { devDependencies?: Record<string, string> }
    root.devDependencies = { ...root.devDependencies, 'electron-builder': '27.0.0-alpha.6' }

    assert.match(validateRootLock(added).join('\n'), /electron-builder.*unreviewed dependency edge|lost a reviewed edge/i)
  })

  test('rejects reintroduction of the retired vulnerable sprintf-js closure', () => {
    const lock = developmentLock()
    packages(lock)['node_modules/sprintf-js'] = {
      version: '1.1.3',
      resolved: 'https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz',
      integrity: 'sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==',
      dev: true
    }

    const result = evaluateAuditReport(cleanReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /retired vulnerable lockfile node.*sprintf-js/i)
  })

  test('rejects the formerly accepted advisory even with exact historical provenance', () => {
    const report = cleanReport()
    report.vulnerabilities['sprintf-js'] = formerSprintfFinding()
    report.metadata.vulnerabilities.moderate = 1
    report.metadata.vulnerabilities.total = 1

    const result = evaluateAuditReport(report, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /unapproved vulnerable package: sprintf-js/i)
  })

  test('rejects every new advisory severity', () => {
    for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
      const report = cleanReport()
      report.vulnerabilities.example = { severity }
      report.metadata.vulnerabilities[severity] = 1
      report.metadata.vulnerabilities.total = 1

      const result = evaluateAuditReport(report, developmentLock())

      assert.equal(result.passed, false, `${severity} finding was accepted`)
      assert.match(result.errors.join('\n'), /unapproved vulnerable package: example/i)
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
        const report = cleanReport()
        delete report.auditReportVersion

        return report
      })(),
      (() => {
        const report = cleanReport()
        report.auditReportVersion = 3

        return report
      })(),
      (() => {
        const report = cleanReport()
        report.auditReportVersion = '2'

        return report
      })(),
      (() => {
        const report = cleanReport()
        report.metadata.vulnerabilities.moderate = 1

        return report
      })(),
      (() => {
        const report = cleanReport()
        report.metadata.vulnerabilities.total = 1

        return report
      })(),
      (() => {
        const report = cleanReport()
        delete report.metadata.vulnerabilities.info

        return report
      })(),
      (() => {
        const report = cleanReport()
        report.metadata.vulnerabilities.unexpected = 0

        return report
      })(),
      (() => {
        const report = cleanReport() as { metadata: { vulnerabilities: Record<string, unknown> } }
        report.metadata.vulnerabilities.moderate = '0'

        return report
      })()
    ]

    for (const report of reports) {
      assert.equal(evaluateAuditReport(report, developmentLock()).passed, false)
    }
  })

  test('rejects a structurally incomplete audit report', () => {
    const result = evaluateAuditReport({}, developmentLock())

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing audit metadata/i)
    assert.match(result.errors.join('\n'), /missing vulnerability map/i)
  })

  test('rejects a clean report when the reviewed lock graph is absent', () => {
    const result = evaluateAuditReport(cleanReport(), { packages: {} })

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /lockfile node is missing/i)
  })
})
