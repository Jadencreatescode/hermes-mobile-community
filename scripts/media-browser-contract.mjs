import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
const evidenceDir = path.resolve(process.env.HERMES_MOBILE_EVIDENCE_DIR || 'artifacts/evidence/media')
const backendFile = process.env.HERMES_MOBILE_BACKEND_TEST_FILE || '/tmp/hermes-mobile-download-proof.txt'
const outputFile = path.join(evidenceDir, 'downloaded-proof.txt')
const expectedDownload = 'Hermes mobile authenticated download proof.\n'
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')
await fs.mkdir(evidenceDir, { recursive: true })

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    ...(process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
      ? [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`]
      : [])
  ]
})
const context = await browser.newContext({ viewport: { width: 344, height: 882 }, deviceScaleFactor: 2, acceptDownloads: true })
await context.grantPermissions(['microphone'], { origin: baseUrl })
const login = await context.request.post(`${baseUrl}/auth/password-login`, {
  data: { provider: 'basic', username, password, next: '/' }
})
if (!login.ok()) throw new Error(`Login failed with HTTP ${login.status()}`)
const page = await context.newPage()
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))
await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)

const composerButtons = page.locator('[data-slot="composer-dock"] button')
const composerButtonNames = await composerButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent?.trim() || ''))
const addButton = composerButtons.first()
await addButton.click()
const imageItem = page.getByRole('menuitem', { name: 'Images' })
const chooserPromise = page.waitForEvent('filechooser')
await imageItem.click()
const chooser = await chooserPromise
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
await chooser.setFiles({ name: 'phone-camera-proof.png', mimeType: 'image/png', buffer: png })
await page.getByRole('button', { name: 'Preview phone-camera-proof.png' }).waitFor({ timeout: 10000 })
const removeAttachmentRect = await page.locator('[data-slot="composer-attachments"] button[aria-label]:not([aria-label^="Preview"])').first().evaluate(button => {
  const rect = button.getBoundingClientRect()
  return { height: rect.height, visible: getComputedStyle(button).opacity !== '0', width: rect.width }
})

const fixedPetVisible = await page.evaluate(() =>
  [...document.querySelectorAll('canvas')].some(canvas => {
    let element = canvas.parentElement
    while (element && element !== document.body) {
      if (getComputedStyle(element).position === 'fixed') return element.getBoundingClientRect().width > 0
      element = element.parentElement
    }
    return false
  })
)

const microphoneGranted = await page.evaluate(() => window.hermesDesktop?.requestMicrophoneAccess?.())
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(path => window.hermesDesktop?.saveGatewayFile?.({ path, suggestedName: 'downloaded-proof.txt' }), backendFile)
])
await download.saveAs(outputFile)
const downloadedText = await fs.readFile(outputFile, 'utf8')

const failures = []
if (!composerButtonNames.length) failures.push('composer controls missing')
if (!removeAttachmentRect.visible || removeAttachmentRect.width < 44 || removeAttachmentRect.height < 44) failures.push('attachment removal is not a visible 44px control')
if (fixedPetVisible) failures.push('pet overlaps the narrow attachment composer')
if (!microphoneGranted) failures.push('microphone permission route failed')
if (downloadedText !== expectedDownload) failures.push('authenticated download bytes do not match')
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)
await page.screenshot({
  path: path.join(evidenceDir, 'fold-outer-attachment.png'),
  fullPage: true
})
console.log(JSON.stringify({
  composerButtonNames,
  attachmentVisible: true,
  fixedPetVisible,
  removeAttachmentRect,
  microphoneGranted,
  downloadSuggestedName: download.suggestedFilename(),
  downloadBytesMatch: downloadedText === expectedDownload,
  errorCount: errors.length,
  failures
}, null, 2))
await browser.close()
if (failures.length) process.exit(1)
