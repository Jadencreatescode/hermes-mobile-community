# Browser Capability Contract

## Purpose

Run the official Hermes Desktop React renderer as an installable browser application without weakening the Desktop preload boundary or duplicating agent behavior.

The browser adapter is installed only when `window.hermesDesktop` is absent. Electron builds continue using the existing preload bridge byte for byte.

## Authority

1. Hermes backend owns sessions, profiles, models, tools, skills, MCP, cron, configuration, files, and agent execution.
2. Browser renderer owns presentation, touch interaction, selected node, selected profile, and install state.
3. The private relay owns authenticated node routing and WebSocket forwarding.
4. Native machine operations remain on the selected Hermes node.

## Initial boot requirements

The Desktop boot path directly requires these browser bridge capabilities:

1. `getConnection`
2. `getBootProgress`
3. `onBootProgress`
4. `onBackendExit`
5. `api`
6. `profile.get`

These capabilities are optional but should be implemented for correct reconnect and switching behavior:

1. `getGatewayWsUrl`
2. `revalidateConnection`
3. `onPowerResume`
4. `onConnectionApplied`
5. `connections.list`
6. `connections.onChanged`
7. `touchBackend`
8. `getConnectionFor`
9. `getGatewayWsUrlFor`
10. `getAgentRoster`

## Same origin transport

1. REST requests use the current application origin and `credentials: include`.
2. Request paths and methods remain the existing Desktop dashboard API contract.
3. Profile scope becomes the existing `profile` query parameter.
4. Connection scope becomes a relay selected route and is never trusted from arbitrary browser input.
5. WebSocket URLs use `/api/ws`.
6. Cookie authenticated routes mint a single use ticket through `POST /api/auth/ws-ticket` immediately before connection.
7. Token authenticated disposable tests may use the existing token query contract.

## Browser equivalents

1. Clipboard uses the browser Clipboard API with a safe text fallback.
2. File selection uses hidden browser file inputs.
3. Downloads use authenticated fetch plus an object URL.
4. External URLs use `window.open` with opener isolation.
5. Notifications use the browser Notification API only after user permission.
6. Visibility and network events replace Electron power and window state events where equivalent.
7. Connection registry persists nonsecret labels and selected identifiers in browser storage. Secrets remain server side in the private relay.
8. Zoom uses browser CSS or visual viewport behavior, not Electron webFrame.

## Explicitly unavailable in the first browser checkpoint

These Electron only capabilities must not crash boot. They return a clear unsupported result or remain absent so existing optional chaining applies:

1. Native HUD windows
2. Native pet overlay windows
3. Global quick entry hotkeys
4. Native title bar controls
5. OS file reveal and local directory selection on the phone
6. Local Electron PTY
7. Native Git worktree dialogs on the phone
8. Native application updater

The underlying remote work remains available through Hermes agent tools. Direct phone UI equivalents for terminal, remote files, and Git review are separate verified slices.

## Security rules

1. No backend token, node API key, or relay secret is bundled into JavaScript.
2. No unrestricted arbitrary proxy target is accepted from the browser.
3. Every relay request resolves an allowlisted node identifier server side.
4. WebSocket and REST routes share the same authenticated session and node selection.
5. Cross site request protection applies to state changing relay calls.
6. External URLs never receive an opener reference.
7. Browser storage contains no reusable backend credentials.

## First checkpoint

1. Install the adapter only in ordinary browser mode.
2. Preserve an existing Electron bridge unchanged.
3. Boot the Desktop renderer against a disposable mocked `hermes serve` backend.
4. Open a WebSocket.
5. Load model and profile data through REST.
6. Create or resume a disposable session.
7. Stream one mock assistant response.
8. Verify browser refresh restores node and profile presentation state.
9. Verify no production service or configuration changed.
