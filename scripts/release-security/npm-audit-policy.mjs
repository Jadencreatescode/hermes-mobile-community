import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Electron Builder 27 removes the vulnerable global-agent -> roarr -> sprintf-js
// development closure. Bind that remediation to the exact reviewed artifacts and
// dependency edges so a newer-looking version or graph drift still fails closed.
const REVIEWED_PATCHED_PACKAGES = {
  '@electron/get': {
    artifacts: [
      {
        node: 'node_modules/@electron/get',
        version: '5.1.0',
        resolved: 'https://registry.npmjs.org/@electron/get/-/get-5.1.0.tgz',
        integrity: 'sha512-3kSBtG8ObcTVfXanm5vVJ6UnBLEVmVsRk1M+vGqCuMBV+XLCbJYuWQful+yIy0GQDsSlK0kHEriEHn7SPk4EnA==',
        dev: true
      }
    ],
    edges: [
      {
        node: 'apps/desktop/node_modules/app-builder-lib',
        section: 'dependencies',
        spec: '^5.0.0'
      },
      {
        node: 'apps/desktop/node_modules/electron',
        section: 'dependencies',
        spec: '^5.0.0'
      }
    ]
  },
  'app-builder-lib': {
    artifacts: [
      {
        node: 'apps/desktop/node_modules/app-builder-lib',
        version: '27.0.0-alpha.6',
        resolved: 'https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-27.0.0-alpha.6.tgz',
        integrity: 'sha512-XWQfZQJ7gTudBUQ49cId4hv7Z+JXNm+i8eR8Nj6pFVPMsCoEWRrbHLay1/W0HpHCEcSrR+7G6A+/yMrtR5AtZw==',
        dev: true
      }
    ],
    edges: [
      {
        node: 'apps/desktop/node_modules/dmg-builder',
        section: 'dependencies',
        spec: '27.0.0-alpha.6'
      },
      {
        node: 'apps/desktop/node_modules/electron-builder',
        section: 'dependencies',
        spec: '27.0.0-alpha.6'
      },
      {
        node: 'apps/desktop/node_modules/electron-builder-squirrel-windows',
        section: 'dependencies',
        spec: '27.0.0-alpha.6'
      }
    ]
  },
  'dmg-builder': {
    artifacts: [
      {
        node: 'apps/desktop/node_modules/dmg-builder',
        version: '27.0.0-alpha.6',
        resolved: 'https://registry.npmjs.org/dmg-builder/-/dmg-builder-27.0.0-alpha.6.tgz',
        integrity: 'sha512-3bvNvPmeeHVoWyR0iW6pX3lQG94sacieuiwvb3o5s6sn1GtjS6XQuKHHNrRZAi3PnDJ/XkfwuI6RIsJfsuqa6g==',
        dev: true
      }
    ],
    edges: [
      {
        node: 'apps/desktop/node_modules/app-builder-lib',
        section: 'peerDependencies',
        spec: '27.0.0-alpha.6'
      },
      {
        node: 'apps/desktop/node_modules/electron-builder',
        section: 'dependencies',
        spec: '27.0.0-alpha.6'
      }
    ]
  },
  'electron-builder': {
    artifacts: [
      {
        node: 'apps/desktop/node_modules/electron-builder',
        version: '27.0.0-alpha.6',
        resolved: 'https://registry.npmjs.org/electron-builder/-/electron-builder-27.0.0-alpha.6.tgz',
        integrity: 'sha512-vnsyKuG60X3+Dyl2VnxVoPxndjnXlczb15qE250hpAkIEtu5T/edNmSihDZw7GEZw15zU8g/4egEqaIfeatn0w==',
        dev: true
      }
    ],
    edges: [
      {
        node: 'apps/desktop',
        section: 'devDependencies',
        spec: '27.0.0-alpha.6'
      }
    ]
  },
  'electron-builder-squirrel-windows': {
    artifacts: [
      {
        node: 'apps/desktop/node_modules/electron-builder-squirrel-windows',
        version: '27.0.0-alpha.6',
        resolved: 'https://registry.npmjs.org/electron-builder-squirrel-windows/-/electron-builder-squirrel-windows-27.0.0-alpha.6.tgz',
        integrity: 'sha512-WjFLFsuI5Yd9A+3ZohGWnaiLYYALd/0gH+1TmfyANym3r1YnxltXsdK3OvfpVUTurnEmABYfRhgQBwKVOd3xgg==',
        dev: true
      }
    ],
    edges: [
      {
        node: 'apps/desktop/node_modules/app-builder-lib',
        section: 'peerDependencies',
        spec: '27.0.0-alpha.6'
      }
    ]
  }
}

const RETIRED_VULNERABLE_NODES = [
  'node_modules/global-agent',
  'node_modules/roarr',
  'node_modules/sprintf-js'
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

function sameValue(actual, expected) {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))
}

function incomingEdges(packages, dependencyName) {
  const edges = []
  for (const [node, locked] of Object.entries(packages)) {
    if (!isRecord(locked)) continue
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = locked[section]
      if (isRecord(dependencies) && Object.hasOwn(dependencies, dependencyName)) {
        edges.push({ node, section, spec: dependencies[dependencyName] })
      }
    }
  }
  return edges.sort((left, right) =>
    `${left.node}:${left.section}:${left.spec}`.localeCompare(`${right.node}:${right.section}:${right.spec}`)
  )
}

function validateArtifact(name, expected, packages, errors) {
  const locked = packages[expected.node]
  if (!isRecord(locked)) {
    errors.push(`${name} lockfile node is missing: ${expected.node}`)
    return
  }
  if (locked.version !== expected.version) {
    errors.push(`${name} version changed from reviewed ${expected.version} to ${locked.version ?? '<missing>'}`)
  }
  if (locked.resolved !== expected.resolved) {
    errors.push(`${name} registry identity changed or is missing at ${expected.node}`)
  }
  if (locked.integrity !== expected.integrity) {
    errors.push(`${name} integrity changed or is missing at ${expected.node}`)
  }
  if (expected.dev === true && locked.dev !== true) {
    errors.push(`${name} is not development only at ${expected.node}`)
  }
}

export function validateRootLock(lock) {
  const errors = []
  const packages = isRecord(lock?.packages) ? lock.packages : null
  if (!packages) return ['missing lockfile package map']

  for (const [name, policy] of Object.entries(REVIEWED_PATCHED_PACKAGES)) {
    for (const artifact of policy.artifacts) validateArtifact(name, artifact, packages, errors)
    const actualEdges = incomingEdges(packages, name)
    const expectedEdges = [...policy.edges].sort((left, right) =>
      `${left.node}:${left.section}:${left.spec}`.localeCompare(`${right.node}:${right.section}:${right.spec}`)
    )
    if (!sameValue(actualEdges, expectedEdges)) {
      errors.push(`${name} appeared at an unreviewed dependency edge or lost a reviewed edge`)
    }
  }

  for (const node of RETIRED_VULNERABLE_NODES) {
    if (Object.hasOwn(packages, node)) {
      errors.push(`retired vulnerable lockfile node was reintroduced: ${node}`)
    }
  }

  return errors
}

function validateCounts(counts, vulnerabilities, errors) {
  const severities = ['info', 'low', 'moderate', 'high', 'critical']
  const expectedCountKeys = [...severities, 'total'].sort()
  if (!sameValue(Object.keys(counts).sort(), expectedCountKeys)) {
    errors.push('audit metadata vulnerability counts have missing or unexpected fields')
  }
  for (const severity of [...severities, 'total']) {
    const count = counts[severity]
    if (!Number.isInteger(count) || count < 0) errors.push(`invalid audit metadata count for ${severity}`)
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
    errors.push(`audit metadata total ${counts.total} does not match vulnerability map size ${Object.keys(vulnerabilities).length}`)
  }
  if (
    severities.every(severity => Number.isInteger(counts[severity])) &&
    Number.isInteger(counts.total) &&
    counts.total !== severities.reduce((total, severity) => total + counts[severity], 0)
  ) {
    errors.push('audit metadata total does not equal the sum of severity counts')
  }
  if (Number(counts.critical ?? 0) > 0) {
    errors.push(`critical advisories are never allowed: ${counts.critical}`)
  }
}

export function evaluateAuditReport(report, lock) {
  const errors = [...validateRootLock(lock)]
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}

  if (!isRecord(report)) errors.push('audit report is malformed')
  if (!isRecord(report?.metadata?.vulnerabilities)) errors.push('missing audit metadata vulnerability counts')
  if (!isRecord(report?.vulnerabilities)) errors.push('missing vulnerability map')
  if (report?.auditReportVersion !== 2) errors.push('missing or unsupported audit report version')

  validateCounts(counts, vulnerabilities, errors)

  for (const name of Object.keys(vulnerabilities)) {
    errors.push(`unapproved vulnerable package: ${name}`)
  }

  if (Number.isInteger(counts.total) && counts.total !== 0) {
    errors.push(`root audit must be clean; npm reported ${counts.total} vulnerable packages`)
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', '--audit-level=high'], {
    cwd: projectRoot,
    encoding: 'utf8'
  })

  let report
  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    console.error('npm audit did not return valid JSON')
    if (result.stderr) console.error(result.stderr.trim())
    process.exit(1)
  }

  if (result.error || report.error) {
    console.error(`npm audit failed: ${report.error?.summary ?? result.error?.message ?? 'unknown error'}`)
    process.exit(1)
  }

  let lock
  try {
    lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  } catch (error) {
    console.error(`package lock could not be read: ${error.message}`)
    process.exit(1)
  }

  const evaluation = evaluateAuditReport(report, lock)
  if (!evaluation.passed) {
    console.error('npm audit policy failed')
    for (const error of evaluation.errors) console.error(`  ${error}`)
    process.exit(1)
  }

  console.log('npm audit policy passed with no known vulnerabilities against the reviewed Electron Builder 27 lock graph')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
