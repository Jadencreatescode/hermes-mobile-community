import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import { evaluateWebsiteAuditReport, validateWebsiteLock } from '../scripts/release-security/website-audit-policy.mjs'

const bracesUrl = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../website/package-lock.json', import.meta.url), 'utf8')
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
  fs.readFileSync(new URL('./fixtures/website-audit-report.json', import.meta.url), 'utf8')
) as AuditReport

function knownReport(): AuditReport {
  return structuredClone(repositoryReport)
}

function recount(report: AuditReport): void {
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 }

  for (const finding of Object.values(report.vulnerabilities)) {
    counts[finding.severity as keyof typeof counts] += 1
    counts.total += 1
  }

  report.metadata.vulnerabilities = counts
}

describe('website npm audit policy', () => {
  test('accepts the no-patch braces closure derived from the repository lock', () => {
    assert.deepEqual(evaluateWebsiteAuditReport(knownReport(), repositoryLock), {
      errors: [],
      passed: true
    })
  })

  test('does not freeze npm transitive effects, ranges, or fix presentation', () => {
    const report = knownReport()
    report.vulnerabilities.chokidar.effects = ['braces']
    report.vulnerabilities.chokidar.range = 'volatile-range'
    report.vulnerabilities.chokidar.fixAvailable = {
      isSemVerMajor: true,
      name: 'volatile',
      version: '999.0.0'
    }

    assert.equal(evaluateWebsiteAuditReport(report, repositoryLock).passed, true)
  })

  test('rejects an incomplete lock-derived transitive closure', () => {
    const report = knownReport()
    delete report.vulnerabilities.chokidar
    recount(report)

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing.*chokidar/i)
  })

  test('rejects a closure member whose actual vulnerable lock node is omitted', () => {
    const report = knownReport()
    report.vulnerabilities.globby.nodes = ['node_modules/globby']

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /globby.*nodes/i)
  })

  test('rejects unexpected vulnerable nodes and findings', () => {
    const report = knownReport()
    report.vulnerabilities.braces.nodes.push('node_modules/unreviewed/node_modules/braces')
    report.vulnerabilities.axios = {
      name: 'axios',
      severity: 'high',
      isDirect: false,
      via: [{ url: 'https://github.com/advisories/GHSA-unknown' }],
      effects: [],
      range: '*',
      nodes: ['node_modules/axios'],
      fixAvailable: false
    }
    recount(report)

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /braces.*nodes/i)
    assert.match(result.errors.join('\n'), /unexpected vulnerable package: axios/i)
  })

  test('binds the leaf advisory to exact provenance', () => {
    const mutations = [
      (finding: AuditFinding) => { finding.via = [{ url: bracesUrl }] },
      (finding: AuditFinding) => { (finding.via[0] as Record<string, unknown>).source = 0 },
      (finding: AuditFinding) => { (finding.via[0] as Record<string, unknown>).range = '<=999.0.0' },
      (finding: AuditFinding) => { finding.via.push({ url: 'https://github.com/advisories/GHSA-unknown' }) }
    ]

    for (const mutate of mutations) {
      const report = knownReport()
      mutate(report.vulnerabilities.braces)
      const result = evaluateWebsiteAuditReport(report, repositoryLock)
      assert.equal(result.passed, false)
      assert.match(result.errors.join('\n'), /braces.*advisory provenance/i)
    }
  })

  test('rejects another leaf advisory anywhere in the closure', () => {
    const report = knownReport()
    report.vulnerabilities.chokidar.via = [{
      source: 1,
      name: 'chokidar',
      dependency: 'chokidar',
      title: 'unexpected advisory',
      url: 'https://github.com/advisories/GHSA-unknown',
      severity: 'high',
      cwe: ['CWE-1'],
      cvss: { score: 9, vectorString: 'CVSS:3.1/example' },
      range: '*'
    }]

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /only braces may contain advisory details/i)
  })

  test('rejects duplicate provenance, duplicate effects, and malformed transitive fix objects', () => {
    const mutations = [
      (finding: AuditFinding) => { finding.via = ['braces', 'braces'] },
      (finding: AuditFinding) => { finding.effects = ['braces', 'braces'] },
      (finding: AuditFinding) => { finding.fixAvailable = { name: 'incomplete' } }
    ]

    for (const mutate of mutations) {
      const report = knownReport()
      mutate(report.vulnerabilities.chokidar)
      assert.equal(evaluateWebsiteAuditReport(report, repositoryLock).passed, false)
    }
  })

  test.each([true, { name: 'braces', version: '3.0.4' }, null])(
    'rejects leaf fix availability %j',
    fixAvailable => {
      const report = knownReport()
      report.vulnerabilities.braces.fixAvailable = fixAvailable

      const result = evaluateWebsiteAuditReport(report, repositoryLock)

      assert.equal(result.passed, false)
      assert.match(result.errors.join('\n'), /braces.*fix/i)
    }
  )

  test.each([null, [], '', 0, {}])('rejects malformed or truncated report payload %j', report => {
    assert.equal(
      evaluateWebsiteAuditReport(report as unknown as Record<string, unknown>, repositoryLock).passed,
      false
    )
  })

  test('rejects omitted report maps and counts', () => {
    for (const mutate of [
      (report: AuditReport) => { delete (report as Record<string, unknown>).vulnerabilities },
      (report: AuditReport) => { delete (report as Record<string, unknown>).metadata },
      (report: AuditReport) => { delete (report.metadata as Record<string, unknown>).vulnerabilities }
    ]) {
      const report = knownReport()
      mutate(report)
      assert.equal(evaluateWebsiteAuditReport(report, repositoryLock).passed, false)
    }
  })

  test('rejects unsupported versions and contradictory counts', () => {
    const reports = [
      (() => { const report = knownReport(); delete report.auditReportVersion;

 return report })(),
      (() => { const report = knownReport(); report.auditReportVersion = 3;

 return report })(),
      (() => { const report = knownReport(); report.metadata.vulnerabilities.high -= 1;

 return report })(),
      (() => { const report = knownReport(); delete report.metadata.vulnerabilities.info;

 return report })(),
      (() => { const report = knownReport(); report.metadata.vulnerabilities.unexpected = 0;

 return report })()
    ]

    for (const report of reports) {
      assert.equal(evaluateWebsiteAuditReport(report, repositoryLock).passed, false)
    }
  })

  test('rejects a falsely clean report while the lock has vulnerable braces nodes', () => {
    const report = knownReport()
    report.vulnerabilities = {}
    recount(report)

    const result = evaluateWebsiteAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing.*braces/i)
  })

  test('binds the braces exception to exact version, registry, and integrity', () => {
    for (const field of ['version', 'resolved', 'integrity'] as const) {
      const lock = structuredClone(repositoryLock) as {
        packages: Record<string, Record<string, unknown>>
      }

      lock.packages['node_modules/braces'][field] = 'drift'

      const result = evaluateWebsiteAuditReport(knownReport(), lock)

      assert.equal(result.passed, false)
      assert.match(result.errors.join('\n'), new RegExp(`braces.*${field}`, 'i'))
    }
  })

  test('rejects any semantic lock artifact drift', () => {
    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, Record<string, unknown>>
    }

    lock.packages['node_modules/react'].version = '0.0.0-drift'

    const result = evaluateWebsiteAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /lock artifact.*drift/i)
  })

  test('derives closure from dependency edges rather than the npm effects snapshot', () => {
    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, { dependencies?: Record<string, string> }>
    }

    delete lock.packages['node_modules/chokidar'].dependencies?.braces

    const result = evaluateWebsiteAuditReport(knownReport(), lock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /lock artifact.*drift|unexpected vulnerable package: chokidar/i)
  })

  test('requires the patched webpack-dev-middleware artifact', () => {
    assert.deepEqual(validateWebsiteLock(repositoryLock), [])
    const packages = (repositoryLock as { packages: Record<string, { version: string }> }).packages
    assert.equal(packages['node_modules/webpack-dev-middleware'].version, '7.4.6')
  })
})
