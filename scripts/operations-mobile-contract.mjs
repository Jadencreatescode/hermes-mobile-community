import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH

if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const viewports = [
  { id: 'iphone-se', width: 344, height: 882 },
  { id: 'iphone-compact', width: 360, height: 800 },
  { id: 'iphone', width: 390, height: 844 },
  { id: 'iphone-large', width: 412, height: 915 },
  { id: 'ipad-portrait', width: 768, height: 1024 },
  { id: 'ipad-landscape', width: 1024, height: 768 },
  { id: 'desktop', width: 1440, height: 900 }
]

const sections = [
  { id: 'overview', marker: 'Bots' },
  { id: 'mailroom', marker: 'Durable, ordered Bot correspondence' },
  { id: 'meetings', marker: 'New specialist meeting' },
  { id: 'workspace', marker: 'Agent Workspace' },
  { id: 'forge', marker: 'Forge' },
  { id: 'training', marker: 'Open Training Mode' }
]

const out = path.resolve(process.env.HERMES_OPERATIONS_EVIDENCE_DIR || 'artifacts/evidence/operations-mobile')
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: viewports[0].width, height: viewports[0].height }, deviceScaleFactor: 1 })
const login = await context.request.post(`${baseUrl}/auth/password-login`, {
  data: { provider: 'basic', username, password, next: '/' }
})
if (!login.ok()) throw new Error(`login failed with HTTP ${login.status()}`)
const page = await context.newPage()
const browserErrors = []
if (process.env.HERMES_OPERATIONS_MOCK_PLUGIN === '1') {
  await page.route('**/api/plugins/operations/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const body = pathname.endsWith('/mailroom') ? { envelopes: [] }
      : pathname.endsWith('/meetings') ? { meetings: [] }
        : { detail: 'Operation not exercised by the responsive contract' }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
page.on('pageerror', error => browserErrors.push(error.message))
const results = []

async function waitForOperations() {
  const ready = () => document.querySelector('select[aria-label="Operations section"]') instanceof HTMLSelectElement
  try {
    await page.waitForFunction(ready, undefined, { timeout: 20_000 })
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(ready, undefined, { timeout: 20_000 })
  }
}

for (const viewport of viewports) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await page.goto(`${baseUrl}/#/operations`, { waitUntil: 'domcontentloaded' })
  await waitForOperations()

  for (const section of sections) {
    console.log(`checking ${viewport.id}/${section.id}`)
    const startError = browserErrors.length
    const selected = await page.evaluate(sectionId => {
      const select = document.querySelector('select[aria-label="Operations section"]')
      if (!(select instanceof HTMLSelectElement)) return false
      select.value = sectionId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, section.id)
    if (!selected) throw new Error(`${viewport.id}: Operations section selector is missing`)
    await page.waitForTimeout(150)
    const measurement = await page.evaluate(marker => {
      const root = document.querySelector('main')
      const controls = [...(root?.querySelectorAll('button, select, input:not([type="checkbox"]), textarea') || [])]
        .map(element => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          }
        })
        .filter(control => control.visible)
      return {
        bodyScrollWidth: document.body.scrollWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyText: document.body.innerText,
        markerVisible: document.body.innerText.includes(marker),
        minimumControlHeight: controls.length ? Math.min(...controls.map(control => control.height)) : 0,
        viewportWidth: window.innerWidth
      }
    }, section.marker)
    const routeErrors = browserErrors.slice(startError)
    const failures = []
    if (measurement.bodyScrollWidth > measurement.viewportWidth + 1 || measurement.documentScrollWidth > measurement.viewportWidth + 1) {
      failures.push(`horizontal overflow body=${measurement.bodyScrollWidth} document=${measurement.documentScrollWidth} viewport=${measurement.viewportWidth}`)
    }
    if (!measurement.markerVisible) failures.push(`missing marker: ${section.marker}`)
    if (measurement.minimumControlHeight > 0 && measurement.minimumControlHeight < 43) {
      failures.push(`control below 44px contract: ${measurement.minimumControlHeight}`)
    }
    if (/Something broke in the interface|Hermes couldn't start|Desktop boot failed/i.test(measurement.bodyText)) {
      failures.push('fatal recovery surface visible')
    }
    if (routeErrors.length) failures.push(`browser errors: ${routeErrors.join(' | ')}`)
    results.push({ viewport: viewport.id, section: section.id, ...measurement, errorCount: routeErrors.length, failures })
  }

  await page.screenshot({ path: `${out}/${viewport.id}--operations.png`, fullPage: true })
}

await context.close()
await browser.close()
const failures = results.filter(result => result.failures.length)
await fs.writeFile(`${out}/results.json`, JSON.stringify({ viewports, sections, results, failures }, null, 2))
console.log(JSON.stringify({ checked: results.length, failed: failures.length, failures }, null, 2))
if (failures.length) process.exit(1)
