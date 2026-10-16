import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const username = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME
const password = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
const baseUrl = process.env.HERMES_MOBILE_TEST_URL || 'http://127.0.0.1:4175'
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
const evidenceDir = path.resolve(process.env.HERMES_MOBILE_EVIDENCE_DIR || 'artifacts/evidence/nodes')
const primaryId = process.env.HERMES_MOBILE_PRIMARY_CONNECTION_ID

if (!username) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_USERNAME is required')
if (!password) throw new Error('HERMES_DASHBOARD_BASIC_AUTH_PASSWORD is required')

const resolverArgs = process.env.PLAYWRIGHT_HOST_RESOLVER_RULES
  ? [`--host-resolver-rules=${process.env.PLAYWRIGHT_HOST_RESOLVER_RULES}`]
  : []

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', ...resolverArgs] })
let exitCode = 0

try {
  const context = await browser.newContext({
    viewport: { width: 344, height: 882 },
    deviceScaleFactor: 2,
    acceptDownloads: true
  })
  await fs.mkdir(evidenceDir, { recursive: true })
  const loginResponse = await context.request.post(`${baseUrl}/auth/password-login`, {
    data: { provider: 'basic', username, password, next: '/' }
  })
  const loginStatuses = { '/': loginResponse.status() }
  if (loginResponse.status() !== 200) throw new Error(`Login failed with status ${loginResponse.status()}`)

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
    return {
      registry,
      roster
    }
  })

  const connections = evidence.registry.connections
  if (connections.length < 2) throw new Error('At least two registered connections are required')

  const primary = primaryId ? connections.find(conn => conn.id === primaryId) : connections[0]
  if (!primary) throw new Error(`Primary connection ID ${primaryId} not found in registry`)

  const nonPrimaryConnections = connections.filter(conn => conn.id !== primary.id)

  for (const connection of nonPrimaryConnections) {
    const loginPath = `/nodes/${encodeURIComponent(connection.id)}`
    const response = await context.request.post(`${baseUrl}${loginPath}/auth/password-login`, {
      data: { provider: 'basic', username, password, next: '/' }
    })
    loginStatuses[loginPath] = response.status()
    if (response.status() !== 200) throw new Error(`Authentication failed for connection ${connection.id}`)
  }

  const results = await page.evaluate(async (args) => {
    const { connectionIds } = args
    const bridge = window.hermesDesktop
    const descriptors = await Promise.all(
      connectionIds.map(id => bridge.getConnectionFor?.({ connectionId: id, profile: 'default' }))
    )
    const statuses = await Promise.all(
      connectionIds.map(id => bridge.api({ connectionId: id, path: '/api/status' }))
    )
    const sockets = []
    for (const id of connectionIds) {
      const result = await bridge.getGatewayWsUrlFor?.({ connectionId: id, profile: 'default' })
      if (!result?.ok) {
        sockets.push({ connectionId: id, open: false, error: result?.error })
        continue
      }
      const open = await new Promise(resolve => {
        const socket = new WebSocket(result.wsUrl)
        const timer = window.setTimeout(() => { socket.close(); resolve(false) }, 8000)
        socket.addEventListener('open', () => { window.clearTimeout(timer); socket.close(); resolve(true) }, { once: true })
        socket.addEventListener('error', () => { window.clearTimeout(timer); resolve(false) }, { once: true })
      })
      sockets.push({ connectionId: id, open })
    }
    return {
      descriptors: descriptors.map(value => ({
        baseUrl: value?.baseUrl,
        connectionId: value?.connectionId,
        profile: value?.profile,
        registryScoped: value?.registryScoped,
        wsUrl: value?.wsUrl
      })),
      statuses: statuses.map(status => ({ overall: status.overall, profiles: status.profiles, version: status.version })),
      sockets
    }
  }, { connectionIds: connections.map(conn => conn.id) })

  const gatewayTrigger = page.getByRole('button', { name: /Registered gateways:/ })
  await gatewayTrigger.waitFor({ timeout: 10000 })
  const triggerRect = await gatewayTrigger.evaluate(button => {
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
    path: path.join(evidenceDir, 'narrow-viewport-gateways.png'),
    fullPage: true
  })

  const selectionResults = []
  for (const connection of connections) {
    const label = connection.label
    await page.getByRole('menuitemradio', { name: label }).click()
    await page.waitForFunction((id) => localStorage.getItem('hermes-mobile-connection-id') === id, connection.id, { timeout: 15000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction((id) => localStorage.getItem('hermes-mobile-connection-id') === id, connection.id, { timeout: 15000 })
    const triggerText = await page.getByRole('button', { name: /Registered gateways:/ }).innerText()
    const persistedAfterReload = triggerText.includes(label)
    selectionResults.push({ connectionId: connection.id, triggerText, persistedAfterReload })
    await page.getByRole('button', { name: /Registered gateways:/ }).click()
  }

  await page.getByRole('menuitemradio', { name: primary.label }).click()
  await page.waitForFunction((id) => localStorage.getItem('hermes-mobile-connection-id') === id, primary.id, { timeout: 15000 })

  const nodeApiCached = await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      if ((await cache.keys()).some(request => /\/nodes\/[^/]+\/api\//.test(new URL(request.url).pathname))) return true
    }
    return false
  })

  const failures = []
  if (results.descriptors.some(item => !item.registryScoped || !item.connectionId)) failures.push('connection identity missing')
  if (results.statuses.some(status => status.overall !== 'ok')) failures.push('one or more node status checks failed')
  if (results.sockets.some(socket => !socket.open)) failures.push(`one or more node WebSockets failed: ${JSON.stringify(results.sockets)}`)
  for (const connection of connections) {
    const source = evidence.roster?.sources?.find(item => item.connectionId === connection.id)
    if (!source?.reachable) failures.push(`connection ${connection.id} is missing a reachable roster source`)
    if (!evidence.roster?.agents?.some(agent => agent.connectionId === connection.id && agent.profile === 'default')) {
      failures.push(`connection ${connection.id} is missing a default-profile roster agent`)
    }
    if (!nodeItems.includes(connection.label)) failures.push(`gateway selector is missing ${connection.label}`)
  }
  if (nodeItemRects.some(item => item.height < 44)) failures.push('gateway selector menu row is below 44px')
  if (triggerRect.height < 44) failures.push('gateway selector trigger is below 44px')
  if (selectionResults.some(result => !result.persistedAfterReload)) failures.push('Connection selection did not persist across reload')
  if (nodeApiCached) failures.push('node API response entered the service worker cache')
  if (errors.length) failures.push(`browser errors: ${errors.join(' | ')}`)

  await fs.writeFile(
    path.join(evidenceDir, 'results.json'),
    JSON.stringify({ evidence, errors, failures, loginStatuses, results, selectionResults }, null, 2)
  )

  console.log(JSON.stringify({
    loginStatuses,
    registryIds: connections.map(conn => conn.id),
    sourceReachability: evidence.roster?.sources?.map(source => ({ id: source.connectionId, reachable: source.reachable })),
    rosterAgents: evidence.roster?.agents?.map(agent => ({ connectionId: agent.connectionId, profile: agent.profile })),
    profileCounts: results.statuses.map(status => status.profiles?.length),
    socketResults: results.sockets,
    nodeItems,
    nodeItemRects,
    triggerRect,
    nodeApiCached,
    versions: results.statuses.map(status => status.version),
    errors,
    failures,
    selectionResults
  }, null, 2))

  if (failures.length) exitCode = 1
} finally {
  await browser.close()
}
if (exitCode) process.exitCode = exitCode
