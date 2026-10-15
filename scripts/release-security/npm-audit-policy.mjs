import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// sprintf-js 1.1.3 has no patched 1.x release and is reachable only through
// Electron Builder's development-only packaging path. Bind the exception to
// the complete npm audit report and exact lock graph so omissions fail closed.
const POLICIES = {
  "@electron/get": {
    "artifacts": [
      {
        "node": "node_modules/app-builder-lib/node_modules/@electron/get",
        "version": "3.1.0",
        "resolved": "https://registry.npmjs.org/@electron/get/-/get-3.1.0.tgz",
        "integrity": "sha512-F+nKc0xW+kVbBRhFzaMgPy3KwmuNTYX1fx6+FxxoSnNgwYX6LD7AKBTWkU0MQ6IBoe7dz069CNkR673sPAgkCQ==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "apps/desktop/node_modules/electron",
        "section": "dependencies",
        "spec": "^5.0.0"
      },
      {
        "node": "node_modules/app-builder-lib",
        "section": "dependencies",
        "spec": "^3.0.0"
      }
    ],
    "finding": {
      "name": "@electron/get",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "global-agent"
      ],
      "effects": [
        "app-builder-lib"
      ],
      "range": "1.6.0 - 4.0.3",
      "nodes": [
        "node_modules/app-builder-lib/node_modules/@electron/get"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "app-builder-lib": {
    "artifacts": [
      {
        "node": "node_modules/app-builder-lib",
        "version": "26.15.3",
        "resolved": "https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz",
        "integrity": "sha512-2VnyWkqsP5v5XbBhL3tD5Syx8iNPBYsoU7kY4S2fz7wg8Rj/nztWKCUzGKaFRTv0Xwf3/H058CR1Kvtd/3lRow==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/dmg-builder",
        "section": "dependencies",
        "spec": "26.15.3"
      },
      {
        "node": "node_modules/electron-builder",
        "section": "dependencies",
        "spec": "26.15.3"
      },
      {
        "node": "node_modules/electron-builder-squirrel-windows",
        "section": "dependencies",
        "spec": "26.15.3"
      }
    ],
    "finding": {
      "name": "app-builder-lib",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "@electron/get",
        "dmg-builder",
        "electron-builder-squirrel-windows"
      ],
      "effects": [
        "dmg-builder",
        "electron-builder",
        "electron-builder-squirrel-windows"
      ],
      "range": "26.6.0 - 27.0.0-alpha.2",
      "nodes": [
        "node_modules/app-builder-lib"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "dmg-builder": {
    "artifacts": [
      {
        "node": "node_modules/dmg-builder",
        "version": "26.15.3",
        "resolved": "https://registry.npmjs.org/dmg-builder/-/dmg-builder-26.15.3.tgz",
        "integrity": "sha512-O3zJUFUYHJKgzPqioHxfxzBzlSC1eXCSr79gMSBKBP5AgjjpmrydMsMLotEg9fAJF36vdUncb+4ndRNxoPdlSQ==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/app-builder-lib",
        "section": "peerDependencies",
        "spec": "26.15.3"
      },
      {
        "node": "node_modules/electron-builder",
        "section": "dependencies",
        "spec": "26.15.3"
      }
    ],
    "finding": {
      "name": "dmg-builder",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "app-builder-lib"
      ],
      "effects": [
        "electron-builder"
      ],
      "range": "26.6.0 - 27.0.0-alpha.2",
      "nodes": [
        "node_modules/dmg-builder"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "electron-builder": {
    "artifacts": [
      {
        "node": "node_modules/electron-builder",
        "version": "26.15.3",
        "resolved": "https://registry.npmjs.org/electron-builder/-/electron-builder-26.15.3.tgz",
        "integrity": "sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "apps/desktop",
        "section": "devDependencies",
        "spec": "26.15.3"
      }
    ],
    "finding": {
      "name": "electron-builder",
      "severity": "moderate",
      "isDirect": true,
      "via": [
        "app-builder-lib",
        "dmg-builder"
      ],
      "effects": [],
      "range": "19.25.0 || 26.6.0 - 27.0.0-alpha.2",
      "nodes": [
        "node_modules/electron-builder"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "electron-builder-squirrel-windows": {
    "artifacts": [
      {
        "node": "node_modules/electron-builder-squirrel-windows",
        "version": "26.15.3",
        "resolved": "https://registry.npmjs.org/electron-builder-squirrel-windows/-/electron-builder-squirrel-windows-26.15.3.tgz",
        "integrity": "sha512-Jc19XPV9y9+2bAdZPkXuVNGNIEFBq9poHC61l8Kv6FdK7DRG3+Ic0rerC0DXOaeHNz8yW0fg/JnF8GQROOF5MA==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/app-builder-lib",
        "section": "peerDependencies",
        "spec": "26.15.3"
      }
    ],
    "finding": {
      "name": "electron-builder-squirrel-windows",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "app-builder-lib"
      ],
      "effects": [],
      "range": "26.6.0 - 27.0.0-alpha.2",
      "nodes": [
        "node_modules/electron-builder-squirrel-windows"
      ],
      "fixAvailable": true
    }
  },
  "global-agent": {
    "artifacts": [
      {
        "node": "node_modules/global-agent",
        "version": "3.0.0",
        "resolved": "https://registry.npmjs.org/global-agent/-/global-agent-3.0.0.tgz",
        "integrity": "sha512-PT6XReJ+D07JvGoxQMkT6qji/jVNfX/h364XHZOWeRzy64sSFr+xJ5OX7LI3b4MPQzdL4H8Y8M0xzPpsVMwA8Q==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/app-builder-lib/node_modules/@electron/get",
        "section": "optionalDependencies",
        "spec": "^3.0.0"
      }
    ],
    "finding": {
      "name": "global-agent",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "roarr"
      ],
      "effects": [
        "@electron/get"
      ],
      "range": "<=3.0.0",
      "nodes": [
        "node_modules/global-agent"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "roarr": {
    "artifacts": [
      {
        "node": "node_modules/roarr",
        "version": "2.15.4",
        "resolved": "https://registry.npmjs.org/roarr/-/roarr-2.15.4.tgz",
        "integrity": "sha512-CHhPh+UNHD2GTXNYhPWLnU8ONHdI+5DI+4EYIAOaiD63rHeYlZvyh8P+in5999TTSFgUYuKUAjzRI4mdh/p+2A==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/global-agent",
        "section": "dependencies",
        "spec": "^2.15.3"
      }
    ],
    "finding": {
      "name": "roarr",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        "sprintf-js"
      ],
      "effects": [
        "global-agent"
      ],
      "range": "<=2.15.4",
      "nodes": [
        "node_modules/roarr"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  },
  "sprintf-js": {
    "artifacts": [
      {
        "node": "node_modules/sprintf-js",
        "version": "1.1.3",
        "resolved": "https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz",
        "integrity": "sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==",
        "dev": true
      }
    ],
    "edges": [
      {
        "node": "node_modules/roarr",
        "section": "dependencies",
        "spec": "^1.1.2"
      }
    ],
    "finding": {
      "name": "sprintf-js",
      "severity": "moderate",
      "isDirect": false,
      "via": [
        {
          "source": 1241202,
          "name": "sprintf-js",
          "dependency": "sprintf-js",
          "title": "sprintf-js vulnerable to denial of service through unbounded precision specifiers",
          "url": "https://github.com/advisories/GHSA-hp3w-g68c-fv3c",
          "severity": "moderate",
          "cwe": [
            "CWE-1284"
          ],
          "cvss": {
            "score": 5.3,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": "<=1.1.3"
        }
      ],
      "effects": [
        "roarr"
      ],
      "range": "*",
      "nodes": [
        "node_modules/sprintf-js"
      ],
      "fixAvailable": {
        "name": "electron-builder",
        "version": "26.5.0",
        "isSemVerMajor": true
      }
    }
  }
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

function sameArrayMembers(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false
  const normalized = values => values.map(value => JSON.stringify(canonical(value))).sort()
  return sameValue(normalized(actual), normalized(expected))
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

function validatePolicyLock(packages, errors) {
  for (const [name, policy] of Object.entries(POLICIES)) {
    for (const artifact of policy.artifacts) validateArtifact(name, artifact, packages, errors)
    const actualEdges = incomingEdges(packages, name)
    const expectedEdges = [...policy.edges].sort((left, right) =>
      `${left.node}:${left.section}:${left.spec}`.localeCompare(`${right.node}:${right.section}:${right.spec}`)
    )
    if (!sameValue(actualEdges, expectedEdges)) {
      errors.push(`${name} appeared at an unreviewed dependency edge or lost a reviewed edge`)
    }
  }
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
  for (const finding of Object.values(vulnerabilities)) {
    if (isRecord(finding) && severities.includes(finding.severity)) derived[finding.severity] += 1
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
  if (Number(counts.critical ?? 0) > 0) errors.push(`critical advisories are never allowed: ${counts.critical}`)
}

function validateFinding(name, finding, policy, errors) {
  if (!isRecord(finding)) {
    errors.push(`${name} finding is malformed`)
    return
  }

  const expectedVia = policy.finding.via
  const expectedReferences = new Set(expectedVia.filter(source => typeof source === 'string'))
  const expectedAdvisories = expectedVia.filter(source => isRecord(source))
  const expectedUrls = new Set(expectedAdvisories.map(source => source.url))

  if (!Array.isArray(finding.via)) {
    errors.push(`${name} via fan-out is missing or malformed`)
  } else {
    if (expectedAdvisories.length > 0 && !finding.via.some(source => isRecord(source))) {
      errors.push(`${name} has no advisory details to validate`)
    }
    for (const source of finding.via) {
      if (typeof source === 'string') {
        if (!expectedReferences.has(source)) errors.push(`unapproved transitive reference for ${name}: ${source}`)
      } else if (!isRecord(source) || !expectedUrls.has(source.url)) {
        errors.push(`unapproved advisory for ${name}: ${isRecord(source) ? source.url ?? '<missing URL>' : '<malformed>'}`)
      } else if (!expectedAdvisories.some(expected => sameValue(source, expected))) {
        errors.push(`${name} advisory provenance does not match reviewed details`)
      }
    }
    if (!sameArrayMembers(finding.via, expectedVia)) errors.push(`${name} via fan-out differs from the reviewed closure`)
  }

  for (const field of ['name', 'severity', 'isDirect', 'effects', 'range', 'nodes', 'fixAvailable']) {
    const matches = field === 'effects' || field === 'nodes'
      ? sameArrayMembers(finding[field], policy.finding[field])
      : sameValue(finding[field], policy.finding[field])
    if (!matches) {
      errors.push(
        `${name} audit field ${field} differs from the reviewed finding ` +
        `(actual=${JSON.stringify(finding[field])}, expected=${JSON.stringify(policy.finding[field])})`
      )
    }
  }
  const expectedKeys = Object.keys(policy.finding).sort()
  const actualKeys = Object.keys(finding).sort()
  if (!sameValue(actualKeys, expectedKeys)) errors.push(`${name} finding has missing or unexpected fields`)
}

export function evaluateAuditReport(report, lock) {
  const errors = []
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}
  const packages = isRecord(lock?.packages) ? lock.packages : {}

  if (!isRecord(report)) errors.push('audit report is malformed')
  if (!isRecord(report?.metadata?.vulnerabilities)) errors.push('missing audit metadata vulnerability counts')
  if (!isRecord(report?.vulnerabilities)) errors.push('missing vulnerability map')
  if (!isRecord(lock?.packages)) errors.push('missing lockfile package map')
  if (report?.auditReportVersion !== 2) errors.push('missing or unsupported audit report version')

  validateCounts(counts, vulnerabilities, errors)
  if (Object.keys(vulnerabilities).length > 0) validatePolicyLock(packages, errors)

  const names = Object.keys(vulnerabilities)
  if (names.length > 0) {
    for (const name of Object.keys(POLICIES)) {
      if (!Object.hasOwn(vulnerabilities, name)) errors.push(`missing required vulnerability from reviewed closure: ${name}`)
    }
  }

  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const policy = POLICIES[name]
    if (!policy) {
      errors.push(`unapproved vulnerable package: ${name}`)
      continue
    }
    validateFinding(name, finding, policy, errors)
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

  const total = Number(report.metadata.vulnerabilities.total)
  if (total === 0) console.log('npm audit policy passed with no known vulnerabilities')
  else console.log(`npm audit policy passed with ${total} documented development-only sprintf-js transitive findings`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
