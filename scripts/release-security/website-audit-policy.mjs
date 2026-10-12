import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// npm's metavulnerability presentation is intentionally not pinned. The only
// exception is the unpatched braces leaf advisory; its complete transitive
// closure and concrete vulnerable nodes are derived from this reviewed lock.
const REVIEWED_LOCK_SHA256 = 'b136067831a38784daeb35a923553b4ff2877b39737a6ddceea0487cd1ea9883'
const FINDING_KEYS = ['effects', 'fixAvailable', 'isDirect', 'name', 'nodes', 'range', 'severity', 'via']
const COUNT_KEYS = ['critical', 'high', 'info', 'low', 'moderate', 'total']
const PRODUCTION_SECTIONS = ['dependencies', 'optionalDependencies']

const REVIEWED_ARTIFACTS = {
  braces: {
    node: 'node_modules/braces',
    version: '3.0.3',
    resolved: 'https://registry.npmjs.org/braces/-/braces-3.0.3.tgz',
    integrity: 'sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA=='
  },
  'http-cache-semantics': {
    node: 'node_modules/http-cache-semantics',
    version: '4.3.0',
    resolved: 'https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.3.0.tgz',
    integrity: 'sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA=='
  },
  'webpack-dev-middleware': {
    node: 'node_modules/webpack-dev-middleware',
    version: '7.4.6',
    resolved: 'https://registry.npmjs.org/webpack-dev-middleware/-/webpack-dev-middleware-7.4.6.tgz',
    integrity: 'sha512-yBWCMvIfUmuhAE8vdqUKzH0vg9kuWN0KeG4vBnqRplUFHRU7lMQjkiJWxVQzvo2BTewqhPhDlMB41rAt2jVA9A=='
  }
}

const BRACES_ADVISORY = {
  source: 1240992,
  name: 'braces',
  dependency: 'braces',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  severity: 'high',
  cwe: ['CWE-674'],
  cvss: {
    score: 7.5,
    vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H'
  },
  range: '<=3.0.3'
}

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

function sameMembers(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) &&
    sameValue([...actual].sort(), [...expected].sort())
}

function isUniqueStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string') &&
    new Set(value).size === value.length
}

function isValidFixPresentation(value) {
  if (typeof value === 'boolean') return true
  if (!isRecord(value)) return false
  return sameValue(Object.keys(value).sort(), ['isSemVerMajor', 'name', 'version']) &&
    typeof value.isSemVerMajor === 'boolean' &&
    typeof value.name === 'string' && value.name.length > 0 &&
    typeof value.version === 'string' && value.version.length > 0
}

function lockDigest(lock) {
  return createHash('sha256').update(JSON.stringify(canonical(lock))).digest('hex')
}

function validateArtifact(name, expected, packages, errors) {
  const locked = packages[expected.node]
  if (!isRecord(locked)) {
    errors.push(`${name} lockfile node is missing: ${expected.node}`)
    return
  }
  for (const field of ['version', 'resolved', 'integrity']) {
    if (locked[field] !== expected[field]) {
      errors.push(`${name} ${field} changed from the reviewed artifact`)
    }
  }
}

export function validateWebsiteLock(lock) {
  const errors = []
  const packages = isRecord(lock?.packages) ? lock.packages : null
  if (!packages) return ['missing lockfile package map']

  for (const [name, artifact] of Object.entries(REVIEWED_ARTIFACTS)) {
    validateArtifact(name, artifact, packages, errors)
  }
  if (lockDigest(lock) !== REVIEWED_LOCK_SHA256) {
    errors.push('website lock artifact drifted from the reviewed semantic graph')
  }
  return errors
}

function packageName(node) {
  const marker = 'node_modules/'
  return node.slice(node.lastIndexOf(marker) + marker.length)
}

function resolveDependency(packages, parentNode, dependencyName) {
  let base = parentNode
  while (true) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${dependencyName}`
    if (Object.hasOwn(packages, candidate)) return candidate

    const nested = base.lastIndexOf('/node_modules/')
    if (nested >= 0) {
      base = base.slice(0, nested)
    } else if (base.startsWith('node_modules/')) {
      base = ''
    } else {
      return null
    }
  }
}

function deriveBracesClosure(packages, errors) {
  const leaf = REVIEWED_ARTIFACTS.braces.node
  const reverse = new Map(Object.keys(packages).map(node => [node, new Set()]))

  for (const [parentNode, locked] of Object.entries(packages)) {
    if (!isRecord(locked)) continue
    for (const section of PRODUCTION_SECTIONS) {
      const dependencies = locked[section]
      if (!isRecord(dependencies)) continue
      for (const dependencyName of Object.keys(dependencies)) {
        const childNode = resolveDependency(packages, parentNode, dependencyName)
        if (!childNode) {
          errors.push(`lock graph cannot resolve ${dependencyName} from ${parentNode || '<root>'}`)
          continue
        }
        reverse.get(childNode)?.add(parentNode)
      }
    }
  }

  const nodes = new Set([leaf])
  const pending = [leaf]
  while (pending.length > 0) {
    const child = pending.pop()
    for (const parent of reverse.get(child) ?? []) {
      if (nodes.has(parent)) continue
      nodes.add(parent)
      pending.push(parent)
    }
  }
  nodes.delete('')

  const byName = new Map()
  for (const node of nodes) {
    const name = packageName(node)
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(node)
  }
  for (const packageNodes of byName.values()) packageNodes.sort()
  return byName
}

function validateCounts(counts, vulnerabilities, errors) {
  if (!isRecord(counts)) {
    errors.push('missing audit metadata vulnerability counts')
    return
  }
  if (!sameValue(Object.keys(counts).sort(), COUNT_KEYS)) {
    errors.push('audit metadata vulnerability counts have missing or unexpected fields')
  }

  const derived = { critical: 0, high: 0, info: 0, low: 0, moderate: 0, total: 0 }
  for (const finding of Object.values(vulnerabilities)) {
    if (isRecord(finding) && Object.hasOwn(derived, finding.severity) && finding.severity !== 'total') {
      derived[finding.severity] += 1
    }
    derived.total += 1
  }

  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      errors.push(`invalid audit metadata count for ${key}`)
    } else if (counts[key] !== derived[key]) {
      errors.push(`audit metadata ${key} count does not match findings`)
    }
  }
  if (counts.critical > 0) errors.push('critical advisories are never allowed')
}

function validateFinding(name, finding, expectedNodes, closureNames, directNames, errors) {
  if (!isRecord(finding)) {
    errors.push(`${name} finding is malformed`)
    return
  }
  if (!sameValue(Object.keys(finding).sort(), FINDING_KEYS)) {
    errors.push(`${name} finding has missing or unexpected fields`)
  }
  if (finding.name !== name) errors.push(`${name} finding name is malformed`)
  if (finding.severity !== 'high') errors.push(`${name} severity must remain high`)
  if (finding.isDirect !== directNames.has(name)) errors.push(`${name} directness contradicts the lock graph`)
  if (!sameMembers(finding.nodes, expectedNodes)) errors.push(`${name} vulnerable nodes contradict the lock graph`)
  if (!isUniqueStringArray(finding.effects) || finding.effects.some(effect => !closureNames.has(effect))) {
    errors.push(`${name} effects are malformed or escape the lock-derived closure`)
  }
  if (typeof finding.range !== 'string' || !finding.range) errors.push(`${name} range is malformed`)
  if (!isValidFixPresentation(finding.fixAvailable)) {
    errors.push(`${name} fix availability is malformed`)
  }

  if (name === 'braces') {
    if (!sameValue(finding.via, [BRACES_ADVISORY])) {
      errors.push('braces advisory provenance does not match the reviewed no-patch leaf')
    }
    if (finding.fixAvailable !== false) {
      errors.push('braces now reports a fix and must not use the no-patch exception')
    }
    return
  }

  if (!Array.isArray(finding.via) || finding.via.length === 0) {
    errors.push(`${name} transitive provenance is missing or malformed`)
  } else if (finding.via.some(source => typeof source !== 'string')) {
    errors.push(`only braces may contain advisory details; ${name} introduced another leaf advisory`)
  } else if (!isUniqueStringArray(finding.via)) {
    errors.push(`${name} transitive provenance is duplicated or malformed`)
  } else if (finding.via.some(source => !closureNames.has(source))) {
    errors.push(`${name} transitive provenance escapes the lock-derived closure`)
  }
}

export function evaluateWebsiteAuditReport(report, lock) {
  const errors = [...validateWebsiteLock(lock)]
  const packages = isRecord(lock?.packages) ? lock.packages : {}
  const closure = deriveBracesClosure(packages, errors)
  const closureNames = new Set(closure.keys())
  const directNames = new Set(Object.keys(isRecord(packages['']?.dependencies) ? packages[''].dependencies : {}))

  if (!isRecord(report)) errors.push('audit report is malformed')
  if (report?.auditReportVersion !== 2) errors.push('missing or unsupported audit report version')
  if (!isRecord(report?.vulnerabilities)) errors.push('missing vulnerability map')
  if (!isRecord(report?.metadata?.vulnerabilities)) errors.push('missing audit metadata vulnerability counts')

  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}
  validateCounts(report?.metadata?.vulnerabilities, vulnerabilities, errors)

  const actualNames = new Set(Object.keys(vulnerabilities))
  for (const name of closureNames) {
    if (!actualNames.has(name)) errors.push(`missing lock-derived vulnerable package: ${name}`)
  }
  for (const name of actualNames) {
    if (!closureNames.has(name)) errors.push(`unexpected vulnerable package: ${name}`)
  }
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!closure.has(name)) continue
    validateFinding(name, finding, closure.get(name), closureNames, directNames, errors)
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'website')
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    '--yes', 'npm@11.17.0', 'audit', '--omit=dev', '--json', '--audit-level=high'
  ], { cwd: projectRoot, encoding: 'utf8' })

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
    console.error(`website package lock could not be read: ${error.message}`)
    process.exit(1)
  }

  const evaluation = evaluateWebsiteAuditReport(report, lock)
  if (!evaluation.passed) {
    console.error('website npm audit policy failed')
    for (const error of evaluation.errors) console.error(`  ${error}`)
    process.exit(1)
  }

  console.log(`website npm audit policy passed with ${report.metadata.vulnerabilities.total} lock-derived braces findings (no patched braces release)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
