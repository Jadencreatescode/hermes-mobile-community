"""Bounded, credential-neutral imports for connected harness agents."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

_MAX_SOURCE_BYTES = 1_000_000
_MAX_FILENAME_LENGTH = 255
_MAX_NAME_LENGTH = 128
_MAX_DESCRIPTION_LENGTH = 4_096
_MAX_INSTRUCTIONS_LENGTH = 65_536
_MAX_LIST_ITEMS = 64
_MAX_LIST_ITEM_LENGTH = 256
_MAX_DEPTH = 20

_CREDENTIAL_KEY_SUFFIXES = (
    "apikey",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "password",
    "passwd",
    "clientsecret",
    "privatekey",
    "secret",
    "token",
    "credential",
    "credentials",
    "cookie",
    "cookies",
)
_BEARER_LINE_RE = re.compile(r"(?im)(\bbearer\s+).*$")
_CREDENTIAL_ASSIGNMENT_LINE_RE = re.compile(
    r"(?i)(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
    r"password|passwd|client[_-]?secret|private[_-]?key|credential|secret|token|"
    r"cookie)\s*[:=]\s*).*$",
    re.MULTILINE,
)
_URL_SECRET_RE = re.compile(
    r"(?i)(https?://)([^\s/@:]+):([^\s/@]+)@|"
    r"([?&](?:access_token|api[_-]?key|auth|key|password|secret|token)=)[^&#\s]+"
)
_VENDOR_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|"
    r"AKIA|ASIA|AIza|ya29\.|eyJ)[A-Za-z0-9._-]{12,}"
)
_HIGH_ENTROPY_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9])")


@dataclass(frozen=True)
class AgentImport:
    """A neutral template and any sanitization warnings produced for it."""

    template: dict[str, Any]
    warnings: list[str]


def _is_credential_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
    return normalized == "authorization" or normalized.endswith(
        _CREDENTIAL_KEY_SUFFIXES
    )


def _redact_string(value: str) -> tuple[str, int]:
    redactions = 0

    def redact(match: re.Match[str]) -> str:
        nonlocal redactions
        redactions += 1
        return f"{match.group(1)}[REDACTED]"

    value = _BEARER_LINE_RE.sub(redact, value)
    value = _CREDENTIAL_ASSIGNMENT_LINE_RE.sub(redact, value)

    def redact_url(match: re.Match[str]) -> str:
        nonlocal redactions
        redactions += 1
        if match.group(1):
            return f"{match.group(1)}[REDACTED]@"
        return f"{match.group(4)}[REDACTED]"

    value = _URL_SECRET_RE.sub(redact_url, value)
    for pattern in (_VENDOR_TOKEN_RE, _HIGH_ENTROPY_RE):
        value, count = pattern.subn("[REDACTED]", value)
        redactions += count
    return value, redactions


def redact_agent_text(value: str) -> str:
    """Redact credential-shaped values before agent text crosses persistence."""
    from agent.redact import redact_sensitive_text

    return _redact_string(redact_sensitive_text(value, force=True))[0]


def _sanitize(value: Any, *, depth: int = 0) -> tuple[Any, int, int]:
    if depth > _MAX_DEPTH:
        raise ValueError("agent import exceeds the maximum nesting depth")

    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        removed_fields = 0
        redactions = 0
        for key, item in value.items():
            if _is_credential_key(key):
                removed_fields += 1
                continue
            clean_item, child_removed, child_redactions = _sanitize(
                item, depth=depth + 1
            )
            sanitized[key] = clean_item
            removed_fields += child_removed
            redactions += child_redactions
        return sanitized, removed_fields, redactions

    if isinstance(value, list):
        sanitized_items: list[Any] = []
        removed_fields = 0
        redactions = 0
        for item in value:
            clean_item, child_removed, child_redactions = _sanitize(
                item, depth=depth + 1
            )
            sanitized_items.append(clean_item)
            removed_fields += child_removed
            redactions += child_redactions
        return sanitized_items, removed_fields, redactions

    if isinstance(value, str):
        clean_value, redactions = _redact_string(value)
        return clean_value, 0, redactions

    return value, 0, 0


def _bounded_string(
    value: Any,
    field: str,
    *,
    maximum: int,
    required: bool = False,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{field} must not be empty")
    if len(value) > maximum:
        raise ValueError(f"{field} exceeds the maximum length")
    return value


def _slug(value: str, *, separator: str) -> str:
    ascii_value = (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]+", separator, ascii_value.casefold()).strip(
        separator
    )
    if not slug:
        raise ValueError("agent import cannot produce an empty slug")
    return slug[:64].rstrip(separator)


def _bounded_string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    if len(value) > _MAX_LIST_ITEMS:
        raise ValueError(f"{field} exceeds the maximum item count")

    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > _MAX_LIST_ITEM_LENGTH:
            raise ValueError(f"{field} contains an invalid item")
        result.append(item)
    return result


def _normalize_model(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return {"id": _bounded_string(value, "model.id", maximum=256, required=True)}
    if not isinstance(value, dict):
        raise ValueError("model must be a string or object")

    model_id = _bounded_string(value.get("id"), "model.id", maximum=256, required=True)
    provider = _bounded_string(value.get("provider"), "model.provider", maximum=128)
    return {**({"provider": provider} if provider else {}), "id": model_id}


def parse_agent_import(source: str, filename: str) -> AgentImport:
    """Parse one JSON agent export into a bounded, credential-neutral template."""
    if not isinstance(source, str):
        raise TypeError("source must be a string")
    if len(source.encode("utf-8")) > _MAX_SOURCE_BYTES:
        raise ValueError("agent import exceeds the maximum source size")
    if (
        not isinstance(filename, str)
        or not filename
        or len(filename) > _MAX_FILENAME_LENGTH
        or "\x00" in filename
    ):
        raise ValueError("source filename is invalid")

    try:
        parsed = json.loads(source)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("agent import must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("agent import must contain a JSON object")

    sanitized, removed_fields, redactions = _sanitize(parsed)
    name = _bounded_string(
        sanitized.get("displayName"),
        "displayName",
        maximum=_MAX_NAME_LENGTH,
        required=True,
    )
    platform = _bounded_string(
        sanitized.get("platform"),
        "platform",
        maximum=64,
        required=True,
    )
    description = _bounded_string(
        sanitized.get("summary"),
        "summary",
        maximum=_MAX_DESCRIPTION_LENGTH,
    )
    instructions = _bounded_string(
        sanitized.get("systemPrompt"),
        "systemPrompt",
        maximum=_MAX_INSTRUCTIONS_LENGTH,
    )
    skills = _bounded_string_list(sanitized.get("skills"), "skills")
    tools = _bounded_string_list(sanitized.get("capabilities"), "capabilities")

    model = _normalize_model(sanitized.get("model"))

    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    handle = _slug(name, separator="-")
    harness = _slug(platform, separator="_")
    template: dict[str, Any] = {
        "id": f"{harness}:{handle}:{digest[-12:]}",
        "name": name,
        "handle": handle,
        "description": description,
        "instructions": instructions,
        "harness": harness,
        "model": model,
        "skills": skills,
        "tools": tools,
        "source_fingerprint": f"sha256:{digest}",
        "source_filename": filename,
    }

    warnings: list[str] = []
    if removed_fields:
        warnings.append(
            f"Removed {removed_fields} credential-shaped field(s) from the import."
        )
    if redactions:
        warnings.append(
            f"Redacted {redactions} embedded credential value(s) from the import."
        )
    return AgentImport(template=template, warnings=warnings)
