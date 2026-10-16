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
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', error => errors.push(error.message))
await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)

const evidence = await page.evaluate(() => {
  const viewportWidth = window.innerWidth
  const wordmark = document.querySelector('[aria-label="HERMES AGENT"]')?.getBoundingClientRect()
  const titlebarButtons = [...document.querySelectorAll('button.titlebar-icon-button')].map(button => {
    const rect = button.getBoundingClientRect()
    return { height: rect.height, width: rect.width }
  })

  return {
    bodyText: document.body.innerText,
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    titlebarButtons,
    viewportWidth,
    wordmark: wordmark ? { left: wordmark.left, right: wordmark.right, width: wordmark.width } : null
  }
})

const failures = []
if (!/Gateway\s+ready/.test(evidence.bodyText)) failures.push('gateway is not ready')
if (evidence.bodyScrollWidth > evidence.viewportWidth || evidence.documentScrollWidth > evidence.viewportWidth) {
  failures.push('horizontal overflow detected')
}
if (!evidence.wordmark || evidence.wordmark.left < 0 || evidence.wordmark.right > evidence.viewportWidth) {
  failures.push('wordmark is clipped')
}
if (evidence.titlebarButtons.length === 0) failures.push('titlebar controls missing')
if (evidence.titlebarButtons.some(button => button.width < 44 || button.height < 44)) {
  failures.push(`titlebar touch targets below 44px: ${JSON.stringify(evidence.titlebarButtons)}`)
}
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)

console.log(JSON.stringify({ evidence, errors, failures }, null, 2))
await browser.close()
if (failures.length) process.exit(1)
