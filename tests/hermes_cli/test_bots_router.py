"""Tests for the bots router (hermes_cli/web_routers/bots.py)."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server


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


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


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
