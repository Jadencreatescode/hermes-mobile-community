"""Tests for harness_agents registry: CRUD, locking, events, chat bindings."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from plugins.harness_agents import registry


class TestAgentLock:
    def test_acquire_and_release(self, tmp_path: Path) -> None:
        db_path = tmp_path / "agents.db"
        lock = registry.acquire_agent_operation_lock(db_path, "agent-1")
        assert lock is not None
        lock.release()

    def test_nonblocking_returns_none_when_busy(self, tmp_path: Path) -> None:
        db_path = tmp_path / "agents.db"
        lock1 = registry.acquire_agent_operation_lock(db_path, "agent-1", blocking=True)
        assert lock1 is not None
        lock2 = registry.acquire_agent_operation_lock(db_path, "agent-1", blocking=False)
        assert lock2 is None
        lock1.release()

    def test_rejects_empty_agent_id(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="agent id is required"):
            registry.acquire_agent_operation_lock(tmp_path / "agents.db", "")

    def test_rejects_null_in_agent_id(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="agent id is required"):
            registry.acquire_agent_operation_lock(tmp_path / "agents.db", "a\x00b")


class TestRegistryCreate:
    def test_create_minimal_agent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        agent = db.create_agent({
            "id": "a2a:test-1",
            "name": "Test Agent",
            "handle": "test-agent",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com/agent",
            "auth_env": "",
            "team_id": "",
        })
        assert agent["name"] == "Test Agent"
        assert agent["verification_state"] == "pending"
        assert agent["capabilities"] == []
        db.close()

    def test_create_with_optional_fields(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        agent = db.create_agent({
            "id": "a2a:test-2",
            "name": "Full Agent",
            "handle": "full-agent",
            "description": "A test",
            "harness": "hermes",
            "host_id": "h1",
            "host_label": "H1",
            "connector_url": "https://h1.example.com",
            "auth_env": "TOKEN",
            "team_id": "team-1",
            "instructions": "Be helpful.",
            "model": {"provider": "openai", "id": "gpt-4o"},
            "skills": ["chat", "search"],
            "tools": ["web_search"],
            "tags": ["beta"],
            "source_fingerprint": "abc123",
            "source_filename": "agent.json",
        })
        assert agent["instructions"] == "Be helpful."
        assert agent["model"] == {"provider": "openai", "id": "gpt-4o"}
        assert agent["skills"] == ["chat", "search"]
        assert agent["tools"] == ["web_search"]
        assert agent["tags"] == ["beta"]
        assert agent["source_fingerprint"] == "abc123"
        db.close()

    def test_create_agent_with_all_fields(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        agent = db.create_agent({
            "id": "a2a:full-1",
            "name": "Full Agent",
            "handle": "full-agent",
            "description": "A full agent",
            "harness": "hermes",
            "host_id": "host.example.com",
            "host_label": "Host Example",
            "connector_url": "https://host.example.com/agent",
            "auth_env": "API_KEY",
            "team_id": "team-1",
            "instructions": "Be helpful.",
            "model": {"provider": "openai", "id": "gpt-4o"},
            "skills": ["chat", "search"],
            "tools": ["web_search"],
            "tags": ["beta"],
            "source_fingerprint": "abc123",
            "source_filename": "agent.json",
        })
        assert agent["name"] == "Full Agent"
        assert agent["instructions"] == "Be helpful."
        assert agent["model"] == {"provider": "openai", "id": "gpt-4o"}
        assert agent["skills"] == ["chat", "search"]
        assert agent["tools"] == ["web_search"]
        assert agent["tags"] == ["beta"]
        assert agent["source_fingerprint"] == "abc123"
        db.close()


class TestRegistryRead:
    def test_get_existing_agent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:get-1",
            "name": "Get Agent",
            "handle": "get-agent",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        agent = db.get_agent("a2a:get-1")
        assert agent["name"] == "Get Agent"
        db.close()

    def test_get_missing_agent_raises(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        with pytest.raises(ValueError, match="unknown agent"):
            db.get_agent("a2a:missing")
        db.close()

    def test_list_agents_returns_all(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:list-a",
            "name": "A",
            "handle": "a",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.create_agent({
            "id": "a2a:list-b",
            "name": "B",
            "handle": "b",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        agents = db.list_agents()
        assert len(agents) == 2
        db.close()

    def test_list_verified_only_filters(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:ver-1",
            "name": "V1",
            "handle": "v1",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.create_agent({
            "id": "a2a:ver-2",
            "name": "V2",
            "handle": "v2",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "a2a:ver-1",
            native_agent_id="n1",
            native_session_id="s1",
            mirror_session_id="m1",
            capabilities=["agent.view"],
        )
        agents = db.list_agents(verified_only=True)
        assert len(agents) == 1
        assert agents[0]["id"] == "a2a:ver-1"
        db.close()


class TestRegistryUpdate:
    def test_mark_verified(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:mark-1",
            "name": "Mark",
            "handle": "mark",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        agent = db.mark_verified(
            "a2a:mark-1",
            native_agent_id="native-1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view", "chat.send"],
            runtime_state="working",
            work_summary="Testing",
            reasoning="test",
            supported_operations=["probe", "send"],
        )
        assert agent["verification_state"] == "verified"
        assert agent["native_agent_id"] == "native-1"
        assert agent["runtime_state"] == "working"
        assert agent["work_summary"] == "Testing"
        assert agent["reasoning"] == "test"
        assert agent["supported_operations"] == ["probe", "send"]
        db.close()

    def test_mark_verified_with_trusted_template(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:mark-2",
            "name": "Old",
            "handle": "old",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "old.com",
            "host_label": "old.com",
            "connector_url": "https://old.com",
            "auth_env": "",
            "team_id": "",
        })
        template = {
            "id": "a2a:mark-2",
            "name": "New",
            "handle": "new",
            "description": "Updated",
            "harness": "hermes",
            "host_id": "new.com",
            "host_label": "new.com",
            "connector_url": "https://new.com",
            "auth_env": "NEW",
            "team_id": "team-2",
        }
        agent = db.mark_verified(
            "a2a:mark-2",
            native_agent_id="n1",
            native_session_id="s1",
            mirror_session_id="m1",
            capabilities=["agent.view"],
            trusted_template=template,
        )
        assert agent["name"] == "New"
        assert agent["connector_url"] == "https://new.com"
        db.close()

    def test_mark_verified_rejects_mismatched_template(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:mark-3",
            "name": "M",
            "handle": "m",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="identity does not match"):
            db.mark_verified(
                "a2a:mark-3",
                native_agent_id="n1",
                native_session_id="s1",
                mirror_session_id="m1",
                capabilities=["agent.view"],
                trusted_template={"id": "a2a:other"},
            )
        db.close()

    def test_mark_verified_rejects_invalid_capability(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:mark-4",
            "name": "M",
            "handle": "m",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="invalid capability"):
            db.mark_verified(
                "a2a:mark-4",
                native_agent_id="n1",
                native_session_id="s1",
                mirror_session_id="m1",
                capabilities=["evil.hack"],
            )
        db.close()

    def test_mark_verified_rejects_invalid_operation(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:mark-5",
            "name": "M",
            "handle": "m",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="invalid operation"):
            db.mark_verified(
                "a2a:mark-5",
                native_agent_id="n1",
                native_session_id="s1",
                mirror_session_id="m1",
                capabilities=["agent.view"],
                supported_operations=["evil"],
            )
        db.close()

    def test_mark_degraded(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:deg-1",
            "name": "Deg",
            "handle": "deg",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "a2a:deg-1",
            native_agent_id="n1",
            native_session_id="s1",
            mirror_session_id="m1",
            capabilities=["agent.view"],
        )
        agent = db.mark_degraded("a2a:deg-1", error="probe timeout")
        assert agent["verification_state"] == "degraded"
        assert agent["verification_error"] == "probe timeout"
        assert agent["runtime_state"] == "offline"
        db.close()

    def test_mark_degraded_requires_error(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:deg-2",
            "name": "Deg",
            "handle": "deg",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="error is required"):
            db.mark_degraded("a2a:deg-2", error="")
        db.close()

    def test_delete_agent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:del-1",
            "name": "Del",
            "handle": "del",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        assert db.delete_agent("a2a:del-1") is True
        assert db.delete_agent("a2a:del-1") is False
        with pytest.raises(ValueError, match="unknown agent"):
            db.get_agent("a2a:del-1")
        db.close()

    def test_delete_requires_id(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        with pytest.raises(ValueError, match="agent id is required"):
            db.delete_agent("")
        db.close()


class TestRegistryEvents:
    def test_record_event(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-1",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        event = db.record_event(
            "a2a:evt-1",
            principal="tester",
            event_type="probe",
            outcome="succeeded",
            detail={"latency_ms": 42},
        )
        assert event["event_type"] == "probe"
        assert event["detail"]["latency_ms"] == 42
        assert event["id"] >= 1
        db.close()

    def test_list_events(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-2",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.record_event("a2a:evt-2", principal="a", event_type="probe", outcome="succeeded")
        db.record_event("a2a:evt-2", principal="b", event_type="send", outcome="succeeded")
        events = db.list_events("a2a:evt-2")
        assert len(events) == 2
        assert events[0]["principal"] == "a"
        assert events[1]["principal"] == "b"
        db.close()

    def test_list_events_respects_limit(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-3",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        for i in range(5):
            db.record_event("a2a:evt-3", principal=str(i), event_type="probe", outcome="succeeded")
        events = db.list_events("a2a:evt-3", limit=3)
        assert len(events) == 3
        db.close()

    def test_record_event_rejects_invalid_outcome(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-4",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="outcome is invalid"):
            db.record_event("a2a:evt-4", principal="x", event_type="probe", outcome="maybe")
        db.close()

    def test_record_event_rejects_invalid_event_type(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-5",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="event type is invalid"):
            db.record_event("a2a:evt-5", principal="x", event_type="bad type!", outcome="succeeded")
        db.close()

    def test_record_event_rejects_oversized_detail(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:evt-6",
            "name": "Evt",
            "handle": "evt",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        with pytest.raises(ValueError, match="too long"):
            db.record_event(
                "a2a:evt-6",
                principal="x",
                event_type="probe",
                outcome="succeeded",
                detail={"key": "v" * 3000},
            )
        db.close()


class TestRegistryChatBinding:
    def test_get_chat_binding(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:bind-1",
            "name": "Bind",
            "handle": "bind",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "a2a:bind-1",
            native_agent_id="n1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view"],
        )
        binding = db.get_chat_binding("a2a:bind-1")
        assert binding["mirror_session_id"] == "mirror-1"
        assert binding["native_session_id"] == "sess-1"
        db.close()

    def test_get_chat_binding_missing_raises(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        with pytest.raises(ValueError, match="unknown agent"):
            db.get_chat_binding("a2a:missing")
        db.close()

    def test_send_chat_turn(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-1",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "a2a:chat-1",
            native_agent_id="n1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view"],
        )
        result = db.send_chat_turn(
            "a2a:chat-1",
            connector_event_id="evt-1",
            user_message="Hello",
            assistant_reply="Hi there",
            native_session_id="sess-1",
        )
        assert result["status"] == "committed"
        history = db.get_chat_history("a2a:chat-1")
        assert len(history["messages"]) == 2
        assert history["messages"][0]["role"] == "user"
        db.close()

    def test_get_chat_history_empty(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-2",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.mark_verified(
            "a2a:chat-2",
            native_agent_id="n1",
            native_session_id="sess-1",
            mirror_session_id="mirror-1",
            capabilities=["agent.view"],
        )
        history = db.get_chat_history("a2a:chat-2")
        assert history["messages"] == []
        assert history["mirror_session_id"] == "mirror-1"
        db.close()

    def test_chat_request_status(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-3",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.prepare_chat_intent(
            "a2a:chat-3",
            mirror_session_id="m1",
            expected_native_session_id="s1",
            request_id="req-1",
            user_message="Hello",
        )
        assert db.chat_request_status("a2a:chat-3", "req-1") == "pending"
        assert db.chat_request_status("a2a:chat-3", "req-missing") == "unknown"
        db.close()

    def test_prepare_chat_intent_idempotent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-4",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.prepare_chat_intent(
            "a2a:chat-4",
            mirror_session_id="m1",
            expected_native_session_id="s1",
            request_id="req-1",
            user_message="Hello",
        )
        # Same request id with same content is idempotent
        db.prepare_chat_intent(
            "a2a:chat-4",
            mirror_session_id="m1",
            expected_native_session_id="s1",
            request_id="req-1",
            user_message="Hello",
        )
        with pytest.raises(ValueError, match="reused for another turn"):
            db.prepare_chat_intent(
                "a2a:chat-4",
                mirror_session_id="m1",
                expected_native_session_id="s1",
                request_id="req-1",
                user_message="Different",
            )
        db.close()

    def test_incomplete_chat_request_ids(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-5",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.prepare_chat_intent(
            "a2a:chat-5",
            mirror_session_id="m1",
            expected_native_session_id="s1",
            request_id="req-1",
            user_message="Hello",
        )
        ids = db.incomplete_chat_request_ids("a2a:chat-5")
        assert ids == ("req-1",)
        db.close()

    def test_discard_legacy_adapter_intent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:chat-6",
            "name": "Chat",
            "handle": "chat",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        db.prepare_chat_intent(
            "a2a:chat-6",
            mirror_session_id="m1",
            expected_native_session_id="s1",
            request_id="req-1",
            user_message="Hello",
        )
        db.discard_legacy_adapter_intent("req-1")
        assert db.chat_request_status("a2a:chat-6", "req-1") == "unknown"
        db.close()


class TestRegistrySchemaMigrations:
    def test_creates_schema_on_init(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        tables = db._connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        table_names = {row["name"] for row in tables}
        assert "connected_agents" in table_names
        assert "agent_connectors" in table_names
        assert "agent_chat_bindings" in table_names
        assert "agent_events" in table_names
        assert "agent_chat_commits" in table_names
        db.close()

    def test_trigger_updates_timestamp(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        db.create_agent({
            "id": "a2a:trig-1",
            "name": "Trig",
            "handle": "trig",
            "description": "",
            "harness": "generic_a2a",
            "host_id": "example.com",
            "host_label": "example.com",
            "connector_url": "https://example.com",
            "auth_env": "",
            "team_id": "",
        })
        before = db.get_agent("a2a:trig-1")["updated_at"]
        db._connection.execute(
            "UPDATE connected_agents SET description='changed' WHERE id='a2a:trig-1'"
        )
        after = db.get_agent("a2a:trig-1")["updated_at"]
        assert after != before
        db.close()
