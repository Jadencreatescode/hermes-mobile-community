import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REVIEWED_PATCHED_PACKAGES = {
  'music-metadata': {
    node: 'node_modules/music-metadata',
    version: '11.16.1',
    resolved: 'https://registry.npmjs.org/music-metadata/-/music-metadata-11.16.1.tgz',
    integrity: 'sha512-uR/mHK6eyfl8h3jVCobF5b38Mfg1IDJMiBxIVbmm5F+G1OXEFcUpQHveO84tJBAqvY93GCRY2R4kDyx7s06Rug=='
  },
  sharp: {
    node: 'node_modules/sharp',
    version: '0.35.5',
    resolved: 'https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz',
    integrity: 'sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g=='
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function validateCounts(counts, vulnerabilities, errors) {
  const severities = ['info', 'low', 'moderate', 'high', 'critical']
  const expectedKeys = [...severities, 'total'].sort()
  if (!sameValue(Object.keys(counts).sort(), expectedKeys)) {
    errors.push('audit metadata vulnerability counts have missing or unexpected fields')
  }

  for (const severity of [...severities, 'total']) {
    const count = counts[severity]
    if (!Number.isInteger(count) || count < 0) {
      errors.push(`invalid audit metadata count for ${severity}`)
    }
  }

  const derived = Object.fromEntries(severities.map(severity => [severity, 0]))
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!isRecord(finding) || !severities.includes(finding.severity)) {
      errors.push(`${name} vulnerability finding has a missing or invalid severity`)
      continue
    }
    derived[finding.severity] += 1
  }

  for (const severity of severities) {
    if (Number.isInteger(counts[severity]) && counts[severity] !== derived[severity]) {
      errors.push(`audit metadata ${severity} count ${counts[severity]} does not match findings ${derived[severity]}`)
    }
  }

  if (Number.isInteger(counts.total) && counts.total !== Object.keys(vulnerabilities).length) {
    errors.push(
      `audit metadata total ${counts.total} does not match vulnerability map size ${Object.keys(vulnerabilities).length}`
    )
  }
  if (
    severities.every(severity => Number.isInteger(counts[severity])) &&
    Number.isInteger(counts.total) &&
    counts.total !== severities.reduce((total, severity) => total + counts[severity], 0)
  ) {
    errors.push('audit metadata total does not equal the sum of severity counts')
  }
}

export function validateWhatsAppLock(lock) {
  const errors = []
  const packages = isRecord(lock?.packages) ? lock.packages : null

  if (!packages) {
    return ['missing lockfile package map']
  }

  for (const [name, expected] of Object.entries(REVIEWED_PATCHED_PACKAGES)) {
    const locked = packages[expected.node]

    if (!isRecord(locked)) {
      errors.push(`${name} lockfile node is missing: ${expected.node}`)
      continue
    }

    if (locked.version !== expected.version) {
      errors.push(`${name} must remain locked to patched version ${expected.version}`)
    }
    if (locked.resolved !== expected.resolved) {
      errors.push(`${name} registry identity changed or is missing`)
    }
    if (locked.integrity !== expected.integrity) {
      errors.push(`${name} integrity changed or is missing`)
    }
  }

  return errors
}

export function evaluateProductionAuditReport(report, lock) {
  const errors = [...validateWhatsAppLock(lock)]
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}

  if (!isRecord(report)) {
    errors.push('audit report is malformed')
  }

  if (!isRecord(report?.metadata?.vulnerabilities)) {
    errors.push('missing audit metadata vulnerability counts')
  }

  if (!isRecord(report?.vulnerabilities)) {
    errors.push('missing vulnerability map')
  }

  if (report?.auditReportVersion !== 2) {
    errors.push('missing or unsupported audit report version')
  }

  validateCounts(counts, vulnerabilities, errors)

  for (const name of Object.keys(vulnerabilities)) {
    errors.push(`production vulnerability: ${name}`)
  }

  if (Number.isInteger(counts.total) && counts.total !== 0) {
    errors.push(`production audit must be clean; npm reported ${counts.total} vulnerable packages`)
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'whatsapp-bridge')
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], {
    cwd: bridgeRoot,
    encoding: 'utf8'
  })

  let report

  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    console.error('WhatsApp production npm audit did not return valid JSON')
    if (result.stderr) console.error(result.stderr.trim())
    process.exit(1)
  }

  if (result.error || report.error) {
    console.error(
      `WhatsApp production npm audit failed: ${report.error?.summary ?? result.error?.message ?? 'unknown error'}`
    )
    process.exit(1)
  }

  let lock
  try {
    lock = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'package-lock.json'), 'utf8'))
  } catch (error) {
    console.error(`WhatsApp package lock could not be read: ${error.message}`)
    process.exit(1)
  }

  const evaluation = evaluateProductionAuditReport(report, lock)

  if (!evaluation.passed) {
    console.error('WhatsApp production npm audit policy failed')
    for (const error of evaluation.errors) console.error(`  ${error}`)
    process.exit(1)
  }

  console.log('WhatsApp production npm audit policy passed with no known vulnerabilities')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
