"""Public agent card catalog and cache for connected harness agents."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any
import os

from plugins.harness_agents.policy import fetch_agent_card

_MAX_CACHED_CARDS = 256
_CACHE_TTL_SECONDS = 300


class AgentCardCatalog:
    """Fetch, validate, and cache public A2A Agent Cards."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self._path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._create_schema()

    def _create_schema(self) -> None:
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_cards (
                    url TEXT PRIMARY KEY,
                    card_json TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    fetched_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_agent_cards_expires_at
                    ON agent_cards(expires_at);
                """
            )

    def _fingerprint(self, card: dict[str, Any]) -> str:
        canonical = json.dumps(card, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def get(
        self,
        url: str,
        *,
        allowlist: set[str] | frozenset[str] | None = None,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        """Return a cached or freshly fetched Agent Card."""
        now = time.time()
        if not force_refresh:
            row = self._connection.execute(
                "SELECT card_json FROM agent_cards WHERE url = ? AND expires_at > ?",
                (url, now),
            ).fetchone()
            if row is not None:
                return json.loads(row["card_json"])

        card = fetch_agent_card(url, allowlist=allowlist)
        fingerprint = self._fingerprint(card)
        expires = now + _CACHE_TTL_SECONDS
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO agent_cards (url, card_json, fingerprint, fetched_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                    card_json = excluded.card_json,
                    fingerprint = excluded.fingerprint,
                    fetched_at = excluded.fetched_at,
                    expires_at = excluded.expires_at
                """,
                (url, json.dumps(card), fingerprint, now, expires),
            )
            # Evict oldest expired entries if over limit
            count = self._connection.execute(
                "SELECT COUNT(*) FROM agent_cards"
            ).fetchone()[0]
            if count > _MAX_CACHED_CARDS:
                excess = count - _MAX_CACHED_CARDS
                self._connection.execute(
                    """
                    DELETE FROM agent_cards WHERE url IN (
                        SELECT url FROM agent_cards
                        ORDER BY expires_at ASC, fetched_at ASC
                        LIMIT ?
                    )
                    """,
                    (excess,),
                )
        return card

    def invalidate(self, url: str) -> bool:
        """Remove one cached card. Returns True if it existed."""
        with self._connection:
            cursor = self._connection.execute(
                "DELETE FROM agent_cards WHERE url = ?", (url,)
            )
            return cursor.rowcount > 0

    def list_cached(self) -> list[dict[str, Any]]:
        """List all cached card metadata without full card bodies."""
        rows = self._connection.execute(
            """
            SELECT url, fingerprint, fetched_at, expires_at FROM agent_cards
            ORDER BY fetched_at DESC
            """
        ).fetchall()
        now = time.time()
        return [
            {
                "url": row["url"],
                "fingerprint": row["fingerprint"],
                "fetched_at": row["fetched_at"],
                "expires_at": row["expires_at"],
                "fresh": row["expires_at"] > now,
            }
            for row in rows
        ]

    def close(self) -> None:
        self._connection.close()
