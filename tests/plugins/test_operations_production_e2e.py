"""Real local end-to-end route for the public production-meeting vertical.

Everything here is real: the authenticated Operations ASGI app, HTTP over an
ASGI transport, a temporary SQLite database, a temporary artifact root, a real
producer file tree on the filesystem, real hashing, real deterministic package
building, real authorization, and a real ZIP download.

Only the identities are synthetic — generated dummy routes, no model text
generation, and no private topology.
"""

import asyncio
import hashlib
import importlib.util
import itertools
import json
import os
import sqlite3
import sys
import time
import zipfile
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, HTTPException

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"

LOCAL = "local"
ORCHESTRATOR = {"connection": LOCAL, "profile": "orchestrator-bot"}
PRODUCER = {"connection": LOCAL, "profile": "producer-bot"}
REVIEWER = {"connection": LOCAL, "profile": "reviewer-bot"}

MEETING_ID = "meeting_e2e_onboarding"
SECOND_MEETING_ID = "meeting_e2e_onboarding_two"
BRIEF = "Produce a one-page onboarding guide whose every step is reproducible."
ACCEPTANCE = "An independent reviewer confirms every onboarding step is reproducible."

PRIMARY_BODY = b"1. Install Hermes.\n2. Create a profile.\n3. Start a meeting.\n"
SUPPORT_BODY = b"- install verified\n- profile verified\n- meeting verified\n"
REVISED_BODY = PRIMARY_BODY + b"4. Produce a deliverable.\n"


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_api():
    module_path = DASHBOARD / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("operations_plugin_api_e2e", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Client:
    """A tiny synchronous driver over the real authenticated ASGI app.

    Every output-lifecycle mutation REQUIRES an ``Idempotency-Key``, so a
    distinct one is supplied unless the caller pins its own (replay and
    conflict tests do) or asks for none with ``idempotency=False``.
    """

    def __init__(self, app: FastAPI):
        self.app = app
        self._serial = itertools.count(1)

    def request(self, method: str, path: str, payload=None, headers=None, *, idempotency=True):
        sent = dict(headers or {})
        if idempotency and method.upper() == "POST" and "Idempotency-Key" not in sent:
            sent["Idempotency-Key"] = f"e2e-auto-key-{next(self._serial)}"

        async def run():
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://operations.test"
            ) as client:
                return await client.request(method, path, json=payload, headers=sent)

        return asyncio.run(run())

    def json(self, method: str, path: str, payload=None, headers=None, expect=200, **kwargs):
        response = self.request(method, path, payload, headers, **kwargs)
        assert response.status_code == expect, (path, response.status_code, response.text)
        return response.json()


def production_meeting(**overrides):
    record = {
        "id": MEETING_ID,
        "source": {"connection": LOCAL, "profile": "default"},
        "title": "Ship the onboarding guide",
        "agenda": "Produce, review, and approve the onboarding guide.",
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
            {"bot": REVIEWER, "role": "reviewer", "label": "Independent reviewer"},
        ],
        "product_kind": "document",
        "output_title": "Onboarding guide",
        "acceptance_statement": ACCEPTANCE,
    }
    record.update(overrides)
    return record


def write_producer_tree(cwd: str, files: dict[str, bytes], *, primary: str):
    """Act as the producer: write a real output tree in the assigned cwd."""
    output = Path(cwd) / "output"
    output.mkdir(parents=True, exist_ok=True)
    for relative, payload in files.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    manifest = {
        "schema": "deliverable_package_v1",
        "product_kind": "document",
        "title": "Onboarding guide",
        "summary": "A one-page onboarding guide.",
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
def operations(tmp_path, monkeypatch):
    """Boot the real authenticated Operations app over temporary state."""
    api = load_api()
    home = tmp_path / "hermes-home"
    (home / "operations").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(api, "get_hermes_home", lambda: home)
    monkeypatch.setattr(api, "_meeting_db_path", lambda: home / "operations" / "meetings.db")
    monkeypatch.setattr(api, "_artifact_root", lambda: home / "operations" / "artifacts")
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: home / "operations" / "harness_agents.db")

    app = FastAPI()
    # Local owner mode: the installation owner key is the authenticated
    # principal, exactly as the shipped loopback path resolves it.
    app.state.auth_required = False
    app.include_router(api.router)
    return {"api": api, "app": app, "client": Client(app), "home": home}


def start_production(operations, meeting_id: str = MEETING_ID, suffix: str = "1"):
    """create -> start -> freeze brief -> produce -> collect."""
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{meeting_id}",
        {"record": production_meeting(id=meeting_id), "expected_version": 0},
    )
    assert created["meeting"]["schema_version"] == 2
    assert created["meeting"]["production_stage"] == "briefing"

    frozen = client.json(
        "POST", f"/meetings/{meeting_id}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": ["note://round-1"]},
    )
    assert frozen["production_stage"] == "production_ready"
    assert frozen["brief_hash"] == digest(BRIEF.encode("utf-8"))

    run = client.json(
        "POST", f"/meetings/{meeting_id}/production-runs",
        {
            "expected_version": frozen["meeting_version"],
            "producer_session_id": f"session-producer-e2e-{suffix}",
            "submission_id": f"submission-e2e-{suffix}",
        },
    )
    # The authenticated dispatcher response carries the assigned cwd it must
    # hand the producer session, and never the single-use collection claim.
    assert run["cwd"]
    assert "collection_claim" not in run
    assert "claim_token" not in run

    claim = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": f"dispatch-{suffix}", "session_id": f"session-producer-e2e-{suffix}"},
    )
    assert claim["brief"] == BRIEF
    assert claim["producer"] == PRODUCER

    write_producer_tree(
        claim["workspace"]["cwd"],
        {"index.txt": PRIMARY_BODY, "notes/checklist.txt": SUPPORT_BODY},
        primary="index.txt",
    )
    collected = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": claim["collection_claim"]},
    )
    return {"run": run, "claim": claim, "collected": collected, "frozen": frozen}


def open_review(operations, output_id: str, *, suffix: str = "1"):
    """Open a review AND claim its dispatch, exactly as a dispatcher must."""
    client = operations["client"]
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    review = client.json(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": REVIEWER},
    )
    client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim",
        {"request_id": f"review-dispatch-{suffix}", "session_id": f"session-reviewer-{suffix}"},
    )
    return review


def test_full_production_route_from_create_to_download(operations):
    client = operations["client"]
    started = start_production(operations)
    run = started["run"]
    receipt = started["collected"]["receipt"]
    output_id = run["output_id"]

    # --- collection produced immutable artifact version 1 -----------------
    assert receipt["artifact_version"] == 1
    assert receipt["game_sha256"] == digest(PRIMARY_BODY)
    assert started["collected"]["output"]["state"] == "reviewing"
    assert client.json("GET", f"/meetings/{MEETING_ID}")["meeting"]["production_stage"] == "reviewing"

    listed = client.json("GET", f"/meetings/{MEETING_ID}/outputs")
    assert [row["output"]["output_id"] for row in listed["outputs"]] == [output_id]
    assert listed["outputs"][0]["eligibility"]["review"] is True
    assert listed["outputs"][0]["eligibility"]["approve"] is False

    versions = client.json("GET", f"/meeting-outputs/{output_id}/versions")["versions"]
    assert [row["artifact_version"] for row in versions] == [1]
    assert versions[0]["manifest"]["primary_file"] == "index.txt"

    # --- independent review ------------------------------------------------
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    refused = client.request(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": PRODUCER},
    )
    assert refused.status_code == 403
    assert refused.json()["detail"] == {"error": "operations_reviewer_not_eligible"}

    review = client.json(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": REVIEWER},
    )
    assert review["artifact_version"] == 1
    assert review["checks"]["ok"] is True
    assert review["zip_sha256"] == receipt["zip_sha256"]

    review_claim = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim",
        {"request_id": "review-dispatch-1", "session_id": "session-reviewer-e2e"},
    )
    # A reviewer gets a read-only summary, never a writable workspace path.
    assert "workspace" not in review_claim
    assert "collection_claim" not in review_claim
    assert review_claim["artifact_summary"]["files"][0]["path"] == "index.txt"

    completed = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert completed["output"]["state"] == "verified"
    assert completed["eligibility"]["approve"] is True
    assert client.json("GET", f"/meetings/{MEETING_ID}")["meeting"]["production_stage"] == "approval_ready"

    # --- exact owner approval ---------------------------------------------
    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    approval = {
        "meeting_id": MEETING_ID,
        "expected_meeting_version": meeting["version"],
        "expected_output_version": output["version"],
        "artifact_version": 1,
        "game_sha256": receipt["game_sha256"],
        "manifest_sha256": receipt["manifest_sha256"],
        "zip_sha256": receipt["zip_sha256"],
    }
    approved = client.json("POST", f"/meeting-outputs/{output_id}/approve", approval)

    assert approved["output"]["state"] == "approved"
    assert approved["meeting"]["state"] == "completed"
    assert approved["meeting"]["production_stage"] == "completed"
    binding = approved["meeting"]["artifact_binding"]
    assert binding["approved_by"] == "Owner"
    assert binding["artifact_version"] == 1
    assert binding["game_sha256"] == receipt["game_sha256"]
    assert binding["manifest_sha256"] == receipt["manifest_sha256"]
    assert binding["zip_sha256"] == receipt["zip_sha256"]

    bound = client.json("GET", f"/meetings/{MEETING_ID}")
    assert bound["meeting"]["artifact_binding"] == binding
    assert bound["meeting"]["state"] == "completed"

    # --- safe preview ------------------------------------------------------
    preview = client.request(
        "GET", f"/meeting-outputs/{output_id}/versions/1/files/index.txt"
    )
    assert preview.status_code == 200
    assert preview.content == PRIMARY_BODY
    assert preview.headers["content-type"].startswith("text/plain")
    assert preview.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in preview.headers["content-security-policy"]
    assert preview.headers["content-disposition"] == "inline"
    assert preview.headers["x-hermes-artifact-sha256"] == digest(PRIMARY_BODY)

    for traversal in ("../../etc/passwd", "..%2F..%2Fetc%2Fpasswd", "missing.txt"):
        refused = client.request(
            "GET", f"/meeting-outputs/{output_id}/versions/1/files/{traversal}"
        )
        assert refused.status_code == 404, traversal
        assert "passwd" not in json.dumps(refused.json())

    # --- real download -----------------------------------------------------
    download = client.request("GET", f"/meeting-outputs/{output_id}/versions/1/download")
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/zip"
    assert download.headers["content-disposition"] == 'attachment; filename="deliverable-v1.zip"'
    assert download.headers["x-hermes-artifact-status"] == "approved"
    assert digest(download.content) == receipt["zip_sha256"]
    with zipfile.ZipFile(BytesIO(download.content)) as archive:
        assert archive.namelist() == ["deliverable.json", "index.txt", "notes/checklist.txt"]
        assert archive.read("index.txt") == PRIMARY_BODY
        assert digest(archive.read("deliverable.json")) == receipt["manifest_sha256"]

    # --- restart: a brand new app over the same durable state --------------
    restarted = FastAPI()
    restarted.state.auth_required = False
    restarted.include_router(operations["api"].router)
    after = Client(restarted)
    assert after.json("GET", f"/meetings/{MEETING_ID}")["meeting"]["artifact_binding"] == binding
    recovered = after.json("GET", f"/meeting-outputs/{output_id}/recovery")
    assert recovered["output"]["state"] == "approved"
    assert recovered["active_run"] is None
    assert recovered["receipt"]["zip_sha256"] == receipt["zip_sha256"]
    again = after.request("GET", f"/meeting-outputs/{output_id}/versions/1/download")
    assert digest(again.content) == receipt["zip_sha256"]

    # No host path, claim token, or principal digest in any public response.
    surface = json.dumps([listed, versions, completed, approved, bound, recovered])
    assert str(operations["home"]) not in surface
    assert "collection_claim" not in surface
    assert "approver_digest" not in surface


def test_production_cannot_complete_through_a_client_put_or_generic_conclude(operations):
    client = operations["client"]
    started = start_production(operations)
    meeting = client.json("GET", f"/meetings/{MEETING_ID}")

    forged = dict(meeting["meeting"])
    forged["state"] = "completed"
    forged["decisions"] = [{"id": "d1", "text": "Shipped.", "evidence_refs": []}]
    refused = client.request(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": forged, "expected_version": meeting["version"]},
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == {"error": "operations_invalid_transition"}

    fabricated = dict(meeting["meeting"])
    fabricated["artifact_binding"] = {
        "output_id": started["run"]["output_id"],
        "artifact_version": 1,
        "game_sha256": digest(PRIMARY_BODY),
        "manifest_sha256": started["collected"]["receipt"]["manifest_sha256"],
        "zip_sha256": started["collected"]["receipt"]["zip_sha256"],
        "approved_by": "Owner",
        "approved_at": 1_800_000_000,
    }
    fabricated["state"] = "completed"
    refused = client.request(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": fabricated, "expected_version": meeting["version"]},
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == {"error": "operations_server_owned_field"}

    stage_forged = dict(meeting["meeting"])
    stage_forged["production_stage"] = "approval_ready"
    refused = client.request(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": stage_forged, "expected_version": meeting["version"]},
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == {"error": "operations_server_owned_field"}

    # The meeting is untouched by every refusal.
    assert client.json("GET", f"/meetings/{MEETING_ID}") == meeting


def test_stale_and_mismatched_approval_requests_return_409_and_write_nothing(operations):
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    receipt = started["collected"]["receipt"]
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    client.json(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": REVIEWER},
    )
    review_id = client.json("GET", f"/meeting-outputs/{output_id}")["reviews"][0]["request_id"]
    client.json(
        "POST", f"/meeting-output-review-runs/{review_id}/claim",
        {"request_id": "review-dispatch-1", "session_id": "session-reviewer-1"},
    )
    client.json(
        "POST", f"/meeting-output-review-runs/{review_id}/complete",
        {"verdict": "verified", "findings": []},
    )

    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    base = {
        "meeting_id": MEETING_ID,
        "expected_meeting_version": meeting["version"],
        "expected_output_version": output["version"],
        "artifact_version": 1,
        "game_sha256": receipt["game_sha256"],
        "manifest_sha256": receipt["manifest_sha256"],
        "zip_sha256": receipt["zip_sha256"],
    }

    for field, value in (
        ("expected_meeting_version", meeting["version"] + 7),
        ("expected_output_version", output["version"] + 7),
        ("artifact_version", 2),
        ("game_sha256", "d" * 64),
        ("manifest_sha256", "d" * 64),
        ("zip_sha256", "d" * 64),
    ):
        refused = client.request(
            "POST", f"/meeting-outputs/{output_id}/approve", {**base, field: value}
        )
        assert refused.status_code == 409, field
        assert client.json("GET", f"/meetings/{MEETING_ID}") == meeting
        assert client.json("GET", f"/meeting-outputs/{output_id}")["output"] == output

    approved = client.json("POST", f"/meeting-outputs/{output_id}/approve", base)
    assert approved["output"]["state"] == "approved"


def test_lifecycle_requests_replay_by_idempotency_key_and_conflict_on_change(operations):
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
    )
    payload = {
        "expected_version": frozen["meeting_version"],
        "producer_session_id": "session-producer-e2e",
        "submission_id": "submission-idem-1",
    }
    headers = {"Idempotency-Key": "run-key-1"}

    first = client.json("POST", f"/meetings/{MEETING_ID}/production-runs", payload, headers)
    replay = client.json("POST", f"/meetings/{MEETING_ID}/production-runs", payload, headers)
    assert replay == first

    # Exactly one run and one output exist despite two identical requests.
    assert len(client.json("GET", f"/meetings/{MEETING_ID}/outputs")["outputs"]) == 1

    conflict = client.request(
        "POST", f"/meetings/{MEETING_ID}/production-runs",
        {**payload, "submission_id": "submission-idem-2"}, headers,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {"error": "operations_idempotency_conflict"}

    # Collection replays identically too, without a second artifact version.
    claim = client.json(
        "POST", f"/meeting-output-runs/{first['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-e2e"},
    )
    write_producer_tree(
        claim["workspace"]["cwd"], {"index.txt": PRIMARY_BODY}, primary="index.txt"
    )
    collect_headers = {"Idempotency-Key": "collect-key-1"}
    collected = client.json(
        "POST", f"/meeting-output-runs/{first['run_id']}/collect",
        {"collection_claim": claim["collection_claim"]}, collect_headers,
    )
    again = client.json(
        "POST", f"/meeting-output-runs/{first['run_id']}/collect",
        {"collection_claim": claim["collection_claim"]}, collect_headers,
    )
    assert again == collected
    assert len(client.json("GET", f"/meeting-outputs/{first['output_id']}/versions")["versions"]) == 1


def test_a_replayed_key_returns_the_exact_response_after_a_restart(operations):
    """The stored response survives the process that produced it."""
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    body = {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []}
    headers = {"Idempotency-Key": "brief-restart-key"}
    first = client.json("POST", f"/meetings/{MEETING_ID}/production-brief", body, headers)

    restarted = FastAPI()
    restarted.state.auth_required = False
    restarted.include_router(operations["api"].router)
    after = Client(restarted)

    assert after.json("POST", f"/meetings/{MEETING_ID}/production-brief", body, headers) == first
    # One freeze happened: the replay did not bump the meeting again.
    assert after.json("GET", f"/meetings/{MEETING_ID}")["version"] == first["meeting_version"]

    conflict = after.request(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {**body, "brief": BRIEF + " Changed."}, headers,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {"error": "operations_idempotency_conflict"}
    assert after.json("GET", f"/meetings/{MEETING_ID}")["meeting"]["production_stage"] == (
        "production_ready"
    )


def test_the_output_list_route_returns_exactly_output_and_eligibility(operations):
    """Pin the list contract the renderer is written against."""
    client = operations["client"]
    started = start_production(operations)

    listed = client.json("GET", f"/meetings/{MEETING_ID}/outputs")
    assert set(listed) == {"meeting_id", "outputs"}
    assert len(listed["outputs"]) == 1
    row = listed["outputs"][0]
    assert set(row) == {"output", "eligibility"}
    assert row["output"]["output_id"] == started["run"]["output_id"]
    assert set(row["eligibility"]) == {
        "produce", "review", "revise", "approve", "preview", "download"
    }

    # The full detail -- versions and reviews -- comes from the detail route.
    detail = client.json("GET", f"/meeting-outputs/{started['run']['output_id']}")
    assert set(detail) == {"output", "eligibility", "versions", "reviews"}
    assert [version["artifact_version"] for version in detail["versions"]] == [1]


def test_a_request_cannot_carry_a_producer_chosen_workspace_path(operations):
    """The run request model has no path field, and refuses a smuggled one."""
    client = operations["client"]
    api = operations["api"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
    )

    assert not set(api.ProductionRunRequest.model_fields) & {
        "cwd", "workspace", "workspace_root", "path", "root"
    }
    assert not set(api.RevisionRunRequest.model_fields) & {
        "cwd", "workspace", "workspace_root", "path", "root"
    }

    attacker = str(operations["home"] / "attacker")
    for smuggled in ("cwd", "workspace", "workspace_root", "path"):
        refused = client.request(
            "POST", f"/meetings/{MEETING_ID}/production-runs",
            {
                "expected_version": frozen["meeting_version"],
                "producer_session_id": "session-producer-e2e",
                "submission_id": f"submission-smuggled-{smuggled}",
                smuggled: attacker,
            },
        )
        assert refused.status_code == 422, smuggled
        assert client.json("GET", f"/meetings/{MEETING_ID}/outputs")["outputs"] == []
        assert not Path(attacker).exists()

    # The honest request still works, and the cwd it is handed is the server's.
    run = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-runs",
        {
            "expected_version": frozen["meeting_version"],
            "producer_session_id": "session-producer-e2e",
            "submission_id": "submission-honest",
        },
    )
    claim = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-e2e"},
    )
    assigned = Path(claim["workspace"]["cwd"]).resolve()
    artifacts = (operations["home"] / "operations" / "artifacts").resolve()
    assert assigned.is_relative_to(artifacts)
    assert assigned == artifacts / "workspaces" / run["run_id"]


def test_the_create_run_response_carries_the_cwd_and_nothing_secret(operations):
    """The dispatcher needs the cwd BEFORE it can create a producer session."""
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
    )
    run = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-runs",
        {
            "expected_version": frozen["meeting_version"],
            "producer_session_id": "provisional-production-1",
            "submission_id": "submission-cwd-1",
        },
    )

    artifacts = (operations["home"] / "operations" / "artifacts").resolve()
    assert Path(run["cwd"]).resolve() == artifacts / "workspaces" / run["run_id"]
    assert (Path(run["cwd"]) / "output").is_dir()
    assert "collection_claim" not in run
    assert "claim_token" not in run

    # The cwd stays out of every normal DTO and out of recovery.
    listed = client.json("GET", f"/meetings/{MEETING_ID}/outputs")
    output = client.json("GET", f"/meeting-outputs/{run['output_id']}")
    recovered = client.json("GET", f"/meeting-outputs/{run['output_id']}/recovery")
    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    surface = json.dumps([listed, output, recovered, meeting])
    assert str(operations["home"]) not in surface
    assert "cwd" not in surface

    # A refusal never leaks it either.
    refused = client.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": "x" * 32},
    )
    assert refused.status_code == 403
    assert str(operations["home"]) not in refused.text
    assert "cwd" not in refused.text


def test_the_claim_binds_the_actual_producer_session_exactly_once(operations):
    """The provisional reference is replaced once, by the real session id."""
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
    )
    run = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-runs",
        {
            "expected_version": frozen["meeting_version"],
            "producer_session_id": "provisional-production-1",
            "submission_id": "submission-binding-1",
        },
    )

    claimed = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-actual"},
    )
    assert claimed["workspace"]["cwd"]
    assert claimed["collection_claim"]
    assert claimed["session_id"] == "session-producer-actual"

    # A different session cannot rebind the run or take its workspace.
    stolen = client.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-2", "session_id": "session-producer-thief"},
    )
    assert stolen.status_code == 403
    assert stolen.json()["detail"] == {"error": "operations_producer_session_mismatch"}
    assert "cwd" not in stolen.text
    assert "collection_claim" not in stolen.text
    assert str(operations["home"]) not in stolen.text

    # Restart: the real session is durable, and still the only one accepted.
    restarted = FastAPI()
    restarted.state.auth_required = False
    restarted.include_router(operations["api"].router)
    after = Client(restarted)

    again = after.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-2", "session_id": "session-producer-thief"},
    )
    assert again.status_code == 403
    assert again.json()["detail"] == {"error": "operations_producer_session_mismatch"}

    # The identical binding is the live dispatch, so the workspace is not
    # handed out a second time while that claim is unexpired.
    active = after.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-actual"},
    )
    assert active.status_code == 409
    assert active.json()["detail"] == {"error": "operations_claim_active"}
    assert "cwd" not in active.text

    # The durable checkpoint and the output now carry the REAL session.
    write_producer_tree(
        Path(run["cwd"]), {"index.txt": PRIMARY_BODY}, primary="index.txt"
    )
    collected = after.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": claimed["collection_claim"]},
    )
    assert collected["receipt"]["artifact_version"] == 1


def test_a_verdict_requires_the_durable_review_dispatch_claim(operations):
    """A mutation-capable caller cannot verdict a review nobody dispatched."""
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    review = client.json(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": REVIEWER},
    )

    refused = client.request(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert refused.status_code == 403
    assert refused.json()["detail"] == {"error": "operations_review_claim_required"}

    unchanged = client.json("GET", f"/meeting-outputs/{output_id}")
    assert unchanged["output"]["state"] == "reviewing"
    assert unchanged["output"]["verified_artifact_version"] == 0
    assert unchanged["reviews"][0]["state"] == "open"

    # Claiming the reviewer dispatch is what makes the verdict recordable.
    client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim",
        {"request_id": "review-dispatch-1", "session_id": "session-reviewer-1"},
    )
    completed = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert completed["review"]["verdict"] == "verified"
    assert completed["output"]["state"] == "verified"

    # The consumed claim cannot be replayed into a second verdict.
    replayed = client.request(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "changes_requested",
         "findings": [{"severity": "high", "code": "late", "detail": "Too late."}]},
    )
    assert replayed.status_code == 409
    assert client.json("GET", f"/meeting-outputs/{output_id}")["output"]["state"] == "verified"


def test_a_verdict_idempotency_key_never_replays_onto_another_review_run(operations):
    """Same key, same body, DIFFERENT resource: a conflict, never a foreign 200."""
    client = operations["client"]
    first = start_production(operations)
    second = start_production(operations, SECOND_MEETING_ID, suffix="2")
    output_one = first["run"]["output_id"]
    output_two = second["run"]["output_id"]

    review_one = open_review(operations, output_one, suffix="1")
    review_two = open_review(operations, output_two, suffix="2")

    key = {"Idempotency-Key": "shared-verdict-key"}
    verdict = {"verdict": "verified", "findings": []}

    completed = client.json(
        "POST", f"/meeting-output-review-runs/{review_one['request_id']}/complete", verdict, key
    )
    assert completed["review"]["request_id"] == review_one["request_id"]

    foreign = client.request(
        "POST", f"/meeting-output-review-runs/{review_two['request_id']}/complete", verdict, key
    )
    assert foreign.status_code == 409
    assert foreign.json()["detail"] == {"error": "operations_idempotency_conflict"}

    # The second output never received a verdict it did not earn.
    untouched = client.json("GET", f"/meeting-outputs/{output_two}")
    assert untouched["output"]["state"] == "reviewing"
    assert untouched["output"]["verified_artifact_version"] == 0
    assert untouched["reviews"][0]["state"] == "open"
    assert client.json("GET", f"/meetings/{SECOND_MEETING_ID}")["meeting"][
        "production_stage"
    ] == "reviewing"

    # Replaying the key against the review that earned it still returns it.
    assert client.json(
        "POST", f"/meeting-output-review-runs/{review_one['request_id']}/complete", verdict, key
    ) == completed


def test_an_approval_idempotency_key_never_replays_onto_another_output(operations):
    client = operations["client"]
    first = start_production(operations)
    second = start_production(operations, SECOND_MEETING_ID, suffix="2")
    output_one = first["run"]["output_id"]
    output_two = second["run"]["output_id"]
    receipt = first["collected"]["receipt"]

    review_one = open_review(operations, output_one, suffix="1")
    client.json(
        "POST", f"/meeting-output-review-runs/{review_one['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )

    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    output = client.json("GET", f"/meeting-outputs/{output_one}")["output"]
    body = {
        "meeting_id": MEETING_ID,
        "expected_meeting_version": meeting["version"],
        "expected_output_version": output["version"],
        "artifact_version": 1,
        "game_sha256": receipt["game_sha256"],
        "manifest_sha256": receipt["manifest_sha256"],
        "zip_sha256": receipt["zip_sha256"],
    }
    key = {"Idempotency-Key": "shared-approval-key"}

    approved = client.json("POST", f"/meeting-outputs/{output_one}/approve", body, key)
    assert approved["output"]["output_id"] == output_one

    # The identical body against a DIFFERENT output id must conflict instead of
    # echoing the first output's approval as though the second were approved.
    foreign = client.request("POST", f"/meeting-outputs/{output_two}/approve", body, key)
    assert foreign.status_code == 409
    assert foreign.json()["detail"] == {"error": "operations_idempotency_conflict"}

    still_unapproved = client.json("GET", f"/meeting-outputs/{output_two}")["output"]
    assert still_unapproved["state"] == "reviewing"
    assert still_unapproved["approved_artifact_version"] == 0
    second_meeting = client.json("GET", f"/meetings/{SECOND_MEETING_ID}")["meeting"]
    assert second_meeting["state"] != "completed"
    assert "artifact_binding" not in second_meeting


def test_every_lifecycle_key_is_scoped_to_its_own_path_resource(operations):
    """Every mutation hash carries its path identifiers, not just its body."""
    client = operations["client"]
    created_one = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    created_two = client.json(
        "PUT", f"/meetings/{SECOND_MEETING_ID}",
        {"record": production_meeting(id=SECOND_MEETING_ID), "expected_version": 0},
    )
    assert created_one["version"] == created_two["version"]

    # production.brief: identical body, two meetings.
    brief_body = {"expected_version": created_one["version"], "brief": BRIEF, "evidence_refs": []}
    brief_key = {"Idempotency-Key": "shared-brief-key"}
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief", brief_body, brief_key
    )
    foreign = client.request(
        "POST", f"/meetings/{SECOND_MEETING_ID}/production-brief", brief_body, brief_key
    )
    assert foreign.status_code == 409
    assert foreign.json()["detail"] == {"error": "operations_idempotency_conflict"}
    assert client.json("GET", f"/meetings/{SECOND_MEETING_ID}")["meeting"][
        "production_stage"
    ] == "briefing"

    # production.run: identical body, two meetings.
    client.json("POST", f"/meetings/{SECOND_MEETING_ID}/production-brief", brief_body)
    run_body = {
        "expected_version": frozen["meeting_version"],
        "producer_session_id": "session-producer-shared",
        "submission_id": "submission-shared",
    }
    run_key = {"Idempotency-Key": "shared-run-key"}
    run_one = client.json("POST", f"/meetings/{MEETING_ID}/production-runs", run_body, run_key)
    foreign = client.request(
        "POST", f"/meetings/{SECOND_MEETING_ID}/production-runs", run_body, run_key
    )
    assert foreign.status_code == 409
    assert client.json("GET", f"/meetings/{SECOND_MEETING_ID}/outputs")["outputs"] == []

    # run.collect: identical body, two runs.
    second_run = client.json(
        "POST", f"/meetings/{SECOND_MEETING_ID}/production-runs",
        {**run_body, "submission_id": "submission-shared-2"},
    )
    collection_claims = {}
    for run_id in (run_one["run_id"], second_run["run_id"]):
        claim = client.json(
            "POST", f"/meeting-output-runs/{run_id}/claim",
            {"request_id": f"dispatch-{run_id}", "session_id": "session-producer-shared"},
        )
        collection_claims[run_id] = claim["collection_claim"]
        write_producer_tree(
            claim["workspace"]["cwd"], {"index.txt": PRIMARY_BODY}, primary="index.txt"
        )
    collect_key = {"Idempotency-Key": "shared-collect-key"}
    client.json(
        "POST", f"/meeting-output-runs/{run_one['run_id']}/collect",
        {"collection_claim": collection_claims[run_one["run_id"]]}, collect_key,
    )
    foreign = client.request(
        "POST", f"/meeting-output-runs/{second_run['run_id']}/collect",
        {"collection_claim": collection_claims[second_run["run_id"]]}, collect_key,
    )
    assert foreign.status_code == 409
    assert client.json(
        "GET", f"/meeting-outputs/{second_run['output_id']}/versions"
    )["versions"] == []

    # review.run: identical body, two outputs.
    client.json(
        "POST", f"/meeting-output-runs/{second_run['run_id']}/collect",
        {"collection_claim": collection_claims[second_run["run_id"]]},
    )
    outputs = (run_one["output_id"], second_run["output_id"])
    review_body = {
        "expected_output_version": client.json(
            "GET", f"/meeting-outputs/{outputs[0]}"
        )["output"]["version"],
        "reviewer": REVIEWER,
    }
    review_key = {"Idempotency-Key": "shared-review-key"}
    opened = client.json(
        "POST", f"/meeting-outputs/{outputs[0]}/review-runs", review_body, review_key
    )
    foreign = client.request(
        "POST", f"/meeting-outputs/{outputs[1]}/review-runs", review_body, review_key
    )
    assert foreign.status_code == 409
    assert client.json("GET", f"/meeting-outputs/{outputs[1]}")["reviews"] == []

    # revision.run: identical body, two outputs.
    client.json(
        "POST", f"/meeting-output-review-runs/{opened['request_id']}/claim",
        {"request_id": "review-dispatch-shared", "session_id": "session-reviewer-shared"},
    )
    client.json(
        "POST", f"/meeting-output-review-runs/{opened['request_id']}/complete",
        {
            "verdict": "changes_requested",
            "findings": [{"severity": "high", "code": "missing", "detail": "Add the step."}],
        },
    )
    revision_body = {
        "expected_output_version": client.json(
            "GET", f"/meeting-outputs/{outputs[0]}"
        )["output"]["version"],
        "producer_session_id": "session-producer-revision",
    }
    revision_key = {"Idempotency-Key": "shared-revision-key"}
    client.json("POST", f"/meeting-outputs/{outputs[0]}/revision-runs", revision_body, revision_key)
    foreign = client.request(
        "POST", f"/meeting-outputs/{outputs[1]}/revision-runs", revision_body, revision_key
    )
    assert foreign.status_code == 409
    assert foreign.json()["detail"] == {"error": "operations_idempotency_conflict"}


def test_revision_creates_version_two_and_requires_a_fresh_review(operations):
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    first_receipt = started["collected"]["receipt"]

    review = open_review(operations, output_id, suffix="1")
    rejected = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {
            "verdict": "changes_requested",
            "findings": [{
                "severity": "high", "code": "missing_step",
                "detail": "The guide omits producing a deliverable.",
                "path": "index.txt",
            }],
        },
    )
    assert rejected["output"]["state"] == "changes_requested"
    assert rejected["output"]["findings"][0]["code"] == "missing_step"
    assert rejected["eligibility"]["revise"] is True
    assert rejected["eligibility"]["approve"] is False

    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    revision = client.json(
        "POST", f"/meeting-outputs/{output_id}/revision-runs",
        {"expected_output_version": output["version"], "producer_session_id": "session-producer-2"},
    )
    assert revision["parent_artifact_version"] == 1

    revision_claim = client.json(
        "POST", f"/meeting-output-revision-runs/{revision['run_id']}/claim",
        {"request_id": "dispatch-2", "session_id": "session-producer-2"},
    )
    write_producer_tree(
        revision_claim["workspace"]["cwd"],
        {"index.txt": REVISED_BODY, "notes/checklist.txt": SUPPORT_BODY},
        primary="index.txt",
    )
    second = client.json(
        "POST", f"/meeting-output-revision-runs/{revision['run_id']}/collect",
        {"collection_claim": revision_claim["collection_claim"]},
    )["receipt"]

    assert second["artifact_version"] == 2
    assert second["parent_artifact_version"] == 1
    assert second["game_sha256"] == digest(REVISED_BODY)

    # Version 1 survives byte-for-byte with its own digests and lineage.
    versions = client.json("GET", f"/meeting-outputs/{output_id}/versions")["versions"]
    assert [row["artifact_version"] for row in versions] == [1, 2]
    assert versions[0]["game_sha256"] == first_receipt["game_sha256"]
    assert versions[0]["parent_artifact_version"] is None
    assert versions[1]["parent_artifact_version"] == 1
    old = client.request("GET", f"/meeting-outputs/{output_id}/versions/1/download")
    assert digest(old.content) == first_receipt["zip_sha256"]

    # Version 2 clears verification and cannot reuse version 1's review.
    refreshed = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    assert refreshed["state"] == "reviewing"
    assert refreshed["verified_artifact_version"] == 0
    stale = client.request(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert stale.status_code == 409

    # Approving version 2 requires its own independent review.
    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    premature = client.request(
        "POST", f"/meeting-outputs/{output_id}/approve",
        {
            "meeting_id": MEETING_ID,
            "expected_meeting_version": meeting["version"],
            "expected_output_version": refreshed["version"],
            "artifact_version": 2,
            "game_sha256": second["game_sha256"],
            "manifest_sha256": second["manifest_sha256"],
            "zip_sha256": second["zip_sha256"],
        },
    )
    assert premature.status_code == 409

    fresh = open_review(operations, output_id, suffix="2")
    assert fresh["artifact_version"] == 2
    client.json(
        "POST", f"/meeting-output-review-runs/{fresh['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    meeting = client.json("GET", f"/meetings/{MEETING_ID}")
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    approved = client.json(
        "POST", f"/meeting-outputs/{output_id}/approve",
        {
            "meeting_id": MEETING_ID,
            "expected_meeting_version": meeting["version"],
            "expected_output_version": output["version"],
            "artifact_version": 2,
            "game_sha256": second["game_sha256"],
            "manifest_sha256": second["manifest_sha256"],
            "zip_sha256": second["zip_sha256"],
        },
    )
    assert approved["meeting"]["artifact_binding"]["artifact_version"] == 2


def test_tampering_with_stored_bytes_fails_review_download_and_preview(operations):
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    receipt = started["collected"]["receipt"]

    blobs = operations["home"] / "operations" / "artifacts" / "sha256"
    blob = blobs / receipt["zip_sha256"][:2] / receipt["zip_sha256"]
    blob.write_bytes(blob.read_bytes()[:-8] + b"tampered")

    review = open_review(operations, output_id, suffix="1")
    assert review["checks"]["ok"] is False

    refused = client.request(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert refused.status_code == 422
    assert refused.json()["detail"] == {"error": "operations_deterministic_check_failed"}

    for path in (
        f"/meeting-outputs/{output_id}/versions/1/download",
        f"/meeting-outputs/{output_id}/versions/1/files/index.txt",
    ):
        broken = client.request("GET", path)
        assert broken.status_code == 422
        assert broken.json()["detail"] == {"error": "operations_artifact_unavailable"}


def test_every_output_route_requires_authentication(tmp_path, monkeypatch):
    api = load_api()
    home = tmp_path / "hermes-home"
    (home / "operations").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(api, "get_hermes_home", lambda: home)
    monkeypatch.setattr(api, "_meeting_db_path", lambda: home / "operations" / "meetings.db")
    monkeypatch.setattr(api, "_artifact_root", lambda: home / "operations" / "artifacts")
    monkeypatch.setattr(api, "_a2a_registry_path", lambda: home / "operations" / "harness_agents.db")

    # auth_required is absent: the app is NOT in local owner mode and carries
    # no token or session principal, so every route must refuse.
    app = FastAPI()
    app.include_router(api.router)
    client = Client(app)

    unauthenticated = [
        ("GET", "/meetings", None),
        ("GET", f"/meetings/{MEETING_ID}", None),
        ("PUT", f"/meetings/{MEETING_ID}", {"record": production_meeting(), "expected_version": 0}),
        ("GET", f"/meetings/{MEETING_ID}/outputs", None),
        ("GET", "/meeting-outputs/mout_1", None),
        ("GET", "/meeting-outputs/mout_1/versions", None),
        ("GET", "/meeting-outputs/mout_1/recovery", None),
        ("POST", f"/meetings/{MEETING_ID}/production-brief",
         {"expected_version": 1, "brief": BRIEF, "evidence_refs": []}),
        ("POST", f"/meetings/{MEETING_ID}/production-runs",
         {"expected_version": 1, "producer_session_id": "s", "submission_id": "x"}),
        ("POST", "/meeting-output-runs/mrun_1/claim", {"request_id": "r", "session_id": "s"}),
        ("POST", "/meeting-output-runs/mrun_1/collect", {"collection_claim": "x" * 32}),
        ("POST", "/meeting-outputs/mout_1/review-runs",
         {"expected_output_version": 1, "reviewer": REVIEWER}),
        ("POST", "/meeting-output-review-runs/mrev_1/claim", {"request_id": "r", "session_id": "s"}),
        ("POST", "/meeting-output-review-runs/mrev_1/complete", {"verdict": "verified", "findings": []}),
        ("POST", "/meeting-outputs/mout_1/revision-runs",
         {"expected_output_version": 1, "producer_session_id": "s"}),
        ("POST", "/meeting-output-revision-runs/mrun_1/claim", {"request_id": "r", "session_id": "s"}),
        ("POST", "/meeting-output-revision-runs/mrun_1/collect", {"collection_claim": "x" * 32}),
        ("POST", "/meeting-outputs/mout_1/approve", {
            "meeting_id": MEETING_ID, "expected_meeting_version": 1, "expected_output_version": 1,
            "artifact_version": 1, "game_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "zip_sha256": "c" * 64,
        }),
        ("GET", "/meeting-outputs/mout_1/versions/1/files/index.txt", None),
        ("GET", "/meeting-outputs/mout_1/versions/1/download", None),
    ]

    for method, path, payload in unauthenticated:
        response = client.request(method, path, payload)
        assert response.status_code == 401, (method, path, response.status_code)
        assert response.json()["detail"] == "operations_authentication_required"


def test_ordinary_conclusion_meetings_keep_working_end_to_end(operations):
    client = operations["client"]
    record = {
        "id": "meeting_e2e_discussion",
        "source": {"connection": LOCAL, "profile": "default"},
        "title": "Weekly review",
        "agenda": "Decide whether to publish the changelog.",
        "chair": ORCHESTRATOR,
        "participants": [ORCHESTRATOR, REVIEWER],
        "state": "draft",
        "max_rounds": 2,
        "current_round": 0,
        "contributions": [],
        "evidence": [],
        "decisions": [],
        "dissent": [],
        "action_items": [],
    }
    created = client.json(
        "PUT", "/meetings/meeting_e2e_discussion", {"record": record, "expected_version": 0}
    )
    assert "production_stage" not in created["meeting"]

    running = client.json(
        "PUT", "/meetings/meeting_e2e_discussion",
        {
            "record": {**record, "state": "running", "current_round": 1, "contributions": [{
                "id": "c1", "round": 1, "participant": ORCHESTRATOR,
                "kind": "speak", "text": "The changelog is ready.", "evidence_refs": [],
            }]},
            "expected_version": created["version"],
        },
    )
    completed = client.json(
        "PUT", "/meetings/meeting_e2e_discussion",
        {
            "record": {
                **record, "state": "completed", "current_round": 2,
                "contributions": [
                    {"id": "c1", "round": 1, "participant": ORCHESTRATOR, "kind": "speak",
                     "text": "The changelog is ready.", "evidence_refs": []},
                    {"id": "c2", "round": 1, "participant": REVIEWER, "kind": "pass", "text": ""},
                ],
                "decisions": [{"id": "d1", "text": "Publish the changelog.", "evidence_refs": []}],
                "action_items": [{
                    "id": "publish", "owner_route": REVIEWER, "title": "Publish the changelog",
                    "acceptance_criteria": "The changelog is live.", "priority": "normal",
                    "due_intent": "This week",
                    "dedupe_key": "meeting:meeting_e2e_discussion:action:publish",
                }],
            },
            "expected_version": running["version"],
        },
    )

    # The conclusion path creates no output, no stage, and no binding.
    assert completed["meeting"]["state"] == "completed"
    assert "production_stage" not in completed["meeting"]
    assert "artifact_binding" not in completed["meeting"]
    assert client.json("GET", "/meetings/meeting_e2e_discussion/outputs")["outputs"] == []


# ---------------------------------------------------------------------------
# idempotency: every lifecycle mutation, including the dispatch claims
# ---------------------------------------------------------------------------


def opened_run(operations, *, suffix="1", submission="submission-idem"):
    """Freeze a brief and open a producer run, returning the run response."""
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )
    frozen = client.json(
        "POST", f"/meetings/{MEETING_ID}/production-brief",
        {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
    )
    return client.json(
        "POST", f"/meetings/{MEETING_ID}/production-runs",
        {
            "expected_version": frozen["meeting_version"],
            "producer_session_id": f"provisional-production-{suffix}",
            "submission_id": f"{submission}-{suffix}",
        },
    )


def test_every_lifecycle_mutation_refuses_a_request_without_an_idempotency_key(operations):
    """A retry the server cannot recognize is refused, never applied blindly.

    Without a key there is no way to tell a retry from a second intent, so a
    dropped response could mint a second run, artifact version, verdict, or
    approval. The refusal is a 400 before any authorization-bearing work.
    """
    client = operations["client"]
    created = client.json(
        "PUT", f"/meetings/{MEETING_ID}",
        {"record": production_meeting(), "expected_version": 0},
    )

    mutations = [
        (f"/meetings/{MEETING_ID}/production-brief",
         {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []}),
        (f"/meetings/{MEETING_ID}/production-runs",
         {"expected_version": created["version"], "producer_session_id": "s",
          "submission_id": "submission-nokey"}),
        ("/meeting-output-runs/mrun_1/claim", {"request_id": "r", "session_id": "s"}),
        ("/meeting-output-runs/mrun_1/collect", {"collection_claim": "x" * 32}),
        ("/meeting-outputs/mout_1/review-runs",
         {"expected_output_version": 1, "reviewer": REVIEWER}),
        ("/meeting-output-review-runs/mrev_1/claim", {"request_id": "r", "session_id": "s"}),
        ("/meeting-output-review-runs/mrev_1/complete", {"verdict": "verified", "findings": []}),
        ("/meeting-outputs/mout_1/revision-runs",
         {"expected_output_version": 1, "producer_session_id": "s"}),
        ("/meeting-output-revision-runs/mrun_1/claim", {"request_id": "r", "session_id": "s"}),
        ("/meeting-output-revision-runs/mrun_1/collect", {"collection_claim": "x" * 32}),
        ("/meeting-outputs/mout_1/approve", {
            "meeting_id": MEETING_ID, "expected_meeting_version": 1, "expected_output_version": 1,
            "artifact_version": 1, "game_sha256": "a" * 64, "manifest_sha256": "b" * 64,
            "zip_sha256": "c" * 64,
        }),
    ]

    for path, payload in mutations:
        refused = client.request("POST", path, payload, idempotency=False)
        assert refused.status_code == 400, (path, refused.status_code, refused.text)
        assert refused.json()["detail"] == {"error": "operations_idempotency_key_required"}

    # A blank or oversized key is refused too, and nothing happened.
    for key, code in (
        ("   ", "operations_idempotency_key_required"),
        ("k" * 1_000, "operations_idempotency_key_invalid"),
    ):
        refused = client.request(
            "POST", f"/meetings/{MEETING_ID}/production-brief",
            {"expected_version": created["version"], "brief": BRIEF, "evidence_refs": []},
            {"Idempotency-Key": key},
        )
        assert refused.status_code == 400
        assert refused.json()["detail"] == {"error": code}

    assert client.json("GET", f"/meetings/{MEETING_ID}/outputs")["outputs"] == []
    assert client.json("GET", f"/meetings/{MEETING_ID}")["meeting"]["production_stage"] == "briefing"


def test_a_producer_claim_retry_replays_its_dispatch_response(operations):
    """An exact claim retry replays the original dispatch, lease and all.

    The claim is what hands out the assigned cwd and the single-use collection
    claim. A dropped response previously left the dispatcher with an active
    lease it could not re-read, so the run could never be collected.
    """
    client = operations["client"]
    run = opened_run(operations, submission="submission-claim-replay")
    body = {"request_id": "dispatch-1", "session_id": "session-producer-actual"}
    key = {"Idempotency-Key": f"claim-{run['run_id']}-session-producer-actual"}

    claimed = client.json("POST", f"/meeting-output-runs/{run['run_id']}/claim", body, key)
    assert claimed["workspace"]["cwd"]
    assert claimed["collection_claim"]

    # The exact retry replays byte-for-byte while the lease is still active.
    replay = client.json("POST", f"/meeting-output-runs/{run['run_id']}/claim", body, key)
    assert replay == claimed

    # A different key against the same live binding is a new dispatch attempt.
    active = client.request("POST", f"/meeting-output-runs/{run['run_id']}/claim", body, None)
    assert active.status_code == 409
    assert active.json()["detail"] == {"error": "operations_claim_active"}

    # The same key with a CHANGED binding conflicts and leaks nothing.
    changed = client.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-2", "session_id": "session-producer-actual"}, key,
    )
    assert changed.status_code == 409
    assert changed.json()["detail"] == {"error": "operations_idempotency_conflict"}
    assert "cwd" not in changed.text
    assert "collection_claim" not in changed.text
    assert str(operations["home"]) not in changed.text

    # The replay survives the process that produced it, and the claim it
    # returns is the one that actually collects the run.
    restarted = FastAPI()
    restarted.state.auth_required = False
    restarted.include_router(operations["api"].router)
    after = Client(restarted)
    assert after.json("POST", f"/meeting-output-runs/{run['run_id']}/claim", body, key) == claimed

    write_producer_tree(
        claimed["workspace"]["cwd"], {"index.txt": PRIMARY_BODY}, primary="index.txt"
    )
    collected = after.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": claimed["collection_claim"]},
    )
    assert collected["receipt"]["artifact_version"] == 1


def test_a_claim_key_never_replays_onto_another_run(operations):
    """Same key, same body, DIFFERENT run: a conflict, never a foreign cwd."""
    client = operations["client"]
    first = opened_run(operations, suffix="1", submission="submission-claim-one")
    second_created = client.json(
        "PUT", f"/meetings/{SECOND_MEETING_ID}",
        {"record": production_meeting(id=SECOND_MEETING_ID), "expected_version": 0},
    )
    second_frozen = client.json(
        "POST", f"/meetings/{SECOND_MEETING_ID}/production-brief",
        {"expected_version": second_created["version"], "brief": BRIEF, "evidence_refs": []},
    )
    second = client.json(
        "POST", f"/meetings/{SECOND_MEETING_ID}/production-runs",
        {
            "expected_version": second_frozen["meeting_version"],
            "producer_session_id": "provisional-production-2",
            "submission_id": "submission-claim-two",
        },
    )

    body = {"request_id": "dispatch-shared", "session_id": "session-shared"}
    key = {"Idempotency-Key": "shared-claim-key"}
    claimed = client.json("POST", f"/meeting-output-runs/{first['run_id']}/claim", body, key)

    foreign = client.request(
        "POST", f"/meeting-output-runs/{second['run_id']}/claim", body, key
    )
    assert foreign.status_code == 409
    assert foreign.json()["detail"] == {"error": "operations_idempotency_conflict"}
    assert claimed["workspace"]["cwd"] not in foreign.text

    # The second run was never dispatched by the foreign key.
    assert client.json("GET", f"/meeting-outputs/{second['output_id']}/recovery")[
        "active_prompt_claim"
    ] is None

    # The key still replays for the run that earned it.
    assert client.json("POST", f"/meeting-output-runs/{first['run_id']}/claim", body, key) == claimed


def test_a_review_claim_retry_replays_its_dispatch_response(operations):
    """The reviewer dispatch replays too, so a dropped response is recoverable."""
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    output = client.json("GET", f"/meeting-outputs/{output_id}")["output"]
    review = client.json(
        "POST", f"/meeting-outputs/{output_id}/review-runs",
        {"expected_output_version": output["version"], "reviewer": REVIEWER},
    )
    body = {"request_id": "review-dispatch-1", "session_id": "session-reviewer-1"}
    key = {"Idempotency-Key": f"review-claim-{review['request_id']}-session-reviewer-1"}

    claimed = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim", body, key
    )
    assert claimed["artifact_version"] == 1
    assert "collection_claim" not in claimed
    assert "workspace" not in claimed

    assert client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim", body, key
    ) == claimed

    # A changed reviewer session under the same key conflicts.
    changed = client.request(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/claim",
        {"request_id": "review-dispatch-1", "session_id": "session-reviewer-2"}, key,
    )
    assert changed.status_code == 409
    assert changed.json()["detail"] == {"error": "operations_idempotency_conflict"}

    # The replayed claim is still the one that authorizes the verdict.
    completed = client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
    )
    assert completed["review"]["verdict"] == "verified"


def test_a_collection_key_is_bound_to_the_presented_collection_claim(operations):
    """A collect retry must present the same claim, and the key never stores it."""
    client = operations["client"]
    run = opened_run(operations, submission="submission-collect-hash")
    claimed = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-actual"},
    )
    write_producer_tree(
        claimed["workspace"]["cwd"], {"index.txt": PRIMARY_BODY}, primary="index.txt"
    )
    key = {"Idempotency-Key": f"collect-{run['run_id']}"}

    collected = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": claimed["collection_claim"]}, key,
    )
    assert collected["receipt"]["artifact_version"] == 1

    # The exact retry replays; a DIFFERENT claim under the same key conflicts
    # rather than replaying a receipt it never presented a claim for.
    assert client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": claimed["collection_claim"]}, key,
    ) == collected
    forged = client.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/collect",
        {"collection_claim": "x" * 32}, key,
    )
    assert forged.status_code == 409
    assert forged.json()["detail"] == {"error": "operations_idempotency_conflict"}

    # The stored collection receipt never persists the raw claim token.
    database = operations["home"] / "operations" / "meetings.db"
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT request_hash, response_json FROM meeting_output_idempotency"
            " WHERE action = 'run.collect'"
        ).fetchall()
    assert rows
    for request_hash, response_json in rows:
        assert claimed["collection_claim"] not in request_hash
        assert claimed["collection_claim"] not in response_json


def test_a_bounded_startup_sweep_reclaims_an_abandoned_workspace(operations):
    """One bounded sweep per process reclaims aged, unreferenced workspaces."""
    client = operations["client"]
    workspaces = operations["home"] / "operations" / "artifacts" / "workspaces"
    workspaces.mkdir(parents=True)
    aged = time.time() - 30 * 24 * 60 * 60
    abandoned = workspaces / "mrun_abandoned_startup"
    abandoned.mkdir()
    os.utime(abandoned, (aged, aged))

    # The first output-lifecycle call in this process runs the sweep.
    assert client.json("GET", f"/meetings/{MEETING_ID}/outputs")["outputs"] == []
    assert not abandoned.exists()

    # It is bounded to once per process: a workspace abandoned afterwards is
    # not reclaimed by the next request.
    later = workspaces / "mrun_abandoned_later"
    later.mkdir()
    os.utime(later, (aged, aged))
    assert client.json("GET", f"/meetings/{MEETING_ID}/outputs")["outputs"] == []
    assert later.is_dir()


def test_an_expired_claim_uses_a_new_replayable_generation(operations, monkeypatch):
    api = operations["api"]
    client = operations["client"]
    now = [10_000]
    monkeypatch.setattr(api, "_clock", lambda: now[0])
    run = opened_run(operations, submission="submission-claim-generation")
    body = {"request_id": "dispatch-generation", "session_id": "session-generation"}

    first = client.json(
        "POST",
        f"/meeting-output-runs/{run['run_id']}/claim",
        body,
        {"Idempotency-Key": f"claim-{run['run_id']}-session-generation-g0"},
    )
    assert first["claim"]["renewals"] == 0

    now[0] += api.output_store_module.PROMPT_CLAIM_TTL_SECONDS + 1
    expired_replay = client.request(
        "POST",
        f"/meeting-output-runs/{run['run_id']}/claim",
        body,
        {"Idempotency-Key": f"claim-{run['run_id']}-session-generation-g0"},
    )
    assert expired_replay.status_code == 409
    assert expired_replay.json()["detail"] == {"error": "operations_claim_expired"}

    generation_one = {"Idempotency-Key": f"claim-{run['run_id']}-session-generation-g1"}
    renewed = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim", body, generation_one
    )
    replay = client.json(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim", body, generation_one
    )

    assert renewed["claim"]["renewals"] == 1
    assert replay == renewed
    recovery = client.json("GET", f"/meeting-outputs/{run['output_id']}/recovery")
    assert recovery["observed_at"] == now[0]
    assert recovery["active_prompt_claim"]["renewals"] == 1


def test_the_artifact_root_identity_is_pinned_for_the_api_process(operations, monkeypatch):
    api = operations["api"]
    first = api._output_store()
    root = api._artifact_root()
    alias_parent = root.parent / "path-alias"
    alias_parent.mkdir()
    monkeypatch.setattr(api, "_artifact_root", lambda: alias_parent / ".." / root.name)
    database = api._meeting_db_path()
    monkeypatch.setattr(api, "_meeting_db_path", lambda: alias_parent / ".." / database.name)
    assert api._output_store() is first

    held = root.with_name("artifacts-original")
    root.rename(held)
    root.mkdir(mode=0o700)

    with pytest.raises(HTTPException) as caught:
        api._output_store()

    assert caught.value.status_code == 500
    assert caught.value.detail == {"error": "operations_artifact_store_unavailable"}
    assert first.artifacts.root_identity != (
        root.stat().st_dev,
        root.stat().st_ino,
    )


def test_the_production_lifecycle_still_works_when_keys_are_supplied(operations):
    """The full route, every mutation keyed, ends in an approved artifact."""
    client = operations["client"]
    started = start_production(operations)
    output_id = started["run"]["output_id"]
    review = open_review(operations, output_id)
    client.json(
        "POST", f"/meeting-output-review-runs/{review['request_id']}/complete",
        {"verdict": "verified", "findings": []},
        {"Idempotency-Key": f"verdict-{review['request_id']}"},
    )
    detail = client.json("GET", f"/meeting-outputs/{output_id}")
    version = detail["versions"][0]
    approved = client.json(
        "POST", f"/meeting-outputs/{output_id}/approve",
        {
            "meeting_id": MEETING_ID,
            "expected_meeting_version": client.json("GET", f"/meetings/{MEETING_ID}")["version"],
            "expected_output_version": detail["output"]["version"],
            "artifact_version": version["artifact_version"],
            "game_sha256": version["game_sha256"],
            "manifest_sha256": version["manifest_sha256"],
            "zip_sha256": version["zip_sha256"],
        },
        {"Idempotency-Key": f"approve-{output_id}-1"},
    )
    assert approved["output"]["state"] == "approved"
    assert approved["output"]["approved_artifact_version"] == 1


def test_a_swapped_artifact_root_hands_out_no_cwd_and_leaks_no_path(operations):
    """The dispatcher door closes when the root is not the one Operations built."""
    client = operations["client"]
    run = opened_run(operations, submission="submission-root-swap")
    root = operations["home"] / "operations" / "artifacts"
    decoy = operations["home"] / "decoy"
    decoy.mkdir()

    def remove_tree(path: Path) -> None:
        for child in sorted(path.iterdir()):
            if child.is_dir() and not child.is_symlink():
                remove_tree(child)
            else:
                child.unlink()
        path.rmdir()

    remove_tree(root)
    root.symlink_to(decoy, target_is_directory=True)

    refused = client.request(
        "POST", f"/meeting-output-runs/{run['run_id']}/claim",
        {"request_id": "dispatch-1", "session_id": "session-producer-actual"},
    )
    assert refused.status_code == 500
    assert refused.json()["detail"] == {"error": "operations_artifact_store_unavailable"}
    assert str(operations["home"]) not in refused.text
    assert "cwd" not in refused.text
    assert "collection_claim" not in refused.text
    assert sorted(entry.name for entry in decoy.iterdir()) == []
