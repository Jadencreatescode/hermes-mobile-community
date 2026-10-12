import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Docusaurus 3.10.2 still carries braces 3.0.3 through its build toolchain.
// npm publishes no patched braces release, so this policy permits only that
// advisory and binds it to the exact reviewed lockfile artifact. Any new
// advisory, package, node, or artifact drift fails closed. The separately
// patchable http-cache-semantics advisory is not an exception: the lock must
// retain the fixed 4.3.0 artifact.
const ALLOWED_ADVISORIES = new Set(['https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'])

const ALLOWED_PACKAGES = new Set([
  '@docusaurus/babel',
  '@docusaurus/bundler',
  '@docusaurus/core',
  '@docusaurus/mdx-loader',
  '@docusaurus/plugin-client-redirects',
  '@docusaurus/plugin-content-blog',
  '@docusaurus/plugin-content-docs',
  '@docusaurus/plugin-content-pages',
  '@docusaurus/plugin-css-cascade-layers',
  '@docusaurus/plugin-debug',
  '@docusaurus/plugin-google-analytics',
  '@docusaurus/plugin-google-gtag',
  '@docusaurus/plugin-google-tag-manager',
  '@docusaurus/plugin-sitemap',
  '@docusaurus/plugin-svgr',
  '@docusaurus/preset-classic',
  '@docusaurus/theme-classic',
  '@docusaurus/theme-common',
  '@docusaurus/theme-mermaid',
  '@docusaurus/theme-search-algolia',
  '@docusaurus/utils',
  '@docusaurus/utils-validation',
  'braces',
  'chokidar',
  'copy-webpack-plugin',
  'fast-glob',
  'globby',
  'http-proxy-middleware',
  'micromatch',
  'webpack-dev-server'
])

const REVIEWED_LOCKED_PACKAGES = {
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
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function lockedPackageName(node) {
  const marker = 'node_modules/'
  const index = node.lastIndexOf(marker)
  return index === -1 ? '' : node.slice(index + marker.length)
}

export function validateWebsiteLock(lock) {
  const errors = []
  const packages = isRecord(lock?.packages) ? lock.packages : null

  if (!packages) {
    return ['missing lockfile package map']
  }

  for (const [name, expected] of Object.entries(REVIEWED_LOCKED_PACKAGES)) {
    const locked = packages[expected.node]

    if (!isRecord(locked)) {
      errors.push(`${name} lockfile node is missing: ${expected.node}`)
      continue
    }

    if (locked.version !== expected.version) {
      errors.push(`${name} must remain locked to reviewed version ${expected.version}`)
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

export function evaluateWebsiteAuditReport(report, lock) {
  const errors = [...validateWebsiteLock(lock)]
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}
  const packages = isRecord(lock?.packages) ? lock.packages : {}

  if (!isRecord(report?.metadata?.vulnerabilities)) {
    errors.push('missing audit metadata vulnerability counts')
  }

  if (!isRecord(report?.vulnerabilities)) {
    errors.push('missing vulnerability map')
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
    if (!ALLOWED_PACKAGES.has(name)) {
      errors.push(`unapproved vulnerable package: ${name}`)
      continue
    }

    const nodes = Array.isArray(finding?.nodes) ? finding.nodes : []
    if (nodes.length === 0) {
      errors.push(`${name} has no lockfile nodes to validate`)
    }

    for (const node of nodes) {
      if (typeof node !== 'string' || lockedPackageName(node) !== name) {
        errors.push(`${name} reported an invalid lockfile node: ${String(node)}`)
        continue
      }
      if (!isRecord(packages[node])) {
        errors.push(`${name} lockfile node is missing: ${node}`)
      }
    }

    const via = Array.isArray(finding?.via) ? finding.via : []

    for (const source of via) {
      if (typeof source === 'string') {
        if (!ALLOWED_PACKAGES.has(source)) {
          errors.push(`unapproved transitive reference for ${name}: ${source}`)
        }
        continue
      }

      const url = source?.url
      if (!url || !ALLOWED_ADVISORIES.has(url)) {
        errors.push(`unapproved advisory for ${name}: ${url ?? '<missing URL>'}`)
      }
    }
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'website')
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['audit', '--omit=dev', '--json', '--audit-level=high'],
    { cwd: websiteRoot, encoding: 'utf8' }
  )

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
    lock = JSON.parse(fs.readFileSync(path.join(websiteRoot, 'package-lock.json'), 'utf8'))
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

  const total = Number(report.metadata.vulnerabilities.total)
  if (total === 0) {
    console.log('website npm audit policy passed with no known vulnerabilities')
  } else {
    console.log(
      `website npm audit policy passed with ${total} documented Docusaurus-internal braces findings (no patched braces release)`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
