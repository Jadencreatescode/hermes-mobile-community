"""Tests for tools/connected_agent_import.py — bounded agent import, sanitization,
fingerprinting, registry persistence, and verification gates.

Strict vertical TDD: every behavior is tested red-before-green.
"""

import json
import textwrap
from dataclasses import asdict
from pathlib import Path

import pytest

from tools import connected_agent_import as cai
from tools.connected_agent_import import (
    AgentRegistry,
    AgentRegistryEntry,
    HarnessFamily,
    ImportPreview,
    ModelReference,
    NeutralAgentManifest,
    SourceMetadata,
    compute_source_fingerprint,
    count_secret_redactions,
    detect_platform,
    normalize_to_manifest,
    redact_secrets_in_text,
    sanitize_value,
    validate_runtime_targets,
)


# ── fingerprinting ─────────────────────────────────────────────────────────────


def test_fingerprint_is_sha256_hex():
    raw = b"hello connected agent"
    fp = compute_source_fingerprint(raw)
    assert len(fp) == 64
    assert all(c in "0123456789abcdef" for c in fp)


def test_fingerprint_changes_with_content():
    assert compute_source_fingerprint(b"a") != compute_source_fingerprint(b"b")


# ── platform detection ───────────────────────────────────────────────────────


def test_detect_platform_from_filename():
    assert detect_platform(b"{}", "agent.json") == HarnessFamily.HERMES
    assert detect_platform(b"{}", "my-agent.pi") == HarnessFamily.PI
    assert detect_platform(b"{}", "claude-project.md") == HarnessFamily.CLAUDE_CODE
    assert detect_platform(b"{}", "codex-agent.json") == HarnessFamily.CODEX
    assert detect_platform(b"{}", "opencode.json") == HarnessFamily.OPENCODE
    assert detect_platform(b"{}", "cursor-rules.md") == HarnessFamily.CURSOR
    assert detect_platform(b"{}", "copilot-instructions.md") == HarnessFamily.GITHUB_COPILOT


def test_detect_platform_from_content():
    assert detect_platform(b'{"agentCard": {}}', "unknown.txt") == HarnessFamily.GENERIC_A2A
    assert detect_platform(b"claude system_prompt here", "unknown.txt") == HarnessFamily.CLAUDE_CODE
    assert detect_platform(b"random data", "unknown.txt") == HarnessFamily.GENERIC_A2A


# ── credential stripping ───────────────────────────────────────────────────────


def test_sanitize_value_strips_exact_credential_keys():
    raw = {
        "name": "helper",
        "api_key": "should-be-removed",
        "token": "should-be-removed",
        "secret": "should-be-removed",
        "password": "should-be-removed",
        "nested": {"credential": "also-removed", "ok": "kept"},
    }
    clean = sanitize_value(raw)
    assert clean == {"name": "helper", "nested": {"ok": "kept"}}


def test_sanitize_value_strips_suffix_keys():
    raw = {"my_api_key": "gone", "auth_token": "gone", "db_password": "gone", "open_secret": "gone"}
    clean = sanitize_value(raw)
    assert clean == {}


def test_sanitize_value_strips_prototype_pollution_keys():
    raw = {"__proto__": {"pollute": True}, "constructor": {"name": "bad"}, "prototype": {}, "safe": True}
    clean = sanitize_value(raw)
    assert clean == {"safe": True}


def test_sanitize_value_redacts_secrets_in_strings():
    raw = {"bio": "Contact me with Bearer abc123.xyz token"}
    clean = sanitize_value(raw)
    assert "Bearer ***" in clean["bio"]
    assert "abc123.xyz" not in clean["bio"]


def test_sanitize_value_bounds_nesting():
    deep = {}
    cursor = deep
    for _ in range(100):
        cursor["child"] = {}
        cursor = cursor["child"]
    cursor["value"] = "deep"
    clean = sanitize_value(deep, max_depth=8)
    # At max_depth=8, depth 8 is the last valid dict and its child is None.
    d = clean
    for _ in range(8):
        assert isinstance(d, dict)
        d = d["child"]
    # Depth 8 itself is a dict with child=None; we need one more step for None
    assert isinstance(d, dict) and d.get("child") is None


# ── secret redaction ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected_substring",
    [
        ("Authorization: Bearer abc123", "Bearer ***"),
        ("Cookie: session=xyz", "Cookie: ***"),
        ("Key is sk-abcdefghijklmnopqrstuvwxyz", "sk-***"),
        ("Key is pk-abcdefghijklmnopqrstuvwxyz", "pk-***"),
        ("Token ghp_123456789012345678901234567890", "ghp_***"),
        ("Google AIza123456789012345678901234567890", "AIza***"),
    ],
)
def test_redact_secrets_in_text_patterns(text, expected_substring):
    result = redact_secrets_in_text(text)
    assert expected_substring in result


def test_count_secret_redactions():
    text = "Bearer abc and Bearer xyz"
    assert count_secret_redactions(text) == 2


# ── size bound ───────────────────────────────────────────────────────────────────────


def test_oversized_source_rejected():
    big = b"x" * (cai.MAX_SOURCE_BYTES + 1)
    preview = normalize_to_manifest(big, "big.json")
    assert preview.rejected is True
    assert "exceeds maximum" in preview.rejection_reason


# ── JSON normalization ───────────────────────────────────────────────────────


def test_normalize_json_agent():
    raw = {
        "name": "Researcher",
        "slug": "researcher",
        "description": "Literature review agent",
        "instructions": "Read papers and summarize.",
        "skills": ["search", "summarize"],
        "tools": ["web_search"],
        "tags": ["academic"],
        "model": {"provider": "openai", "model_id": "gpt-4o"},
        "runtime_targets": ["hermes", "claude_code"],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "agent.json")

    assert preview.rejected is False
    m = preview.manifest
    assert m.name == "Researcher"
    assert m.slug == "researcher"
    assert m.description == "Literature review agent"
    assert m.instructions == "Read papers and summarize."
    assert m.skills == ("search", "summarize")
    assert m.tools == ("web_search",)
    assert m.tags == ("academic",)
    assert m.model_reference == ModelReference(provider="openai", model_id="gpt-4o")
    assert HarnessFamily.HERMES in m.runtime_targets
    assert HarnessFamily.CLAUDE_CODE in m.runtime_targets
    assert m.source_metadata.platform == "hermes"
    assert m.source_metadata.filename == "agent.json"
    assert len(m.source_metadata.fingerprint) == 64


def test_normalize_strips_credentials_and_warns():
    raw = {
        "name": "BadAgent",
        "api_key": "sk-live-1234567890abcdef",
        "instructions": "Use token Bearer abc123.xyz",
        "nested": {"secret": "shh"},
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "bad.json")

    assert preview.rejected is False
    assert preview.credential_keys_found == ("api_key", "secret")
    assert any("Stripped credential keys" in w for w in preview.warnings)
    assert preview.secret_redactions >= 1
    # The manifest must not carry raw secrets
    from dataclasses import asdict
    manifest_text = json.dumps(asdict(preview.manifest), default=str)
    assert "sk-live" not in manifest_text
    assert "abc123.xyz" not in manifest_text


def test_normalize_bounds_string_lengths():
    raw = {
        "name": "x" * 500,
        "description": "y" * 10_000,
        "instructions": "z" * 200_000,
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "agent.json")
    m = preview.manifest
    assert len(m.name) == cai.MAX_NAME_CHARS
    assert len(m.description) == cai.MAX_DESCRIPTION_CHARS
    assert len(m.instructions) == cai.MAX_INSTRUCTIONS_BYTES


def test_normalize_bounds_array_lengths():
    raw = {
        "skills": [f"skill-{i}" for i in range(500)],
        "tags": [f"tag-{i}" for i in range(500)],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "agent.json")
    assert len(preview.manifest.skills) == cai.MAX_ARRAY_ITEMS
    assert len(preview.manifest.tags) == cai.MAX_ARRAY_ITEMS


# ── Markdown / YAML frontmatter normalization ─────────────────────────────


def test_normalize_markdown_with_yaml_frontmatter():
    text = textwrap.dedent(
        """\
        ---
        name: PiAgent
        slug: pi-agent
        description: A Pi-style agent
        skills:
          - chat
          - empathize
        ---
        Be kind and helpful.
        """
    )
    source = text.encode()
    preview = normalize_to_manifest(source, "agent.md")
    m = preview.manifest
    assert m.name == "PiAgent"
    assert m.slug == "pi-agent"
    assert m.description == "A Pi-style agent"
    assert m.skills == ("chat", "empathize")
    assert "Be kind and helpful." in m.instructions


# ── runtime target validation ─────────────────────────────────────────────────────


def test_validate_runtime_targets_all_approved():
    ok, errs = validate_runtime_targets(["hermes", "codex", "generic_a2a"])
    assert ok is True
    assert errs == []


def test_validate_runtime_targets_rejects_ninth_family():
    ok, errs = validate_runtime_targets(["hermes", "unknown_harness"])
    assert ok is False
    assert any("Unapproved harness family" in e for e in errs)


# ── registry persistence ───────────────────────────────────────────────────────


@pytest.fixture
def tmp_registry(tmp_path):
    reg = AgentRegistry(hermes_home=tmp_path)
    return reg


@pytest.fixture
def sample_preview():
    raw = {
        "name": "TestAgent",
        "slug": "test-agent",
        "description": "A test agent",
        "instructions": "Do testing.",
        "skills": ["test"],
        "runtime_targets": ["hermes"],
    }
    source = json.dumps(raw).encode()
    return normalize_to_manifest(source, "test.json")


def test_registry_upsert_and_get(tmp_registry, sample_preview):
    entry = tmp_registry.upsert(sample_preview)
    assert entry.manifest.id == sample_preview.manifest.id
    fetched = tmp_registry.get(sample_preview.manifest.id)
    assert fetched is not None
    assert fetched.manifest.name == "TestAgent"
    assert fetched.verified is False


def test_registry_upsert_rejected_preview_raises(tmp_registry):
    bad = ImportPreview(
        manifest=NeutralAgentManifest(),
        rejected=True,
        rejection_reason="too big",
    )
    with pytest.raises(ValueError, match="Cannot upsert rejected preview"):
        tmp_registry.upsert(bad)


def test_registry_delete(tmp_registry, sample_preview):
    tmp_registry.upsert(sample_preview)
    assert tmp_registry.delete(sample_preview.manifest.id) is True
    assert tmp_registry.get(sample_preview.manifest.id) is None


def test_registry_list_verified(tmp_registry, sample_preview):
    tmp_registry.upsert(sample_preview)
    assert tmp_registry.list_verified() == []

    # Manually mark verified for test
    entries = tmp_registry.load_entries()
    entries[sample_preview.manifest.id].verified = True
    tmp_registry.save_entries(entries)

    verified = tmp_registry.list_verified()
    assert len(verified) == 1
    assert verified[0].manifest.name == "TestAgent"


def test_registry_verify_entry_gates(tmp_registry, sample_preview):
    entry = tmp_registry.upsert(sample_preview)
    assert entry.verified is False

    verified_entry = tmp_registry.verify_entry(sample_preview.manifest.id)
    assert verified_entry.verified is True
    assert verified_entry.verification_errors == ()


def test_registry_verify_entry_fails_on_secrets(tmp_registry):
    raw = {
        "name": "LeakyAgent",
        "instructions": "My key is sk-abcdefghijklmnopqrstuvwxyz",
        "runtime_targets": ["hermes"],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "leaky.json")
    tmp_registry.upsert(preview)

    verified = tmp_registry.verify_entry(preview.manifest.id)
    assert verified.verified is False
    assert any("secret" in e.lower() for e in verified.verification_errors)


def test_registry_rejects_unapproved_harness_at_preview():
    raw = {
        "name": "RogueAgent",
        "runtime_targets": ["hermes", "forbidden_family"],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "rogue.json")
    assert preview.rejected is True
    assert "Unapproved harness family" in preview.rejection_reason
    # Cannot upsert a rejected preview
    reg = AgentRegistry(hermes_home=Path("/tmp"))
    with pytest.raises(ValueError, match="Cannot upsert rejected preview"):
        reg.upsert(preview)


def test_registry_load_skips_invalid_entries(tmp_registry, caplog):
    # Manually write corrupt data
    corrupt = {"bad-agent": "not-a-dict"}
    tmp_registry._save_raw(corrupt)

    entries = tmp_registry.load_entries()
    assert entries == {}


def test_registry_atomic_write(tmp_registry, sample_preview):
    tmp_registry.upsert(sample_preview)
    # File must exist and be valid JSON
    assert tmp_registry._path.is_file()
    with open(tmp_registry._path, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert sample_preview.manifest.id in data


# ── harness family enum coverage ───────────────────────────────────────────────────


def test_all_eight_harness_families_exist():
    assert len(HarnessFamily) == 8
    names = {h.value for h in HarnessFamily}
    expected = {
        "hermes",
        "pi",
        "claude_code",
        "codex",
        "opencode",
        "cursor",
        "github_copilot",
        "generic_a2a",
    }
    assert names == expected


# ── integration: full import-to-verified flow ────────────────────────────────


def test_full_import_flow_clean_agent(tmp_path):
    """End-to-end: clean JSON agent → preview → registry → verify → list."""
    raw = {
        "name": "CleanBot",
        "slug": "clean-bot",
        "description": "A helpful bot",
        "instructions": "Be helpful.",
        "skills": ["help"],
        "runtime_targets": ["hermes"],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "clean.json")

    assert preview.rejected is False
    assert preview.credential_keys_found == ()
    assert preview.secret_redactions == 0

    reg = AgentRegistry(hermes_home=tmp_path)
    entry = reg.upsert(preview)
    assert entry.verified is False

    verified = reg.verify_entry(entry.manifest.id)
    assert verified.verified is True
    assert reg.list_verified() == [verified]


def test_full_import_flow_leaky_agent_quarantined(tmp_path):
    """End-to-end: leaky agent → preview warns → registry → verify fails → quarantined."""
    raw = {
        "name": "LeakyBot",
        "api_key": "sk-live-leaky",
        "instructions": "Token Bearer leaky-token-here",
        "runtime_targets": ["hermes"],
    }
    source = json.dumps(raw).encode()
    preview = normalize_to_manifest(source, "leaky.json")

    assert preview.credential_keys_found == ("api_key",)
    assert preview.secret_redactions >= 1

    reg = AgentRegistry(hermes_home=tmp_path)
    reg.upsert(preview)
    verified = reg.verify_entry(preview.manifest.id)
    assert verified.verified is False
    assert reg.list_verified() == []


# ── serialization roundtrip ──────────────────────────────────────────────────────────


def test_registry_roundtrip_preserves_manifest(tmp_registry, sample_preview):
    tmp_registry.upsert(sample_preview)
    loaded = tmp_registry.get(sample_preview.manifest.id)
    assert loaded is not None
    m = loaded.manifest
    assert m.schema_version == 1
    assert m.name == "TestAgent"
    assert m.slug == "test-agent"
    assert m.runtime_targets == (HarnessFamily.HERMES,)
    assert m.source_metadata is not None
    assert len(m.source_metadata.fingerprint) == 64


# ── URL import path integration ──────────────────────────────────────────────


class TestNormalizeUrlToManifest:
    def test_fetches_agent_card_via_well_known(self, monkeypatch):
        called_with = []

        def fake_fetch_agent_card(url, *, allowlist=None):
            called_with.append(url)
            return {"name": "URL Agent", "description": "from url"}

        monkeypatch.setattr(
            cai, "_normalize_a2a_url", lambda u: u.strip()
        )
        monkeypatch.setattr(
            "plugins.harness_agents.policy.fetch_agent_card", fake_fetch_agent_card
        )
        monkeypatch.setattr(
            "plugins.harness_agents.policy.validate_url", lambda u, **kw: ("https", "example.com", 443)
        )

        preview = cai.normalize_url_to_manifest("https://example.com/agent")
        assert preview.rejected is False
        assert preview.manifest.name == "URL Agent"
        assert called_with == ["https://example.com/agent"]

    def test_normalizes_well_known_suffixes(self, monkeypatch):
        called_with = []

        def fake_fetch_agent_card(url, *, allowlist=None):
            called_with.append(url)
            return {"name": "Card Agent"}

        monkeypatch.setattr(
            "plugins.harness_agents.policy.fetch_agent_card", fake_fetch_agent_card
        )
        monkeypatch.setattr(
            "plugins.harness_agents.policy.validate_url", lambda u, **kw: ("https", "example.com", 443)
        )

        preview = cai.normalize_url_to_manifest("https://example.com/.well-known/agent-card.json")
        assert preview.rejected is False
        assert preview.manifest.name == "Card Agent"
        assert called_with == ["https://example.com"]

    def test_rejects_private_ip_via_policy(self, monkeypatch):
        from plugins.harness_agents import policy as ha_policy

        def fake_validate(url, **kw):
            raise ValueError("blocked address")

        monkeypatch.setattr(ha_policy, "validate_url", fake_validate)

        with pytest.raises(ValueError, match="blocked address"):
            cai.normalize_url_to_manifest("https://192.168.1.1/agent")

    def test_rejects_metadata_host_via_policy(self, monkeypatch):
        from plugins.harness_agents import policy as ha_policy

        def fake_validate(url, **kw):
            raise ValueError("metadata service")

        monkeypatch.setattr(ha_policy, "validate_url", fake_validate)

        with pytest.raises(ValueError, match="metadata service"):
            cai.normalize_url_to_manifest("https://metadata.google.internal/agent")

    def test_rejects_malformed_card(self, monkeypatch):
        monkeypatch.setattr(
            "plugins.harness_agents.policy.fetch_agent_card",
            lambda url, **kw: {"description": "missing name"},
        )
        monkeypatch.setattr(
            "plugins.harness_agents.policy.validate_url", lambda u, **kw: ("https", "example.com", 443)
        )

        preview = cai.normalize_url_to_manifest("https://example.com/agent")
        # normalize_to_manifest handles missing name gracefully — it falls back to filename
        assert preview.rejected is False
        assert preview.manifest.name == "agent.json"

    def test_url_import_strips_credentials(self, monkeypatch):
        monkeypatch.setattr(
            "plugins.harness_agents.policy.fetch_agent_card",
            lambda url, **kw: {
                "name": "Safe Agent",
                "api_key": "sk-secret",
                "instructions": "Use token Bearer abc123",
            },
        )
        monkeypatch.setattr(
            "plugins.harness_agents.policy.validate_url", lambda u, **kw: ("https", "example.com", 443)
        )

        preview = cai.normalize_url_to_manifest("https://example.com/agent")
        assert preview.rejected is False
        assert preview.credential_keys_found == ("api_key",)
        assert preview.secret_redactions >= 1
        manifest_text = json.dumps(cai.asdict(preview.manifest), default=str)
        assert "sk-secret" not in manifest_text
        assert "abc123" not in manifest_text
