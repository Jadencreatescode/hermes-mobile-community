"""Durable public multi-Bot rooms with bounded transcripts and floor handoff."""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

MAX_ROOM_MEMBERS = 6
MAX_ROOM_NAME_CHARS = 80
MAX_ROOM_MESSAGE_CHARS = 16_000
MAX_TRANSCRIPT_READ = 200
MAX_TRANSCRIPT_STORED = 1_000
_HANDOFF = re.compile(r"\[\[\s*handoff\s*:\s*(?P<agent>[^\[\]]+?)\s*\]\]", re.IGNORECASE)
_HANDOFF_MARKERS = re.compile(r"\[\[\s*handoff\s*:[^\[\]]*\]\]", re.IGNORECASE)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _bounded_text(value: Any, label: str, maximum: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > maximum or "\x00" in text:
        raise ValueError(f"{label} is required and bounded")
    return text


def _redacted_bounded_text(value: Any, label: str, maximum: int) -> str:
    from .manifest import redact_agent_text

    raw = _bounded_text(value, label, maximum)
    return _bounded_text(redact_agent_text(raw), label, maximum)

class RoomStore:
    """Rooms live beside the operations registry, never in private gateway RPC state."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    floor TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS room_members (
                    room_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    PRIMARY KEY (room_id, agent_id),
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS room_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT NOT NULL,
                    speaker TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    request_id TEXT NOT NULL DEFAULT '',
                    payload_digest TEXT NOT NULL DEFAULT '',
                    at TEXT NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS room_messages_room
                    ON room_messages(room_id, id);
                DROP INDEX IF EXISTS room_messages_request;
                CREATE UNIQUE INDEX IF NOT EXISTS room_messages_speaker_request
                    ON room_messages(room_id, speaker, request_id)
                    WHERE request_id <> '';
                CREATE TABLE IF NOT EXISTS room_turns (
                    room_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    message TEXT NOT NULL,
                    payload_digest TEXT NOT NULL,
                    reply TEXT NOT NULL DEFAULT '',
                    reply_digest TEXT NOT NULL DEFAULT '',
                    floor TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
                    created_at TEXT NOT NULL,
                    committed_at TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (room_id, request_id),
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );
                """
            )
            message_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(room_messages)")
            }
            if "payload_digest" not in message_columns:
                connection.execute(
                    "ALTER TABLE room_messages ADD COLUMN payload_digest TEXT NOT NULL DEFAULT ''"
                )
            turn_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(room_turns)")
            }
            if "reply_digest" not in turn_columns:
                connection.execute(
                    "ALTER TABLE room_turns ADD COLUMN reply_digest TEXT NOT NULL DEFAULT ''"
                )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def create(self, name: Any, *, created_by: str) -> dict[str, Any]:
        label = " ".join(
            _redacted_bounded_text(name, "room name", MAX_ROOM_NAME_CHARS).split()
        )
        room = {
            "id": uuid.uuid4().hex,
            "name": label,
            "created_by": _bounded_text(created_by, "room creator", 128),
            "created_at": _now(),
            "floor": "owner",
        }
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO rooms (id, name, created_by, created_at, floor) VALUES (?, ?, ?, ?, ?)",
                tuple(room.values()),
            )
        room.pop("created_by")
        return {**room, "members": [], "member_count": 0}

    def get(self, room_id: Any) -> dict[str, Any]:
        wanted = _bounded_text(room_id, "room id", 64)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM rooms WHERE id = ?", (wanted,)
            ).fetchone()
        if row is None:
            raise LookupError("room not found")
        room = dict(row)
        room.pop("created_by", None)
        room["members"] = self.members(wanted)
        room["member_count"] = len(room["members"])
        return room

    def list_rooms(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT id FROM rooms ORDER BY created_at, id LIMIT 200").fetchall()
        return [self.get(row["id"]) for row in rows]

    def members(self, room_id: Any) -> list[str]:
        wanted = _bounded_text(room_id, "room id", 64)
        with self._connect() as connection:
            exists = connection.execute("SELECT 1 FROM rooms WHERE id = ?", (wanted,)).fetchone()
            if exists is None:
                raise LookupError("room not found")
            rows = connection.execute(
                "SELECT agent_id FROM room_members WHERE room_id = ? ORDER BY position, agent_id",
                (wanted,),
            ).fetchall()
        return [str(row["agent_id"]) for row in rows]

    def add_member(self, room_id: Any, agent_id: Any, *, registry: Any) -> dict[str, Any]:
        room = self.get(room_id)
        wanted = _bounded_text(agent_id, "Bot identity", 256)
        held = list(room["members"])
        if wanted in held:
            return self.get(room["id"])
        if len(held) >= MAX_ROOM_MEMBERS:
            raise ValueError(f"a room holds at most {MAX_ROOM_MEMBERS} Bots")
        agent = registry.get_agent(wanted)
        if agent.get("verification_state") != "verified":
            raise PermissionError("only a verified Bot may join a room")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO room_members (room_id, agent_id, position) VALUES (?, ?, ?)",
                (room["id"], wanted, len(held)),
            )
        return self.get(room["id"])

    def remove_member(self, room_id: Any, agent_id: Any) -> dict[str, Any]:
        room = self.get(room_id)
        wanted = _bounded_text(agent_id, "Bot identity", 256)
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM room_members WHERE room_id = ? AND agent_id = ?",
                (room["id"], wanted),
            )
            if room["floor"] == wanted:
                connection.execute("UPDATE rooms SET floor = 'owner' WHERE id = ?", (room["id"],))
        return self.get(room["id"])

    def _insert_message(
        self,
        connection: sqlite3.Connection,
        room_id: str,
        text: str,
        *,
        speaker: str,
        kind: str,
        request_id: str = "",
        payload_digest: str = "",
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "room_id": room_id,
            "speaker": speaker,
            "kind": kind,
            "text": _redacted_bounded_text(
                text, "room message", MAX_ROOM_MESSAGE_CHARS
            ),
            "request_id": request_id,
            "payload_digest": payload_digest,
            "at": _now(),
        }
        cursor = connection.execute(
            "INSERT INTO room_messages (room_id, speaker, kind, text, request_id, payload_digest, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            tuple(entry.values()),
        )
        entry["id"] = int(cursor.lastrowid or 0)
        connection.execute(
            """
            DELETE FROM room_messages WHERE room_id = ? AND id NOT IN (
                SELECT id FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?
            )
            """,
            (room_id, room_id, MAX_TRANSCRIPT_STORED),
        )
        entry.pop("payload_digest")
        return entry

    def _post(
        self, room_id: str, text: str, *, speaker: str, kind: str, request_id: str = ""
    ) -> dict[str, Any]:
        with self._connect() as connection:
            return self._insert_message(
                connection,
                room_id,
                text,
                speaker=speaker,
                kind=kind,
                request_id=request_id,
            )

    def post(self, room_id: Any, text: Any, *, request_id: str = "") -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256) if request_id else ""
        raw_body = _bounded_text(text, "room message", MAX_ROOM_MESSAGE_CHARS)
        body = _redacted_bounded_text(raw_body, "room message", MAX_ROOM_MESSAGE_CHARS)
        digest = hashlib.sha256(raw_body.encode()).hexdigest()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if stable:
                row = connection.execute(
                    "SELECT * FROM room_messages WHERE room_id = ? AND request_id = ? AND speaker = 'owner' LIMIT 1",
                    (room["id"], stable),
                ).fetchone()
                if row is not None:
                    stored_digest = str(row["payload_digest"] or "")
                    if (stored_digest and stored_digest != digest) or (
                        not stored_digest and str(row["text"]) != raw_body
                    ):
                        raise ValueError(
                            "request identity was reused for another room message"
                        )
                    result = dict(row)
                    result.pop("payload_digest", None)
                    return result
            live = connection.execute(
                "SELECT floor FROM rooms WHERE id = ?", (room["id"],)
            ).fetchone()
            if live is None:
                raise LookupError("room not found")
            if live["floor"] != "owner":
                raise PermissionError("only the floor holder may post")
            return self._insert_message(
                connection,
                room["id"],
                body,
                speaker="owner",
                kind="message",
                request_id=stable,
                payload_digest=digest,
            )

    def transcript(self, room_id: Any, limit: int = 50) -> list[dict[str, Any]]:
        room = self.get(room_id)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_TRANSCRIPT_READ:
            raise ValueError("transcript limit is invalid")
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM (SELECT * FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
                (room["id"], limit),
            ).fetchall()
        transcript = [dict(row) for row in rows]
        for entry in transcript:
            entry.pop("payload_digest", None)
        return transcript

    def hand_off(
        self, room_id: Any, agent_id: Any, *, actor: str = "owner"
    ) -> dict[str, Any]:
        room = self.get(room_id)
        target = _bounded_text(agent_id, "Bot identity", 256)
        if target != "owner" and target not in room["members"]:
            raise PermissionError("the floor can only pass to a member of this room")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            live = connection.execute(
                "SELECT floor FROM rooms WHERE id = ?", (room["id"],)
            ).fetchone()
            if live is None:
                raise LookupError("room not found")
            if actor != "owner" and live["floor"] != actor:
                raise PermissionError("only the floor holder may hand off")
            connection.execute(
                "UPDATE rooms SET floor = ? WHERE id = ?", (target, room["id"])
            )
            actor_label = "owner" if actor == "owner" else actor
            message = self._insert_message(
                connection,
                room["id"],
                f"{actor_label} handed the floor to {target}",
                speaker="owner",
                kind="handoff",
            )
        return {"room_id": room["id"], "floor": target, "message": message}

    def begin_turn(
        self, room_id: Any, *, request_id: Any, agent_id: Any, message: Any
    ) -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256)
        target = _bounded_text(agent_id, "Bot identity", 256)
        raw_body = _bounded_text(message, "room message", MAX_ROOM_MESSAGE_CHARS)
        body = _redacted_bounded_text(raw_body, "room message", MAX_ROOM_MESSAGE_CHARS)
        if target not in room["members"]:
            raise PermissionError("only a member of this room may take a turn")
        digest = hashlib.sha256(f"{target}\0{raw_body}".encode()).hexdigest()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM room_turns WHERE room_id = ? AND request_id = ?",
                (room["id"], stable),
            ).fetchone()
            if existing is not None:
                if str(existing["payload_digest"]) != digest:
                    raise ValueError(
                        "request identity was reused for another room turn"
                    )
                result = dict(existing)
                result.pop("payload_digest", None)
                result.pop("reply_digest", None)
                result["duplicate"] = True
                return result
            live = connection.execute(
                "SELECT floor FROM rooms WHERE id = ?", (room["id"],)
            ).fetchone()
            if live is None:
                raise LookupError("room not found")
            if live["floor"] != target:
                raise PermissionError("only the floor holder may take a turn")
            connection.execute(
                "INSERT INTO room_turns (room_id, request_id, agent_id, message, payload_digest, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                (room["id"], stable, target, body, digest, _now()),
            )
            self._insert_message(
                connection,
                room["id"],
                body,
                speaker="owner",
                kind="message",
                request_id=stable,
                payload_digest=digest,
            )
        return {
            "room_id": room["id"],
            "request_id": stable,
            "agent_id": target,
            "message": body,
            "reply": "",
            "floor": target,
            "status": "pending",
            "duplicate": False,
        }

    def complete_turn(
        self, room_id: Any, *, request_id: Any, agent_id: Any, reply: Any
    ) -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256)
        target = _bounded_text(agent_id, "Bot identity", 256)
        original_reply = _bounded_text(reply, "room reply", MAX_ROOM_MESSAGE_CHARS)
        raw_reply = _redacted_bounded_text(original_reply, "room reply", MAX_ROOM_MESSAGE_CHARS)
        reply_digest = hashlib.sha256(original_reply.encode()).hexdigest()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM room_turns WHERE room_id = ? AND request_id = ?",
                (room["id"], stable),
            ).fetchone()
            if row is None or str(row["agent_id"]) != target:
                raise ValueError("room turn was not prepared")
            if row["status"] == "committed":
                stored_digest = str(row["reply_digest"] or "")
                if (stored_digest and stored_digest != reply_digest) or (
                    not stored_digest and str(row["reply"]) != original_reply
                ):
                    raise ValueError(
                        "room turn replay does not match its original reply"
                    )
                return {
                    "room_id": room["id"],
                    "request_id": stable,
                    "agent_id": target,
                    "reply": raw_reply,
                    "floor": str(row["floor"]),
                    "status": "committed",
                }
            live = connection.execute(
                "SELECT floor FROM rooms WHERE id = ?", (room["id"],)
            ).fetchone()
            if live is None or live["floor"] != target:
                raise PermissionError("only the floor holder may complete a turn")

            match = _HANDOFF.search(raw_reply)
            wanted = str(match.group("agent")).strip() if match else ""
            visible = "\n".join(
                line
                for line in _HANDOFF_MARKERS.sub("", raw_reply).splitlines()
                if line.strip()
            ).strip()
            if not visible:
                visible = "(no visible reply)"
            self._insert_message(
                connection,
                room["id"],
                visible,
                speaker=target,
                kind="message",
                request_id=stable,
                payload_digest=reply_digest,
            )
            floor = target
            if (
                wanted
                and (wanted == "owner" or wanted in room["members"])
                and wanted != target
            ):
                floor = wanted
                connection.execute(
                    "UPDATE rooms SET floor = ? WHERE id = ?", (floor, room["id"])
                )
                self._insert_message(
                    connection,
                    room["id"],
                    f"{target} handed the floor to {floor}",
                    speaker="owner",
                    kind="handoff",
                )
            connection.execute(
                "UPDATE room_turns SET reply = ?, reply_digest = ?, floor = ?, status = 'committed', committed_at = ? WHERE room_id = ? AND request_id = ? AND status = 'pending'",
                (raw_reply, reply_digest, floor, _now(), room["id"], stable),
            )
        return {
            "room_id": room["id"],
            "request_id": stable,
            "agent_id": target,
            "reply": raw_reply,
            "floor": floor,
            "status": "committed",
        }
