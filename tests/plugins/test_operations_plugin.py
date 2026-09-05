import asyncio
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_store():
    module_path = DASHBOARD / "mailroom_store.py"
    spec = importlib.util.spec_from_file_location("operations_mailroom_store_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("operations_plugin_api_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_meeting_store():
    module_path = DASHBOARD / "meeting_store.py"
    spec = importlib.util.spec_from_file_location("operations_meeting_store_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def request_json(app: FastAPI, method: str, path: str, payload=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://operations.test"
    ) as client:
        return await client.request(method, path, json=payload)


def test_manifest_mounts_mailroom_in_authenticated_plugin_namespace():
    manifest = json.loads((DASHBOARD / "manifest.json").read_text(encoding="utf-8"))

    assert manifest == {
        "name": "operations",
        "label": "Operations",
        "description": "Durable public coordination for Hermes Bots",
        "icon": "ServerCog",
        "version": "1.0.0",
        "api": "plugin_api.py",
    }
    assert (DASHBOARD / manifest["api"]).is_file()


def test_store_persists_bounded_envelope_with_append_only_history(tmp_path):
    api = load_store()
    db_path = tmp_path / "mailroom.db"
    store = api.MailroomStore(db_path, clock=lambda: 1_800_000_000)

    created = store.create_envelope(
        source_profile="planner",
        target_profile="builder",
        body="Please review work item 42.",
        urgency="normal",
        session_ref="session_42",
        dedupe_key="review-42",
    )

    assert set(created) == {
        "id",
        "source_profile",
        "target_profile",
        "body",
        "urgency",
        "status",
        "created_at",
        "updated_at",
        "session_ref",
        "dedupe_key",
        "duplicate",
        "history",
    }
    assert created["id"].startswith("mail_")
    assert len(created["id"]) <= api.MAX_ID_CHARS
    assert created["status"] == "queued"
    assert created["duplicate"] is False
    assert created["history"] == [
        {"sequence": 1, "status": "queued", "at": 1_800_000_000}
    ]
    assert api.MailroomStore(db_path, clock=lambda: 1_800_000_001).get_envelope(
        created["id"]
    ) == {**created, "duplicate": False}

    with pytest.raises(ValueError, match="body"):
        store.create_envelope(
            source_profile="planner",
            target_profile="builder",
            body="x" * (api.MAX_BODY_CHARS + 1),
        )

    with sqlite3.connect(db_path) as connection:
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("DELETE FROM mailroom_events")


def test_duplicate_key_is_idempotent_but_cannot_alias_changed_mail(tmp_path):
    api = load_store()
    store = api.MailroomStore(tmp_path / "mailroom.db", clock=lambda: 1_800_000_000)
    request = {
        "source_profile": "planner",
        "target_profile": "builder",
        "body": "Review the release candidate.",
        "urgency": "priority",
        "dedupe_key": "release-review-7",
    }

    first = store.create_envelope(**request)
    duplicate = store.create_envelope(**request)

    assert duplicate["id"] == first["id"]
    assert duplicate["duplicate"] is True
    assert duplicate["history"] == first["history"]
    with pytest.raises(api.DuplicateKeyConflict):
        store.create_envelope(**{**request, "body": "Changed request."})


def test_queued_mail_is_bounded_and_priority_only_changes_queue_order(tmp_path):
    api = load_store()
    ticks = iter([1_800_000_000, 1_800_000_001, 1_800_000_002])
    store = api.MailroomStore(tmp_path / "mailroom.db", clock=lambda: next(ticks))

    first_normal = store.create_envelope(
        source_profile="planner", target_profile="builder", body="normal one"
    )
    priority = store.create_envelope(
        source_profile="planner",
        target_profile="builder",
        body="priority",
        urgency="priority",
    )
    second_normal = store.create_envelope(
        source_profile="planner", target_profile="builder", body="normal two"
    )

    queued = store.list_envelopes(status="queued", limit=3)

    assert [row["id"] for row in queued] == [
        priority["id"],
        first_normal["id"],
        second_normal["id"],
    ]
    assert all(row["status"] == "queued" for row in queued)
    with pytest.raises(ValueError, match="limit"):
        store.list_envelopes(limit=api.MAX_LIST_LIMIT + 1)


def test_critical_requires_exact_unexpired_bounded_policy_and_audits_decisions(tmp_path, monkeypatch):
    api = load_store()
    now = [1_800_000_000]
    store = api.MailroomStore(tmp_path / "mailroom.db", clock=lambda: now[0])

    request = {
        "source_profile": "planner",
        "target_profile": "builder",
        "body": "Please checkpoint when it is safe.",
        "urgency": "critical",
    }
    with pytest.raises(api.CriticalPolicyDenied):
        store.create_envelope(**request)

    policy = store.set_critical_policy(
        source_profile="planner",
        target_profile="builder",
        expires_at=now[0] + 60,
    )
    assert policy == {
        "source_profile": "planner",
        "target_profile": "builder",
        "expires_at": now[0] + 60,
        "created_at": now[0],
    }
    critical = store.create_envelope(**request)
    assert critical["urgency"] == "critical"
    store.record_delivery(critical["id"], delivered=False)

    with pytest.raises(api.CriticalPolicyDenied):
        store.create_envelope(**{**request, "target_profile": "reviewer"})
    now[0] += 61
    with pytest.raises(api.CriticalPolicyDenied):
        store.retry(critical["id"])
    with pytest.raises(api.CriticalPolicyDenied):
        store.create_envelope(**{**request, "dedupe_key": "after-expiry"})
    with pytest.raises(ValueError, match="expiration"):
        store.set_critical_policy(
            source_profile="planner",
            target_profile="builder",
            expires_at=now[0] + api.MAX_POLICY_TTL_SECONDS + 1,
        )

    decisions = store.list_policy_decisions(limit=10)
    assert [(row["decision"], row["reason"]) for row in decisions] == [
        ("denied", "missing"),
        ("allowed", "matched"),
        ("denied", "missing"),
        ("denied", "expired"),
        ("denied", "expired"),
    ]
    assert all(set(row) == {"source_profile", "target_profile", "decision", "reason", "at"} for row in decisions)

    api_module = load_api()
    monkeypatch.setattr(api_module, "_db_path", lambda: tmp_path / "mailroom.db")
    app = FastAPI()
    app.include_router(api_module.router)
    response = asyncio.run(request_json(app, "GET", "/mailroom/policy-decisions?limit=10"))
    assert response.status_code == 200
    assert [(row["decision"], row["reason"]) for row in response.json()["decisions"]] == [
        ("denied", "missing"),
        ("allowed", "matched"),
        ("denied", "missing"),
        ("denied", "expired"),
        ("denied", "expired"),
    ]


def test_critical_retry_revalidates_exact_live_policy_without_changing_failed_state(tmp_path):
    api = load_store()
    now = [1_800_000_000]
    db_path = tmp_path / "mailroom.db"
    store = api.MailroomStore(db_path, clock=lambda: now[0])
    store.set_critical_policy(
        source_profile="planner",
        target_profile="builder",
        expires_at=now[0] + 60,
    )
    envelope = store.create_envelope(
        source_profile="planner",
        target_profile="builder",
        body="Checkpoint safely.",
        urgency="critical",
    )
    store.record_delivery(envelope["id"], delivered=False)

    assert store.retry(envelope["id"])["status"] == "queued"
    store.record_delivery(envelope["id"], delivered=False)
    with sqlite3.connect(db_path) as connection:
        connection.execute("DELETE FROM mailroom_critical_policies")

    with pytest.raises(api.CriticalPolicyDenied):
        store.retry(envelope["id"])

    assert store.get_envelope(envelope["id"])["status"] == "failed"
    assert store.list_policy_decisions(limit=10)[-1]["reason"] == "missing"


def test_status_history_requires_explicit_retry_and_never_forces_cancellation(tmp_path):
    api = load_store()
    ticks = iter(range(1_800_000_000, 1_800_000_020))
    store = api.MailroomStore(tmp_path / "mailroom.db", clock=lambda: next(ticks))
    envelope = store.create_envelope(
        source_profile="planner", target_profile="builder", body="Ship when ready."
    )

    failed = store.record_delivery(envelope["id"], delivered=False)
    assert failed["status"] == "failed"
    assert [event["status"] for event in failed["history"]] == ["queued", "failed"]
    with pytest.raises(api.InvalidTransition):
        store.record_delivery(envelope["id"], delivered=True)

    queued = store.retry(envelope["id"])
    assert queued["status"] == "queued"
    delivered = store.record_delivery(envelope["id"], delivered=True)
    assert delivered["status"] == "delivered"
    with pytest.raises(api.InvalidTransition):
        store.cancel(envelope["id"])
    acknowledged = store.acknowledge(envelope["id"])
    assert acknowledged["status"] == "acknowledged"

    pending = store.create_envelope(
        source_profile="planner", target_profile="builder", body="Never mind."
    )
    cancelled = store.cancel(pending["id"])
    assert cancelled["status"] == "cancelled"
    assert [event["status"] for event in cancelled["history"]] == [
        "queued",
        "cancelled",
    ]


def test_api_rejects_unknown_targets_and_returns_only_public_delivery_fields(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_db_path", lambda: tmp_path / "mailroom.db")
    monkeypatch.setattr(api, "_known_profiles", lambda: ["default", "builder"])
    monkeypatch.setattr(api, "_launch_delivery", lambda *_args, **_kwargs: "proc-private")
    monkeypatch.setattr(api, "_start_delivery_watch", lambda *_args, **_kwargs: None)
    app = FastAPI()
    app.include_router(api.router)

    unknown = asyncio.run(
        request_json(
            app,
            "POST",
            "/mailroom",
            {"source_profile": "default", "target_profile": "missing", "body": "Review this."},
        )
    )
    assert unknown.status_code == 404

    created = asyncio.run(
        request_json(
            app,
            "POST",
            "/mailroom",
            {
                "source_profile": "default",
                "target_profile": "builder",
                "body": "Review this.",
                "urgency": "priority",
                "dedupe_key": "review-this",
            },
        )
    )
    assert created.status_code == 200
    payload = created.json()
    assert set(payload) == {"envelope", "delivery"}
    assert payload["delivery"] == {"status": "started", "to": "builder"}
    assert "process_id" not in json.dumps(payload)
    assert "command" not in json.dumps(payload)
    assert "token" not in json.dumps(payload).lower()


def test_api_requires_explicit_retry_and_hash_free_exact_critical_policy(tmp_path, monkeypatch):
    api = load_api()
    now = [1_800_000_000]
    monkeypatch.setattr(api, "_db_path", lambda: tmp_path / "mailroom.db")
    monkeypatch.setattr(api, "_known_profiles", lambda: ["default", "builder"])
    monkeypatch.setattr(api, "_clock", lambda: now[0])
    monkeypatch.setattr(api, "_launch_delivery", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("offline")))
    app = FastAPI()
    app.include_router(api.router)

    denied = asyncio.run(
        request_json(
            app,
            "POST",
            "/mailroom",
            {
                "source_profile": "default",
                "target_profile": "builder",
                "body": "Checkpoint when safe.",
                "urgency": "critical",
            },
        )
    )
    assert denied.status_code == 403

    policy = asyncio.run(
        request_json(
            app,
            "PUT",
            "/mailroom/critical-policy",
            {"source_profile": "default", "target_profile": "builder", "ttl_seconds": 60},
        )
    )
    assert policy.status_code == 200
    assert policy.json()["expires_at"] == now[0] + 60

    failed = asyncio.run(
        request_json(
            app,
            "POST",
            "/mailroom",
            {
                "source_profile": "default",
                "target_profile": "builder",
                "body": "Checkpoint when safe.",
                "urgency": "critical",
                "dedupe_key": "critical-1",
            },
        )
    )
    assert failed.status_code == 503
    envelope_id = failed.json()["detail"]["envelope_id"]

    listed = asyncio.run(request_json(app, "GET", "/mailroom?status=failed"))
    assert [row["id"] for row in listed.json()["envelopes"]] == [envelope_id]

    retried = asyncio.run(request_json(app, "POST", f"/mailroom/{envelope_id}/retry"))
    assert retried.status_code == 503
    history = asyncio.run(request_json(app, "GET", f"/mailroom/{envelope_id}"))
    assert [event["status"] for event in history.json()["envelope"]["history"]] == [
        "queued",
        "failed",
        "queued",
        "failed",
    ]

    now[0] += 61
    expired_retry = asyncio.run(request_json(app, "POST", f"/mailroom/{envelope_id}/retry"))
    assert expired_retry.status_code == 403
    unchanged = asyncio.run(request_json(app, "GET", f"/mailroom/{envelope_id}"))
    assert [event["status"] for event in unchanged.json()["envelope"]["history"]] == [
        "queued",
        "failed",
        "queued",
        "failed",
    ]


def meeting_record(**overrides):
    record = {
        "id": "meeting_release_1",
        "source": {"connection": "local", "profile": "default"},
        "title": "Release readiness",
        "agenda": "Review evidence and decide whether to release.",
        "chair": {"connection": "local", "profile": "reviewer"},
        "participants": [
            {"connection": "local", "profile": "reviewer"},
            {"connection": "local", "profile": "builder"},
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
    record.update(overrides)
    return record


def test_meeting_store_is_bounded_compare_and_swap_and_append_only(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db", clock=lambda: 1_800_000_000)

    created = store.put(meeting_record(), expected_version=0)
    assert created["version"] == 1
    assert created["meeting"]["state"] == "draft"

    contribution = {
        "id": "turn_1",
        "round": 1,
        "participant": {"connection": "local", "profile": "reviewer"},
        "kind": "speak",
        "text": "The tests pass.",
        "evidenceRefs": ["run:tests"],
    }
    updated = store.put(
        meeting_record(state="running", current_round=1, contributions=[contribution]),
        expected_version=1,
    )
    assert updated["version"] == 2
    assert updated["meeting"]["contributions"] == [contribution]

    with pytest.raises(api.VersionConflict):
        store.put(meeting_record(state="cancelled"), expected_version=1)
    with pytest.raises(api.ImmutableMeetingHistory):
        store.put(
            meeting_record(state="running", current_round=1, contributions=[]),
            expected_version=2,
        )
    with pytest.raises(ValueError):
        store.put(meeting_record(participants=[]), expected_version=2)

    assert store.get("meeting_release_1")["version"] == 2
    assert [row["meeting"]["id"] for row in store.list(limit=10)] == ["meeting_release_1"]


def test_meeting_store_rejects_semantically_malformed_history(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    reviewer = {"connection": "local", "profile": "reviewer"}
    stranger = {"connection": "remote", "profile": "stranger"}
    bad_records = [
        meeting_record(contributions=[{}]),
        meeting_record(state="running", current_round=3),
        meeting_record(
            state="running",
            current_round=1,
            contributions=[
                {
                    "id": "reviewer_pass",
                    "round": 1,
                    "participant": reviewer,
                    "kind": "pass",
                    "text": "",
                    "evidenceRefs": [],
                },
                {
                    "id": "builder_pass",
                    "round": 1,
                    "participant": {"connection": "local", "profile": "builder"},
                    "kind": "pass",
                    "text": "",
                    "evidenceRefs": [],
                },
            ],
        ),
        meeting_record(
            state="running",
            current_round=1,
            contributions=[{
                "id": "bad_round",
                "round": 2,
                "participant": reviewer,
                "kind": "pass",
                "text": "",
                "evidenceRefs": [],
            }],
        ),
        meeting_record(
            state="running",
            current_round=1,
            contributions=[{
                "id": "bad_participant",
                "round": 1,
                "participant": stranger,
                "kind": "speak",
                "text": "Not invited.",
                "evidenceRefs": [],
            }],
        ),
        meeting_record(decisions=[{}]),
        meeting_record(dissent=[{"participant": stranger, "text": "No.", "evidenceRefs": []}]),
        meeting_record(action_items=[{}]),
    ]

    for record in bad_records:
        with pytest.raises(ValueError):
            store.put(record, expected_version=0)


def test_meeting_store_accepts_semantically_complete_conclusion(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    reviewer = {"connection": "local", "profile": "reviewer"}
    completed = meeting_record(
        state="completed",
        current_round=1,
        decisions=[{"id": "release", "text": "Release.", "evidenceRefs": ["run:tests"]}],
        dissent=[{"participant": reviewer, "text": "Monitor rollout.", "evidenceRefs": []}],
        action_items=[{
            "id": "publish",
            "ownerRoute": reviewer,
            "title": "Publish release",
            "acceptanceCriteria": "Verified archive is available.",
            "priority": "high",
            "dueIntent": "After CI passes.",
            "dedupeKey": "meeting:meeting_release_1:action:publish",
        }],
    )

    stored = store.put(completed, expected_version=0)

    assert stored["meeting"]["decisions"][0]["id"] == "release"
    assert stored["meeting"]["action_items"][0]["dedupeKey"].endswith(":publish")


def test_meeting_store_accepts_harness_agent_participants(tmp_path):
    api = load_meeting_store()
    store = api.MeetingStore(tmp_path / "meetings.db")
    chair = {"connection": "local", "profile": "default"}
    a2a_agent = {"connection": "a2a", "profile": "agent-1"}
    record = meeting_record(
        chair=chair,
        participants=[chair, a2a_agent],
        state="running",
        current_round=1,
        contributions=[{
            "id": "a2a-r1",
            "round": 1,
            "participant": a2a_agent,
            "kind": "speak",
            "text": "A2A agent contribution.",
            "evidenceRefs": [],
        }],
    )

    stored = store.put(record, expected_version=0)

    assert stored["meeting"]["participants"][1]["connection"] == "a2a"
    assert stored["meeting"]["participants"][1]["profile"] == "agent-1"
    assert stored["meeting"]["contributions"][0]["participant"]["connection"] == "a2a"


def test_meeting_api_persists_versioned_records_and_returns_conflicts(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_meeting_db_path", lambda: tmp_path / "meetings.db")
    app = FastAPI()
    app.include_router(api.router)

    created = asyncio.run(
        request_json(app, "PUT", "/meetings/meeting_release_1", {"record": meeting_record(), "expected_version": 0})
    )
    assert created.status_code == 200
    assert created.json()["version"] == 1

    listed = asyncio.run(request_json(app, "GET", "/meetings?limit=10"))
    assert [row["meeting"]["id"] for row in listed.json()["meetings"]] == ["meeting_release_1"]

    conflict = asyncio.run(
        request_json(
            app,
            "PUT",
            "/meetings/meeting_release_1",
            {"record": meeting_record(state="cancelled"), "expected_version": 0},
        )
    )
    assert conflict.status_code == 409
    assert set(conflict.json()) == {"detail"}


def test_connected_agents_endpoint_returns_verified_only_and_hides_local(tmp_path, monkeypatch):
    import sys
    fake_module = type(sys)('tools.connected_agent_bot_integration')

    class FakeEntry:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)

    class FakeRoster:
        def __init__(self, **kwargs):
            pass
        def list_entries(self, home, profile):
            return [
                FakeEntry(agent_id="a1", capabilities=["chat"], display_name="Alpha", handle="alpha", provider="hermes", role="builder", stale=False, verified=True),
                FakeEntry(agent_id="a2", capabilities=[], display_name="Beta", handle="beta", provider="claude-code", role="reviewer", stale=True, verified=True),
                FakeEntry(agent_id="a3", capabilities=[], display_name="Gamma", handle="gamma", provider="local", role="local", stale=False, verified=True),
                FakeEntry(agent_id="a4", capabilities=[], display_name="Delta", handle="delta", provider="opencode", role="coder", stale=False, verified=False),
            ]

    fake_module.BotRoster = FakeRoster
    sys.modules['tools.connected_agent_bot_integration'] = fake_module

    api = load_api()
    monkeypatch.setattr(api, "get_hermes_home", lambda: str(tmp_path))
    app = FastAPI()
    app.include_router(api.router)

    response = asyncio.run(request_json(app, "GET", "/connected-agents"))
    assert response.status_code == 200
    agents = response.json()["agents"]
    handles = [a["handle"] for a in agents]
    assert "alpha" in handles
    assert "beta" in handles
    assert "gamma" not in handles  # local provider is filtered out
    assert "delta" not in handles  # unverified is filtered out
    assert all(a["verified"] for a in agents)
    assert agents[1]["stale"] is True

    del sys.modules['tools.connected_agent_bot_integration']


def test_connected_agents_endpoint_gracefully_returns_empty_on_import_failure(tmp_path, monkeypatch):
    import sys
    fake_module = type(sys)('tools.connected_agent_bot_integration')

    def broken_import(*args, **kwargs):
        raise ImportError("No connected agent module")

    fake_module.BotRoster = broken_import
    sys.modules['tools.connected_agent_bot_integration'] = fake_module

    api = load_api()
    monkeypatch.setattr(api, "get_hermes_home", lambda: str(tmp_path))
    app = FastAPI()
    app.include_router(api.router)

    response = asyncio.run(request_json(app, "GET", "/connected-agents"))
    assert response.status_code == 200
    assert response.json()["agents"] == []

    del sys.modules['tools.connected_agent_bot_integration']
