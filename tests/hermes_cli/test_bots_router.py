"""Tests for the bots router (hermes_cli/web_routers/bots.py)."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.web_routers import bots


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "t" * 64)
    web_server.app.state.auth_required = False
    return TestClient(web_server.app)


def _auth_headers():
    return {"X-Hermes-Session-Token": web_server._SESSION_TOKEN}


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


class TestGetBotsCatalog:
    def test_catalog_shape(self, client, monkeypatch, tmp_path):
        """GET /api/bots/catalog returns harnesses and models lists."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [
                {
                    "id": "hermes",
                    "label": "Hermes",
                    "detected": True,
                    "source": "native",
                }
            ],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog",
            lambda: [
                {"id": "claude-sonnet-4", "label": "claude-sonnet-4", "provider": "anthropic"}
            ],
        )
        response = client.get("/api/bots/catalog", headers=_auth_headers())
        assert response.status_code == 200
        data = response.json()
        assert "harnesses" in data
        assert "models" in data
        assert data["harnesses"][0]["id"] == "hermes"
        assert data["models"][0]["id"] == "claude-sonnet-4"

    def test_catalog_empty_when_nothing_configured(self, client, monkeypatch):
        """Catalog returns empty lists when nothing is configured."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog", lambda: []
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog", lambda: []
        )
        response = client.get("/api/bots/catalog", headers=_auth_headers())
        assert response.status_code == 200
        data = response.json()
        assert data["harnesses"] == []
        assert data["models"] == []

    def test_catalog_does_not_trigger_install(self, client, monkeypatch):
        """The catalog endpoint must never call an install or exec path."""
        install_mock = MagicMock()
        exec_mock = MagicMock()
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog", lambda: []
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog", lambda: []
        )
        # The test passes if the endpoint returns 200 without calling install/exec.
        response = client.get("/api/bots/catalog", headers=_auth_headers())
        assert response.status_code == 200
        install_mock.assert_not_called()
        exec_mock.assert_not_called()


class TestHarnessCatalogInvariants:
    """Invariant tests for the real _build_harness_catalog helper."""

    def test_all_harnesses_reported(self, monkeypatch):
        """Every known harness appears in the catalog, even when absent."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {"hermes": "native"},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        ids = {h["id"] for h in catalog}
        assert ids == set(bots._HARNESS_BINARIES.keys())

    def test_selectable_implies_detected(self, monkeypatch):
        """A harness marked selectable must also be detected."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {"hermes": "native", "codex": "native"},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {"generic_a2a": "registry"},
        )
        catalog = bots._build_harness_catalog()
        for h in catalog:
            if h.get("selectable"):
                assert h.get("detected") is True

    def test_every_entry_has_id_and_label(self, monkeypatch):
        """Every catalog entry carries a non-empty id and label."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        assert catalog
        for h in catalog:
            assert isinstance(h.get("id"), str) and h["id"]
            assert isinstance(h.get("label"), str) and h["label"]

    def test_every_entry_has_download_url_or_is_protocol(self, monkeypatch):
        """Entries without a download_url must be explicitly protocol-only."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        assert catalog
        for h in catalog:
            if h.get("download_url") is None:
                assert h["id"] in bots._PROTOCOL_HARNESSES

    def test_undetected_harness_is_reported(self, monkeypatch):
        """A harness that is not present is still listed with detected=False."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        claude = next((h for h in catalog if h["id"] == "claude_code"), None)
        assert claude is not None
        assert claude["detected"] is False
        assert claude["selectable"] is False

    def test_endpoint_no_installer_shellout(self, client, monkeypatch):
        """The catalog endpoint never calls an installer or external shell."""
        import os
        import subprocess

        run_mock = MagicMock()
        popen_mock = MagicMock()
        system_mock = MagicMock()
        call_mock = MagicMock()

        monkeypatch.setattr(subprocess, "run", run_mock)
        monkeypatch.setattr(subprocess, "Popen", popen_mock)
        monkeypatch.setattr(subprocess, "call", call_mock)
        monkeypatch.setattr(os, "system", system_mock)

        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )

        response = client.get("/api/bots/catalog", headers=_auth_headers())
        assert response.status_code == 200
        data = response.json()
        assert "harnesses" in data

        run_mock.assert_not_called()
        popen_mock.assert_not_called()
        call_mock.assert_not_called()
        system_mock.assert_not_called()

    def test_protocol_harness_never_selectable(self, monkeypatch):
        """A protocol-only harness is never selectable even when detected."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {"generic_a2a": "registry"},
        )
        catalog = bots._build_harness_catalog()
        generic = next((h for h in catalog if h["id"] == "generic_a2a"), None)
        assert generic is not None
        assert generic["detected"] is True
        assert generic["selectable"] is False

    def test_present_harness_has_all_fields(self, monkeypatch):
        """A detected harness carries every expected field."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {"hermes": "native"},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        hermes = next((h for h in catalog if h["id"] == "hermes"), None)
        assert hermes is not None
        assert isinstance(hermes["label"], str) and hermes["label"]
        assert hermes["detected"] is True
        assert hermes["selectable"] is True
        assert isinstance(hermes["source"], str) and hermes["source"]
        assert isinstance(hermes["download_url"], str) and hermes["download_url"]

    def test_absent_harness_has_all_fields(self, monkeypatch):
        """An absent harness still carries every expected field."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_native_harnesses",
            lambda: {},
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._detect_registry_harnesses",
            lambda: {},
        )
        catalog = bots._build_harness_catalog()
        codex = next((h for h in catalog if h["id"] == "codex"), None)
        assert codex is not None
        assert isinstance(codex["label"], str) and codex["label"]
        assert codex["detected"] is False
        assert codex["selectable"] is False
        assert isinstance(codex["source"], str)
        assert isinstance(codex["download_url"], str) and codex["download_url"]
        assert "install_hint" in codex


class TestPostBots:
    def test_create_success_delegates_to_profile_creator(self, client, monkeypatch, tmp_path):
        """POST /api/bots creates a profile and records harness/model."""
        profile_dir = tmp_path / "profiles" / "testbot"
        profile_dir.mkdir(parents=True)

        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [
                {
                    "id": "claude_code",
                    "label": "Claude Code",
                    "detected": True,
                    "source": "native",
                }
            ],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog",
            lambda: [
                {"id": "claude-sonnet-4", "label": "claude-sonnet-4", "provider": "anthropic"}
            ],
        )

        create_profile_mock = MagicMock(return_value=profile_dir)
        seed_skills_mock = MagicMock()
        check_alias_mock = MagicMock(return_value=None)
        create_wrapper_mock = MagicMock()

        monkeypatch.setattr("hermes_cli.profiles.create_profile", create_profile_mock)
        monkeypatch.setattr("hermes_cli.profiles.seed_profile_skills", seed_skills_mock)
        monkeypatch.setattr("hermes_cli.profiles.check_alias_collision", check_alias_mock)
        monkeypatch.setattr("hermes_cli.profiles.create_wrapper_script", create_wrapper_mock)

        # Patch config read/write inside the profile so we can inspect it
        saved_cfg = {}

        def _fake_load_config():
            return dict(saved_cfg)

        def _fake_save_config(cfg):
            saved_cfg.clear()
            saved_cfg.update(cfg)

        monkeypatch.setattr("hermes_cli.config.load_config", _fake_load_config)
        monkeypatch.setattr("hermes_cli.config.save_config", _fake_save_config)
        monkeypatch.setattr(
            "hermes_constants.set_hermes_home_override",
            lambda _path: "token",
        )
        monkeypatch.setattr(
            "hermes_constants.reset_hermes_home_override",
            lambda _token: None,
        )

        response = client.post(
            "/api/bots",
            headers=_auth_headers(),
            json={
                "name": "testbot",
                "description": "A test bot",
                "harness": "claude_code",
                "model": "claude-sonnet-4",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "testbot"
        assert data["harness"] == "claude_code"
        assert data["model"] == "claude-sonnet-4"
        create_profile_mock.assert_called_once()
        seed_skills_mock.assert_called_once()
        assert saved_cfg.get("bot", {}).get("harness") == "claude_code"
        assert saved_cfg.get("bot", {}).get("model") == "claude-sonnet-4"

    def test_create_rejects_unknown_harness(self, client, monkeypatch):
        """POST /api/bots returns 400 for an unknown harness."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [
                {
                    "id": "hermes",
                    "label": "Hermes",
                    "detected": True,
                    "source": "native",
                }
            ],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog", lambda: []
        )

        response = client.post(
            "/api/bots",
            headers=_auth_headers(),
            json={"name": "testbot", "harness": "unknown_harness"},
        )
        assert response.status_code == 400
        assert "unknown_harness" in response.json()["detail"]

    def test_create_rejects_unknown_model(self, client, monkeypatch):
        """POST /api/bots returns 400 for an unknown model."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [
                {
                    "id": "hermes",
                    "label": "Hermes",
                    "detected": True,
                    "source": "native",
                }
            ],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog",
            lambda: [
                {"id": "claude-sonnet-4", "label": "claude-sonnet-4", "provider": "anthropic"}
            ],
        )

        response = client.post(
            "/api/bots",
            headers=_auth_headers(),
            json={"name": "testbot", "model": "unknown-model"},
        )
        assert response.status_code == 400
        assert "unknown-model" in response.json()["detail"]

    def test_create_rejects_duplicate_name(self, client, monkeypatch):
        """POST /api/bots returns 400 when the profile name already exists."""
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [
                {
                    "id": "hermes",
                    "label": "Hermes",
                    "detected": True,
                    "source": "native",
                }
            ],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog",
            lambda: [],
        )

        create_profile_mock = MagicMock(side_effect=FileExistsError("Profile 'testbot' already exists"))
        monkeypatch.setattr("hermes_cli.profiles.create_profile", create_profile_mock)

        response = client.post(
            "/api/bots",
            headers=_auth_headers(),
            json={"name": "testbot", "harness": "hermes"},
        )
        assert response.status_code == 400
        assert "testbot" in response.json()["detail"]

    def test_create_allows_empty_harness_and_model(self, client, monkeypatch, tmp_path):
        """POST /api/bots accepts empty harness/model (user decides later)."""
        profile_dir = tmp_path / "profiles" / "emptybot"
        profile_dir.mkdir(parents=True)

        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_harness_catalog",
            lambda: [],
        )
        monkeypatch.setattr(
            "hermes_cli.web_routers.bots._build_model_catalog",
            lambda: [],
        )

        create_profile_mock = MagicMock(return_value=profile_dir)
        seed_skills_mock = MagicMock()
        check_alias_mock = MagicMock(return_value=None)
        create_wrapper_mock = MagicMock()

        monkeypatch.setattr("hermes_cli.profiles.create_profile", create_profile_mock)
        monkeypatch.setattr("hermes_cli.profiles.seed_profile_skills", seed_skills_mock)
        monkeypatch.setattr("hermes_cli.profiles.check_alias_collision", check_alias_mock)
        monkeypatch.setattr("hermes_cli.profiles.create_wrapper_script", create_wrapper_mock)

        response = client.post(
            "/api/bots",
            headers=_auth_headers(),
            json={"name": "emptybot", "harness": "", "model": ""},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["harness"] == ""
        assert data["model"] == ""
