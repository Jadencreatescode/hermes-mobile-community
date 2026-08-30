"""Production-path restrictions for hidden structured-meeting sessions."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import tui_gateway.server as server


MEETING_PARAMS = {
    "enabled_toolsets": ["clarify"],
    "skip_background_review": True,
    "skip_context_files": True,
    "skip_memory": True,
    "source": "meeting",
}


@pytest.fixture(autouse=True)
def _clean_sessions():
    known = set(server._sessions)
    yield
    with server._sessions_lock:
        for sid in set(server._sessions) - known:
            server._sessions.pop(sid, None)


def test_toolset_restrictions_can_only_remove_ambient_authority():
    restrict = server._restrict_enabled_toolsets

    assert restrict(None, ["file", "terminal"]) == ["file", "terminal"]
    assert restrict(["clarify"], None) == ["clarify"]
    assert restrict(["clarify", "terminal"], ["clarify", "file"]) == ["clarify"]
    assert restrict(["terminal"], ["clarify", "file"]) == []


def test_session_create_threads_meeting_restrictions_into_agent_build(monkeypatch, tmp_path):
    captured = {}

    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    monkeypatch.setattr(server, "_completion_cwd", lambda _params: str(tmp_path))
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_profile_home", lambda _profile: None)

    response = server._methods["session.create"](
        "create-meeting",
        {
            **MEETING_PARAMS,
            "hidden": True,
            "profile": "reviewer",
            "title": "Meeting: security-review",
        },
    )
    sid = response["result"]["session_id"]
    session = server._sessions[sid]

    def _fake_make_agent(_sid, _key, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(_session_db=None, _owns_session_db=False)

    monkeypatch.setattr(server, "_make_agent", _fake_make_agent)
    for name, value in (
        ("_set_session_context", lambda _key: []),
        ("_clear_session_context", lambda _tokens: None),
        ("_wire_callbacks", lambda _sid: None),
        ("_config_model_target", lambda: None),
        ("_load_memory_notifications", lambda: False),
        ("_start_notification_poller", lambda _sid, _session: None),
        ("_notify_session_boundary", lambda *args, **kwargs: None),
        ("_session_info", lambda *args, **kwargs: {}),
        ("_probe_config_health", lambda _cfg: None),
        ("_load_cfg", lambda: {}),
        ("_emit", lambda *args, **kwargs: None),
        ("_schedule_mcp_late_refresh", lambda *args, **kwargs: None),
        ("_child_run_active", lambda _key: False),
    ):
        monkeypatch.setattr(server, name, value)

    server._start_agent_build(sid, session)
    assert session["agent_ready"].wait(timeout=10), "meeting agent build did not finish"

    assert captured["enabled_toolsets_override"] == ["clarify"]
    assert captured["skip_background_review"] is True
    assert captured["skip_context_files"] is True
    assert captured["skip_memory"] is True
    assert captured["platform_override"] == "meeting"


def test_restrictive_meeting_resume_refuses_a_live_session_with_broader_authority(monkeypatch):
    broad = {"agent": SimpleNamespace(enabled_toolsets=None), "session_key": "stored-meeting"}
    db = MagicMock()
    db.get_session.return_value = {"id": "stored-meeting", "cwd": ""}
    db.resolve_resume_session_id.return_value = "stored-meeting"

    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(server, "_find_live_session_by_key", lambda _target: ("broad-runtime", broad))

    response = server._methods["session.resume"](
        "resume-meeting",
        {**MEETING_PARAMS, "profile": "reviewer", "session_id": "stored-meeting"},
    )

    assert response["error"]["code"] == 4033
    assert "broader authority" in response["error"]["message"]
