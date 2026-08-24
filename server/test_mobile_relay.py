import io
import tempfile
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server.mobile_relay import create_relay_app


class MobileRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.upstream_paths = []
        self.bridge_cookies = []
        upstream = web.Application(client_max_size=64 * 1024 * 1024)

        async def status(request: web.Request):
            self.upstream_paths.append(request.path_qs)
            response = web.json_response({"ok": True, "node": "vps"})
            response.set_cookie("hermes_session_at", "opaque", httponly=True, path="/")
            return response

        async def upload(request: web.Request):
            payload = await request.read()
            return web.json_response({"received": len(payload)})

        async def websocket(request: web.Request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            async for message in ws:
                if message.type == web.WSMsgType.TEXT:
                    await ws.send_str(f"relay:{message.data}")
            return ws

        upstream.router.add_get("/api/status", status)
        upstream.router.add_post("/api/upload", upload)
        upstream.router.add_get("/api/ws", websocket)
        self.upstream_server = TestServer(upstream)
        await self.upstream_server.start_server()

        bridge = web.Application()

        async def bridge_status(request: web.Request):
            self.bridge_cookies.append(request.cookies.get("hermes_session_at"))
            response = web.json_response({"ok": True, "node": "bridge"})
            response.set_cookie("hermes_session_at", "bridge-opaque", httponly=True, path="/")
            return response

        async def bridge_login(request: web.Request):
            return web.json_response({"ok": True, "node": "bridge"})

        async def bridge_config(request: web.Request):
            return web.json_response({"ok": True, "writable": True})

        bridge.router.add_get("/api/status", bridge_status)
        bridge.router.add_post("/api/config", bridge_config)
        bridge.router.add_post("/auth/password-login", bridge_login)
        bridge.router.add_get("/api/ws", websocket)
        self.bridge_server = TestServer(bridge)
        await self.bridge_server.start_server()

        self.tempdir = tempfile.TemporaryDirectory()
        static_root = Path(self.tempdir.name)
        self.static_root = static_root
        (static_root / "index.html").write_text("<main>Hermes Mobile</main>", encoding="utf-8")
        (static_root / "asset.js").write_text("window.mobile = true", encoding="utf-8")

        relay = create_relay_app(
            static_root=static_root,
            upstream=str(self.upstream_server.make_url("/")),
            nodes={"bridge": str(self.bridge_server.make_url("/")), "helm": str(self.bridge_server.make_url("/"))},
            read_only_nodes={"helm"},
        )
        self.relay_server = TestServer(relay)
        self.client = TestClient(self.relay_server)
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.upstream_server.close()
        await self.bridge_server.close()
        self.tempdir.cleanup()

    async def test_serves_desktop_renderer_and_spa_fallback(self):
        root = await self.client.get("/")
        route = await self.client.get("/settings/models")
        asset = await self.client.get("/asset.js")

        self.assertEqual(root.status, 200)
        self.assertIn("Hermes Mobile", await root.text())
        self.assertEqual(route.status, 200)
        self.assertIn("Hermes Mobile", await route.text())
        self.assertEqual(await asset.text(), "window.mobile = true")

    async def test_serves_single_backend_runtime_descriptor_without_proxying(self):
        response = await self.client.get("/.well-known/hermes-mobile-runtime.json")

        self.assertEqual(response.status, 200)
        self.assertEqual(
            await response.json(),
            {
                "version": 1,
                "backend": {
                    "id": "local",
                    "label": "Local Hermes",
                },
            },
        )
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.upstream_paths, [])

    def test_rejects_runtime_descriptors_the_browser_would_refuse(self):
        invalid = [
            ("local-", "Local Hermes"),
            ("local", " Local Hermes "),
            ("local", "x" * 81),
        ]

        for backend_id, backend_label in invalid:
            with self.subTest(backend_id=backend_id), self.assertRaisesRegex(ValueError, "[Bb]ackend"):
                create_relay_app(
                    static_root=self.static_root,
                    upstream=str(self.upstream_server.make_url("/")),
                    backend_id=backend_id,
                    backend_label=backend_label,
                )

    async def test_proxies_http_query_and_session_cookie(self):
        response = await self.client.get("/api/status?detail=1")

        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"ok": True, "node": "vps"})
        self.assertEqual(self.upstream_paths, ["/api/status?detail=1"])
        self.assertEqual(response.cookies["hermes_session_at"].value, "opaque")

    async def test_proxies_normal_phone_uploads_larger_than_one_megabyte(self):
        payload = b"p" * (2 * 1024 * 1024)
        response = await self.client.post("/api/upload", data=io.BytesIO(payload))

        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"received": len(payload)})

    async def test_rejects_uploads_larger_than_the_documented_limit(self):
        payload = io.BytesIO(b"x" * (64 * 1024 * 1024 + 1))
        response = await self.client.post("/api/upload", data=payload)

        self.assertEqual(response.status, 413)

    async def test_proxies_websocket_frames_bidirectionally(self):
        ws = await self.client.ws_connect("/api/ws?ticket=single-use")
        await ws.send_str("hello")
        message = await ws.receive(timeout=2)

        self.assertEqual(message.data, "relay:hello")
        await ws.close()

    async def test_scopes_prefixed_node_cookies_and_strips_the_prefix(self):
        first = await self.client.get("/nodes/bridge/api/status")
        self.assertEqual(await first.json(), {"ok": True, "node": "bridge"})
        cookie = first.cookies["hermes_bridge__hermes_session_at"]
        self.assertEqual(cookie.value, "bridge-opaque")
        self.assertEqual(cookie["path"], "/nodes/bridge")

        await self.client.get(
            "/nodes/bridge/api/status",
            headers={"Cookie": "hermes_bridge__hermes_session_at=bridge-opaque; hermes_session_at=vps-opaque"},
        )
        self.assertEqual(self.bridge_cookies, [None, "bridge-opaque"])

    async def test_proxies_prefixed_node_websocket(self):
        ws = await self.client.ws_connect("/nodes/bridge/api/ws?ticket=single-use")
        await ws.send_str("bridge")
        message = await ws.receive(timeout=2)
        self.assertEqual(message.data, "relay:bridge")
        await ws.close()

    async def test_read_only_node_allows_only_status_get(self):
        status = await self.client.get("/nodes/helm/api/status")
        write = await self.client.post("/nodes/helm/api/status")
        login = await self.client.post("/nodes/helm/auth/password-login", json={})
        download = await self.client.get("/nodes/helm/api/fs/download?path=/tmp/x")

        self.assertEqual(status.status, 200)
        self.assertEqual(write.status, 403)
        self.assertEqual(login.status, 403)
        self.assertEqual(download.status, 403)

        with self.assertRaises(Exception):
            await self.client.ws_connect("/nodes/helm/api/ws?ticket=single-use")

    async def test_node_is_fully_interactive_when_read_only_policy_is_not_assigned(self):
        relay = create_relay_app(
            static_root=self.static_root,
            upstream=str(self.upstream_server.make_url("/")),
            nodes={"helm": str(self.bridge_server.make_url("/"))},
            read_only_nodes=set(),
        )
        server = TestServer(relay)
        client = TestClient(server)
        await client.start_server()
        try:
            login = await client.post("/nodes/helm/auth/password-login", json={})
            write = await client.post("/nodes/helm/api/config", json={"enabled": True})
            ws = await client.ws_connect("/nodes/helm/api/ws?ticket=single-use")
            await ws.send_str("helm")
            message = await ws.receive(timeout=2)

            self.assertEqual(login.status, 200)
            self.assertEqual(write.status, 200)
            self.assertEqual(message.data, "relay:helm")
            await ws.close()
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
