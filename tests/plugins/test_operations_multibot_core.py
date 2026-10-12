from __future__ import annotations

import asyncio
import concurrent.futures
import importlib.util
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    name = "operations_multibot_api_test"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def agent_template(agent_id: str, *, name: str = "Review Bot") -> dict:
    return {
        "id": agent_id,
        "name": name,
        "handle": agent_id.replace(":", "-"),
        "description": "",
        "harness": "generic_a2a",
        "host_id": "agent.example.com",
        "host_label": "Public peer",
        "connector_url": "https://agent.example.com/rpc",
        "auth_env": "",
        "team_id": "",
    }


def test_authenticated_principal_ignores_forwarded_network_identity():
    api = load_api()

    class State:
        session = SimpleNamespace(
            provider="portal", user_id="owner-42", org_id="org-public", email="owner@example.com"
        )

    first = SimpleNamespace(
        state=State(),
        headers={"x-forwarded-for": "203.0.113.10"},
    )
    second = SimpleNamespace(
        state=State(),
        headers={"x-forwarded-for": "198.51.100.44"},
    )

    assert api._principal_hash_from_request(first) == api._principal_hash_from_request(second)
    assert len(api._principal_hash_from_request(first)) == 64


def test_registry_owner_policy_is_persisted_and_unknown_principals_fail_closed(tmp_path):
    from plugins.harness_agents.policy import ALL_CAPABILITIES
    from plugins.harness_agents.registry import HarnessRegistry

    database = tmp_path / "agents.db"
    owner = "a" * 64
    stranger = "b" * 64
    registry = HarnessRegistry(database)
    registry.provision_owner_principal(owner)

    assert registry.resolve_principal(owner)
    assert registry.capabilities_for(owner) == ALL_CAPABILITIES
    assert registry.is_owner_or_admin(owner)
    with pytest.raises(PermissionError, match="unknown or inactive principal"):
        registry.resolve_principal(stranger)
    assert not registry.is_owner_or_admin(stranger)
    registry.close()

    reopened = HarnessRegistry(database)
    assert reopened.is_owner_or_admin(owner)
    reopened.close()


def test_room_store_accepts_only_verified_bots_caps_members_and_replays_turns(tmp_path):
    from plugins.harness_agents.registry import HarnessRegistry
    from plugins.harness_agents.rooms import RoomStore

    registry = HarnessRegistry(tmp_path / "agents.db")
    for index in range(7):
        agent_id = f"a2a:bot-{index}"
        registry.create_agent(agent_template(agent_id, name=f"Bot {chr(65 + index)}"))
        if index < 6:
            registry.mark_verified(
                agent_id,
                native_agent_id=agent_id,
                native_session_id="",
                mirror_session_id=f"mirror-{index}",
                capabilities=["agent.view", "chat.send"],
                runtime_state="idle",
                supported_operations=["probe", "send"],
            )

    rooms = RoomStore(tmp_path / "rooms.db")
    room = rooms.create("Release room", created_by="owner")
    for index in range(6):
        rooms.add_member(room["id"], f"a2a:bot-{index}", registry=registry)

    with pytest.raises(ValueError, match="at most 6"):
        rooms.add_member(room["id"], "a2a:bot-6", registry=registry)

    first = rooms.begin_turn(
        room["id"],
        request_id="turn-1",
        agent_id="a2a:bot-0",
        message="Review the release.",
    )
    replay = rooms.begin_turn(
        room["id"],
        request_id="turn-1",
        agent_id="a2a:bot-0",
        message="Review the release.",
    )
    assert first["duplicate"] is False
    assert replay["duplicate"] is True

    completed = rooms.complete_turn(
        room["id"],
        request_id="turn-1",
        agent_id="a2a:bot-0",
        reply="Ready. [[handoff: a2a:bot-1]]",
    )
    repeated = rooms.complete_turn(
        room["id"],
        request_id="turn-1",
        agent_id="a2a:bot-0",
        reply="Ready. [[handoff: a2a:bot-1]]",
    )
    assert repeated == completed
    assert completed["floor"] == "a2a:bot-1"
    transcript = rooms.transcript(room["id"], 20)
    assert [entry["text"] for entry in transcript if entry["kind"] == "message"] == [
        "Review the release.",
        "Ready.",
    ]


def test_public_agent_dto_reports_unknown_without_fresh_evidence(tmp_path):
    api = load_api()
    from plugins.harness_agents.registry import HarnessRegistry

    registry = HarnessRegistry(tmp_path / "agents.db")
    registry.create_agent(agent_template("a2a:review"))
    pending = registry.get_agent("a2a:review")
    assert api._public_agent_summary(pending)["runtime_state"] == "unknown"

    verified = registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="native-1",
        mirror_session_id="mirror-1",
        capabilities=["agent.view", "chat.send", "run.interrupt"],
        runtime_state="working",
        supported_operations=["probe", "send", "get_state", "interrupt"],
    )
    summary = api._public_agent_summary(verified)
    assert summary["runtime_state"] == "working"
    assert summary["supported_operations"] == ["get_state", "interrupt", "probe", "send"]


def test_unadvertised_control_is_refused_before_connector_invocation(tmp_path, monkeypatch):
    api = load_api()
    from plugins.harness_agents.registry import HarnessRegistry

    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "agents.db")
    registry = HarnessRegistry(tmp_path / "agents.db")
    registry.create_agent(agent_template("a2a:review"))
    registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="native-1",
        mirror_session_id="mirror-1",
        capabilities=["agent.view", "chat.send"],
        runtime_state="idle",
        supported_operations=["probe", "send"],
    )
    owner_hash = api._principal_hash("session", "portal", "owner-1", "")
    registry.provision_owner_principal(owner_hash)
    registry.close()

    class SessionMiddleware:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] == "http":
                scope.setdefault("state", {})["session"] = SimpleNamespace(
                    provider="portal", user_id="owner-1", org_id="", email="owner@example.com"
                )
            await self.app(scope, receive, send)

    app = FastAPI()
    app.include_router(api.router)
    app.add_middleware(SessionMiddleware)

    async def invoke():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://operations.test"
        ) as client:
            return await client.post(
                "/agents/a2a/a2a%3Areview/interrupt", json={"confirm": True}
            )

    response = asyncio.run(invoke())
    assert response.status_code == 409
    assert response.json()["detail"] == "a2a_operation_not_advertised"


def test_advertised_controls_use_public_a2a_methods_not_private_gateway_rpc(monkeypatch):
    from plugins.harness_agents import connectors

    card = {
        "name": "Review Bot",
        "operations": ["start_or_resume", "steer", "interrupt", "get_state"],
        "supportedInterfaces": [
            {
                "protocolBinding": "JSONRPC",
                "protocolVersion": "1.0",
                "url": "https://agent.example.com/rpc",
            }
        ],
    }
    requests: list[dict] = []
    monkeypatch.setattr(connectors, "fetch_agent_card", lambda *_args, **_kwargs: card)

    def fetch_json(*_args, **kwargs):
        requests.append(kwargs["body"])
        return {"result": {"state": "working", "native_session_id": "task-1"}}

    monkeypatch.setattr(connectors, "fetch_json", fetch_json)
    connector = connectors.A2AConnector(
        name="Review Bot",
        url="https://agent.example.com/rpc",
        allowlist=frozenset({"agent.example.com"}),
    )
    connector.probe()
    connector.steer(message="Check the release.", native_session_id="task-1")
    connector.interrupt(native_session_id="task-1")

    assert [request["method"] for request in requests] == ["message/send", "tasks/cancel"]
    assert all(not request["method"].startswith("hermes/") for request in requests)


def test_owner_bootstrap_is_one_way_under_a_race(tmp_path):
    from plugins.harness_agents.registry import HarnessRegistry

    database = tmp_path / "agents.db"
    HarnessRegistry(database).close()
    barrier = threading.Barrier(2)

    def claim(principal: str) -> str:
        registry = HarnessRegistry(database)
        barrier.wait()
        try:
            registry.provision_owner_principal(principal)
            return "owner"
        except PermissionError:
            return "denied"
        finally:
            registry.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(claim, ("a" * 64, "b" * 64)))

    assert sorted(outcomes) == ["denied", "owner"]
    registry = HarnessRegistry(database)
    assert sum(registry.is_owner_or_admin(value) for value in ("a" * 64, "b" * 64)) == 1
    registry.close()


def test_non_owner_mutation_is_denied_and_audited(tmp_path, monkeypatch):
    api = load_api()
    from plugins.harness_agents.registry import HarnessRegistry

    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "agents.db")
    owner = api._principal_hash("session", "portal", "owner", "")
    operator = api._principal_hash("session", "portal", "operator", "")
    registry = HarnessRegistry(tmp_path / "agents.db")
    registry.provision_owner_principal(owner)
    with registry._connection:
        registry._connection.execute(
            "INSERT INTO principals (id, principal_hash, display_name) VALUES ('operator', ?, 'Operator')",
            (operator,),
        )
        registry._connection.execute(
            "INSERT INTO role_bindings (principal_id, team_id, agent_id, role) VALUES ('operator', '', '', 'operator')"
        )
    registry.close()

    request = SimpleNamespace(
        state=SimpleNamespace(
            session=SimpleNamespace(provider="portal", user_id="operator", org_id="", email="")
        )
    )
    with pytest.raises(HTTPException) as denied:
        api._authorized_registry(request, "chat.send")
    assert getattr(denied.value, "status_code", None) == 403

    registry = HarnessRegistry(tmp_path / "agents.db")
    events = registry.list_events("operations")
    assert events[-1]["outcome"] == "denied"
    assert events[-1]["detail"] == {"capability": "chat.send"}
    registry.close()


def test_durable_chat_retries_one_request_and_serializes_each_agent(tmp_path, monkeypatch):
    api = load_api()
    from plugins.harness_agents import connectors
    from plugins.harness_agents.registry import HarnessRegistry

    database = tmp_path / "agents.db"
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: database)
    registry = HarnessRegistry(database)
    registry.create_agent(agent_template("a2a:review"))
    registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="native-1",
        mirror_session_id="mirror-1",
        capabilities=["agent.view", "chat.send"],
        runtime_state="idle",
        supported_operations=["probe", "send"],
    )
    binding = registry.get_chat_binding("a2a:review")
    registry.prepare_chat_intent(
        "a2a:review",
        mirror_session_id=binding["mirror_session_id"],
        expected_native_session_id=binding["native_session_id"],
        request_id="lost-response",
        user_message="Continue safely.",
    )
    registry.close()

    calls: list[str] = []
    active = 0
    maximum_active = 0
    guard = threading.Lock()

    class FakeConnector:
        def __init__(self, **_kwargs):
            pass

        def send(self, message, *, native_session_id, request_id):
            nonlocal active, maximum_active
            with guard:
                active += 1
                maximum_active = max(maximum_active, active)
                calls.append(request_id)
            time.sleep(0.04)
            with guard:
                active -= 1
            return {
                "reply": f"Reply to {message}",
                "state": "completed",
                "native_session_id": f"{native_session_id}-next",
                "connector_event_id": request_id,
            }

    monkeypatch.setattr(connectors, "A2AConnector", FakeConnector)

    reopened = HarnessRegistry(database)
    first = api._send_with_registry(
        reopened,
        principal="a" * 64,
        agent_id="a2a:review",
        message="Continue safely.",
        request_id="lost-response",
    )
    reopened.close()
    replay_registry = HarnessRegistry(database)
    replay = api._send_with_registry(
        replay_registry,
        principal="a" * 64,
        agent_id="a2a:review",
        message="Continue safely.",
        request_id="lost-response",
    )
    replay_registry.close()
    assert replay["reply"] == first["reply"]
    assert replay["state"] == first["state"]
    assert replay["native_session_id"] == first["native_session_id"]
    assert first["duplicate"] is False
    assert replay["duplicate"] is True
    assert calls.count("lost-response") == 1

    def another_turn(request_id: str):
        worker_registry = HarnessRegistry(database)
        try:
            return api._send_with_registry(
                worker_registry,
                principal="a" * 64,
                agent_id="a2a:review",
                message=request_id,
                request_id=request_id,
            )
        finally:
            worker_registry.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(another_turn, ("parallel-1", "parallel-2")))
    assert maximum_active == 1
