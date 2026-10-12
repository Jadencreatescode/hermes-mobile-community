import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// sprintf-js 1.1.3 has no patched 1.x release. It is reachable only through
// Electron Builder's development-only packaging path. Keep this exception
// closed over the exact audit fan-out, lockfile nodes, registry artifacts, and
// dependency edges so any new advisory, runtime path, or graph drift fails.
const POLICIES = {
  '@electron/get': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set([
      'apps/desktop/node_modules/electron:dependencies',
      'node_modules/app-builder-lib:dependencies'
    ]),
    allowedReferences: new Set(['global-agent']),
    allowedNodes: new Set(['node_modules/app-builder-lib/node_modules/@electron/get']),
    expectedIntegrity: 'sha512-F+nKc0xW+kVbBRhFzaMgPy3KwmuNTYX1fx6+FxxoSnNgwYX6LD7AKBTWkU0MQ6IBoe7dz069CNkR673sPAgkCQ==',
    expectedResolved: 'https://registry.npmjs.org/@electron/get/-/get-3.1.0.tgz',
    expectedVersion: '3.1.0'
  },
  'app-builder-lib': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set([
      'node_modules/dmg-builder:dependencies',
      'node_modules/electron-builder:dependencies',
      'node_modules/electron-builder-squirrel-windows:dependencies'
    ]),
    allowedReferences: new Set([
      '@electron/get',
      'dmg-builder',
      'electron-builder-squirrel-windows'
    ]),
    allowedNodes: new Set(['node_modules/app-builder-lib']),
    expectedIntegrity: 'sha512-2VnyWkqsP5v5XbBhL3tD5Syx8iNPBYsoU7kY4S2fz7wg8Rj/nztWKCUzGKaFRTv0Xwf3/H058CR1Kvtd/3lRow==',
    expectedResolved: 'https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz',
    expectedVersion: '26.15.3'
  },
  'dmg-builder': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set([
      'node_modules/app-builder-lib:peerDependencies',
      'node_modules/electron-builder:dependencies'
    ]),
    allowedReferences: new Set(['app-builder-lib']),
    allowedNodes: new Set(['node_modules/dmg-builder']),
    expectedIntegrity: 'sha512-O3zJUFUYHJKgzPqioHxfxzBzlSC1eXCSr79gMSBKBP5AgjjpmrydMsMLotEg9fAJF36vdUncb+4ndRNxoPdlSQ==',
    expectedResolved: 'https://registry.npmjs.org/dmg-builder/-/dmg-builder-26.15.3.tgz',
    expectedVersion: '26.15.3'
  },
  'electron-builder': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set(['apps/desktop:devDependencies']),
    allowedReferences: new Set(['app-builder-lib', 'dmg-builder']),
    allowedNodes: new Set(['node_modules/electron-builder']),
    expectedIntegrity: 'sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==',
    expectedResolved: 'https://registry.npmjs.org/electron-builder/-/electron-builder-26.15.3.tgz',
    expectedVersion: '26.15.3'
  },
  'electron-builder-squirrel-windows': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set(['node_modules/app-builder-lib:peerDependencies']),
    allowedReferences: new Set(['app-builder-lib']),
    allowedNodes: new Set(['node_modules/electron-builder-squirrel-windows']),
    expectedIntegrity: 'sha512-Jc19XPV9y9+2bAdZPkXuVNGNIEFBq9poHC61l8Kv6FdK7DRG3+Ic0rerC0DXOaeHNz8yW0fg/JnF8GQROOF5MA==',
    expectedResolved: 'https://registry.npmjs.org/electron-builder-squirrel-windows/-/electron-builder-squirrel-windows-26.15.3.tgz',
    expectedVersion: '26.15.3'
  },
  'global-agent': {
    allowedAdvisories: new Set(),
    allowedEdges: new Set(['node_modules/app-builder-lib/node_modules/@electron/get:optionalDependencies']),
    allowedReferences: new Set(['roarr']),
    allowedNodes: new Set(['node_modules/global-agent']),
    expectedIntegrity: 'sha512-PT6XReJ+D07JvGoxQMkT6qji/jVNfX/h364XHZOWeRzy64sSFr+xJ5OX7LI3b4MPQzdL4H8Y8M0xzPpsVMwA8Q==',
    expectedResolved: 'https://registry.npmjs.org/global-agent/-/global-agent-3.0.0.tgz',
    expectedVersion: '3.0.0'
  },
  roarr: {
    allowedAdvisories: new Set(),
    allowedEdges: new Set(['node_modules/global-agent:dependencies']),
    allowedReferences: new Set(['sprintf-js']),
    allowedNodes: new Set(['node_modules/roarr']),
    expectedIntegrity: 'sha512-CHhPh+UNHD2GTXNYhPWLnU8ONHdI+5DI+4EYIAOaiD63rHeYlZvyh8P+in5999TTSFgUYuKUAjzRI4mdh/p+2A==',
    expectedResolved: 'https://registry.npmjs.org/roarr/-/roarr-2.15.4.tgz',
    expectedVersion: '2.15.4'
  },
  'sprintf-js': {
    allowedAdvisories: new Set([
      'https://github.com/advisories/GHSA-hp3w-g68c-fv3c'
    ]),
    allowedEdges: new Set(['node_modules/roarr:dependencies']),
    allowedReferences: new Set(),
    allowedNodes: new Set(['node_modules/sprintf-js']),
    expectedIntegrity: 'sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==',
    expectedResolved: 'https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz',
    expectedVersion: '1.1.3'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dependencyEdges(packages, dependencyName) {
  const edges = new Set()

  for (const [node, locked] of Object.entries(packages)) {
    if (!isRecord(locked)) continue

    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = locked[section]

      if (isRecord(dependencies) && Object.hasOwn(dependencies, dependencyName)) {
        edges.add(`${node}:${section}`)
      }
    }
  }

  return edges
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

      if (locked.resolved !== policy.expectedResolved) {
        errors.push(`${name} registry identity changed or is missing at ${node}`)
      }

      if (locked.integrity !== policy.expectedIntegrity) {
        errors.push(`${name} integrity changed or is missing at ${node}`)
      }

      if (locked.dev !== true) {
        errors.push(`${name} is not development only at ${node}`)
      }
    }

    const edges = dependencyEdges(packages, name)

    for (const edge of edges) {
      if (!policy.allowedEdges.has(edge)) {
        errors.push(`${name} appeared at an unreviewed dependency edge: ${edge}`)
      }
    }

    for (const edge of policy.allowedEdges) {
      if (!edges.has(edge)) {
        errors.push(`${name} reviewed dependency edge is missing: ${edge}`)
      }
    }

    const via = Array.isArray(finding?.via) ? finding.via : []
    const advisoryDetails = via.filter(source => typeof source !== 'string')

    if (policy.allowedAdvisories.size > 0 && advisoryDetails.length === 0) {
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
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
      `npm audit policy passed with ${total} documented development-only sprintf-js transitive findings`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
