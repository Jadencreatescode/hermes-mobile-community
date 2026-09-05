"""Unit tests for harness_agents public-safe modules."""

from __future__ import annotations

import ipaddress
import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from plugins.harness_agents import catalog, connectors, manifest, policy, registry


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------


class TestManifest:
    def test_parse_agent_import_minimal(self) -> None:
        source = json.dumps({
            "displayName": "Test Agent",
            "platform": "hermes",
        })
        result = manifest.parse_agent_import(source, "test.json")
        assert result.template["name"] == "Test Agent"
        assert result.template["harness"] == "hermes"
        assert result.template["handle"] == "test-agent"
        assert not result.warnings

    def test_parse_agent_import_redacts_credentials(self) -> None:
        source = json.dumps({
            "displayName": "Bad Agent",
            "platform": "pi",
            "api_key": "sk-secret123",
            "systemPrompt": "Use bearer token: abcdef123456",
        })
        result = manifest.parse_agent_import(source, "bad.json")
        assert "[REDACTED]" in result.template["instructions"]
        assert len(result.warnings) == 2
        assert any("credential" in w for w in result.warnings)

    def test_parse_agent_import_invalid_json(self) -> None:
        with pytest.raises(ValueError, match="valid JSON"):
            manifest.parse_agent_import("not json", "test.json")

    def test_parse_agent_import_too_large(self) -> None:
        with pytest.raises(ValueError, match="maximum source size"):
            manifest.parse_agent_import("x" * 2_000_000, "test.json")


# ---------------------------------------------------------------------------
# policy
# ---------------------------------------------------------------------------


class TestPolicy:
    def test_resolve_capabilities_admin(self) -> None:
        caps = policy.resolve_capabilities("admin")
        assert caps == policy.ALL_CAPABILITIES

    def test_resolve_capabilities_viewer(self) -> None:
        caps = policy.resolve_capabilities("viewer")
        assert caps == frozenset({"agent.view", "chat.read"})

    def test_resolve_capabilities_with_grants(self) -> None:
        caps = policy.resolve_capabilities(
            "viewer", grants=frozenset({"chat.send"})
        )
        assert "chat.send" in caps
        assert "agent.view" in caps

    def test_resolve_capabilities_unknown_role(self) -> None:
        with pytest.raises(ValueError, match="unknown role"):
            policy.resolve_capabilities("superuser")

    def test_validate_url_https_required(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            policy.validate_url("http://example.com")

    def test_validate_url_allows_https(self) -> None:
        scheme, host, port = policy.validate_url("https://example.com")
        assert scheme == "https"
        assert host == "example.com"
        assert port == 443

    def test_validate_url_blocks_private_ip_10(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://10.0.0.1")

    def test_validate_url_blocks_private_ip_172(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://172.16.0.1")

    def test_validate_url_blocks_private_ip_192(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://192.168.1.1")

    def test_validate_url_blocks_loopback(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://127.0.0.1")

    def test_validate_url_blocks_link_local(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.validate_url("https://169.254.1.1")

    def test_validate_url_blocks_metadata_host(self) -> None:
        with pytest.raises(ValueError, match="metadata service"):
            policy.validate_url("https://metadata.google.internal")

    def test_validate_url_allowlist_default_deny(self) -> None:
        with pytest.raises(ValueError, match="allowlist"):
            policy.validate_url("https://example.com", allowlist=frozenset({"other.com"}))

    def test_validate_url_allowlist_explicit_allow(self) -> None:
        scheme, host, port = policy.validate_url(
            "https://example.com", allowlist=frozenset({"example.com"})
        )
        assert host == "example.com"

    def test_fetch_json_rejects_http(self) -> None:
        with pytest.raises(ValueError, match="HTTPS"):
            policy.fetch_json("http://example.com/test")

    def test_fetch_json_rejects_private_destination(self) -> None:
        with pytest.raises(ValueError, match="blocked address"):
            policy.fetch_json("https://192.168.1.1/test")


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_create_and_get_agent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        agent = db.create_agent({
            "id": "hermes:test:abc123",
            "name": "Test Agent",
            "handle": "test-agent",
            "description": "A test agent",
            "harness": "hermes",
            "host_id": "host1",
            "host_label": "Host One",
            "connector_url": "https://example.com/agent",
            "auth_env": "",
            "team_id": "",
        })
        assert agent["name"] == "Test Agent"
        assert agent["verification_state"] == "pending"
        retrieved = db.get_agent("hermes:test:abc123")
        assert retrieved["name"] == "Test Agent"
        db.close()

    def test_list_agents(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "hermes:a:abc",
            "name": "Agent A",
            "handle": "agent-a",
            "description": "",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://a.example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.create_agent({
            "id": "hermes:b:def",
            "name": "Agent B",
            "handle": "agent-b",
            "description": "",
            "harness": "hermes",
            "host_id": "h2",
            "host_label": "H2",
            "connector_url": "https://b.example.com",
            "auth_env": "",
            "team_id": "",
        })
        agents = db.list_agents()
        assert len(agents) == 2
        db.close()

    def test_mark_verified(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "hermes:v:xyz",
            "name": "V Agent",
            "handle": "v-agent",
            "description": "",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://v.example.com",
            "auth_env": "",
            "team_id": "",
        })
        agent = db.mark_verified(
            "hermes:v:xyz",
            native_agent_id="native-1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view", "chat.send"],
        )
        assert agent["verification_state"] == "verified"
        assert agent["native_agent_id"] == "native-1"
        db.close()

    def test_mark_degraded(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "hermes:d:deg",
            "name": "D Agent",
            "handle": "d-agent",
            "description": "",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://d.example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "hermes:d:deg",
            native_agent_id="native-1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view"],
        )
        agent = db.mark_degraded("hermes:d:deg", error="probe timeout")
        assert agent["verification_state"] == "degraded"
        assert agent["verification_error"] == "probe timeout"
        db.close()

    def test_record_event(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "hermes:e:evt",
            "name": "E Agent",
            "handle": "e-agent",
            "description": "",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://e.example.com",
            "auth_env": "",
            "team_id": "",
        })
        event = db.record_event(
            "hermes:e:evt",
            principal="tester",
            event_type="probe",
            outcome="succeeded",
            detail={"latency_ms": 42},
        )
        assert event["event_type"] == "probe"
        assert event["detail"]["latency_ms"] == 42
        db.close()

    def test_chat_binding(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "hermes:c:bind",
            "name": "C Agent",
            "handle": "c-agent",
            "description": "",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://c.example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "hermes:c:bind",
            native_agent_id="native-1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view"],
        )
        binding = db.get_chat_binding("hermes:c:bind")
        assert binding["mirror_session_id"] == "mirror-1"
        assert binding["native_session_id"] == "sess-1"
        db.close()


# ---------------------------------------------------------------------------
# catalog
# ---------------------------------------------------------------------------


class TestCatalog:
    def test_catalog_get_and_cache(self, tmp_path: Path) -> None:
        cat = catalog.AgentCardCatalog(tmp_path / "catalog.db")
        mock_card = {"name": "Test", "version": "1.0"}
        with patch.object(
            catalog, "fetch_agent_card", return_value=mock_card
        ) as mock_fetch:
            card = cat.get("https://example.com", allowlist=frozenset({"example.com"}))
            assert card == mock_card
            mock_fetch.assert_called_once()
            # Second call should hit cache
            card2 = cat.get("https://example.com", allowlist=frozenset({"example.com"}))
            assert card2 == mock_card
            assert mock_fetch.call_count == 1
        cat.close()

    def test_catalog_force_refresh(self, tmp_path: Path) -> None:
        cat = catalog.AgentCardCatalog(tmp_path / "catalog.db")
        with patch.object(catalog, "fetch_agent_card", return_value={"name": "Test"}):
            cat.get("https://example.com", allowlist=frozenset({"example.com"}))
        with patch.object(catalog, "fetch_agent_card", return_value={"name": "Test2"}) as mock_fetch:
            card = cat.get("https://example.com", allowlist=frozenset({"example.com"}), force_refresh=True)
            assert card["name"] == "Test2"
            mock_fetch.assert_called_once()
        cat.close()

    def test_catalog_invalidate(self, tmp_path: Path) -> None:
        cat = catalog.AgentCardCatalog(tmp_path / "catalog.db")
        with patch.object(catalog, "fetch_agent_card", return_value={"name": "Test"}):
            cat.get("https://example.com", allowlist=frozenset({"example.com"}))
        assert cat.invalidate("https://example.com") is True
        assert cat.invalidate("https://example.com") is False
        cat.close()

    def test_catalog_eviction(self, tmp_path: Path) -> None:
        cat = catalog.AgentCardCatalog(tmp_path / "catalog.db")
        with patch.object(catalog, "fetch_agent_card", return_value={"name": "Test"}):
            for i in range(catalog._MAX_CACHED_CARDS + 5):
                cat.get(f"https://example{i}.com", allowlist=frozenset({f"example{i}.com"}))
        cached = cat.list_cached()
        assert len(cached) <= catalog._MAX_CACHED_CARDS
        cat.close()


# ---------------------------------------------------------------------------
# connectors
# ---------------------------------------------------------------------------


class TestConnectors:
    def test_connector_factory_a2a(self) -> None:
        conn = connectors.connector_factory(
            connector_type="a2a",
            name="Test",
            url="https://example.com",
        )
        assert isinstance(conn, connectors.A2AConnector)

    def test_connector_factory_unsupported_type(self) -> None:
        with pytest.raises(ValueError, match="unsupported"):
            connectors.connector_factory(connector_type="ws")

    def test_a2a_connector_repr(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        assert "A2AConnector" in repr(conn)

    def test_a2a_connector_requires_name_and_url(self) -> None:
        with pytest.raises(ValueError, match="required"):
            connectors.A2AConnector(name="", url="https://example.com")
        with pytest.raises(ValueError, match="required"):
            connectors.A2AConnector(name="Test", url="")

    def test_a2a_connector_timeout_bounds(self) -> None:
        with pytest.raises(ValueError, match="bound"):
            connectors.A2AConnector(name="Test", url="https://example.com", timeout=0)
        with pytest.raises(ValueError, match="bound"):
            connectors.A2AConnector(name="Test", url="https://example.com", timeout=2000)

    def test_a2a_connector_probe_no_jsonrpc(self) -> None:
        conn = connectors.A2AConnector(
            name="Test", url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        with patch.object(connectors, "fetch_agent_card", return_value={"name": "X"}):
            with pytest.raises(ValueError, match="JSON-RPC"):
                conn.probe()

    def test_a2a_connector_probe_success(self) -> None:
        conn = connectors.A2AConnector(
            name="Test", url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "protocolVersion": "1.0", "url": "https://example.com/rpc"}
            ],
            "capabilities": {"streaming": True},
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            result = conn.probe()
        assert result["verified"] is True
        assert result["native_agent_id"] == "Peer"
        assert result["protocol"] == "a2a-jsonrpc-1.0"
        assert result["features"]["streaming"] is True

    def test_a2a_connector_send_validation(self) -> None:
        conn = connectors.A2AConnector(
            name="Test", url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        with pytest.raises(ValueError, match="message is required"):
            conn.send("")

    def test_a2a_connector_unsupported_operation(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        result = conn.start_or_resume()
        assert result["supported"] is False
