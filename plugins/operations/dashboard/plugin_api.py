"""Authenticated public Operations plugin API.

The router owns only bounded Mailroom metadata and dispatches through the
existing Bot Mode delivery path. It never returns commands, process handles,
credentials, endpoint URLs, environment values, or lease tokens.
"""

from __future__ import annotations

import importlib.util
import json
import shlex
import sys
import threading
import time
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
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
