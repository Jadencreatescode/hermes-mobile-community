"""Integration test: full card-url -> onboard -> chat -> meeting against a local mock A2A peer.

A local threaded HTTP server acts as the A2A peer.  The test exercises the
real HTTP stack through policy, catalog, registry, connectors, dashboard
endpoints, and meeting store.  A penetration-style malicious endpoint is also
rejected.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("operations_plugin_api_test_integration", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def request_json(app: FastAPI, method: str, path: str, payload=None, headers=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://operations.test"
    ) as client:
        return await client.request(method, path, json=payload, headers=headers)


class _MockA2APeerHandler(BaseHTTPRequestHandler):
    """Minimal A2A JSON-RPC v1 peer."""

    card: dict = {}
    messages_received: list = []
    reply_text: str = "Hello from mock peer"

    def log_message(self, format, *args):
        pass

    def _json(self, code: int, payload: dict):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_GET(self):
        if self.path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
            return self._json(200, self.card)
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode()
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            return self._json(400, {"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}})

        method = req.get("method", "")
        req_id = req.get("id", 0)

        if method == "SendMessage":
            params = req.get("params", {})
            msg = params.get("message", {})
            text = ""
            for part in msg.get("parts", []):
                if part.get("type") == "text":
                    text = part.get("text", "")
                    break
            self.messages_received.append(text)
            result = {
                "status": {"state": "TASK_STATE_COMPLETED"},
                "artifacts": [{"type": "text", "text": self.reply_text}],
                "contextId": params.get("contextId") or "mock-session-1",
            }
            return self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": result})

        if method.startswith("hermes/"):
            return self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": {"ok": True}})

        self._json(200, {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}})


@pytest.fixture
def api_module(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "harness_agents.db")
    monkeypatch.setattr(api, "_a2a_catalog_path", lambda: tmp_path / "agent_cards.db")
    api._a2a_rate_limiter._user_buckets.clear()
    api._a2a_rate_limiter._global_bucket.clear()
    return api


def _start_mock_peer(card: dict, reply_text: str = "Hello from mock peer"):
    server = HTTPServer(("127.0.0.1", 0), _MockA2APeerHandler)
    _MockA2APeerHandler.card = card
    _MockA2APeerHandler.messages_received = []
    _MockA2APeerHandler.reply_text = reply_text
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _, port = server.server_address
    return server, port


def _mock_peer_getaddrinfo(*args, **kwargs):
    """Resolve every hostname to loopback so the real HTTP stack reaches the
    local mock peer. Destination policy is bypassed separately by the
    ``validate_url`` patch so loopback is accepted here.
    """
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", args[1] if len(args) > 1 else 0))]


def _allow_http_validate_url(url: str, *, allowlist=None, require_https: bool = True):
    """Drop-in that accepts HTTP for the integration test mock peer."""
    from urllib.parse import urlsplit
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.casefold()
    host = str(parsed.hostname).casefold().rstrip(".")
    port = parsed.port or (443 if scheme == "https" else 80)
    return scheme, host, port


class TestA2AFullFlow:
    def test_register_confirm_chat_meeting_flow(self, api_module, tmp_path):
        card = {
            "name": "Mock Peer Agent",
            "description": "A friendly mock agent for integration testing",
            "capabilities": {"streaming": False, "pushNotifications": False},
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "protocolVersion": "1.0", "url": "http://localhost:{port}/"}
            ],
            "skills": [{"id": "greet", "name": "Greeting"}],
        }

        server, port = _start_mock_peer(card)
        try:
            base_url = f"http://localhost:{port}"
            # Patch the card interface URL to match the actual port
            card["supportedInterfaces"][0]["url"] = base_url + "/"

            app = FastAPI()
            app.include_router(api_module.router)

            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                # 1) Register + confirm (onboard)
                resp = asyncio.run(
                    request_json(
                        app,
                        "POST",
                        "/agents/a2a/register",
                        {"url": base_url, "confirm": True},
                    )
                )

            assert resp.status_code == 200
            payload = resp.json()
            assert payload["name"] == "Mock Peer Agent"
            assert payload["status"] == "verified"
            agent_id = payload["agent_id"]

            # 2) List agents
            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                resp = asyncio.run(
                    request_json(app, "GET", "/agents/a2a")
                )
            assert resp.status_code == 200
            agents = resp.json()["agents"]
            assert any(a["agent_id"] == agent_id for a in agents)

            # 3) Chat history (empty at first)
            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                resp = asyncio.run(
                    request_json(app, "GET", f"/agents/a2a/{agent_id}/chat")
                )
            assert resp.status_code == 200
            history = resp.json()
            assert history.get("messages", []) == []

            # 4) Send chat message
            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                resp = asyncio.run(
                    request_json(
                        app,
                        "POST",
                        f"/agents/a2a/{agent_id}/chat",
                        {"message": "Hello peer"},
                    )
                )
            assert resp.status_code == 200
            chat_resp = resp.json()
            assert chat_resp["reply"] == "Hello from mock peer"
            assert chat_resp["request_status"] == "committed"

            # 5) Chat history now contains the turn
            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                resp = asyncio.run(
                    request_json(app, "GET", f"/agents/a2a/{agent_id}/chat")
                )
            assert resp.status_code == 200
            history = resp.json()
            assert len(history.get("messages", [])) >= 2

            # 6) Create a meeting with the agent as participant
            meeting_id = "meet-int-001"
            human = {"connection": "local", "profile": "host"}
            meeting_record = {
                "id": meeting_id,
                "source": {"connection": "local", "profile": "default"},
                "title": "Integration stand-up",
                "agenda": "Verify end-to-end flow",
                "chair": human,
                "participants": [
                    human,
                    {"connection": agent_id, "profile": "agent"},
                ],
                "state": "draft",
                "max_rounds": 3,
                "current_round": 0,
                "contributions": [],
                "evidence": [],
                "decisions": [],
                "dissent": [],
                "action_items": [],
            }
            resp = asyncio.run(
                request_json(
                    app,
                    "PUT",
                    f"/meetings/{meeting_id}",
                    {"record": meeting_record, "expected_version": 0},
                )
            )
            assert resp.status_code == 200

            # 7) Retrieve meeting
            resp = asyncio.run(
                request_json(app, "GET", f"/meetings/{meeting_id}")
            )
            assert resp.status_code == 200
            fetched = resp.json()["meeting"]
            assert fetched["title"] == "Integration stand-up"
            assert any(p["connection"] == agent_id for p in fetched.get("participants", []))

            # Verify the mock peer actually received the message
            assert _MockA2APeerHandler.messages_received == ["Hello peer"]
        finally:
            server.shutdown()

    def test_malicious_agent_card_rejected(self, api_module):
        """A peer that serves a card with a mismatched/cross-origin endpoint must be rejected."""
        card = {
            "name": "Evil Peer",
            "description": "Tries to redirect to an external domain",
            "capabilities": {},
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "protocolVersion": "1.0", "url": "https://evil.example.com/api"}
            ],
            "skills": [],
        }

        server, port = _start_mock_peer(card)
        try:
            base_url = f"http://localhost:{port}"
            app = FastAPI()
            app.include_router(api_module.router)

            with patch("socket.getaddrinfo", side_effect=_mock_peer_getaddrinfo), patch(
                "plugins.harness_agents.policy.validate_url", side_effect=_allow_http_validate_url
            ):
                resp = asyncio.run(
                    request_json(
                        app,
                        "POST",
                        "/agents/a2a/register",
                        {"url": base_url, "confirm": True},
                    )
                )

            # Probe should reject because the interface url crosses origin
            assert resp.status_code == 400
            detail = resp.json().get("detail", "")
            assert "verification_failed" in detail or "cross" in detail.lower() or "origin" in detail.lower()
        finally:
            server.shutdown()

    def test_malicious_private_ip_rejected(self, api_module):
        """Direct registration against a loopback IP must be rejected by policy."""
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://127.0.0.1:9999/agent"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_meeting_prevents_too_many_participants(self, api_module):
        """Meeting store enforces participant limits."""
        app = FastAPI()
        app.include_router(api_module.router)

        meeting_id = "meet-int-002"
        meeting_record = {
            "id": meeting_id,
            "title": "Overflow",
            "agenda": "Too many agents",
            "state": "draft",
            "participants": [
                {"connection": f"a2a:{i:03d}", "profile": "agent"}
                for i in range(10)
            ],
            "currentRound": 0,
            "maxRounds": 3,
            "contributions": [],
            "decisions": [],
            "history": [],
        }
        resp = asyncio.run(
            request_json(
                app,
                "PUT",
                f"/meetings/{meeting_id}",
                {"record": meeting_record, "expected_version": 0},
            )
        )
        assert resp.status_code == 400
