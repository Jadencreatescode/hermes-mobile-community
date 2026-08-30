"""Append-only versioned persistence for public structured meetings."""

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
MAX_ROUNDS = 5
MAX_HISTORY_ITEMS = 128

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

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_ROUTE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_PRIORITIES = frozenset({"low", "normal", "high", "critical"})


class VersionConflict(ValueError):
    """The proposed expected version is stale."""


class ImmutableMeetingHistory(ValueError):
    """A new version rewrites an existing contribution or decision."""


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
        raise ValueError(f"{camel} is duplicated")
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
            f"contributions[{index}].evidenceRefs",
        )
        normalized.append({
            "id": _bounded_identifier(row.get("id"), f"contributions[{index}].id"),
            "round": round_number,
            "participant": participant,
            "kind": kind,
            "text": text,
            "evidenceRefs": evidence,
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
            "evidenceRefs": _evidence_refs(
                _history_value(row, "evidenceRefs", "evidence_refs", []),
                f"decisions[{index}].evidenceRefs",
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
            "evidenceRefs": _evidence_refs(
                _history_value(row, "evidenceRefs", "evidence_refs", []),
                f"dissent[{index}].evidenceRefs",
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
            f"action_items[{index}].ownerRoute",
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
            "ownerRoute": owner,
            "title": _bounded_text(row.get("title"), f"action_items[{index}].title", MAX_TITLE_CHARS),
            "acceptanceCriteria": _bounded_text(
                acceptance,
                f"action_items[{index}].acceptanceCriteria",
                MAX_AGENDA_CHARS,
            ),
            "priority": priority,
            "dueIntent": _bounded_text(
                due_intent,
                f"action_items[{index}].dueIntent",
                MAX_CONTRIBUTION_CHARS,
            ),
            "dedupeKey": expected_dedupe,
        })
    return normalized


def validate_meeting(value: object) -> dict[str, Any]:
    row = _record(value, "meeting")
    required = {
        "id", "source", "title", "agenda", "chair", "participants", "state",
        "max_rounds", "current_round", "contributions", "evidence", "decisions",
        "dissent", "action_items",
    }
    optional = {"pending", "runner_sessions"}
    if not required.issubset(row) or not set(row).issubset(required | optional):
        raise ValueError("meeting fields are invalid")

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
    if terminal_round and state != "completed":
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
        for key, value in raw_sessions.items():
            runner_sessions[_bounded_text(key, "runner_sessions key", 256)] = _bounded_text(
                value,
                f"runner_sessions[{key}]",
                256,
            )

    normalized = {
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
        **({"pending": pending} if pending is not None else {}),
        **({"runner_sessions": runner_sessions} if runner_sessions is not None else {}),
    }
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_RECORD_BYTES:
        raise ValueError("meeting exceeds the serialized size limit")
    return normalized


def _assert_prefix(previous: list[Any], proposed: list[Any], field: str) -> None:
    if len(proposed) < len(previous) or proposed[: len(previous)] != previous:
        raise ImmutableMeetingHistory(f"{field} history cannot be rewritten")


def _validate_transition(previous: Mapping[str, Any], proposed: Mapping[str, Any]) -> None:
    if proposed["state"] not in _ALLOWED_TRANSITIONS[previous["state"]]:
        raise ValueError("meeting state transition is invalid")
    for field in ("contributions", "decisions", "dissent", "action_items"):
        _assert_prefix(previous[field], proposed[field], field)
    for field in ("id", "source", "title", "agenda", "chair", "participants", "max_rounds"):
        if proposed[field] != previous[field]:
            raise ImmutableMeetingHistory(f"{field} cannot change after creation")


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

    def put(self, value: object, *, expected_version: int) -> dict[str, Any]:
        meeting = validate_meeting(value)
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise ValueError("expected_version is invalid")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            latest = self._latest(connection, meeting["id"])
            current_version = int(latest["version"]) if latest else 0
            if current_version != expected_version:
                raise VersionConflict("meeting version conflict")
            if latest:
                previous = json.loads(latest["record_json"])
                _validate_transition(previous, meeting)
            next_version = current_version + 1
            serialized = json.dumps(meeting, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
            connection.execute(
                "INSERT INTO meeting_versions (meeting_id, version, state, record_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (meeting["id"], next_version, meeting["state"], serialized, int(self.clock())),
            )
        return {"meeting": meeting, "version": next_version}

    def get(self, meeting_id: str) -> dict[str, Any]:
        meeting_id = _bounded_text(meeting_id, "meeting id", MAX_ID_CHARS, pattern=_ID_RE)
        with self._connect() as connection:
            latest = self._latest(connection, meeting_id)
        if latest is None:
            raise KeyError(meeting_id)
        return {"meeting": json.loads(latest["record_json"]), "version": int(latest["version"])}

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
        return [
            {"meeting": json.loads(row["record_json"]), "version": int(row["version"])}
            for row in rows
        ]
