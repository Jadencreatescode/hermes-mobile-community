import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import WSCloseCode, web
from aiohttp.test_utils import TestClient, TestServer

import server.mobile_relay as mobile_relay
from server.mobile_relay import create_relay_app


class MobileRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.primary_paths = []
        self.peer_cookies = []
        primary = web.Application(client_max_size=64 * 1024 * 1024)

        async def status(request: web.Request):
            self.primary_paths.append(request.path_qs)
            response = web.json_response({"ok": True, "node": "primary"})
            response.set_cookie("hermes_session_at", "opaque", httponly=True, path="/")
            return response

        async def upload(request: web.Request):
            payload = await request.read()
            return web.json_response({"received": len(payload)})

        async def operations(request: web.Request):
            self.primary_paths.append(request.path_qs)
            await request.read()
            return web.json_response({"method": request.method, "path": request.path})

        async def websocket(request: web.Request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            emit_text = int(request.query.get("emit_text", "0"))
            if emit_text:
                await ws.send_str("u" * emit_text)
            async for message in ws:
                if message.type == web.WSMsgType.TEXT:
                    reply = message.data if request.query.get("echo") == "1" else f"relay:{message.data}"
                    await ws.send_str(reply)
                elif message.type == web.WSMsgType.BINARY:
                    await ws.send_bytes(message.data)
            return ws

        primary.router.add_get("/api/status", status)
        primary.router.add_post("/api/upload", upload)
        primary.router.add_route("*", "/api/plugins/operations/{path:.*}", operations)
        primary.router.add_get("/api/ws", websocket)
        self.primary_server = TestServer(primary)
        await self.primary_server.start_server()

        peer = web.Application()

        async def peer_status(request: web.Request):
            self.peer_cookies.append(request.cookies.get("hermes_session_at"))
            response = web.json_response({"ok": True, "node": "peer-a"})
            response.set_cookie("hermes_session_at", "peer-opaque", httponly=True, path="/")
            return response

        async def peer_login(request: web.Request):
            return web.json_response({"ok": True, "node": "peer-a"})

        async def peer_config(request: web.Request):
            return web.json_response({"ok": True, "writable": True})

        peer.router.add_get("/api/status", peer_status)
        peer.router.add_post("/api/config", peer_config)
        peer.router.add_post("/auth/password-login", peer_login)
        peer.router.add_get("/api/ws", websocket)
        self.peer_server = TestServer(peer)
        await self.peer_server.start_server()

        self.tempdir = tempfile.TemporaryDirectory()
        static_root = Path(self.tempdir.name)
        self.static_root = static_root
        (static_root / "index.html").write_text("<main>Hermes Mobile</main>", encoding="utf-8")
        (static_root / "asset.js").write_text("window.mobile = true", encoding="utf-8")

        relay = create_relay_app(
            static_root=static_root,
            upstream=str(self.primary_server.make_url("/")),
            nodes={
                "peer-a": str(self.peer_server.make_url("/")),
                "peer-readonly": str(self.peer_server.make_url("/")),
            },
            read_only_nodes={"peer-readonly"},
        )
        self.relay_server = TestServer(relay)
        self.client = TestClient(self.relay_server)
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.primary_server.close()
        await self.peer_server.close()
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

    async def test_static_asset_inventory_is_fixed_at_startup(self):
        late_asset = self.static_root / "late.js"
        late_asset.write_text("window.late = true", encoding="utf-8")

        response = await self.client.get("/late.js")

        self.assertEqual(response.status, 200)
        self.assertIn("Hermes Mobile", await response.text())

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
        self.assertEqual(self.primary_paths, [])

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
                    upstream=str(self.primary_server.make_url("/")),
                    backend_id=backend_id,
                    backend_label=backend_label,
                )

    async def test_proxies_http_query_and_session_cookie(self):
        response = await self.client.get("/api/status?detail=1")

        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"ok": True, "node": "primary"})
        self.assertEqual(self.primary_paths, ["/api/status?detail=1"])
        self.assertEqual(response.cookies["hermes_session_at"].value, "opaque")

    async def test_proxies_public_operations_plugin_paths_without_widening_the_relay(self):
        response = await self.client.post(
            "/api/plugins/operations/mailroom",
            json={"source_profile": "default", "target_profile": "builder", "body": "Review."},
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            await response.json(),
            {"method": "POST", "path": "/api/plugins/operations/mailroom"},
        )
        self.assertEqual(self.primary_paths, ["/api/plugins/operations/mailroom"])

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

    def test_websocket_frame_limit_covers_the_public_attachment_contract(self):
        raw_attachment_bytes = 256 * 1024 * 1024
        base64_bytes = ((raw_attachment_bytes + 2) // 3) * 4

        self.assertGreater(mobile_relay.MAX_WEBSOCKET_MESSAGE_BYTES, base64_bytes)

    async def test_websocket_frame_limit_accepts_the_exact_boundary_in_both_directions(self):
        test_limit = 64 * 1024
        with patch.object(mobile_relay, "MAX_WEBSOCKET_MESSAGE_BYTES", test_limit):
            relay = create_relay_app(
                static_root=self.static_root,
                upstream=str(self.primary_server.make_url("/")),
            )
            client = TestClient(TestServer(relay))
            await client.start_server()
            try:
                ws = await client.ws_connect("/api/ws?echo=1", max_msg_size=test_limit + 1)
                payload = "x" * test_limit
                await ws.send_str(payload)
                echoed = await ws.receive(timeout=2)
                self.assertEqual(echoed.type, web.WSMsgType.TEXT)
                self.assertEqual(echoed.data, payload)
                await ws.close()

                ws = await client.ws_connect(f"/api/ws?emit_text={test_limit}", max_msg_size=test_limit + 1)
                emitted = await ws.receive(timeout=2)
                self.assertEqual(emitted.type, web.WSMsgType.TEXT)
                self.assertEqual(emitted.data, "u" * test_limit)
                await ws.close()
            finally:
                await client.close()

    async def test_websocket_frame_limit_refuses_limit_plus_one_in_both_directions(self):
        test_limit = 64 * 1024
        with patch.object(mobile_relay, "MAX_WEBSOCKET_MESSAGE_BYTES", test_limit):
            relay = create_relay_app(
                static_root=self.static_root,
                upstream=str(self.primary_server.make_url("/")),
            )
            client = TestClient(TestServer(relay))
            await client.start_server()
            try:
                ws = await client.ws_connect("/api/ws")
                await ws.send_str("x" * (test_limit + 1))
                refused = await ws.receive(timeout=2)
                self.assertEqual(refused.type, web.WSMsgType.CLOSE)
                self.assertEqual(ws.close_code, WSCloseCode.MESSAGE_TOO_BIG)

                ws = await client.ws_connect(f"/api/ws?emit_text={test_limit + 1}")
                refused = await ws.receive(timeout=2)
                self.assertEqual(refused.type, web.WSMsgType.CLOSE)
                self.assertEqual(ws.close_code, WSCloseCode.MESSAGE_TOO_BIG)
            finally:
                await client.close()

    async def test_scopes_prefixed_node_cookies_and_strips_the_prefix(self):
        first = await self.client.get("/nodes/peer-a/api/status")
        self.assertEqual(await first.json(), {"ok": True, "node": "peer-a"})
        cookie = first.cookies["hermes_peer-a__hermes_session_at"]
        self.assertEqual(cookie.value, "peer-opaque")
        self.assertEqual(cookie["path"], "/nodes/peer-a")

        await self.client.get(
            "/nodes/peer-a/api/status",
            headers={"Cookie": "hermes_peer-a__hermes_session_at=peer-opaque; hermes_session_at=primary-opaque"},
        )
        self.assertEqual(self.peer_cookies, [None, "peer-opaque"])

    async def test_proxies_prefixed_node_websocket(self):
        ws = await self.client.ws_connect("/nodes/peer-a/api/ws?ticket=single-use")
        await ws.send_str("peer-a")
        message = await ws.receive(timeout=2)
        self.assertEqual(message.data, "relay:peer-a")
        await ws.close()

    async def test_read_only_node_allows_only_status_get(self):
        status = await self.client.get("/nodes/peer-readonly/api/status")
        write = await self.client.post("/nodes/peer-readonly/api/status")
        login = await self.client.post("/nodes/peer-readonly/auth/password-login", json={})
        download = await self.client.get("/nodes/peer-readonly/api/fs/download?path=/tmp/x")

        self.assertEqual(status.status, 200)
        self.assertEqual(write.status, 403)
        self.assertEqual(login.status, 403)
        self.assertEqual(download.status, 403)

        with self.assertRaises(Exception):
            await self.client.ws_connect("/nodes/peer-readonly/api/ws?ticket=single-use")

    async def test_node_is_fully_interactive_when_read_only_policy_is_not_assigned(self):
        relay = create_relay_app(
            static_root=self.static_root,
            upstream=str(self.primary_server.make_url("/")),
            nodes={"peer-readonly": str(self.peer_server.make_url("/"))},
            read_only_nodes=set(),
        )
        server = TestServer(relay)
        client = TestClient(server)
        await client.start_server()
        try:
            login = await client.post("/nodes/peer-readonly/auth/password-login", json={})
            write = await client.post("/nodes/peer-readonly/api/config", json={"enabled": True})
            ws = await client.ws_connect("/nodes/peer-readonly/api/ws?ticket=single-use")
            await ws.send_str("peer-readonly")
            message = await ws.receive(timeout=2)

            self.assertEqual(login.status, 200)
            self.assertEqual(write.status, 200)
            self.assertEqual(message.data, "relay:peer-readonly")
            await ws.close()
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
