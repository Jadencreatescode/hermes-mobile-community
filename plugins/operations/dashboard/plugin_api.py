# health: allow FILE_LINES -- retained public Operations API is security reviewed; route extraction during core migration would risk authorization wiring
"""Authenticated public Operations plugin API.

The router owns only bounded Mailroom metadata and dispatches through the
existing Bot Mode delivery path. It never returns commands, process handles,
credentials, endpoint URLs, environment values, or lease tokens.
"""

from __future__ import annotations

import importlib.util
import hashlib
import json
import logging
import os

import secrets
import shlex
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

try:
    from hermes_constants import get_hermes_home
except ImportError:  # pragma: no cover
    def get_hermes_home() -> Path:
        return Path.home() / ".hermes"  # health: allow HX001 -- standalone plugin import fallback only; Hermes runtime uses the profile-aware helper


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
ServerOwnedField = meeting_store_module.ServerOwnedField
InvalidMeetingTransition = meeting_store_module.InvalidMeetingTransition


def _load_dashboard_module(filename: str, module_name: str):
    """Load a sibling Operations module through the existing convention."""
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Operations module could not load: {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


package_module = _load_dashboard_module(
    "deliverable_package.py", "hermes_operations_deliverable_package"
)
output_store_module = _load_dashboard_module(
    "meeting_output_store.py", "hermes_operations_meeting_output_store"
)
MeetingOutputStore = output_store_module.MeetingOutputStore
workspace_module = output_store_module.workspace_module

router = APIRouter()

#: One bounded workspace sweep per process. Abandoned workspaces are reclaimed
#: on the first output-lifecycle call rather than by an unbounded walk on every
#: request or by a background thread this router does not own.
_workspace_sweep_lock = threading.Lock()
_workspace_sweep_done = False
# Pin each artifact root for the lifetime of this API process. Reconstructing
# ArtifactStore on every request would let a real directory swapped into the
# same pathname become the new trusted root on the next request.
_output_store_cache_lock = threading.Lock()
_output_store_cache: dict[tuple[str, str], MeetingOutputStore] = {}


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


def _artifact_root() -> Path:
    return Path(get_hermes_home()) / "operations" / "artifacts"


def _sweep_workspaces_once(store: MeetingOutputStore) -> None:
    """Reclaim abandoned workspaces once per process, bounded, never fatal.

    A crashed or rolled-back run leaves a workspace no durable row references.
    The sweep keeps every open run's workspace, honours the grace cutoff so an
    in-flight mint is never taken, and removes at most a bounded number of
    entries, so it cannot stall the first request. A sweep failure is never
    allowed to fail the request that happened to trigger it.
    """
    global _workspace_sweep_done

    with _workspace_sweep_lock:
        if _workspace_sweep_done:
            return
        _workspace_sweep_done = True
    try:
        store.sweep_workspaces()
    except Exception:
        logger.exception("Operations workspace sweep failed")


def _output_store() -> MeetingOutputStore:
    """The output lifecycle shares the one public meeting database.

    Opening the store verifies and pins the artifact root, so a root that is
    not the directory Operations built fails here -- with a stable public code
    and no host path -- before any route can expose a cwd or a claim.
    """
    database = Path(os.path.normpath(os.path.abspath(os.fspath(_meeting_db_path()))))
    artifacts = Path(os.path.normpath(os.path.abspath(os.fspath(_artifact_root()))))
    key = (os.fspath(database), os.fspath(artifacts))
    try:
        with _output_store_cache_lock:
            store = _output_store_cache.get(key)
            if store is None:
                store = MeetingOutputStore(database, artifacts, clock=_clock)
                _output_store_cache[key] = store
            else:
                store.artifacts.verify_root()
    except Exception as exc:
        raise _output_http_error(exc) from exc
    _sweep_workspaces_once(store)
    return store


# ---------------------------------------------------------------------------
# Authorization and error mapping for meeting + output lifecycle routes
# ---------------------------------------------------------------------------

#: Public error codes. Bodies carry a stable code and nothing else, so a
#: refusal can never leak a host path, a claim token, SQL, or an identity.
def _code(value: str) -> dict[str, str]:
    return {"error": value}


def _authorize_view(request: Request) -> str:
    """Read routes require the existing Operations view capability."""
    principal, registry = _authorized_registry(request, "agent.view")
    try:
        return principal
    finally:
        registry.close()


def _authorize_mutation(request: Request) -> str:
    """Meeting and output mutations require owner/admin mutation authority."""
    principal, registry = _authorized_registry(request, "team.manage")
    try:
        return principal
    finally:
        registry.close()


def _authorize_owner(request: Request) -> str:
    """Approval additionally re-checks owner/admin on the live registry."""
    principal, registry = _authorized_registry(request, "team.manage")
    try:
        if not registry.is_owner_or_admin(principal):
            raise HTTPException(
                status_code=403, detail=_code("operations_owner_or_admin_required")
            )
        return principal
    finally:
        registry.close()


def _output_http_error(exc: Exception) -> HTTPException:
    """Map store failures onto stable public status codes and codes."""
    if isinstance(exc, HTTPException):
        return exc
    module = output_store_module
    mapping: list[tuple[type, int, str]] = [
        (module.PackageLimitExceeded, 413, "operations_package_limit_exceeded"),
        (module.DeterministicCheckFailed, 422, "operations_deterministic_check_failed"),
        (module.CollectionFailed, 422, "operations_collection_failed"),
        (module.ArtifactUnavailable, 422, "operations_artifact_unavailable"),
        (module.PackageInvalid, 422, "operations_package_invalid"),
        (module.ReviewerNotEligible, 403, "operations_reviewer_not_eligible"),
        (module.ReviewClaimRequired, 403, "operations_review_claim_required"),
        (module.ProducerNotEligible, 403, "operations_producer_not_eligible"),
        (module.ProducerSessionMismatch, 403, "operations_producer_session_mismatch"),
        (module.WorkspaceClaimInvalid, 403, "operations_collection_claim_invalid"),
        (module.OutputNotFound, 404, "operations_output_not_found"),
        (module.OutputVersionConflict, 409, "operations_output_version_conflict"),
        (MeetingVersionConflict, 409, "operations_meeting_version_conflict"),
        (module.IdempotencyConflict, 409, "operations_idempotency_conflict"),
        (module.ClaimActive, 409, "operations_claim_active"),
        (module.ClaimExpired, 409, "operations_claim_expired"),
        (module.ClaimBindingMismatch, 409, "operations_claim_binding_mismatch"),
        (module.ClaimExhausted, 409, "operations_claim_exhausted"),
        (module.ReviewActive, 409, "operations_review_active"),
        (module.InvalidOutputTransition, 409, "operations_invalid_transition"),
        (InvalidMeetingTransition, 409, "operations_invalid_transition"),
        (ServerOwnedField, 409, "operations_server_owned_field"),
        (ImmutableMeetingHistory, 409, "operations_immutable_history"),
        # Last, because the claim-specific failure above is a subclass: an
        # artifact root that is no longer the directory Operations built is a
        # server-state fault, not a bad request, and no cwd comes out of it.
        (module.WorkspaceError, 500, "operations_artifact_store_unavailable"),
    ]
    for kind, status, code in mapping:
        if isinstance(exc, kind):
            return HTTPException(status_code=status, detail=_code(code))
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail=_code("operations_output_not_found"))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=_code("operations_forbidden"))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=_code("operations_request_invalid"))
    return HTTPException(status_code=500, detail=_code("operations_internal_error"))


def _idempotency_key(request: Request) -> str:
    """Every output-lifecycle mutation carries one. No key, no mutation.

    Without a key a dropped response is indistinguishable from a second
    intent, so a retry could mint a second run, artifact version, dispatch
    claim, verdict, or approval. The refusal is a 400 taken before any
    lifecycle work.
    """
    value = (request.headers.get("Idempotency-Key") or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail=_code("operations_idempotency_key_required"))
    if len(value) > output_store_module.MAX_IDEMPOTENCY_KEY_CHARS or "\x00" in value:
        raise HTTPException(status_code=400, detail=_code("operations_idempotency_key_invalid"))
    return value


def _idempotent(
    store: MeetingOutputStore,
    request: Request,
    action: str,
    payload: object,
    run,
    *,
    resource: str,
    replay_guard=None,
) -> Any:
    """Replay an identical lifecycle request; conflict on a changed payload.

    ``resource`` carries the mutation's path identifiers (meeting id, output
    id, run id, review request id). It is hashed with the action and the body,
    so the SAME key presented against a DIFFERENT resource is a 409 rather than
    a replay of some other resource's response. It is required, not defaulted:
    a new mutation route cannot forget it.

    ``run`` receives the lifecycle transaction's connection and must do all of
    its durable work on it: the replay check, the mutation, and the stored
    response commit together or not at all.
    """
    key = _idempotency_key(request)
    request_hash = output_store_module.canonical_request_hash([action, resource, payload])
    try:
        return store.run_idempotent(
            action=action,
            key=key,
            request_hash=request_hash,
            mutate=run,
            replay_guard=replay_guard,
        )
    except Exception as exc:
        raise _output_http_error(exc) from exc


def _collection_claim_digest(claim: str) -> str:
    """Hash a presented collection claim for the request hash.

    The raw claim is single use and must not be stored a second time, so the
    canonical request carries only this hash. It still separates one claim from
    another, which is the conflict semantics the collect route needs.
    """
    try:
        return workspace_module.hash_claim_token(claim)
    except Exception as exc:
        raise _output_http_error(exc) from exc


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
        logger.exception("Operations delivery watcher failed")
        try:
            MailroomStore(db_path).record_delivery(envelope_id, delivered=False)
        except Exception:
            logger.exception("Operations delivery watcher could not record failure")


def _start_delivery_watch(db_path: Path, envelope_id: str, process_id: str) -> None:
    from agent.memory_provider import spawn_context_thread

    spawn_context_thread(
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
            _store().record_delivery(envelope_id, delivered=False)
        except Exception:
            logger.exception("Operations dispatch could not record delivery failure")
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
def list_meetings(
    request: Request,
    limit: int = Query(default=50, ge=1, le=meeting_store_module.MAX_LIST_LIMIT),
):
    _authorize_view(request)
    return {"meetings": _meeting_store().list(limit=limit)}


@router.get("/meetings/{meeting_id}")
def get_meeting(request: Request, meeting_id: str):
    _authorize_view(request)
    try:
        return _meeting_store().get(meeting_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=404, detail=_code("operations_meeting_not_found")) from exc


@router.put("/meetings/{meeting_id}")
def put_meeting(request: Request, meeting_id: str, body: MeetingPut):
    _authorize_mutation(request)
    if body.record.get("id") != meeting_id:
        raise HTTPException(status_code=400, detail=_code("operations_meeting_id_mismatch"))
    try:
        return _meeting_store().put(body.record, expected_version=body.expected_version)
    except Exception as exc:
        raise _output_http_error(exc) from exc


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
        logger.exception("Connected-agent roster could not be loaded")
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


def _principal_hash(kind: str, provider: str, identity: str, organization: str = "") -> str:
    """Build a stable opaque authority key from verified authentication data."""
    material = "\x00".join((kind, provider, identity, organization))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _principal_hash_from_request(request: Request) -> str:
    """Resolve the authenticated caller without trusting network addressing."""
    # Loopback headers rotate at process startup. They authenticate the request
    # but are not an identity. Bind local ownership to a durable, installation-
    # private value instead so restarts cannot lock out the real operator.
    app_state = getattr(getattr(request, "app", None), "state", None)
    local_mode = getattr(app_state, "auth_required", None) is False
    if local_mode:
        path = Path(get_hermes_home()) / "operations" / "installation-owner.key"
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.parent.chmod(0o700)
        except OSError:
            pass
        created = False
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            created = True
            try:
                secret_bytes = secrets.token_hex(32).encode("ascii")
                os.write(fd, secret_bytes)
                os.fsync(fd)
            finally:
                os.close(fd)
        installation_secret = ""
        try:
            path.chmod(0o600)
            for attempt in range(100):
                installation_secret = path.read_text(encoding="utf-8-sig").strip()
                if len(installation_secret) == 64:
                    break
                if created or attempt == 99:
                    break
                time.sleep(0.01)
        except OSError as exc:
            raise HTTPException(
                status_code=503, detail="operations_identity_unavailable"
            ) from exc
        if len(installation_secret) != 64 or any(
            char not in "0123456789abcdef" for char in installation_secret
        ):
            raise HTTPException(status_code=503, detail="operations_identity_invalid")
        return _principal_hash("installation", "local", installation_secret)
    token = getattr(request.state, "token_principal", None)
    if token is not None and str(getattr(token, "principal", "")).strip():
        return _principal_hash(
            "token",
            str(getattr(token, "provider", "")),
            str(token.principal),
        )
    session = getattr(request.state, "session", None)
    if session is not None and str(getattr(session, "user_id", "")).strip():
        return _principal_hash(
            "session",
            str(getattr(session, "provider", "")),
            str(session.user_id),
            str(getattr(session, "org_id", "")),
        )
    raise HTTPException(status_code=401, detail="operations_authentication_required")


def _user_id_from_request(request: Request) -> str:
    return _principal_hash_from_request(request)


def _a2a_registry_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "harness_agents.db"


def _a2a_catalog_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "agent_cards.db"


def _authorized_registry(
    request: Request,
    capability: str,
    *,
    agent_id: str = "operations",
    bootstrap_owner: bool = True,
):
    """Return an authorized registry and audit every mutation decision."""
    from plugins.harness_agents.registry import HarnessRegistry

    principal = _principal_hash_from_request(request)
    registry = HarnessRegistry(_a2a_registry_path())
    try:
        if bootstrap_owner and not registry.has_owner():
            app_state = getattr(getattr(request, "app", None), "state", None)
            local_mode = getattr(app_state, "auth_required", None) is False
            if not local_mode:
                token = getattr(request.state, "token_principal", None)
                session = getattr(request.state, "session", None)
                if token is not None and str(getattr(token, "principal", "")).strip():
                    identity = (
                        "token",
                        str(getattr(token, "provider", "")),
                        str(token.principal),
                        "",
                    )
                else:
                    identity = (
                        "session",
                        str(getattr(session, "provider", "")),
                        str(getattr(session, "user_id", "")),
                        str(getattr(session, "org_id", "")),
                    )
                assertion = json.dumps(identity, separators=(",", ":"))
                trusted = os.getenv("HERMES_OPERATIONS_OWNER", "").strip()  # health: allow HX002 -- this value is a credential-bound owner assertion, not a behavioral setting
                if not trusted or not secrets.compare_digest(assertion, trusted):
                    raise HTTPException(
                        status_code=403, detail="operations_owner_setup_required"
                    )
            registry.provision_owner_principal(principal)
        registry.resolve_principal(principal)
        allowed = capability in registry.capabilities_for(principal, agent_id=agent_id)
        if capability not in {"agent.view", "chat.read"}:
            allowed = allowed and registry.is_owner_or_admin(principal)
        registry.record_event(
            agent_id or "_global",
            principal=principal,
            event_type="policy.decision",
            outcome="allowed" if allowed else "denied",
            detail={"capability": capability},
        )
        if not allowed:
            raise HTTPException(
                status_code=403, detail="operations_owner_or_admin_required"
            )
        return principal, registry
    except HTTPException:
        registry.close()
        raise
    except PermissionError as exc:
        try:
            registry.record_event(
                agent_id,
                principal=principal,
                event_type="policy.decision",
                outcome="denied",
                detail={"capability": capability},
            )
        except Exception:
            logger.exception("Operations policy denial could not be recorded")
        registry.close()
        raise HTTPException(
            status_code=403, detail="operations_owner_or_admin_required"
        ) from exc
    except Exception:
        registry.close()
        raise


class A2ARegisterRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    confirm: bool = False


class A2ARenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=96)


def _normalize_a2a_url(url: str) -> str:
    stripped = url.strip()
    lowered = stripped.lower()
    for suffix in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
        if lowered.endswith(suffix):
            return stripped[: -len(suffix)]
    return stripped


def _public_agent_summary(agent: dict[str, Any]) -> dict[str, Any]:
    """Return only public-safe fields for the renderer."""
    verified = agent.get("verification_state") == "verified"
    return {
        "agent_id": agent["id"],
        "name": agent["name"],
        "status": agent["verification_state"],
        "capabilities": agent.get("capabilities", []),
        "runtime_state": str(agent.get("runtime_state") or "unknown") if verified else "unknown",
        "supported_operations": agent.get("supported_operations", []) if verified else [],
        "last_probe_at": str(agent.get("last_probe_at") or ""),
        "work_summary": str(agent.get("work_summary") or "") if verified else "",
    }


def _register_a2a_agent_with_registry(
    body: A2ARegisterRequest, user_id: str, reg: Any
) -> dict[str, Any]:
    """Register a new A2A harness agent from a public Agent Card URL.

    The agent is created in *pending* state. Pass ``confirm=true`` to
    immediately probe, verify, and bind a per-user mirror session.
    """
    url = _normalize_a2a_url(body.url)

    # Policy validation (SSRF + default-deny)
    try:
        from plugins.harness_agents.policy import validate_url

        _scheme, host, _port = validate_url(url, require_https=True)
    except ValueError as exc:
        raise HTTPException(
            status_code=403, detail="a2a_destination_not_allowed"
        ) from exc

    # Fetch and cache the public Agent Card
    try:
        from plugins.harness_agents.catalog import AgentCardCatalog

        catalog = AgentCardCatalog(_a2a_catalog_path())
        try:
            card = catalog.get(url, allowlist=None)
        finally:
            catalog.close()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="a2a_malformed_agent_card") from exc

    # Schema validation
    name = str(card.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="a2a_malformed_agent_card")

    agent_id = f"a2a:{hashlib.sha256(url.encode()).hexdigest()[:16]}"

    try:
        reg.get_agent(agent_id)
    except ValueError:
        reg.create_agent({
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
        })
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
                runtime_state=str(probe_result.get("state") or "unknown"),
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

@router.post("/agents/a2a/register")
def register_a2a_agent(request: Request, body: A2ARegisterRequest):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")
    user_id, reg = _authorized_registry(request, "agent.create")
    try:
        return _register_a2a_agent_with_registry(body, user_id, reg)
    finally:
        reg.close()


def _rename_a2a_agent_with_registry(
    agent_id: str, body: A2ARenameRequest, user_id: str, reg: Any
) -> dict[str, Any]:
    """Rename one connected agent.

    The id and the handle stay stable, so the connector, the verification state,
    and the audit trail keep pointing at the same Bot; only the displayed name
    moves.  A name the operator's other Bots already use is reported back as a
    warning and the rename still lands, because the operator may mean it.
    """
    from plugins.harness_agents.registry import _bot_name

    try:
        reg.get_agent(agent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="a2a_agent_not_found")

    try:
        name = _bot_name(body.name)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "a2a_name_rejected", "reason": str(exc)},
        ) from exc

    warnings: list[str] = []
    conflicts = reg.name_conflicts(name, exclude_id=agent_id)
    if conflicts:
        labels = ", ".join(sorted(conflict["label"] for conflict in conflicts))
        warnings.append(
            "another Bot already uses this name ("
            + labels
            + "), so the two are hard to tell apart in the roster and the rooms"
        )

    try:
        agent = reg.rename_agent(agent_id, name)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "a2a_name_rejected", "reason": str(exc)},
        ) from exc

    reg.record_event(
        agent_id,
        principal=user_id,
        event_type="rename",
        outcome="succeeded",
        detail={"name": name, "conflicts": len(conflicts)},
    )
    return {**_public_agent_summary(agent), "warnings": warnings}

@router.patch("/agents/a2a/{agent_id}")
def rename_a2a_agent(request: Request, agent_id: str, body: A2ARenameRequest):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")
    user_id, reg = _authorized_registry(request, "agent.create", agent_id=agent_id)
    try:
        return _rename_a2a_agent_with_registry(agent_id, body, user_id, reg)
    finally:
        reg.close()


@router.get("/agents/a2a")
def list_a2a_agents(request: Request, limit: int = Query(default=50, ge=1, le=100)):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    _principal, reg = _authorized_registry(request, "agent.view")
    try:
        agents = reg.list_agents()
        return {"agents": [_public_agent_summary(a) for a in agents[:limit]]}
    finally:
        reg.close()


@router.delete("/agents/a2a/{agent_id}")
def delete_a2a_agent(request: Request, agent_id: str):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    user_id, reg = _authorized_registry(request, "agent.delete", agent_id=agent_id)
    try:
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
    finally:
        reg.close()


@router.get("/agents/a2a/{agent_id}/status")
def get_a2a_agent_status(request: Request, agent_id: str):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    _principal, reg = _authorized_registry(request, "agent.view", agent_id=agent_id)
    try:
        try:
            agent = reg.get_agent(agent_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="a2a_agent_not_found")
        return _public_agent_summary(agent)
    finally:
        reg.close()


class A2AChatSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=16_000)
    request_id: str = Field(default="", max_length=256)


@router.get("/agents/a2a/{agent_id}/chat")
def get_a2a_chat_history(
    request: Request, agent_id: str, request_id: str = Query(default="")
):
    user_id = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(user_id):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")

    _principal, reg = _authorized_registry(request, "chat.read", agent_id=agent_id)
    try:
        try:
            reg.get_agent(agent_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="a2a_agent_not_found")
        return reg.get_chat_history(agent_id, request_id=request_id)
    finally:
        reg.close()


def _send_with_registry(
    reg: Any,
    *,
    principal: str,
    agent_id: str,
    message: str,
    request_id: str,
) -> dict[str, Any]:
    """One serialized prepare/dispatch/commit path shared by chat and rooms."""
    from plugins.harness_agents.connectors import A2AConnector
    from plugins.harness_agents.registry import acquire_agent_operation_lock

    lock = acquire_agent_operation_lock(_a2a_registry_path(), agent_id)
    if lock is None:
        raise HTTPException(status_code=409, detail="a2a_agent_busy")
    try:
        agent = reg.get_agent(agent_id)
        if agent.get("verification_state") != "verified":
            raise HTTPException(status_code=403, detail="a2a_agent_not_verified")
        if "chat.send" not in agent.get("capabilities", []):
            raise HTTPException(status_code=403, detail="a2a_chat_not_advertised")
        stable_request_id = request_id or f"request-{secrets.token_hex(16)}"
        binding = reg.get_chat_binding(agent_id)
        reg.prepare_chat_intent(
            agent_id,
            mirror_session_id=binding["mirror_session_id"],
            expected_native_session_id=binding["native_session_id"],
            request_id=stable_request_id,
            user_message=message.strip(),
        )
        replay = reg.get_chat_request(agent_id, stable_request_id)
        if replay is not None and replay["status"] == "committed":
            return {
                "reply": replay["assistant_reply"],
                "state": str(agent.get("runtime_state") or "unknown"),
                "request_status": "committed",
                "native_session_id": replay["native_session_id"],
                "connector_event_id": stable_request_id,
                "duplicate": True,
            }
        connector_url = str(agent.get("connector_url") or "").strip()
        host = str(agent.get("host_id") or "").strip()
        conn = A2AConnector(
            name=str(agent.get("name") or agent_id),
            url=connector_url,
            allowlist=frozenset({host}) if host else None,
        )
        result = conn.send(
            message,
            native_session_id=binding["native_session_id"],
            request_id=stable_request_id,
        )
        reg.send_chat_turn(
            agent_id,
            connector_event_id=stable_request_id,
            user_message=message,
            assistant_reply=result["reply"],
            native_session_id=result["native_session_id"],
            native_task_id=str(result.get("native_task_id") or ""),
        )
        updated_agent = reg.update_runtime_state(
            agent_id, str(result.get("state") or "unknown")
        )
        state = str(updated_agent.get("runtime_state") or "unknown")
        reg.record_event(
            agent_id,
            principal=principal,
            event_type="chat.delivery",
            outcome="succeeded",
            detail={"request_id": stable_request_id},
        )
        return {
            "reply": result["reply"],
            "state": state,
            "request_status": "committed",
            "native_session_id": result["native_session_id"],
            "connector_event_id": stable_request_id,
            "duplicate": False,
        }
    finally:
        lock.release()


@router.post("/agents/a2a/{agent_id}/chat")
def send_a2a_chat_message(request: Request, agent_id: str, body: A2AChatSendRequest):
    principal = _user_id_from_request(request)
    if not _a2a_rate_limiter.allow(principal):
        raise HTTPException(status_code=429, detail="a2a_rate_limited")
    principal, reg = _authorized_registry(request, "chat.send", agent_id=agent_id)
    try:
        return _send_with_registry(
            reg,
            principal=principal,
            agent_id=agent_id,
            message=body.message,
            request_id=body.request_id,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        if "request" in str(exc) and "reused" in str(exc):
            raise HTTPException(status_code=409, detail="a2a_request_id_conflict") from exc
        raise HTTPException(status_code=400, detail="a2a_chat_invalid") from exc
    except Exception as exc:
        reg.record_event(
            agent_id,
            principal=principal,
            event_type="chat.delivery",
            outcome="failed",
            detail={"error_type": type(exc).__name__[:128]},
        )
        raise HTTPException(status_code=502, detail="a2a_send_failed") from exc
    finally:
        reg.close()


class A2AStartRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=16_000)


class A2ASteerRequest(BaseModel):
    message: str = Field(min_length=1, max_length=16_000)


class A2AInterruptRequest(BaseModel):
    confirm: bool = False


def _run_advertised_control(
    request: Request,
    agent_id: str,
    operation: str,
    capability: str,
    parameters: dict[str, Any],
) -> dict[str, Any]:
    from plugins.harness_agents.connectors import A2AConnector
    from plugins.harness_agents.registry import acquire_agent_operation_lock

    principal, reg = _authorized_registry(request, capability, agent_id=agent_id)
    lock = acquire_agent_operation_lock(_a2a_registry_path(), agent_id)
    try:
        agent = reg.get_agent(agent_id)
        if agent.get("verification_state") != "verified":
            raise HTTPException(status_code=403, detail="a2a_agent_not_verified")
        if operation not in set(agent.get("supported_operations") or []):
            raise HTTPException(status_code=409, detail="a2a_operation_not_advertised")
        binding = reg.get_chat_binding(agent_id)
        host = str(agent.get("host_id") or "").strip()
        connector = A2AConnector(
            name=str(agent.get("name") or agent_id),
            url=str(agent.get("connector_url") or ""),
            allowlist=frozenset({host}) if host else None,
        )
        probe = connector.probe()
        if operation not in set(probe.get("operations") or []):
            raise HTTPException(status_code=409, detail="a2a_operation_not_advertised")
        result = getattr(connector, operation)(
            **parameters,
            native_session_id=binding["native_session_id"],
            native_task_id=binding["native_task_id"],
        )
        if not isinstance(result, dict):
            raise ValueError("connector control returned an invalid result")
        state = str(result.get("state") or probe.get("state") or "unknown")
        updated_binding = str(
            result.get("native_session_id") or binding["native_session_id"]
        )
        updated_task = str(result.get("native_task_id") or binding["native_task_id"])
        if (
            updated_binding != binding["native_session_id"]
            or updated_task != binding["native_task_id"]
        ):
            reg.update_chat_binding(agent_id, updated_binding, updated_task)
        updated_agent = reg.update_runtime_state(
            agent_id,
            state,
            work_summary=str(result.get("work_summary") or "")[:1024],
        )
        state = str(updated_agent.get("runtime_state") or "unknown")
        reg.record_event(
            agent_id,
            principal=principal,
            event_type="connector.operation",
            outcome="succeeded",
            detail={"operation": operation},
        )
        return {
            "operation": operation,
            "supported": True,
            "state": state,
            "native_session_id": updated_binding,
        }
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="a2a_control_invalid") from exc
    except Exception as exc:
        try:
            reg.mark_degraded(agent_id, error=type(exc).__name__[:128])
            reg.record_event(
                agent_id,
                principal=principal,
                event_type="connector.operation",
                outcome="failed",
                detail={"operation": operation, "error_type": type(exc).__name__[:128]},
            )
        finally:
            pass
        raise HTTPException(status_code=502, detail="a2a_control_failed") from exc
    finally:
        if lock is not None:
            lock.release()
        reg.close()


@router.post("/agents/a2a/{agent_id}/refresh")
def refresh_a2a_agent(request: Request, agent_id: str):
    from plugins.harness_agents.connectors import A2AConnector
    from plugins.harness_agents.registry import acquire_agent_operation_lock

    principal, reg = _authorized_registry(request, "agent.create", agent_id=agent_id)
    lock = acquire_agent_operation_lock(_a2a_registry_path(), agent_id)
    try:
        agent = reg.get_agent(agent_id)
        binding = reg.get_chat_binding(agent_id)
        host = str(agent.get("host_id") or "").strip()
        connector = A2AConnector(
            name=str(agent.get("name") or agent_id),
            url=str(agent.get("connector_url") or ""),
            allowlist=frozenset({host}) if host else None,
        )
        probe = connector.probe()
        refreshed = reg.mark_verified(
            agent_id,
            native_agent_id=str(probe.get("native_agent_id") or agent_id),
            native_session_id=binding["native_session_id"],
            mirror_session_id=binding["mirror_session_id"],
            capabilities=probe.get("capabilities") or [],
            runtime_state=str(probe.get("state") or "unknown"),
            work_summary=str(probe.get("work_summary") or "")[:1024],
            supported_operations=probe.get("operations") or [],
        )
        reg.record_event(
            agent_id,
            principal=principal,
            event_type="verification.refresh",
            outcome="succeeded",
            detail={"state": "verified"},
        )
        return _public_agent_summary(refreshed)
    except HTTPException:
        raise
    except Exception as exc:
        try:
            reg.mark_degraded(agent_id, error=type(exc).__name__[:128])
        except Exception:
            logger.exception("A2A refresh failure could not mark the agent degraded")
        raise HTTPException(status_code=502, detail="a2a_refresh_failed") from exc
    finally:
        if lock is not None:
            lock.release()
        reg.close()


@router.get("/agents/a2a/{agent_id}/state")
def get_a2a_live_state(request: Request, agent_id: str):
    return _run_advertised_control(request, agent_id, "get_state", "agent.view", {})


@router.post("/agents/a2a/{agent_id}/start-or-resume")
def start_or_resume_a2a(request: Request, agent_id: str, body: A2AStartRequest):
    return _run_advertised_control(
        request, agent_id, "start_or_resume", "run.assign", {"prompt": body.prompt.strip()}
    )


@router.post("/agents/a2a/{agent_id}/steer")
def steer_a2a(request: Request, agent_id: str, body: A2ASteerRequest):
    return _run_advertised_control(
        request, agent_id, "steer", "run.steer", {"message": body.message.strip()}
    )


@router.post("/agents/a2a/{agent_id}/interrupt")
def interrupt_a2a(request: Request, agent_id: str, body: A2AInterruptRequest):
    if body.confirm is not True:
        raise HTTPException(status_code=400, detail="confirmation_required")
    return _run_advertised_control(request, agent_id, "interrupt", "run.interrupt", {})


def _rooms_path() -> Path:
    return Path(get_hermes_home()) / "operations" / "rooms.db"


class RoomCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    confirm: bool = False


class RoomMemberRequest(BaseModel):
    confirm: bool = False


class RoomMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=16_000)
    request_id: str = Field(default="", max_length=256)


class RoomHandoffRequest(BaseModel):
    agent_id: str = Field(min_length=1, max_length=256)
    confirm: bool = False


class RoomTurnRequest(BaseModel):
    agent_id: str = Field(min_length=1, max_length=256)
    message: str = Field(min_length=1, max_length=16_000)
    request_id: str = Field(min_length=1, max_length=256)


def _room_turn_dispatch_id(room_id: str, request_id: str) -> str:
    """Derive a bounded connector identity without truncating room identity."""
    framed = bytearray(b"hermes.operations.room-turn.dispatch.v1\0")
    for value in (room_id, request_id):
        encoded = value.encode("utf-8")
        framed.extend(len(encoded).to_bytes(4, "big"))
        framed.extend(encoded)
    return f"room-turn-{hashlib.sha256(framed).hexdigest()}"


def _room_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, LookupError):
        return HTTPException(status_code=404, detail="room_not_found")
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/rooms")
def list_rooms(request: Request):
    from plugins.harness_agents.rooms import RoomStore

    _principal, reg = _authorized_registry(request, "agent.view")
    try:
        return {"rooms": RoomStore(_rooms_path()).list_rooms()}
    finally:
        reg.close()


@router.post("/rooms")
def create_room(request: Request, body: RoomCreateRequest):
    from plugins.harness_agents.rooms import RoomStore

    if body.confirm is not True:
        raise HTTPException(status_code=400, detail="confirmation_required")
    principal, reg = _authorized_registry(request, "team.manage")
    try:
        return {"room": RoomStore(_rooms_path()).create(body.name, created_by=principal)}
    finally:
        reg.close()


@router.get("/rooms/{room_id}")
def get_room(request: Request, room_id: str, limit: int = Query(default=100, ge=1, le=200)):
    from plugins.harness_agents.rooms import RoomStore

    _principal, reg = _authorized_registry(request, "agent.view")
    store = RoomStore(_rooms_path())
    try:
        return {"room": store.get(room_id), "transcript": store.transcript(room_id, limit)}
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


@router.post("/rooms/{room_id}/members/{agent_id}")
def add_room_member(request: Request, room_id: str, agent_id: str, body: RoomMemberRequest):
    from plugins.harness_agents.rooms import RoomStore

    if body.confirm is not True:
        raise HTTPException(status_code=400, detail="confirmation_required")
    _principal, reg = _authorized_registry(request, "team.manage", agent_id=agent_id)
    try:
        return {"room": RoomStore(_rooms_path()).add_member(room_id, agent_id, registry=reg)}
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


@router.delete("/rooms/{room_id}/members/{agent_id}")
def remove_room_member(request: Request, room_id: str, agent_id: str, confirm: bool = Query(default=False)):
    from plugins.harness_agents.rooms import RoomStore

    if confirm is not True:
        raise HTTPException(status_code=400, detail="confirmation_required")
    _principal, reg = _authorized_registry(request, "team.manage", agent_id=agent_id)
    try:
        return {"room": RoomStore(_rooms_path()).remove_member(room_id, agent_id)}
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


@router.post("/rooms/{room_id}/messages")
def post_room_message(request: Request, room_id: str, body: RoomMessageRequest):
    from plugins.harness_agents.rooms import RoomStore

    principal, reg = _authorized_registry(request, "chat.send")
    try:
        if not reg.is_owner_or_admin(principal):
            raise HTTPException(status_code=403, detail="room_owner_required")
        message = RoomStore(_rooms_path()).post(
            room_id, body.message, request_id=body.request_id
        )
        return {"message": message}
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


@router.post("/rooms/{room_id}/handoff")
def handoff_room(request: Request, room_id: str, body: RoomHandoffRequest):
    from plugins.harness_agents.rooms import RoomStore

    if body.confirm is not True:
        raise HTTPException(status_code=400, detail="confirmation_required")
    principal, reg = _authorized_registry(request, "chat.send", agent_id=body.agent_id)
    try:
        if not reg.is_owner_or_admin(principal):
            raise HTTPException(status_code=403, detail="room_owner_required")
        return RoomStore(_rooms_path()).hand_off(room_id, body.agent_id, actor="owner")
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


@router.post("/rooms/{room_id}/turns")
def run_room_turn(request: Request, room_id: str, body: RoomTurnRequest):
    from plugins.harness_agents.rooms import RoomStore

    principal, reg = _authorized_registry(request, "chat.send", agent_id=body.agent_id)
    store = RoomStore(_rooms_path())
    try:
        if not reg.is_owner_or_admin(principal):
            raise HTTPException(status_code=403, detail="room_owner_required")
        turn = store.begin_turn(
            room_id,
            request_id=body.request_id,
            agent_id=body.agent_id,
            message=body.message,
        )
        if turn.get("status") == "committed":
            return turn
        result = _send_with_registry(
            reg,
            principal=principal,
            agent_id=body.agent_id,
            message=body.message,
            request_id=_room_turn_dispatch_id(room_id, body.request_id),
        )
        return store.complete_turn(
            room_id,
            request_id=body.request_id,
            agent_id=body.agent_id,
            reply=result["reply"],
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _room_error(exc) from exc
    finally:
        reg.close()


# ---------------------------------------------------------------------------
# Public production-meeting output lifecycle
#
# Every route below runs inside the existing authenticated Operations REST
# authority. Read routes need the view capability; mutations need the
# owner/admin mutation authority; approval re-checks owner/admin and derives
# the approver from request authentication. No route accepts an approver, an
# approval time, a hash the client invented, or a host path.
# ---------------------------------------------------------------------------


class _ClosedRequest(BaseModel):
    """Base for every production-lifecycle request body.

    The model is CLOSED: an unexpected field is a 422, not a silently dropped
    one. That is what makes "the producer never chooses a host path" checkable
    at the boundary — a smuggled ``cwd``/``workspace`` is refused outright
    instead of being ignored and looking accepted.
    """

    model_config = ConfigDict(extra="forbid")


class ProductionBriefRequest(_ClosedRequest):
    expected_version: int = Field(ge=1)
    brief: str = Field(min_length=1, max_length=output_store_module.MAX_BRIEF_CHARS)
    evidence_refs: list[str] = Field(default_factory=list, max_length=output_store_module.MAX_EVIDENCE_REFS)


class ProductionRunRequest(_ClosedRequest):
    expected_version: int = Field(ge=1)
    producer_session_id: str = Field(min_length=1, max_length=output_store_module.MAX_SESSION_REF_CHARS)
    submission_id: str = Field(min_length=1, max_length=128)


class RunClaimRequest(_ClosedRequest):
    request_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=output_store_module.MAX_SESSION_REF_CHARS)


class RunCollectRequest(_ClosedRequest):
    collection_claim: str = Field(min_length=16, max_length=256)


class ReviewRunRequest(_ClosedRequest):
    expected_output_version: int = Field(ge=1)
    reviewer: dict


class ReviewFinding(_ClosedRequest):
    severity: Literal["low", "medium", "high", "critical"]
    code: str = Field(min_length=1, max_length=64)
    detail: str = Field(min_length=1, max_length=output_store_module.MAX_FINDING_DETAIL_CHARS)
    path: Optional[str] = Field(default=None, max_length=512)


class ReviewCompleteRequest(_ClosedRequest):
    verdict: Literal["verified", "changes_requested"]
    findings: list[ReviewFinding] = Field(default_factory=list, max_length=output_store_module.MAX_FINDINGS)


class RevisionRunRequest(_ClosedRequest):
    expected_output_version: int = Field(ge=1)
    producer_session_id: str = Field(min_length=1, max_length=output_store_module.MAX_SESSION_REF_CHARS)


class ApproveOutputRequest(_ClosedRequest):
    """The exact approval request. There is no approver or approval-time field."""

    meeting_id: str = Field(min_length=1, max_length=128)
    expected_meeting_version: int = Field(ge=1)
    expected_output_version: int = Field(ge=1)
    artifact_version: int = Field(ge=1)
    game_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    manifest_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    zip_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


def _output_eligibility(output: dict[str, Any]) -> dict[str, bool]:
    """Server-declared action eligibility. The UI shows only what is true."""
    state = output["state"]
    current = int(output["current_artifact_version"])
    return {
        "produce": state == "candidate" and current == 0,
        "review": state == "reviewing" and current > 0,
        "revise": state == "changes_requested",
        "approve": state == "verified" and int(output["verified_artifact_version"]) > 0,
        "preview": current > 0,
        "download": current > 0,
    }


def _output_dto(store: MeetingOutputStore, output: dict[str, Any]) -> dict[str, Any]:
    versions = store.list_versions(output["output_id"])
    return {
        "output": output,
        "eligibility": _output_eligibility(output),
        "versions": versions,
        "reviews": store.list_review_runs(output["output_id"]),
    }


@router.get("/meetings/{meeting_id}/outputs")
def list_meeting_outputs(
    request: Request,
    meeting_id: str,
    limit: int = Query(default=20, ge=1, le=output_store_module.MAX_LIST_LIMIT),
):
    _authorize_view(request)
    store = _output_store()
    try:
        outputs = store.list_outputs(meeting_id, limit=limit)
    except Exception as exc:
        raise _output_http_error(exc) from exc
    return {
        "meeting_id": meeting_id,
        "outputs": [
            {"output": row, "eligibility": _output_eligibility(row)} for row in outputs
        ],
    }


@router.get("/meeting-outputs/{output_id}")
def get_meeting_output(request: Request, output_id: str):
    _authorize_view(request)
    store = _output_store()
    try:
        return _output_dto(store, store.get_output(output_id))
    except Exception as exc:
        raise _output_http_error(exc) from exc


@router.get("/meeting-outputs/{output_id}/versions")
def list_meeting_output_versions(
    request: Request,
    output_id: str,
    limit: int = Query(default=50, ge=1, le=output_store_module.MAX_LIST_LIMIT),
):
    _authorize_view(request)
    store = _output_store()
    try:
        store.get_output(output_id)
        return {"output_id": output_id, "versions": store.list_versions(output_id, limit=limit)}
    except Exception as exc:
        raise _output_http_error(exc) from exc


@router.get("/meeting-outputs/{output_id}/recovery")
def get_meeting_output_recovery(request: Request, output_id: str):
    """Durable lifecycle truth after a reload or a process restart."""
    _authorize_view(request)
    store = _output_store()
    try:
        return store.recover_output(output_id)
    except Exception as exc:
        raise _output_http_error(exc) from exc


@router.post("/meetings/{meeting_id}/production-brief")
def freeze_production_brief(request: Request, meeting_id: str, body: ProductionBriefRequest):
    """Freeze the orchestrator brief and reach the production_ready stage."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            frozen = store.freeze_production_brief(
                meeting_id,
                expected_meeting_version=body.expected_version,
                brief=body.brief,
                evidence_refs=body.evidence_refs,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc
        return {
            "meeting_id": frozen["meeting_id"],
            "meeting_version": frozen["meeting_version"],
            "brief_hash": frozen["brief_hash"],
            "acceptance_statement": frozen["acceptance_statement"],
            "evidence_refs": frozen["evidence_refs"],
            "production_stage": frozen["meeting"]["production_stage"],
        }

    return _idempotent(
        store, request, "production.brief", body.model_dump(), run, resource=meeting_id
    )


@router.post("/meetings/{meeting_id}/production-runs")
def create_production_run(request: Request, meeting_id: str, body: ProductionRunRequest):
    """Checkpoint a producer run and mint its server-owned workspace."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            created = store.begin_production_run(
                meeting_id=meeting_id,
                expected_meeting_version=body.expected_version,
                producer_session_id=body.producer_session_id,
                submission_id=body.submission_id,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc
        # Authenticated dispatcher response. It carries the server-assigned
        # cwd because a producer session cannot be created without it, and it
        # NEVER carries the single-use collection claim. The cwd appears in no
        # meeting record, no output DTO, and no error body.
        return {
            "run_id": created["run_id"],
            "output_id": created["output_id"],
            "kind": created["kind"],
            "meeting_id": created["meeting_id"],
            "meeting_version": created["meeting_version"],
            "parent_artifact_version": created["parent_artifact_version"],
            "cwd": created["cwd"],
            "workspace_identity": created["workspace_identity"],
        }

    return _idempotent(
        store, request, "production.run", body.model_dump(), run, resource=meeting_id
    )


@router.post("/meeting-outputs/{output_id}/revision-runs")
def create_revision_run(request: Request, output_id: str, body: RevisionRunRequest):
    """Open a revision run bound to the rejected parent artifact version."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            created = store.begin_revision_run(
                output_id,
                expected_output_version=body.expected_output_version,
                producer_session_id=body.producer_session_id,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc
        # Same dispatcher contract as a production run: the assigned cwd, and
        # never the collection claim.
        return {
            "run_id": created["run_id"],
            "output_id": created["output_id"],
            "kind": created["kind"],
            "meeting_id": created["meeting_id"],
            "meeting_version": created["meeting_version"],
            "parent_artifact_version": created["parent_artifact_version"],
            "cwd": created["cwd"],
            "workspace_identity": created["workspace_identity"],
        }

    return _idempotent(
        store, request, "revision.run", body.model_dump(), run, resource=output_id
    )


def _claim_replay_is_live(store: MeetingOutputStore, db, response: object) -> bool:
    """An idempotent claim replay is authority only while its lease is live."""
    if not isinstance(response, dict) or not isinstance(response.get("claim"), dict):
        return False
    claim = response["claim"]
    claim_id = str(claim.get("claim_id") or "")
    if not claim_id:
        return False
    row = db.execute(
        "SELECT expires_at, renewals, consumed FROM meeting_output_prompt_claims"
        " WHERE claim_id = ?",
        (claim_id,),
    ).fetchone()
    return bool(
        row is not None
        and not int(row["consumed"])
        and int(row["expires_at"]) > store._now()
        and int(row["renewals"]) == int(claim.get("renewals", -1))
    )


def _claim_run(request: Request, run_id: str, body: RunClaimRequest, *, kind: str | None):
    """Claim a producer dispatch and hand the dispatcher its assigned cwd.

    The claim is the ONLY door to the assigned cwd and the single-use
    collection claim, and taking it consumes a lease. A dropped response
    therefore used to leave the dispatcher holding an active lease it could
    never read back, so the run could not be collected at all. The key makes
    the exact retry replay that one dispatch response -- cwd and collection
    claim included -- while a changed binding under the same key conflicts.

    The replay record for this action carries those dispatcher-only fields, so
    it is exactly as sensitive as ``meeting_output_run_secrets`` and lives in
    the same private database behind the same authenticated door.
    """
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            # One transaction binds the actual producer session, takes the
            # dispatch claim, and reads the dispatcher-only cwd + collection
            # claim -- on the idempotency transaction's own connection, so the
            # receipt commits with the binding or not at all.
            return store.claim_dispatch(
                run_id,
                kind=kind,
                request_id=body.request_id,
                session_id=body.session_id,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc

    return _idempotent(
        store,
        request,
        "run.claim",
        {**body.model_dump(), "kind": kind},
        run,
        resource=run_id,
        replay_guard=lambda db, response: _claim_replay_is_live(store, db, response),
    )


@router.post("/meeting-output-runs/{run_id}/claim")
def claim_output_run(request: Request, run_id: str, body: RunClaimRequest):
    return _claim_run(request, run_id, body, kind=None)


@router.post("/meeting-output-revision-runs/{request_id}/claim")
def claim_revision_run(request: Request, request_id: str, body: RunClaimRequest):
    return _claim_run(request, request_id, body, kind="revision")


def _collect_run(request: Request, run_id: str, body: RunCollectRequest, *, kind: str | None):
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            run_row = store.get_run(run_id, connection=db)
            if kind is not None and run_row["kind"] != kind:
                raise output_store_module.OutputNotFound(run_id)
            receipt = store.collect_run(
                run_id, claim_token=body.collection_claim, connection=db
            )
            output = store.get_output(run_row["output_id"], connection=db)
        except Exception as exc:
            raise _output_http_error(exc) from exc
        return {"receipt": receipt, "output": output, "eligibility": _output_eligibility(output)}

    # The presented collection claim is part of the request, so it is part of
    # the hash: otherwise one key would replay a receipt for a claim this
    # request never presented. Only its hash goes in, so the raw single-use
    # token is neither persisted in the replay record nor derivable from it,
    # while a different claim under the same key still conflicts.
    return _idempotent(
        store,
        request,
        "run.collect",
        {
            "run_id": run_id,
            "kind": kind,
            "collection_claim_sha256": _collection_claim_digest(body.collection_claim),
        },
        run,
        resource=run_id,
    )


@router.post("/meeting-output-runs/{run_id}/collect")
def collect_output_run(request: Request, run_id: str, body: RunCollectRequest):
    return _collect_run(request, run_id, body, kind=None)


@router.post("/meeting-output-revision-runs/{request_id}/collect")
def collect_revision_run(request: Request, request_id: str, body: RunCollectRequest):
    return _collect_run(request, request_id, body, kind="revision")


@router.post("/meeting-outputs/{output_id}/review-runs")
def create_review_run(request: Request, output_id: str, body: ReviewRunRequest):
    """Open an independent review bound to exactly one artifact version."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            return store.begin_review_run(
                output_id,
                reviewer=body.reviewer,
                expected_output_version=body.expected_output_version,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc

    return _idempotent(
        store, request, "review.run", body.model_dump(), run, resource=output_id
    )


@router.post("/meeting-output-review-runs/{request_id}/claim")
def claim_review_run(request: Request, request_id: str, body: RunClaimRequest):
    """Claim a reviewer dispatch. Reviewers never receive a writable path."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            # One transaction reads the review, its output version, and the
            # meeting version and binds all three into the claim, so a verdict
            # can never be authorized against versions that had already moved.
            return store.claim_review_dispatch(
                request_id,
                dispatch_request_id=body.request_id,
                session_id=body.session_id,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc

    return _idempotent(
        store,
        request,
        "review.claim",
        body.model_dump(),
        run,
        resource=request_id,
        replay_guard=lambda db, response: _claim_replay_is_live(store, db, response),
    )


@router.post("/meeting-output-review-runs/{request_id}/complete")
def complete_review_run(request: Request, request_id: str, body: ReviewCompleteRequest):
    """Record a verdict. A verified verdict needs every check to pass."""
    _authorize_mutation(request)
    store = _output_store()

    def run(db):
        try:
            completed = store.complete_review_run(
                request_id,
                verdict=body.verdict,
                findings=[finding.model_dump(exclude_none=True) for finding in body.findings],
                connection=db,
            )
            output = store.get_output(completed["output_id"], connection=db)
        except Exception as exc:
            raise _output_http_error(exc) from exc
        return {
            "review": completed,
            "output": output,
            "eligibility": _output_eligibility(output),
        }

    return _idempotent(
        store, request, "review.complete", body.model_dump(), run, resource=request_id
    )


@router.post("/meeting-outputs/{output_id}/approve")
def approve_meeting_output(request: Request, output_id: str, body: ApproveOutputRequest):
    """The exact owner approval transaction."""
    principal = _authorize_owner(request)
    store = _output_store()

    def run(db):
        try:
            approved = store.approve_output(
                output_id,
                meeting_id=body.meeting_id,
                expected_meeting_version=body.expected_meeting_version,
                expected_output_version=body.expected_output_version,
                artifact_version=body.artifact_version,
                game_sha256=body.game_sha256,
                manifest_sha256=body.manifest_sha256,
                zip_sha256=body.zip_sha256,
                # Derived from request authentication, never from the body.
                approver_digest=principal,
                connection=db,
            )
        except Exception as exc:
            raise _output_http_error(exc) from exc
        return {
            "output": approved["output"],
            "eligibility": _output_eligibility(approved["output"]),
            "meeting": approved["meeting"],
            "meeting_version": approved["meeting_version"],
            "artifact_binding": approved["artifact_binding"],
        }

    return _idempotent(
        store, request, "output.approve", body.model_dump(), run, resource=output_id
    )


_ARTIFACT_RESPONSE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
}


@router.get("/meeting-outputs/{output_id}/versions/{artifact_version}/files/{path:path}")
def preview_meeting_output_file(
    request: Request,
    output_id: str,
    artifact_version: int,
    path: str,
):
    """Preview one declared member. Hash knowledge is not authorization."""
    _authorize_view(request)
    store = _output_store()
    try:
        store.get_output(output_id)
        member = store.read_member(output_id, artifact_version, path)
    except Exception as exc:
        raise _output_http_error(exc) from exc

    disposition = package_module.preview_disposition(member.media_type, member.preview_policy)
    cap = package_module.preview_byte_cap(member.preview_policy)
    if disposition == "attachment" or cap <= 0:
        return Response(
            content=member.payload,
            media_type="application/octet-stream",
            headers={
                **_ARTIFACT_RESPONSE_HEADERS,
                "Content-Disposition": "attachment; filename=\"artifact.bin\"",
                "X-Hermes-Artifact-Sha256": member.sha256,
                "X-Hermes-Preview-Policy": member.preview_policy,
            },
        )
    if len(member.payload) > cap:
        raise HTTPException(status_code=413, detail=_code("operations_preview_too_large"))
    if member.preview_policy == "text":
        try:
            member.payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status_code=422, detail=_code("operations_preview_not_utf8")
            ) from exc
    return Response(
        content=member.payload,
        media_type=member.media_type,
        headers={
            **_ARTIFACT_RESPONSE_HEADERS,
            "Content-Disposition": "inline",
            "X-Hermes-Artifact-Sha256": member.sha256,
            "X-Hermes-Preview-Policy": member.preview_policy,
        },
    )


@router.get("/meeting-outputs/{output_id}/versions/{artifact_version}/download")
def download_meeting_output_package(request: Request, output_id: str, artifact_version: int):
    """Stream the stored immutable package as an attachment."""
    _authorize_view(request)
    store = _output_store()
    try:
        output = store.get_output(output_id)
        version = store.get_version(output_id, artifact_version)
        payload = store.package_bytes(output_id, artifact_version)
    except Exception as exc:
        raise _output_http_error(exc) from exc

    approved = int(output["approved_artifact_version"]) == int(artifact_version)
    verified = int(output["verified_artifact_version"]) == int(artifact_version)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            **_ARTIFACT_RESPONSE_HEADERS,
            "Content-Disposition": (
                f'attachment; filename="deliverable-v{int(artifact_version)}.zip"'
            ),
            "X-Hermes-Artifact-Sha256": version["zip_sha256"],
            "X-Hermes-Artifact-Status": (
                "approved" if approved else "verified" if verified else "candidate"
            ),
        },
    )
