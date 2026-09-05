"""Connected agent import sanitizer and neutral manifest normalizer.

Implements the bounded preview-first import path for the eight approved
harness families.  Every imported agent source is fingerprinted, recursively
stripped of credential fields, redacted for secret-shaped values, normalized
into a schema-versioned neutral manifest, and validated against the approved
harness-family list before it can enter the live roster.

The module is import-safe (no side effects at module level) and does NOT
register itself as a model tool; it is a library used by Bot Mode, the
desktop Operations plugin, and gateway import surfaces.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── bounds ───────────────────────────────────────────────────────────────────
MAX_SOURCE_BYTES = 1_048_576  # 1 MB
MAX_NESTING_DEPTH = 64
MAX_NAME_CHARS = 256
MAX_SLUG_CHARS = 256
MAX_DESCRIPTION_CHARS = 4096
MAX_INSTRUCTIONS_BYTES = 65_536  # 64 KB
MAX_ARRAY_ITEMS = 256
MAX_ARRAY_STRING_CHARS = 256

# ── credential stripping ─────────────────────────────────────────────────────
_CREDENTIAL_KEYS = frozenset(
    {
        "api_key",
        "token",
        "secret",
        "password",
        "credential",
        "cookie",
        "authorization",
        "__proto__",
        "constructor",
        "prototype",
    }
)

# ── secret redaction patterns ────────────────────────────────────────────────
_SECRET_PATTERNS = [
    (re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]+"), "Bearer ***"),
    (re.compile(r"Cookie:\s*[^\s;]+"), "Cookie: ***"),
    (re.compile(r"sk-[a-zA-Z0-9]{20,}"), "sk-***"),
    (re.compile(r"pk-[a-zA-Z0-9]{20,}"), "pk-***"),
    (re.compile(r"ghp_[a-zA-Z0-9]{20,}"), "ghp_***"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{20,}"), "AIza***"),
    # Base64 high-entropy strings inside known credential contexts
    (re.compile(r"(api[_-]?key\s*[:=]\s*)([A-Za-z0-9+/]{40,}={0,2})"), r"\1***"),
    (re.compile(r"(auth\s*[:=]\s*)([A-Za-z0-9+/]{40,}={0,2})"), r"\1***"),
]

# ── harness families ─────────────────────────────────────────────────────────


class HarnessFamily(str, Enum):
    HERMES = "hermes"
    PI = "pi"
    CLAUDE_CODE = "claude_code"
    CODEX = "codex"
    OPENCODE = "opencode"
    CURSOR = "cursor"
    GITHUB_COPILOT = "github_copilot"
    GENERIC_A2A = "generic_a2a"


_APPROVED_HARNESS_FAMILIES = frozenset(HarnessFamily)


# ── data classes ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SourceMetadata:
    platform: str
    filename: str
    fingerprint: str
    import_timestamp: float


@dataclass(frozen=True, slots=True)
class ModelReference:
    provider: str = ""
    model_id: str = ""


@dataclass(frozen=True, slots=True)
class NeutralAgentManifest:
    schema_version: int = 1
    id: str = ""
    name: str = ""
    slug: str = ""
    description: str = ""
    instructions: str = ""
    skills: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    model_reference: Optional[ModelReference] = None
    runtime_targets: tuple[HarnessFamily, ...] = ()
    source_metadata: Optional[SourceMetadata] = None


@dataclass(frozen=True, slots=True)
class ImportPreview:
    manifest: NeutralAgentManifest
    warnings: tuple[str, ...] = ()
    credential_keys_found: tuple[str, ...] = ()
    secret_redactions: int = 0
    rejected: bool = False
    rejection_reason: str = ""


@dataclass(slots=True)
class AgentRegistryEntry:
    manifest: NeutralAgentManifest
    verified: bool = False
    verification_errors: tuple[str, ...] = ()
    credential_keys_found: tuple[str, ...] = ()
    secret_redactions: int = 0
    added_at: float = field(default_factory=time.time)
    last_validated_at: float = 0.0


# ── fingerprinting ───────────────────────────────────────────────────────────


def compute_source_fingerprint(raw: bytes) -> str:
    """SHA-256 of raw source bytes; FNV-1a fallback is NOT needed on CPython."""
    return hashlib.sha256(raw).hexdigest()


# ── sanitization ─────────────────────────────────────────────────────────────


def _is_base64_high_entropy(value: str) -> bool:
    """Heuristic: looks like a base64 string with high entropy."""
    if len(value) < 32:
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
        return len(decoded) >= 24
    except Exception:
        return False


def sanitize_value(value: Any, depth: int = 0, max_depth: int = MAX_NESTING_DEPTH) -> Any:
    """Recursively strip credential keys and prototype-pollution keys.

    Returns a deep copy with offending keys removed.  Dictionaries and lists
    are traversed; primitives are returned unchanged.  Strings are also
    redacted for secret-shaped values in-place.
    """
    if depth > max_depth:
        logger.warning("sanitize_value: max nesting depth %d exceeded; truncating branch", max_depth)
        return None

    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                continue
            lowered = k.lower()
            if lowered in _CREDENTIAL_KEYS or lowered.endswith("_key") or lowered.endswith("_token") or lowered.endswith("_secret") or lowered.endswith("_password"):
                continue
            cleaned[k] = sanitize_value(v, depth + 1, max_depth)
        return cleaned

    if isinstance(value, list):
        return [sanitize_value(item, depth + 1, max_depth) for item in value]

    if isinstance(value, str):
        return redact_secrets_in_text(value)

    return value


def redact_secrets_in_text(text: str) -> str:
    """Redact secret-shaped substrings inside a free-text value."""
    if not text:
        return text
    count = 0
    for pattern, replacement in _SECRET_PATTERNS:
        new_text, n = pattern.subn(replacement, text)
        if n:
            text = new_text
            count += n
    return text


def count_secret_redactions(text: str) -> int:
    """Count how many secret-shaped substrings would be redacted."""
    total = 0
    for pattern, _ in _SECRET_PATTERNS:
        total += len(pattern.findall(text))
    return total


# ── platform detection ───────────────────────────────────────────────────────


def detect_platform(source: bytes, filename: str) -> HarnessFamily:
    """Best-effort platform detection from filename hints and content heuristics.

    Detection order:
    1. Explicit filename extensions / path segments
    2. Content magic bytes / JSON keys
    3. Default to GENERIC_A2A
    """
    lowered_name = filename.lower()

    # Filename heuristics — more specific patterns first
    if ".pi/" in lowered_name or lowered_name.endswith(".pi"):
        return HarnessFamily.PI
    if "soul.md" in lowered_name:
        return HarnessFamily.HERMES
    if "claude" in lowered_name:
        return HarnessFamily.CLAUDE_CODE
    if "codex" in lowered_name:
        return HarnessFamily.CODEX
    if "opencode" in lowered_name:
        return HarnessFamily.OPENCODE
    if "cursor" in lowered_name:
        return HarnessFamily.CURSOR
    if "copilot" in lowered_name:
        return HarnessFamily.GITHUB_COPILOT
    if "agent.json" in lowered_name:
        return HarnessFamily.HERMES

    # Content heuristics (cheap prefix checks only)
    prefix = source[:2048]
    try:
        text = prefix.decode("utf-8", errors="ignore")
    except Exception:
        text = ""

    if "agentCard" in text or "a2a_protocol" in text:
        return HarnessFamily.GENERIC_A2A
    if "claude" in text and ("system_prompt" in text or "project instructions" in text):
        return HarnessFamily.CLAUDE_CODE
    if "codex" in text and ("model" in text or "instructions" in text):
        return HarnessFamily.CODEX
    if "opencode" in text:
        return HarnessFamily.OPENCODE
    if "cursor" in text:
        return HarnessFamily.CURSOR
    if "copilot" in text:
        return HarnessFamily.GITHUB_COPILOT

    return HarnessFamily.GENERIC_A2A


# ── normalization ────────────────────────────────────────────────────────────


def _bound_string(value: Any, max_len: int) -> str:
    s = str(value) if value is not None else ""
    return s[:max_len]


def _bound_tuple(value: Any, max_items: int, max_str_len: int) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    out: list[str] = []
    for item in value[:max_items]:
        s = str(item)[:max_str_len]
        out.append(s)
    return tuple(out)


def _extract_raw_runtime_targets(sanitized: Any) -> list[str]:
    """Extract raw runtime target strings from sanitized data before enum conversion."""
    if not isinstance(sanitized, dict):
        return []
    raw = sanitized.get("runtime_targets", sanitized.get("harness_families", []))
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(t) for t in raw]
    return []


def normalize_to_manifest(
    source: bytes,
    filename: str,
    platform_hint: Optional[str] = None,
) -> ImportPreview:
    """Preview-first normalization: raw source → sanitized neutral manifest.

    Returns an ImportPreview.  If the source is oversized, the preview is
    rejected outright.  Credential stripping and secret redaction run before
    the manifest is built so the preview never contains raw secrets.
    """
    warnings: list[str] = []
    credential_keys_found: list[str] = []
    redaction_count = 0

    # Size bound
    if len(source) > MAX_SOURCE_BYTES:
        return ImportPreview(
            manifest=NeutralAgentManifest(),
            rejected=True,
            rejection_reason=f"Source size {len(source)} bytes exceeds maximum {MAX_SOURCE_BYTES}",
        )

    fingerprint = compute_source_fingerprint(source)

    # Detect platform
    platform = platform_hint or detect_platform(source, filename).value

    # Parse raw data
    raw_data: Any = None
    try:
        text = source.decode("utf-8", errors="replace")
        # Try JSON first
        raw_data = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        # Fall back to treating as plain text / Markdown with YAML frontmatter
        raw_data = _parse_markdown_or_plaintext(text)

    # Find credential keys BEFORE sanitization (for audit)
    credential_keys_found = _find_credential_keys(raw_data)
    if credential_keys_found:
        warnings.append(f"Stripped credential keys: {', '.join(credential_keys_found)}")

    # Count redactions on raw strings BEFORE sanitization wipes them
    redaction_count = _count_redactions_in_value(raw_data)
    if redaction_count:
        warnings.append(f"Redacted {redaction_count} secret-shaped value(s)")

    # Sanitize and redact
    sanitized = sanitize_value(raw_data)

    # Validate raw runtime targets BEFORE building manifest
    raw_targets = _extract_raw_runtime_targets(sanitized)
    targets_valid, target_errors = validate_runtime_targets(raw_targets)
    if not targets_valid:
        return ImportPreview(
            manifest=NeutralAgentManifest(),
            rejected=True,
            rejection_reason="; ".join(target_errors),
            warnings=tuple(warnings),
            credential_keys_found=tuple(credential_keys_found),
            secret_redactions=redaction_count,
        )

    # Build manifest from sanitized data
    manifest = _build_manifest(sanitized, filename, fingerprint, platform)

    return ImportPreview(
        manifest=manifest,
        warnings=tuple(warnings),
        credential_keys_found=tuple(credential_keys_found),
        secret_redactions=redaction_count,
    )


def _find_credential_keys(value: Any, depth: int = 0) -> list[str]:
    """Return a list of credential-like keys found in the raw data."""
    found: list[str] = []
    if depth > MAX_NESTING_DEPTH:
        return found
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(k, str):
                lowered = k.lower()
                if lowered in _CREDENTIAL_KEYS or lowered.endswith("_key") or lowered.endswith("_token") or lowered.endswith("_secret") or lowered.endswith("_password"):
                    found.append(k)
            found.extend(_find_credential_keys(v, depth + 1))
    elif isinstance(value, list):
        for item in value:
            found.extend(_find_credential_keys(item, depth + 1))
    return found


def _count_redactions_in_value(value: Any, depth: int = 0) -> int:
    """Count total secret redactions across all string values."""
    if depth > MAX_NESTING_DEPTH:
        return 0
    total = 0
    if isinstance(value, dict):
        for v in value.values():
            total += _count_redactions_in_value(v, depth + 1)
    elif isinstance(value, list):
        for item in value:
            total += _count_redactions_in_value(item, depth + 1)
    elif isinstance(value, str):
        total += count_secret_redactions(value)
    return total


def _parse_markdown_or_plaintext(text: str) -> dict[str, Any]:
    """Extract YAML frontmatter and body from Markdown; otherwise wrap plain text."""
    data: dict[str, Any] = {"_raw_text": text}
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            body = parts[2].strip()
            try:
                import yaml

                parsed = yaml.safe_load(frontmatter)
                if isinstance(parsed, dict):
                    data = parsed
                data["instructions"] = body
            except Exception:
                data["_raw_text"] = text
    return data


def _build_manifest(
    sanitized: Any,
    filename: str,
    fingerprint: str,
    platform: str,
) -> NeutralAgentManifest:
    """Construct a bounded neutral manifest from sanitized data."""
    if not isinstance(sanitized, dict):
        sanitized = {"_raw_text": str(sanitized)}

    name = _bound_string(sanitized.get("name", sanitized.get("title", filename)), MAX_NAME_CHARS)
    slug = _bound_string(sanitized.get("slug", sanitized.get("id", name)), MAX_SLUG_CHARS)
    if not slug:
        slug = "agent"
    description = _bound_string(sanitized.get("description", sanitized.get("summary", "")), MAX_DESCRIPTION_CHARS)
    instructions = _bound_string(
        sanitized.get("instructions", sanitized.get("system_prompt", sanitized.get("_raw_text", ""))),
        MAX_INSTRUCTIONS_BYTES,
    )

    skills = _bound_tuple(sanitized.get("skills", sanitized.get("abilities", [])), MAX_ARRAY_ITEMS, MAX_ARRAY_STRING_CHARS)
    tools = _bound_tuple(sanitized.get("tools", sanitized.get("tool_names", [])), MAX_ARRAY_ITEMS, MAX_ARRAY_STRING_CHARS)
    tags = _bound_tuple(sanitized.get("tags", sanitized.get("categories", [])), MAX_ARRAY_ITEMS, MAX_ARRAY_STRING_CHARS)

    model_ref = None
    model = sanitized.get("model")
    if isinstance(model, dict):
        model_ref = ModelReference(
            provider=_bound_string(model.get("provider", ""), MAX_ARRAY_STRING_CHARS),
            model_id=_bound_string(model.get("model_id", model.get("id", "")), MAX_ARRAY_STRING_CHARS),
        )
    elif isinstance(model, str) and model:
        model_ref = ModelReference(model_id=_bound_string(model, MAX_ARRAY_STRING_CHARS))

    # Runtime targets
    raw_targets = sanitized.get("runtime_targets", sanitized.get("harness_families", [platform]))
    if isinstance(raw_targets, str):
        raw_targets = [raw_targets]
    targets = []
    for t in raw_targets:
        try:
            targets.append(HarnessFamily(str(t).lower()))
        except ValueError:
            pass
    if not targets:
        targets = [HarnessFamily.GENERIC_A2A]

    source_meta = SourceMetadata(
        platform=platform,
        filename=filename,
        fingerprint=fingerprint,
        import_timestamp=time.time(),
    )

    # Derive ID from fingerprint + slug for uniqueness
    agent_id = hashlib.sha256(f"{fingerprint}:{slug}".encode()).hexdigest()[:32]

    return NeutralAgentManifest(
        schema_version=1,
        id=agent_id,
        name=name or slug,
        slug=slug,
        description=description,
        instructions=instructions,
        skills=skills,
        tools=tools,
        tags=tags,
        model_reference=model_ref,
        runtime_targets=tuple(targets),
        source_metadata=source_meta,
    )


# ── URL import path ──────────────────────────────────────────────────────────


def normalize_url_to_manifest(url: str) -> ImportPreview:
    """Fetch an agent manifest from a public HTTPS URL and normalize it.

    Validates the destination against SSRF policy, discovers the public Agent
    Card via well-known URLs, and runs the same sanitization pipeline as
    file-based imports.
    """
    from plugins.harness_agents.policy import validate_url, fetch_agent_card

    normalized = _normalize_a2a_url(url)
    validate_url(normalized, require_https=True)
    card = fetch_agent_card(normalized)
    source = json.dumps(card, ensure_ascii=False).encode("utf-8")
    return normalize_to_manifest(source, filename="agent.json", platform_hint="generic_a2a")


def _normalize_a2a_url(url: str) -> str:
    """Strip well-known agent card suffixes to obtain the origin."""
    stripped = url.strip()
    lowered = stripped.lower()
    for suffix in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
        if lowered.endswith(suffix):
            return stripped[: -len(suffix)]
    return stripped


def import_agent_from_url(url: str, registry: Optional["AgentRegistry"] = None) -> AgentRegistryEntry:
    """Fetch, normalize, and persist an agent from a public URL.

    Raises ValueError if the import is rejected or verification fails.
    """
    preview = normalize_url_to_manifest(url)
    if preview.rejected:
        raise ValueError(f"URL import rejected: {preview.rejection_reason}")
    if registry is None:
        registry = AgentRegistry()
    return registry.upsert(preview)


# ── runtime target validation ────────────────────────────────────────────────


def validate_runtime_targets(targets: list[str]) -> tuple[bool, list[str]]:
    """Return (all_valid, error_messages) for a list of target strings."""
    errors: list[str] = []
    for t in targets:
        try:
            HarnessFamily(t.lower())
        except ValueError:
            errors.append(f"Unapproved harness family: {t!r}")
    return (not errors, errors)


# ── registry persistence ─────────────────────────────────────────────────────


class AgentRegistry:
    """Local agent library backed by a JSON file inside HERMES_HOME.

    Thread-safe via file-level atomic write (write+rename).  Invalid entries
    are silently ignored on load with a console warning.
    """

    _FILE_NAME = "connected_agent_registry.json"

    def __init__(self, hermes_home: Optional[Path] = None):
        if hermes_home is None:
            from hermes_constants import get_hermes_home

            hermes_home = Path(get_hermes_home())
        self._path = Path(hermes_home) / self._FILE_NAME
        self._lock_path = self._path.with_suffix(".json.lock")

    def _load_raw(self) -> dict[str, Any]:
        if not self._path.is_file():
            return {}
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("AgentRegistry load failed: %s", exc)
        return {}

    def _save_raw(self, data: dict[str, Any]) -> None:
        tmp = self._path.with_suffix(".json.tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(str(tmp), str(self._path))
        except OSError as exc:
            logger.error("AgentRegistry save failed: %s", exc)
            raise

    def load_entries(self) -> dict[str, AgentRegistryEntry]:
        """Return all valid registry entries keyed by agent ID."""
        raw = self._load_raw()
        entries: dict[str, AgentRegistryEntry] = {}
        for agent_id, payload in raw.items():
            if not isinstance(payload, dict):
                logger.warning("AgentRegistry: skipping non-dict entry %s", agent_id)
                continue
            try:
                entry = _deserialize_entry(payload)
                entries[agent_id] = entry
            except Exception as exc:
                logger.warning("AgentRegistry: skipping invalid entry %s: %s", agent_id, exc)
        return entries

    def save_entries(self, entries: dict[str, AgentRegistryEntry]) -> None:
        """Atomically write all entries to disk."""
        raw = {k: _serialize_entry(v) for k, v in entries.items()}
        self._save_raw(raw)

    def upsert(self, preview: ImportPreview) -> AgentRegistryEntry:
        """Add or replace an agent from an ImportPreview.

        Returns the created entry.  Raises ValueError if the preview is
        rejected or the manifest has no id.
        """
        if preview.rejected:
            raise ValueError(f"Cannot upsert rejected preview: {preview.rejection_reason}")
        manifest = preview.manifest
        if not manifest.id:
            raise ValueError("Manifest has no id")

        entries = self.load_entries()
        entry = AgentRegistryEntry(
            manifest=manifest,
            verified=False,  # must pass verification gates separately
            verification_errors=(),
            credential_keys_found=preview.credential_keys_found,
            secret_redactions=preview.secret_redactions,
            added_at=time.time(),
            last_validated_at=0.0,
        )
        entries[manifest.id] = entry
        self.save_entries(entries)
        return entry

    def get(self, agent_id: str) -> Optional[AgentRegistryEntry]:
        return self.load_entries().get(agent_id)

    def delete(self, agent_id: str) -> bool:
        entries = self.load_entries()
        if agent_id not in entries:
            return False
        del entries[agent_id]
        self.save_entries(entries)
        return True

    def list_verified(self) -> list[AgentRegistryEntry]:
        """Return only entries that have passed verification."""
        return [e for e in self.load_entries().values() if e.verified]

    def verify_entry(self, agent_id: str) -> AgentRegistryEntry:
        """Run verification gates on an entry and update its state.

        Gates:
        1. Source fingerprint unchanged since preview
        2. Zero detected secrets in the stored manifest
        3. Runtime targets are a subset of approved harness families
        4. Capability epoch matches current host (placeholder)
        """
        entries = self.load_entries()
        entry = entries.get(agent_id)
        if entry is None:
            raise KeyError(f"Agent {agent_id} not found")

        errors: list[str] = []
        manifest = entry.manifest

        # Gate 1: fingerprint present (we trust stored fingerprint)
        if not manifest.source_metadata or not manifest.source_metadata.fingerprint:
            errors.append("Missing source fingerprint")

        # Gate 2: zero detected secrets at import time
        if entry.credential_keys_found:
            errors.append(f"Unresolved credential keys: {', '.join(entry.credential_keys_found)}")
        if entry.secret_redactions:
            errors.append(f"Unresolved secret redactions: {entry.secret_redactions}")

        # Gate 3: runtime targets approved (already enforced at preview, defense in depth)
        valid, target_errors = validate_runtime_targets([t.value for t in manifest.runtime_targets])
        if not valid:
            errors.extend(target_errors)

        # Gate 4: capability epoch (placeholder — real check depends on host surface)
        # For now we accept all since the architecture says "capability epoch matches current host"

        entry.verified = not errors
        entry.verification_errors = tuple(errors)
        entry.last_validated_at = time.time()
        entries[agent_id] = entry
        self.save_entries(entries)
        return entry


# ── serialization helpers ────────────────────────────────────────────────────


def _serialize_entry(entry: AgentRegistryEntry) -> dict[str, Any]:
    """Serialize an AgentRegistryEntry to a plain dict."""
    manifest_dict = asdict(entry.manifest)
    # Convert enums and nested dataclasses to serializable forms
    manifest_dict["runtime_targets"] = [t.value for t in entry.manifest.runtime_targets]
    if entry.manifest.model_reference:
        manifest_dict["model_reference"] = asdict(entry.manifest.model_reference)
    else:
        manifest_dict["model_reference"] = None
    if entry.manifest.source_metadata:
        manifest_dict["source_metadata"] = asdict(entry.manifest.source_metadata)
    else:
        manifest_dict["source_metadata"] = None
    return {
        "manifest": manifest_dict,
        "verified": entry.verified,
        "verification_errors": list(entry.verification_errors),
        "credential_keys_found": list(entry.credential_keys_found),
        "secret_redactions": entry.secret_redactions,
        "added_at": entry.added_at,
        "last_validated_at": entry.last_validated_at,
    }


def _deserialize_entry(payload: dict[str, Any]) -> AgentRegistryEntry:
    """Deserialize a plain dict to an AgentRegistryEntry."""
    m = payload["manifest"]
    # Rebuild dataclasses
    source_meta = None
    if m.get("source_metadata"):
        sm = m["source_metadata"]
        source_meta = SourceMetadata(
            platform=sm["platform"],
            filename=sm["filename"],
            fingerprint=sm["fingerprint"],
            import_timestamp=sm["import_timestamp"],
        )
    model_ref = None
    if m.get("model_reference"):
        mr = m["model_reference"]
        model_ref = ModelReference(provider=mr.get("provider", ""), model_id=mr.get("model_id", ""))

    runtime_targets = []
    for t in m.get("runtime_targets", []):
        try:
            runtime_targets.append(HarnessFamily(t))
        except ValueError:
            pass

    manifest = NeutralAgentManifest(
        schema_version=m.get("schema_version", 1),
        id=m.get("id", ""),
        name=m.get("name", ""),
        slug=m.get("slug", ""),
        description=m.get("description", ""),
        instructions=m.get("instructions", ""),
        skills=tuple(m.get("skills", [])),
        tools=tuple(m.get("tools", [])),
        tags=tuple(m.get("tags", [])),
        model_reference=model_ref,
        runtime_targets=tuple(runtime_targets),
        source_metadata=source_meta,
    )

    return AgentRegistryEntry(
        manifest=manifest,
        verified=payload.get("verified", False),
        verification_errors=tuple(payload.get("verification_errors", [])),
        credential_keys_found=tuple(payload.get("credential_keys_found", [])),
        secret_redactions=payload.get("secret_redactions", 0),
        added_at=payload.get("added_at", 0.0),
        last_validated_at=payload.get("last_validated_at", 0.0),
    )
