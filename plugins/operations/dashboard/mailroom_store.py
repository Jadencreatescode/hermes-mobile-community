"""Bounded SQLite persistence for the public Operations Mailroom."""

from __future__ import annotations

import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Callable, Optional

MAX_BODY_CHARS = 4_000
MAX_ID_CHARS = 64
MAX_PROFILE_CHARS = 64
MAX_SESSION_REF_CHARS = 128
MAX_DEDUPE_KEY_CHARS = 128
MAX_HISTORY_EVENTS = 32
MAX_LIST_LIMIT = 100
MAX_POLICY_TTL_SECONDS = 3_600
MAX_TIMESTAMP = 253_402_300_799

URGENCIES = frozenset({"normal", "priority", "critical"})
STATUSES = frozenset(
    {"queued", "delivered", "acknowledged", "failed", "expired", "cancelled"}
)

_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_REFERENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class DuplicateKeyConflict(ValueError):
    """A dedupe key already names different mail."""


class CriticalPolicyDenied(ValueError):
    """No exact, live critical-delivery policy exists."""


class InvalidTransition(ValueError):
    """The requested envelope state change is not permitted."""


class MailroomStore:
    """Own Mailroom envelopes and their immutable status events."""

    def __init__(self, db_path: Path | str, *, clock: Callable[[], float] = time.time):
        self.db_path = Path(db_path)
        self.clock = clock
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _init_schema(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS mailroom_envelopes (
                    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
                    source_profile TEXT NOT NULL CHECK(length(source_profile) BETWEEN 1 AND 64),
                    target_profile TEXT NOT NULL CHECK(length(target_profile) BETWEEN 1 AND 64),
                    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
                    urgency TEXT NOT NULL CHECK(urgency IN ('normal', 'priority', 'critical')),
                    status TEXT NOT NULL CHECK(status IN ('queued', 'delivered', 'acknowledged', 'failed', 'expired', 'cancelled')),
                    created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 253402300799),
                    updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 253402300799),
                    session_ref TEXT CHECK(session_ref IS NULL OR length(session_ref) BETWEEN 1 AND 128),
                    dedupe_key TEXT CHECK(dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 128)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS mailroom_dedupe_identity
                ON mailroom_envelopes(source_profile, target_profile, dedupe_key)
                WHERE dedupe_key IS NOT NULL;
                CREATE TABLE IF NOT EXISTS mailroom_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    envelope_id TEXT NOT NULL REFERENCES mailroom_envelopes(id) ON DELETE RESTRICT,
                    sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 32),
                    status TEXT NOT NULL CHECK(status IN ('queued', 'delivered', 'acknowledged', 'failed', 'expired', 'cancelled')),
                    at INTEGER NOT NULL CHECK(at BETWEEN 0 AND 253402300799),
                    UNIQUE(envelope_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS mailroom_critical_policies (
                    source_profile TEXT NOT NULL CHECK(length(source_profile) BETWEEN 1 AND 64),
                    target_profile TEXT NOT NULL CHECK(length(target_profile) BETWEEN 1 AND 64),
                    expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 253402300799),
                    created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 253402300799),
                    PRIMARY KEY(source_profile, target_profile)
                );
                CREATE TABLE IF NOT EXISTS mailroom_policy_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_profile TEXT NOT NULL CHECK(length(source_profile) BETWEEN 1 AND 64),
                    target_profile TEXT NOT NULL CHECK(length(target_profile) BETWEEN 1 AND 64),
                    decision TEXT NOT NULL CHECK(decision IN ('allowed', 'denied')),
                    reason TEXT NOT NULL CHECK(reason IN ('matched', 'missing', 'expired')),
                    at INTEGER NOT NULL CHECK(at BETWEEN 0 AND 253402300799)
                );
                CREATE TRIGGER IF NOT EXISTS mailroom_events_no_update
                BEFORE UPDATE ON mailroom_events
                BEGIN SELECT RAISE(ABORT, 'mailroom events are append only'); END;
                CREATE TRIGGER IF NOT EXISTS mailroom_events_no_delete
                BEFORE DELETE ON mailroom_events
                BEGIN SELECT RAISE(ABORT, 'mailroom events are append only'); END;
                CREATE TRIGGER IF NOT EXISTS mailroom_policy_decisions_no_update
                BEFORE UPDATE ON mailroom_policy_decisions
                BEGIN SELECT RAISE(ABORT, 'policy decisions are append only'); END;
                CREATE TRIGGER IF NOT EXISTS mailroom_policy_decisions_no_delete
                BEFORE DELETE ON mailroom_policy_decisions
                BEGIN SELECT RAISE(ABORT, 'policy decisions are append only'); END;
                """
            )

    def _now(self) -> int:
        value = int(self.clock())
        if value < 0 or value > MAX_TIMESTAMP:
            raise ValueError("clock produced an invalid timestamp")
        return value

    @staticmethod
    def _profile(value: str, field: str) -> str:
        if not isinstance(value, str) or not _PROFILE_RE.fullmatch(value):
            raise ValueError(f"{field} is invalid")
        return value

    @staticmethod
    def _optional_reference(
        value: Optional[str], field: str, maximum: int
    ) -> Optional[str]:
        if value is None:
            return None
        if (
            not isinstance(value, str)
            or len(value) > maximum
            or not _REFERENCE_RE.fullmatch(value)
        ):
            raise ValueError(f"{field} is invalid")
        return value

    def set_critical_policy(
        self, *, source_profile: str, target_profile: str, expires_at: int
    ) -> dict[str, object]:
        source = self._profile(source_profile, "source_profile")
        target = self._profile(target_profile, "target_profile")
        now = self._now()
        if (
            not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or expires_at <= now
            or expires_at > now + MAX_POLICY_TTL_SECONDS
        ):
            raise ValueError("policy expiration is invalid")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO mailroom_critical_policies (
                    source_profile, target_profile, expires_at, created_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(source_profile, target_profile) DO UPDATE SET
                    expires_at = excluded.expires_at,
                    created_at = excluded.created_at
                """,
                (source, target, expires_at, now),
            )
        return {
            "source_profile": source,
            "target_profile": target,
            "expires_at": expires_at,
            "created_at": now,
        }

    def _authorize_critical(self, source: str, target: str) -> None:
        now = self._now()
        with self._connect() as connection:
            policy = connection.execute(
                """
                SELECT expires_at FROM mailroom_critical_policies
                WHERE source_profile = ? AND target_profile = ?
                """,
                (source, target),
            ).fetchone()
            if policy is None:
                decision, reason = "denied", "missing"
            elif policy["expires_at"] <= now:
                decision, reason = "denied", "expired"
            else:
                decision, reason = "allowed", "matched"
            connection.execute(
                """
                INSERT INTO mailroom_policy_decisions (
                    source_profile, target_profile, decision, reason, at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (source, target, decision, reason, now),
            )
        if decision == "denied":
            raise CriticalPolicyDenied("critical delivery policy denied")

    def list_policy_decisions(self, *, limit: int = 50) -> list[dict[str, object]]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValueError("limit is invalid")
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT source_profile, target_profile, decision, reason, at
                FROM mailroom_policy_decisions ORDER BY id ASC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {
                "source_profile": row["source_profile"],
                "target_profile": row["target_profile"],
                "decision": row["decision"],
                "reason": row["reason"],
                "at": row["at"],
            }
            for row in rows
        ]

    def create_envelope(
        self,
        *,
        source_profile: str,
        target_profile: str,
        body: str,
        urgency: str = "normal",
        session_ref: Optional[str] = None,
        dedupe_key: Optional[str] = None,
    ) -> dict[str, object]:
        source = self._profile(source_profile, "source_profile")
        target = self._profile(target_profile, "target_profile")
        if not isinstance(body, str) or not body.strip() or len(body) > MAX_BODY_CHARS:
            raise ValueError("body is invalid")
        if urgency not in URGENCIES:
            raise ValueError("urgency is invalid")
        session = self._optional_reference(
            session_ref, "session_ref", MAX_SESSION_REF_CHARS
        )
        dedupe = self._optional_reference(
            dedupe_key, "dedupe_key", MAX_DEDUPE_KEY_CHARS
        )
        normalized_body = body.strip()

        if dedupe is not None:
            with self._connect() as connection:
                existing = connection.execute(
                    """
                    SELECT * FROM mailroom_envelopes
                    WHERE source_profile = ? AND target_profile = ? AND dedupe_key = ?
                    """,
                    (source, target, dedupe),
                ).fetchone()
            if existing is not None:
                if (
                    existing["body"] != normalized_body
                    or existing["urgency"] != urgency
                    or existing["session_ref"] != session
                ):
                    raise DuplicateKeyConflict("dedupe key already names different mail")
                result = self.get_envelope(existing["id"])
                result["duplicate"] = True
                return result

        if urgency == "critical":
            self._authorize_critical(source, target)

        now = self._now()
        envelope_id = f"mail_{uuid.uuid4().hex}"

        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO mailroom_envelopes (
                    id, source_profile, target_profile, body, urgency, status,
                    created_at, updated_at, session_ref, dedupe_key
                ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
                """,
                (
                    envelope_id,
                    source,
                    target,
                    normalized_body,
                    urgency,
                    now,
                    now,
                    session,
                    dedupe,
                ),
            )
            connection.execute(
                """
                INSERT INTO mailroom_events (envelope_id, sequence, status, at)
                VALUES (?, 1, 'queued', ?)
                """,
                (envelope_id, now),
            )

        return self.get_envelope(envelope_id)

    def list_envelopes(
        self, *, status: Optional[str] = None, limit: int = 50
    ) -> list[dict[str, object]]:
        if status is not None and status not in STATUSES:
            raise ValueError("status is invalid")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_LIST_LIMIT:
            raise ValueError("limit is invalid")
        where = "WHERE status = ?" if status is not None else ""
        parameters: tuple[object, ...] = (status, limit) if status is not None else (limit,)
        if status == "queued":
            order = (
                "ORDER BY CASE WHEN urgency = 'priority' THEN 0 ELSE 1 END, "
                "created_at ASC, id ASC"
            )
        else:
            order = "ORDER BY updated_at DESC, id DESC"
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT id FROM mailroom_envelopes {where} {order} LIMIT ?",
                parameters,
            ).fetchall()
        return [self.get_envelope(row["id"]) for row in rows]

    def _transition(
        self, envelope_id: str, *, expected: frozenset[str], status: str
    ) -> dict[str, object]:
        if status not in STATUSES:
            raise ValueError("status is invalid")
        now = self._now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status FROM mailroom_envelopes WHERE id = ?", (envelope_id,)
            ).fetchone()
            if row is None:
                raise KeyError(envelope_id)
            if row["status"] not in expected:
                raise InvalidTransition(
                    f"cannot change {row['status']} envelope to {status}"
                )
            sequence = connection.execute(
                "SELECT COUNT(*) + 1 AS n FROM mailroom_events WHERE envelope_id = ?",
                (envelope_id,),
            ).fetchone()["n"]
            if sequence > MAX_HISTORY_EVENTS:
                raise InvalidTransition("envelope history limit reached")
            connection.execute(
                """
                INSERT INTO mailroom_events (envelope_id, sequence, status, at)
                VALUES (?, ?, ?, ?)
                """,
                (envelope_id, sequence, status, now),
            )
            connection.execute(
                """
                UPDATE mailroom_envelopes SET status = ?, updated_at = ? WHERE id = ?
                """,
                (status, now, envelope_id),
            )
        return self.get_envelope(envelope_id)

    def record_delivery(
        self, envelope_id: str, *, delivered: bool
    ) -> dict[str, object]:
        if not isinstance(delivered, bool):
            raise ValueError("delivery result is invalid")
        return self._transition(
            envelope_id,
            expected=frozenset({"queued"}),
            status="delivered" if delivered else "failed",
        )

    def retry(self, envelope_id: str) -> dict[str, object]:
        return self._transition(
            envelope_id, expected=frozenset({"failed"}), status="queued"
        )

    def acknowledge(self, envelope_id: str) -> dict[str, object]:
        return self._transition(
            envelope_id, expected=frozenset({"delivered"}), status="acknowledged"
        )

    def cancel(self, envelope_id: str) -> dict[str, object]:
        return self._transition(
            envelope_id, expected=frozenset({"queued"}), status="cancelled"
        )

    def expire(self, envelope_id: str) -> dict[str, object]:
        return self._transition(
            envelope_id, expected=frozenset({"queued"}), status="expired"
        )

    def get_envelope(self, envelope_id: str) -> dict[str, object]:
        if not isinstance(envelope_id, str) or len(envelope_id) > MAX_ID_CHARS:
            raise ValueError("envelope id is invalid")
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM mailroom_envelopes WHERE id = ?", (envelope_id,)
            ).fetchone()
            if row is None:
                raise KeyError(envelope_id)
            events = connection.execute(
                """
                SELECT sequence, status, at FROM mailroom_events
                WHERE envelope_id = ? ORDER BY sequence ASC LIMIT ?
                """,
                (envelope_id, MAX_HISTORY_EVENTS),
            ).fetchall()
        return {
            "id": row["id"],
            "source_profile": row["source_profile"],
            "target_profile": row["target_profile"],
            "body": row["body"],
            "urgency": row["urgency"],
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "session_ref": row["session_ref"],
            "dedupe_key": row["dedupe_key"],
            "duplicate": False,
            "history": [
                {"sequence": event["sequence"], "status": event["status"], "at": event["at"]}
                for event in events
            ],
        }
