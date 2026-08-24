import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const POLICIES = {
  electron: {
    allowedAdvisories: new Set([
      'https://github.com/advisories/GHSA-9f4c-93c8-jc8g',
      'https://github.com/advisories/GHSA-r4w5-6pfg-jxp5'
    ]),
    allowedReferences: new Set(['extract-zip']),
    allowedNodes: new Set(['apps/desktop/node_modules/electron']),
    expectedVersion: '40.10.2'
  },
  'extract-zip': {
    allowedAdvisories: new Set([
      'https://github.com/advisories/GHSA-jmr9-qjv8-65gv'
    ]),
    allowedReferences: new Set(),
    allowedNodes: new Set(['node_modules/extract-zip']),
    expectedVersion: '2.0.1'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function evaluateAuditReport(report, lock) {
  const errors = []
  const counts = isRecord(report?.metadata?.vulnerabilities)
    ? report.metadata.vulnerabilities
    : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}
  const packages = isRecord(lock?.packages) ? lock.packages : {}

  if (!isRecord(report?.metadata?.vulnerabilities)) {
    errors.push('missing audit metadata vulnerability counts')
  }

  if (!isRecord(report?.vulnerabilities)) {
    errors.push('missing vulnerability map')
  }

  if (!isRecord(lock?.packages)) {
    errors.push('missing lockfile package map')
  }

  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    const count = counts[severity]
    if (!Number.isInteger(count) || count < 0) {
      errors.push(`invalid audit metadata count for ${severity}`)
    }
  }

  if (Number.isInteger(counts.total) && counts.total !== Object.keys(vulnerabilities).length) {
    errors.push(
      `audit metadata total ${counts.total} does not match vulnerability map size ${Object.keys(vulnerabilities).length}`
    )
  }

  if (Number(counts.critical ?? 0) > 0) {
    errors.push(`critical advisories are never allowed: ${counts.critical}`)
  }

  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const policy = POLICIES[name]

    if (!policy) {
      errors.push(`unapproved vulnerable package: ${name}`)
      continue
    }

    const nodes = Array.isArray(finding?.nodes) ? finding.nodes : []

    if (nodes.length === 0) {
      errors.push(`${name} has no lockfile nodes to validate`)
    }

    for (const node of nodes) {
      if (!policy.allowedNodes.has(node)) {
        errors.push(`${name} appeared at an unreviewed lockfile node: ${node}`)
      }

      const locked = packages[node]

      if (!locked) {
        errors.push(`${name} lockfile node is missing: ${node}`)
        continue
      }

      if (locked.version !== policy.expectedVersion) {
        errors.push(
          `${name} version changed from reviewed ${policy.expectedVersion} to ${locked.version ?? '<missing>'}`
        )
      }

      if (locked.dev !== true) {
        errors.push(`${name} is not development only at ${node}`)
      }
    }

    const via = Array.isArray(finding?.via) ? finding.via : []
    const advisoryDetails = via.filter(source => typeof source !== 'string')

    if (advisoryDetails.length === 0) {
      errors.push(`${name} has no advisory details to validate`)
    }

    for (const source of via) {
      if (typeof source === 'string') {
        if (!policy.allowedReferences.has(source)) {
          errors.push(`unapproved advisory reference for ${name}: ${source}`)
        }
        continue
      }

      const url = source?.url

      if (!url || !policy.allowedAdvisories.has(url)) {
        errors.push(`unapproved advisory for ${name}: ${url ?? '<missing URL>'}`)
      }
    }
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['audit', '--json', '--audit-level=high'],
    { cwd: root, encoding: 'utf8' }
  )

  let report

  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    console.error('npm audit did not return valid JSON')
    if (result.stderr) {
      console.error(result.stderr.trim())
    }
    process.exit(1)
  }

  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? report.error.code ?? 'unknown error'}`)
    process.exit(1)
  }

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const evaluation = evaluateAuditReport(report, lock)

  if (!evaluation.passed) {
    console.error('npm audit policy failed')
    for (const error of evaluation.errors) {
      console.error(`  ${error}`)
    }
    process.exit(1)
  }

  const total = Number(report.metadata.vulnerabilities.total)
  if (total === 0) {
    console.log('npm audit policy passed with no known vulnerabilities')
  } else {
    console.log(
      `npm audit policy passed with ${total} documented development only Electron findings`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
