import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Website docs build (Docusaurus) carries its own dependency tree, entirely
// separate from the shipped desktop app and mobile relay server. This policy
// exists because Docusaurus 3.10.2 (the latest stable release as of review)
// still bundles two upstream-fixed-elsewhere advisories transitively through
// its own internals (webpack-dev-server -> chokidar -> braces, and
// @electron/get-style got/cacheable-request -> http-cache-semantics via the
// webpack build toolchain). Neither reaches the published static site output;
// both are dev-time build tooling. Unlike the root npm-audit-policy.mjs
// (which pins exact node/version/integrity because we control that
// dependency directly), this gate allowlists by package name + advisory URL
// only: the vulnerable packages here are Docusaurus's own internal fan-out
// (31 nodes as of this review, all resolving to the same two root CVEs), so
// pinning each node's exact version would break on every routine Docusaurus
// patch release while adding no real review signal. Re-review and shrink
// this list whenever Docusaurus ships a release that resolves either CVE.

const ALLOWED_ADVISORIES = new Set([
  'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', // braces: quadratic brace-expansion ReDoS
  'https://github.com/advisories/GHSA-ch52-4w7c-c8xp' // http-cache-semantics: max-stale cross-user disclosure
])

// Closed set of package names allowed to carry (only) the two advisories
// above, reached transitively through Docusaurus 3.10.2's own tree.
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
  'http-cache-semantics',
  'http-proxy-middleware',
  'micromatch',
  'webpack-dev-server'
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function evaluateWebsiteAuditReport(report) {
  const errors = []
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}

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

    const via = Array.isArray(finding?.via) ? finding.via : []
    const advisoryDetails = via.filter(source => typeof source !== 'string')

    if (advisoryDetails.length === 0 && via.every(source => typeof source === 'string')) {
      // Purely transitive (reached only via other allowed packages, no
      // direct advisory attached here) — fine as long as every reference
      // resolves inside the reviewed closure, checked below.
    }

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
    ['audit', '--json', '--audit-level=high'],
    { cwd: websiteRoot, encoding: 'utf8' }
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

  const evaluation = evaluateWebsiteAuditReport(report)

  if (!evaluation.passed) {
    console.error('website npm audit policy failed')
    for (const error of evaluation.errors) {
      console.error(`  ${error}`)
    }
    process.exit(1)
  }

  const total = Number(report.metadata.vulnerabilities.total)
  if (total === 0) {
    console.log('website npm audit policy passed with no known vulnerabilities')
  } else {
    console.log(
      `website npm audit policy passed with ${total} documented Docusaurus-internal build-tooling findings (upstream-tracked, not shipped in site output)`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
}
