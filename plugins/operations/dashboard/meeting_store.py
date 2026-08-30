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
        "contributions": _bounded_list(row["contributions"], "contributions"),
        "evidence": _bounded_list(row["evidence"], "evidence", 32),
        "decisions": _bounded_list(row["decisions"], "decisions", 32),
        "dissent": _bounded_list(row["dissent"], "dissent", 32),
        "action_items": _bounded_list(row["action_items"], "action_items", 64),
        **({"pending": row["pending"]} if "pending" in row else {}),
        **({"runner_sessions": _record(row["runner_sessions"], "runner_sessions")} if "runner_sessions" in row else {}),
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
