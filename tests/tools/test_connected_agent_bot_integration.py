"""Tests for tools/connected_agent_bot_integration.py — verified connected agent
integration into Bot Mode roster and canonical mirrored chat.

Strict vertical TDD: every behavior is tested red-before-green.
Covers: roster provider abstraction, verified-only publication, provider ownership,
canonical chat, stable event identity, retry/crash recovery, backend auth,
stale connector state, duplicate delivery prevention, unverified invisibility.
"""

import json
import time
from pathlib import Path

import pytest

from tools import connected_agent_bot_integration as cabi
from tools.connected_agent_bot_integration import (
    BackendAuth,
    BotRoster,
    ChatEvent,
    ConnectedAgentChatStore,
    ConnectedAgentMessenger,
    ConnectedAgentRosterProvider,
    LocalProfileRosterProvider,
    RosterEntry,
)
from tools.connected_agent_import import AgentRegistry, HarnessFamily, normalize_to_manifest


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_preview(name, slug, runtime_targets=("hermes",), with_secret=False):
    raw = {
        "name": name,
        "slug": slug,
        "description": f"A {name} agent",
        "instructions": "Be helpful.",
        "skills": ["help"],
        "runtime_targets": list(runtime_targets),
    }
    if with_secret:
        raw["api_key"] = "sk-live-test"
    source = json.dumps(raw).encode()
    return normalize_to_manifest(source, f"{slug}.json")


def _make_verified_registry(tmp_path, *entries):
    """Entries are (name, slug, targets, with_secret) tuples."""
    reg = AgentRegistry(hermes_home=tmp_path)
    for name, slug, targets, with_secret in entries:
        preview = _make_preview(name, slug, targets, with_secret)
        reg.upsert(preview)
        reg.verify_entry(preview.manifest.id)
    return reg


def _make_bot_managed_profile(root, name):
    d = root / "profiles" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "profile.yaml").write_text(
        "ui_meta:\n  hermes-bots:\n    shape: cloud\n",
        encoding="utf-8",
    )
    return d


# ── roster provider abstraction ──────────────────────────────────────────────


def test_local_profile_provider_lists_managed_profiles(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    _make_bot_managed_profile(root, "researcher")
    _make_bot_managed_profile(root, "coder")
    # default profile not managed
    (root / "profile.yaml").write_text("description: default agent\n", encoding="utf-8")

    provider = LocalProfileRosterProvider()
    entries = provider.list_entries(root, me="default")

    handles = {e.handle for e in entries}
    assert handles == {"researcher", "coder"}
    # default is excluded from roster (it's "me")
    assert "default" not in handles


def test_local_profile_provider_skips_unmanaged_profiles(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    _make_bot_managed_profile(root, "managed")
    # unmanaged profile
    plain_dir = root / "profiles" / "plain"
    plain_dir.mkdir(parents=True, exist_ok=True)
    (plain_dir / "profile.yaml").write_text(
        "description: plain\n", encoding="utf-8"
    )

    provider = LocalProfileRosterProvider()
    entries = provider.list_entries(root, me="default")
    handles = {e.handle for e in entries}
    assert handles == {"managed"}


def test_connected_agent_provider_lists_only_verified(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    clean = _make_preview("CleanBot", "clean-bot")
    leaky = _make_preview("LeakyBot", "leaky-bot", with_secret=True)
    reg.upsert(clean)
    reg.upsert(leaky)
    reg.verify_entry(clean.manifest.id)
    reg.verify_entry(leaky.manifest.id)  # will fail due to secret

    provider = ConnectedAgentRosterProvider(hermes_home=tmp_path)
    entries = provider.list_entries(tmp_path, me="default")

    handles = {e.handle for e in entries}
    assert "clean-bot" in handles
    assert "leaky-bot" not in handles  # unverified → invisible


def test_connected_agent_provider_preserves_provider_ownership(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("ClaudeHelper", "claude-helper", runtime_targets=("claude_code",))
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    provider = ConnectedAgentRosterProvider(hermes_home=tmp_path)
    entries = provider.list_entries(tmp_path, me="default")
    assert len(entries) == 1
    entry = entries[0]
    assert entry.provider == "claude_code"
    assert entry.agent_id == preview.manifest.id
    assert entry.workspace_path is not None
    # workspace_path points to provider-specific workspace, not local profile
    assert "profiles" not in str(entry.workspace_path)


def test_connected_agent_provider_open_owning_workspace(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("PiBot", "pi-bot", runtime_targets=("pi",))
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    provider = ConnectedAgentRosterProvider(hermes_home=tmp_path)
    entry = provider.list_entries(tmp_path, me="default")[0]
    # workspace should be provider-scoped under connected_agents/
    assert entry.workspace_path is not None
    assert entry.workspace_path.exists()
    assert entry.workspace_path.name == preview.manifest.id


# ── BotRoster aggregator ─────────────────────────────────────────────────────


def test_bot_roster_combines_local_and_connected(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    _make_bot_managed_profile(root, "researcher")

    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("ConnBot", "conn-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entries = roster.list_entries(root, me="default")

    handles = {e.handle for e in entries}
    assert "researcher" in handles
    assert "conn-bot" in handles


def test_bot_roster_looks_up_by_handle(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    _make_bot_managed_profile(root, "researcher")

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("researcher", root, me="default")
    assert entry is not None
    assert entry.handle == "researcher"
    assert entry.provider == "local"

    assert roster.get_entry("nonexistent", root, me="default") is None


def test_bot_roster_unverified_connected_invisible(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()

    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("SecretBot", "secret-bot", with_secret=True)
    reg.upsert(preview)
    # Do NOT verify — should remain invisible

    roster = BotRoster(hermes_home=tmp_path)
    entries = roster.list_entries(root, me="default")
    assert all(e.handle != "secret-bot" for e in entries)
    assert roster.get_entry("secret-bot", root, me="default") is None


# ── chat store: sanitized ordered messages ───────────────────────────────────


def test_chat_store_sanitizes_on_append(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    event = store.append(
        agent_id="agent-1",
        sender_handle="me",
        content="My key is sk-abcdefghijklmnopqrstuvwxyz and Bearer token123",
    )
    assert "sk-abcdefghijklmnopqrstuvwxyz" not in event.content
    assert "sk-***" in event.content
    assert "Bearer ***" in event.content
    assert event.sanitized is True


def test_chat_store_orders_by_timestamp(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "first")
    time.sleep(0.01)
    e2 = store.append("agent-1", "me", "second")
    time.sleep(0.01)
    e3 = store.append("agent-1", "me", "third")

    messages = store.get_messages("agent-1")
    contents = [m.content for m in messages]
    assert contents == ["first", "second", "third"]


def test_chat_store_stable_event_identity(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "hello")
    e2 = store.append("agent-1", "me", "hello")
    # Same content but different timestamps → different IDs
    assert e1.event_id != e2.event_id
    # IDs are deterministic hashes (non-empty, hex-like)
    assert len(e1.event_id) == 64
    assert all(c in "0123456789abcdef" for c in e1.event_id)


# ── backend authorization ────────────────────────────────────────────────────


def test_backend_auth_allows_valid_token():
    auth = BackendAuth(secret="test-secret")
    token = auth.generate_token("agent-1", "send")
    assert auth.authorize_mutation("agent-1", "send", token) is True


def test_backend_auth_rejects_invalid_token():
    auth = BackendAuth(secret="test-secret")
    assert auth.authorize_mutation("agent-1", "send", "bad-token") is False
    assert auth.authorize_mutation("agent-1", "send", "") is False


def test_backend_auth_rejects_wrong_operation():
    auth = BackendAuth(secret="test-secret")
    token = auth.generate_token("agent-1", "send")
    assert auth.authorize_mutation("agent-1", "delete", token) is False


def test_backend_auth_rejects_wrong_agent():
    auth = BackendAuth(secret="test-secret")
    token = auth.generate_token("agent-1", "send")
    assert auth.authorize_mutation("agent-2", "send", token) is False


# ── retry and crash recovery ─────────────────────────────────────────────────


def test_chat_store_tracks_pending_status(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    event = store.append("agent-1", "me", "hello")
    assert event.delivery_status == "pending"


def test_chat_store_retry_increments_count(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    event = store.append("agent-1", "me", "hello")
    updated = store.mark_retry(event.event_id)
    assert updated.retry_count == 1
    assert updated.delivery_status == "pending"

    updated2 = store.mark_retry(event.event_id)
    assert updated2.retry_count == 2


def test_chat_store_crash_recovery_finds_pending(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "hello")
    e2 = store.append("agent-1", "me", "world")
    store.mark_delivered(e1.event_id)

    pending = store.list_pending()
    assert len(pending) == 1
    assert pending[0].event_id == e2.event_id


def test_chat_store_persists_across_instances(tmp_path):
    store1 = ConnectedAgentChatStore(hermes_home=tmp_path)
    event = store1.append("agent-1", "me", "persisted")

    store2 = ConnectedAgentChatStore(hermes_home=tmp_path)
    messages = store2.get_messages("agent-1")
    assert len(messages) == 1
    assert messages[0].content == "persisted"
    assert messages[0].event_id == event.event_id


# ── duplicate delivery prevention ────────────────────────────────────────────


def test_chat_store_prevents_exact_duplicate(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "hello", dedup_window_seconds=10.0)
    # Exact same content within dedup window → same event returned
    e2 = store.append("agent-1", "me", "hello", dedup_window_seconds=10.0)
    assert e1.event_id == e2.event_id


def test_chat_store_allows_different_content(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "hello", dedup_window_seconds=10.0)
    e2 = store.append("agent-1", "me", "world", dedup_window_seconds=10.0)
    assert e1.event_id != e2.event_id


def test_chat_store_allows_after_dedup_window(tmp_path):
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    e1 = store.append("agent-1", "me", "hello", dedup_window_seconds=0.01)
    time.sleep(0.02)
    e2 = store.append("agent-1", "me", "hello", dedup_window_seconds=0.01)
    assert e1.event_id != e2.event_id


# ── stale and failed connector state ─────────────────────────────────────────


def test_messenger_tracks_stale_state(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("StaleBot", "stale-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("stale-bot", tmp_path, me="default")

    messenger = ConnectedAgentMessenger(hermes_home=tmp_path)
    # Mark agent as stale
    messenger.mark_stale(entry.agent_id)
    assert messenger.is_stale(entry.agent_id) is True


def test_messenger_honest_capability_state(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("CapBot", "cap-bot", runtime_targets=("hermes", "codex"))
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("cap-bot", tmp_path, me="default")

    # Capability state must reflect actual manifest, not invented data
    assert entry.capabilities == ("hermes", "codex")
    assert entry.model_reference is None  # honest about missing model


def test_messenger_reports_model_truth(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    raw = {
        "name": "ModelBot",
        "slug": "model-bot",
        "model": {"provider": "openai", "model_id": "gpt-4o"},
        "runtime_targets": ["hermes"],
    }
    preview = normalize_to_manifest(json.dumps(raw).encode(), "model.json")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("model-bot", tmp_path, me="default")
    assert entry.model_reference.provider == "openai"
    assert entry.model_reference.model_id == "gpt-4o"


# ── integration: full send flow with auth ────────────────────────────────────


def test_full_send_flow_requires_auth(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("FlowBot", "flow-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("flow-bot", tmp_path, me="default")

    auth = BackendAuth(secret="test-secret")
    messenger = ConnectedAgentMessenger(hermes_home=tmp_path, auth=auth)

    # Without auth token → auto-generated internally for backend callers → accepted
    result = messenger.send_message(entry, "hello", sender_handle="me")
    assert result.get("error") is None
    assert result["status"] == "queued"
    assert result["event_id"] is not None

    # With an invalid external auth token → rejected
    result_bad = messenger.send_message(entry, "hello", sender_handle="me", auth_token="bad-token")
    assert result_bad.get("error") is not None
    assert "authorization" in result_bad["error"].lower()

    # With valid external auth token → accepted
    token = auth.generate_token(entry.agent_id, "send")
    result_ok = messenger.send_message(entry, "hello", sender_handle="me", auth_token=token)
    assert result_ok.get("error") is None
    assert result_ok["status"] == "queued"


def test_full_send_flow_sanitizes_and_stores(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("SafeBot", "safe-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("safe-bot", tmp_path, me="default")

    auth = BackendAuth(secret="test-secret")
    token = auth.generate_token(entry.agent_id, "send")

    messenger = ConnectedAgentMessenger(hermes_home=tmp_path, auth=auth)
    result = messenger.send_message(
        entry, "key is sk-abcdefghijklmnopqrstuvwxyz", sender_handle="me", auth_token=token
    )
    event_id = result["event_id"]

    # Verify stored message is sanitized
    store = ConnectedAgentChatStore(hermes_home=tmp_path)
    event = store.get_event(event_id)
    assert event is not None
    assert "sk-abcdefghijklmnopqrstuvwxyz" not in event.content
    assert event.sanitized is True


# ── reload handling ──────────────────────────────────────────────────────────


def test_roster_reflects_registry_reload(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("ReloadBot", "reload-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    assert roster.get_entry("reload-bot", tmp_path, me="default") is not None

    # Delete from registry
    reg.delete(preview.manifest.id)

    # BotRoster re-reads on each call
    assert roster.get_entry("reload-bot", tmp_path, me="default") is None


# ── honest state boundaries ──────────────────────────────────────────────────


def test_roster_entry_shows_verified_status(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("HonestBot", "honest-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("honest-bot", tmp_path, me="default")
    assert entry.verified is True
    assert entry.stale is False


def test_stale_entry_shows_stale_true(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("OldBot", "old-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("old-bot", tmp_path, me="default")

    messenger = ConnectedAgentMessenger(hermes_home=tmp_path)
    messenger.mark_stale(entry.agent_id)

    # Re-fetch entry — stale state is reflected
    roster2 = BotRoster(hermes_home=tmp_path)
    entry2 = roster2.get_entry("old-bot", tmp_path, me="default")
    assert entry2.stale is True


# ── responsive management path helpers ───────────────────────────────────────


def test_roster_entry_has_management_path(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("ManageBot", "manage-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("manage-bot", tmp_path, me="default")
    assert entry is not None
    assert entry.chat_path is not None
    assert entry.management_path is not None
    assert entry.agent_id in entry.chat_path
    assert entry.agent_id in entry.management_path


def test_chat_path_is_canonical(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    preview = _make_preview("ChatBot", "chat-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    roster = BotRoster(hermes_home=tmp_path)
    entry = roster.get_entry("chat-bot", tmp_path, me="default")
    assert entry is not None
    # chat_path should be deterministic and unique per agent
    assert entry.agent_id in entry.chat_path


# ── integration with Bot Mode probe and DM ─────────────────────────────────────────────────────


def test_connected_agents_appear_in_protocol_section(tmp_path):
    import textwrap

    from tools import bot_mode_probe

    bot_mode_probe._reset_cache_for_tests()

    home = tmp_path / ".hermes"
    home.mkdir()
    # managed local profile
    d = home / "profiles" / "researcher"
    d.mkdir(parents=True)
    (d / "profile.yaml").write_text(
        textwrap.dedent(
            """\
            ui_meta:
              hermes-bots:
                shape: cloud
            """
        ),
        encoding="utf-8",
    )

    # verified connected agent
    reg = AgentRegistry(hermes_home=home)
    preview = _make_preview("ConnBot", "conn-bot", runtime_targets=("codex",))
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    section = bot_mode_probe.get_bot_mode_protocol_section(home)
    assert "@researcher" in section
    assert "@conn-bot" in section
    assert "(codex)" in section
    bot_mode_probe._reset_cache_for_tests()


def test_connected_agents_invisible_when_unverified(tmp_path):
    import textwrap

    from tools import bot_mode_probe

    bot_mode_probe._reset_cache_for_tests()

    home = tmp_path / ".hermes"
    home.mkdir()
    d = home / "profiles" / "researcher"
    d.mkdir(parents=True)
    (d / "profile.yaml").write_text(
        textwrap.dedent(
            """\
            ui_meta:
              hermes-bots:
                shape: cloud
            """
        ),
        encoding="utf-8",
    )

    # unverified connected agent
    reg = AgentRegistry(hermes_home=home)
    preview = _make_preview("SecretBot", "secret-bot", with_secret=True)
    reg.upsert(preview)
    # deliberately NOT verified

    section = bot_mode_probe.get_bot_mode_protocol_section(home)
    assert "@researcher" in section
    assert "@secret-bot" not in section
    bot_mode_probe._reset_cache_for_tests()


def test_capability_fingerprint_changes_with_connected_agent(tmp_path):
    import textwrap

    from tools import bot_mode_probe

    home = tmp_path / ".hermes"
    home.mkdir()
    d = home / "profiles" / "researcher"
    d.mkdir(parents=True)
    (d / "profile.yaml").write_text(
        textwrap.dedent(
            """\
            ui_meta:
              hermes-bots:
                shape: cloud
            """
        ),
        encoding="utf-8",
    )

    before = bot_mode_probe.capability_fingerprint(home)

    reg = AgentRegistry(hermes_home=home)
    preview = _make_preview("NewBot", "new-bot")
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    after = bot_mode_probe.capability_fingerprint(home)
    assert after != before


def test_message_agent_tool_dispatches_to_connected_agent(tmp_path):
    import textwrap

    from tools import bot_mode_dm, bot_mode_probe

    bot_mode_probe._reset_cache_for_tests()

    home = tmp_path / ".hermes"
    home.mkdir()
    d = home / "profiles" / "researcher"
    d.mkdir(parents=True)
    (d / "profile.yaml").write_text(
        textwrap.dedent(
            """\
            ui_meta:
              hermes-bots:
                shape: cloud
            """
        ),
        encoding="utf-8",
    )

    reg = AgentRegistry(hermes_home=home)
    preview = _make_preview("ConnBot", "conn-bot", runtime_targets=("codex",))
    reg.upsert(preview)
    reg.verify_entry(preview.manifest.id)

    class _FakeDB:
        def __init__(self, home: Path, title: str):
            self.db_path = str(home / "state.db")
            self._title = title
        def get_session_title(self, _sid):
            return self._title

    class _FakeAgent:
        def __init__(self, home: Path):
            self._session_db = _FakeDB(home, "Bot Chat")
            self.session_id = "sess-1"
            self._session_title_hint = None
            self._bot_mode_protocol = True

    agent = _FakeAgent(home)
    result = bot_mode_dm.message_agent_tool(target="conn-bot", message="hello connected", agent=agent)
    parsed = json.loads(result)
    assert parsed.get("error") is None
    assert parsed["status"] == "queued"
    assert parsed["to"] == "conn-bot"
    assert parsed["provider"] == "codex"
    bot_mode_probe._reset_cache_for_tests()
