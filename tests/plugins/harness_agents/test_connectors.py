"""Tests for harness_agents connectors: A2A probe, send, sanitization."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from plugins.harness_agents import connectors


class TestConnectorFactory:
    def test_factory_creates_a2a_connector(self) -> None:
        conn = connectors.connector_factory(
            connector_type="a2a", name="Test", url="https://example.com"
        )
        assert isinstance(conn, connectors.A2AConnector)

    def test_factory_rejects_unsupported_type(self) -> None:
        with pytest.raises(ValueError, match="unsupported"):
            connectors.connector_factory(connector_type="ws")


class TestA2AConnectorInit:
    def test_requires_name(self) -> None:
        with pytest.raises(ValueError, match="required"):
            connectors.A2AConnector(name="", url="https://example.com")

    def test_requires_url(self) -> None:
        with pytest.raises(ValueError, match="required"):
            connectors.A2AConnector(name="Test", url="")

    def test_timeout_lower_bound(self) -> None:
        with pytest.raises(ValueError, match="bound"):
            connectors.A2AConnector(name="Test", url="https://example.com", timeout=0)

    def test_timeout_upper_bound(self) -> None:
        with pytest.raises(ValueError, match="bound"):
            connectors.A2AConnector(
                name="Test", url="https://example.com", timeout=2000
            )

    def test_repr_contains_name(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        assert "A2AConnector" in repr(conn)
        assert "Test" in repr(conn)


class TestA2AConnectorProbe:
    def test_probe_success(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                    "url": "https://example.com/rpc",
                }
            ],
            "capabilities": {"streaming": True},
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            result = conn.probe()
        assert result["verified"] is True
        assert result["native_agent_id"] == "Peer"
        assert result["protocol"] == "a2a-jsonrpc-1.0"
        assert result["features"]["streaming"] is True
        assert result["operations"] == ["probe", "send"]

    def test_probe_rejects_non_jsonrpc(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        with patch.object(connectors, "fetch_agent_card", return_value={"name": "X"}):
            with pytest.raises(ValueError, match="JSON-RPC"):
                conn.probe()

    def test_probe_rejects_crossed_origin(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                    "url": "https://evil.com/rpc",
                }
            ],
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            with pytest.raises(ValueError, match="crossed its configured origin"):
                conn.probe()

    def test_probe_allows_subpath_origin(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                    "url": "https://example.com/v2/rpc",
                }
            ],
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            result = conn.probe()
        assert result["verified"] is True

    def test_probe_rejects_missing_name(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "   ",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                }
            ],
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            with pytest.raises(ValueError, match="no name"):
                conn.probe()

    def test_probe_extracts_skills(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                }
            ],
            "skills": [
                {"id": "skill-1", "name": "Skill One"},
                {"name": "Skill Two"},
                {"id": ""},
                "not-a-dict",
            ],
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            result = conn.probe()
        assert "skill-1" in result["skills"]
        assert "Skill Two" in result["skills"]


class TestA2AConnectorSend:
    def test_send_success(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        conn._verified_card = {
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "url": "https://example.com"}
            ]
        }
        conn._supported_operations = frozenset({"probe", "send"})
        response = {
            "result": {
                "artifacts": [{"type": "text", "text": "Hello back"}],
                "contextId": "ctx-1",
                "status": {"state": "TASK_STATE_WORKING"},
            }
        }
        with patch.object(connectors, "fetch_json", return_value=response):
            result = conn.send("Hello", native_session_id="sess-1")
        assert result["reply"] == "Hello back"
        assert result["native_session_id"] == "ctx-1"
        assert result["state"] == "working"

    def test_send_uses_fallback_status_message(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        conn._verified_card = {
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "url": "https://example.com"}
            ]
        }
        conn._supported_operations = frozenset({"probe", "send"})
        response = {
            "result": {
                "status": {"message": {"text": "Reply from status"}},
                "contextId": "",
            }
        }
        with patch.object(connectors, "fetch_json", return_value=response):
            result = conn.send("Hello")
        assert result["reply"] == "Reply from status"

    def test_send_returns_context_id_when_empty(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        conn._verified_card = {
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "url": "https://example.com"}
            ]
        }
        conn._supported_operations = frozenset({"probe", "send"})
        response = {"result": {"artifacts": []}}
        with patch.object(connectors, "fetch_json", return_value=response):
            result = conn.send("Hello", native_session_id="sess-1")
        assert result["native_session_id"] == "sess-1"

    def test_send_rejects_empty_message(self) -> None:
        conn = connectors.A2AConnector(
            name="Test", url="https://example.com"
        )
        with pytest.raises(ValueError, match="message is required"):
            conn.send("")

    def test_send_rejects_error_response(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        conn._verified_card = {
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "url": "https://example.com"}
            ]
        }
        conn._supported_operations = frozenset({"probe", "send"})
        with patch.object(
            connectors, "fetch_json", return_value={"error": {"message": "Oops"}}
        ):
            with pytest.raises(RuntimeError, match="send failed"):
                conn.send("Hello")


class TestA2AConnectorUnsupported:
    def test_unsupported_before_probe(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        result = conn.start_or_resume()
        assert result["supported"] is False
        result = conn.steer()
        assert result["supported"] is False
        result = conn.interrupt()
        assert result["supported"] is False
        result = conn.get_state()
        assert result["supported"] is False
        result = conn.get_messages()
        assert result["supported"] is False
        result = conn.list_models()
        assert result["supported"] is False
        result = conn.set_model()
        assert result["supported"] is False
        result = conn.close()
        assert result["supported"] is False

    def test_unsupported_after_probe(self) -> None:
        conn = connectors.A2AConnector(
            name="Test",
            url="https://example.com",
            allowlist=frozenset({"example.com"}),
        )
        card = {
            "name": "Peer",
            "supportedInterfaces": [
                {
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                }
            ],
        }
        with patch.object(connectors, "fetch_agent_card", return_value=card):
            conn.probe()
        result = conn.start_or_resume()
        assert result["supported"] is False
        assert result["reason"] == "unsupported_by_a2a_connector"


class TestSanitizeResult:
    def test_sanitize_string(self) -> None:
        result = connectors._sanitize_result("Bearer secret123")
        assert "[REDACTED]" in result

    def test_sanitize_list(self) -> None:
        result = connectors._sanitize_result(["Bearer secret123", "safe text"])
        assert "[REDACTED]" in result[0]
        assert "safe text" == result[1]

    def test_sanitize_dict_removes_secret_keys(self) -> None:
        result = connectors._sanitize_result({
            "name": "Test",
            "token": "secret",
            "apiKey": "secret",
            "nested": {"password": "secret", "safe": "keep"},
        })
        assert "name" in result
        assert "token" not in result
        assert "apiKey" not in result
        assert "nested" in result
        assert "password" not in result["nested"]
        assert "safe" in result["nested"]

    def test_sanitize_dict_skips_redacted_keys(self) -> None:
        result = connectors._sanitize_result({
            "name": "Test",
            "Bearer [REDACTED] token": "value",
        })
        assert "name" in result
        assert "Bearer [REDACTED] token" not in result

    def test_sanitize_preserves_primitives(self) -> None:
        assert connectors._sanitize_result(42) == 42
        assert connectors._sanitize_result(None) is None
        assert connectors._sanitize_result(True) is True


class TestA2AConnectorRpcUrl:
    def test_rpc_url_from_card_interface(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        conn._verified_card = {
            "supportedInterfaces": [
                {"protocolBinding": "JSONRPC", "url": "https://rpc.example.com"}
            ]
        }
        assert conn._rpc_url() == "https://rpc.example.com"

    def test_rpc_url_fallback_to_card_url(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        conn._verified_card = {"url": "https://card.example.com"}
        assert conn._rpc_url() == "https://card.example.com"

    def test_rpc_url_fallback_to_self(self) -> None:
        conn = connectors.A2AConnector(name="Test", url="https://example.com")
        assert conn._rpc_url() == "https://example.com"
