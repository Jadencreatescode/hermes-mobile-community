"""Tests for Bot naming: the name rules, the rename write, and name conflicts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from plugins.harness_agents import registry


def make_agent(db: registry.HarnessRegistry, agent_id: str, name: str, label: str = "") -> dict:
    return db.create_agent(
        {
            "id": agent_id,
            "name": name,
            "handle": agent_id.replace(":", "-"),
            "description": "",
            "harness": "generic_a2a",
            "host_id": label or agent_id,
            "host_label": label or agent_id,
            "connector_url": "https://example.com/agent",
            "auth_env": "",
            "team_id": "",
        }
    )


class TestBotNameRules:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Darrell", "Darrell"),
            ("  Darrell  ", "Darrell"),
            ("Mary   Jane", "Mary Jane"),
            ("O'Brien", "O'Brien"),
            ("Anne-Marie", "Anne-Marie"),
            ("M\u00fcller", "M\u00fcller"),
            ("\u4e2d\u6587\u540d", "\u4e2d\u6587\u540d"),
        ],
    )
    def test_accepts_plain_names(self, raw: str, expected: str) -> None:
        assert registry._bot_name(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        ["", "   ", None, "Darrell!", "agent_1", "Darrell;drop", "R2 Unit", "a" * 49],
    )
    def test_rejects_unusable_names(self, raw) -> None:
        with pytest.raises(ValueError):
            registry._bot_name(raw)

    def test_rejects_a_name_without_letters(self) -> None:
        with pytest.raises(ValueError, match="must contain letters"):
            registry._bot_name("12 34")

    def test_rejects_too_many_words(self) -> None:
        with pytest.raises(ValueError, match="5 words or fewer"):
            registry._bot_name("one two three four five six")

    def test_rejects_too_many_characters(self) -> None:
        with pytest.raises(ValueError, match="48 characters or fewer"):
            registry._bot_name("Darrell " + "a" * 45)

    def test_comparison_key_ignores_case_and_spacing(self) -> None:
        assert registry._bot_name_key("  Darrell jones ") == "darrell jones"
        assert registry._bot_name_key("DARRELL JONES") == registry._bot_name_key("darrell jones")


class TestSharedNameCases:
    """The same fixture the renderer suite reads, so the two rules cannot drift."""

    @staticmethod
    def cases() -> list[dict]:
        path = Path(__file__).resolve().parents[2] / "fixtures" / "bot_name_cases.json"
        return json.loads(path.read_text(encoding="utf-8"))["cases"]

    def test_fixture_is_readable_and_covers_both_verdicts(self) -> None:
        cases = self.cases()
        assert len(cases) >= 20
        assert any(case["valid"] for case in cases)
        assert any(not case["valid"] for case in cases)

    @pytest.mark.parametrize("case", cases())
    def test_backend_rule_matches_the_shared_verdict(self, case: dict) -> None:
        raw = case["name"]
        if case["valid"]:
            normalized = registry._bot_name(raw)
            assert normalized
            assert len(normalized) <= registry._BOT_NAME_MAX_CHARS
            assert len(normalized.split(" ")) <= registry._BOT_NAME_MAX_WORDS
            assert normalized == registry._bot_name(normalized)
        else:
            with pytest.raises(ValueError):
                registry._bot_name(raw)


class TestRenameAgent:
    def test_rename_changes_the_display_name(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Bridge Goose")
        renamed = db.rename_agent("a2a:one", "Darrell")
        assert renamed["name"] == "Darrell"
        assert db.get_agent("a2a:one")["name"] == "Darrell"
        db.close()

    def test_rename_keeps_the_id_and_handle_stable(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Bridge Goose")
        renamed = db.rename_agent("a2a:one", "Darrell")
        assert renamed["id"] == "a2a:one"
        assert renamed["handle"] == "a2a-one"
        assert renamed["connector_url"] == "https://example.com/agent"
        db.close()

    def test_rename_rejects_an_unknown_agent(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        with pytest.raises(ValueError, match="unknown agent"):
            db.rename_agent("a2a:missing", "Darrell")
        db.close()

    def test_rename_rejects_an_unusable_name(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Bridge Goose")
        with pytest.raises(ValueError):
            db.rename_agent("a2a:one", "Darrell!")
        assert db.get_agent("a2a:one")["name"] == "Bridge Goose"
        db.close()

    def test_rename_records_nothing_but_the_name(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        created = make_agent(db, "a2a:one", "Bridge Goose")
        renamed = db.rename_agent("a2a:one", "Darrell")
        assert renamed["created_at"] == created["created_at"]
        assert renamed["verification_state"] == created["verification_state"]
        db.close()


class TestNameConflicts:
    def test_reports_another_bot_with_the_same_name(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Darrell", label="studio")
        make_agent(db, "a2a:two", "Goose", label="laptop")
        conflicts = db.name_conflicts("Darrell", exclude_id="a2a:two")
        assert [item["agent_id"] for item in conflicts] == ["a2a:one"]
        assert conflicts[0]["label"] == "studio"
        db.close()

    def test_ignores_case_and_extra_spacing(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Darrell Jones")
        assert db.name_conflicts("  darrell   jones  ") != []
        db.close()

    def test_excludes_the_bot_being_renamed(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Darrell")
        assert db.name_conflicts("Darrell", exclude_id="a2a:one") == []
        db.close()

    def test_no_conflict_for_a_fresh_name(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Darrell")
        assert db.name_conflicts("Marisol") == []
        db.close()

    def test_empty_name_has_no_conflicts(self, tmp_path: Path) -> None:
        db = registry.HarnessRegistry(tmp_path / "agents.db")
        make_agent(db, "a2a:one", "Darrell")
        assert db.name_conflicts("   ") == []
        db.close()
