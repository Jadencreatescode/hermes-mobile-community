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
await page.goto(`${baseUrl}/#/settings?tab=config:model`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(10000)

const evidence = await page.evaluate(() => {
  const leaf = text => [...document.querySelectorAll('*')].find(
    element => element.childElementCount === 0 && element.textContent?.trim() === text
  )
  const heading = leaf('Mixture of Agents')
  heading?.scrollIntoView({ block: 'start' })
  const section = heading?.closest('section')
  const search = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Search'))
  const modelTitle = leaf('Model')
  const rect = element => {
    const value = element?.getBoundingClientRect()
    return value ? { bottom: value.bottom, height: value.height, left: value.left, right: value.right, top: value.top, width: value.width } : null
  }
  const intersects = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
  const controls = section
    ? [...section.querySelectorAll('button:not([data-slot="switch"]), input')].map(control => ({
        label: control.getAttribute('aria-label') || control.textContent?.trim() || control.getAttribute('placeholder') || '',
        ...rect(control)
      })).filter(control => control.width > 0 && control.height > 0)
    : []
  const switchHitAreas = section
    ? [...section.querySelectorAll('[data-slot="switch"]')].map(control => {
        const target = control.closest('label') || control
        const bounds = target.getBoundingClientRect()
        return { height: bounds.height, width: bounds.width }
      })
    : []
  const fixedPet = [...document.querySelectorAll('canvas')].find(canvas => {
    let element = canvas.parentElement
    while (element && element !== document.body) {
      if (getComputedStyle(element).position === 'fixed') return true
      element = element.parentElement
    }
    return false
  })

  return {
    bodyScrollWidth: document.body.scrollWidth,
    controls,
    documentScrollWidth: document.documentElement.scrollWidth,
    fixedPetVisible: Boolean(fixedPet && fixedPet.getBoundingClientRect().width > 0),
    searchRect: rect(search),
    searchOverlapsTitle: intersects(rect(search), rect(modelTitle)),
    sectionPresent: Boolean(section),
    switchHitAreas,
    viewportWidth: window.innerWidth
  }
})

const failures = []
if (!evidence.sectionPresent) failures.push('Mixture of Agents section missing')
if (evidence.searchOverlapsTitle) failures.push('Search overlaps the settings header')
if (evidence.searchRect && (evidence.searchRect.width > 44 || evidence.searchRect.height < 44)) {
  failures.push(`Search is not a compact 44px phone control: ${JSON.stringify(evidence.searchRect)}`)
}
if (evidence.fixedPetVisible) failures.push('Pet remains visible over the narrow settings overlay')
if (evidence.controls.some(control => control.width < 44 || control.height < 44)) {
  failures.push(`MoA controls below 44px: ${JSON.stringify(evidence.controls.filter(control => control.width < 44 || control.height < 44))}`)
}
if (evidence.switchHitAreas.some(control => control.width < 44 || control.height < 44)) {
  failures.push(`MoA switch hit areas below 44px: ${JSON.stringify(evidence.switchHitAreas)}`)
}
if (evidence.bodyScrollWidth > evidence.viewportWidth || evidence.documentScrollWidth > evidence.viewportWidth) {
  failures.push('horizontal overflow detected')
}
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)
console.log(JSON.stringify({ evidence, errors, failures }, null, 2))
await browser.close()
if (failures.length) process.exit(1)
