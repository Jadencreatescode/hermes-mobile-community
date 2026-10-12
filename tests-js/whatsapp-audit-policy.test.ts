import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, test } from 'vitest'

import {
  evaluateProductionAuditReport,
  validateWhatsAppLock
} from '../scripts/release-security/whatsapp-audit-policy.mjs'

const repositoryLock = JSON.parse(
  fs.readFileSync(new URL('../scripts/whatsapp-bridge/package-lock.json', import.meta.url), 'utf8')
) as Record<string, unknown>

function cleanReport() {
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 }
    },
    vulnerabilities: {}
  }
}

describe('WhatsApp production npm audit policy', () => {
  test('accepts a clean production report against the patched repository lock', () => {
    assert.deepEqual(evaluateProductionAuditReport(cleanReport(), repositoryLock), {
      errors: [],
      passed: true
    })
  })

  test('requires patched music-metadata in the exact lock', () => {
    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, { version?: string }>
    }

    lock.packages['node_modules/music-metadata'].version = '11.15.0'

    assert.match(validateWhatsAppLock(lock).join('\n'), /music-metadata.*11\.16\.0/i)
  })

  test('requires patched sharp in the exact lock', () => {
    const lock = structuredClone(repositoryLock) as {
      packages: Record<string, { version?: string }>
    }

    lock.packages['node_modules/sharp'].version = '0.35.4'

    assert.match(validateWhatsAppLock(lock).join('\n'), /sharp.*0\.35\.5/i)
  })

  test('fails closed on every production advisory severity', () => {
    const report = cleanReport() as {
      metadata: { vulnerabilities: Record<string, number> }
      vulnerabilities: Record<string, unknown>
    }

    report.metadata.vulnerabilities.low = 1
    report.metadata.vulnerabilities.total = 1
    report.vulnerabilities.example = {
      severity: 'low',
      nodes: ['node_modules/example'],
      via: [{ url: 'https://github.com/advisories/GHSA-example' }]
    }

    const result = evaluateProductionAuditReport(report, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /production vulnerability: example/i)
  })

  test('rejects a structurally incomplete audit report', () => {
    const result = evaluateProductionAuditReport({}, repositoryLock)

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing audit metadata/i)
    assert.match(result.errors.join('\n'), /missing vulnerability map/i)
  })

  test('rejects a lockfile without a package map', () => {
    const result = evaluateProductionAuditReport(cleanReport(), {})

    assert.equal(result.passed, false)
    assert.match(result.errors.join('\n'), /missing lockfile package map/i)
  })
})
