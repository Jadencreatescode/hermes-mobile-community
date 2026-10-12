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
                    at TEXT NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS room_messages_room
                    ON room_messages(room_id, id);
                CREATE TABLE IF NOT EXISTS room_turns (
                    room_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    message TEXT NOT NULL,
                    payload_digest TEXT NOT NULL,
                    reply TEXT NOT NULL DEFAULT '',
                    floor TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
                    created_at TEXT NOT NULL,
                    committed_at TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (room_id, request_id),
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def create(self, name: Any, *, created_by: str) -> dict[str, Any]:
        label = " ".join(_bounded_text(name, "room name", MAX_ROOM_NAME_CHARS).split())
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
        return {**room, "members": [], "member_count": 0}

    def get(self, room_id: Any) -> dict[str, Any]:
        wanted = _bounded_text(room_id, "room id", 64)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM rooms WHERE id = ?", (wanted,)).fetchone()
        if row is None:
            raise LookupError("room not found")
        room = dict(row)
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

    def _post(self, room_id: str, text: str, *, speaker: str, kind: str, request_id: str = "") -> dict[str, Any]:
        entry = {
            "room_id": room_id,
            "speaker": speaker,
            "kind": kind,
            "text": _bounded_text(text, "room message", MAX_ROOM_MESSAGE_CHARS),
            "request_id": request_id,
            "at": _now(),
        }
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO room_messages (room_id, speaker, kind, text, request_id, at) VALUES (?, ?, ?, ?, ?, ?)",
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
        return entry

    def post(self, room_id: Any, text: Any, *, request_id: str = "") -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256) if request_id else ""
        if stable:
            with self._connect() as connection:
                row = connection.execute(
                    "SELECT * FROM room_messages WHERE room_id = ? AND request_id = ? AND speaker = 'owner' LIMIT 1",
                    (room["id"], stable),
                ).fetchone()
            if row is not None:
                if str(row["text"]) != str(text).strip():
                    raise ValueError("request identity was reused for another room message")
                return dict(row)
        return self._post(room["id"], text, speaker="owner", kind="message", request_id=stable)

    def transcript(self, room_id: Any, limit: int = 50) -> list[dict[str, Any]]:
        room = self.get(room_id)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_TRANSCRIPT_READ:
            raise ValueError("transcript limit is invalid")
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM (SELECT * FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
                (room["id"], limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def hand_off(self, room_id: Any, agent_id: Any, *, actor: str = "owner") -> dict[str, Any]:
        room = self.get(room_id)
        target = _bounded_text(agent_id, "Bot identity", 256)
        if target not in room["members"]:
            raise PermissionError("the floor can only pass to a member of this room")
        with self._connect() as connection:
            connection.execute("UPDATE rooms SET floor = ? WHERE id = ?", (target, room["id"]))
        message = self._post(
            room["id"], f"{actor} handed the floor to {target}", speaker="owner", kind="handoff"
        )
        return {"room_id": room["id"], "floor": target, "message": message}

    def begin_turn(self, room_id: Any, *, request_id: Any, agent_id: Any, message: Any) -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256)
        target = _bounded_text(agent_id, "Bot identity", 256)
        body = _bounded_text(message, "room message", MAX_ROOM_MESSAGE_CHARS)
        if target not in room["members"]:
            raise PermissionError("only a member of this room may take a turn")
        digest = hashlib.sha256(f"{target}\0{body}".encode()).hexdigest()
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM room_turns WHERE room_id = ? AND request_id = ?",
                (room["id"], stable),
            ).fetchone()
            if existing is not None:
                if str(existing["payload_digest"]) != digest:
                    raise ValueError("request identity was reused for another room turn")
                result = dict(existing)
                result["duplicate"] = True
                return result
            connection.execute(
                "INSERT INTO room_turns (room_id, request_id, agent_id, message, payload_digest, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                (room["id"], stable, target, body, digest, _now()),
            )
        self._post(room["id"], body, speaker="owner", kind="message", request_id=stable)
        return {
            "room_id": room["id"], "request_id": stable, "agent_id": target,
            "message": body, "reply": "", "floor": room["floor"], "status": "pending",
            "duplicate": False,
        }

    def complete_turn(self, room_id: Any, *, request_id: Any, agent_id: Any, reply: Any) -> dict[str, Any]:
        room = self.get(room_id)
        stable = _bounded_text(request_id, "request id", 256)
        target = _bounded_text(agent_id, "Bot identity", 256)
        raw_reply = _bounded_text(reply, "room reply", MAX_ROOM_MESSAGE_CHARS)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM room_turns WHERE room_id = ? AND request_id = ?",
                (room["id"], stable),
            ).fetchone()
        if row is None or str(row["agent_id"]) != target:
            raise ValueError("room turn was not prepared")
        if row["status"] == "committed":
            if str(row["reply"]) != raw_reply:
                raise ValueError("room turn replay does not match its original reply")
            return {"room_id": room["id"], "request_id": stable, "agent_id": target,
                    "reply": raw_reply, "floor": str(row["floor"]), "status": "committed"}

        match = _HANDOFF.search(raw_reply)
        wanted = str(match.group("agent")).strip() if match else ""
        visible = "\n".join(
            line for line in _HANDOFF_MARKERS.sub("", raw_reply).splitlines() if line.strip()
        ).strip()
        if not visible:
            visible = "(no visible reply)"
        self._post(room["id"], visible, speaker=target, kind="message", request_id=stable)
        floor = room["floor"]
        if wanted and wanted in room["members"] and wanted != target:
            floor = self.hand_off(room["id"], wanted, actor=target)["floor"]
        with self._connect() as connection:
            connection.execute(
                "UPDATE room_turns SET reply = ?, floor = ?, status = 'committed', committed_at = ? WHERE room_id = ? AND request_id = ? AND status = 'pending'",
                (raw_reply, floor, _now(), room["id"], stable),
            )
        return {"room_id": room["id"], "request_id": stable, "agent_id": target,
                "reply": raw_reply, "floor": floor, "status": "committed"}
