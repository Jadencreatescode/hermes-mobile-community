import { chromium } from 'playwright'

const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const resolverArgs = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
  ? [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`]
  : []
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', ...resolverArgs] })
const context = await browser.newContext({ viewport: { width: 344, height: 882 }, deviceScaleFactor: 2 })
const login = await context.request.post(`${baseUrl}/auth/password-login`, {
  data: { provider: 'basic', username, password, next: '/' }
})
if (!login.ok()) throw new Error(`Login failed with HTTP ${login.status()}`)
const page = await context.newPage()
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))
await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })

const manifestLocator = page.locator('link[rel="manifest"]')
const manifestHref = (await manifestLocator.count()) ? await manifestLocator.getAttribute('href') : null
if (!manifestHref) {
  console.log(JSON.stringify({ failures: ['manifest link missing'] }, null, 2))
  await browser.close()
  process.exit(1)
}
const manifestResponse = await context.request.get(new URL(manifestHref, `${baseUrl}/`).href)
const manifest = manifestResponse.ok() ? await manifestResponse.json() : null
await page.waitForFunction(() => 'serviceWorker' in navigator, null, { timeout: 5000 })
await page.evaluate(() => navigator.serviceWorker.ready)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10000 })
await page.evaluate(() => fetch('/api/auth/providers', { credentials: 'include' }).then(response => response.json()))
const workerEvidence = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.getRegistration('./')
  const cacheNames = await caches.keys()
  const cachedUrls = []
  for (const name of cacheNames) {
    const cache = await caches.open(name)
    cachedUrls.push(...(await cache.keys()).map(request => request.url))
  }
  return {
    active: Boolean(registration?.active),
    cacheNames,
    cachedUrls,
    controlled: Boolean(navigator.serviceWorker.controller)
  }
})

const failures = []
if (!manifestResponse.ok()) failures.push(`manifest returned HTTP ${manifestResponse.status()}`)
if (manifest?.name !== 'Hermes Mobile Control Center') failures.push('manifest name mismatch')
if (manifest?.display !== 'standalone') failures.push('manifest is not standalone')
if (!Array.isArray(manifest?.icons) || !manifest.icons.some(icon => icon.sizes === '192x192') || !manifest.icons.some(icon => icon.sizes === '512x512')) {
  failures.push('required install icons missing')
}
if (!workerEvidence.active || !workerEvidence.controlled) failures.push('service worker is not active and controlling the app')
if (!workerEvidence.cacheNames.some(name => name.startsWith('hermes-mobile-shell-'))) failures.push('shell cache missing')
if (workerEvidence.cachedUrls.some(url => new URL(url).pathname.includes('/api/'))) failures.push('API response was cached')
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)
console.log(JSON.stringify({ manifest, workerEvidence, errors, failures }, null, 2))
await browser.close()
if (failures.length) process.exit(1)
