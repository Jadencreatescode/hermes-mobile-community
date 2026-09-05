"""Tests for A2A harness agent lifecycle dashboard endpoints."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("operations_plugin_api_test_a2a", module_path)
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


@pytest.fixture
def api_module(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "harness_agents.db")
    monkeypatch.setattr(api, "_a2a_catalog_path", lambda: tmp_path / "agent_cards.db")
    # Reset rate limiter for isolation
    api._a2a_rate_limiter._user_buckets.clear()
    api._a2a_rate_limiter._global_bucket.clear()
    return api


class TestA2ARegister:
    def test_register_valid_url_creates_pending_agent(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        mock_card = {"name": "Test Agent", "description": "A test agent"}
        with patch("plugins.harness_agents.catalog.AgentCardCatalog") as MockCatalog:
            instance = MockCatalog.return_value
            instance.get.return_value = mock_card

            resp = asyncio.run(
                request_json(
                    app,
                    "POST",
                    "/agents/a2a/register",
                    {"url": "https://example.com/agent", "confirm": False},
                )
            )

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["name"] == "Test Agent"
        assert payload["status"] == "pending"
        assert "agent_id" in payload
        assert "capabilities" in payload

    def test_register_normalizes_well_known_suffixes(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        mock_card = {"name": "Agent Card", "description": "card"}
        with patch("plugins.harness_agents.catalog.AgentCardCatalog") as MockCatalog:
            instance = MockCatalog.return_value
            instance.get.return_value = mock_card

            resp = asyncio.run(
                request_json(
                    app,
                    "POST",
                    "/agents/a2a/register",
                    {"url": "https://example.com/.well-known/agent-card.json"},
                )
            )

        assert resp.status_code == 200
        payload = resp.json()
        # The normalized URL should be used (no .well-known suffix)
        assert payload["name"] == "Agent Card"

    def test_register_rejects_private_ip_with_a2a_destination_not_allowed(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://192.168.1.1/agent"},
            )
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_metadata_host(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://metadata.google.internal/agent"},
            )
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_malformed_card(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        mock_card = {"description": "missing name"}
        with patch("plugins.harness_agents.catalog.AgentCardCatalog") as MockCatalog:
            instance = MockCatalog.return_value
            instance.get.return_value = mock_card

            resp = asyncio.run(
                request_json(
                    app,
                    "POST",
                    "/agents/a2a/register",
                    {"url": "https://example.com/agent"},
                )
            )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "a2a_malformed_agent_card"

    def test_register_confirm_verifies_and_binds_mirror(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        mock_card = {"name": "Confirm Agent", "description": "d"}
        probe_result = {
            "verified": True,
            "native_agent_id": "native-1",
            "capabilities": ["chat.send"],
            "operations": ["probe", "send"],
        }
        with patch("plugins.harness_agents.catalog.AgentCardCatalog") as MockCatalog:
            instance = MockCatalog.return_value
            instance.get.return_value = mock_card
            with patch("plugins.harness_agents.connectors.A2AConnector") as MockConn:
                conn = MockConn.return_value
                conn.probe.return_value = probe_result

                resp = asyncio.run(
                    request_json(
                        app,
                        "POST",
                        "/agents/a2a/register",
                        {"url": "https://example.com/agent", "confirm": True},
                    )
                )

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["status"] == "verified"

    def test_register_response_contains_no_credentials_or_destination(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        mock_card = {"name": "Safe Agent", "description": "d"}
        with patch("plugins.harness_agents.catalog.AgentCardCatalog") as MockCatalog:
            instance = MockCatalog.return_value
            instance.get.return_value = mock_card

            resp = asyncio.run(
                request_json(
                    app,
                    "POST",
                    "/agents/a2a/register",
                    {"url": "https://example.com/agent"},
                )
            )

        assert resp.status_code == 200
        payload = resp.json()
        response_json = json.dumps(payload)
        assert "connector_url" not in response_json
        assert "auth_env" not in response_json
        assert "token" not in response_json.lower()
        assert "example.com" not in response_json


class TestA2AList:
    def test_list_returns_public_safe_summaries(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        # Seed one agent
        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:test123",
                "name": "Listed Agent",
                "handle": "listed-agent",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.close()

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        assert resp.status_code == 200
        payload = resp.json()
        assert len(payload["agents"]) == 1
        agent = payload["agents"][0]
        assert agent["name"] == "Listed Agent"
        assert "connector_url" not in agent
        assert "example.com" not in json.dumps(agent)


class TestA2AStatus:
    def test_status_returns_public_safe_summary(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:status456",
                "name": "Status Agent",
                "handle": "status-agent",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.close()

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a/a2a:status456/status"))
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["name"] == "Status Agent"
        assert "connector_url" not in json.dumps(payload)

    def test_status_404_for_missing_agent(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a/missing-id/status"))
        assert resp.status_code == 404
        assert resp.json()["detail"] == "a2a_agent_not_found"


class TestA2ADelete:
    def test_delete_removes_agent(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:del789",
                "name": "Delete Agent",
                "handle": "delete-agent",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.close()

        resp = asyncio.run(request_json(app, "DELETE", "/agents/a2a/a2a:del789"))
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        # Verify gone
        resp2 = asyncio.run(request_json(app, "GET", "/agents/a2a/a2a:del789/status"))
        assert resp2.status_code == 404

    def test_delete_404_for_missing_agent(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(request_json(app, "DELETE", "/agents/a2a/missing-id"))
        assert resp.status_code == 404
        assert resp.json()["detail"] == "a2a_agent_not_found"


class TestA2ARateLimiting:
    def test_rate_limit_blocks_excess_requests(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        # Force a very low per-user limit by temporarily overriding constants
        api_module._A2A_RATE_LIMIT_PER_USER = 2
        api_module._A2A_RATE_LIMIT_GLOBAL = 100
        api_module._a2a_rate_limiter._user_buckets.clear()
        api_module._a2a_rate_limiter._global_bucket.clear()

        for _ in range(2):
            resp = asyncio.run(request_json(app, "GET", "/agents/a2a"))
            assert resp.status_code == 200

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        assert resp.status_code == 429
        assert resp.json()["detail"] == "a2a_rate_limited"


class TestA2ARegisterEdgeCases:
    def test_register_rejects_non_https_url(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "http://example.com/agent"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_url_with_credentials(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://user:pass@example.com/agent"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_localhost(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://127.0.0.1/agent"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_blocked_ipv6(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "https://[::1]/agent"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"

    def test_register_rejects_malformed_url(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(
            request_json(
                app,
                "POST",
                "/agents/a2a/register",
                {"url": "not-a-url"},
            )
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "a2a_destination_not_allowed"


class TestA2AListEdgeCases:
    def test_list_empty_returns_empty_array(self, api_module):
        app = FastAPI()
        app.include_router(api_module.router)

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["agents"] == []


class TestA2AStatusExtended:
    def test_status_includes_capabilities_when_verified(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:status-verified",
                "name": "Verified Agent",
                "handle": "verified-agent",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.mark_verified(
            "a2a:status-verified",
            native_agent_id="n1",
            native_session_id="s1",
            mirror_session_id="m1",
            capabilities=["agent.view", "chat.send"],
        )
        reg.close()

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a/a2a:status-verified/status"))
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["status"] == "verified"
        assert "agent.view" in payload["capabilities"]

    def test_status_omits_connector_url(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:status-safe",
                "name": "Safe Agent",
                "handle": "safe-agent",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.close()

        resp = asyncio.run(request_json(app, "GET", "/agents/a2a/a2a:status-safe/status"))
        assert resp.status_code == 200
        payload = resp.json()
        assert "connector_url" not in json.dumps(payload)
        assert "auth_env" not in json.dumps(payload)


class TestA2ADeleteExtended:
    def test_delete_already_deleted_returns_404(self, api_module, tmp_path):
        app = FastAPI()
        app.include_router(api_module.router)

        from plugins.harness_agents.registry import HarnessRegistry

        reg = HarnessRegistry(tmp_path / "harness_agents.db")
        reg.create_agent(
            {
                "id": "a2a:del-twice",
                "name": "Del Twice",
                "handle": "del-twice",
                "description": "",
                "harness": "generic_a2a",
                "host_id": "example.com",
                "host_label": "example.com",
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.close()

        resp1 = asyncio.run(request_json(app, "DELETE", "/agents/a2a/a2a:del-twice"))
        assert resp1.status_code == 200
        assert resp1.json()["deleted"] is True

        resp2 = asyncio.run(request_json(app, "DELETE", "/agents/a2a/a2a:del-twice"))
        assert resp2.status_code == 404
        assert resp2.json()["detail"] == "a2a_agent_not_found"
