"""Bot creation dashboard routes.

Provides the backend surface the Make a Bot dialog needs:
- harness discovery from what is already on disk
- model discovery from configured providers (no network calls)
- bot creation that delegates to the public profile creator
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_constants import get_hermes_home

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------


class BotCreate(BaseModel):
    name: str
    description: str = ""
    harness: str = ""
    model: str = ""


# ---------------------------------------------------------------------------
# Harness catalog helpers
# ---------------------------------------------------------------------------

_HARNESS_BINARIES: Dict[str, List[str]] = {
    "hermes": ["hermes"],
    "pi": ["pi"],
    "claude_code": ["claude"],
    "codex": ["codex"],
    "opencode": ["opencode"],
    "cursor": ["cursor"],
    "github_copilot": ["gh"],
    "generic_a2a": [],
}

_HARNESS_LABELS: Dict[str, str] = {
    "hermes": "Hermes",
    "pi": "Pi",
    "claude_code": "Claude Code",
    "codex": "Codex",
    "opencode": "OpenCode",
    "cursor": "Cursor",
    "github_copilot": "GitHub Copilot",
    "generic_a2a": "Generic A2A",
}


def _detect_native_harnesses() -> Dict[str, str]:
    """Return harness_id -> 'native' for binaries found on PATH."""
    detected: Dict[str, str] = {}
    for harness_id, binaries in _HARNESS_BINARIES.items():
        for binary in binaries:
            if shutil.which(binary):
                detected[harness_id] = "native"
                break
    # Hermes itself is always present because this code is running inside it.
    detected["hermes"] = "native"
    return detected


def _detect_registry_harnesses() -> Dict[str, str]:
    """Return harness_id -> 'registry' for harnesses stored in HarnessRegistry."""
    detected: Dict[str, str] = {}
    try:
        from plugins.harness_agents.registry import HarnessRegistry

        registry_path = get_hermes_home() / "harness-agents.db"
        if not registry_path.exists():
            return detected
        registry = HarnessRegistry(registry_path)
        try:
            agents = registry.list_agents()
            for agent in agents:
                harness = str(agent.get("harness") or "").strip()
                if harness and harness not in detected:
                    detected[harness] = "registry"
        finally:
            registry.close()
    except Exception:
        _log.exception("Failed to read harness registry for catalog")
    return detected


def _build_harness_catalog() -> List[Dict[str, Any]]:
    """Build the harness catalog from native detection + registry."""
    catalog: Dict[str, Dict[str, Any]] = {}

    # Native detection first (strongest signal)
    for harness_id, source in _detect_native_harnesses().items():
        catalog[harness_id] = {
            "id": harness_id,
            "label": _HARNESS_LABELS.get(harness_id, harness_id),
            "detected": True,
            "source": source,
        }

    # Registry entries fill gaps
    for harness_id, source in _detect_registry_harnesses().items():
        if harness_id not in catalog:
            catalog[harness_id] = {
                "id": harness_id,
                "label": _HARNESS_LABELS.get(harness_id, harness_id),
                "detected": True,
                "source": source,
            }

    return list(catalog.values())


# ---------------------------------------------------------------------------
# Model catalog helpers
# ---------------------------------------------------------------------------


def _build_model_catalog() -> List[Dict[str, str]]:
    """Build the model catalog from configured providers (no network)."""
    models: List[Dict[str, str]] = []
    seen: set = set()

    try:
        from hermes_cli.config import cfg_get, load_config_readonly

        cfg = load_config_readonly()
    except Exception:
        _log.exception("Failed to load config for model catalog")
        return models

    providers: List[str] = []

    # Main provider
    main_provider = str(cfg_get(cfg, "model", "provider", default="") or "").strip()
    if main_provider:
        providers.append(main_provider)

    # Custom providers
    custom_providers = cfg.get("custom_providers") or []
    if isinstance(custom_providers, list):
        for entry in custom_providers:
            if isinstance(entry, dict):
                slug = str(entry.get("id") or entry.get("slug") or "").strip()
                if slug and slug not in providers:
                    providers.append(slug)

    # Fallback providers
    fallback_providers = cfg.get("fallback_providers") or []
    if isinstance(fallback_providers, list):
        for entry in fallback_providers:
            if isinstance(entry, dict):
                slug = str(entry.get("provider") or "").strip()
                if slug and slug not in providers:
                    providers.append(slug)

    from agent.models_dev import list_provider_models

    for provider in providers:
        try:
            provider_models = list_provider_models(provider, allow_network=False)
            for model_id in provider_models:
                key = f"{provider}/{model_id}"
                if key in seen:
                    continue
                seen.add(key)
                models.append(
                    {
                        "id": model_id,
                        "label": model_id,
                        "provider": provider,
                    }
                )
        except Exception:
            _log.exception("Failed to list models for provider %s", provider)

    return models


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/bots/catalog")
async def get_bots_catalog():
    """Return harnesses and models available on this machine."""
    return {
        "harnesses": _build_harness_catalog(),
        "models": _build_model_catalog(),
    }


@router.post("/api/bots")
async def create_bot_endpoint(body: BotCreate):
    """Create a new Bot (profile) with optional harness/model choice."""
    from hermes_cli import profiles as profiles_mod

    # Build catalog for validation
    harness_catalog = _build_harness_catalog()
    model_catalog = _build_model_catalog()

    valid_harnesses = {h["id"] for h in harness_catalog}
    valid_models = {m["id"] for m in model_catalog}

    harness = (body.harness or "").strip()
    model = (body.model or "").strip()

    if harness and harness not in valid_harnesses:
        raise HTTPException(
            status_code=400,
            detail=f"Harness '{harness}' is not in the catalog",
        )
    if model and model not in valid_models:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{model}' is not in the catalog",
        )

    try:
        path = profiles_mod.create_profile(
            name=body.name,
            description=body.description or None,
        )
        profiles_mod.seed_profile_skills(path, quiet=True)
        collision = profiles_mod.check_alias_collision(body.name)
        if not collision:
            profiles_mod.create_wrapper_script(body.name)
    except (ValueError, FileExistsError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _log.exception("POST /api/bots failed")
        raise HTTPException(status_code=500, detail=str(e))

    # Record harness/model on the profile config
    if harness or model:
        try:
            from hermes_constants import (
                reset_hermes_home_override,
                set_hermes_home_override,
            )
            from hermes_cli.config import load_config, save_config

            token = set_hermes_home_override(str(path))
            try:
                cfg = load_config()
                bot_cfg = cfg.setdefault("bot", {})
                if harness:
                    bot_cfg["harness"] = harness
                if model:
                    bot_cfg["model"] = model
                save_config(cfg)
            finally:
                reset_hermes_home_override(token)
        except Exception:
            _log.exception("Writing bot harness/model for profile %s failed", body.name)

    return {
        "name": body.name,
        "path": str(path),
        "harness": harness,
        "model": model,
    }
