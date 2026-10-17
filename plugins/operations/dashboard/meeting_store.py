"""Append-only versioned persistence for public structured meetings.

Two meeting shapes share one durable store and one canonical wire schema:

* A **conclusion meeting** is the ordinary discussion/decision/action-item
  meeting. It must carry none of the production fields.
* A **production meeting** carries the complete production bundle —
  orchestrator, producer, an ordered seat bijection with at least one
  independent reviewer, ``product_kind``, ``output_title``, and
  ``acceptance_statement`` — and completes only through the exact owner
  approval transaction.

New records are canonical ``schema_version`` 2 with snake_case keys. Records
written before schema v2 are read exactly as stored (legacy schema_version 1)
and are never rewritten; appending a new version normalizes camelCase input
into the canonical keys without touching history.

``production_stage`` and ``artifact_binding`` are server-owned. A full-record
client PUT may echo their current values but can neither create nor change
them; only the dedicated transactions in this module write them.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Mapping

MAX_RECORD_BYTES = 256_000
MAX_LIST_LIMIT = 100
MAX_ID_CHARS = 128
MAX_ROUTE_CHARS = 128
MAX_TITLE_CHARS = 200
MAX_AGENDA_CHARS = 8_000
MAX_CONTRIBUTION_CHARS = 8_000
MAX_EVIDENCE_REF_CHARS = 2_048
MAX_PARTICIPANTS = 6
MIN_PARTICIPANTS = 2
MIN_PRODUCTION_PARTICIPANTS = 3
MAX_ROUNDS = 5
MAX_HISTORY_ITEMS = 128
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_SEAT_LABEL_CHARS = 256
MAX_SEAT_INSTRUCTIONS_CHARS = 4_000
MAX_ACCEPTANCE_STATEMENT_CHARS = 4_000

SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1

STATES = frozenset({"draft", "running", "waiting", "completed", "cancelled", "failed"})
TERMINAL_STATES = frozenset({"completed", "cancelled", "failed"})
_ALLOWED_TRANSITIONS = {
    "draft": frozenset({"draft", "running", "cancelled", "failed"}),
    "running": frozenset({"running", "waiting", "completed", "cancelled", "failed"}),
    "waiting": frozenset({"waiting", "running", "completed", "cancelled", "failed"}),
    "completed": frozenset({"completed"}),
    "cancelled": frozenset({"cancelled"}),
    "failed": frozenset({"failed"}),
}

PRODUCT_KINDS = frozenset({
    "interactive_web_app",
    "three_scene",
    "audio_asset",
    "video_asset",
    "document",
})

SEAT_ROLES = frozenset({"contributor", "thinker", "specialist", "reviewer"})

PRODUCTION_STAGES = (
    "briefing",
    "working",
    "production_ready",
    "producing",
    "reviewing",
    "changes_requested",
    "approval_ready",
    "completed",
)
_PRODUCTION_STAGE_SET = frozenset(PRODUCTION_STAGES)

# Server-owned stage machine. ``completed`` is reachable only through
# complete_production_meeting, never through advance_production_stage.
_STAGE_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "briefing": frozenset({"working"}),
    "working": frozenset({"production_ready"}),
    "production_ready": frozenset({"producing"}),
    "producing": frozenset({"reviewing"}),
    "reviewing": frozenset({"changes_requested", "approval_ready"}),
    "changes_requested": frozenset({"producing"}),
    "approval_ready": frozenset({"reviewing"}),
    "completed": frozenset(),
}

# The complete production bundle. Partial bundles are refused outright.
PRODUCTION_BUNDLE_FIELDS = (
    "orchestrator",
    "producer",
    "seats",
    "product_kind",
    "output_title",
    "acceptance_statement",
)
# Every field a conclusion meeting must not carry.
PRODUCTION_ONLY_FIELDS = PRODUCTION_BUNDLE_FIELDS + ("production_stage", "artifact_binding")
SERVER_OWNED_FIELDS = ("production_stage", "artifact_binding")

APPROVED_BY_LABEL = "Owner"

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_ROUTE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PRIORITIES = frozenset({"low", "normal", "high", "critical"})


class VersionConflict(ValueError):
    """The proposed expected version is stale."""


class ImmutableMeetingHistory(ValueError):
    """A new version rewrites an existing contribution or decision."""


class ServerOwnedField(ValueError):
    """A client payload tried to create or change a server-owned field."""


class InvalidMeetingTransition(ValueError):
    """The requested state or production-stage transition is not legal."""


def _record(value: object, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} must be an object")
    return value


def _bounded_text(value: object, field: str, maximum: int, *, pattern=None) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise ValueError(f"{field} is invalid")
    if pattern is not None and not pattern.fullmatch(value):
        raise ValueError(f"{field} is invalid")
    return value


def _route(value: object, field: str) -> dict[str, str]:
    row = _record(value, field)
    allowed = {"connection", "connectionId", "profile"}
    if not set(row).issubset(allowed):
        raise ValueError(f"{field} contains unsupported fields")
    connection = row.get("connection", row.get("connectionId"))
    return {
        "connection": _bounded_text(connection, f"{field}.connection", MAX_ROUTE_CHARS, pattern=_ROUTE_RE),
        "profile": _bounded_text(row.get("profile"), f"{field}.profile", MAX_ROUTE_CHARS, pattern=_ROUTE_RE),
    }


def _route_key(value: Mapping[str, str]) -> tuple[str, str]:
    return value["connection"], value["profile"]


def _bounded_list(value: object, field: str, maximum: int = MAX_HISTORY_ITEMS) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"{field} must be a bounded array")
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} is not valid JSON") from exc
    return value


def _bounded_identifier(value: object, field: str) -> str:
    result = _bounded_text(value, field, MAX_ID_CHARS)
    if any(character.isspace() for character in result):
        raise ValueError(f"{field} is invalid")
    return result


def _evidence_refs(value: object, field: str) -> list[str]:
    rows = _bounded_list(value, field, 32)
    return [
        _bounded_text(reference, f"{field}[{index}]", MAX_EVIDENCE_REF_CHARS)
        for index, reference in enumerate(rows)
    ]


def _history_value(row: Mapping[str, Any], camel: str, snake: str, default: object) -> object:
    if camel in row and snake in row:
        raise ValueError(f"{snake} is duplicated")
    return row.get(camel, row.get(snake, default))


def _contributions(
    value: object,
    participants: list[dict[str, str]],
    max_rounds: int,
) -> tuple[list[dict[str, Any]], int, bool]:
    rows = _bounded_list(value, "contributions", max_rounds * len(participants))
    participant_keys = {_route_key(participant) for participant in participants}
    expected_round = 1
    round_participants: set[tuple[str, str]] = set()
    round_kinds: list[str] = []
    normalized: list[dict[str, Any]] = []
    terminal_round = False
    for index, value_row in enumerate(rows):
        if terminal_round:
            raise ValueError("contribution follows a terminal round")
        row = _record(value_row, f"contributions[{index}]")
        allowed = {"id", "round", "participant", "kind", "text", "evidenceRefs", "evidence_refs"}
        if not set(row).issubset(allowed):
            raise ValueError(f"contributions[{index}] contains unsupported fields")
        round_number = row.get("round")
        if isinstance(round_number, bool) or not isinstance(round_number, int) or round_number != expected_round:
            raise ValueError("contribution round is invalid")
        participant = _route(row.get("participant"), f"contributions[{index}].participant")
        participant_key = _route_key(participant)
        if participant_key not in participant_keys or participant_key in round_participants:
            raise ValueError("contributor must be a unique meeting participant for the round")
        kind = row.get("kind")
        if kind not in {"speak", "pass"}:
            raise ValueError("contribution kind is invalid")
        text = row.get("text", "")
        if kind == "speak":
            text = _bounded_text(text, f"contributions[{index}].text", MAX_CONTRIBUTION_CHARS)
        elif text != "":
            raise ValueError("pass contribution text must be empty")
        evidence = _evidence_refs(
            _history_value(row, "evidenceRefs", "evidence_refs", []),
            f"contributions[{index}].evidence_refs",
        )
        normalized.append({
            "id": _bounded_identifier(row.get("id"), f"contributions[{index}].id"),
            "round": round_number,
            "participant": participant,
            "kind": kind,
            "text": text,
            "evidence_refs": evidence,
        })
        round_participants.add(participant_key)
        round_kinds.append(kind)
        if len(round_participants) == len(participants):
            terminal_round = all(item == "pass" for item in round_kinds) or expected_round >= max_rounds
            if not terminal_round:
                expected_round += 1
                round_participants.clear()
                round_kinds.clear()
    return normalized, expected_round, terminal_round


def _decisions(value: object) -> list[dict[str, Any]]:
    rows = _bounded_list(value, "decisions", 32)
    normalized = []
    for index, value_row in enumerate(rows):
        row = _record(value_row, f"decisions[{index}]")
        if not set(row).issubset({"id", "text", "evidenceRefs", "evidence_refs"}):
            raise ValueError(f"decisions[{index}] contains unsupported fields")
        normalized.append({
            "id": _bounded_identifier(row.get("id"), f"decisions[{index}].id"),
            "text": _bounded_text(row.get("text"), f"decisions[{index}].text", MAX_CONTRIBUTION_CHARS),
            "evidence_refs": _evidence_refs(
                _history_value(row, "evidenceRefs", "evidence_refs", []),
                f"decisions[{index}].evidence_refs",
            ),
        })
    return normalized


def _dissent(value: object, participant_keys: set[tuple[str, str]]) -> list[dict[str, Any]]:
    rows = _bounded_list(value, "dissent", 32)
    normalized = []
    for index, value_row in enumerate(rows):
        row = _record(value_row, f"dissent[{index}]")
        if not set(row).issubset({"participant", "text", "evidenceRefs", "evidence_refs"}):
            raise ValueError(f"dissent[{index}] contains unsupported fields")
        participant = _route(row.get("participant"), f"dissent[{index}].participant")
        if _route_key(participant) not in participant_keys:
            raise ValueError("dissent participant must be in the meeting")
        normalized.append({
            "participant": participant,
            "text": _bounded_text(row.get("text"), f"dissent[{index}].text", MAX_CONTRIBUTION_CHARS),
            "evidence_refs": _evidence_refs(
                _history_value(row, "evidenceRefs", "evidence_refs", []),
                f"dissent[{index}].evidence_refs",
            ),
        })
    return normalized


def _action_items(
    value: object,
    meeting_id: str,
    participant_keys: set[tuple[str, str]],
) -> list[dict[str, Any]]:
    rows = _bounded_list(value, "action_items", 64)
    normalized = []
    for index, value_row in enumerate(rows):
        row = _record(value_row, f"action_items[{index}]")
        item_id = _bounded_identifier(row.get("id"), f"action_items[{index}].id")
        owner = _route(
            _history_value(row, "ownerRoute", "owner_route", None),
            f"action_items[{index}].owner_route",
        )
        if _route_key(owner) not in participant_keys:
            raise ValueError("action item owner must be in the meeting")
        priority = row.get("priority")
        if priority not in _PRIORITIES:
            raise ValueError("action item priority is invalid")
        acceptance = _history_value(row, "acceptanceCriteria", "acceptance_criteria", None)
        due_intent = _history_value(row, "dueIntent", "due_intent", None)
        dedupe = _history_value(row, "dedupeKey", "dedupe_key", None)
        expected_dedupe = f"meeting:{meeting_id}:action:{item_id}"
        if dedupe != expected_dedupe:
            raise ValueError("action item dedupe key is invalid")
        normalized.append({
            "id": item_id,
            "owner_route": owner,
            "title": _bounded_text(row.get("title"), f"action_items[{index}].title", MAX_TITLE_CHARS),
            "acceptance_criteria": _bounded_text(
                acceptance,
                f"action_items[{index}].acceptance_criteria",
                MAX_AGENDA_CHARS,
            ),
            "priority": priority,
            "due_intent": _bounded_text(
                due_intent,
                f"action_items[{index}].due_intent",
                MAX_CONTRIBUTION_CHARS,
            ),
            "dedupe_key": expected_dedupe,
        })
    return normalized


def _seats(
    value: object,
    participants: list[dict[str, str]],
    orchestrator: Mapping[str, str],
    producer: Mapping[str, str],
) -> list[dict[str, Any]]:
    """Validate seats as an ordered one-to-one assignment of the participants."""
    rows = _bounded_list(value, "seats", MAX_PARTICIPANTS)
    if not rows:
        raise ValueError("production seats must be a non-empty ordered assignment")
    participant_keys = {_route_key(participant) for participant in participants}
    if len(rows) != len(participants):
        raise ValueError("production seats must assign every participant exactly once")
    seen: set[tuple[str, str]] = set()
    reviewer_keys: list[tuple[str, str]] = []
    normalized: list[dict[str, Any]] = []
    for index, value_row in enumerate(rows):
        row = _record(value_row, f"seats[{index}]")
        if not set(row).issubset({"bot", "role", "label", "instructions"}):
            raise ValueError(f"seats[{index}] contains unsupported fields")
        bot = _route(row.get("bot"), f"seats[{index}].bot")
        key = _route_key(bot)
        if key not in participant_keys:
            raise ValueError("every seat bot must be a meeting participant")
        if key in seen:
            raise ValueError("production seats must assign every participant exactly once")
        seen.add(key)
        role = row.get("role")
        if role not in SEAT_ROLES:
            raise ValueError(f"seats[{index}].role is not allowed")
        if role == "reviewer":
            reviewer_keys.append(key)
        seat: dict[str, Any] = {
            "bot": bot,
            "role": role,
            "label": _bounded_text(row.get("label"), f"seats[{index}].label", MAX_SEAT_LABEL_CHARS),
        }
        if row.get("instructions") is not None:
            seat["instructions"] = _bounded_text(
                row.get("instructions"),
                f"seats[{index}].instructions",
                MAX_SEAT_INSTRUCTIONS_CHARS,
            )
        normalized.append(seat)
    if seen != participant_keys:
        raise ValueError("production seats must assign every participant exactly once")
    if not reviewer_keys:
        raise ValueError("production requires at least one independent reviewer seat")
    excluded = {_route_key(orchestrator), _route_key(producer)}
    if any(key in excluded for key in reviewer_keys):
        raise ValueError("a reviewer seat must differ from both the orchestrator and the producer")
    return normalized


def _artifact_binding(value: object, field: str = "artifact_binding") -> dict[str, Any]:
    row = _record(value, field)
    required = {
        "output_id", "artifact_version", "game_sha256", "manifest_sha256",
        "zip_sha256", "approved_by", "approved_at",
    }
    if set(row) != required:
        raise ValueError(f"{field} fields are invalid")
    artifact_version = row["artifact_version"]
    if isinstance(artifact_version, bool) or not isinstance(artifact_version, int) or artifact_version < 1:
        raise ValueError(f"{field}.artifact_version is invalid")
    approved_at = row["approved_at"]
    if isinstance(approved_at, bool) or not isinstance(approved_at, int) or not 0 < approved_at <= MAX_SAFE_INTEGER:
        raise ValueError(f"{field}.approved_at is invalid")
    if row["approved_by"] != APPROVED_BY_LABEL:
        raise ValueError(f"{field}.approved_by must be the non-identifying Owner label")
    binding = {
        "output_id": _bounded_text(row["output_id"], f"{field}.output_id", MAX_ID_CHARS, pattern=_ID_RE),
        "artifact_version": artifact_version,
        "approved_by": APPROVED_BY_LABEL,
        "approved_at": approved_at,
    }
    for digest_field in ("game_sha256", "manifest_sha256", "zip_sha256"):
        binding[digest_field] = _bounded_text(
            row[digest_field], f"{field}.{digest_field}", 64, pattern=_SHA256_RE
        )
    return binding


def is_production_record(value: Mapping[str, Any]) -> bool:
    """True when a record carries any part of the production bundle."""
    return any(value.get(field) is not None for field in PRODUCTION_ONLY_FIELDS)


# health: allow CC -- the meeting validator intentionally evaluates the complete closed persisted contract in one auditable boundary
def validate_meeting(value: object) -> dict[str, Any]:
    row = _record(value, "meeting")
    required = {
        "id", "source", "title", "agenda", "chair", "participants", "state",
        "max_rounds", "current_round", "contributions", "evidence", "decisions",
        "dissent", "action_items",
    }
    optional = {"pending", "runner_sessions", "round_run", "schema_version"} | set(PRODUCTION_ONLY_FIELDS)
    if not required.issubset(row) or not set(row).issubset(required | optional):
        raise ValueError("meeting fields are invalid")

    declared_schema = row.get("schema_version", SCHEMA_VERSION)
    if declared_schema not in {LEGACY_SCHEMA_VERSION, SCHEMA_VERSION}:
        raise ValueError("schema_version is unsupported")

    meeting_id = _bounded_text(row["id"], "id", MAX_ID_CHARS, pattern=_ID_RE)
    source = _route(row["source"], "source")
    chair = _route(row["chair"], "chair")
    raw_participants = row["participants"]
    if not isinstance(raw_participants, list):
        raise ValueError("participants must be an array")
    participants = [_route(item, f"participants[{index}]") for index, item in enumerate(raw_participants)]
    keys = [_route_key(item) for item in participants]
    if not MIN_PARTICIPANTS <= len(participants) <= MAX_PARTICIPANTS or len(set(keys)) != len(keys):
        raise ValueError("participants must contain two to six unique routes")
    if _route_key(chair) not in keys:
        raise ValueError("chair must be a participant")

    state = row["state"]
    if state not in STATES:
        raise ValueError("meeting state is invalid")
    max_rounds = row["max_rounds"]
    current_round = row["current_round"]
    if isinstance(max_rounds, bool) or not isinstance(max_rounds, int) or not 1 <= max_rounds <= MAX_ROUNDS:
        raise ValueError("max_rounds is invalid")
    if isinstance(current_round, bool) or not isinstance(current_round, int) or not 0 <= current_round <= max_rounds:
        raise ValueError("current_round is invalid")

    participant_keys = set(keys)
    contributions, history_round, terminal_round = _contributions(
        row["contributions"], participants, max_rounds
    )
    evidence = _evidence_refs(row["evidence"], "evidence")
    decisions = _decisions(row["decisions"])
    dissent = _dissent(row["dissent"], participant_keys)
    action_items = _action_items(row["action_items"], meeting_id, participant_keys)

    production = _validate_production_bundle(row, participants, participant_keys, state)

    if state == "draft" and (current_round != 0 or contributions):
        raise ValueError("draft meeting history is invalid")
    if state in {"running", "waiting", "completed"} and current_round != history_round:
        raise ValueError("meeting current_round does not match contribution history")
    if state in {"cancelled", "failed"}:
        allowed_rounds = {history_round}
        if not contributions:
            allowed_rounds.add(0)
        if current_round not in allowed_rounds:
            raise ValueError("terminal meeting current_round is invalid")
    # A conclusion meeting still completes on a terminal round. A production
    # meeting may not: round completion only makes it eligible for
    # production_ready, and approval is the one path to completed.
    if terminal_round and not production and state != "completed":
        raise ValueError("terminal contribution round requires completed state")
    if state != "completed" and (decisions or dissent or action_items):
        raise ValueError("meeting conclusions require completed state")

    pending = None
    if "pending" in row:
        if state != "waiting":
            raise ValueError("pending input requires waiting state")
        pending = _record(row["pending"], "pending")
        _bounded_list([pending], "pending", 1)

    runner_sessions = None
    if "runner_sessions" in row:
        raw_sessions = _record(row["runner_sessions"], "runner_sessions")
        runner_sessions = {}
        participant_session_keys = {
            f'{participant["connection"]}::{participant["profile"]}'
            for participant in participants
        }
        for key, session_value in raw_sessions.items():
            normalized_key = _bounded_text(key, "runner_sessions key", 256)
            if normalized_key not in participant_session_keys:
                raise ValueError("runner session key must be a meeting participant")
            runner_sessions[normalized_key] = _bounded_text(
                session_value,
                f"runner_sessions[{key}]",
                256,
            )

    round_run = None
    if "round_run" in row:
        if state != "running":
            raise ValueError("round run requires running state")
        round_run_row = _record(row["round_run"], "round_run")
        if set(round_run_row) != {"participant", "round", "started_at"}:
            raise ValueError("round_run fields are invalid")
        round_run_participant = _route(round_run_row["participant"], "round_run.participant")
        if _route_key(round_run_participant) not in participant_keys:
            raise ValueError("round run participant must be in the meeting")
        round_run_round = round_run_row["round"]
        if (
            isinstance(round_run_round, bool)
            or not isinstance(round_run_round, int)
            or not 1 <= round_run_round <= max_rounds
            or round_run_round != current_round
        ):
            raise ValueError("round_run.round is invalid")
        started_at = round_run_row["started_at"]
        if (
            isinstance(started_at, bool)
            or not isinstance(started_at, int)
            or not 0 < started_at <= MAX_SAFE_INTEGER
        ):
            raise ValueError("round_run.started_at is invalid")
        round_run = {
            "participant": round_run_participant,
            "round": round_run_round,
            "started_at": started_at,
        }

    normalized = {
        "schema_version": SCHEMA_VERSION,
        "id": meeting_id,
        "source": source,
        "title": _bounded_text(row["title"], "title", MAX_TITLE_CHARS),
        "agenda": _bounded_text(row["agenda"], "agenda", MAX_AGENDA_CHARS),
        "chair": chair,
        "participants": participants,
        "state": state,
        "max_rounds": max_rounds,
        "current_round": current_round,
        "contributions": contributions,
        "evidence": evidence,
        "decisions": decisions,
        "dissent": dissent,
        "action_items": action_items,
        **production,
        **({"pending": pending} if pending is not None else {}),
        **({"runner_sessions": runner_sessions} if runner_sessions is not None else {}),
        **({"round_run": round_run} if round_run is not None else {}),
    }
    encoded = json.dumps(
        normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(encoded) > MAX_RECORD_BYTES:
        raise ValueError("meeting exceeds the serialized size limit")
    return normalized


def _validate_production_bundle(
    row: Mapping[str, Any],
    participants: list[dict[str, str]],
    participant_keys: set[tuple[str, str]],
    state: str,
) -> dict[str, Any]:
    """Validate the all-or-none production bundle and its server-owned fields."""
    present = [field for field in PRODUCTION_ONLY_FIELDS if row.get(field) is not None]
    if not present:
        return {}
    missing = [field for field in PRODUCTION_BUNDLE_FIELDS if row.get(field) is None]
    if missing:
        raise ValueError(
            "a production meeting requires the complete production bundle; "
            f"missing: {', '.join(missing)}"
        )
    if len(participants) < MIN_PRODUCTION_PARTICIPANTS:
        raise ValueError("a production meeting requires at least three participant routes")

    orchestrator = _route(row["orchestrator"], "orchestrator")
    producer = _route(row["producer"], "producer")
    if _route_key(orchestrator) not in participant_keys:
        raise ValueError("orchestrator must be a participant")
    if _route_key(producer) not in participant_keys:
        raise ValueError("producer must be a participant")
    if _route_key(orchestrator) == _route_key(producer):
        raise ValueError("orchestrator and producer must be distinct participants")

    seats = _seats(row["seats"], participants, orchestrator, producer)

    product_kind = row["product_kind"]
    if not isinstance(product_kind, str) or product_kind not in PRODUCT_KINDS:
        raise ValueError("product_kind is not a public package kind")

    stage = row.get("production_stage", PRODUCTION_STAGES[0])
    if stage not in _PRODUCTION_STAGE_SET:
        raise ValueError("production_stage is not a valid production stage")

    binding = None
    if row.get("artifact_binding") is not None:
        binding = _artifact_binding(row["artifact_binding"])
        if stage != "completed" or state != "completed":
            raise ValueError("artifact_binding requires a completed production meeting")
    if state == "completed" and (stage != "completed" or binding is None):
        raise InvalidMeetingTransition(
            "a production meeting completes only through the exact owner approval transaction"
        )

    return {
        "orchestrator": orchestrator,
        "producer": producer,
        "seats": seats,
        "product_kind": product_kind,
        "output_title": _bounded_text(row["output_title"], "output_title", MAX_TITLE_CHARS),
        "acceptance_statement": _bounded_text(
            row["acceptance_statement"], "acceptance_statement", MAX_ACCEPTANCE_STATEMENT_CHARS
        ),
        "production_stage": stage,
        **({"artifact_binding": binding} if binding is not None else {}),
    }


def _assert_server_owned_echo(
    proposed: object,
    previous: Mapping[str, Any] | None,
) -> None:
    """Refuse a client payload that creates or changes a server-owned field.

    Runs before the full record validator so an attempt to author approval
    evidence is reported as an authority failure, not a shape failure.
    """
    row = _record(proposed, "meeting")
    for field in SERVER_OWNED_FIELDS:
        current = None if previous is None else previous.get(field)
        if field == "production_stage" and previous is None:
            # A brand-new production draft may declare only the first stage.
            supplied = row.get(field)
            if supplied is not None and supplied != PRODUCTION_STAGES[0]:
                raise ServerOwnedField(
                    "production_stage is server owned; a new production meeting starts at briefing"
                )
            continue
        if row.get(field) != current:
            raise ServerOwnedField(
                f"{field} is server owned; a meeting PUT may only echo its current value"
            )


def _assert_prefix(previous: list[Any], proposed: list[Any], field: str) -> None:
    if len(proposed) < len(previous) or proposed[: len(previous)] != previous:
        raise ImmutableMeetingHistory(f"{field} history cannot be rewritten")


def _validate_transition(
    previous: Mapping[str, Any],
    proposed: Mapping[str, Any],
    *,
    server_owned: bool,
) -> None:
    if proposed["state"] not in _ALLOWED_TRANSITIONS[previous["state"]]:
        raise InvalidMeetingTransition("meeting state transition is invalid")
    for field in ("contributions", "decisions", "dissent", "action_items"):
        _assert_prefix(previous[field], proposed[field], field)
    previous_sessions = previous.get("runner_sessions", {})
    proposed_sessions = proposed.get("runner_sessions", {})
    if any(proposed_sessions.get(key) != value for key, value in previous_sessions.items()):
        raise ImmutableMeetingHistory("runner session bindings cannot change or be removed")
    immutable = ("id", "source", "title", "agenda", "chair", "participants", "max_rounds")
    production_immutable = ("orchestrator", "producer", "seats", "product_kind",
                            "output_title", "acceptance_statement")
    for field in immutable + production_immutable:
        if proposed.get(field) != previous.get(field):
            raise ImmutableMeetingHistory(f"{field} cannot change after creation")

    if server_owned:
        return

    # Server-owned fields: a client may echo the current value, nothing else.
    for field in SERVER_OWNED_FIELDS:
        if proposed.get(field) != previous.get(field):
            raise ServerOwnedField(
                f"{field} is server owned; a meeting PUT may only echo its current value"
            )
    if previous.get("production_stage") is not None and proposed["state"] == "completed":
        raise InvalidMeetingTransition(
            "a production meeting completes only through the exact owner approval transaction"
        )


def serialize_meeting(meeting: Mapping[str, Any]) -> str:
    return json.dumps(
        meeting, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def latest_meeting_row(connection: sqlite3.Connection, meeting_id: str):
    return connection.execute(
        "SELECT version, record_json FROM meeting_versions"
        " WHERE meeting_id = ? ORDER BY version DESC LIMIT 1",
        (meeting_id,),
    ).fetchone()


def append_meeting_version(
    connection: sqlite3.Connection,
    meeting: Mapping[str, Any],
    version: int,
    now: int,
) -> None:
    connection.execute(
        "INSERT INTO meeting_versions (meeting_id, version, state, record_json, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (meeting["id"], version, meeting["state"], serialize_meeting(meeting), now),
    )


def load_production_meeting(
    connection: sqlite3.Connection,
    meeting_id: str,
    expected_version: int | None,
) -> tuple[dict[str, Any], int]:
    """Read the latest production meeting inside a caller-owned transaction."""
    meeting_id = _bounded_text(meeting_id, "meeting id", MAX_ID_CHARS, pattern=_ID_RE)
    latest = latest_meeting_row(connection, meeting_id)
    if latest is None:
        raise KeyError(meeting_id)
    current_version = int(latest["version"])
    if expected_version is not None and current_version != expected_version:
        raise VersionConflict("meeting version conflict")
    meeting = validate_meeting(json.loads(latest["record_json"]))
    if meeting.get("production_stage") is None:
        raise InvalidMeetingTransition("this is not a production meeting")
    return meeting, current_version


def advance_stage_in_transaction(
    connection: sqlite3.Connection,
    meeting_id: str,
    stage: str,
    *,
    expected_version: int | None,
    now: int,
) -> tuple[dict[str, Any], int]:
    """Advance one legal production stage inside a caller-owned transaction."""
    if stage not in _PRODUCTION_STAGE_SET:
        raise ValueError("production_stage is not a valid production stage")
    if stage == "completed":
        raise InvalidMeetingTransition(
            "the completed stage is reached only through the exact owner approval transaction"
        )
    meeting, current_version = load_production_meeting(connection, meeting_id, expected_version)
    if meeting["state"] in TERMINAL_STATES:
        raise InvalidMeetingTransition("a terminal meeting cannot advance its production stage")
    current_stage = meeting["production_stage"]
    if stage not in _STAGE_TRANSITIONS[current_stage]:
        raise InvalidMeetingTransition(
            f"production stage {current_stage} cannot advance to {stage}"
        )
    proposed = dict(meeting)
    proposed["production_stage"] = stage
    if proposed["state"] == "draft":
        proposed["state"] = "running"
        proposed["current_round"] = max(1, proposed["current_round"])
    revalidated = validate_meeting(proposed)
    next_version = current_version + 1
    append_meeting_version(connection, revalidated, next_version, now)
    return revalidated, next_version


def complete_production_in_transaction(
    connection: sqlite3.Connection,
    meeting_id: str,
    *,
    artifact_binding: Mapping[str, Any],
    expected_version: int | None,
    now: int,
) -> tuple[dict[str, Any], int]:
    """Bind approved evidence and complete, inside a caller-owned transaction."""
    binding = _artifact_binding(artifact_binding)
    meeting, current_version = load_production_meeting(connection, meeting_id, expected_version)
    if meeting["state"] == "completed":
        raise InvalidMeetingTransition("the meeting is already completed")
    if meeting["state"] in TERMINAL_STATES:
        raise InvalidMeetingTransition("a terminal meeting cannot be approved")
    if meeting["production_stage"] != "approval_ready":
        raise InvalidMeetingTransition("approval requires the approval_ready production stage")
    proposed = dict(meeting)
    proposed["state"] = "completed"
    proposed["production_stage"] = "completed"
    proposed["artifact_binding"] = binding
    proposed["current_round"] = max(proposed["current_round"], 1)
    revalidated = validate_meeting(proposed)
    next_version = current_version + 1
    append_meeting_version(connection, revalidated, next_version, now)
    return revalidated, next_version


class MeetingStore:
    def __init__(self, db_path: Path | str, *, clock: Callable[[], float] = time.time):
        self.db_path = Path(db_path)
        self.clock = clock
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS meeting_versions (
                    meeting_id TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK(version > 0),
                    state TEXT NOT NULL,
                    record_json TEXT NOT NULL CHECK(length(record_json) BETWEEN 2 AND 256000),
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(meeting_id, version)
                );
                CREATE INDEX IF NOT EXISTS meeting_versions_latest
                ON meeting_versions(meeting_id, version DESC);
                CREATE TRIGGER IF NOT EXISTS meeting_versions_no_update
                BEFORE UPDATE ON meeting_versions
                BEGIN SELECT RAISE(ABORT, 'meeting versions are append only'); END;
                CREATE TRIGGER IF NOT EXISTS meeting_versions_no_delete
                BEFORE DELETE ON meeting_versions
                BEGIN SELECT RAISE(ABORT, 'meeting versions are append only'); END;
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _latest(self, connection: sqlite3.Connection, meeting_id: str):
        return connection.execute(
            "SELECT version, record_json FROM meeting_versions WHERE meeting_id = ? ORDER BY version DESC LIMIT 1",
            (meeting_id,),
        ).fetchone()

    @staticmethod
    def _serialize(meeting: Mapping[str, Any]) -> str:
        return json.dumps(
            meeting, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )

    def _append(
        self,
        connection: sqlite3.Connection,
        meeting: Mapping[str, Any],
        version: int,
    ) -> None:
        connection.execute(
            "INSERT INTO meeting_versions (meeting_id, version, state, record_json, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (meeting["id"], version, meeting["state"], self._serialize(meeting), int(self.clock())),
        )

    def _write(
        self,
        value: object,
        *,
        expected_version: int,
        server_owned: bool,
    ) -> dict[str, Any]:
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("expected_version is invalid")
        meeting_id = _bounded_text(
            _record(value, "meeting").get("id"), "id", MAX_ID_CHARS, pattern=_ID_RE
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            latest = self._latest(connection, meeting_id)
            current_version = int(latest["version"]) if latest else 0
            if current_version != expected_version:
                raise VersionConflict("meeting version conflict")
            previous = (
                validate_meeting(json.loads(latest["record_json"])) if latest else None
            )
            if not server_owned:
                # Server-owned ownership is checked against the stored values
                # BEFORE the full record validator, so a fabricated binding is
                # reported as an authority failure rather than a shape failure.
                _assert_server_owned_echo(value, previous)
            meeting = validate_meeting(value)
            if previous is not None:
                # The stored record is normalized through the same validator so
                # a legacy v1 row compares against a v2 proposal on identity,
                # never on key casing.
                _validate_transition(previous, meeting, server_owned=server_owned)
            next_version = current_version + 1
            self._append(connection, meeting, next_version)
        return {"meeting": meeting, "version": next_version, "schema_version": SCHEMA_VERSION}

    def put(self, value: object, *, expected_version: int) -> dict[str, Any]:
        """Persist a full client-authored meeting record."""
        return self._write(value, expected_version=expected_version, server_owned=False)

    def get(self, meeting_id: str) -> dict[str, Any]:
        meeting_id = _bounded_text(meeting_id, "meeting id", MAX_ID_CHARS, pattern=_ID_RE)
        with self._connect() as connection:
            latest = self._latest(connection, meeting_id)
        if latest is None:
            raise KeyError(meeting_id)
        record = json.loads(latest["record_json"])
        return {
            "meeting": record,
            "version": int(latest["version"]),
            "schema_version": int(record.get("schema_version", LEGACY_SCHEMA_VERSION)),
        }

    def list(self, *, limit: int = 50) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValueError("limit is invalid")
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT v.meeting_id, v.version, v.record_json
                FROM meeting_versions v
                JOIN (
                    SELECT meeting_id, MAX(version) AS version
                    FROM meeting_versions GROUP BY meeting_id
                ) latest ON latest.meeting_id = v.meeting_id AND latest.version = v.version
                ORDER BY v.created_at DESC, v.meeting_id DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            record = json.loads(row["record_json"])
            result.append({
                "meeting": record,
                "version": int(row["version"]),
                "schema_version": int(record.get("schema_version", LEGACY_SCHEMA_VERSION)),
            })
        return result

    # -- server-owned production transactions ------------------------------

    def advance_production_stage(
        self, meeting_id: str, stage: str, *, expected_version: int
    ) -> dict[str, Any]:
        """Move a production meeting one legal stage, server-owned."""
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            meeting, version = advance_stage_in_transaction(
                connection,
                meeting_id,
                stage,
                expected_version=expected_version,
                now=int(self.clock()),
            )
        return {"meeting": meeting, "version": version, "schema_version": SCHEMA_VERSION}

    def complete_production_meeting(
        self,
        meeting_id: str,
        *,
        artifact_binding: Mapping[str, Any],
        expected_version: int,
    ) -> dict[str, Any]:
        """Atomically bind approved evidence and complete a production meeting."""
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            meeting, version = complete_production_in_transaction(
                connection,
                meeting_id,
                artifact_binding=artifact_binding,
                expected_version=expected_version,
                now=int(self.clock()),
            )
        return {"meeting": meeting, "version": version, "schema_version": SCHEMA_VERSION}

    def record_runner_sessions(
        self, meeting_id: str, sessions: Mapping[str, str], *, expected_version: int
    ) -> dict[str, Any]:
        """Add durable participant session bindings without touching history."""
        meeting_id = _bounded_text(meeting_id, "meeting id", MAX_ID_CHARS, pattern=_ID_RE)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            latest = self._latest(connection, meeting_id)
            if latest is None:
                raise KeyError(meeting_id)
            current_version = int(latest["version"])
            if current_version != expected_version:
                raise VersionConflict("meeting version conflict")
            meeting = validate_meeting(json.loads(latest["record_json"]))
            merged = {**meeting.get("runner_sessions", {}), **dict(sessions)}
            proposed = {**meeting, "runner_sessions": merged}
            revalidated = validate_meeting(proposed)
            _validate_transition(meeting, revalidated, server_owned=True)
            next_version = current_version + 1
            self._append(connection, revalidated, next_version)
        return {"meeting": revalidated, "version": next_version, "schema_version": SCHEMA_VERSION}
