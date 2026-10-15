from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
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


async def request_json(app: FastAPI, method: str, path: str, payload=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://operations.test"
    ) as client:
        return await client.request(method, path, json=payload)


def _room_turn_test_app(tmp_path, monkeypatch):
    from plugins.harness_agents.registry import HarnessRegistry
    from plugins.harness_agents.rooms import RoomStore

    api = load_api()
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    app = FastAPI()
    app.state.auth_required = False
    app.include_router(api.router)

    registry = HarnessRegistry(tmp_path / "operations" / "harness_agents.db")
    registry.create_agent(agent_template("a2a:review"))
    registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="ctx",
        mirror_session_id="mirror",
        capabilities=["agent.view", "chat.send"],
        supported_operations=["send"],
    )
    rooms = RoomStore(tmp_path / "operations" / "rooms.db")
    room = rooms.create("Idempotency", created_by="owner")
    rooms.add_member(room["id"], "a2a:review", registry=registry)
    rooms.hand_off(room["id"], "a2a:review")
    registry.close()
    return app, rooms, room["id"]


def _expected_room_dispatch_id(room_id: str, request_id: str) -> str:
    framed = bytearray(b"hermes.operations.room-turn.dispatch.v1\0")
    for value in (room_id, request_id):
        encoded = value.encode("utf-8")
        framed.extend(len(encoded).to_bytes(4, "big"))
        framed.extend(encoded)
    return f"room-turn-{hashlib.sha256(framed).hexdigest()}"


def _record_room_dispatches(monkeypatch, *, reply_prefix: str = "Reply to") -> list[str]:
    from plugins.harness_agents import connectors

    dispatches: list[str] = []

    class FakeConnector:
        def __init__(self, **_kwargs):
            pass

        def send(self, message, *, native_session_id, request_id):
            dispatches.append(request_id)
            return {
                "reply": f"{reply_prefix} {message}",
                "state": "completed",
                "native_session_id": native_session_id,
                "native_task_id": f"task-{len(dispatches)}",
                "connector_event_id": request_id,
            }

    monkeypatch.setattr(connectors, "A2AConnector", FakeConnector)
    return dispatches

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


def test_loopback_owner_identity_survives_dashboard_token_rotation(
    tmp_path, monkeypatch
):
    api = load_api()
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)

    def request(token: str):
        return SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(auth_required=False)),
            state=SimpleNamespace(
                session=SimpleNamespace(provider="ignored", user_id=token, org_id="")
            ),
            headers={"x-hermes-session-token": token},
        )

    assert api._principal_hash_from_request(
        request("first-process-token")
    ) == api._principal_hash_from_request(request("rotated-after-restart"))
    identity = tmp_path / "operations" / "installation-owner.key"
    assert identity.exists()
    assert identity.stat().st_mode & 0o077 == 0

def test_rotating_dashboard_token_cannot_become_identity_without_explicit_local_mode():
    api = load_api()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace()),
        state=SimpleNamespace(),
        headers={"x-hermes-session-token": "rotating-token"},
    )

    with pytest.raises(HTTPException) as denied:
        api._principal_hash_from_request(request)
    assert denied.value.status_code == 401

def test_remote_first_authenticated_caller_cannot_claim_owner(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "agents.db")
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(auth_required=True)),
        state=SimpleNamespace(
            session=SimpleNamespace(
                provider="portal", user_id="first-caller", org_id="", email=""
            )
        ),
        headers={},
    )

    with pytest.raises(HTTPException) as denied:
        api._authorized_registry(request, "agent.view")

    assert denied.value.status_code == 403
    assert denied.value.detail == "operations_owner_setup_required"
    request.app.state = SimpleNamespace()
    with pytest.raises(HTTPException) as misconfigured:
        api._authorized_registry(request, "agent.view")
    assert misconfigured.value.status_code == 403
    assert misconfigured.value.detail == "operations_owner_setup_required"

def test_remote_owner_requires_matching_durable_authenticated_assertion(
    tmp_path, monkeypatch
):
    api = load_api()
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "agents.db")
    monkeypatch.setenv(
        "HERMES_OPERATIONS_OWNER", '["session","portal","configured-owner","org-1"]'
    )

    def request(user_id: str):
        return SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(auth_required=True)),
            state=SimpleNamespace(
                session=SimpleNamespace(
                    provider="portal", user_id=user_id, org_id="org-1"
                )
            ),
            headers={},
        )

    _principal, registry = api._authorized_registry(
        request("configured-owner"), "agent.view"
    )
    registry.close()
    with pytest.raises(HTTPException) as denied:
        api._authorized_registry(request("later-attacker"), "agent.view")
    assert denied.value.status_code == 403

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

    rooms.hand_off(room["id"], "a2a:bot-0")
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


def test_room_member_capacity_is_atomic_under_race(tmp_path):
    from plugins.harness_agents.rooms import RoomStore

    class VerifiedRegistry:
        @staticmethod
        def get_agent(_agent_id):
            return {"verification_state": "verified"}

    database = tmp_path / "rooms.db"
    rooms = RoomStore(database)
    room = rooms.create("Capacity race", created_by="owner")
    registry = VerifiedRegistry()
    for index in range(5):
        rooms.add_member(room["id"], f"a2a:existing-{index}", registry=registry)

    pre_transaction_reads = threading.Barrier(2)

    def add(candidate: str) -> str:
        store = RoomStore(database)
        original_get = store.get
        synchronized = False

        def synchronized_get(room_id):
            nonlocal synchronized
            result = original_get(room_id)
            if not synchronized:
                synchronized = True
                pre_transaction_reads.wait()
            return result

        store.get = synchronized_get  # type: ignore[method-assign]
        try:
            store.add_member(room["id"], candidate, registry=registry)
            return "added"
        except ValueError as error:
            assert "at most 6" in str(error)
            return "full"

    candidates = ("a2a:candidate-a", "a2a:candidate-b")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(add, candidates))

    members = RoomStore(database).members(room["id"])
    assert sorted(outcomes) == ["added", "full"]
    assert len(members) == 6
    assert len(set(candidates) & set(members)) == 1


@pytest.mark.parametrize("first_writer", ["remove", "handoff"])
def test_room_remove_and_handoff_preserve_live_floor_under_race(tmp_path, first_writer):
    from plugins.harness_agents.rooms import RoomStore

    class VerifiedRegistry:
        @staticmethod
        def get_agent(_agent_id):
            return {"verification_state": "verified"}

    database = tmp_path / f"rooms-{first_writer}.db"
    rooms = RoomStore(database)
    room = rooms.create("Floor race", created_by="owner")
    target = "a2a:target"
    rooms.add_member(room["id"], target, registry=VerifiedRegistry())

    stale_read_complete = threading.Event()
    allow_transaction = threading.Event()

    def pause_after_first_get(store):
        original_get = store.get
        synchronized = False

        def synchronized_get(room_id):
            nonlocal synchronized
            result = original_get(room_id)
            if not synchronized:
                synchronized = True
                stale_read_complete.set()
                assert allow_transaction.wait(timeout=5)
            return result

        store.get = synchronized_get  # type: ignore[method-assign]

    def handoff_after_stale_read() -> str:
        store = RoomStore(database)
        pause_after_first_get(store)
        try:
            store.hand_off(room["id"], target)
            return "handed"
        except PermissionError:
            return "denied"

    def remove_after_stale_read() -> str:
        store = RoomStore(database)
        pause_after_first_get(store)
        store.remove_member(room["id"], target)
        return "removed"

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        if first_writer == "remove":
            future = pool.submit(handoff_after_stale_read)
            assert stale_read_complete.wait(timeout=5)
            RoomStore(database).remove_member(room["id"], target)
        else:
            future = pool.submit(remove_after_stale_read)
            assert stale_read_complete.wait(timeout=5)
            RoomStore(database).hand_off(room["id"], target)
        allow_transaction.set()
        future.result(timeout=5)

    final = RoomStore(database).get(room["id"])
    assert target not in final["members"]
    assert final["floor"] == "owner"


def test_room_reply_handoff_revalidates_target_under_remove_race(tmp_path):
    from plugins.harness_agents.rooms import RoomStore

    class VerifiedRegistry:
        @staticmethod
        def get_agent(_agent_id):
            return {"verification_state": "verified"}

    database = tmp_path / "reply-handoff-race.db"
    rooms = RoomStore(database)
    room = rooms.create("Reply floor race", created_by="owner")
    speaker = "a2a:speaker"
    target = "a2a:target"
    for agent_id in (speaker, target):
        rooms.add_member(room["id"], agent_id, registry=VerifiedRegistry())
    rooms.hand_off(room["id"], speaker)
    rooms.begin_turn(
        room["id"], request_id="turn", agent_id=speaker, message="Review"
    )

    stale_read_complete = threading.Event()
    allow_transaction = threading.Event()

    def complete_after_stale_read():
        store = RoomStore(database)
        original_get = store.get
        synchronized = False

        def synchronized_get(room_id):
            nonlocal synchronized
            result = original_get(room_id)
            if not synchronized:
                synchronized = True
                stale_read_complete.set()
                assert allow_transaction.wait(timeout=5)
            return result

        store.get = synchronized_get  # type: ignore[method-assign]
        return store.complete_turn(
            room["id"],
            request_id="turn",
            agent_id=speaker,
            reply=f"Done. [[handoff: {target}]]",
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(complete_after_stale_read)
        assert stale_read_complete.wait(timeout=5)
        RoomStore(database).remove_member(room["id"], target)
        allow_transaction.set()
        completed = future.result(timeout=5)

    final = RoomStore(database).get(room["id"])
    assert completed["floor"] == speaker
    assert target not in final["members"]
    assert final["floor"] == speaker


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


def test_advertised_controls_use_public_a2a_methods_not_private_gateway_rpc(
    monkeypatch,
):
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
        method = kwargs["body"]["method"]
        if method == "SendMessage":
            return {
                "result": {
                    "task": {
                        "id": "task-1",
                        "contextId": "ctx-1",
                        "status": {"state": "TASK_STATE_WORKING"},
                    }
                }
            }
        state = "TASK_STATE_WORKING" if method == "GetTask" else "TASK_STATE_CANCELED"
        return {
            "result": {
                "id": "task-1",
                "contextId": "ctx-1",
                "status": {"state": state},
            }
        }

    monkeypatch.setattr(connectors, "fetch_json", fetch_json)
    connector = connectors.A2AConnector(
        name="Review Bot",
        url="https://agent.example.com/rpc",
        allowlist=frozenset({"agent.example.com"}),
    )
    connector.probe()
    steered = connector.steer(message="Check the release.", native_session_id="ctx-1")
    observed = connector.get_state(native_task_id=steered["native_task_id"])
    interrupted = connector.interrupt(native_task_id=steered["native_task_id"])

    assert [request["method"] for request in requests] == [
        "SendMessage",
        "GetTask",
        "CancelTask",
    ]
    assert all(not request["method"].startswith("hermes/") for request in requests)
    message = requests[0]["params"]["message"]
    assert message["role"] == "ROLE_USER"
    assert message["contextId"] == "ctx-1"
    assert message["parts"] == [
        {"text": "Check the release.", "mediaType": "text/plain"}
    ]
    assert requests[1]["params"] == {"taskId": "task-1"}
    assert requests[2]["params"] == {"taskId": "task-1"}
    assert observed["state"] == "working"
    assert interrupted["state"] == "idle"


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
                "native_task_id": f"task-{request_id}",
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
    assert reopened.get_chat_binding("a2a:review") == {
        "agent_id": "a2a:review",
        "mirror_session_id": "mirror-1",
        "native_session_id": "native-1-next",
        "native_task_id": "task-lost-response",
    }
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


@pytest.mark.parametrize("request_id", ["normal-turn", "x" * 256])
def test_room_turn_uses_bounded_dispatch_id_and_replays_committed_response(
    tmp_path, monkeypatch, request_id
):
    app, _rooms, room_id = _room_turn_test_app(tmp_path, monkeypatch)
    dispatches = _record_room_dispatches(monkeypatch)
    payload = {
        "agent_id": "a2a:review",
        "message": "Check the release.",
        "request_id": request_id,
    }

    first = asyncio.run(request_json(app, "POST", f"/rooms/{room_id}/turns", payload))
    replay = asyncio.run(request_json(app, "POST", f"/rooms/{room_id}/turns", payload))

    assert first.status_code == 200
    assert replay.status_code == 200
    assert first.json()["request_id"] == request_id
    assert first.json()["status"] == "committed"
    assert replay.json()["request_id"] == request_id
    assert replay.json()["status"] == "committed"
    assert replay.json()["reply"] == first.json()["reply"]
    assert replay.json()["floor"] == first.json()["floor"]
    assert dispatches == [_expected_room_dispatch_id(room_id, request_id)]
    assert len(dispatches[0]) < 256


def test_room_turn_repairs_pending_maximum_length_request_after_boundary_failure(
    tmp_path, monkeypatch
):
    app, rooms, room_id = _room_turn_test_app(tmp_path, monkeypatch)
    request_id = "p" * 256
    # Reproduce the old failure boundary: the room pending write committed,
    # then the oversized composed registry identifier was rejected.
    pending = rooms.begin_turn(
        room_id,
        request_id=request_id,
        agent_id="a2a:review",
        message="Repair the pending boundary.",
    )
    assert pending["status"] == "pending"
    dispatches = _record_room_dispatches(monkeypatch, reply_prefix="Repaired:")

    response = asyncio.run(
        request_json(
            app,
            "POST",
            f"/rooms/{room_id}/turns",
            {
                "agent_id": "a2a:review",
                "message": "Repair the pending boundary.",
                "request_id": request_id,
            },
        )
    )

    assert response.status_code == 200
    assert response.json()["status"] == "committed"
    assert response.json()["request_id"] == request_id
    assert dispatches == [_expected_room_dispatch_id(room_id, request_id)]


def test_room_turn_dispatch_digest_does_not_truncate_colliding_prefixes(
    tmp_path, monkeypatch
):
    app, _rooms, room_id = _room_turn_test_app(tmp_path, monkeypatch)
    request_ids = ("z" * 255 + "a", "z" * 255 + "b")
    dispatches = _record_room_dispatches(monkeypatch)

    for index, request_id in enumerate(request_ids):
        response = asyncio.run(
            request_json(
                app,
                "POST",
                f"/rooms/{room_id}/turns",
                {
                    "agent_id": "a2a:review",
                    "message": f"Message {index}",
                    "request_id": request_id,
                },
            )
        )
        assert response.status_code == 200

    assert dispatches == [
        _expected_room_dispatch_id(room_id, request_id) for request_id in request_ids
    ]
    assert dispatches[0] != dispatches[1]


def test_room_floor_is_enforced_and_owner_can_take_it_back(tmp_path):
    from plugins.harness_agents.registry import HarnessRegistry
    from plugins.harness_agents.rooms import RoomStore

    registry = HarnessRegistry(tmp_path / "agents.db")
    for agent_id in ("a2a:first", "a2a:second"):
        registry.create_agent(
            agent_template(agent_id, name=agent_id.split(":")[1].title())
        )
        registry.mark_verified(
            agent_id,
            native_agent_id=agent_id,
            native_session_id="ctx",
            mirror_session_id=f"mirror-{agent_id}",
            capabilities=["agent.view", "chat.send"],
            supported_operations=["probe", "send"],
        )
    rooms = RoomStore(tmp_path / "rooms.db")
    room = rooms.create("Authority", created_by="a" * 64)
    rooms.add_member(room["id"], "a2a:first", registry=registry)
    rooms.add_member(room["id"], "a2a:second", registry=registry)

    stored = rooms.post(room["id"], "Bearer secret123", request_id="redacted-owner")
    assert "secret123" not in stored["text"]
    assert "payload_digest" not in stored
    with pytest.raises(ValueError, match="reused"):
        rooms.post(room["id"], "Bearer secret456", request_id="redacted-owner")

    with pytest.raises(PermissionError, match="floor"):
        rooms.begin_turn(
            room["id"], request_id="bypass", agent_id="a2a:first", message="bypass"
        )
    rooms.hand_off(room["id"], "a2a:first")
    rooms.begin_turn(
        room["id"],
        request_id="redacted-turn",
        agent_id="a2a:first",
        message="Bearer secret123",
    )
    with pytest.raises(ValueError, match="reused"):
        rooms.begin_turn(
            room["id"],
            request_id="redacted-turn",
            agent_id="a2a:first",
            message="Bearer secret456",
        )
    with pytest.raises(PermissionError, match="floor"):
        rooms.post(room["id"], "owner bypass")
    with pytest.raises(PermissionError, match="floor"):
        rooms.begin_turn(
            room["id"], request_id="wrong-bot", agent_id="a2a:second", message="bypass"
        )
    returned = rooms.complete_turn(
        room["id"],
        request_id="redacted-turn",
        agent_id="a2a:first",
        reply="Done. [[handoff: owner]]",
    )
    assert returned["floor"] == "owner"
    transcript = rooms.transcript(room["id"], 50)
    assert any(
        row["kind"] == "handoff" and "handed the floor to owner" in row["text"]
        for row in transcript
    )
    assert all("a" * 64 not in row["text"] for row in transcript)
    assert "created_by" not in rooms.get(room["id"])
    registry.close()

def test_room_request_id_is_atomic_under_race(tmp_path):
    from plugins.harness_agents.rooms import RoomStore

    database = tmp_path / "rooms.db"
    room = RoomStore(database).create("Race", created_by="owner")
    barrier = threading.Barrier(2)

    def post(text: str) -> str:
        store = RoomStore(database)
        barrier.wait()
        try:
            return str(store.post(room["id"], text, request_id="same-request")["text"])
        except ValueError:
            return "conflict"

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(post, ("one", "two")))

    assert outcomes.count("conflict") == 1
    assert len(RoomStore(database).transcript(room["id"], 50)) == 1

def test_room_pending_transition_rolls_back_when_transcript_write_fails(
    tmp_path, monkeypatch
):
    from plugins.harness_agents.registry import HarnessRegistry
    from plugins.harness_agents.rooms import RoomStore

    registry = HarnessRegistry(tmp_path / "agents.db")
    registry.create_agent(agent_template("a2a:review"))
    registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="ctx",
        mirror_session_id="mirror",
        capabilities=["chat.send"],
        supported_operations=["send"],
    )
    rooms = RoomStore(tmp_path / "rooms.db")
    room = rooms.create("Recovery", created_by="owner")
    rooms.add_member(room["id"], "a2a:review", registry=registry)
    rooms.hand_off(room["id"], "a2a:review")
    original = rooms._insert_message

    def fail_once(*args, **kwargs):
        monkeypatch.setattr(rooms, "_insert_message", original)
        raise RuntimeError("injected transcript failure")

    monkeypatch.setattr(rooms, "_insert_message", fail_once)
    with pytest.raises(RuntimeError, match="injected"):
        rooms.begin_turn(
            room["id"],
            request_id="recoverable",
            agent_id="a2a:review",
            message="Review",
        )

    retried = rooms.begin_turn(
        room["id"], request_id="recoverable", agent_id="a2a:review", message="Review"
    )
    assert retried["status"] == "pending"
    assert retried["duplicate"] is False
    registry.close()

def test_room_rest_endpoints_cannot_bypass_floor_authority(tmp_path, monkeypatch):
    from plugins.harness_agents.registry import HarnessRegistry

    api = load_api()
    monkeypatch.setattr(api, "get_hermes_home", lambda: tmp_path)
    app = FastAPI()
    app.state.auth_required = False
    app.include_router(api.router)
    registry = HarnessRegistry(tmp_path / "operations" / "harness_agents.db")
    for agent_id in ("a2a:first", "a2a:second"):
        registry.create_agent(agent_template(agent_id))
        registry.mark_verified(
            agent_id,
            native_agent_id=agent_id,
            native_session_id="ctx",
            mirror_session_id=f"mirror-{agent_id}",
            capabilities=["agent.view", "chat.send"],
            supported_operations=["send"],
        )
    registry.close()

    created = asyncio.run(
        request_json(app, "POST", "/rooms", {"name": "REST authority", "confirm": True})
    )
    assert created.status_code == 200
    room_id = created.json()["room"]["id"]
    for agent_id in ("a2a:first", "a2a:second"):
        response = asyncio.run(
            request_json(
                app,
                "POST",
                f"/rooms/{room_id}/members/{agent_id}",
                {"confirm": True},
            )
        )
        assert response.status_code == 200
    assert (
        asyncio.run(
            request_json(
                app,
                "POST",
                f"/rooms/{room_id}/handoff",
                {"agent_id": "a2a:first", "confirm": True},
            )
        ).status_code
        == 200
    )

    owner_bypass = asyncio.run(
        request_json(app, "POST", f"/rooms/{room_id}/messages", {"message": "bypass"})
    )
    wrong_bot = asyncio.run(
        request_json(
            app,
            "POST",
            f"/rooms/{room_id}/turns",
            {"agent_id": "a2a:second", "message": "bypass", "request_id": "wrong"},
        )
    )
    assert owner_bypass.status_code == 403
    assert wrong_bot.status_code == 403
    returned = asyncio.run(
        request_json(
            app,
            "POST",
            f"/rooms/{room_id}/handoff",
            {"agent_id": "owner", "confirm": True},
        )
    )
    assert returned.status_code == 200
    assert returned.json()["floor"] == "owner"

def test_registry_and_catalog_connections_close_on_endpoint_failures(monkeypatch):
    api = load_api()

    class FailingRegistry:
        closed = False

        def list_agents(self):
            raise RuntimeError("injected registry failure")

        def close(self):
            self.closed = True

    registry = FailingRegistry()
    monkeypatch.setattr(api, "_user_id_from_request", lambda _request: "owner")
    monkeypatch.setattr(api._a2a_rate_limiter, "allow", lambda _principal: True)
    monkeypatch.setattr(
        api, "_authorized_registry", lambda *_args, **_kwargs: ("owner", registry)
    )
    with pytest.raises(RuntimeError, match="injected registry failure"):
        api.list_a2a_agents(SimpleNamespace(), limit=10)
    assert registry.closed is True

    from plugins.harness_agents import catalog as catalog_module
    from plugins.harness_agents import policy

    class FailingCatalog:
        instance = None

        def __init__(self, _path):
            self.closed = False
            FailingCatalog.instance = self

        def get(self, _url, *, allowlist=None):
            raise ValueError("injected catalog failure")

        def close(self):
            self.closed = True

    monkeypatch.setattr(catalog_module, "AgentCardCatalog", FailingCatalog)
    monkeypatch.setattr(
        policy,
        "validate_url",
        lambda *_args, **_kwargs: ("https", "agent.example.com", 443),
    )
    with pytest.raises(HTTPException) as rejected:
        api._register_a2a_agent_with_registry(
            api.A2ARegisterRequest(url="https://agent.example.com/card", confirm=False),
            "owner",
            SimpleNamespace(),
        )
    assert rejected.value.status_code == 400
    assert FailingCatalog.instance is not None
    assert FailingCatalog.instance.closed is True

def test_pending_chat_history_returns_original_durable_message_for_safe_retry(tmp_path):
    from plugins.harness_agents.registry import HarnessRegistry

    registry = HarnessRegistry(tmp_path / "agents.db")
    registry.create_agent(agent_template("a2a:review"))
    registry.mark_verified(
        "a2a:review",
        native_agent_id="review",
        native_session_id="ctx-1",
        mirror_session_id="mirror-1",
        capabilities=["agent.view", "chat.send"],
        supported_operations=["probe", "send"],
    )
    registry.prepare_chat_intent(
        "a2a:review",
        mirror_session_id="mirror-1",
        expected_native_session_id="ctx-1",
        request_id="reload-me",
        user_message="Retry exactly this text.",
    )

    history = registry.get_chat_history("a2a:review", request_id="reload-me")
    assert history["request_status"] == "pending"
    assert history["pending_message"] == "Retry exactly this text."

    registry.prepare_chat_intent(
        "a2a:review",
        mirror_session_id="mirror-1",
        expected_native_session_id="ctx-1",
        request_id="redacted-reload",
        user_message="Bearer secret123",
    )
    redacted = registry.get_chat_history("a2a:review", request_id="redacted-reload")
    assert "secret123" not in redacted["pending_message"]
    registry.prepare_chat_intent(
        "a2a:review",
        mirror_session_id="mirror-1",
        expected_native_session_id="ctx-1",
        request_id="redacted-reload",
        user_message=redacted["pending_message"],
    )
    with pytest.raises(ValueError, match="reused"):
        registry.prepare_chat_intent(
            "a2a:review",
            mirror_session_id="mirror-1",
            expected_native_session_id="ctx-1",
            request_id="redacted-reload",
            user_message="Bearer secret456",
        )
    registry.close()
