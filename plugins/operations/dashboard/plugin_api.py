"""Authenticated public Operations plugin API.

The router owns only bounded Mailroom metadata and dispatches through the
existing Bot Mode delivery path. It never returns commands, process handles,
credentials, endpoint URLs, environment values, or lease tokens.
"""

from __future__ import annotations

import importlib.util
import hashlib
import json
import shlex
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

try:
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover
    def get_hermes_home() -> Path:
        return Path.home() / ".hermes"


def _load_store_module():
    path = Path(__file__).with_name("mailroom_store.py")
    name = "hermes_operations_mailroom_store"
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Operations Mailroom store could not load")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


store_module = _load_store_module()
MailroomStore = store_module.MailroomStore
CriticalPolicyDenied = store_module.CriticalPolicyDenied
DuplicateKeyConflict = store_module.DuplicateKeyConflict
InvalidTransition = store_module.InvalidTransition
MAX_BODY_CHARS = store_module.MAX_BODY_CHARS
MAX_DEDUPE_KEY_CHARS = store_module.MAX_DEDUPE_KEY_CHARS
MAX_LIST_LIMIT = store_module.MAX_LIST_LIMIT
MAX_POLICY_TTL_SECONDS = store_module.MAX_POLICY_TTL_SECONDS
MAX_SESSION_REF_CHARS = store_module.MAX_SESSION_REF_CHARS


def _load_meeting_store_module():
    path = Path(__file__).with_name("meeting_store.py")
    name = "hermes_operations_meeting_store"
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Operations meeting store could not load")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


meeting_store_module = _load_meeting_store_module()
MeetingStore = meeting_store_module.MeetingStore
MeetingVersionConflict = meeting_store_module.VersionConflict
ImmutableMeetingHistory = meeting_store_module.ImmutableMeetingHistory

router = APIRouter()


def _clock() -> float:
    return time.time()


def _db_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "mailroom.db"


def _store() -> MailroomStore:
    return MailroomStore(_db_path(), clock=_clock)


def _meeting_db_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "meetings.db"


def _meeting_store() -> MeetingStore:
    return MeetingStore(_meeting_db_path(), clock=_clock)


def _known_profiles() -> list[str]:
    from tools.bot_mode_dm import _hermes_root, _local_roster

    home = Path(get_hermes_home())
    return _local_roster(_hermes_root(home))


def _require_known_profile(value: str, field: str) -> str:
    matches = [profile for profile in _known_profiles() if profile.lower() == value.lower()]
    if not matches:
        raise HTTPException(status_code=404, detail=f"{field} is not a local Hermes profile")
    return matches[0]


def _launch_delivery(source_profile: str, target_profile: str, body: str, urgency: str) -> str:
    """Launch the established asynchronous Bot Chat delivery and return its private handle."""
    from tools.bot_mode_dm import _handle, _spawn_delivery, _write_dm_file

    safe_body = body
    if urgency == "critical":
        safe_body = "[CRITICAL: cooperative safe checkpoint requested; do not cancel running work.] " + body
    prefix = f"Message from user via Mailroom (@{_handle(source_profile)}): "
    message_file = _write_dm_file(prefix + safe_body)
    command = (
        f"hermes -p {shlex.quote(target_profile)} chat --in ~ -c \"Bot Chat\" "
        f"--create-if-missing -Q --query-file {shlex.quote(message_file)}"
    )
    raw = _spawn_delivery(command, f"@{_handle(target_profile)}", task_id=None, agent=None)
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("delivery returned an invalid acknowledgement") from exc
    if payload.get("error"):
        raise RuntimeError("delivery could not start")
    process_id = str(payload.get("process_id") or "")
    if not process_id:
        raise RuntimeError("delivery returned no tracked process")
    return process_id


def _watch_delivery(db_path: Path, envelope_id: str, process_id: str) -> None:
    try:
        from tools.process_registry import process_registry

        session = process_registry.get(process_id)
        if session is None:
            MailroomStore(db_path).record_delivery(envelope_id, delivered=False)
            return
        session._completion_event.wait()
        MailroomStore(db_path).record_delivery(envelope_id, delivered=session.exit_code == 0)
    except Exception:
        try:
            MailroomStore(db_path).record_delivery(envelope_id, delivered=False)
        except Exception:
            pass


def _start_delivery_watch(db_path: Path, envelope_id: str, process_id: str) -> None:
    threading.Thread(
        target=_watch_delivery,
        args=(db_path, envelope_id, process_id),
        daemon=True,
        name=f"operations-mailroom-{envelope_id[:12]}",
    ).start()


class MailCreate(BaseModel):
    source_profile: str = Field(min_length=1, max_length=64)
    target_profile: str = Field(min_length=1, max_length=64)
    body: str = Field(min_length=1, max_length=MAX_BODY_CHARS)
    urgency: Literal["normal", "priority", "critical"] = "normal"
    session_ref: Optional[str] = Field(default=None, min_length=1, max_length=MAX_SESSION_REF_CHARS)
    dedupe_key: Optional[str] = Field(default=None, min_length=1, max_length=MAX_DEDUPE_KEY_CHARS)


class CriticalPolicyPut(BaseModel):
    source_profile: str = Field(min_length=1, max_length=64)
    target_profile: str = Field(min_length=1, max_length=64)
    ttl_seconds: int = Field(ge=60, le=MAX_POLICY_TTL_SECONDS)


class MeetingPut(BaseModel):
    record: dict
    expected_version: int = Field(ge=0)


def _dispatch(envelope: dict[str, object]) -> dict[str, object]:
    envelope_id = str(envelope["id"])
    try:
        process_id = _launch_delivery(
            str(envelope["source_profile"]),
            str(envelope["target_profile"]),
            str(envelope["body"]),
            str(envelope["urgency"]),
        )
    except Exception as exc:
        try:
            failed = _store().record_delivery(envelope_id, delivered=False)
        except Exception:
            failed = envelope
        raise HTTPException(
            status_code=503,
            detail={"message": "Mailroom delivery could not start", "envelope_id": envelope_id},
        ) from exc
    _start_delivery_watch(_db_path(), envelope_id, process_id)
    return {"envelope": envelope, "delivery": {"status": "started", "to": envelope["target_profile"]}}


@router.get("/health")
def health():
    return {"ok": True, "service": "operations"}


@router.get("/mailroom")
def list_mailroom(
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=MAX_LIST_LIMIT),
):
    try:
        return {"envelopes": _store().list_envelopes(status=status, limit=limit)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/mailroom/policy-decisions")
def list_policy_decisions(limit: int = Query(default=50, ge=1, le=MAX_LIST_LIMIT)):
    return {"decisions": _store().list_policy_decisions(limit=limit)}


@router.get("/mailroom/{envelope_id}")
def get_mailroom(envelope_id: str):
    try:
        return {"envelope": _store().get_envelope(envelope_id)}
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Mailroom envelope not found") from exc


@router.post("/mailroom")
def create_mailroom(request: MailCreate):
    source = _require_known_profile(request.source_profile, "source_profile")
    target = _require_known_profile(request.target_profile, "target_profile")
    if source == target:
        raise HTTPException(status_code=400, detail="source and target profiles must differ")
    try:
        envelope = _store().create_envelope(
            source_profile=source,
            target_profile=target,
            body=request.body,
            urgency=request.urgency,
            session_ref=request.session_ref,
            dedupe_key=request.dedupe_key,
        )
    except CriticalPolicyDenied as exc:
        raise HTTPException(status_code=403, detail="Critical delivery requires an exact live policy") from exc
    except DuplicateKeyConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if envelope.get("duplicate"):
        return {"envelope": envelope, "delivery": {"status": "duplicate", "to": target}}
    return _dispatch(envelope)


@router.post("/mailroom/{envelope_id}/retry")
def retry_mailroom(envelope_id: str):
    try:
        envelope = _store().retry(envelope_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Mailroom envelope not found") from exc
    except CriticalPolicyDenied as exc:
        raise HTTPException(status_code=403, detail="Critical delivery requires an exact live policy") from exc
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _dispatch(envelope)


@router.post("/mailroom/{envelope_id}/acknowledge")
def acknowledge_mailroom(envelope_id: str):
    try:
        return {"envelope": _store().acknowledge(envelope_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Mailroom envelope not found") from exc
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/mailroom/{envelope_id}/cancel")
def cancel_mailroom(envelope_id: str):
    try:
        return {"envelope": _store().cancel(envelope_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Mailroom envelope not found") from exc
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.put("/mailroom/critical-policy")
def put_critical_policy(request: CriticalPolicyPut):
    source = _require_known_profile(request.source_profile, "source_profile")
    target = _require_known_profile(request.target_profile, "target_profile")
    if source == target:
        raise HTTPException(status_code=400, detail="source and target profiles must differ")
    return _store().set_critical_policy(
        source_profile=source,
        target_profile=target,
        expires_at=int(_clock()) + request.ttl_seconds,
    )


@router.get("/meetings")
def list_meetings(limit: int = Query(default=50, ge=1, le=meeting_store_module.MAX_LIST_LIMIT)):
    return {"meetings": _meeting_store().list(limit=limit)}


@router.get("/meetings/{meeting_id}")
def get_meeting(meeting_id: str):
    try:
        return _meeting_store().get(meeting_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Meeting not found") from exc


@router.put("/meetings/{meeting_id}")
def put_meeting(meeting_id: str, request: MeetingPut):
    if request.record.get("id") != meeting_id:
        raise HTTPException(status_code=400, detail="Meeting id does not match route")
    try:
        return _meeting_store().put(request.record, expected_version=request.expected_version)
    except MeetingVersionConflict as exc:
        raise HTTPException(status_code=409, detail="Meeting version conflict") from exc
    except ImmutableMeetingHistory as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/connected-agents")
def list_connected_agents():
    """Return verified connected agents from the AgentRegistry.

    Unverified agents are invisible. Staleness is reported honestly.
    """
    try:
        from tools.connected_agent_bot_integration import BotRoster
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
        roster = BotRoster(hermes_home=home)
        entries = roster.list_entries(home, "default")
    except Exception:
        return {"agents": []}

    return {
        "agents": [
            {
                "agent_id": entry.agent_id,
                "capabilities": list(entry.capabilities),
                "display_name": entry.display_name,
                "handle": entry.handle,
                "provider": entry.provider,
                "role": entry.role,
                "stale": entry.stale,
                "verified": entry.verified,
            }
            for entry in entries
            if entry.verified and entry.provider != "local"
        ]
    }


# ---------------------------------------------------------------------------
# A2A harness agent lifecycle
# ---------------------------------------------------------------------------

from collections import defaultdict, deque

_A2A_RATE_LIMIT_PER_USER = 10
_A2A_RATE_LIMIT_GLOBAL = 100
_A2A_RATE_WINDOW = 60.0


class _A2ARateLimiter:
    """Sliding-window rate limiter: one bucket per user + one global bucket."""

    def __init__(self) -> None:
        self._user_buckets: dict[str, deque[float]] = defaultdict(deque)
        self._global_bucket: deque[float] = deque()
        self._lock = threading.Lock()

    def allow(self, user_id: str) -> bool:
        with self._lock:
            now = time.time()
            # Global bucket
            while self._global_bucket and now - self._global_bucket[0] > _A2A_RATE_WINDOW:
                self._global_bucket.popleft()
            if len(self._global_bucket) >= _A2A_RATE_LIMIT_GLOBAL:
                return False
            # Per-user bucket
            bucket = self._user_buckets[user_id]
            while bucket and now - bucket[0] > _A2A_RATE_WINDOW:
                bucket.popleft()
            if len(bucket) >= _A2A_RATE_LIMIT_PER_USER:
                return False
            self._global_bucket.append(now)
            bucket.append(now)
            return True


_a2a_rate_limiter = _A2ARateLimiter()


def _user_id_from_request(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _a2a_registry_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "harness_agents.db"


def _a2a_catalog_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "agent_cards.db"


class A2ARegisterRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    confirm: bool = False


def _normalize_a2a_url(url: str) -> str:
    stripped = url.strip()
    lowered = stripped.lower()
    for suffix in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
        if lowered.endswith(suffix):
            return stripped[: -len(suffix)]
    return stripped


def _public_agent_summary(agent: dict[str, Any]) -> dict[str, Any]:
    """Return only public-safe fields for the renderer."""
    return {
        "agent_id": agent["id"],
        "name": agent["name"],
        "status": agent["verification_state"],
        "capabilities": agent.get("capabilities", []),
    }


@router.post("/agents/a2a/register")
def register_a2a_agent(request: Request, body: A2ARegisterRequest):
    """Register a new A2A harness agent from a public Agent Card URL.

    The agent is created in *pending* state. Pass ``confirm=true`` to
    immediately probe, verify, and bind a per-user mirror session.
    """
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    url = _normalize_a2a_url(body.url)

    # Policy validation (SSRF + default-deny)
    try:
        from plugins.harness_agents.policy import validate_url

        scheme, host, _port = validate_url(url, require_https=True)
    except ValueError as exc:
        raise HTTPException(
            status_code=403, detail="a2a_destination_not_allowed"
        ) from exc

    # Fetch and cache the public Agent Card
    try:
        from plugins.harness_agents.catalog import AgentCardCatalog

        catalog = AgentCardCatalog(_a2a_catalog_path())
        card = catalog.get(url, allowlist=None)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="a2a_malformed_agent_card"
        ) from exc

    # Schema validation
    name = str(card.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="a2a_malformed_agent_card")

    from plugins.harness_agents.registry import HarnessRegistry

    reg = HarnessRegistry(_a2a_registry_path())
    agent_id = f"a2a:{hashlib.sha256(url.encode()).hexdigest()[:16]}"

    try:
        reg.get_agent(agent_id)
    except ValueError:
        reg.create_agent(
            {
                "id": agent_id,
                "name": name,
                "handle": name.lower().replace(" ", "-")[:64] or "agent",
                "description": str(card.get("description") or "")[:4096],
                "harness": "generic_a2a",
                "host_id": host,
                "host_label": host,
                "connector_url": url,
                "auth_env": "",
                "team_id": "",
            }
        )
        reg.record_event(
            agent_id,
            principal=user_id,
            event_type="register",
            outcome="succeeded",
            detail={"url_domain": host},
        )

    # Confirm = immediate verification + mirror binding
    if body.confirm:
        try:
            from plugins.harness_agents.connectors import A2AConnector

            conn = A2AConnector(name=name, url=url, allowlist=frozenset({host}))
            probe_result = conn.probe()
            mirror_session_id = f"a2a_mirror_{agent_id}_{int(time.time())}"
            reg.mark_verified(
                agent_id,
                native_agent_id=str(probe_result.get("native_agent_id", name)),
                native_session_id="",
                mirror_session_id=mirror_session_id,
                capabilities=probe_result.get("capabilities", []),
                runtime_state="idle",
                supported_operations=probe_result.get("operations", []),
            )
            reg.record_event(
                agent_id,
                principal=user_id,
                event_type="confirm",
                outcome="succeeded",
                detail={},
            )
        except Exception as exc:
            reg.record_event(
                agent_id,
                principal=user_id,
                event_type="confirm",
                outcome="failed",
                detail={"error": str(exc)},
            )
            raise HTTPException(
                status_code=400, detail="a2a_verification_failed"
            ) from exc

    agent = reg.get_agent(agent_id)
    return _public_agent_summary(agent)


@router.get("/agents/a2a")
def list_a2a_agents(request: Request, limit: int = Query(default=50, ge=1, le=100)):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    from plugins.harness_agents.registry import HarnessRegistry

    reg = HarnessRegistry(_a2a_registry_path())
    agents = reg.list_agents()
    return {"agents": [_public_agent_summary(a) for a in agents[:limit]]}


@router.delete("/agents/a2a/{agent_id}")
def delete_a2a_agent(request: Request, agent_id: str):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    from plugins.harness_agents.registry import HarnessRegistry

    reg = HarnessRegistry(_a2a_registry_path())
    try:
        reg.get_agent(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_agent_not_found")

    reg.delete_agent(agent_id)
    reg.record_event(
        agent_id,
        principal=user_id,
        event_type="delete",
        outcome="succeeded",
        detail={},
    )
    return {"agent_id": agent_id, "deleted": True}


@router.get("/agents/a2a/{agent_id}/status")
def get_a2a_agent_status(request: Request, agent_id: str):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    from plugins.harness_agents.registry import HarnessRegistry

    reg = HarnessRegistry(_a2a_registry_path())
    try:
        agent = reg.get_agent(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_agent_not_found")

    return _public_agent_summary(agent)


class A2AChatSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=16_000)
    request_id: str = Field(default="", max_length=256)


@router.get("/agents/a2a/{agent_id}/chat")
def get_a2a_chat_history(request: Request, agent_id: str, request_id: str = Query(default="")):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    from plugins.harness_agents.registry import HarnessRegistry

    reg = HarnessRegistry(_a2a_registry_path())
    try:
        reg.get_agent(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_agent_not_found")

    return reg.get_chat_history(agent_id, request_id=request_id)


@router.post("/agents/a2a/{agent_id}/chat")
def send_a2a_chat_message(request: Request, agent_id: str, body: A2AChatSendRequest):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    from plugins.harness_agents.registry import HarnessRegistry
    from plugins.harness_agents.connectors import A2AConnector

    reg = HarnessRegistry(_a2a_registry_path())
    try:
        agent = reg.get_agent(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_agent_not_found")

    if agent.get("verification_state") != "verified":
        raise HTTPException(status_code=403, detail="a2a_agent_not_verified")

    try:
        binding = reg.get_chat_binding(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_chat_binding_not_found")

    connector_url = str(agent.get("connector_url") or "").strip()
    if not connector_url:
        raise HTTPException(status_code=400, detail="a2a_agent_missing_connector_url")

    host = str(agent.get("host_id") or "").strip()
    allowlist = frozenset({host}) if host else None

    try:
        conn = A2AConnector(
            name=str(agent.get("name") or agent_id),
            url=connector_url,
            allowlist=allowlist,
        )
        result = conn.send(
            body.message,
            native_session_id=binding["native_session_id"],
            request_id=body.request_id or None,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"a2a_send_failed: {exc}") from exc

    reg.send_chat_turn(
        agent_id,
        connector_event_id=result["connector_event_id"],
        user_message=body.message,
        assistant_reply=result["reply"],
        native_session_id=result["native_session_id"],
    )

    return {
        "reply": result["reply"],
        "state": result["state"],
        "request_status": "committed",
        "native_session_id": result["native_session_id"],
        "connector_event_id": result["connector_event_id"],
    }
