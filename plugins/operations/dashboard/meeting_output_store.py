# health: allow FILE_LINES -- retained public production lifecycle is security reviewed; migration preserves its established storage transaction boundary
"""Durable output lifecycle for public production meetings.

The tables here are **additive** to the existing public meeting database. The
output lifecycle and the meeting history share one SQLite file on purpose: the
owner approval transaction has to approve the output and complete the meeting
atomically, and a second database would make that impossible while also
creating a second meeting identifier namespace.

Everything a reviewer or the owner relies on is frozen at the moment it is
decided:

* a production checkpoint freezes the meeting version, producer route, producer
  session, frozen brief, brief hash, and acceptance statement before any
  producer prompt is dispatched;
* an artifact version is immutable — BEFORE UPDATE and BEFORE DELETE triggers
  abort any attempt to change or remove one, including direct SQL;
* a review run freezes the exact artifact version and all three hashes, so a
  later artifact can never inherit an earlier verdict;
* approval compares the meeting version, output version, artifact version, and
  all three hashes, derives the approver from authentication, and writes the
  binding and the completed meeting in one transaction.

Public responses never carry the approver principal digest, a claim token, or a
host path. The authenticated run dispatcher is the only caller that receives an
assigned workspace cwd, and it is never persisted into a meeting record.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import secrets
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

# --------------------------------------------------------------------------
# sibling module loading — same convention plugin_api.py already uses
# --------------------------------------------------------------------------


def _load_sibling(name: str, module_name: str):
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - packaging guard
        raise RuntimeError(f"Operations module could not load: {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


meeting_module = _load_sibling("meeting_store.py", "hermes_operations_meeting_store")
package_module = _load_sibling("deliverable_package.py", "hermes_operations_deliverable_package")
workspace_module = _load_sibling("artifact_workspace.py", "hermes_operations_artifact_workspace")

MeetingVersionConflict = meeting_module.VersionConflict
InvalidMeetingTransition = meeting_module.InvalidMeetingTransition
PackageInvalid = package_module.PackageInvalid
PackageLimitExceeded = package_module.PackageLimitExceeded
WorkspaceClaimInvalid = workspace_module.WorkspaceClaimInvalid
WorkspaceError = workspace_module.WorkspaceError
ArtifactStore = workspace_module.ArtifactStore

OUTPUT_KIND = "deliverable_package_v1"
RUNTIME_VERSION = "1"

OUTPUT_STATES = ("candidate", "reviewing", "changes_requested", "verified", "approved")
RUN_STATES = ("open", "collected", "failed")
REVIEW_VERDICTS = ("verified", "changes_requested")

PROMPT_CLAIM_TTL_SECONDS = 15 * 60
MAX_PROMPT_CLAIM_RENEWALS = 3
MAX_PROMPT_CLAIM_LIFETIME_SECONDS = 2 * 60 * 60

MAX_BRIEF_CHARS = 8_000
MAX_EVIDENCE_REFS = 32
MAX_EVIDENCE_REF_CHARS = 2_048
MAX_FINDINGS = 64
MAX_FINDING_DETAIL_CHARS = 2_000
MAX_LIST_LIMIT = 100
MAX_IDEMPOTENCY_KEY_CHARS = 200
MAX_SESSION_REF_CHARS = 256

FINDING_SEVERITIES = ("low", "medium", "high", "critical")
BLOCKING_SEVERITIES = frozenset({"high", "critical"})

#: Connections whose filesystem the Operations artifact root shares. Cross-host
#: producer artifact transfer is not a public authority yet, so a producer on
#: any other connection (including A2A) is explicitly ineligible rather than
#: simulated.
LOCAL_FILESYSTEM_CONNECTIONS = frozenset({"local"})


class OutputVersionConflict(ValueError):
    """An expected output/artifact version or hash did not match."""


class InvalidOutputTransition(ValueError):
    """The requested output lifecycle transition is not legal."""


class IdempotencyConflict(ValueError):
    """An idempotency key was reused with a different payload."""


class ClaimActive(ValueError):
    """An unexpired prompt claim already owns this dispatch scope."""


class ClaimExpired(ValueError):
    """A replayed dispatch response no longer carries a live lease."""


class ClaimBindingMismatch(ValueError):
    """A claim renewal did not present the identical durable binding."""


class ClaimExhausted(ValueError):
    """The claim exceeded its bounded renewal count or total lifetime."""


class ReviewActive(ValueError):
    """An open review already owns this output."""


class ReviewerNotEligible(PermissionError):
    """The selected reviewer is not an independent reviewer seat."""


class ReviewClaimRequired(PermissionError):
    """No unconsumed review dispatch claim binds this verdict to its reviewer.

    AUTHORITY LIMITATION, stated exactly: Operations REST authenticates the
    installation owner (or an admin), never an individual Bot route, so a
    verdict request cannot *prove* it came from the reviewer seat. What it can
    prove is that this exact review run was dispatched to that seat: the
    durable ``review.prompt`` claim is minted only by the authenticated review
    claim route, is bound to the reviewer route recorded on the review run, and
    is consumed by the verdict. A caller with mutation authority therefore
    cannot verdict a review nobody dispatched, cannot verdict one dispatched to
    a different route, and cannot replay a consumed dispatch. It can still
    record the verdict for a review it legitimately dispatched -- no reviewer
    identity is fabricated to pretend otherwise.
    """


class ProducerNotEligible(PermissionError):
    """The producer route cannot reach the Operations artifact filesystem."""


class ProducerSessionMismatch(PermissionError):
    """The dispatch session does not match the session frozen with this run."""


class CollectionFailed(ValueError):
    """Workspace collection failed a mandatory filesystem or manifest check."""


class DeterministicCheckFailed(ValueError):
    """A mandatory deterministic package check failed."""


class ArtifactUnavailable(ValueError):
    """Stored package bytes are missing or do not match their digest."""


class OutputNotFound(KeyError):
    """No accessible output, version, or run with that identifier."""


_SCHEMA = """
CREATE TABLE IF NOT EXISTS meeting_production_briefs (
    meeting_id TEXT NOT NULL,
    meeting_version INTEGER NOT NULL,
    brief TEXT NOT NULL,
    brief_hash TEXT NOT NULL,
    acceptance_statement TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(meeting_id, meeting_version)
);

CREATE TABLE IF NOT EXISTS meeting_outputs (
    output_id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    product_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    brief TEXT NOT NULL,
    brief_hash TEXT NOT NULL,
    producer_connection TEXT NOT NULL,
    producer_profile TEXT NOT NULL,
    producer_session_id TEXT NOT NULL,
    source_meeting_version INTEGER NOT NULL,
    current_artifact_version INTEGER NOT NULL DEFAULT 0,
    verified_artifact_version INTEGER NOT NULL DEFAULT 0,
    approved_artifact_version INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    submission_id TEXT NOT NULL,
    findings_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_outputs_submission
ON meeting_outputs(submission_id);
CREATE INDEX IF NOT EXISTS meeting_outputs_meeting
ON meeting_outputs(meeting_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_output_versions (
    output_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL CHECK(artifact_version > 0),
    schema_version INTEGER NOT NULL,
    runtime_version TEXT NOT NULL,
    game_sha256 TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    blob_digest TEXT NOT NULL,
    zip_sha256 TEXT NOT NULL,
    total_byte_size INTEGER NOT NULL,
    producer_run_id TEXT NOT NULL,
    parent_artifact_version INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(output_id, artifact_version)
);
CREATE TRIGGER IF NOT EXISTS meeting_output_versions_no_update
BEFORE UPDATE ON meeting_output_versions
BEGIN SELECT RAISE(ABORT, 'meeting output versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS meeting_output_versions_no_delete
BEFORE DELETE ON meeting_output_versions
BEGIN SELECT RAISE(ABORT, 'meeting output versions are immutable'); END;

CREATE TABLE IF NOT EXISTS meeting_output_runs (
    run_id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    workspace_device INTEGER NOT NULL,
    workspace_inode INTEGER NOT NULL,
    output_device INTEGER NOT NULL,
    output_inode INTEGER NOT NULL,
    claim_token_hash TEXT NOT NULL,
    claim_consumed INTEGER NOT NULL DEFAULT 0,
    parent_artifact_version INTEGER,
    artifact_version INTEGER,
    receipt_json TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_output_runs_active
ON meeting_output_runs(output_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS meeting_output_runs_output
ON meeting_output_runs(output_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_output_production_checkpoints (
    run_id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    meeting_version INTEGER NOT NULL,
    producer_connection TEXT NOT NULL,
    producer_profile TEXT NOT NULL,
    producer_session_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    brief_hash TEXT NOT NULL,
    acceptance_statement TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- One run's producer session binding. A run is created before its producer
-- session can exist (the session needs the cwd the run mints), so the run
-- freezes a bounded provisional reference and the first claim binds the actual
-- durable session id exactly once.
CREATE TABLE IF NOT EXISTS meeting_output_run_sessions (
    run_id TEXT PRIMARY KEY,
    provisional_session_id TEXT NOT NULL,
    actual_session_id TEXT NOT NULL DEFAULT '',
    bound_at INTEGER
);

CREATE TABLE IF NOT EXISTS meeting_output_revision_runs (
    run_id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL,
    parent_artifact_version INTEGER NOT NULL,
    parent_game_sha256 TEXT NOT NULL,
    parent_manifest_sha256 TEXT NOT NULL,
    parent_zip_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_output_review_runs (
    request_id TEXT PRIMARY KEY,
    output_id TEXT NOT NULL,
    output_version INTEGER NOT NULL,
    artifact_version INTEGER NOT NULL,
    reviewer_connection TEXT NOT NULL,
    reviewer_profile TEXT NOT NULL,
    brief_hash TEXT NOT NULL,
    game_sha256 TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    zip_sha256 TEXT NOT NULL,
    state TEXT NOT NULL,
    verdict TEXT NOT NULL DEFAULT '',
    findings_json TEXT NOT NULL DEFAULT '[]',
    checks_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_output_review_active
ON meeting_output_review_runs(output_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS meeting_output_review_history
ON meeting_output_review_runs(output_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_output_prompt_claims (
    claim_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    route_connection TEXT NOT NULL,
    route_profile TEXT NOT NULL,
    session_id TEXT NOT NULL,
    meeting_version INTEGER NOT NULL,
    output_version INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    renewals INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_output_claims_scope
ON meeting_output_prompt_claims(operation, scope);

CREATE TABLE IF NOT EXISTS meeting_output_idempotency (
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(action, idempotency_key)
);

CREATE TABLE IF NOT EXISTS meeting_output_blobs (
    digest TEXT PRIMARY KEY,
    byte_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_output_approvals (
    output_id TEXT PRIMARY KEY,
    artifact_version INTEGER NOT NULL,
    approver_digest TEXT NOT NULL,
    approved_at INTEGER NOT NULL
);

-- Protected: the single-use collection claim for one run. It survives a
-- restart so the authenticated dispatcher can re-present it after a reload,
-- and it is never read into a public DTO, an audit event, or an error body.
CREATE TABLE IF NOT EXISTS meeting_output_run_secrets (
    run_id TEXT PRIMARY KEY,
    claim_token TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _bounded(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise ValueError(f"{field} is invalid")
    return value


def _route(value: object, field: str) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} must be an object")
    connection = value.get("connection", value.get("connectionId"))
    return {
        "connection": _bounded(connection, f"{field}.connection", 128),
        "profile": _bounded(value.get("profile"), f"{field}.profile", 128),
    }


def _route_key(value: Mapping[str, str]) -> tuple[str, str]:
    return value["connection"], value["profile"]


def _evidence_refs(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)) or len(value) > MAX_EVIDENCE_REFS:
        raise ValueError("evidence_refs must be a bounded array")
    return [_bounded(item, f"evidence_refs[{index}]", MAX_EVIDENCE_REF_CHARS)
            for index, item in enumerate(value)]


def _findings(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)) or len(value) > MAX_FINDINGS:
        raise ValueError("findings must be a bounded array")
    normalized = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping) or not set(item).issubset(
            {"severity", "code", "detail", "path"}
        ):
            raise ValueError(f"findings[{index}] fields are invalid")
        severity = item.get("severity")
        if severity not in FINDING_SEVERITIES:
            raise ValueError(f"findings[{index}].severity is invalid")
        finding = {
            "severity": severity,
            "code": _bounded(item.get("code"), f"findings[{index}].code", 64),
            "detail": _bounded(item.get("detail"), f"findings[{index}].detail", MAX_FINDING_DETAIL_CHARS),
        }
        if item.get("path") is not None:
            finding["path"] = package_module.safe_package_path(item["path"])
        normalized.append(finding)
    return normalized


def canonical_request_hash(payload: object) -> str:
    """Stable hash of a request body for idempotency comparison."""
    return _sha256_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    )


def _opaque_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(16)}"


class MeetingOutputStore:
    """Additive output lifecycle over the existing public meeting database."""

    def __init__(
        self,
        db_path: Path | str,
        artifact_root: Path | str,
        *,
        clock: Callable[[], float] = time.time,
        local_connections: Iterable[str] = LOCAL_FILESYSTEM_CONNECTIONS,
    ):
        self.db_path = Path(db_path)
        self.clock = clock
        self.local_connections = frozenset(local_connections)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.artifacts = ArtifactStore(artifact_root)
        own = self._connect()
        try:
            own.executescript(_SCHEMA)
            columns = {
                row["name"] for row in own.execute("PRAGMA table_info(meeting_output_runs)")
            }
            for name in (
                "workspace_device", "workspace_inode", "output_device", "output_inode"
            ):
                if name not in columns:
                    # Pre-release databases may contain open runs created before
                    # exact directory identity was persisted. Keep those values
                    # NULL so cwd recovery fails closed rather than blessing
                    # whatever directory happens to occupy the pathname now.
                    own.execute(f"ALTER TABLE meeting_output_runs ADD COLUMN {name} INTEGER")
            own.commit()
        finally:
            own.close()

    # -- plumbing ----------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        # Write-ahead logging so a reader is never blocked by the single
        # IMMEDIATE writer that owns a lifecycle transaction.
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    @contextlib.contextmanager
    def _transaction(self, connection: sqlite3.Connection | None = None):
        """Own one ``BEGIN IMMEDIATE`` transaction, or join the caller's.

        Every lifecycle mutation runs inside exactly one of these. Passing a
        caller-owned connection lets the idempotency reservation, the domain
        mutation, and the stored response commit or roll back together.
        """
        if connection is not None:
            yield connection

            return
        own = self._connect()
        try:
            own.execute("BEGIN IMMEDIATE")
            yield own
            own.commit()
        except BaseException:
            own.rollback()
            raise
        finally:
            own.close()

    @contextlib.contextmanager
    def _reader(self, connection: sqlite3.Connection | None = None):
        """Read on the caller's connection when there is one.

        A read issued on a second connection could not see the caller's
        uncommitted writes, so every read inside a lifecycle transaction must
        join it.
        """
        if connection is not None:
            yield connection

            return
        own = self._connect()
        try:
            yield own
        finally:
            own.close()

    def _now(self) -> int:
        return int(self.clock())

    @staticmethod
    def _output_row(row: sqlite3.Row) -> dict[str, Any]:
        """Public output DTO. Never includes a host path or a principal."""
        return {
            "output_id": row["output_id"],
            "meeting_id": row["meeting_id"],
            "kind": row["kind"],
            "product_kind": row["product_kind"],
            "title": row["title"],
            "summary": row["summary"],
            "brief": row["brief"],
            "brief_hash": row["brief_hash"],
            "producer": {"connection": row["producer_connection"], "profile": row["producer_profile"]},
            "source_meeting_version": int(row["source_meeting_version"]),
            "current_artifact_version": int(row["current_artifact_version"]),
            "verified_artifact_version": int(row["verified_artifact_version"]),
            "approved_artifact_version": int(row["approved_artifact_version"]),
            "state": row["state"],
            "version": int(row["version"]),
            "findings": json.loads(row["findings_json"]),
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
        }

    @staticmethod
    def _version_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "output_id": row["output_id"],
            "artifact_version": int(row["artifact_version"]),
            "schema_version": int(row["schema_version"]),
            "runtime_version": row["runtime_version"],
            "game_sha256": row["game_sha256"],
            "manifest_sha256": row["manifest_sha256"],
            "zip_sha256": row["zip_sha256"],
            "total_byte_size": int(row["total_byte_size"]),
            "manifest": json.loads(row["manifest_json"]),
            "parent_artifact_version": (
                None if row["parent_artifact_version"] is None else int(row["parent_artifact_version"])
            ),
            "created_at": int(row["created_at"]),
        }

    def _require_output(self, connection: sqlite3.Connection, output_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM meeting_outputs WHERE output_id = ?", (output_id,)
        ).fetchone()
        if row is None:
            raise OutputNotFound(output_id)
        return row

    # -- brief freeze ------------------------------------------------------

    def freeze_production_brief(
        self,
        meeting_id: str,
        *,
        expected_meeting_version: int,
        brief: str,
        evidence_refs: Iterable[str] = (),
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Durably freeze the orchestrator brief and reach production_ready."""
        brief_text = _bounded(brief, "brief", MAX_BRIEF_CHARS)
        references = _evidence_refs(list(evidence_refs))
        now = self._now()
        with self._transaction(connection) as connection:
            meeting, _version = meeting_module.load_production_meeting(
                connection, meeting_id, expected_meeting_version
            )
            stage = meeting["production_stage"]
            if stage not in {"briefing", "working"}:
                raise InvalidMeetingTransition(
                    "the brief can be frozen only while briefing or working"
                )
            version = expected_meeting_version
            if stage == "briefing":
                _meeting, version = meeting_module.advance_stage_in_transaction(
                    connection, meeting_id, "working", expected_version=version, now=now
                )
            meeting, version = meeting_module.advance_stage_in_transaction(
                connection, meeting_id, "production_ready", expected_version=version, now=now
            )
            connection.execute(
                "INSERT OR REPLACE INTO meeting_production_briefs"
                " (meeting_id, meeting_version, brief, brief_hash, acceptance_statement,"
                "  evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    meeting_id,
                    version,
                    brief_text,
                    _sha256_text(brief_text),
                    meeting["acceptance_statement"],
                    json.dumps(references, ensure_ascii=False, separators=(",", ":")),
                    now,
                ),
            )
        return {
            "meeting_id": meeting_id,
            "meeting_version": version,
            "meeting": meeting,
            "brief": brief_text,
            "brief_hash": _sha256_text(brief_text),
            "acceptance_statement": meeting["acceptance_statement"],
            "evidence_refs": references,
        }

    def get_production_brief(self, meeting_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_production_briefs WHERE meeting_id = ?"
                " ORDER BY meeting_version DESC LIMIT 1",
                (meeting_id,),
            ).fetchone()
        if row is None:
            raise OutputNotFound(meeting_id)
        return {
            "meeting_id": row["meeting_id"],
            "meeting_version": int(row["meeting_version"]),
            "brief": row["brief"],
            "brief_hash": row["brief_hash"],
            "acceptance_statement": row["acceptance_statement"],
            "evidence_refs": json.loads(row["evidence_json"]),
        }

    # -- production runs ---------------------------------------------------

    def begin_production_run(
        self,
        *,
        meeting_id: str,
        expected_meeting_version: int,
        producer_session_id: str,
        submission_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Create the output, checkpoint it, and mint the server-owned cwd."""
        session_ref = _bounded(producer_session_id, "producer_session_id", MAX_SESSION_REF_CHARS)
        submission = _bounded(submission_id, "submission_id", 128)
        now = self._now()
        with self._transaction(connection) as connection:
            meeting, _current = meeting_module.load_production_meeting(
                connection, meeting_id, expected_meeting_version
            )
            if meeting["production_stage"] != "production_ready":
                raise InvalidMeetingTransition(
                    "starting production requires the production_ready stage"
                )
            producer = meeting["producer"]
            if producer["connection"] not in self.local_connections:
                raise ProducerNotEligible(
                    "this producer connection does not share the Operations artifact filesystem"
                )
            brief_row = connection.execute(
                "SELECT * FROM meeting_production_briefs WHERE meeting_id = ?"
                " ORDER BY meeting_version DESC LIMIT 1",
                (meeting_id,),
            ).fetchone()
            if brief_row is None:
                raise InvalidOutputTransition("the production brief is not frozen yet")

            existing = connection.execute(
                "SELECT * FROM meeting_outputs WHERE submission_id = ?", (submission,)
            ).fetchone()
            if existing is not None:
                raise InvalidOutputTransition("this submission already created an output")

            output_id = _opaque_id("mout")
            run_id = _opaque_id("mrun")
            minted = self.artifacts.mint_workspace(run_id)
            connection.execute(
                "INSERT INTO meeting_outputs (output_id, meeting_id, kind, product_kind, title,"
                " summary, brief, brief_hash, producer_connection, producer_profile,"
                " producer_session_id, source_meeting_version, state, version, submission_id,"
                " findings_json, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, '[]', ?, ?)",
                (
                    output_id, meeting_id, OUTPUT_KIND, meeting["product_kind"],
                    meeting["output_title"], meeting["acceptance_statement"],
                    brief_row["brief"], brief_row["brief_hash"],
                    producer["connection"], producer["profile"], session_ref,
                    expected_meeting_version, submission, now, now,
                ),
            )
            connection.execute(
                "INSERT INTO meeting_output_runs (run_id, output_id, meeting_id, kind, state,"
                " workspace_root, workspace_device, workspace_inode, output_device, output_inode,"
                " claim_token_hash, parent_artifact_version, created_at, updated_at)"
                " VALUES (?, ?, ?, 'production', 'open', ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                (run_id, output_id, meeting_id, minted.relative_root,
                 minted.workspace_device, minted.workspace_inode,
                 minted.output_device, minted.output_inode,
                 minted.claim_token_hash, now, now),
            )
            connection.execute(
                "INSERT INTO meeting_output_run_secrets (run_id, claim_token, created_at)"
                " VALUES (?, ?, ?)",
                (run_id, minted.claim_token, now),
            )
            connection.execute(
                "INSERT INTO meeting_output_run_sessions (run_id, provisional_session_id)"
                " VALUES (?, ?)",
                (run_id, session_ref),
            )
            connection.execute(
                "INSERT INTO meeting_output_production_checkpoints (run_id, output_id, meeting_id,"
                " meeting_version, producer_connection, producer_profile, producer_session_id,"
                " brief, brief_hash, acceptance_statement, evidence_json, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id, output_id, meeting_id, expected_meeting_version,
                    producer["connection"], producer["profile"], session_ref,
                    brief_row["brief"], brief_row["brief_hash"],
                    brief_row["acceptance_statement"], brief_row["evidence_json"], now,
                ),
            )
            _meeting, meeting_version = meeting_module.advance_stage_in_transaction(
                connection, meeting_id, "producing",
                expected_version=expected_meeting_version, now=now,
            )
        return {
            "run_id": run_id,
            "output_id": output_id,
            "kind": "production",
            "meeting_id": meeting_id,
            "meeting_version": meeting_version,
            "parent_artifact_version": None,
            # cwd and claim_token go ONLY to the authenticated dispatcher.
            "cwd": str(self.artifacts.verified_workspace_path(
                run_id,
                workspace_identity=(minted.workspace_device, minted.workspace_inode),
                output_identity=(minted.output_device, minted.output_inode),
            )),
            "workspace_identity": {
                "device": str(minted.workspace_device),
                "inode": str(minted.workspace_inode),
                "output_device": str(minted.output_device),
                "output_inode": str(minted.output_inode),
            },
            "claim_token": minted.claim_token,
        }

    def get_production_checkpoint(self, run_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_production_checkpoints WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(run_id)
        return {
            "run_id": row["run_id"],
            "output_id": row["output_id"],
            "meeting_id": row["meeting_id"],
            "meeting_version": int(row["meeting_version"]),
            "producer": {
                "connection": row["producer_connection"],
                "profile": row["producer_profile"],
            },
            "producer_session_id": row["producer_session_id"],
            "brief": row["brief"],
            "brief_hash": row["brief_hash"],
            "acceptance_statement": row["acceptance_statement"],
            "evidence_refs": json.loads(row["evidence_json"]),
        }

    def begin_revision_run(
        self,
        output_id: str,
        *,
        expected_output_version: int,
        producer_session_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Open a revision run bound to the rejected parent artifact version."""
        session_ref = _bounded(producer_session_id, "producer_session_id", MAX_SESSION_REF_CHARS)
        now = self._now()
        with self._transaction(connection) as connection:
            output = self._require_output(connection, output_id)
            if int(output["version"]) != expected_output_version:
                raise OutputVersionConflict("output version conflict")
            if output["state"] != "changes_requested":
                raise InvalidOutputTransition(
                    "only an output with requested changes can be revised"
                )
            parent = int(output["current_artifact_version"])
            parent_row = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ? AND artifact_version = ?",
                (output_id, parent),
            ).fetchone()
            if parent_row is None:
                raise InvalidOutputTransition("the parent artifact version is missing")

            run_id = _opaque_id("mrun")
            minted = self.artifacts.mint_workspace(run_id)
            connection.execute(
                "INSERT INTO meeting_output_runs (run_id, output_id, meeting_id, kind, state,"
                " workspace_root, workspace_device, workspace_inode, output_device, output_inode,"
                " claim_token_hash, parent_artifact_version, created_at, updated_at)"
                " VALUES (?, ?, ?, 'revision', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, output_id, output["meeting_id"], minted.relative_root,
                 minted.workspace_device, minted.workspace_inode,
                 minted.output_device, minted.output_inode,
                 minted.claim_token_hash, parent, now, now),
            )
            connection.execute(
                "INSERT INTO meeting_output_run_secrets (run_id, claim_token, created_at)"
                " VALUES (?, ?, ?)",
                (run_id, minted.claim_token, now),
            )
            connection.execute(
                "INSERT INTO meeting_output_run_sessions (run_id, provisional_session_id)"
                " VALUES (?, ?)",
                (run_id, session_ref),
            )
            connection.execute(
                "INSERT INTO meeting_output_revision_runs (run_id, output_id,"
                " parent_artifact_version, parent_game_sha256, parent_manifest_sha256,"
                " parent_zip_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, output_id, parent, parent_row["game_sha256"],
                 parent_row["manifest_sha256"], parent_row["zip_sha256"], now),
            )
            connection.execute(
                "UPDATE meeting_outputs SET producer_session_id = ?, version = version + 1,"
                " updated_at = ? WHERE output_id = ?",
                (session_ref, now, output_id),
            )
            _meeting, meeting_version = meeting_module.advance_stage_in_transaction(
                connection, output["meeting_id"], "producing", expected_version=None, now=now,
            )
        return {
            "run_id": run_id,
            "output_id": output_id,
            "kind": "revision",
            "meeting_id": output["meeting_id"],
            "meeting_version": meeting_version,
            "parent_artifact_version": parent,
            "cwd": str(self.artifacts.verified_workspace_path(
                run_id,
                workspace_identity=(minted.workspace_device, minted.workspace_inode),
                output_identity=(minted.output_device, minted.output_inode),
            )),
            "workspace_identity": {
                "device": str(minted.workspace_device),
                "inode": str(minted.workspace_inode),
                "output_device": str(minted.output_device),
                "output_inode": str(minted.output_inode),
            },
            "claim_token": minted.claim_token,
        }

    def collect_run(self, run_id: str, *, claim_token: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        """Collect a run's workspace into an immutable artifact version.

        Replaying a consumed claim returns the original receipt byte-for-byte
        rather than rebuilding, so a crash between fsync and commit cannot
        duplicate an artifact version.

        The claim check, the package build, and every row this writes live in
        ONE ``BEGIN IMMEDIATE`` transaction, so two concurrent collections of
        the same run cannot both mint an artifact version: the second waits,
        then replays the first one's receipt. Write-ahead logging keeps
        readers unblocked while a large package is built.
        """
        token_hash = workspace_module.hash_claim_token(claim_token)
        now = self._now()
        with self._transaction(connection) as connection:
            run = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise OutputNotFound(run_id)
            if not secrets.compare_digest(str(run["claim_token_hash"]), token_hash):
                raise WorkspaceClaimInvalid("the collection claim does not match this run")
            if run["state"] == "collected":
                return json.loads(run["receipt_json"])
            if run["state"] != "open":
                raise InvalidOutputTransition("this run is not collectable")

            try:
                collected = self.artifacts.collect_workspace(
                    run_id,
                    workspace_identity=(int(run["workspace_device"]), int(run["workspace_inode"])),
                    output_identity=(int(run["output_device"]), int(run["output_inode"])),
                )
            except (PackageInvalid, WorkspaceError) as exc:
                raise CollectionFailed(str(exc)) from exc

            output = self._require_output(connection, run["output_id"])
            next_version = int(output["current_artifact_version"]) + 1
            parent = run["parent_artifact_version"]
            connection.execute(
                "INSERT INTO meeting_output_versions (output_id, artifact_version, schema_version,"
                " runtime_version, game_sha256, manifest_json, manifest_sha256, blob_digest,"
                " zip_sha256, total_byte_size, producer_run_id, parent_artifact_version, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    output["output_id"], next_version, collected.schema_version, RUNTIME_VERSION,
                    collected.game_sha256,
                    json.dumps(collected.manifest, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")),
                    collected.manifest_sha256, collected.blob_digest, collected.zip_sha256,
                    collected.total_byte_size, run_id, parent, now,
                ),
            )
            connection.execute(
                "INSERT OR IGNORE INTO meeting_output_blobs (digest, byte_size, created_at)"
                " VALUES (?, ?, ?)",
                (collected.blob_digest, len(collected.zip_bytes), now),
            )
            receipt = {
                "run_id": run_id,
                "output_id": output["output_id"],
                "artifact_version": next_version,
                "parent_artifact_version": None if parent is None else int(parent),
                "schema_version": collected.schema_version,
                "game_sha256": collected.game_sha256,
                "manifest_sha256": collected.manifest_sha256,
                "zip_sha256": collected.zip_sha256,
                "total_byte_size": collected.total_byte_size,
                "collected_at": now,
            }
            connection.execute(
                "UPDATE meeting_output_runs SET state = 'collected', claim_consumed = 1,"
                " artifact_version = ?, receipt_json = ?, updated_at = ? WHERE run_id = ?",
                (next_version, json.dumps(receipt, ensure_ascii=False, sort_keys=True,
                                          separators=(",", ":")), now, run_id),
            )
            # Collecting a revision clears the verified pointer: the new
            # artifact version requires its own independent review.
            connection.execute(
                "UPDATE meeting_outputs SET state = 'reviewing', current_artifact_version = ?,"
                " verified_artifact_version = 0, findings_json = '[]', version = version + 1,"
                " updated_at = ? WHERE output_id = ?",
                (next_version, now, output["output_id"]),
            )
            connection.execute(
                "UPDATE meeting_output_prompt_claims SET consumed = 1 WHERE scope = ?", (run_id,)
            )
            meeting_module.advance_stage_in_transaction(
                connection, run["meeting_id"], "reviewing", expected_version=None, now=now,
            )
        return receipt

    # -- prompt claims -----------------------------------------------------

    def acquire_prompt_claim(
        self,
        *,
        operation: str,
        scope: str,
        request_id: str,
        route: Mapping[str, str],
        session_id: str,
        meeting_version: int,
        output_version: int,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Claim one dispatch scope before calling prompt.submit."""
        operation = _bounded(operation, "operation", 64)
        scope = _bounded(scope, "scope", 128)
        request_id = _bounded(request_id, "request_id", 128)
        session = _bounded(session_id, "session_id", MAX_SESSION_REF_CHARS)
        bound_route = _route(route, "route")
        now = self._now()
        with self._transaction(connection) as connection:
            existing = connection.execute(
                "SELECT * FROM meeting_output_prompt_claims WHERE operation = ? AND scope = ?",
                (operation, scope),
            ).fetchone()
            if existing is not None and not int(existing["consumed"]):
                identical = (
                    existing["request_id"] == request_id
                    and existing["route_connection"] == bound_route["connection"]
                    and existing["route_profile"] == bound_route["profile"]
                    and existing["session_id"] == session
                    and int(existing["meeting_version"]) == int(meeting_version)
                    and int(existing["output_version"]) == int(output_version)
                )
                if int(existing["expires_at"]) > now:
                    if not identical:
                        raise ClaimBindingMismatch(
                            "another dispatch binding already owns this claim scope"
                        )
                    raise ClaimActive("an unexpired claim already owns this dispatch scope")
                if not identical:
                    raise ClaimBindingMismatch(
                        "an expired claim may be renewed only by the identical binding"
                    )
                renewals = int(existing["renewals"]) + 1
                lifetime = now - int(existing["created_at"])
                if renewals > MAX_PROMPT_CLAIM_RENEWALS or lifetime > MAX_PROMPT_CLAIM_LIFETIME_SECONDS:
                    raise ClaimExhausted("this claim exceeded its bounded renewals or lifetime")
                connection.execute(
                    "UPDATE meeting_output_prompt_claims SET renewals = ?, expires_at = ?"
                    " WHERE claim_id = ?",
                    (renewals, now + PROMPT_CLAIM_TTL_SECONDS, existing["claim_id"]),
                )
                return {
                    "claim_id": existing["claim_id"],
                    "operation": operation,
                    "scope": scope,
                    "renewals": renewals,
                    "expires_at": now + PROMPT_CLAIM_TTL_SECONDS,
                }

            claim_id = _opaque_id("mclaim")
            token = secrets.token_urlsafe(32)
            connection.execute(
                "INSERT OR REPLACE INTO meeting_output_prompt_claims (claim_id, operation, scope,"
                " request_id, route_connection, route_profile, session_id, meeting_version,"
                " output_version, token_hash, expires_at, renewals, consumed, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
                (
                    claim_id, operation, scope, request_id, bound_route["connection"],
                    bound_route["profile"], session, int(meeting_version), int(output_version),
                    workspace_module.hash_claim_token(token), now + PROMPT_CLAIM_TTL_SECONDS, now,
                ),
            )
        return {
            "claim_id": claim_id,
            "operation": operation,
            "scope": scope,
            "renewals": 0,
            "expires_at": now + PROMPT_CLAIM_TTL_SECONDS,
        }

    # -- review ------------------------------------------------------------

    def _deterministic_checks(
        self, output_row: sqlite3.Row, version_row: sqlite3.Row
    ) -> dict[str, Any]:
        """Run every mandatory package check plus frozen-brief identity."""
        try:
            payload = self.artifacts.get_blob(version_row["blob_digest"])
        except WorkspaceError as exc:
            return {
                "ok": False,
                "checks": {"package_available": False},
                "failed_checks": ["package_available"],
                "detail": [str(exc)],
            }
        result = package_module.verify_package_bytes(
            payload,
            manifest_sha256=version_row["manifest_sha256"],
            game_sha256=version_row["game_sha256"],
            zip_sha256=version_row["zip_sha256"],
        )
        checks = dict(result["checks"])
        checks["package_available"] = True
        checks["frozen_brief_identity"] = (
            output_row["brief_hash"] == _sha256_text(output_row["brief"])
        )
        failed = sorted(name for name, passed in checks.items() if not passed)
        return {
            "ok": not failed,
            "checks": checks,
            "failed_checks": failed,
            "detail": result["detail"],
        }

    def artifact_summary(
        self,
        output_id: str,
        artifact_version: int,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Read-only, server-prepared summary for an independent reviewer."""
        version = self.get_version(output_id, artifact_version, connection=connection)
        return {
            "output_id": output_id,
            "artifact_version": version["artifact_version"],
            "product_kind": version["manifest"]["product_kind"],
            "title": version["manifest"]["title"],
            "summary": version["manifest"]["summary"],
            "primary_file": version["manifest"]["primary_file"],
            "game_sha256": version["game_sha256"],
            "manifest_sha256": version["manifest_sha256"],
            "zip_sha256": version["zip_sha256"],
            "total_byte_size": version["total_byte_size"],
            "files": [
                {
                    "path": row["path"],
                    "media_type": row["media_type"],
                    "role": row["role"],
                    "preview_policy": row["preview_policy"],
                    "byte_size": row["byte_size"],
                    "sha256": row["sha256"],
                }
                for row in version["manifest"]["files"]
            ],
        }

    def begin_review_run(
        self,
        output_id: str,
        *,
        reviewer: Mapping[str, str],
        expected_output_version: int,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Open an independent review bound to exactly one artifact version."""
        reviewer_route = _route(reviewer, "reviewer")
        now = self._now()
        with self._transaction(connection) as connection:
            output = self._require_output(connection, output_id)
            if int(output["version"]) != expected_output_version:
                raise OutputVersionConflict("output version conflict")
            if output["state"] != "reviewing":
                raise InvalidOutputTransition("this output is not awaiting review")
            meeting, _version = meeting_module.load_production_meeting(
                connection, output["meeting_id"], None
            )
            seat = next(
                (
                    row for row in meeting["seats"]
                    if row["role"] == "reviewer" and _route_key(row["bot"]) == _route_key(reviewer_route)
                ),
                None,
            )
            if seat is None:
                raise ReviewerNotEligible("the selected reviewer does not occupy a reviewer seat")
            if _route_key(reviewer_route) in {
                _route_key(meeting["orchestrator"]), _route_key(meeting["producer"])
            }:
                raise ReviewerNotEligible(
                    "a reviewer must differ from both the orchestrator and the producer"
                )
            if connection.execute(
                "SELECT 1 FROM meeting_output_review_runs WHERE output_id = ? AND state = 'open'",
                (output_id,),
            ).fetchone() is not None:
                raise ReviewActive("an open review already owns this output")

            artifact_version = int(output["current_artifact_version"])
            version_row = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ? AND artifact_version = ?",
                (output_id, artifact_version),
            ).fetchone()
            if version_row is None:
                raise InvalidOutputTransition("there is no collected artifact version to review")
            checks = self._deterministic_checks(output, version_row)
            request_id = _opaque_id("mrev")
            connection.execute(
                "INSERT INTO meeting_output_review_runs (request_id, output_id, output_version,"
                " artifact_version, reviewer_connection, reviewer_profile, brief_hash, game_sha256,"
                " manifest_sha256, zip_sha256, state, checks_json, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
                (
                    request_id, output_id, int(output["version"]), artifact_version,
                    reviewer_route["connection"], reviewer_route["profile"],
                    output["brief_hash"], version_row["game_sha256"],
                    version_row["manifest_sha256"], version_row["zip_sha256"],
                    json.dumps(checks, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                    now,
                ),
            )
        return {
            "request_id": request_id,
            "output_id": output_id,
            "output_version": int(output["version"]),
            "artifact_version": artifact_version,
            "reviewer": reviewer_route,
            "brief_hash": output["brief_hash"],
            "brief": output["brief"],
            "acceptance_statement": output["summary"],
            "game_sha256": version_row["game_sha256"],
            "manifest_sha256": version_row["manifest_sha256"],
            "zip_sha256": version_row["zip_sha256"],
            "checks": checks,
            "artifact_summary": self.artifact_summary(output_id, artifact_version),
        }

    def complete_review_run(
        self,
        request_id: str,
        *,
        verdict: str,
        findings: Iterable[Mapping[str, Any]] = (),
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Record a verdict against the exact artifact version it reviewed."""
        if verdict not in REVIEW_VERDICTS:
            raise ValueError("verdict is invalid")
        structured = _findings(list(findings))
        now = self._now()
        with self._transaction(connection) as connection:
            review = connection.execute(
                "SELECT * FROM meeting_output_review_runs WHERE request_id = ?", (request_id,)
            ).fetchone()
            if review is None:
                raise OutputNotFound(request_id)
            if review["state"] != "open":
                raise InvalidOutputTransition("this review is already completed")
            output = self._require_output(connection, review["output_id"])
            if int(output["current_artifact_version"]) != int(review["artifact_version"]):
                raise InvalidOutputTransition(
                    "this review is bound to an older artifact version"
                )
            version_row = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ? AND artifact_version = ?",
                (review["output_id"], int(review["artifact_version"])),
            ).fetchone()
            for field in ("game_sha256", "manifest_sha256", "zip_sha256"):
                if version_row[field] != review[field]:
                    raise InvalidOutputTransition(
                        "the reviewed artifact hashes no longer match the stored version"
                    )

            # The verdict belongs to the dispatched reviewer seat, not to the
            # authenticated caller. See ReviewClaimRequired for the exact
            # authority limitation this enforces.
            claim = connection.execute(
                "SELECT * FROM meeting_output_prompt_claims"
                " WHERE operation = 'review.prompt' AND scope = ?",
                (request_id,),
            ).fetchone()
            if (
                claim is None
                or int(claim["consumed"])
                or claim["route_connection"] != review["reviewer_connection"]
                or claim["route_profile"] != review["reviewer_profile"]
            ):
                raise ReviewClaimRequired(
                    "this verdict needs the review dispatch claim for its reviewer seat"
                )

            checks = self._deterministic_checks(output, version_row)
            blocking = [row for row in structured if row["severity"] in BLOCKING_SEVERITIES]
            if verdict == "verified":
                if not checks["ok"]:
                    raise DeterministicCheckFailed(
                        "a verified verdict requires every mandatory check to pass"
                    )
                if blocking:
                    raise InvalidOutputTransition(
                        "a verified verdict requires no unresolved high or critical finding"
                    )

            connection.execute(
                "UPDATE meeting_output_prompt_claims SET consumed = 1 WHERE claim_id = ?",
                (claim["claim_id"],),
            )
            connection.execute(
                "UPDATE meeting_output_review_runs SET state = 'completed', verdict = ?,"
                " findings_json = ?, checks_json = ?, completed_at = ? WHERE request_id = ?",
                (
                    verdict,
                    json.dumps(structured, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(checks, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                    now, request_id,
                ),
            )
            if verdict == "verified":
                connection.execute(
                    "UPDATE meeting_outputs SET state = 'verified', verified_artifact_version = ?,"
                    " findings_json = '[]', version = version + 1, updated_at = ?"
                    " WHERE output_id = ?",
                    (int(review["artifact_version"]), now, review["output_id"]),
                )
                stage = "approval_ready"
            else:
                connection.execute(
                    "UPDATE meeting_outputs SET state = 'changes_requested',"
                    " verified_artifact_version = 0, findings_json = ?, version = version + 1,"
                    " updated_at = ? WHERE output_id = ?",
                    (json.dumps(structured, ensure_ascii=False, separators=(",", ":")), now,
                     review["output_id"]),
                )
                stage = "changes_requested"
            meeting_module.advance_stage_in_transaction(
                connection, output["meeting_id"], stage, expected_version=None, now=now,
            )
        return {
            "request_id": request_id,
            "output_id": review["output_id"],
            "artifact_version": int(review["artifact_version"]),
            "verdict": verdict,
            "findings": structured,
            "checks": checks,
            "completed_at": now,
        }

    def review_dispatch_claim(self, request_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any] | None:
        """Durable review dispatch state. No token, only the binding it proves."""
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_prompt_claims"
                " WHERE operation = 'review.prompt' AND scope = ?",
                (request_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "claim_id": row["claim_id"],
            "scope": row["scope"],
            "route": {
                "connection": row["route_connection"],
                "profile": row["route_profile"],
            },
            "consumed": bool(int(row["consumed"])),
            "expires_at": int(row["expires_at"]),
            "renewals": int(row["renewals"]),
        }

    def get_review_run(self, request_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_review_runs WHERE request_id = ?", (request_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(request_id)
        return self._review_row(row)

    def list_review_runs(self, output_id: str, *, limit: int = 20, connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        with self._reader(connection) as connection:
            rows = connection.execute(
                "SELECT * FROM meeting_output_review_runs WHERE output_id = ?"
                " ORDER BY created_at DESC, request_id DESC LIMIT ?",
                (output_id, max(1, min(int(limit), MAX_LIST_LIMIT))),
            ).fetchall()
        return [self._review_row(row) for row in rows]

    @staticmethod
    def _review_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "request_id": row["request_id"],
            "output_id": row["output_id"],
            "output_version": int(row["output_version"]),
            "artifact_version": int(row["artifact_version"]),
            "reviewer": {
                "connection": row["reviewer_connection"],
                "profile": row["reviewer_profile"],
            },
            "state": row["state"],
            "verdict": row["verdict"],
            "findings": json.loads(row["findings_json"]),
            "checks": json.loads(row["checks_json"]),
            "brief_hash": row["brief_hash"],
            "game_sha256": row["game_sha256"],
            "manifest_sha256": row["manifest_sha256"],
            "zip_sha256": row["zip_sha256"],
            "created_at": int(row["created_at"]),
            "completed_at": None if row["completed_at"] is None else int(row["completed_at"]),
        }

    # -- approval ----------------------------------------------------------

    def approve_output(
        self,
        output_id: str,
        *,
        meeting_id: str,
        expected_meeting_version: int,
        expected_output_version: int,
        artifact_version: int,
        game_sha256: str,
        manifest_sha256: str,
        zip_sha256: str,
        approver_digest: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """The exact owner approval transaction. Any mismatch writes nothing."""
        digest_value = _bounded(approver_digest, "approver_digest", 128)
        now = self._now()
        with self._transaction(connection) as connection:
            output = self._require_output(connection, output_id)
            if output["meeting_id"] != meeting_id:
                raise OutputVersionConflict("this output does not belong to that meeting")
            if int(output["version"]) != int(expected_output_version):
                raise OutputVersionConflict("output version conflict")
            if output["state"] != "verified":
                raise InvalidOutputTransition("only a verified output can be approved")
            if int(output["verified_artifact_version"]) != int(artifact_version):
                raise OutputVersionConflict("that artifact version is not the verified one")
            version_row = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ? AND artifact_version = ?",
                (output_id, int(artifact_version)),
            ).fetchone()
            if version_row is None:
                raise OutputVersionConflict("that artifact version does not exist")
            for field, supplied in (
                ("game_sha256", game_sha256),
                ("manifest_sha256", manifest_sha256),
                ("zip_sha256", zip_sha256),
            ):
                if version_row[field] != supplied:
                    raise OutputVersionConflict(f"{field} does not match the stored artifact")

            binding = {
                "output_id": output_id,
                "artifact_version": int(artifact_version),
                "game_sha256": version_row["game_sha256"],
                "manifest_sha256": version_row["manifest_sha256"],
                "zip_sha256": version_row["zip_sha256"],
                "approved_by": meeting_module.APPROVED_BY_LABEL,
                "approved_at": now,
            }
            meeting, meeting_version = meeting_module.complete_production_in_transaction(
                connection, meeting_id,
                artifact_binding=binding,
                expected_version=int(expected_meeting_version),
                now=now,
            )
            connection.execute(
                "UPDATE meeting_outputs SET state = 'approved', approved_artifact_version = ?,"
                " version = version + 1, updated_at = ? WHERE output_id = ?",
                (int(artifact_version), now, output_id),
            )
            connection.execute(
                "INSERT OR REPLACE INTO meeting_output_approvals (output_id, artifact_version,"
                " approver_digest, approved_at) VALUES (?, ?, ?, ?)",
                (output_id, int(artifact_version), digest_value, now),
            )
            approved = self._output_row(self._require_output(connection, output_id))
        return {
            "output": approved,
            "meeting": meeting,
            "meeting_version": meeting_version,
            "artifact_binding": binding,
        }

    # -- reads -------------------------------------------------------------

    def get_output(self, output_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with self._reader(connection) as connection:
            return self._output_row(self._require_output(connection, output_id))

    def list_outputs(self, meeting_id: str, *, limit: int = 20, connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        with self._reader(connection) as connection:
            rows = connection.execute(
                "SELECT * FROM meeting_outputs WHERE meeting_id = ?"
                " ORDER BY created_at DESC, output_id DESC LIMIT ?",
                (meeting_id, max(1, min(int(limit), MAX_LIST_LIMIT))),
            ).fetchall()
        return [self._output_row(row) for row in rows]

    def get_version(self, output_id: str, artifact_version: int, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ? AND artifact_version = ?",
                (output_id, int(artifact_version)),
            ).fetchone()
        if row is None:
            raise OutputNotFound(f"{output_id}:{artifact_version}")
        return self._version_row(row)

    def list_versions(self, output_id: str, *, limit: int = 50, connection: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        with self._reader(connection) as connection:
            rows = connection.execute(
                "SELECT * FROM meeting_output_versions WHERE output_id = ?"
                " ORDER BY artifact_version ASC LIMIT ?",
                (output_id, max(1, min(int(limit), MAX_LIST_LIMIT))),
            ).fetchall()
        return [self._version_row(row) for row in rows]

    def package_bytes(self, output_id: str, artifact_version: int, *, connection: sqlite3.Connection | None = None) -> bytes:
        """Return stored package bytes after revalidating the stored digest."""
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT blob_digest, zip_sha256 FROM meeting_output_versions"
                " WHERE output_id = ? AND artifact_version = ?",
                (output_id, int(artifact_version)),
            ).fetchone()
        if row is None:
            raise OutputNotFound(f"{output_id}:{artifact_version}")
        try:
            payload = self.artifacts.get_blob(row["blob_digest"])
        except WorkspaceError as exc:
            raise ArtifactUnavailable(str(exc)) from exc
        if hashlib.sha256(payload).hexdigest() != row["zip_sha256"]:
            raise ArtifactUnavailable("stored package bytes do not match zip_sha256")
        return payload

    def read_member(self, output_id: str, artifact_version: int, path: str):
        """Return one declared member after revalidating its stored digest."""
        payload = self.package_bytes(output_id, artifact_version)
        try:
            return package_module.read_package_member(payload, path)
        except PackageInvalid as exc:
            raise OutputNotFound(str(exc)) from exc

    # -- idempotency -------------------------------------------------------

    def run_idempotent(
        self,
        *,
        action: str,
        key: str,
        request_hash: str,
        mutate: Callable[[sqlite3.Connection], Any],
        replay_guard: Callable[[sqlite3.Connection, Any], bool] | None = None,
    ) -> Any:
        """Reserve, mutate, and store the response in ONE transaction.

        ``mutate`` receives the transaction's connection and MUST do all of its
        durable work on it. Because the replay check, the domain mutation, and
        the stored response share one ``BEGIN IMMEDIATE`` transaction:

        * two concurrent requests with the same key serialize -- the second
          waits for the first to commit, then returns its exact response, so
          the domain mutation happens once;
        * a crash anywhere before the commit rolls back BOTH the mutation and
          the reservation, so a retry re-runs cleanly instead of finding a
          half-applied lifecycle it can never replay;
        * the same key with a different request hash is a conflict, and that
          conflict writes nothing.

        A key is REQUIRED. Without one there is no way to tell a retry from a
        second intent, so an unkeyed lifecycle mutation is refused rather than
        applied twice; the route layer turns that into a 400.
        """
        bounded = _bounded(key, "idempotency_key", MAX_IDEMPOTENCY_KEY_CHARS)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_idempotency WHERE action = ? AND idempotency_key = ?",
                (action, bounded),
            ).fetchone()
            if row is not None:
                if not secrets.compare_digest(str(row["request_hash"]), request_hash):
                    raise IdempotencyConflict(
                        "this idempotency key was used with a different payload"
                    )
                response = json.loads(row["response_json"])
                if replay_guard is not None and not replay_guard(connection, response):
                    raise ClaimExpired("the replayed dispatch claim has expired")
                return response

            response = mutate(connection)
            connection.execute(
                "INSERT INTO meeting_output_idempotency (action, idempotency_key, request_hash,"
                " status_code, response_json, created_at) VALUES (?, ?, ?, 200, ?, ?)",
                (
                    action, bounded, request_hash,
                    json.dumps(response, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), default=str),
                    self._now(),
                ),
            )
            return response

    def claim_dispatch(
        self,
        run_id: str,
        *,
        kind: str | None,
        request_id: str,
        session_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Bind the session, take the claim, and hand out the workspace atomically.

        One transaction IS this route's atomicity: a second dispatcher cannot
        observe a bound session without the claim that goes with it, and no
        caller can receive the assigned cwd or the single-use collection claim
        unless both the binding and the claim committed for it.

        The caller passes the idempotency transaction's connection, so the
        replay reservation, the binding, the claim, and the stored dispatcher
        response commit together or not at all. An exact retry therefore
        replays this same response -- cwd and collection claim included --
        instead of hitting the lease it took itself, while a changed binding
        under the same key conflicts.
        """
        with self._transaction(connection) as connection:
            run = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None or (kind is not None and run["kind"] != kind):
                raise OutputNotFound(run_id)
            output = self._output_row(self._require_output(connection, run["output_id"]))
            _meeting, meeting_version = meeting_module.load_production_meeting(
                connection, run["meeting_id"], None
            )
            bound = self.bind_producer_session(
                run_id, session_id=session_id, connection=connection
            )
            claim = self.acquire_prompt_claim(
                operation=f"{run['kind']}.prompt",
                scope=run_id,
                request_id=request_id,
                route=output["producer"],
                session_id=session_id,
                meeting_version=meeting_version,
                output_version=output["version"],
                connection=connection,
            )
            return {
                "run_id": run_id,
                "output_id": run["output_id"],
                "kind": run["kind"],
                "claim": claim,
                "producer": output["producer"],
                "session_id": bound["session_id"],
                # Dispatcher-only fields: the assigned cwd and the single-use
                # collection claim. Neither is persisted into a meeting record
                # nor rendered in the normal UI.
                "workspace": {
                    "cwd": self.workspace_cwd(run_id, connection=connection),
                    "identity": {
                        "device": str(run["workspace_device"]),
                        "inode": str(run["workspace_inode"]),
                        "output_device": str(run["output_device"]),
                        "output_inode": str(run["output_inode"]),
                    },
                },
                "collection_claim": self.collection_claim(run_id, connection=connection),
                "brief": output["brief"],
                "brief_hash": output["brief_hash"],
                "acceptance_statement": output["summary"],
                "parent_artifact_version": (
                    None if run["parent_artifact_version"] is None
                    else int(run["parent_artifact_version"])
                ),
            }

    def claim_review_dispatch(
        self,
        request_id: str,
        *,
        dispatch_request_id: str,
        session_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Take a reviewer dispatch claim atomically with the versions it saw.

        Like the producer claim route, one transaction IS its atomicity: the
        review run, its output version, and the meeting version are read and
        bound into the claim together, on the caller's idempotency transaction.
        A claim can therefore never be bound to a version that had already
        moved -- which would otherwise authorize a verdict against an artifact
        the reviewer never saw. The reviewer gets a read-only summary: no
        workspace path and no collection claim exist here.
        """
        with self._transaction(connection) as connection:
            review = connection.execute(
                "SELECT * FROM meeting_output_review_runs WHERE request_id = ?", (request_id,)
            ).fetchone()
            if review is None:
                raise OutputNotFound(request_id)
            output = self._output_row(self._require_output(connection, review["output_id"]))
            _meeting, meeting_version = meeting_module.load_production_meeting(
                connection, output["meeting_id"], None
            )
            reviewer = {
                "connection": review["reviewer_connection"],
                "profile": review["reviewer_profile"],
            }
            claim = self.acquire_prompt_claim(
                operation="review.prompt",
                scope=request_id,
                request_id=dispatch_request_id,
                route=reviewer,
                session_id=session_id,
                meeting_version=meeting_version,
                output_version=output["version"],
                connection=connection,
            )
            return {
                "request_id": request_id,
                "output_id": review["output_id"],
                "artifact_version": int(review["artifact_version"]),
                "reviewer": reviewer,
                "claim": claim,
                "brief": output["brief"],
                "brief_hash": output["brief_hash"],
                "acceptance_statement": output["summary"],
                "checks": json.loads(review["checks_json"]),
                "artifact_summary": self.artifact_summary(
                    review["output_id"], int(review["artifact_version"]), connection=connection
                ),
            }

    def idempotent_replay(
        self, action: str, idempotency_key: str, request_hash: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any] | None:
        key = _bounded(idempotency_key, "idempotency_key", MAX_IDEMPOTENCY_KEY_CHARS)
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_idempotency WHERE action = ? AND idempotency_key = ?",
                (action, key),
            ).fetchone()
        if row is None:
            return None
        if not secrets.compare_digest(str(row["request_hash"]), request_hash):
            raise IdempotencyConflict("this idempotency key was used with a different payload")
        return {"status_code": int(row["status_code"]), "response": json.loads(row["response_json"])}

    def idempotent_commit(
        self,
        action: str,
        idempotency_key: str,
        request_hash: str,
        status_code: int,
        response: object,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        key = _bounded(idempotency_key, "idempotency_key", MAX_IDEMPOTENCY_KEY_CHARS)
        with self._transaction(connection) as connection:
            existing = connection.execute(
                "SELECT request_hash FROM meeting_output_idempotency"
                " WHERE action = ? AND idempotency_key = ?",
                (action, key),
            ).fetchone()
            if existing is not None:
                if not secrets.compare_digest(str(existing["request_hash"]), request_hash):
                    raise IdempotencyConflict(
                        "this idempotency key was used with a different payload"
                    )
                return
            connection.execute(
                "INSERT INTO meeting_output_idempotency (action, idempotency_key, request_hash,"
                " status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    action, key, request_hash, int(status_code),
                    json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                               default=str),
                    self._now(),
                ),
            )

    # -- recovery ----------------------------------------------------------

    def recover_output(self, output_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        """Read durable lifecycle state after a reload or a process restart."""
        with self._reader(connection) as connection:
            output = self._output_row(self._require_output(connection, output_id))
            active = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE output_id = ? AND state = 'open'"
                " ORDER BY created_at DESC LIMIT 1",
                (output_id,),
            ).fetchone()
            latest = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE output_id = ?"
                " ORDER BY created_at DESC LIMIT 1",
                (output_id,),
            ).fetchone()
            review = connection.execute(
                "SELECT * FROM meeting_output_review_runs WHERE output_id = ? AND state = 'open'"
                " ORDER BY created_at DESC LIMIT 1",
                (output_id,),
            ).fetchone()
            claim = None
            claim_scope = (
                active["run_id"] if active is not None
                else review["request_id"] if review is not None
                else None
            )
            if claim_scope is not None:
                claim = connection.execute(
                    "SELECT * FROM meeting_output_prompt_claims WHERE scope = ? AND consumed = 0"
                    " ORDER BY created_at DESC LIMIT 1",
                    (claim_scope,),
                ).fetchone()
        receipt = None
        if latest is not None and latest["state"] == "collected" and latest["receipt_json"]:
            receipt = json.loads(latest["receipt_json"])
        return {
            "observed_at": int(self._now()),
            "output": output,
            "active_run": None if active is None else {
                "run_id": active["run_id"],
                "kind": active["kind"],
                "state": active["state"],
                "parent_artifact_version": (
                    None if active["parent_artifact_version"] is None
                    else int(active["parent_artifact_version"])
                ),
                "claim_consumed": bool(int(active["claim_consumed"])),
                "created_at": int(active["created_at"]),
            },
            "active_prompt_claim": None if claim is None else {
                "claim_id": claim["claim_id"],
                "operation": claim["operation"],
                "scope": claim["scope"],
                "route": {
                    "connection": claim["route_connection"],
                    "profile": claim["route_profile"],
                },
                "session_id": claim["session_id"],
                "expires_at": int(claim["expires_at"]),
                "renewals": int(claim["renewals"]),
            },
            "active_review": None if review is None else {
                "request_id": review["request_id"],
                "artifact_version": int(review["artifact_version"]),
                "reviewer": {
                    "connection": review["reviewer_connection"],
                    "profile": review["reviewer_profile"],
                },
            },
            "receipt": receipt,
        }

    def collection_claim(self, run_id: str, *, connection: sqlite3.Connection | None = None) -> str:
        """Single-use collection claim for one run. Dispatcher door only."""
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT claim_token FROM meeting_output_run_secrets WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(run_id)
        return str(row["claim_token"])

    def get_run(self, run_id: str, *, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        """Public run DTO. Never carries a host path or a claim token."""
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(run_id)
        return {
            "run_id": row["run_id"],
            "output_id": row["output_id"],
            "meeting_id": row["meeting_id"],
            "kind": row["kind"],
            "state": row["state"],
            "artifact_version": (
                None if row["artifact_version"] is None else int(row["artifact_version"])
            ),
            "parent_artifact_version": (
                None if row["parent_artifact_version"] is None
                else int(row["parent_artifact_version"])
            ),
            "created_at": int(row["created_at"]),
            "updated_at": int(row["updated_at"]),
        }

    def frozen_dispatch_session(self, run_id: str, *, actual_only: bool = False, connection: sqlite3.Connection | None = None) -> str:
        """The session reference this run is dispatched under.

        The actual durable session id once bound, otherwise the provisional
        reference the run was created with. With ``actual_only`` the answer is
        empty until the real session has been bound.
        """
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_run_sessions WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(run_id)
        actual = str(row["actual_session_id"])
        if actual_only:
            return actual
        return actual or str(row["provisional_session_id"])

    def bind_producer_session(self, run_id: str, *, session_id: str, connection: sqlite3.Connection | None = None) -> dict[str, Any]:
        """Bind the ACTUAL producer session to this run, exactly once.

        The workspace cwd must be handed out before a producer session can be
        created, so the run starts with a provisional reference and the first
        claim binds the real session id -- into the output and, for a
        production run, into its checkpoint, so recovery after a restart reads
        the session that actually holds the work. Once bound, only that exact
        session is accepted; the assigned cwd and the single-use collection
        claim are never handed to a second, different session. A dispatch claim
        already standing for the run closes the first bind too: a claim IS the
        dispatch, so nothing may be bound behind it.
        """
        presented = _bounded(session_id, "session_id", MAX_SESSION_REF_CHARS)
        now = self._now()
        with self._transaction(connection) as connection:
            run = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run is None:
                raise OutputNotFound(run_id)
            row = connection.execute(
                "SELECT * FROM meeting_output_run_sessions WHERE run_id = ?", (run_id,)
            ).fetchone()
            if row is None:  # pragma: no cover - every run records its session
                raise OutputNotFound(run_id)
            bound = str(row["actual_session_id"])
            if bound:
                if not secrets.compare_digest(bound, presented):
                    raise ProducerSessionMismatch(
                        "another producer session already owns this run"
                    )
                return {"run_id": run_id, "session_id": bound, "bound": False}

            claimed = connection.execute(
                "SELECT session_id FROM meeting_output_prompt_claims"
                " WHERE operation = ? AND scope = ?",
                (f"{run['kind']}.prompt", run_id),
            ).fetchone()
            if claimed is not None and not secrets.compare_digest(
                str(claimed["session_id"]), presented
            ):
                raise ProducerSessionMismatch(
                    "a dispatch claim already owns this run"
                )

            connection.execute(
                "UPDATE meeting_output_run_sessions SET actual_session_id = ?, bound_at = ?"
                " WHERE run_id = ?",
                (presented, now, run_id),
            )
            connection.execute(
                "UPDATE meeting_outputs SET producer_session_id = ?, updated_at = ?"
                " WHERE output_id = ?",
                (presented, now, run["output_id"]),
            )
            connection.execute(
                "UPDATE meeting_output_production_checkpoints SET producer_session_id = ?"
                " WHERE run_id = ?",
                (presented, run_id),
            )
        return {"run_id": run_id, "session_id": presented, "bound": True}

    def workspace_cwd(self, run_id: str, *, connection: sqlite3.Connection | None = None) -> str:
        """Assigned cwd for one run. For the authenticated dispatcher only.

        The root's pinned identity is rechecked first: a cwd is never handed to
        a producer under a pathname that no longer names the directory
        Operations built.
        """
        with self._reader(connection) as connection:
            row = connection.execute(
                "SELECT * FROM meeting_output_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        if row is None:
            raise OutputNotFound(run_id)
        if any(
            row[name] is None
            for name in ("workspace_device", "workspace_inode", "output_device", "output_inode")
        ):
            raise WorkspaceError("the run workspace identity is unavailable")
        return str(self.artifacts.verified_workspace_path(
            run_id,
            workspace_identity=(int(row["workspace_device"]), int(row["workspace_inode"])),
            output_identity=(int(row["output_device"]), int(row["output_inode"])),
        ))

    def sweep_workspaces(
        self,
        *,
        grace_seconds: float | None = None,
        now: float | None = None,
        limit: int | None = None,
    ) -> list[str]:
        """Reclaim workspaces no durable run still needs. Blobs are untouched.

        Durable state is re-read from a fresh connection immediately before
        each removal, so an open run -- including one that committed after the
        listing -- keeps its workspace. A workspace that no row references at
        all is reclaimed only once it is older than the grace cutoff, because
        a workspace minted inside a still-open lifecycle transaction is
        indistinguishable from an abandoned one.
        """

        def durable_state() -> tuple[set[str], set[str]]:
            with self._reader() as connection:
                rows = connection.execute(
                    "SELECT run_id, state FROM meeting_output_runs"
                ).fetchall()
            return (
                {row["run_id"] for row in rows if row["state"] == "open"},
                {row["run_id"] for row in rows},
            )

        bounds: dict[str, Any] = {}
        if grace_seconds is not None:
            bounds["grace_seconds"] = grace_seconds
        if limit is not None:
            bounds["limit"] = limit
        return self.artifacts.sweep_uncollected_workspaces(
            durable_state=durable_state, now=now, **bounds
        )
