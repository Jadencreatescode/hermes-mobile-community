import { chromium } from 'playwright'
import fs from 'node:fs/promises'

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
const page = await context.newPage()
const errors = []
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', error => errors.push(error.message))
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

await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await page.getByRole('button', { name: /sidebar/i }).first().click()
const botTab = page.getByRole('tablist').getByText(/^bots$/i)
await botTab.click()
const botWorkspaceHeading = page.getByText(/^bots$/i).nth(1)
const newAgent = page.getByText('New Agent', { exact: true })
await newAgent.waitFor({ timeout: 15000 })
const evidence = {
  botTabVisible: await botTab.isVisible(),
  botWorkspaceVisible: await botWorkspaceHeading.isVisible(),
  newAgentVisible: await newAgent.isVisible(),
  viewportWidth: await page.evaluate(() => window.innerWidth)
}
const failures = []
if (!evidence.botTabVisible) failures.push('Bots tab is not visible')
if (!evidence.botWorkspaceVisible) failures.push('Bot Mode workspace is not visible')
if (!evidence.newAgentVisible) failures.push('New Agent control is not visible')
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)

await fs.mkdir('artifacts/evidence/bot-mode-phone', { recursive: true })
await page.screenshot({ path: 'artifacts/evidence/bot-mode-phone/fold-outer-bots.png', fullPage: true })
await fs.writeFile(
  'artifacts/evidence/bot-mode-phone/result.json',
  JSON.stringify({ evidence, errors, failures }, null, 2)
)
console.log(JSON.stringify({ evidence, errors, failures }, null, 2))
await browser.close()
if (failures.length) process.exit(1)
