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

    def test_accepts_an_astral_name_at_the_limit(self) -> None:
        # U+10400 is outside the BMP; 25 of them is 25 characters, well under 48
        name = "\U00010400" * 25
        assert registry._bot_name(name) == name

    def test_rejects_an_astral_name_past_the_limit(self) -> None:
        name = "\U00010400" * 49
        with pytest.raises(ValueError, match="48 characters or fewer"):
            registry._bot_name(name)

    def test_comparison_key_ignores_case_and_spacing(self) -> None:
        assert registry._bot_name_key("  Darrell jones ") == "darrell jones"
        assert registry._bot_name_key("DARRELL JONES") == registry._bot_name_key("darrell jones")

    def test_casefold_key_matches_strasse_pair(self) -> None:
        assert registry._bot_name_key("Strasse") == registry._bot_name_key("Stra\u00dfe")

    def test_casefold_key_matches_sharp_s(self) -> None:
        assert registry._bot_name_key("\u00df") == "ss"

    def test_casefold_key_matches_ff_ligature(self) -> None:
        assert registry._bot_name_key("\ufb00") == "ff"

    def test_casefold_key_matches_fi_ligature(self) -> None:
        assert registry._bot_name_key("\ufb01") == "fi"

    def test_casefold_key_matches_greek_sigma_forms(self) -> None:
        sigma = registry._bot_name_key("\u03a3")
        assert registry._bot_name_key("\u03c3") == sigma
        assert registry._bot_name_key("\u03c2") == sigma

    def test_casefold_key_matches_turkish_dotted_i(self) -> None:
        assert registry._bot_name_key("\u0130") == "i\u0307"

    def test_casefold_key_leaves_fullwidth_darrell_different(self) -> None:
        assert registry._bot_name_key("\uff24arrell") != registry._bot_name_key("darrell")

    def test_casefold_key_leaves_composed_decomposed_different(self) -> None:
        assert registry._bot_name_key("\u00e9") != registry._bot_name_key("e\u0301")


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


class TestRendererTablesMatchTheInterpreter:
    """The checked-in JSON tables must match the interpreter that generates them."""

    def test_alpha_ranges_match_the_running_interpreter(self) -> None:
        import unicodedata

        alpha_ranges_path = (
            Path(__file__).resolve().parents[3]
            / "apps"
            / "desktop"
            / "src"
            / "plugins"
            / "operations"
            / "bot-name-alpha-ranges.json"
        )
        stored = json.loads(alpha_ranges_path.read_text(encoding="utf-8"))

        expected = []
        start = None
        prev = None
        for cp in range(0x110000):
            if 0xD800 <= cp <= 0xDFFF:
                continue
            ch = chr(cp)
            if ch.isalpha():
                if start is None:
                    start = cp
                    prev = cp
                elif cp == prev + 1:
                    prev = cp
                else:
                    expected.append([start, prev])
                    start = cp
                    prev = cp
        if start is not None:
            expected.append([start, prev])

        assert stored == expected, f"Regenerate with scripts/generate_tables.py on Python {unicodedata.unidata_version}"

    def test_whitespace_ranges_match_the_running_interpreter(self) -> None:
        import unicodedata

        whitespace_ranges_path = (
            Path(__file__).resolve().parents[3]
            / "apps"
            / "desktop"
            / "src"
            / "plugins"
            / "operations"
            / "bot-name-whitespace-ranges.json"
        )
        stored = json.loads(whitespace_ranges_path.read_text(encoding="utf-8"))

        expected = []
        start = None
        prev = None
        for cp in range(0x110000):
            if 0xD800 <= cp <= 0xDFFF:
                continue
            ch = chr(cp)
            if ch.isspace():
                if start is None:
                    start = cp
                    prev = cp
                elif cp == prev + 1:
                    prev = cp
                else:
                    expected.append([start, prev])
                    start = cp
                    prev = cp
        if start is not None:
            expected.append([start, prev])

        assert stored == expected, f"Regenerate with scripts/check_whitespace.py on Python {unicodedata.unidata_version}"

    def test_casefold_map_matches_the_running_interpreter(self) -> None:
        casefold_path = (
            Path(__file__).resolve().parents[3]
            / "apps"
            / "desktop"
            / "src"
            / "plugins"
            / "operations"
            / "bot-name-casefold.json"
        )
        stored = json.loads(casefold_path.read_text(encoding="utf-8"))

        expected = {}
        for cp in range(0x110000):
            if 0xD800 <= cp <= 0xDFFF:
                continue
            ch = chr(cp)
            lower = ch.lower()
            casefold = ch.casefold()
            if lower != casefold:
                expected[str(cp)] = casefold

        assert stored == expected, "Regenerate with scripts/generate_tables.py"


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
