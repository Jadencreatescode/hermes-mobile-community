import { chromium } from 'playwright'

const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const resolverArgs = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
  ? [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`]
  : []
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', ...resolverArgs] })
const context = await browser.newContext({ viewport: { width: 344, height: 882 }, deviceScaleFactor: 2 })
const page = await context.newPage()
await page.goto(`${baseUrl}/manifest.webmanifest`, { waitUntil: 'domcontentloaded' })
const loginStatus = await page.evaluate(async ({ username, password }) => {
  const response = await fetch('/auth/password-login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', username, password, next: '/' })
  })

  return response.status
}, { username, password })
if (loginStatus !== 200) throw new Error(`Login failed with HTTP ${loginStatus}`)

const authRequests = []
const browserErrors = []
page.on('console', message => {
  if (
    message.type() === 'error' &&
    !/401 \(Unauthorized\)|navigator\.vibrate/i.test(message.text())
  ) {
    browserErrors.push(message.text())
  }
})
page.on('pageerror', error => browserErrors.push(error.message))
page.on('request', request => {
  const pathname = new URL(request.url()).pathname

  if (pathname === '/auth/logout' || pathname === '/login') {
    authRequests.push({ method: request.method(), pathname })
  }
})
await page.route('**/api/auth/ws-ticket', route =>
  route.fulfill({ status: 401, contentType: 'text/plain', body: 'session expired' })
)
await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
const button = page.getByRole('button', { name: /sign out & sign in/i })
await button.waitFor({ timeout: 20000 })
await button.click()
await page.waitForURL(url => url.pathname === '/login', { timeout: 10000 })
const openedLogin = new URL(page.url()).pathname === '/login'
const loginFormVisible = await page.locator('input[name="username"]').isVisible() &&
  await page.locator('input[type="password"]').isVisible() &&
  await page.locator('button[type="submit"]').isVisible()
const logoutSent = authRequests.some(request => request.method === 'POST' && request.pathname === '/auth/logout')
const failures = []
if (!logoutSent) failures.push('logout request was not sent')
if (!openedLogin) failures.push('same-tab login page did not open')
if (!loginFormVisible) failures.push('username and password sign-in form did not render')
if (browserErrors.length) failures.push(`browser errors: ${browserErrors.join(' | ')}`)

console.log(JSON.stringify({ authRequests, browserErrors, failures, loginFormVisible, openedLogin }, null, 2))
await browser.close()
if (failures.length) process.exit(1)
