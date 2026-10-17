"""Store, workspace, hash, review, revision, approval, and recovery tests."""

import hashlib
import importlib.util
import inspect
import json
import os
import socket
import sqlite3
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def _load(name: str, alias: str):
    spec = importlib.util.spec_from_file_location(alias, DASHBOARD / name)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


def load_outputs():
    return _load("meeting_output_store.py", "operations_meeting_output_store_test")


def load_workspace():
    return _load("artifact_workspace.py", "operations_artifact_workspace_test")


def load_meetings():
    return _load("meeting_store.py", "operations_meeting_store_outputs_test")


def load_package():
    return _load("deliverable_package.py", "operations_deliverable_package_outputs_test")


LOCAL = "local"
ORCHESTRATOR = {"connection": LOCAL, "profile": "orchestrator"}
PRODUCER = {"connection": LOCAL, "profile": "producer"}
REVIEWER = {"connection": LOCAL, "profile": "reviewer"}
REMOTE_PRODUCER = {"connection": "a2a", "profile": "remote-producer"}

MEETING_ID = "meeting_production_1"
BRIEF = "Produce a one-page onboarding guide with a verified checklist."
ACCEPTANCE = "A reviewer confirms every onboarding step is reproducible."


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def production_record(**overrides):
    record = {
        "id": MEETING_ID,
        "source": {"connection": LOCAL, "profile": "default"},
        "title": "Ship the onboarding document",
        "agenda": "Produce and review the onboarding guide.",
        "chair": ORCHESTRATOR,
        "participants": [ORCHESTRATOR, PRODUCER, REVIEWER],
        "state": "draft",
        "max_rounds": 3,
        "current_round": 0,
        "contributions": [],
        "evidence": [],
        "decisions": [],
        "dissent": [],
        "action_items": [],
        "orchestrator": ORCHESTRATOR,
        "producer": PRODUCER,
        "seats": [
            {"bot": ORCHESTRATOR, "role": "specialist", "label": "Orchestrator"},
            {"bot": PRODUCER, "role": "contributor", "label": "Producer"},
            {"bot": REVIEWER, "role": "reviewer", "label": "Reviewer"},
        ],
        "product_kind": "document",
        "output_title": "Onboarding guide",
        "acceptance_statement": ACCEPTANCE,
    }
    record.update(overrides)
    return record


SAMPLE_FILES = {
    "index.txt": b"Step one. Step two. Step three.\n",
    "notes/checklist.txt": b"- verified\n",
}


def write_package_tree(cwd: Path, files=None, *, title="Onboarding guide", primary="index.txt"):
    """Write a real producer output tree inside a minted workspace."""
    files = SAMPLE_FILES if files is None else files
    output = Path(cwd) / "output"
    output.mkdir(parents=True, exist_ok=True)
    for relative, payload in files.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    manifest = {
        "schema": "deliverable_package_v1",
        "product_kind": "document",
        "title": title,
        "summary": "A short onboarding guide.",
        "primary_file": primary,
        "files": [
            {
                "path": path,
                "media_type": "text/plain",
                "role": "primary" if path == primary else "support",
                "preview_policy": "text",
                "byte_size": len(payload),
                "sha256": digest(payload),
            }
            for path, payload in sorted(files.items())
        ],
    }
    (output / "deliverable.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return manifest


@pytest.fixture
def lifecycle(tmp_path):
    """A production meeting frozen and ready for its first producer run."""
    meetings = load_meetings()
    outputs = load_outputs()
    db_path = tmp_path / "meetings.db"
    artifact_root = tmp_path / "artifacts"
    clock = {"now": 1_800_000_000}

    meeting_store = meetings.MeetingStore(db_path, clock=lambda: clock["now"])
    store = outputs.MeetingOutputStore(db_path, artifact_root, clock=lambda: clock["now"])
    created = meeting_store.put(production_record(), expected_version=0)
    frozen = store.freeze_production_brief(
        MEETING_ID,
        expected_meeting_version=created["version"],
        brief=BRIEF,
        evidence_refs=["note://round-1"],
    )
    return {
        "api": outputs,
        "meetings": meetings,
        "meeting_store": meeting_store,
        "store": store,
        "db_path": db_path,
        "artifact_root": artifact_root,
        "clock": clock,
        "meeting_version": frozen["meeting_version"],
    }


def begin_production(lifecycle, **overrides):
    kwargs = {
        "meeting_id": MEETING_ID,
        "expected_meeting_version": lifecycle["meeting_version"],
        "producer_session_id": "session-producer-1",
        "submission_id": "submission-1",
    }
    kwargs.update(overrides)
    return lifecycle["store"].begin_production_run(**kwargs)


def produce_and_collect(lifecycle, run, files=None, **kwargs):
    write_package_tree(run["cwd"], files, **kwargs)
    return lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])


def claim_review_dispatch(
    lifecycle,
    begun,
    *,
    route=REVIEWER,
    request_id="review-dispatch-1",
    session_id="session-reviewer-1",
):
    """Claim a reviewer dispatch exactly as the review claim route does."""
    store = lifecycle["store"]
    return store.acquire_prompt_claim(
        operation="review.prompt",
        scope=begun["request_id"],
        request_id=request_id,
        route=route,
        session_id=session_id,
        meeting_version=lifecycle["meeting_store"].get(MEETING_ID)["version"],
        output_version=store.get_output(begun["output_id"])["version"],
    )


def review(lifecycle, output_id, *, reviewer=REVIEWER, verdict="verified", findings=()):
    store = lifecycle["store"]
    output = store.get_output(output_id)
    begun = store.begin_review_run(
        output_id, reviewer=reviewer, expected_output_version=output["version"]
    )
    # A verdict is recordable only for a review that was actually dispatched.
    claim_review_dispatch(lifecycle, begun, route=reviewer, request_id=begun["request_id"])
    return store.complete_review_run(
        begun["request_id"], verdict=verdict, findings=list(findings)
    )


# ---------------------------------------------------------------------------
# schema, migration, immutability
# ---------------------------------------------------------------------------


def test_tables_triggers_and_indexes_are_additive_and_idempotent(tmp_path):
    meetings = load_meetings()
    outputs = load_outputs()
    db_path = tmp_path / "meetings.db"
    meetings.MeetingStore(db_path)
    for _ in range(3):
        outputs.MeetingOutputStore(db_path, tmp_path / "artifacts")

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT type, name FROM sqlite_master WHERE name LIKE 'meeting%' ORDER BY name"
        ).fetchall()
    names = [row[1] for row in rows]

    assert len(names) == len(set(names))
    for expected in (
        "meeting_versions",
        "meeting_outputs",
        "meeting_output_versions",
        "meeting_output_runs",
        "meeting_output_production_checkpoints",
        "meeting_output_review_runs",
        "meeting_output_revision_runs",
        "meeting_output_prompt_claims",
        "meeting_output_idempotency",
        "meeting_output_versions_no_update",
        "meeting_output_versions_no_delete",
    ):
        assert expected in names, expected
    # The output lifecycle shares the one meeting database; no second store.
    assert not list((tmp_path).glob("*outputs.db"))


def test_artifact_versions_cannot_be_updated_or_deleted(lifecycle):
    run = begin_production(lifecycle)
    produce_and_collect(lifecycle, run)

    with sqlite3.connect(lifecycle["db_path"]) as connection:
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            connection.execute("UPDATE meeting_output_versions SET game_sha256 = 'x'")
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            connection.execute("DELETE FROM meeting_output_versions")


# ---------------------------------------------------------------------------
# brief freeze and production checkpoint
# ---------------------------------------------------------------------------


def test_freezing_the_brief_advances_the_meeting_to_production_ready(lifecycle):
    meeting = lifecycle["meeting_store"].get(MEETING_ID)

    assert meeting["meeting"]["production_stage"] == "production_ready"
    frozen = lifecycle["store"].get_production_brief(MEETING_ID)
    assert frozen["brief"] == BRIEF
    assert frozen["brief_hash"] == digest(BRIEF.encode("utf-8"))
    assert frozen["acceptance_statement"] == ACCEPTANCE
    assert frozen["evidence_refs"] == ["note://round-1"]


def test_production_run_checkpoints_everything_before_any_dispatch(lifecycle):
    run = begin_production(lifecycle)
    checkpoint = lifecycle["store"].get_production_checkpoint(run["run_id"])

    assert checkpoint["meeting_version"] == lifecycle["meeting_version"]
    assert checkpoint["brief"] == BRIEF
    assert checkpoint["brief_hash"] == digest(BRIEF.encode("utf-8"))
    assert checkpoint["acceptance_statement"] == ACCEPTANCE
    assert checkpoint["producer"] == PRODUCER
    assert checkpoint["producer_session_id"] == "session-producer-1"
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "producing"

    output = lifecycle["store"].get_output(run["output_id"])
    assert output["state"] == "candidate"
    assert output["kind"] == "deliverable_package_v1"
    assert output["product_kind"] == "document"
    assert output["current_artifact_version"] == 0


def test_the_server_chooses_the_workspace_and_offers_no_path_parameter(lifecycle):
    """There is no producer-supplied path door anywhere in the run API."""
    run = begin_production(lifecycle)

    assert Path(run["cwd"]).is_dir()
    assert Path(run["cwd"]).resolve().is_relative_to(lifecycle["artifact_root"].resolve())
    assert (Path(run["cwd"]) / "output").is_dir()
    # The assigned cwd is derived from the run id the server minted, never from
    # anything a caller could pass.
    assert Path(run["cwd"]).name == run["run_id"]

    store = lifecycle["store"]
    for method in (store.begin_production_run, store.begin_revision_run):
        parameters = set(inspect.signature(method).parameters)
        assert not parameters & {"cwd", "workspace", "workspace_root", "path", "root"}, method

    # Minting is keyed only by run id, and lands under the Operations root.
    minted = store.artifacts.mint_workspace("mrun_server_chosen")
    assert set(inspect.signature(store.artifacts.mint_workspace).parameters) == {"run_id"}
    assert minted.cwd.resolve().is_relative_to(lifecycle["artifact_root"].resolve())
    assert minted.relative_root == "workspaces/mrun_server_chosen"


def test_remote_producers_are_explicitly_ineligible(tmp_path):
    meetings = load_meetings()
    outputs = load_outputs()
    db_path = tmp_path / "meetings.db"
    meeting_store = meetings.MeetingStore(db_path)
    store = outputs.MeetingOutputStore(db_path, tmp_path / "artifacts")
    record = production_record(
        participants=[ORCHESTRATOR, REMOTE_PRODUCER, REVIEWER],
        producer=REMOTE_PRODUCER,
        seats=[
            {"bot": ORCHESTRATOR, "role": "specialist", "label": "Orchestrator"},
            {"bot": REMOTE_PRODUCER, "role": "contributor", "label": "Producer"},
            {"bot": REVIEWER, "role": "reviewer", "label": "Reviewer"},
        ],
    )
    created = meeting_store.put(record, expected_version=0)
    frozen = store.freeze_production_brief(
        MEETING_ID, expected_meeting_version=created["version"], brief=BRIEF, evidence_refs=[]
    )

    with pytest.raises(outputs.ProducerNotEligible, match="filesystem"):
        store.begin_production_run(
            meeting_id=MEETING_ID,
            expected_meeting_version=frozen["meeting_version"],
            producer_session_id="session-remote",
            submission_id="submission-remote",
        )


def test_stale_meeting_version_refuses_to_start_production(lifecycle):
    with pytest.raises(lifecycle["api"].MeetingVersionConflict):
        begin_production(lifecycle, expected_meeting_version=lifecycle["meeting_version"] + 5)


# ---------------------------------------------------------------------------
# collection, claims, receipts
# ---------------------------------------------------------------------------


def test_collection_persists_an_immutable_verified_artifact_version(lifecycle):
    package = load_package()
    run = begin_production(lifecycle)
    manifest = write_package_tree(run["cwd"])
    collected = lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    assert collected["artifact_version"] == 1
    assert collected["parent_artifact_version"] is None
    assert collected["game_sha256"] == digest(SAMPLE_FILES["index.txt"])
    assert collected["manifest_sha256"] == package.manifest_digest(manifest)
    assert len(collected["zip_sha256"]) == 64

    stored = lifecycle["store"].get_version(collected["output_id"], 1)
    assert stored["game_sha256"] == collected["game_sha256"]
    assert stored["manifest"]["primary_file"] == "index.txt"
    payload = lifecycle["store"].package_bytes(collected["output_id"], 1)
    assert digest(payload) == collected["zip_sha256"]

    output = lifecycle["store"].get_output(collected["output_id"])
    assert output["state"] == "reviewing"
    assert output["current_artifact_version"] == 1
    assert output["verified_artifact_version"] == 0
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "reviewing"


def test_collection_claim_is_single_use_and_replays_the_exact_receipt(lifecycle):
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])
    first = lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    replay = lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])
    assert replay == first
    assert lifecycle["store"].list_versions(first["output_id"]) == [
        lifecycle["store"].get_version(first["output_id"], 1)
    ]

    with pytest.raises(lifecycle["api"].WorkspaceClaimInvalid):
        lifecycle["store"].collect_run(run["run_id"], claim_token="not-the-claim-token-at-all")


def test_a_collected_workspace_cannot_be_rearmed(lifecycle):
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])
    lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    # Rewriting the tree after collection cannot change the immutable version.
    write_package_tree(run["cwd"], {"index.txt": b"tampered\n"})
    replay = lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])
    assert replay["game_sha256"] == digest(SAMPLE_FILES["index.txt"])


def test_missing_manifest_fails_collection_closed(lifecycle):
    run = begin_production(lifecycle)
    (Path(run["cwd"]) / "output" / "index.txt").write_bytes(b"orphan\n")

    with pytest.raises(lifecycle["api"].CollectionFailed, match="manifest"):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])


@pytest.mark.parametrize("hostile", ["output", "manifest", "nested"])
def test_symlinked_workspace_members_are_refused(lifecycle, tmp_path, hostile):
    run = begin_production(lifecycle)
    cwd = Path(run["cwd"])
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.txt").write_bytes(b"secret\n")

    if hostile == "output":
        _remove_tree(cwd / "output")
        (cwd / "output").symlink_to(outside, target_is_directory=True)
    elif hostile == "manifest":
        write_package_tree(cwd)
        (cwd / "output" / "deliverable.json").unlink()
        (cwd / "output" / "deliverable.json").symlink_to(outside / "secret.txt")
    else:
        write_package_tree(cwd, {"index.txt": b"body\n", "notes/checklist.txt": b"- verified\n"})
        (cwd / "output" / "notes" / "checklist.txt").unlink()
        (cwd / "output" / "notes" / "checklist.txt").symlink_to(outside / "secret.txt")

    with pytest.raises(lifecycle["api"].CollectionFailed):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])


def test_a_symlinked_artifact_root_is_refused_outright(tmp_path):
    """The Operations artifact root is a real directory the server made."""
    workspace = load_workspace()
    real = tmp_path / "elsewhere"
    real.mkdir()
    linked = tmp_path / "artifacts"
    linked.symlink_to(real, target_is_directory=True)

    with pytest.raises(workspace.WorkspaceError, match="artifact root"):
        workspace.ArtifactStore(linked)

    # Nothing was created through the link.
    assert sorted(entry.name for entry in real.iterdir()) == []


@pytest.mark.parametrize("child", ["sha256", "staging", "workspaces"])
def test_a_swapped_artifact_child_directory_is_refused(tmp_path, child):
    """Blob writes, blob reads, minting, and sweeping all stay in the root."""
    workspace = load_workspace()
    root = tmp_path / "artifacts"
    store = workspace.ArtifactStore(root)
    digest_value = store.put_blob(b"first blob\n")
    decoy = tmp_path / "decoy"
    decoy.mkdir()

    _remove_tree(root / child)
    (root / child).symlink_to(decoy, target_is_directory=True)

    with pytest.raises(workspace.WorkspaceError):
        store.put_blob(b"second blob\n")
    with pytest.raises(workspace.WorkspaceError):
        store.mint_workspace("mrun_swapped_child")
    with pytest.raises(workspace.WorkspaceError):
        store.sweep_uncollected_workspaces(set())
    if child == "sha256":
        with pytest.raises(workspace.WorkspaceError):
            store.get_blob(digest_value)
        assert store.has_blob(digest_value) is False

    # Not one byte was written through the swapped name.
    assert sorted(entry.name for entry in decoy.iterdir()) == []


def test_external_writes_and_deletes_in_the_artifact_root_have_zero_effect(lifecycle):
    """Stored truth lives in content-addressed bytes, not in a mutable tree."""
    store = lifecycle["store"]
    workspace = load_workspace()
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    artifacts = workspace.ArtifactStore(lifecycle["artifact_root"])

    # An external actor writes extra files into the collected workspace and
    # into the blob shard, then deletes the workspace entirely.
    (Path(run["cwd"]) / "output" / "stowaway.txt").write_bytes(b"smuggled\n")
    shard = artifacts.blob_path(collected["zip_sha256"]).parent
    (shard / "rogue-blob").write_bytes(b"not a package\n")
    _remove_tree(Path(run["cwd"]))

    replay = store.collect_run(run["run_id"], claim_token=run["claim_token"])
    assert replay == collected
    assert store.list_versions(collected["output_id"]) == [
        store.get_version(collected["output_id"], 1)
    ]
    assert digest(store.package_bytes(collected["output_id"], 1)) == collected["zip_sha256"]

    # Deleting the stored bytes is detected, never served as empty or rogue.
    artifacts.blob_path(collected["zip_sha256"]).unlink()
    with pytest.raises(lifecycle["api"].ArtifactUnavailable):
        store.package_bytes(collected["output_id"], 1)
    assert artifacts.has_blob(collected["zip_sha256"]) is False


def test_a_tree_swapped_mid_collection_cannot_substitute_its_bytes(lifecycle, tmp_path, monkeypatch):
    """Collection builds from the descriptor it validated, not from a path.

    The swap fires between reading the manifest and building the package --
    exactly the window a pathname reopen would expose.
    """
    workspace = load_workspace()
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])
    honest = (Path(run["cwd"]) / "output" / "index.txt").read_bytes()

    decoy = tmp_path / "decoy"
    write_package_tree(decoy, {"index.txt": b"substituted bytes\n"}, primary="index.txt")
    run_directory = Path(run["cwd"])
    real_loads = workspace.json.loads
    swapped = {"done": False}

    def loads_then_swap(payload):
        declared = real_loads(payload)
        if not swapped["done"]:
            swapped["done"] = True
            # Move the real tree aside (the pinned descriptor still owns it)
            # and leave a decoy behind the same name.
            os.rename(run_directory, tmp_path / "moved-aside")
            run_directory.symlink_to(decoy, target_is_directory=True)
        return declared

    monkeypatch.setattr(workspace.json, "loads", loads_then_swap)
    collected = lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    assert swapped["done"] is True
    assert collected["game_sha256"] == digest(honest)
    assert collected["game_sha256"] != digest(b"substituted bytes\n")
    members = lifecycle["store"].package_bytes(collected["output_id"], 1)
    assert digest(members) == collected["zip_sha256"]


def test_every_workspace_directory_is_owner_only(lifecycle):
    run = begin_production(lifecycle)
    root = lifecycle["artifact_root"]

    for directory in (root, root / "sha256", root / "staging", root / "workspaces",
                      Path(run["cwd"])):
        assert directory.is_dir(), directory
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700, directory


@pytest.mark.parametrize("swapped", ["workspaces", "run"])
def test_a_swapped_workspace_ancestor_cannot_redirect_collection(lifecycle, tmp_path, swapped):
    """An ancestor symlink or swap must not move collection off the root."""
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])
    root = lifecycle["artifact_root"]
    decoy = tmp_path / "decoy"
    decoy.mkdir()

    if swapped == "workspaces":
        # Move the real workspaces tree aside and symlink the name elsewhere.
        (decoy / "workspaces").mkdir()
        _remove_tree(root / "workspaces")
        (root / "workspaces").symlink_to(decoy / "workspaces", target_is_directory=True)
        write_package_tree(decoy / "workspaces" / run["run_id"])
    else:
        run_directory = root / "workspaces" / run["run_id"]
        _remove_tree(run_directory)
        write_package_tree(decoy / run["run_id"])
        run_directory.symlink_to(decoy / run["run_id"], target_is_directory=True)

    with pytest.raises(lifecycle["api"].CollectionFailed):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])
    assert lifecycle["store"].list_versions(run["output_id"]) == []


def test_hard_linked_and_special_workspace_files_are_refused(lifecycle):
    run = begin_production(lifecycle)
    cwd = Path(run["cwd"])
    write_package_tree(cwd)
    linked = cwd / "output" / "notes" / "checklist.txt"
    payload = linked.read_bytes()
    linked.unlink()
    original = cwd / "original.txt"
    original.write_bytes(payload)
    os.link(original, linked)

    with pytest.raises(lifecycle["api"].CollectionFailed, match="hard link"):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    linked.unlink()
    original.unlink()
    write_package_tree(cwd)
    fifo_run = cwd / "output" / "pipe"
    os.mkfifo(fifo_run)
    with pytest.raises(lifecycle["api"].CollectionFailed, match="special"):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])
    fifo_run.unlink()

    # AF_UNIX paths are short; bind relative from inside the output directory.
    sock_path = cwd / "output" / "sock"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.getcwd()
    try:
        os.chdir(cwd / "output")
        server.bind("sock")
        assert stat.S_ISSOCK(sock_path.lstat().st_mode)
        with pytest.raises(lifecycle["api"].CollectionFailed, match="special"):
            lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])
    finally:
        os.chdir(previous)
        server.close()
        sock_path.unlink(missing_ok=True)


def test_undeclared_and_tampered_workspace_files_fail_collection(lifecycle):
    run = begin_production(lifecycle)
    cwd = Path(run["cwd"])
    write_package_tree(cwd)
    (cwd / "output" / "stowaway.txt").write_bytes(b"smuggled\n")

    with pytest.raises(lifecycle["api"].CollectionFailed, match="undeclared"):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])

    (cwd / "output" / "stowaway.txt").unlink()
    (cwd / "output" / "index.txt").write_bytes(b"tampered body that is a different length\n")
    with pytest.raises(lifecycle["api"].CollectionFailed, match="size|digest"):
        lifecycle["store"].collect_run(run["run_id"], claim_token=run["claim_token"])


def test_stored_blob_tamper_fails_before_retrieval(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    workspace = load_workspace()
    store = workspace.ArtifactStore(lifecycle["artifact_root"])
    blob = store.blob_path(collected["zip_sha256"])
    blob.write_bytes(blob.read_bytes()[:-5] + b"xxxxx")

    with pytest.raises(lifecycle["api"].ArtifactUnavailable):
        lifecycle["store"].package_bytes(collected["output_id"], 1)


# ---------------------------------------------------------------------------
# prompt claims
# ---------------------------------------------------------------------------


def test_prompt_claims_serialize_dispatch_and_renew_only_on_identical_binding(lifecycle):
    run = begin_production(lifecycle)
    store = lifecycle["store"]
    binding = {
        "operation": "production.prompt",
        "scope": run["run_id"],
        "request_id": "request-1",
        "route": PRODUCER,
        "session_id": "session-producer-1",
        "meeting_version": lifecycle["meeting_version"],
        "output_version": 1,
    }

    claim = store.acquire_prompt_claim(**binding)
    assert claim["claim_id"]

    with pytest.raises(lifecycle["api"].ClaimActive):
        store.acquire_prompt_claim(**binding)

    lifecycle["clock"]["now"] += lifecycle["api"].PROMPT_CLAIM_TTL_SECONDS + 1
    renewed = store.acquire_prompt_claim(**binding)
    assert renewed["renewals"] == 1

    lifecycle["clock"]["now"] += lifecycle["api"].PROMPT_CLAIM_TTL_SECONDS + 1
    with pytest.raises(lifecycle["api"].ClaimBindingMismatch):
        store.acquire_prompt_claim(**{**binding, "session_id": "session-other"})
    with pytest.raises(lifecycle["api"].ClaimBindingMismatch):
        store.acquire_prompt_claim(**{**binding, "route": REVIEWER})


def test_prompt_claims_stop_renewing_at_the_bounded_lifetime(lifecycle):
    run = begin_production(lifecycle)
    store = lifecycle["store"]
    binding = {
        "operation": "production.prompt",
        "scope": run["run_id"],
        "request_id": "request-1",
        "route": PRODUCER,
        "session_id": "session-producer-1",
        "meeting_version": lifecycle["meeting_version"],
        "output_version": 1,
    }
    store.acquire_prompt_claim(**binding)

    for _ in range(lifecycle["api"].MAX_PROMPT_CLAIM_RENEWALS):
        lifecycle["clock"]["now"] += lifecycle["api"].PROMPT_CLAIM_TTL_SECONDS + 1
        store.acquire_prompt_claim(**binding)

    lifecycle["clock"]["now"] += lifecycle["api"].PROMPT_CLAIM_TTL_SECONDS + 1
    with pytest.raises(lifecycle["api"].ClaimExhausted):
        store.acquire_prompt_claim(**binding)


# ---------------------------------------------------------------------------
# review
# ---------------------------------------------------------------------------


def test_review_freezes_the_exact_artifact_and_verifies_every_check(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    output = store.get_output(collected["output_id"])

    begun = store.begin_review_run(
        collected["output_id"], reviewer=REVIEWER, expected_output_version=output["version"]
    )
    assert begun["artifact_version"] == 1
    assert begun["game_sha256"] == collected["game_sha256"]
    assert begun["manifest_sha256"] == collected["manifest_sha256"]
    assert begun["zip_sha256"] == collected["zip_sha256"]
    assert begun["brief_hash"] == digest(BRIEF.encode("utf-8"))
    assert begun["checks"]["ok"] is True
    assert begun["artifact_summary"]["files"][0]["path"] == "index.txt"
    assert "cwd" not in json.dumps(begun)

    claim_review_dispatch(lifecycle, begun)
    completed = store.complete_review_run(begun["request_id"], verdict="verified", findings=[])
    assert completed["verdict"] == "verified"
    assert store.get_output(collected["output_id"])["state"] == "verified"
    assert store.get_output(collected["output_id"])["verified_artifact_version"] == 1
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "approval_ready"


def test_the_producer_and_orchestrator_cannot_review(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    version = store.get_output(collected["output_id"])["version"]

    for impostor in (PRODUCER, ORCHESTRATOR, {"connection": LOCAL, "profile": "stranger"}):
        with pytest.raises(lifecycle["api"].ReviewerNotEligible):
            store.begin_review_run(
                collected["output_id"], reviewer=impostor, expected_output_version=version
            )


def test_only_one_review_is_active_per_output(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    version = store.get_output(collected["output_id"])["version"]
    store.begin_review_run(
        collected["output_id"], reviewer=REVIEWER, expected_output_version=version
    )

    with pytest.raises(lifecycle["api"].ReviewActive):
        store.begin_review_run(
            collected["output_id"], reviewer=REVIEWER, expected_output_version=version
        )


def test_a_verified_verdict_is_impossible_while_a_mandatory_check_fails(lifecycle):
    workspace = load_workspace()
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    blob = workspace.ArtifactStore(lifecycle["artifact_root"]).blob_path(collected["zip_sha256"])
    version = store.get_output(collected["output_id"])["version"]
    begun = store.begin_review_run(
        collected["output_id"], reviewer=REVIEWER, expected_output_version=version
    )
    blob.write_bytes(b"not a zip at all")
    claim_review_dispatch(lifecycle, begun)

    with pytest.raises(lifecycle["api"].DeterministicCheckFailed):
        store.complete_review_run(begun["request_id"], verdict="verified", findings=[])


def test_the_actual_producer_session_binds_exactly_once_per_run(lifecycle):
    """A run opens with a provisional reference and binds the real session once.

    The real session id cannot exist before the run, because creating the
    producer session needs the cwd the run mints. So the run freezes a bounded
    provisional reference, and the first claim binds the actual durable session
    id into both the output and the production checkpoint.
    """
    store = lifecycle["store"]
    run = begin_production(lifecycle, producer_session_id="provisional-production-1")

    assert store.frozen_dispatch_session(run["run_id"]) == "provisional-production-1"
    assert store.frozen_dispatch_session(run["run_id"], actual_only=True) == ""

    bound = store.bind_producer_session(run["run_id"], session_id="session-producer-actual")
    assert bound == {"run_id": run["run_id"], "session_id": "session-producer-actual", "bound": True}
    assert store.frozen_dispatch_session(run["run_id"]) == "session-producer-actual"
    assert store.get_production_checkpoint(run["run_id"])["producer_session_id"] == (
        "session-producer-actual"
    )

    # Idempotent for the identical session; refused for any other.
    rebound = store.bind_producer_session(run["run_id"], session_id="session-producer-actual")
    assert rebound["bound"] is False
    with pytest.raises(lifecycle["api"].ProducerSessionMismatch):
        store.bind_producer_session(run["run_id"], session_id="session-producer-thief")
    with pytest.raises(lifecycle["api"].ProducerSessionMismatch):
        store.bind_producer_session(run["run_id"], session_id="provisional-production-1")
    assert store.frozen_dispatch_session(run["run_id"]) == "session-producer-actual"


def test_a_run_with_a_live_claim_cannot_bind_a_first_session_afterwards(lifecycle):
    """A claim is the dispatch: no session may be bound behind its back."""
    store = lifecycle["store"]
    run = begin_production(lifecycle, producer_session_id="provisional-production-1")
    store.acquire_prompt_claim(
        operation="production.prompt",
        scope=run["run_id"],
        request_id="dispatch-1",
        route=PRODUCER,
        session_id="session-producer-actual",
        meeting_version=lifecycle["meeting_version"],
        output_version=1,
    )

    with pytest.raises(lifecycle["api"].ProducerSessionMismatch):
        store.bind_producer_session(run["run_id"], session_id="session-producer-late")
    assert store.frozen_dispatch_session(run["run_id"]) == "provisional-production-1"


def test_a_revision_run_binds_its_own_actual_session(lifecycle):
    store = lifecycle["store"]
    run = begin_production(lifecycle, producer_session_id="provisional-production-1")
    store.bind_producer_session(run["run_id"], session_id="session-producer-actual")
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"], verdict="changes_requested",
           findings=[{"severity": "high", "code": "fix", "detail": "Add step three."}])
    revision = store.begin_revision_run(
        collected["output_id"],
        expected_output_version=store.get_output(collected["output_id"])["version"],
        producer_session_id="provisional-revision-1",
    )

    assert store.frozen_dispatch_session(revision["run_id"]) == "provisional-revision-1"
    store.bind_producer_session(revision["run_id"], session_id="session-revision-actual")
    assert store.frozen_dispatch_session(revision["run_id"]) == "session-revision-actual"
    assert store.get_output(collected["output_id"])["producer"] == PRODUCER
    # The production checkpoint of the FIRST run keeps its own real session.
    assert store.get_production_checkpoint(run["run_id"])["producer_session_id"] == (
        "session-producer-actual"
    )
    with pytest.raises(lifecycle["api"].ProducerSessionMismatch):
        store.bind_producer_session(revision["run_id"], session_id="session-producer-actual")


def _production_run_mutation(lifecycle, *, submission="submission-atomic"):
    def mutate(connection):
        return lifecycle["store"].begin_production_run(
            meeting_id=MEETING_ID,
            expected_meeting_version=lifecycle["meeting_version"],
            producer_session_id="provisional-production-1",
            submission_id=submission,
            connection=connection,
        )

    return mutate


def test_two_concurrent_requests_with_one_key_mutate_once_and_replay(lifecycle):
    """The reservation, the mutation, and the response share one transaction.

    Both callers see the SAME response, and the lifecycle advanced once. The
    second caller's mutation never runs, so it cannot fail on the stage the
    first one already advanced.
    """
    store = lifecycle["store"]
    start = threading.Barrier(2)
    responses: list[dict] = []
    failures: list[BaseException] = []

    def attempt():
        start.wait(timeout=10)
        try:
            responses.append(
                store.run_idempotent(
                    action="production.run",
                    key="shared-run-key",
                    request_hash="request-hash-1",
                    mutate=_production_run_mutation(lifecycle),
                )
            )
        except BaseException as exc:
            failures.append(exc)

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert [type(failure).__name__ for failure in failures] == []
    assert len(responses) == 2
    assert responses[0]["run_id"] == responses[1]["run_id"]
    assert len(store.list_outputs(MEETING_ID)) == 1
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "producing"
    with sqlite3.connect(lifecycle["db_path"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM meeting_output_runs").fetchone()[0] == 1


def test_a_crash_before_the_commit_leaves_no_half_applied_lifecycle(lifecycle):
    """A failure after the mutation rolls the whole transaction back."""
    store = lifecycle["store"]

    class Crash(RuntimeError):
        pass

    def mutate_then_crash(connection):
        _production_run_mutation(lifecycle)(connection)
        raise Crash("the process died before the response was stored")

    with pytest.raises(Crash):
        store.run_idempotent(
            action="production.run",
            key="crash-key",
            request_hash="request-hash-1",
            mutate=mutate_then_crash,
        )

    # Nothing was applied, and the key is unknown rather than half-recorded.
    assert store.list_outputs(MEETING_ID) == []
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == (
        "production_ready"
    )
    assert store.idempotent_replay("production.run", "crash-key", "request-hash-1") is None
    with sqlite3.connect(lifecycle["db_path"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM meeting_output_runs").fetchone()[0] == 0

    # The retry applies exactly once and replays byte-for-byte after that.
    first = store.run_idempotent(
        action="production.run",
        key="crash-key",
        request_hash="request-hash-1",
        mutate=_production_run_mutation(lifecycle),
    )
    replay = store.run_idempotent(
        action="production.run",
        key="crash-key",
        request_hash="request-hash-1",
        mutate=_production_run_mutation(lifecycle),
    )
    assert replay["run_id"] == first["run_id"]
    assert len(store.list_outputs(MEETING_ID)) == 1

    # The rolled-back run minted a workspace on disk; it belongs to no run, so
    # the sweep reclaims it and the surviving run keeps its own.
    swept = store.sweep_workspaces()
    assert first["run_id"] not in swept
    assert Path(first["cwd"]).is_dir()


def test_the_same_key_with_a_changed_payload_conflicts_and_writes_nothing(lifecycle):
    store = lifecycle["store"]
    first = store.run_idempotent(
        action="production.run",
        key="shared-run-key",
        request_hash="request-hash-1",
        mutate=_production_run_mutation(lifecycle),
    )

    with pytest.raises(lifecycle["api"].IdempotencyConflict):
        store.run_idempotent(
            action="production.run",
            key="shared-run-key",
            request_hash="request-hash-2",
            mutate=_production_run_mutation(lifecycle, submission="submission-other"),
        )

    assert [row["output_id"] for row in store.list_outputs(MEETING_ID)] == [first["output_id"]]
    with sqlite3.connect(lifecycle["db_path"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM meeting_output_runs").fetchone()[0] == 1


def test_a_verdict_requires_the_matching_reviewer_dispatch_claim(lifecycle):
    """The verdict follows the claimed review dispatch, not the caller.

    REST authentication identifies the installation owner, never a Bot route,
    so the durable ``review.prompt`` claim is the only evidence that this exact
    review run was dispatched to this exact reviewer seat. A claim bound to
    another route is not this reviewer's dispatch.
    """
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    begun = store.begin_review_run(
        collected["output_id"],
        reviewer=REVIEWER,
        expected_output_version=store.get_output(collected["output_id"])["version"],
    )

    with pytest.raises(lifecycle["api"].ReviewClaimRequired):
        store.complete_review_run(begun["request_id"], verdict="verified", findings=[])

    claim_review_dispatch(lifecycle, begun, route=ORCHESTRATOR)
    with pytest.raises(lifecycle["api"].ReviewClaimRequired):
        store.complete_review_run(begun["request_id"], verdict="verified", findings=[])

    output = store.get_output(collected["output_id"])
    assert output["state"] == "reviewing"
    assert output["verified_artifact_version"] == 0
    assert store.get_review_run(begun["request_id"])["state"] == "open"


def test_a_consumed_review_claim_cannot_record_a_second_verdict(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    begun = store.begin_review_run(
        collected["output_id"],
        reviewer=REVIEWER,
        expected_output_version=store.get_output(collected["output_id"])["version"],
    )
    claim = claim_review_dispatch(lifecycle, begun)
    store.complete_review_run(begun["request_id"], verdict="verified", findings=[])

    assert store.review_dispatch_claim(begun["request_id"])["claim_id"] == claim["claim_id"]
    assert store.review_dispatch_claim(begun["request_id"])["consumed"] is True
    with pytest.raises(lifecycle["api"].InvalidOutputTransition):
        store.complete_review_run(begun["request_id"], verdict="verified", findings=[])


def test_changes_requested_persists_structured_findings(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    findings = [
        {"severity": "high", "code": "missing_checklist", "detail": "The checklist omits step three.",
         "path": "notes/checklist.txt"},
    ]

    completed = review(lifecycle, collected["output_id"], verdict="changes_requested", findings=findings)

    assert completed["verdict"] == "changes_requested"
    assert completed["findings"][0]["code"] == "missing_checklist"
    assert store.get_output(collected["output_id"])["state"] == "changes_requested"
    assert store.get_output(collected["output_id"])["findings"][0]["severity"] == "high"
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "changes_requested"


def test_a_verified_verdict_requires_no_unresolved_high_finding(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    version = store.get_output(collected["output_id"])["version"]
    begun = store.begin_review_run(
        collected["output_id"], reviewer=REVIEWER, expected_output_version=version
    )
    claim_review_dispatch(lifecycle, begun)

    with pytest.raises(lifecycle["api"].InvalidOutputTransition, match="finding"):
        store.complete_review_run(
            begun["request_id"],
            verdict="verified",
            findings=[{"severity": "critical", "code": "unsafe", "detail": "Unsafe preview."}],
        )


# ---------------------------------------------------------------------------
# revision lineage
# ---------------------------------------------------------------------------


def test_revision_creates_an_immutable_next_version_with_parent_lineage(lifecycle):
    run = begin_production(lifecycle)
    first = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    review(lifecycle, first["output_id"], verdict="changes_requested",
           findings=[{"severity": "high", "code": "fix", "detail": "Add step three."}])

    output = store.get_output(first["output_id"])
    revision = store.begin_revision_run(
        first["output_id"],
        expected_output_version=output["version"],
        producer_session_id="session-producer-2",
    )
    assert revision["parent_artifact_version"] == 1
    assert lifecycle["meeting_store"].get(MEETING_ID)["meeting"]["production_stage"] == "producing"

    second = produce_and_collect(
        lifecycle,
        revision,
        {"index.txt": b"Step one. Step two. Step three. Step four.\n", "notes/checklist.txt": b"- verified\n"},
    )
    assert second["artifact_version"] == 2
    assert second["parent_artifact_version"] == 1
    assert second["game_sha256"] != first["game_sha256"]

    # Version 1 survives byte-for-byte and keeps its own digests.
    assert store.get_version(first["output_id"], 1)["game_sha256"] == first["game_sha256"]
    assert digest(store.package_bytes(first["output_id"], 1)) == first["zip_sha256"]

    refreshed = store.get_output(first["output_id"])
    assert refreshed["state"] == "reviewing"
    assert refreshed["current_artifact_version"] == 2
    assert refreshed["verified_artifact_version"] == 0


def test_a_stale_review_cannot_verify_a_newer_artifact(lifecycle):
    run = begin_production(lifecycle)
    first = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]
    stale = store.begin_review_run(
        first["output_id"], reviewer=REVIEWER,
        expected_output_version=store.get_output(first["output_id"])["version"],
    )
    claim_review_dispatch(lifecycle, stale)
    store.complete_review_run(
        stale["request_id"], verdict="changes_requested",
        findings=[{"severity": "high", "code": "fix", "detail": "Add step three."}],
    )
    revision = store.begin_revision_run(
        first["output_id"],
        expected_output_version=store.get_output(first["output_id"])["version"],
        producer_session_id="session-producer-2",
    )
    produce_and_collect(lifecycle, revision, {"index.txt": b"Revised.\n"}, primary="index.txt")

    # The closed review for version 1 cannot be reopened against version 2.
    with pytest.raises(lifecycle["api"].InvalidOutputTransition):
        store.complete_review_run(stale["request_id"], verdict="verified", findings=[])
    assert store.get_output(first["output_id"])["verified_artifact_version"] == 0


def test_only_a_changes_requested_output_can_be_revised(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]

    with pytest.raises(lifecycle["api"].InvalidOutputTransition):
        store.begin_revision_run(
            collected["output_id"],
            expected_output_version=store.get_output(collected["output_id"])["version"],
            producer_session_id="session-producer-2",
        )


# ---------------------------------------------------------------------------
# exact owner approval
# ---------------------------------------------------------------------------


def approval_payload(lifecycle, collected, **overrides):
    meeting = lifecycle["meeting_store"].get(MEETING_ID)
    output = lifecycle["store"].get_output(collected["output_id"])
    payload = {
        "meeting_id": MEETING_ID,
        "expected_meeting_version": meeting["version"],
        "expected_output_version": output["version"],
        "artifact_version": collected["artifact_version"],
        "game_sha256": collected["game_sha256"],
        "manifest_sha256": collected["manifest_sha256"],
        "zip_sha256": collected["zip_sha256"],
        "approver_digest": "a" * 64,
    }
    payload.update(overrides)
    return payload


def test_exact_owner_approval_binds_and_completes_atomically(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"])
    store = lifecycle["store"]

    approved = store.approve_output(collected["output_id"], **approval_payload(lifecycle, collected))

    assert approved["output"]["state"] == "approved"
    assert approved["output"]["approved_artifact_version"] == 1
    meeting = approved["meeting"]
    assert meeting["state"] == "completed"
    assert meeting["production_stage"] == "completed"
    assert meeting["artifact_binding"] == {
        "output_id": collected["output_id"],
        "artifact_version": 1,
        "game_sha256": collected["game_sha256"],
        "manifest_sha256": collected["manifest_sha256"],
        "zip_sha256": collected["zip_sha256"],
        "approved_by": "Owner",
        "approved_at": lifecycle["clock"]["now"],
    }
    assert "a" * 64 not in json.dumps(approved)


@pytest.mark.parametrize("field,value", [
    ("expected_meeting_version", 99),
    ("expected_output_version", 99),
    ("artifact_version", 2),
    ("game_sha256", "d" * 64),
    ("manifest_sha256", "d" * 64),
    ("zip_sha256", "d" * 64),
])
def test_any_stale_or_mismatched_approval_value_changes_nothing(lifecycle, field, value):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"])
    store = lifecycle["store"]
    before_meeting = lifecycle["meeting_store"].get(MEETING_ID)
    before_output = store.get_output(collected["output_id"])

    with pytest.raises((lifecycle["api"].OutputVersionConflict, lifecycle["api"].MeetingVersionConflict)):
        store.approve_output(
            collected["output_id"], **approval_payload(lifecycle, collected, **{field: value})
        )

    assert lifecycle["meeting_store"].get(MEETING_ID) == before_meeting
    assert store.get_output(collected["output_id"]) == before_output


def test_an_unverified_output_cannot_be_approved(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    store = lifecycle["store"]

    with pytest.raises(lifecycle["api"].InvalidOutputTransition, match="verified"):
        store.approve_output(collected["output_id"], **approval_payload(lifecycle, collected))


def test_approval_is_terminal_and_cannot_be_replayed_or_revised(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"])
    store = lifecycle["store"]
    payload = approval_payload(lifecycle, collected)
    store.approve_output(collected["output_id"], **payload)

    with pytest.raises((lifecycle["api"].OutputVersionConflict, lifecycle["api"].InvalidOutputTransition)):
        store.approve_output(collected["output_id"], **payload)
    with pytest.raises(lifecycle["api"].InvalidOutputTransition):
        store.begin_revision_run(
            collected["output_id"],
            expected_output_version=store.get_output(collected["output_id"])["version"],
            producer_session_id="session-producer-3",
        )


def test_the_approver_principal_is_recorded_privately_only(lifecycle):
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"])
    store = lifecycle["store"]
    store.approve_output(
        collected["output_id"], **approval_payload(lifecycle, collected, approver_digest="f" * 64)
    )

    public = json.dumps([
        store.get_output(collected["output_id"]),
        store.get_version(collected["output_id"], 1),
        lifecycle["meeting_store"].get(MEETING_ID),
    ])
    assert "f" * 64 not in public
    with sqlite3.connect(lifecycle["db_path"]) as connection:
        stored = connection.execute(
            "SELECT approver_digest FROM meeting_output_approvals WHERE output_id = ?",
            (collected["output_id"],),
        ).fetchone()
    assert stored[0] == "f" * 64


# ---------------------------------------------------------------------------
# idempotency and recovery
# ---------------------------------------------------------------------------


def test_idempotent_replay_returns_the_original_response_and_conflicts_on_change(lifecycle):
    store = lifecycle["store"]
    assert store.idempotent_replay("production.begin", "key-1", "hash-a") is None

    store.idempotent_commit("production.begin", "key-1", "hash-a", 200, {"run_id": "run-1"})
    assert store.idempotent_replay("production.begin", "key-1", "hash-a") == {
        "status_code": 200,
        "response": {"run_id": "run-1"},
    }

    with pytest.raises(lifecycle["api"].IdempotencyConflict):
        store.idempotent_replay("production.begin", "key-1", "hash-b")


def test_recovery_reads_durable_state_after_a_restart(lifecycle):
    outputs = lifecycle["api"]
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])

    # Restart: a brand new store instance over the same database and root.
    restarted = outputs.MeetingOutputStore(
        lifecycle["db_path"], lifecycle["artifact_root"], clock=lambda: lifecycle["clock"]["now"]
    )
    recovered = restarted.recover_output(run["output_id"])
    assert recovered["output"]["state"] == "candidate"
    assert recovered["active_run"]["run_id"] == run["run_id"]
    assert recovered["active_run"]["state"] == "open"
    assert recovered["receipt"] is None

    collected = restarted.collect_run(run["run_id"], claim_token=run["claim_token"])

    again = outputs.MeetingOutputStore(
        lifecycle["db_path"], lifecycle["artifact_root"], clock=lambda: lifecycle["clock"]["now"]
    )
    after = again.recover_output(run["output_id"])
    assert after["active_run"] is None
    assert after["receipt"]["zip_sha256"] == collected["zip_sha256"]
    assert after["output"]["current_artifact_version"] == 1


def test_sweeping_uncollected_workspaces_never_touches_approved_evidence(lifecycle):
    workspace = load_workspace()
    run = begin_production(lifecycle)
    collected = produce_and_collect(lifecycle, run)
    review(lifecycle, collected["output_id"])
    lifecycle["store"].approve_output(collected["output_id"], **approval_payload(lifecycle, collected))

    removed = lifecycle["store"].sweep_workspaces()

    assert run["run_id"] in removed
    assert not Path(run["cwd"]).exists()
    store = workspace.ArtifactStore(lifecycle["artifact_root"])
    assert store.has_blob(collected["zip_sha256"])
    assert digest(lifecycle["store"].package_bytes(collected["output_id"], 1)) == collected["zip_sha256"]


def _remove_tree(path: Path) -> None:
    for child in sorted(path.iterdir()):
        if child.is_dir() and not child.is_symlink():
            _remove_tree(child)
        else:
            child.unlink()
    path.rmdir()


def test_a_review_claim_binds_its_versions_in_one_transaction(lifecycle):
    """The reviewer claim reads and binds inside ONE transaction.

    A claim bound to a version that already moved would authorize a verdict
    against an artifact the reviewer never saw, so the read of the meeting and
    output versions and the write of the claim must not be separable.
    """
    store = lifecycle["store"]
    run = begin_production(lifecycle, producer_session_id="provisional-production-1")
    store.bind_producer_session(run["run_id"], session_id="session-producer-actual")
    collected = produce_and_collect(lifecycle, run)
    output = store.get_output(collected["output_id"])
    begun = store.begin_review_run(
        collected["output_id"], reviewer=REVIEWER, expected_output_version=output["version"]
    )

    claimed = store.claim_review_dispatch(
        begun["request_id"],
        dispatch_request_id="review-dispatch-1",
        session_id="session-reviewer-1",
    )

    assert claimed["request_id"] == begun["request_id"]
    assert claimed["reviewer"] == REVIEWER
    assert claimed["artifact_version"] == 1
    assert claimed["claim"]["claim_id"]
    # A reviewer never receives a writable path or a collection claim.
    assert "workspace" not in claimed
    assert "collection_claim" not in claimed
    assert "cwd" not in json.dumps(claimed)
    assert claimed["artifact_summary"]["files"][0]["path"] == "index.txt"

    # The durable claim is bound to the versions the review actually saw.
    durable = store.review_dispatch_claim(begun["request_id"])
    assert durable["route"] == REVIEWER
    assert durable["consumed"] is False

    # Re-claiming the identical binding is refused while it is unexpired, so a
    # second reviewer dispatch cannot run behind the first one.
    with pytest.raises(lifecycle["api"].ClaimActive):
        store.claim_review_dispatch(
            begun["request_id"],
            dispatch_request_id="review-dispatch-1",
            session_id="session-reviewer-1",
        )

    # One transaction: the whole claim is taken on a caller-owned connection,
    # which is also how the route commits its idempotency receipt with it.
    assert "connection" in inspect.signature(store.acquire_prompt_claim).parameters
    assert set(inspect.signature(store.claim_review_dispatch).parameters) == {
        "request_id", "dispatch_request_id", "session_id", "connection"
    }
    assert set(inspect.signature(store.claim_dispatch).parameters) == {
        "run_id", "kind", "request_id", "session_id", "connection"
    }


# ---------------------------------------------------------------------------
# artifact root creation, identity pinning, and blob entry verification
# ---------------------------------------------------------------------------


def test_a_symlinked_ancestor_cannot_place_the_artifact_root(tmp_path):
    """The root is created by descriptor walk, so a linked ancestor is refused.

    The link is planted BEFORE construction, which is the only window a
    ``mkdir(parents=True)`` would have followed: every missing component of the
    configured root would have been created inside the link's target.
    """
    workspace = load_workspace()
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    linked = tmp_path / "parent"
    linked.symlink_to(decoy, target_is_directory=True)

    with pytest.raises(workspace.WorkspaceError) as caught:
        workspace.ArtifactStore(linked / "nested" / "artifacts")

    # A refusal never carries the host path it refused.
    assert str(tmp_path) not in str(caught.value)
    assert sorted(entry.name for entry in decoy.iterdir()) == []


def test_a_symlinked_existing_ancestor_is_refused_even_when_the_root_exists(tmp_path):
    """Every existing path component is opened no-follow from the filesystem anchor."""
    workspace = load_workspace()
    decoy = tmp_path / "decoy"
    existing_root = decoy / "nested" / "artifacts"
    existing_root.mkdir(parents=True)
    linked = tmp_path / "parent"
    linked.symlink_to(decoy, target_is_directory=True)

    with pytest.raises(workspace.WorkspaceError) as caught:
        workspace.ArtifactStore(linked / "nested" / "artifacts")

    assert str(tmp_path) not in str(caught.value)
    assert sorted(entry.name for entry in existing_root.iterdir()) == []


def test_blob_staging_retries_short_writes_and_verifies_the_result(tmp_path, monkeypatch):
    workspace = load_workspace()
    store = workspace.ArtifactStore(tmp_path / "artifacts")
    payload = b"short writes must not truncate immutable bytes\n" * 400
    real_write = workspace.os.write

    def short_write(descriptor, data):
        return real_write(descriptor, data[: max(1, len(data) // 2)])

    monkeypatch.setattr(workspace.os, "write", short_write)
    stored = store.put_blob(payload)

    assert stored == digest(payload)
    assert store.get_blob(stored) == payload


def test_blob_publication_refuses_a_swapped_staging_name(tmp_path, monkeypatch):
    workspace = load_workspace()
    store = workspace.ArtifactStore(tmp_path / "artifacts")
    payload = b"verified immutable package bytes"
    real_rename = workspace.os.rename

    def swap_then_rename(source, destination, *, src_dir_fd=None, dst_dir_fd=None):
        workspace.os.unlink(source, dir_fd=src_dir_fd)
        replacement = workspace.os.open(
            source,
            workspace.os.O_WRONLY | workspace.os.O_CREAT | workspace.os.O_EXCL,
            0o600,
            dir_fd=src_dir_fd,
        )
        try:
            workspace.os.write(replacement, b"substituted package bytes")
        finally:
            workspace.os.close(replacement)
        return real_rename(
            source,
            destination,
            src_dir_fd=src_dir_fd,
            dst_dir_fd=dst_dir_fd,
        )

    monkeypatch.setattr(workspace.os, "rename", swap_then_rename)

    with pytest.raises(workspace.WorkspaceError, match="changed during publication"):
        store.put_blob(payload)
    with pytest.raises(workspace.WorkspaceError):
        store.get_blob(digest(payload))


def test_a_replaced_run_workspace_is_refused_before_its_cwd_is_exposed(lifecycle, tmp_path):
    store = lifecycle["store"]
    run = begin_production(lifecycle)
    run_path = Path(run["cwd"])
    decoy = tmp_path / "decoy-run"
    (decoy / "output").mkdir(parents=True)
    _remove_tree(run_path)
    run_path.symlink_to(decoy, target_is_directory=True)

    with pytest.raises(lifecycle["api"].WorkspaceError):
        store.workspace_cwd(run["run_id"])


def test_collection_refuses_a_replacement_real_workspace(lifecycle):
    api = lifecycle["api"]
    store = lifecycle["store"]
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"], files={"index.txt": b"producer bytes\n"})
    original = Path(run["cwd"])
    held = original.with_name(f"{original.name}-held")
    original.rename(held)
    write_package_tree(original, files={"index.txt": b"substituted bytes\n"})

    with pytest.raises(api.CollectionFailed, match="workspace identity changed"):
        store.collect_run(run["run_id"], claim_token=run["claim_token"])


def test_a_file_in_place_of_an_artifact_root_component_is_refused(tmp_path):
    """A component of the configured root must be a directory, never a file."""
    workspace = load_workspace()
    blocker = tmp_path / "parent"
    blocker.write_bytes(b"not a directory\n")

    with pytest.raises(workspace.WorkspaceError) as caught:
        workspace.ArtifactStore(blocker / "artifacts")

    assert str(tmp_path) not in str(caught.value)
    assert blocker.read_bytes() == b"not a directory\n"


def test_the_artifact_root_is_created_by_descriptor_walk_and_owner_only(tmp_path):
    """Every component Operations creates below the trusted ancestor is ours."""
    workspace = load_workspace()
    root = tmp_path / "deep" / "nested" / "artifacts"
    store = workspace.ArtifactStore(root)

    assert root.is_dir()
    assert not root.is_symlink()
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "deep").stat().st_mode) == 0o700
    assert store.put_blob(b"walked blob\n") == digest(b"walked blob\n")


def test_a_root_swapped_after_construction_is_refused_before_any_operation(tmp_path):
    """The root's device and inode are pinned, so a swap cannot redirect IO.

    This is the check/open race: the configured pathname still resolves, but it
    no longer names the directory Operations verified and built.
    """
    workspace = load_workspace()
    root = tmp_path / "artifacts"
    store = workspace.ArtifactStore(root)
    stored = store.put_blob(b"first blob\n")
    decoy = tmp_path / "decoy"
    decoy.mkdir()

    # 1. The root pathname becomes a link to an attacker-owned directory.
    _remove_tree(root)
    root.symlink_to(decoy, target_is_directory=True)

    for operation in (
        lambda: store.put_blob(b"second blob\n"),
        lambda: store.mint_workspace("mrun_after_swap"),
        lambda: store.sweep_uncollected_workspaces(set()),
        lambda: store.get_blob(stored),
    ):
        with pytest.raises(workspace.WorkspaceError) as caught:
            operation()
        assert str(tmp_path) not in str(caught.value)
    assert sorted(entry.name for entry in decoy.iterdir()) == []

    # 2. A REAL replacement directory at the same pathname is refused too: the
    #    pinned inode, not the name, is what identifies the root.
    root.unlink()
    root.mkdir()
    with pytest.raises(workspace.WorkspaceError):
        store.put_blob(b"third blob\n")
    assert sorted(entry.name for entry in root.iterdir()) == []


def test_a_swapped_root_refuses_to_hand_out_an_assigned_cwd(lifecycle, tmp_path):
    """No assigned cwd and no dispatch claim come out of an unverified root."""
    store = lifecycle["store"]
    run = begin_production(lifecycle)
    assert store.workspace_cwd(run["run_id"]) == run["cwd"]

    decoy = tmp_path / "decoy"
    decoy.mkdir()
    _remove_tree(Path(lifecycle["artifact_root"]))
    Path(lifecycle["artifact_root"]).symlink_to(decoy, target_is_directory=True)

    with pytest.raises(lifecycle["api"].WorkspaceError) as caught:
        store.workspace_cwd(run["run_id"])
    assert str(tmp_path) not in str(caught.value)

    with pytest.raises(lifecycle["api"].WorkspaceError):
        store.claim_dispatch(
            run["run_id"], kind=None, request_id="dispatch-1", session_id="session-producer-1"
        )
    assert sorted(entry.name for entry in decoy.iterdir()) == []


@pytest.mark.parametrize(
    "plant",
    ["wrong_bytes", "truncated", "symlink", "hard_link", "unreadable_mode"],
)
def test_an_invalid_preexisting_blob_entry_is_replaced_with_verified_bytes(tmp_path, plant):
    """A name under sha256/ proves nothing: the stored bytes are re-hashed.

    Trusting the NAME let anyone pre-plant a path and have the server record
    metadata for bytes it never wrote.
    """
    workspace = load_workspace()
    store = workspace.ArtifactStore(tmp_path / "artifacts")
    payload = b"the real deterministic package bytes\n"
    expected = digest(payload)
    path = store.blob_path(expected)
    path.parent.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"attacker owned\n")

# health: allow HX011 -- the explicit adversarial fixture ladder documents each distinct hostile filesystem object under test
    if plant == "wrong_bytes":
        path.write_bytes(b"not the package at all\n")
    elif plant == "truncated":
        path.write_bytes(payload[:7])
    elif plant == "symlink":
        path.symlink_to(outside)
    elif plant == "hard_link":
        os.link(outside, path)
    else:
        path.write_bytes(payload)
        path.chmod(0o000)

    assert store.put_blob(payload) == expected
    assert store.get_blob(expected) == payload
    assert store.has_blob(expected) is True

    # The replacement is a fresh single-link regular file, and nothing was
    # written through the link or into the attacker's file.
    info = os.lstat(path)
    assert stat.S_ISREG(info.st_mode)
    assert info.st_nlink == 1
    assert outside.read_bytes() == b"attacker owned\n"


def test_a_directory_in_a_blob_slot_fails_instead_of_being_silently_accepted(tmp_path):
    """An entry that cannot be safely replaced fails loudly, writing nothing."""
    workspace = load_workspace()
    store = workspace.ArtifactStore(tmp_path / "artifacts")
    payload = b"package bytes needing a slot\n"
    path = store.blob_path(digest(payload))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir()
    (path / "occupied.txt").write_bytes(b"not package bytes\n")

    with pytest.raises(workspace.WorkspaceError) as caught:
        store.put_blob(payload)

    assert str(tmp_path) not in str(caught.value)
    assert (path / "occupied.txt").read_bytes() == b"not package bytes\n"
    assert store.has_blob(digest(payload)) is False
    # Nothing was left behind in staging either.
    assert sorted(entry.name for entry in (Path(store.root) / "staging").iterdir()) == []


def test_a_hostile_blob_slot_fails_collection_before_any_metadata(lifecycle):
    """Collection commits no artifact version when the bytes cannot be stored."""
    workspace = load_workspace()
    store = lifecycle["store"]
    artifacts = workspace.ArtifactStore(lifecycle["artifact_root"])
    run = begin_production(lifecycle)
    write_package_tree(run["cwd"])

    # Learn the deterministic package digest, then make its slot unusable.
    built = artifacts.collect_workspace(
        run["run_id"],
        workspace_identity=(
            int(run["workspace_identity"]["device"]),
            int(run["workspace_identity"]["inode"]),
        ),
        output_identity=(
            int(run["workspace_identity"]["output_device"]),
            int(run["workspace_identity"]["output_inode"]),
        ),
    )
    path = artifacts.blob_path(built.zip_sha256)
    path.unlink()
    path.mkdir()
    (path / "decoy.txt").write_bytes(b"decoy\n")

    with pytest.raises(lifecycle["api"].CollectionFailed):
        store.collect_run(run["run_id"], claim_token=run["claim_token"])

    # No artifact version, no blob row, and the run is still collectable.
    assert store.list_versions(run["output_id"]) == []
    assert store.get_output(run["output_id"])["current_artifact_version"] == 0
    assert store.get_run(run["run_id"])["state"] == "open"
    with sqlite3.connect(lifecycle["db_path"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM meeting_output_blobs").fetchone()[0] == 0

    # Once the slot is usable again, collection stores the verified bytes.
    _remove_tree(path)
    receipt = store.collect_run(run["run_id"], claim_token=run["claim_token"])
    assert receipt["zip_sha256"] == built.zip_sha256
    assert digest(store.package_bytes(run["output_id"], 1)) == built.zip_sha256


# ---------------------------------------------------------------------------
# workspace sweep: grace, publication race, and durable recheck
# ---------------------------------------------------------------------------


def test_a_minted_workspace_is_never_swept_before_its_run_is_published(lifecycle):
    """A sweep racing an in-flight mint must not take the assigned cwd.

    The workspace exists on disk as soon as it is minted, but the run row is
    invisible to any other connection until the lifecycle transaction commits.
    A sweep that only consulted committed state would delete the cwd the
    dispatcher is about to hand to a producer.
    """
    store = lifecycle["store"]
    minted = threading.Event()
    release = threading.Event()
    captured: dict[str, object] = {}
    failures: list[BaseException] = []

    def mutate(connection):
        created = store.begin_production_run(
            meeting_id=MEETING_ID,
            expected_meeting_version=lifecycle["meeting_version"],
            producer_session_id="session-producer-1",
            submission_id="submission-race-1",
            connection=connection,
        )
        captured.update(created)
        minted.set()
        # The row is still uncommitted here: this is the whole window.
        assert release.wait(10)
        return created

    def publish():
        try:
            store.run_idempotent(
                action="production.run",
                key="race-key",
                request_hash="race-hash",
                mutate=mutate,
            )
        except BaseException as exc:  # pragma: no cover - surfaced below
            failures.append(exc)
            minted.set()

    thread = threading.Thread(target=publish)
    thread.start()
    try:
        assert minted.wait(10)
        assert not failures, failures
        swept = store.sweep_workspaces()
    finally:
        release.set()
        thread.join(10)

    assert not failures, failures
    assert captured["run_id"] not in swept
    assert Path(str(captured["cwd"])).is_dir()
    # The published run keeps its workspace on the next sweep too.
    assert captured["run_id"] not in store.sweep_workspaces()
    assert Path(str(captured["cwd"])).is_dir()


def test_an_abandoned_workspace_is_reclaimed_only_after_the_grace_cutoff(lifecycle):
    """An unreferenced workspace is young-until-proven-old, then reclaimed."""
    workspace = load_workspace()
    store = lifecycle["store"]
    artifacts = workspace.ArtifactStore(lifecycle["artifact_root"])
    abandoned = artifacts.mint_workspace("mrun_abandoned")

    # No durable run references it, but it is inside the grace cutoff.
    assert store.sweep_workspaces() == []
    assert abandoned.cwd.is_dir()

    aged = time.time() - (workspace.WORKSPACE_SWEEP_GRACE_SECONDS + 60)
    os.utime(abandoned.cwd, (aged, aged))

    assert store.sweep_workspaces() == ["mrun_abandoned"]
    assert not abandoned.cwd.exists()


def test_an_open_run_keeps_its_workspace_however_old_it_gets(lifecycle):
    """Age is never a reason to take a workspace a durable open run needs."""
    store = lifecycle["store"]
    run = begin_production(lifecycle)
    aged = time.time() - (load_workspace().WORKSPACE_SWEEP_GRACE_SECONDS + 86_400)
    os.utime(run["cwd"], (aged, aged))

    assert store.sweep_workspaces() == []
    assert Path(run["cwd"]).is_dir()
    assert (Path(run["cwd"]) / "output").is_dir()


def test_the_sweep_rechecks_durable_state_immediately_before_deleting(lifecycle):
    """A run published after the listing keeps its workspace."""
    workspace = load_workspace()
    artifacts = workspace.ArtifactStore(lifecycle["artifact_root"])
    minted = artifacts.mint_workspace("mrun_published_late")
    aged = time.time() - (workspace.WORKSPACE_SWEEP_GRACE_SECONDS + 60)
    os.utime(minted.cwd, (aged, aged))
    answers = {"count": 0}

    def durable_state():
        answers["count"] += 1
        if answers["count"] == 1:
            # The listing snapshot: nothing durable references the workspace.
            return set(), set()
        # By the recheck the run has committed as an open run.
        return {"mrun_published_late"}, {"mrun_published_late"}

    removed = artifacts.sweep_uncollected_workspaces(durable_state=durable_state)

    assert removed == []
    assert minted.cwd.is_dir()
    assert answers["count"] >= 2


def test_the_sweep_is_bounded_and_reports_only_what_it_removed(lifecycle):
    """A sweep removes at most its bound, so a huge root cannot stall a start."""
    workspace = load_workspace()
    artifacts = workspace.ArtifactStore(lifecycle["artifact_root"])
    aged = time.time() - (workspace.WORKSPACE_SWEEP_GRACE_SECONDS + 60)
    for index in range(workspace.MAX_SWEEP_REMOVALS + 3):
        minted = artifacts.mint_workspace(f"mrun_abandoned_{index:03d}")
        os.utime(minted.cwd, (aged, aged))

    first = artifacts.sweep_uncollected_workspaces(set())
    assert len(first) == workspace.MAX_SWEEP_REMOVALS
    second = artifacts.sweep_uncollected_workspaces(set())
    assert len(second) == 3
    assert set(first) & set(second) == set()
    assert artifacts.sweep_uncollected_workspaces(set()) == []
