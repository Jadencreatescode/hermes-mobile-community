"""Tests for the A2A agent rename endpoint.

The rename changes only the displayed name, keeps the id and handle stable, and
returns a warning when another Bot already uses the name instead of failing.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("operations_plugin_api_test_rename", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def request_json(app: FastAPI, method: str, path: str, payload=None, headers=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://operations.test") as client:
        return await client.request(method, path, json=payload, headers=headers)


@pytest.fixture
def api_module(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: tmp_path / "harness_agents.db")
    monkeypatch.setattr(api, "_a2a_catalog_path", lambda: tmp_path / "agent_cards.db")
    api._a2a_rate_limiter._user_buckets.clear()
    api._a2a_rate_limiter._global_bucket.clear()
    return api


@pytest.fixture
def app(api_module):
    application = FastAPI()
    application.include_router(api_module.router)
    return application


@pytest.fixture
def registry_rows(api_module, tmp_path):
    """Seed two connected agents straight into the registry the endpoint reads."""
    from plugins.harness_agents.registry import HarnessRegistry

    db = HarnessRegistry(tmp_path / "harness_agents.db")
    for agent_id, name, label in (
        ("a2a:one", "Bridge Goose", "studio"),
        ("a2a:two", "Goose", "laptop"),
    ):
        db.create_agent(
            {
                "id": agent_id,
                "name": name,
                "handle": agent_id.replace(":", "-"),
                "description": "",
                "harness": "generic_a2a",
                "host_id": label,
                "host_label": label,
                "connector_url": "https://example.com/agent",
                "auth_env": "",
                "team_id": "",
            }
        )
    db.close()
    return tmp_path / "harness_agents.db"


class TestRenameEndpoint:
    def test_rename_changes_the_name(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "Darrell"}))
        assert resp.status_code == 200
        body = resp.json()
        assert body["agent_id"] == "a2a:one"
        assert body["name"] == "Darrell"
        assert body["warnings"] == []

    def test_rename_is_visible_on_the_next_read(self, app, registry_rows):
        asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "Darrell"}))
        listing = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        names = {row["agent_id"]: row["name"] for row in listing.json()["agents"]}
        assert names["a2a:one"] == "Darrell"
        assert names["a2a:two"] == "Goose"

    def test_rename_normalizes_spacing(self, app, registry_rows):
        resp = asyncio.run(
            request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "  Mary   Jane  "})
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Mary Jane"

    def test_duplicate_name_warns_but_still_renames(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "goose"}))
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "goose"
        assert len(body["warnings"]) == 1
        assert "laptop" in body["warnings"][0]

    def test_renaming_a_bot_to_its_own_name_does_not_warn(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "Bridge Goose"}))
        assert resp.status_code == 200
        assert resp.json()["warnings"] == []

    @pytest.mark.parametrize(
        "bad_name",
        ["Darrell!", "R2 Unit", "one two three four five six", "a" * 49, "123"],
    )
    def test_rejected_name_explains_itself_and_writes_nothing(self, app, registry_rows, bad_name):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": bad_name}))
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "a2a_name_rejected"
        assert detail["reason"]
        listing = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        names = {row["agent_id"]: row["name"] for row in listing.json()["agents"]}
        assert names["a2a:one"] == "Bridge Goose"

    def test_empty_name_is_refused_before_the_registry_is_touched(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "   "}))
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "a2a_name_rejected"

    def test_unknown_agent_is_not_found(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:missing", {"name": "Darrell"}))
        assert resp.status_code == 404
        assert resp.json()["detail"] == "a2a_agent_not_found"

    def test_missing_name_field_is_refused_by_the_schema(self, app, registry_rows):
        resp = asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {}))
        assert resp.status_code == 422

    def test_rename_is_recorded_in_the_audit_trail(self, app, registry_rows):
        from plugins.harness_agents.registry import HarnessRegistry

        asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": "Darrell"}))
        db = HarnessRegistry(registry_rows)
        with db._connection:  # noqa: SLF001 - read only assertion on the audit table
            rows = db._connection.execute(
                "SELECT event_type, outcome FROM agent_events WHERE agent_id = ?",
                ("a2a:one",),
            ).fetchall()
        db.close()
        assert ("rename", "succeeded") in {(row["event_type"], row["outcome"]) for row in rows}

    def test_rename_of_the_other_bot_leaves_the_first_alone(self, app, registry_rows):
        asyncio.run(request_json(app, "PATCH", "/agents/a2a/a2a:two", {"name": "Marisol"}))
        listing = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        names = {row["agent_id"]: row["name"] for row in listing.json()["agents"]}
        assert names == {"a2a:one": "Bridge Goose", "a2a:two": "Marisol"}


def shared_name_cases() -> list[dict]:
    path = ROOT / "tests" / "fixtures" / "bot_name_cases.json"
    return json.loads(path.read_text(encoding="utf-8"))["cases"]


class TestSharedNameCasesAtTheRoute:
    """The route agrees with the same fixture the backend rule and the renderer read."""

    @pytest.mark.parametrize("case", shared_name_cases())
    def test_route_matches_the_shared_verdict(self, app, registry_rows, case):
        resp = asyncio.run(
            request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": case["name"]})
        )
        if case["valid"]:
            assert resp.status_code == 200, case["why"]
            assert resp.json()["name"] == " ".join(case["name"].split())
        else:
            # A nameless request is refused by the request schema before the route
            # reads it; every other unusable name is refused by the name rule itself.
            assert resp.status_code in (400, 422), case["why"]
            if resp.status_code == 400:
                assert resp.json()["detail"]["error"] == "a2a_name_rejected"

    def test_a_refused_name_leaves_every_bot_untouched(self, app, api_module, registry_rows):
        for case in shared_name_cases():
            if case["valid"]:
                continue
            resp = asyncio.run(
                request_json(app, "PATCH", "/agents/a2a/a2a:one", {"name": case["name"]})
            )
            assert resp.status_code in (400, 422), case["why"]

        api_module._a2a_rate_limiter._user_buckets.clear()
        api_module._a2a_rate_limiter._global_bucket.clear()
        listing = asyncio.run(request_json(app, "GET", "/agents/a2a"))
        names = {row["agent_id"]: row["name"] for row in listing.json()["agents"]}
        assert names == {"a2a:one": "Bridge Goose", "a2a:two": "Goose"}
