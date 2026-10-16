# Desktop-dist relay deploy (phone / tablet testing)

This surface serves the **Electron desktop app built as a PWA** (`apps/desktop/dist`)
through a Python relay for phone and tablet testing. It is distinct from the public
Hermes Mobile thin-client release described in `iphone-ipad-testing.md`.

- Service: `hermes-mobile-control-center.service` (user unit, `~/.config/systemd/user/`)
- Serves: `--static-root apps/desktop/dist`
- Upstream: `http://127.0.0.1:9100` (Hermes server / dashboard)
- Listen: `0.0.0.0:4175`

## How the relay serves files

`server/mobile_relay.py` reads every file under `--static-root` into memory **once at
startup** (`STATIC_FILES`, built from disk at boot) and serves from that snapshot.
Responses carry `Cache-Control: no-store`, so the browser never caches — but the relay
itself does not re-read disk per request. Therefore a source change requires a **rebuild
plus a service restart** to reach the phone; `npm run dev` hot-reload does not apply here.

## Deploy one-liner

Run from the repo root. Rebuilds the PWA, then restarts the relay so it re-reads the new
assets:

```bash
cd apps/desktop && npm run build && systemctl --user restart hermes-mobile-control-center.service
```

`npm run build` runs `vite build` (regenerates `dist/` with new hashed asset names), then
bundles `electron-main.mjs` + `electron-preload.js` and stages native deps. It exits non-zero
on a failed build, and the `&&` chain aborts the restart if the build fails.

## Verify

```bash
# service healthy and listening
systemctl --user status hermes-mobile-control-center.service --no-pager
ss -ltnp | grep 4175

# served index references the freshly built chunk
curl -s http://127.0.0.1:4175/ | grep -oE "assets/index-[A-Za-z0-9_-]+\.js"

# confirm your change compiled in (asset names are hashed, so grep the bundle)
grep -rl "hover: none" apps/desktop/dist/assets/   # example: the $hoverNone touch detection
```

## Notes

- The build takes ~35s; the service `RestartSec` is 5s on failure.
- `dist/` is gitignored, so rebuilds are not tracked — always rebuild after source changes.
- To test on device, open `http://<host>:4175` in Safari and **Add to Home Screen**.
