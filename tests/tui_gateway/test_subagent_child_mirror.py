"""Tests for the gateway's child-session live mirror.

A delegated child runs synchronously inside the parent's turn; its activity
reaches the gateway only as relayed ``subagent.*`` events on the PARENT sid
(tagged with ``child_session_id``). When a UI resumes the child's own session
(desktop open-in-new-window), ``_mirror_subagent_to_child`` translates those
relayed events into native stream events on the CHILD's live sid so the window
shows a real midstream turn instead of sitting silent until persistence.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def server():
    # Mocks are scoped to the initial import only (see
    # tests/tui_gateway/test_protocol.py for the rationale).
    with patch.dict(
        "sys.modules",
        {
            "hermes_constants": MagicMock(
                get_hermes_home=MagicMock(return_value="/tmp/hermes_test_child_mirror")
            ),
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
            "hermes_state": MagicMock(),
        },
    ):
        import importlib

        mod = importlib.import_module("tui_gateway.server")

    yield mod
    mod._sessions.clear()
    mod._pending.clear()
    mod._answers.clear()
    mod._child_mirrors.clear()
    mod._active_child_runs.clear()


@pytest.fixture()
def emits(server, monkeypatch):
    captured: list = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: captured.append((event, sid, payload)),
    )
    monkeypatch.setattr(server, "_tool_progress_enabled", lambda sid: True)
    return captured


def _relay(server, event_type, **payload):
    """Drive _on_tool_progress the way the delegate relay does."""
    server._on_tool_progress(
        "parent-sid",
        event_type,
        payload.pop("tool_name", None),
        payload.pop("preview", None),
        None,
        goal="research X",
        task_count=1,
        task_index=0,
        **payload,
    )


def test_no_live_child_session_no_mirror(server, emits):
    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")

    # Only the parent-sid relay event — nothing mirrored, no state retained.
    assert [(e, s) for e, s, _ in emits] == [("subagent.tool", "parent-sid")]
    assert server._child_mirrors == {}


def test_live_child_session_gets_native_stream(server, emits):
    # A window resumed the child session: live sid differs from the stored key.
    server._sessions["live-1"] = {"session_key": "child-1", "agent": None}

    _relay(server, "subagent.tool", tool_name="terminal", preview="ls", child_session_id="child-1")
    _relay(server, "subagent.thinking", preview="hmm", child_session_id="child-1")
    _relay(server, "subagent.tool", tool_name="read_file", child_session_id="child-1")
    _relay(
        server,
        "subagent.complete",
        child_session_id="child-1",
        status="completed",
        summary="done deal",
    )

    child = [(e, p) for e, s, p in emits if s == "live-1"]

    # Synthetic turn: start → tool → reasoning → tool rotation → close + summary.
    assert [e for e, _ in child] == [
        "message.start",
        "tool.start",
        "reasoning.delta",
        "tool.complete",
        "tool.start",
        "tool.complete",
        "message.complete",
    ]
    first_tool = child[1][1]
    assert first_tool["name"] == "terminal"
    assert first_tool["tool_id"].startswith("submirror:child-1:")
    assert child[2][1] == {"text": "hmm"}
    # The rotated-out tool closes with the same id it opened with.
    assert child[3][1]["tool_id"] == first_tool["tool_id"]
    assert child[6][1] == {"text": "done deal"}

    # Parent relay is untouched alongside the mirror.
    assert [e for e, s, _ in emits if s == "parent-sid"] == [
        "subagent.tool",
        "subagent.thinking",
        "subagent.tool",
        "subagent.complete",
    ]
    # Completion clears mirror state.
    assert server._child_mirrors == {}


def test_window_closed_midrun_drops_state_then_fresh_turn_on_reopen(server, emits):
    server._sessions["live-1"] = {"session_key": "child-1", "agent": None}
    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")
    assert "child-1" in server._child_mirrors

    # Window closes → live session gone → state dropped on the next event.
    server._sessions.clear()
    _relay(server, "subagent.tool", tool_name="read_file", child_session_id="child-1")
    assert server._child_mirrors == {}

    # Reopen under a new live sid → a fresh synthetic turn starts.
    emits.clear()
    server._sessions["live-2"] = {"session_key": "child-1", "agent": None}
    _relay(server, "subagent.tool", tool_name="web_search", child_session_id="child-1")
    assert [(e, s) for e, s, _ in emits if s == "live-2"] == [
        ("message.start", "live-2"),
        ("tool.start", "live-2"),
    ]


def test_upgraded_child_session_not_mirrored(server, emits):
    """A watch window upgraded to a full session (agent built) owns a real
    native stream — mirroring on top would interleave two turns on one sid."""
    server._sessions["live-1"] = {"session_key": "child-1", "agent": object()}

    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")

    assert [(e, s) for e, s, _ in emits] == [("subagent.tool", "parent-sid")]
    assert server._child_mirrors == {}
    # Liveness registry still updates — it serves resume, not the mirror.
    assert "child-1" in server._active_child_runs


def test_stale_child_run_not_reported_active(server, emits):
    """A leaked registry entry (lost completion event) must age out instead of
    pinning running=true on every future lazy resume of that child."""
    server._active_child_runs["child-1"] = 0.0  # epoch — ancient

    assert server._child_run_active("child-1") is False

    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")
    assert server._child_run_active("child-1") is True


def test_prompt_submit_rejected_while_child_run_active(server, emits):
    """Typing into a watch window mid-run must not build a second agent racing
    the in-flight child on the same stored session — busy error instead."""
    import threading

    server._sessions["live-1"] = {
        "agent": None,
        "history_lock": threading.Lock(),
        "lazy": True,
        "running": False,
        "session_key": "child-1",
    }
    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")

    result = server._methods["prompt.submit"]("rid-1", {"session_id": "live-1", "text": "hi"})
    assert result["error"]["code"] == 4009

    # Run completes → the same submit upgrades into a real conversation
    # (passes the guard; fails later only because this test stubs no agent).
    _relay(server, "subagent.complete", child_session_id="child-1", status="completed", summary="ok")
    assert server._child_run_active("child-1") is False


def test_prompt_submit_dispatch_identity_is_an_atomic_concurrency_gate(server, monkeypatch):
    """Two callers for one durable dispatch may start only one prompt turn."""
    import threading

    entered = threading.Event()
    release = threading.Event()
    calls = []
    server._sessions["live-1"] = {
        "agent": None,
        "attached_images": [],
        "history": [],
        "history_lock": threading.Lock(),
        "running": False,
        "session_key": "stored-1",
        "transport": None,
    }
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_: True)
    monkeypatch.setattr(server, "_start_inflight_turn", lambda *_: None)

    def dispatch(*args, **kwargs):
        calls.append((args, kwargs))
        entered.set()
        assert release.wait(2)
        return {"id": "rpc", "result": {"status": "streaming"}}

    monkeypatch.setattr(server, "_submit_prompt_to_compute_host", dispatch)
    results = []
    first = threading.Thread(
        target=lambda: results.append(server._methods["prompt.submit"](
            "rid-1",
            {"session_id": "live-1", "text": "produce", "idempotency_key": "mrun-1"},
        ))
    )
    first.start()
    assert entered.wait(2)
    replay = server._methods["prompt.submit"](
        "rid-2",
        {"session_id": "live-1", "text": "produce", "idempotency_key": "mrun-1"},
    )
    release.set()
    first.join(2)

    assert len(calls) == 1
    assert replay["result"]["idempotent_replay"] is True
    assert results[0]["result"]["status"] == "streaming"


def test_failed_agent_initialization_releases_the_dispatch_key_for_one_retry(
    server, monkeypatch
):
    import threading
    import time

    failed = threading.Event()
    retried = threading.Event()
    waits = iter([{"error": {"message": "agent build failed"}}, None])
    submits = []
    session = {
        "agent": None,
        "agent_ready": threading.Event(),
        "attached_images": [],
        "history": [],
        "history_lock": threading.Lock(),
        "running": False,
        "session_key": "stored-1",
        "transport": None,
    }
    server._sessions["live-1"] = session
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_: False)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda *_: None)
    monkeypatch.setattr(server, "_persist_branch_seed", lambda *_: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *_: None)
    monkeypatch.setattr(server, "_emit_terminal_turn_error", lambda *_args, **_kwargs: failed.set())
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_session_info", lambda *_: {})
    monkeypatch.setattr(server, "_wait_agent_for_prompt", lambda *_: next(waits))

    def submit(*args, **kwargs):
        submits.append((args, kwargs))
        with session["history_lock"]:
            session["running"] = False
        retried.set()

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    params = {"session_id": "live-1", "text": "produce", "idempotency_key": "mrun-1"}
    assert server._methods["prompt.submit"]("rid-1", params)["result"]["status"] == "streaming"
    assert failed.wait(2)
    deadline = time.monotonic() + 2
    while session.get("running") and time.monotonic() < deadline:
        time.sleep(0.01)
    assert "mrun-1" not in session.get("_prompt_idempotency", {})

    assert server._methods["prompt.submit"]("rid-2", params)["result"]["status"] == "streaming"
    assert retried.wait(2)
    assert len(submits) == 1


def test_concurrent_resume_loser_closes_its_pinned_workspace_descriptor(
    server, tmp_path
):
    server._sessions["winner"] = {"session_key": "stored-1"}
    for _ in range(20):
        descriptor = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
        record = {"_cwd_fd": descriptor, "active_session_lease": None}
        assert server._claim_or_reuse_live("loser", "stored-1", record, None)[0] == "winner"
        with pytest.raises(OSError):
            os.fstat(descriptor)


def test_resume_hydration_failure_closes_the_pinned_workspace_descriptor(
    server, monkeypatch, tmp_path
):
    import threading
    import time

    class BrokenDb:
        def reopen_session(self, _stored_id):
            raise RuntimeError("broken history")

    descriptor = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    ready = threading.Event()
    session = {
        "_cwd_fd": descriptor,
        "active_session_lease": None,
        "agent_ready": threading.Event(),
        "history_lock": threading.Lock(),
        "resume_history_ready": ready,
    }
    server._sessions["hydrating"] = session
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_teardown_session", lambda *_args, **_kwargs: None)

    server._schedule_resume_hydration("hydrating", "stored-1", BrokenDb())
    assert ready.wait(2)
    deadline = time.monotonic() + 2
    while "hydrating" in server._sessions and time.monotonic() < deadline:
        time.sleep(0.01)
    assert "hydrating" not in server._sessions
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_session_create_consumes_workspace_through_a_pinned_descriptor(
    server, monkeypatch, tmp_path
):
    run = tmp_path / "run"
    output = run / "output"
    output.mkdir(parents=True)
    run_stat = run.stat()
    output_stat = output.stat()
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *_: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)

    created = server._methods["session.create"](
        "rid-create",
        {
            "cwd": str(run),
            "cwd_identity": {
                "device": str(run_stat.st_dev),
                "inode": str(run_stat.st_ino),
                "output_device": str(output_stat.st_dev),
                "output_inode": str(output_stat.st_ino),
            },
            "source": "desktop",
        },
    )

    assert "error" not in created
    sid = created["result"]["session_id"]
    session = server._sessions[sid]
    capability = session["cwd"]
    assert os.stat(capability).st_ino == run_stat.st_ino

    moved = tmp_path / "moved"
    run.rename(moved)
    (run / "output").mkdir(parents=True)
    assert os.stat(capability).st_ino == run_stat.st_ino
    assert os.stat(capability).st_ino != run.stat().st_ino

    server._close_session_by_id(sid)


def test_active_child_runs_registry_tracks_liveness(server, emits):
    """Every relayed event marks the child as in flight (even with no window
    open), and completion clears it — lazy watch resumes read this registry to
    report running=true while the child is silent inside a long tool call."""
    _relay(server, "subagent.start", preview="go", child_session_id="child-1")
    assert "child-1" in server._active_child_runs

    _relay(server, "subagent.tool", tool_name="terminal", child_session_id="child-1")
    assert "child-1" in server._active_child_runs

    _relay(server, "subagent.complete", child_session_id="child-1", status="completed", summary="ok")
    assert "child-1" not in server._active_child_runs


def test_start_mirrors_as_immediate_header_line(server, emits):
    server._sessions["live-1"] = {"session_key": "child-1", "agent": None}

    # subagent.start emits a one-time header (the goal) so a freshly opened
    # window shows context immediately. subagent.progress (batched tool-name
    # rollups) no longer pollutes the message body — tools mirror natively via
    # tool.start and the reply streams via subagent.text.
    _relay(server, "subagent.start", preview="starting child branch", child_session_id="child-1")
    _relay(server, "subagent.progress", preview="step 1/3", child_session_id="child-1")

    child = [(e, p) for e, s, p in emits if s == "live-1"]
    assert child == [
        ("message.start", None),
        ("message.delta", {"text": "starting child branch\n"}),
    ]


def test_text_mirrors_as_message_delta(server, emits):
    """The child's streamed reply (subagent.text) becomes a native
    message.delta on the live child sid — the watch window streams it as the
    agent 'talking', the piece that was previously missing entirely."""
    server._sessions["live-1"] = {"session_key": "child-1", "agent": None}

    _relay(server, "subagent.text", preview="Here is ", child_session_id="child-1")
    _relay(server, "subagent.text", preview="the answer.", child_session_id="child-1")

    child = [(e, p) for e, s, p in emits if s == "live-1"]
    assert child == [
        ("message.start", None),
        ("message.delta", {"text": "Here is "}),
        ("message.delta", {"text": "the answer."}),
    ]


