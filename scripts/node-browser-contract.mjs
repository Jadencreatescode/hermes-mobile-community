import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || 'boss'
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
const evidenceDir = path.resolve(process.env.HERMES_MOBILE_EVIDENCE_DIR || 'artifacts/evidence/nodes')
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const resolverArgs = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
  ? [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`]
  : []
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', ...resolverArgs] })
const context = await browser.newContext({
  viewport: { width: 344, height: 882 },
  deviceScaleFactor: 2,
  acceptDownloads: true
})
await fs.mkdir(evidenceDir, { recursive: true })
const loginPaths = ['', '/nodes/bridge', '/nodes/helm']
const loginStatuses = {}
for (const prefix of loginPaths) {
  const response = await context.request.post(`${baseUrl}${prefix}/auth/password-login`, {
    data: { provider: 'basic', username, password, next: '/' }
  })
  loginStatuses[prefix || '/'] = response.status()
}

const page = await context.newPage()
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))
await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

const evidence = await page.evaluate(async () => {
  const bridge = window.hermesDesktop
  const registry = await bridge.connections.list()
  const roster = await bridge.getAgentRoster?.()
  const descriptors = await Promise.all(
    ['vps', 'bridge', 'helm'].map(connectionId => bridge.getConnectionFor?.({ connectionId, profile: 'default' }))
  )
  const statuses = await Promise.all(
    ['vps', 'bridge', 'helm'].map(connectionId => bridge.api({ connectionId, path: '/api/status' }))
  )
  const sockets = []
  for (const connectionId of ['vps', 'bridge', 'helm']) {
    const result = await bridge.getGatewayWsUrlFor?.({ connectionId, profile: 'default' })
    if (!result?.ok) {
      sockets.push({ connectionId, open: false, error: result?.error })
      continue
    }
    const open = await new Promise(resolve => {
      const socket = new WebSocket(result.wsUrl)
      const timer = window.setTimeout(() => { socket.close(); resolve(false) }, 8000)
      socket.addEventListener('open', () => { window.clearTimeout(timer); socket.close(); resolve(true) }, { once: true })
      socket.addEventListener('error', () => { window.clearTimeout(timer); resolve(false) }, { once: true })
    })
    sockets.push({ connectionId, open })
  }
  return {
    descriptors: descriptors.map(value => ({
      baseUrl: value?.baseUrl,
      connectionId: value?.connectionId,
      profile: value?.profile,
      registryScoped: value?.registryScoped,
      wsUrl: value?.wsUrl
    })),
    registry,
    roster,
    sockets,
    statuses: statuses.map(status => ({ overall: status.overall, profiles: status.profiles, version: status.version }))
  }
})

const gatewayTrigger = page.getByRole('button', { name: /Registered gateways:/ })
await gatewayTrigger.waitFor({ timeout: 10000 })
const gatewayTriggerRect = await gatewayTrigger.evaluate(button => {
  const rect = button.getBoundingClientRect()
  return { height: rect.height, width: rect.width }
})
await gatewayTrigger.click()
const nodeItems = await page.getByRole('menuitemradio').allTextContents()
const nodeItemRects = await page.getByRole('menuitemradio').evaluateAll(items =>
  items.map(item => {
    const rect = item.getBoundingClientRect()
    return { height: rect.height, label: item.textContent?.trim(), width: rect.width }
  })
)
await page.screenshot({
  path: path.join(evidenceDir, 'fold-outer-gateways.png'),
  fullPage: true
})
await page.getByRole('menuitemradio', { name: 'Bridge' }).click()
await page.waitForFunction(() => document.body.innerText.includes('backend v0.20.3'), null, { timeout: 15000 })
const bridgeTriggerText = await page.getByRole('button', { name: /Registered gateways:/ }).innerText()
await page.waitForFunction(() => localStorage.getItem('hermes-mobile-connection-id') === 'bridge', null, { timeout: 15000 })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => document.body.innerText.includes('backend v0.20.3'), null, { timeout: 15000 })
const bridgePersistedAfterReload = (await page.getByRole('button', { name: /Registered gateways:/ }).innerText()).includes('Bridge')
const [bridgeDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() =>
    window.hermesDesktop.saveGatewayFile?.({
      connectionId: 'bridge',
      path: '/tmp/hermes-mobile-bridge-download-proof.txt',
      suggestedName: 'bridge-download-proof.txt'
    })
  )
])
const bridgeDownloadPath = path.join(evidenceDir, 'bridge-download-proof.txt')
await bridgeDownload.saveAs(bridgeDownloadPath)
const bridgeDownloadMatches =
  (await fs.readFile(bridgeDownloadPath, 'utf8')) === 'Bridge-owned Hermes mobile artifact proof.\n'
await page.getByRole('button', { name: /Registered gateways:/ }).click()
await page.getByRole('menuitemradio', { name: 'Helm' }).click()
await page.waitForFunction(() => localStorage.getItem('hermes-mobile-connection-id') === 'helm', null, { timeout: 15000 })
const helmTriggerText = await page.getByRole('button', { name: /Registered gateways:/ }).innerText()
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => localStorage.getItem('hermes-mobile-connection-id') === 'helm', null, { timeout: 15000 })
const helmPersistedAfterReload = (await page.getByRole('button', { name: /Registered gateways:/ }).innerText()).includes('Helm')
await page.getByRole('button', { name: /Registered gateways:/ }).click()
await page.getByRole('menuitemradio', { name: 'VPS' }).click()
await page.waitForFunction(() => document.body.innerText.includes('backend v0.20.4'), null, { timeout: 15000 })
const nodeApiCached = await page.evaluate(async () => {
  for (const name of await caches.keys()) {
    const cache = await caches.open(name)
    if ((await cache.keys()).some(request => /\/nodes\/[^/]+\/api\//.test(new URL(request.url).pathname))) return true
  }
  return false
})

const failures = []
if (Object.values(loginStatuses).some(status => status !== 200)) failures.push(`node login failed: ${JSON.stringify(loginStatuses)}`)
if (evidence.registry.connections.map(node => node.id).join(',') !== 'vps,bridge,helm') failures.push('interactive node registry mismatch')
if (evidence.descriptors.some(item => !item.registryScoped || !item.connectionId)) failures.push('connection identity missing')
if (evidence.statuses.some(status => status.overall !== 'ok')) failures.push('one or more node status checks failed')
if (evidence.sockets.some(socket => !socket.open)) failures.push(`one or more node WebSockets failed: ${JSON.stringify(evidence.sockets)}`)
if (!evidence.roster?.agents.some(agent => agent.connectionId === 'helm' && agent.profile === 'default')) failures.push('Helm default profile is missing from the cross-connection agent roster')
if (!nodeItems.includes('VPS') || !nodeItems.includes('Bridge') || !nodeItems.includes('Helm')) failures.push('gateway selector is missing an interactive node')
if (nodeItemRects.some(item => item.height < 44)) failures.push('gateway selector menu row is below 44px')
if (gatewayTriggerRect.height < 44) failures.push('gateway selector trigger is below 44px')
if (!bridgeTriggerText.includes('Bridge')) failures.push('workspace did not switch visibly to Bridge')
if (!bridgePersistedAfterReload) failures.push('Bridge selection did not persist across reload')
if (!bridgeDownloadMatches) failures.push('Bridge-owned artifact download bytes do not match')
if (!helmTriggerText.includes('Helm')) failures.push('workspace did not switch visibly to Helm')
if (!helmPersistedAfterReload) failures.push('Helm selection did not persist across reload')
if (nodeApiCached) failures.push('node API response entered the service worker cache')
if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)
await fs.writeFile(
  path.join(evidenceDir, 'results.json'),
  JSON.stringify({ loginStatuses, evidence, errors, failures }, null, 2)
)
console.log(JSON.stringify({
  loginStatuses,
  registryIds: evidence.registry.connections.map(node => node.id),
  sourceReachability: evidence.roster?.sources.map(source => ({ id: source.connectionId, reachable: source.reachable })),
  rosterAgents: evidence.roster?.agents.map(agent => ({ connectionId: agent.connectionId, profile: agent.profile })),
  profileCounts: evidence.statuses.map(status => status.profiles?.length),
  socketResults: evidence.sockets,
  nodeItems,
  nodeItemRects,
  bridgeTriggerText,
  bridgePersistedAfterReload,
  bridgeDownloadMatches,
  helmTriggerText,
  helmPersistedAfterReload,
  gatewayTriggerRect,
  nodeApiCached,
  versions: evidence.statuses.map(status => status.version),
  errors,
  failures
}, null, 2))
await browser.close()
if (failures.length) process.exit(1)
