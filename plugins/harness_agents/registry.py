"""SQLite persistence for connected harness agents."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import sqlite3
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

_AGENT_TEMPLATE_FIELDS = (
    "id",
    "name",
    "handle",
    "description",
    "harness",
    "host_id",
    "host_label",
    "connector_url",
    "auth_env",
    "team_id",
)
_AGENT_RESULT_FIELDS = (
    *_AGENT_TEMPLATE_FIELDS,
    "instructions",
    "model_json",
    "skills_json",
    "tools_json",
    "tags_json",
    "source_fingerprint",
    "source_filename",
    "verification_state",
    "native_agent_id",
    "native_session_id",
    "capabilities_json",
    "last_verified_at",
    "last_probe_at",
    "verification_error",
    "icon",
    "runtime_state",
    "advertised_capabilities_json",
    "effective_capabilities_json",
    "supported_operations_json",
    "last_activity_at",
    "work_summary",
    "role",
    "reasoning",
    "connector_state",
    "created_at",
    "updated_at",
)
_MAX_CAPABILITY_INPUTS = 64
_AUDIT_OUTCOMES = frozenset({"allowed", "denied", "succeeded", "failed"})
_VERIFICATION_TTL_SECONDS = 300


class _AgentOperationFileLock:
    """Kernel-backed lock held by an open file descriptor."""

    def __init__(self, handle: Any) -> None:
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            else:
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            handle.close()


def acquire_agent_operation_lock(
    database_path: str | os.PathLike[str],
    agent_id: str,
    *,
    blocking: bool = True,
) -> _AgentOperationFileLock | None:
    """Acquire one deterministic agent lock shared by every Hermes process."""
    if not isinstance(agent_id, str) or not agent_id or "\x00" in agent_id:
        raise ValueError("agent id is required")
    lock_root = Path(database_path).parent / "harness-agent-locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(agent_id.encode("utf-8")).hexdigest()
    handle = (lock_root / f"{digest}.lock").open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "posix":
            import fcntl

            flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), flags)
        else:
            import msvcrt

            mode = msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK
            msvcrt.locking(handle.fileno(), mode, 1)
    except OSError as error:
        handle.close()
        if not blocking and error.errno in {errno.EACCES, errno.EAGAIN}:
            return None
        raise
    return _AgentOperationFileLock(handle)


def _optional_text(value: Any, field: str, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        raise ValueError(f"{field} is invalid or too long")
    return value


def _string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError(f"{field} must be a bounded string list")
    if any(not isinstance(item, str) or not item or len(item) > 256 for item in value):
        raise ValueError(f"{field} contains an invalid item")
    return list(value)


def _model(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) - {"provider", "id"}:
        raise ValueError("model must contain only provider and id")
    model_id = _optional_text(value.get("id"), "model.id", 256)
    provider = _optional_text(value.get("provider"), "model.provider", 128)
    if not model_id:
        raise ValueError("model.id is required")
    return {**({"provider": provider} if provider else {}), "id": model_id}


def _validated_capabilities(value: Iterable[str]) -> list[str]:
    from .policy import ALL_CAPABILITIES

    if isinstance(value, (str, bytes)):
        raise ValueError("capabilities must be a collection of capability names")
    items: list[str] = []
    for item in value:
        if len(items) >= _MAX_CAPABILITY_INPUTS:
            raise ValueError("capabilities exceed the maximum item count")
        items.append(item)
    if any(
        not isinstance(item, str)
        or not item
        or len(item) > 64
        or item not in ALL_CAPABILITIES
        for item in items
    ):
        raise ValueError("capabilities contain an unknown or invalid capability")
    return sorted(set(items))


class HarnessRegistry:
    """Persist connected harness agents and their chat bindings."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self._path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._create_schema()

    def _create_schema(self) -> None:
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS connected_agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    handle TEXT NOT NULL,
                    description TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    host_id TEXT NOT NULL,
                    host_label TEXT NOT NULL,
                    connector_url TEXT NOT NULL,
                    auth_env TEXT NOT NULL,
                    team_id TEXT NOT NULL,
                    instructions TEXT NOT NULL DEFAULT '',
                    model_json TEXT NOT NULL DEFAULT 'null',
                    skills_json TEXT NOT NULL DEFAULT '[]',
                    tools_json TEXT NOT NULL DEFAULT '[]',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    source_fingerprint TEXT NOT NULL DEFAULT '',
                    source_filename TEXT NOT NULL DEFAULT '',
                    verification_state TEXT NOT NULL,
                    native_agent_id TEXT,
                    native_session_id TEXT,
                    capabilities_json TEXT NOT NULL,
                    supported_operations_json TEXT NOT NULL DEFAULT '[]',
                    last_verified_at TEXT NOT NULL DEFAULT '',
                    last_probe_at TEXT NOT NULL DEFAULT '',
                    verification_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );

                CREATE TABLE IF NOT EXISTS agent_connectors (
                    agent_id TEXT PRIMARY KEY,
                    connector_type TEXT NOT NULL DEFAULT 'a2a',
                    url TEXT NOT NULL,
                    auth_env TEXT NOT NULL,
                    host_id TEXT NOT NULL,
                    verification_state TEXT NOT NULL DEFAULT 'pending',
                    last_probe_at TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (agent_id) REFERENCES connected_agents(id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL DEFAULT (
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    )
                );

                CREATE TABLE IF NOT EXISTS agent_chat_commits (
                    connector_event_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    mirror_session_id TEXT NOT NULL,
                    expected_native_session_id TEXT NOT NULL,
                    native_session_id TEXT NOT NULL,
                    payload_digest TEXT NOT NULL,
                    user_message TEXT NOT NULL,
                    assistant_reply TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
                    created_at TEXT NOT NULL DEFAULT (
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    ),
                    committed_at TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (agent_id) REFERENCES connected_agents(id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS agent_chat_bindings (
                    agent_id TEXT PRIMARY KEY,
                    mirror_session_id TEXT NOT NULL,
                    native_session_id TEXT NOT NULL,
                    FOREIGN KEY (agent_id) REFERENCES connected_agents(id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS agent_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    principal TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    )
                );

                CREATE INDEX IF NOT EXISTS idx_agent_events_agent_id_id
                    ON agent_events(agent_id, id);

                INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
                """
            )
            existing = {
                row[1]
                for row in self._connection.execute("PRAGMA table_info(connected_agents)")
            }
            additions = {
                "instructions": "TEXT NOT NULL DEFAULT ''",
                "model_json": "TEXT NOT NULL DEFAULT 'null'",
                "skills_json": "TEXT NOT NULL DEFAULT '[]'",
                "tools_json": "TEXT NOT NULL DEFAULT '[]'",
                "tags_json": "TEXT NOT NULL DEFAULT '[]'",
                "source_fingerprint": "TEXT NOT NULL DEFAULT ''",
                "source_filename": "TEXT NOT NULL DEFAULT ''",
                "last_verified_at": "TEXT NOT NULL DEFAULT ''",
                "last_probe_at": "TEXT NOT NULL DEFAULT ''",
                "verification_error": "TEXT NOT NULL DEFAULT ''",
                "icon": "TEXT NOT NULL DEFAULT ''",
                "runtime_state": "TEXT NOT NULL DEFAULT 'offline'",
                "advertised_capabilities_json": "TEXT NOT NULL DEFAULT '[]'",
                "effective_capabilities_json": "TEXT NOT NULL DEFAULT '[]'",
                "supported_operations_json": "TEXT NOT NULL DEFAULT '[]'",
                "last_activity_at": "TEXT NOT NULL DEFAULT ''",
                "work_summary": "TEXT NOT NULL DEFAULT ''",
                "role": "TEXT NOT NULL DEFAULT ''",
                "reasoning": "TEXT NOT NULL DEFAULT ''",
                "connector_state": "TEXT NOT NULL DEFAULT 'pending'",
                "created_at": "TEXT NOT NULL DEFAULT ''",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            }
            for column, definition in additions.items():
                if column not in existing:
                    self._connection.execute(
                        f"ALTER TABLE connected_agents ADD COLUMN {column} {definition}"
                    )
            self._connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS connected_agents_updated_at
                AFTER UPDATE ON connected_agents
                FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
                BEGIN
                    UPDATE connected_agents
                    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = NEW.id;
                END
                """
            )
            self._connection.execute(
                """
                UPDATE connected_agents
                SET verification_state = 'degraded',
                    verification_error = 'verification_freshness_unknown'
                WHERE verification_state = 'verified' AND last_probe_at = ''
                """
            )
            self._connection.execute("INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)")
            self._connection.execute(
                """
                INSERT OR IGNORE INTO agent_connectors (
                    agent_id, connector_type, url, auth_env, host_id,
                    verification_state, last_probe_at
                )
                SELECT id, 'a2a', connector_url, auth_env, host_id,
                       verification_state, last_probe_at
                FROM connected_agents
                """
            )

    @staticmethod
    def _normalize_agent(row: sqlite3.Row) -> dict[str, Any]:
        agent = {
            field: row[field]
            for field in _AGENT_RESULT_FIELDS
            if not field.endswith("_json")
        }
        agent["model"] = json.loads(row["model_json"])
        agent["skills"] = json.loads(row["skills_json"])
        agent["tools"] = json.loads(row["tools_json"])
        agent["tags"] = json.loads(row["tags_json"])
        agent["capabilities"] = json.loads(row["capabilities_json"])
        agent["advertised_capabilities"] = json.loads(row["advertised_capabilities_json"])
        agent["effective_capabilities"] = json.loads(row["effective_capabilities_json"])
        agent["supported_operations"] = json.loads(row["supported_operations_json"])
        return agent

    def _expire_stale_verifications(self) -> None:
        """Remove stale connectors from the live roster before any read."""
        with self._connection:
            self._connection.execute(
                """
                UPDATE connected_agents
                SET verification_state = 'degraded',
                    verification_error = 'verification_expired'
                WHERE verification_state = 'verified'
                  AND COALESCE(
                        CAST(strftime('%s', last_probe_at) AS INTEGER),
                        0
                      ) <= CAST(strftime('%s', 'now') AS INTEGER) - ?
                """,
                (_VERIFICATION_TTL_SECONDS,),
            )
            self._connection.execute(
                """
                UPDATE agent_connectors
                SET verification_state = 'degraded'
                WHERE agent_id IN (
                    SELECT id FROM connected_agents
                    WHERE verification_state = 'degraded'
                      AND verification_error = 'verification_expired'
                )
                """
            )

    def create_agent(self, template: Mapping[str, Any]) -> dict[str, Any]:
        """Create a pending agent from the supported template fields."""
        values = [template[field] for field in _AGENT_TEMPLATE_FIELDS]
        metadata = [
            _optional_text(template.get("instructions"), "instructions", 65_536),
            json.dumps(_model(template.get("model")), sort_keys=True, separators=(",", ":")),
            json.dumps(_string_list(template.get("skills"), "skills"), separators=(",", ":")),
            json.dumps(_string_list(template.get("tools"), "tools"), separators=(",", ":")),
            json.dumps(_string_list(template.get("tags"), "tags"), separators=(",", ":")),
            _optional_text(template.get("source_fingerprint"), "source_fingerprint", 80),
            _optional_text(template.get("source_filename"), "source_filename", 255),
        ]
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO connected_agents (
                    id, name, handle, description, harness, host_id, host_label,
                    connector_url, auth_env, team_id, instructions, model_json,
                    skills_json, tools_json, tags_json, source_fingerprint,
                    source_filename, verification_state,
                    native_agent_id, native_session_id, capabilities_json
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'pending', NULL, NULL, '[]'
                )
                """,
                [*values, *metadata],
            )
            self._connection.execute(
                """
                INSERT INTO agent_connectors (
                    agent_id, connector_type, url, auth_env, host_id,
                    verification_state, last_probe_at
                ) VALUES (?, 'a2a', ?, ?, ?, 'pending', '')
                """,
                (
                    template["id"],
                    template["connector_url"],
                    template["auth_env"],
                    template["host_id"],
                ),
            )
        return self.get_agent(str(template["id"]))

    def list_agents(self, *, verified_only: bool = False) -> list[dict[str, Any]]:
        """List agents in stable id order, optionally limiting to verified rows."""
        self._expire_stale_verifications()
        query = "SELECT * FROM connected_agents"
        parameters: tuple[str, ...] = ()
        if verified_only:
            query += " WHERE verification_state = ?"
            parameters = ("verified",)
        query += " ORDER BY id"
        rows = self._connection.execute(query, parameters).fetchall()
        return [self._normalize_agent(row) for row in rows]

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Return one normalized agent or raise when it does not exist."""
        self._expire_stale_verifications()
        row = self._connection.execute(
            "SELECT * FROM connected_agents WHERE id = ?", (agent_id,)
        ).fetchone()
        if row is None:
            raise ValueError(f"unknown agent: {agent_id}")
        return self._normalize_agent(row)

    def delete_agent(self, agent_id: str) -> bool:
        """Remove one agent and its cascading rows. Returns True if it existed."""
        agent_id = _optional_text(agent_id, "agent id", 256)
        if not agent_id:
            raise ValueError("agent id is required")
        with self._connection:
            cursor = self._connection.execute(
                "DELETE FROM connected_agents WHERE id = ?", (agent_id,)
            )
            return cursor.rowcount > 0

    def mark_verified(
        self,
        agent_id: str,
        *,
        native_agent_id: str,
        native_session_id: str,
        mirror_session_id: str,
        capabilities: Iterable[str],
        runtime_state: str = "idle",
        work_summary: str = "",
        model: Mapping[str, Any] | None = None,
        reasoning: str = "",
        supported_operations: Iterable[str] = (),
        trusted_template: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Verify an agent and persist its chat binding in one transaction."""
        validated = _validated_capabilities(capabilities)
        capabilities_json = json.dumps(validated, separators=(",", ":"))
        operations = sorted(set(supported_operations))
        if any(
            value
            not in {
                "probe",
                "start_or_resume",
                "send",
                "steer",
                "interrupt",
                "get_state",
                "get_messages",
                "list_models",
                "set_model",
                "close",
            }
            for value in operations
        ):
            raise ValueError("supported operations contain an invalid operation")
        operations_json = json.dumps(operations, separators=(",", ":"))
        if runtime_state not in {
            "idle",
            "working",
            "waiting",
            "reviewing",
            "blocked",
            "offline",
        }:
            runtime_state = "idle"
        model_json = (
            json.dumps(_model(model), sort_keys=True, separators=(",", ":"))
            if model is not None
            else None
        )
        if trusted_template is not None:
            if trusted_template.get("id") != agent_id:
                raise ValueError("trusted template identity does not match agent")
            authority = [trusted_template[field] for field in _AGENT_TEMPLATE_FIELDS]
        else:
            authority = None
        with self._connection:
            if authority is not None:
                assert trusted_template is not None
                cursor = self._connection.execute(
                    """
                    UPDATE connected_agents
                    SET name = ?, handle = ?, description = ?, harness = ?,
                        host_id = ?, host_label = ?, connector_url = ?,
                        auth_env = ?, team_id = ?
                    WHERE id = ?
                    """,
                    [*authority[1:], agent_id],
                )
                if cursor.rowcount == 0:
                    raise ValueError(f"unknown agent: {agent_id}")
                connector = self._connection.execute(
                    """
                    UPDATE agent_connectors
                    SET url = ?, auth_env = ?, host_id = ?,
                        verification_state = 'pending', last_probe_at = ''
                    WHERE agent_id = ?
                    """,
                    (
                        trusted_template["connector_url"],
                        trusted_template["auth_env"],
                        trusted_template["host_id"],
                        agent_id,
                    ),
                )
                if connector.rowcount == 0:
                    raise ValueError(f"unknown connector: {agent_id}")
            cursor = self._connection.execute(
                """
                UPDATE connected_agents
                SET verification_state = 'verified',
                    native_agent_id = ?,
                    native_session_id = ?,
                    capabilities_json = ?,
                    last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    last_probe_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    verification_error = ''
                    , runtime_state = ?, advertised_capabilities_json = ?,
                    effective_capabilities_json = ?, connector_state = 'verified',
                    work_summary = ?, reasoning = ?,
                    last_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    model_json = COALESCE(?, model_json)
                    , supported_operations_json = ?
                WHERE id = ?
                """,
                (
                    native_agent_id,
                    native_session_id,
                    capabilities_json,
                    runtime_state,
                    capabilities_json,
                    capabilities_json,
                    _optional_text(work_summary, "work summary", 1024),
                    _optional_text(reasoning, "reasoning", 256),
                    model_json,
                    operations_json,
                    agent_id,
                ),
            )
            if cursor.rowcount == 0:
                raise ValueError(f"unknown agent: {agent_id}")
            self._connection.execute(
                """
                UPDATE agent_connectors
                SET verification_state = 'verified',
                    last_probe_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE agent_id = ?
                """,
                (agent_id,),
            )
            self._connection.execute(
                """
                INSERT INTO agent_chat_bindings (
                    agent_id, mirror_session_id, native_session_id
                ) VALUES (?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                    mirror_session_id = excluded.mirror_session_id,
                    native_session_id = excluded.native_session_id
                """,
                (agent_id, mirror_session_id, native_session_id),
            )
        return self.get_agent(agent_id)

    def mark_degraded(self, agent_id: str, *, error: str) -> dict[str, Any]:
        """Record a failed live probe without destroying the last chat binding."""
        error = _optional_text(error, "verification error", 128)
        if not error:
            raise ValueError("verification error is required")
        with self._connection:
            cursor = self._connection.execute(
                """
                UPDATE connected_agents
                SET verification_state = 'degraded',
                    last_probe_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    verification_error = ?, runtime_state = 'offline', connector_state = 'degraded'
                WHERE id = ?
                """,
                (error, agent_id),
            )
            if cursor.rowcount == 0:
                raise ValueError(f"unknown agent: {agent_id}")
            self._connection.execute(
                """
                UPDATE agent_connectors
                SET verification_state = 'degraded',
                    last_probe_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE agent_id = ?
                """,
                (agent_id,),
            )
        return self.get_agent(agent_id)

    def commit_chat_turn(
        self,
        agent_id: str,
        *,
        state_db_path: str | os.PathLike[str],
        mirror_session_id: str,
        expected_native_session_id: str,
        native_session_id: str,
        connector_event_id: str,
        user_message: str,
        assistant_reply: str,
    ) -> None:
        """Project a journaled turn into state.db, then advance its context."""
        from .manifest import redact_agent_text

        values = {
            "agent_id": _optional_text(agent_id, "agent id", 256),
            "mirror_session_id": _optional_text(
                mirror_session_id, "mirror session id", 512
            ),
            "expected_native_session_id": _optional_text(
                expected_native_session_id, "expected native session id", 512
            ),
            "native_session_id": _optional_text(
                native_session_id, "native session id", 512
            ),
            "connector_event_id": _optional_text(
                connector_event_id, "connector event id", 256
            ),
            "user_message": _optional_text(
                redact_agent_text(user_message), "user message", 16_000
            ),
            "assistant_reply": _optional_text(
                redact_agent_text(assistant_reply), "assistant reply", 48_000
            ),
        }
        if not all(
            values[field]
            for field in (
                "agent_id",
                "mirror_session_id",
                "native_session_id",
                "connector_event_id",
                "user_message",
                "assistant_reply",
            )
        ):
            raise ValueError("chat turn fields are required")
        payload_digest = hashlib.sha256(
            (values["user_message"] + "\x00" + values["assistant_reply"]).encode(
                "utf-8"
            )
        ).hexdigest()

        state_path = Path(state_db_path).resolve(strict=True)
        if state_path == self._path.resolve(strict=True):
            raise ValueError("state and operations databases must be distinct")

        with self._connection:
            existing = self._connection.execute(
                "SELECT * FROM agent_chat_commits WHERE connector_event_id = ?",
                (values["connector_event_id"],),
            ).fetchone()
            if existing is None:
                binding = self._connection.execute(
                    """
                    SELECT native_session_id FROM agent_chat_bindings
                    WHERE agent_id = ? AND mirror_session_id = ?
                    """,
                    (values["agent_id"], values["mirror_session_id"]),
                ).fetchone()
                if (
                    binding is None
                    or binding["native_session_id"]
                    != values["expected_native_session_id"]
                ):
                    raise ValueError("connected agent native context changed")
                self._connection.execute(
                    """
                    INSERT INTO agent_chat_commits (
                        connector_event_id, agent_id, mirror_session_id,
                        expected_native_session_id, native_session_id,
                        payload_digest, user_message, assistant_reply, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                    """,
                    (
                        values["connector_event_id"],
                        values["agent_id"],
                        values["mirror_session_id"],
                        values["expected_native_session_id"],
                        values["native_session_id"],
                        payload_digest,
                        values["user_message"],
                        values["assistant_reply"],
                    ),
                )
            elif not existing["assistant_reply"]:
                if (
                    existing["agent_id"] != values["agent_id"]
                    or existing["mirror_session_id"] != values["mirror_session_id"]
                    or existing["expected_native_session_id"]
                    != values["expected_native_session_id"]
                    or existing["user_message"] != values["user_message"]
                ):
                    raise ValueError(
                        "client request replay does not match its durable intent"
                    )
                self._connection.execute(
                    "UPDATE agent_chat_commits SET native_session_id = ?, payload_digest = ?, assistant_reply = ? WHERE connector_event_id = ? AND status = 'pending'",
                    (
                        values["native_session_id"],
                        payload_digest,
                        values["assistant_reply"],
                        values["connector_event_id"],
                    ),
                )
            elif any(
                (
                    existing["agent_id"] != values["agent_id"],
                    existing["mirror_session_id"] != values["mirror_session_id"],
                    existing["expected_native_session_id"]
                    != values["expected_native_session_id"],
                    existing["native_session_id"] != values["native_session_id"],
                    existing["payload_digest"] != payload_digest,
                )
            ):
                raise ValueError(
                    "connector event replay does not match its original turn"
                )

        connection = sqlite3.connect(state_path, timeout=60)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            inserted = 0
            for sequence, role, content in (
                (0, "user", values["user_message"]),
                (1, "assistant", values["assistant_reply"]),
            ):
                metadata = json.dumps(
                    {
                        "connector_event_id": values["connector_event_id"],
                        "sequence": sequence,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
                present = connection.execute(
                    """
                    SELECT 1 FROM messages
                    WHERE session_id = ? AND display_kind = 'connected-agent'
                      AND display_metadata = ?
                    LIMIT 1
                    """,
                    (values["mirror_session_id"], metadata),
                ).fetchone()
                if present is None:
                    connection.execute(
                        """
                        INSERT INTO messages (
                            session_id, role, content, timestamp,
                            display_kind, display_metadata
                        ) VALUES (?, ?, ?, ?, 'connected-agent', ?)
                        """,
                        (values["mirror_session_id"], role, content, now, metadata),
                    )
                    inserted += 1
            session = connection.execute(
                "UPDATE sessions SET message_count = message_count + ? WHERE id = ?",
                (inserted, values["mirror_session_id"]),
            )
            if session.rowcount == 0:
                raise ValueError("connected agent mirror session is missing")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        self._finalize_chat_commit(values["connector_event_id"])

    def prepare_chat_intent(
        self,
        agent_id: str,
        *,
        mirror_session_id: str,
        expected_native_session_id: str,
        request_id: str,
        user_message: str,
    ) -> None:
        """Persist an idempotent client request before any remote dispatch."""
        from .manifest import redact_agent_text

        safe = _optional_text(redact_agent_text(user_message), "user message", 16_000)
        request_id = _optional_text(request_id, "request id", 256)
        if not safe or not request_id:
            raise ValueError("chat intent fields are required")
        digest = hashlib.sha256((safe + "\x00").encode()).hexdigest()
        with self._connection:
            existing = self._connection.execute(
                "SELECT * FROM agent_chat_commits WHERE connector_event_id = ?",
                (request_id,),
            ).fetchone()
            if existing is not None:
                if existing["agent_id"] != agent_id or existing["user_message"] != safe:
                    raise ValueError(
                        "client request identity was reused for another turn"
                    )
                return
            self._connection.execute(
                "INSERT INTO agent_chat_commits (connector_event_id, agent_id, mirror_session_id, expected_native_session_id, native_session_id, payload_digest, user_message, assistant_reply, status) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'pending')",
                (
                    request_id,
                    agent_id,
                    mirror_session_id,
                    expected_native_session_id,
                    expected_native_session_id,
                    digest,
                    safe,
                ),
            )

    def discard_legacy_adapter_intent(self, request_id: str) -> None:
        """Compatibility cleanup for legacy adapters without idempotency support."""
        with self._connection:
            self._connection.execute(
                "DELETE FROM agent_chat_commits WHERE connector_event_id = ? AND status = 'pending' AND assistant_reply = ''",
                (request_id,),
            )

    def recover_pending_chat_commits(
        self,
        agent_id: str,
        *,
        state_db_path: str | os.PathLike[str],
        limit: int = 32,
    ) -> int:
        """Boundedly finish durable mirror projections before another native turn."""
        if limit < 1 or limit > 128:
            raise ValueError("recovery limit is invalid")
        rows = self._connection.execute(
            "SELECT * FROM agent_chat_commits WHERE agent_id = ? AND status = 'pending' ORDER BY created_at, connector_event_id LIMIT ?",
            (agent_id, limit + 1),
        ).fetchall()
        if len(rows) > limit:
            raise RuntimeError("connected agent recovery backlog exceeds its bound")
        recovered = 0
        for row in rows:
            if not row["user_message"] or not row["assistant_reply"]:
                raise RuntimeError("connected agent has an incomplete durable turn")
            self.commit_chat_turn(
                str(row["agent_id"]),
                state_db_path=state_db_path,
                mirror_session_id=str(row["mirror_session_id"]),
                expected_native_session_id=str(row["expected_native_session_id"]),
                native_session_id=str(row["native_session_id"]),
                connector_event_id=str(row["connector_event_id"]),
                user_message=str(row["user_message"]),
                assistant_reply=str(row["assistant_reply"]),
            )
            recovered += 1
        return recovered

    def incomplete_chat_request_ids(self, agent_id: str) -> tuple[str, ...]:
        rows = self._connection.execute(
            "SELECT connector_event_id FROM agent_chat_commits WHERE agent_id = ? AND status = 'pending' AND assistant_reply = '' ORDER BY created_at LIMIT 33",
            (agent_id,),
        ).fetchall()
        if len(rows) > 32:
            raise RuntimeError("connected agent recovery backlog exceeds its bound")
        return tuple(str(row[0]) for row in rows)

    def chat_request_status(self, agent_id: str, request_id: str) -> str:
        """Return the durable mirror status for one agent-scoped request."""
        request_id = _optional_text(request_id, "request id", 256)
        row = self._connection.execute(
            "SELECT status FROM agent_chat_commits WHERE agent_id = ? AND connector_event_id = ?",
            (agent_id, request_id),
        ).fetchone()
        return str(row["status"]) if row is not None else "unknown"

    def _finalize_chat_commit(self, connector_event_id: str) -> None:
        """Advance native context only after the canonical mirror is durable."""
        with self._connection:
            row = self._connection.execute(
                "SELECT * FROM agent_chat_commits WHERE connector_event_id = ?",
                (connector_event_id,),
            ).fetchone()
            if row is None:
                raise ValueError("unknown connector event")
            if row["status"] == "committed":
                return
            binding = self._connection.execute(
                """
                UPDATE agent_chat_bindings
                SET native_session_id = ?
                WHERE agent_id = ? AND mirror_session_id = ?
                  AND native_session_id IN (?, ?)
                """,
                (
                    row["native_session_id"],
                    row["agent_id"],
                    row["mirror_session_id"],
                    row["expected_native_session_id"],
                    row["native_session_id"],
                ),
            )
            agent = self._connection.execute(
                """
                UPDATE connected_agents
                SET native_session_id = ?
                WHERE id = ? AND verification_state = 'verified'
                  AND COALESCE(native_session_id, '') IN (?, ?)
                """,
                (
                    row["native_session_id"],
                    row["agent_id"],
                    row["expected_native_session_id"],
                    row["native_session_id"],
                ),
            )
            if binding.rowcount == 0 or agent.rowcount == 0:
                raise ValueError("connected agent chat binding changed")
            self._connection.execute(
                """
                UPDATE agent_chat_commits
                SET status = 'committed', user_message = '', assistant_reply = '',
                    committed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE connector_event_id = ? AND status = 'pending'
                """,
                (connector_event_id,),
            )

    def record_event(
        self,
        agent_id: str,
        *,
        principal: str,
        event_type: str,
        outcome: str,
        detail: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one bounded control-plane audit event."""
        agent_id = _optional_text(agent_id, "agent event id", 256)
        principal = _optional_text(principal, "agent event principal", 64)
        event_type = _optional_text(event_type, "agent event type", 64)
        if not agent_id or not principal or not event_type:
            raise ValueError("agent event identity fields are required")
        if any(not (char.isalnum() or char in "._-") for char in event_type):
            raise ValueError("agent event type is invalid")
        if outcome not in _AUDIT_OUTCOMES:
            raise ValueError("agent event outcome is invalid")
        values = {} if detail is None else detail
        if not isinstance(values, Mapping) or len(values) > 16:
            raise ValueError("agent event detail must be a bounded mapping")
        normalized_detail: dict[str, Any] = {}
        for key, value in values.items():
            if not isinstance(key, str) or not key or len(key) > 64:
                raise ValueError("agent event detail key is invalid")
            if not isinstance(value, (str, int, bool, type(None))):
                raise ValueError("agent event detail value is invalid")
            if isinstance(value, str) and len(value) > 256:
                raise ValueError("agent event detail value is too long")
            normalized_detail[key] = value
        detail_json = json.dumps(
            normalized_detail,
            sort_keys=True,
            separators=(",", ":"),
        )
        if len(detail_json.encode("utf-8")) > 2048:
            raise ValueError("agent event detail is too large")
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO agent_events (
                    agent_id, principal, event_type, outcome, detail_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (agent_id, principal, event_type, outcome, detail_json),
            )
        if cursor.lastrowid is None:
            raise RuntimeError("agent audit event did not receive an identity")
        event_id = int(cursor.lastrowid)
        row = self._connection.execute(
            "SELECT * FROM agent_events WHERE id = ?",
            (event_id,),
        ).fetchone()
        return self._normalize_event(row)

    @staticmethod
    def _normalize_event(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "agent_id": row["agent_id"],
            "principal": row["principal"],
            "event_type": row["event_type"],
            "outcome": row["outcome"],
            "detail": json.loads(row["detail_json"]),
            "created_at": row["created_at"],
        }

    def list_events(self, agent_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        """Read a bounded ordered audit history for internal verification."""
        agent_id = _optional_text(agent_id, "agent event id", 256)
        if not agent_id or not isinstance(limit, int) or isinstance(limit, bool):
            raise ValueError("agent event query is invalid")
        if limit < 1 or limit > 500:
            raise ValueError("agent event limit is invalid")
        rows = self._connection.execute(
            """
            SELECT * FROM agent_events
            WHERE agent_id = ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (agent_id, limit),
        ).fetchall()
        return [self._normalize_event(row) for row in rows]

    def get_chat_binding(self, agent_id: str) -> dict[str, str]:
        """Return an agent's persisted chat binding."""
        row = self._connection.execute(
            """
            SELECT agent_id, mirror_session_id, native_session_id
            FROM agent_chat_bindings
            WHERE agent_id = ?
            """,
            (agent_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"unknown agent: {agent_id}")
        return {
            "agent_id": row["agent_id"],
            "mirror_session_id": row["mirror_session_id"],
            "native_session_id": row["native_session_id"],
        }

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        self._connection.close()
