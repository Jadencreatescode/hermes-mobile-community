"""Public Training Mode draft and hash-bound save API.

The API retains no draft state and exposes no execution or scheduling route.
Every approval regenerates the canonical skill from bounded semantic input,
checks an exact hash-bound phrase, writes through the normal skill manager, and
reads the installed bytes back before reporting success.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import unquote, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

router = APIRouter()

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SECRET_LABEL_RE = re.compile(
    r"password|passphrase|passcode|verification code|authentication code|security code|access code|recovery code|one.?time|\botp\b|\b2fa\b|\bmfa\b|\bpin\b|credential|authenticate|login|log.?in|sign.?in|username|user id|api.?key|access key|token|secret|private key|cookie|session id|authorization|payment|card number|account number|routing number|social security",
    re.I,
)
_RAW_SECRET_RE = re.compile(
    r"(?:sk|gh[op])-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|(?:api[_-]?key|password|token|secret)\s*[:=]\s*\S+",
    re.I,
)
_PRIVATE_BROWSER_DATA_RE = re.compile(
    r"\b(?:cookie|local\s*storage|session\s*storage|indexeddb|authorization\s+header|bearer\s+token)\b",
    re.I,
)
_RAW_VALUE_ACTION_RE = re.compile(
    r"\b(?:(?:type|enter|paste|input|provide|supply|fill|use)\b|(?:set|write|insert|put|populate|assign|configure|update|replace|apply|record|copy|place|store|unlock)\b.+?\b(?:to|into|in|as|with|using)\b)",
    re.I,
)
_RAW_TRIGGER_VALUE_RE = re.compile(
    r"\b(?:(?:type|enter|paste|input|provide|supply|fill)\b|(?:set|write|insert|put|populate|assign|configure|update|replace|apply|record|copy|place|store|unlock)\b.+?\b(?:to|into|in|as|with|using)\b)",
    re.I,
)
_CONSEQUENTIAL_ACTION_RE = re.compile(
    r"^\s*(?:submit|send|publish|post|delete|remove|purchase|pay|transfer)\b", re.I
)
_CODE_VALUE_RE = re.compile(
    r"(?:\b(?:code|number)\b\s*(?:(?:is|equals)\s+|[:=]\s*)\S+|\b(?:code|number)\b\s+(?:\d{3,}|[A-Za-z0-9]*[-_=:.][A-Za-z0-9_.:=-]+)\b)",
    re.I,
)
_VALUE_LIKE_TOKEN_RE = re.compile(
    r"(?:\b\d{3,}\b|\b(?=[A-Za-z0-9_-]{12,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}\b)"
)
_ASSIGNMENT_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9_.-]{1,}\s*=\s*\S+")
_INVISIBLE_RE = re.compile(r"[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]")
_PATH_SECRET_MARKERS = frozenset({
    "access-token",
    "activate",
    "activation",
    "callback",
    "code",
    "invite",
    "invitation",
    "magic",
    "magic-link",
    "oauth-callback",
    "password-reset",
    "reset",
    "reset-password",
    "token",
    "verification",
    "verify",
})
_PRIVATE_ALIAS_SUFFIXES = (".nip.io", ".sslip.io", ".localtest.me", ".local.gd")
_MAX_STEPS = 50


class TrainingStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "navigate",
        "click",
        "select",
        "type_redacted",
        "wait_for",
        "assert_visible",
        "note",
    ]
    label: str = Field(default="", max_length=256)
    url: str = Field(default="", max_length=2048)
    note: str = Field(default="", max_length=500)


class TrainingDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    trigger: str = Field(min_length=1, max_length=2000)
    steps: list[TrainingStep] = Field(min_length=1, max_length=_MAX_STEPS)


class TrainingApprovalRequest(TrainingDraftRequest):
    draft_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    approval: str = Field(min_length=1, max_length=160)


def _text(value: str, field: str, maximum: int) -> str:
    clean = _INVISIBLE_RE.sub("", value or "").strip()
    if not clean or len(clean) > maximum or "\x00" in clean:
        raise ValueError(f"{field} is invalid")
    return clean


def _name(value: str) -> str:
    clean = _text(value, "name", 64)
    if not _NAME_RE.fullmatch(clean) or clean in {"root", "profiles"}:
        raise ValueError("name must be a lowercase Hermes identifier")
    return clean


def _safe_path(path: str) -> str:
    segments = path.split("/")
    safe: list[str] = []
    redact_tail = False
    for segment in segments:
        if redact_tail and segment:
            break
        decoded = unquote(segment).strip()
        if re.fullmatch(r"[0-9a-fA-F]{24,}", decoded):
            break
        if re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            decoded,
        ):
            break
        if len(decoded) >= 20 and re.fullmatch(r"[A-Za-z0-9._~+=-]+", decoded):
            break
        safe.append(segment)
        if decoded.lower().replace("_", "-") in _PATH_SECRET_MARKERS:
            redact_tail = True
    return "/".join(safe) or "/"


def _safe_url(value: str) -> str:
    raw = _text(value, "url", 2048)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("navigation requires credential-free HTTPS")
    host = parsed.hostname.lower()
    if (
        host in {"localhost", "localhost.localdomain"}
        or host.endswith(".local")
        or any(host.endswith(suffix) for suffix in _PRIVATE_ALIAS_SUFFIXES)
    ):
        raise ValueError("private navigation targets are forbidden")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("private navigation targets are forbidden")
    return urlunsplit(("https", parsed.netloc, _safe_path(parsed.path or "/"), "", ""))


def _normalized_step(step: TrainingStep) -> tuple[str, str]:
    kind = step.kind
    if kind == "navigate":
        return kind, _safe_url(step.url)
    if kind == "type_redacted":
        label = _text(step.label or "sensitive field", "field label", 256)
        if (
            _SECRET_LABEL_RE.search(label)
            or _RAW_SECRET_RE.search(label)
            or _PRIVATE_BROWSER_DATA_RE.search(label)
            or _CODE_VALUE_RE.search(label)
            or _VALUE_LIKE_TOKEN_RE.search(label)
            or _ASSIGNMENT_RE.search(label)
            or _RAW_VALUE_ACTION_RE.search(label)
        ):
            label = "sensitive field"
        return kind, label
    if kind == "note":
        note = _text(step.note, "note", 500)
        if (
            _SECRET_LABEL_RE.search(note)
            or _RAW_SECRET_RE.search(note)
            or _PRIVATE_BROWSER_DATA_RE.search(note)
            or _CODE_VALUE_RE.search(note)
            or _VALUE_LIKE_TOKEN_RE.search(note)
            or _ASSIGNMENT_RE.search(note)
            or _RAW_VALUE_ACTION_RE.search(note)
        ):
            return "type_redacted", "sensitive field"
        if _CONSEQUENTIAL_ACTION_RE.search(note):
            return (
                "note",
                "Perform the reviewed consequential action only after fresh user approval.",
            )
        return kind, note
    label = _text(step.label, "step label", 256)
    if (
        _SECRET_LABEL_RE.search(label)
        or _RAW_SECRET_RE.search(label)
        or _PRIVATE_BROWSER_DATA_RE.search(label)
        or _CODE_VALUE_RE.search(label)
        or _VALUE_LIKE_TOKEN_RE.search(label)
        or _ASSIGNMENT_RE.search(label)
        or _RAW_VALUE_ACTION_RE.search(label)
    ):
        return "type_redacted", "sensitive field"
    return kind, label


def _title(name: str) -> str:
    return " ".join(part.capitalize() for part in re.split(r"[-_]+", name) if part)


def _draft(body: TrainingDraftRequest) -> dict[str, object]:
    name = _name(body.name)
    trigger = _text(body.trigger, "trigger", 2000)
    if (
        _SECRET_LABEL_RE.search(trigger)
        or _RAW_SECRET_RE.search(trigger)
        or _PRIVATE_BROWSER_DATA_RE.search(trigger)
        or _CODE_VALUE_RE.search(trigger)
        or _VALUE_LIKE_TOKEN_RE.search(trigger)
        or _ASSIGNMENT_RE.search(trigger)
        or _RAW_TRIGGER_VALUE_RE.search(trigger)
    ):
        raise ValueError(
            "semantic trigger must not contain credentials, raw values, or private browser data"
        )
    normalized = [_normalized_step(step) for step in body.steps]
    procedure: list[str] = []
    public_steps: list[dict[str, str]] = []
    for index, (kind, value) in enumerate(normalized, 1):
        if kind == "navigate":
            sentence = f"Open `{value}`."
        elif kind == "type_redacted":
            sentence = f"Enter the required value for **{value}** through a fresh human input gate. Never retain it."
        elif kind == "note":
            sentence = value
        else:
            sentence = f"{kind.replace('_', ' ').title()} **{value}**."
        procedure.append(f"{index}. {sentence}")
        public_steps.append({"kind": kind, "value": value})

    title = _title(name)
    content = "\n".join([
        "---",
        f"name: {name}",
        'description: "Use when running this reviewed task with approval."',
        "version: 0.1.0",
        "author: Hermes",
        "metadata:",
        "  hermes:",
        "    tags: [Training, Workflow, Approval]",
        "---",
        "",
        f"# {title}",
        "",
        trigger,
        "",
        "This skill contains only the reviewed task procedure. It never authorizes automatic execution or scheduling.",
        "",
        "## When to Use",
        "",
        f"Use when the user asks Hermes to perform the reviewed **{title}** workflow.",
        "",
        "## Prerequisites",
        "",
        "1. Reconfirm the target, account, destination, and current scope.",
        "2. Ask the user for required sensitive values at execution time. Never retain them.",
        "3. Preserve every normal Hermes approval boundary.",
        "",
        "## Procedure",
        "",
        *procedure,
        "",
        "## Pitfalls",
        "",
        "1. Stop if the interface, participant, destination, or expected state differs from this reviewed procedure.",
        "2. Never infer success from a click or request alone. Read back the final state.",
        "3. Never retry payments, publication, deletion, or external messages without fresh user approval.",
        "",
        "## Approval Boundaries",
        "",
        "Approval creates this skill only. Approval does not authorize execution or scheduling.",
        "Passwords, verification codes, payments, identity actions, publication, deletion, and external messages require fresh approval.",
        "",
        "## Verification",
        "",
        "Verify the final state through the same interface that owns it, then report the exact completed and uncompleted steps.",
        "",
    ])
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return {
        "name": name,
        "skill_md": content,
        "draft_hash": digest,
        "approval_phrase": f"SAVE {name} {digest}",
        "steps": public_steps,
    }


def _write_and_verify(
    name: str, content: str, digest: str, profile: Optional[str]
) -> dict[str, object]:
    from hermes_cli.web_server import _profile_scope
    from tools.skill_manager_tool import _create_skill, _find_skill

    with _profile_scope(profile):
        existing = _find_skill(name)
        if existing:
            skill_md = Path(existing["path"]) / "SKILL.md"
            current_hash = hashlib.sha256(skill_md.read_bytes()).hexdigest()
            if current_hash == digest:
                return {
                    "saved": True,
                    "idempotent": True,
                    "name": name,
                    "draft_hash": digest,
                }
            raise ValueError("a different skill with this name already exists")
        result = _create_skill(name, content, "productivity")
        if not result.get("success"):
            raise ValueError(str(result.get("error") or "skill creation failed"))
        installed_hash = hashlib.sha256(
            Path(str(result["skill_md"])).read_bytes()
        ).hexdigest()
        if installed_hash != digest:
            raise RuntimeError("installed skill hash mismatch")
        return {"saved": True, "idempotent": False, "name": name, "draft_hash": digest}


async def _validated_body(request: Request, model):
    try:
        raw = await request.json()
        return model.model_validate(raw)
    except (ValueError, ValidationError):
        raise HTTPException(
            status_code=400,
            detail="invalid training request",
            headers={"Cache-Control": "no-store"},
        ) from None


def _approve(body: TrainingApprovalRequest, profile: Optional[str]):
    canonical = _draft(
        TrainingDraftRequest(name=body.name, trigger=body.trigger, steps=body.steps)
    )
    digest = str(canonical["draft_hash"])
    if body.draft_hash != digest or body.approval != canonical["approval_phrase"]:
        raise ValueError("draft changed or approval phrase is invalid")
    return _write_and_verify(
        str(canonical["name"]), str(canonical["skill_md"]), digest, profile
    )


@router.post("/draft")
async def draft_training(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    body = await _validated_body(request, TrainingDraftRequest)
    try:
        return _draft(body)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
            headers={"Cache-Control": "no-store"},
        ) from None


@router.post("/approve")
async def approve_training(
    request: Request,
    response: Response,
    profile: Optional[str] = None,
):
    response.headers["Cache-Control"] = "no-store"
    body = await _validated_body(request, TrainingApprovalRequest)
    try:
        return _approve(body, profile)
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail=str(exc),
            headers={"Cache-Control": "no-store"},
        ) from None
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="training save verification failed",
            headers={"Cache-Control": "no-store"},
        ) from None
