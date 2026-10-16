import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const viewports = [
  { id: 'android-narrow', width: 320, height: 568 },
  { id: 'fold-outer', width: 344, height: 882 },
  { id: 'iphone-portrait', width: 390, height: 844 },
  { id: 'iphone-landscape', width: 844, height: 390 },
  { id: 'fold-inner-portrait', width: 884, height: 1104 },
  { id: 'fold-inner-landscape', width: 1104, height: 884 },
  { id: 'tablet-portrait', width: 768, height: 1024 },
  { id: 'desktop', width: 1440, height: 900 }
]
const routes = [
  { id: 'chat', hash: '#/' },
  { id: 'settings-model', hash: '#/settings?tab=config:model' },
  { id: 'command-center', hash: '#/command-center' },
  { id: 'skills', hash: '#/skills' },
  { id: 'messaging', hash: '#/messaging' },
  { id: 'webhooks', hash: '#/webhooks' },
  { id: 'artifacts', hash: '#/artifacts' },
  { id: 'cron', hash: '#/cron' },
  { id: 'profiles', hash: '#/profiles' },
  { id: 'agents', hash: '#/agents' },
  { id: 'operations', hash: '#/operations' },
  { id: 'training', hash: '#/training' },
  { id: 'starmap', hash: '#/starmap' }
]

const out = path.resolve(process.env.HERMES_MOBILE_EVIDENCE_DIR || 'artifacts/evidence/route-matrix')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const results = []

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
  const login = await context.request.post(`${baseUrl}/auth/password-login`, {
    data: { provider: 'basic', username, password, next: '/' }
  })
  if (!login.ok()) throw new Error(`${viewport.id}: login failed with HTTP ${login.status()}`)
  const page = await context.newPage()
  const errors = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)

  for (const route of routes) {
    const startError = errors.length
    await page.goto(`${baseUrl}/${route.hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const measure = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyText: document.body.innerText,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    }))
    const routeErrors = errors.slice(startError)
    const failures = []
    if (measure.bodyScrollWidth > measure.viewportWidth + 1 || measure.documentScrollWidth > measure.viewportWidth + 1) {
      failures.push(`horizontal overflow body=${measure.bodyScrollWidth} document=${measure.documentScrollWidth} viewport=${measure.viewportWidth}`)
    }
    if (!measure.bodyText.trim()) failures.push('empty body')
    if (/Something broke in the interface|Hermes couldn't start|Desktop boot failed/i.test(measure.bodyText)) failures.push('fatal recovery surface visible')
    if (routeErrors.length) failures.push(`browser errors: ${routeErrors.join(' | ')}`)
    const result = {
      viewport: viewport.id,
      route: route.id,
      width: viewport.width,
      height: viewport.height,
      bodyScrollWidth: measure.bodyScrollWidth,
      documentScrollWidth: measure.documentScrollWidth,
      errorCount: routeErrors.length,
      failures
    }
    results.push(result)
    if (failures.length || (route.id === 'chat' && ['android-narrow', 'fold-inner-portrait', 'desktop'].includes(viewport.id))) {
      await page.screenshot({ path: `${out}/${viewport.id}--${route.id}.png`, fullPage: true })
    }
  }
  await context.close()
}

await browser.close()
const failures = results.filter(result => result.failures.length)
await fs.writeFile(`${out}/results.json`, JSON.stringify({ viewports, routes, results, failures }, null, 2))
console.log(JSON.stringify({ checked: results.length, failed: failures.length, failures }, null, 2))
if (failures.length) process.exit(1)
