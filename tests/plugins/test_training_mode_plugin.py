import asyncio
import hashlib
import importlib.util
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

MODULE = (
    Path(__file__).resolve().parents[2]
    / "plugins"
    / "training-mode"
    / "dashboard"
    / "plugin_api.py"
)


def load_api():
    spec = importlib.util.spec_from_file_location("training_mode_plugin_api", MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def post_json(app: FastAPI, path: str, payload: dict):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://training.test"
    ) as client:
        return await client.post(path, json=payload)


def fake_secret():
    return "sk" + "-abcdefghijklmnop"


def draft_payload(api):
    return api.TrainingDraftRequest(
        name="weekly-client-report",
        trigger="Prepare and verify the weekly client report.",
        steps=[
            api.TrainingStep(
                kind="navigate",
                url="https://reports.example.com/week?token=secret#private",
            ),
            api.TrainingStep(
                kind="navigate",
                url="https://reports.example.com/reset/0123456789abcdef0123456789abcdef",
            ),
            api.TrainingStep(kind="note", note="Enter password hunter2"),
            api.TrainingStep(kind="note", note="Use " + fake_secret()),
            api.TrainingStep(kind="click", label="Export report"),
        ],
    )


def test_draft_is_deterministic_hash_bound_and_secret_free():
    api = load_api()
    first = api._draft(draft_payload(api))
    second = api._draft(draft_payload(api))

    assert first == second
    assert (
        first["approval_phrase"] == f"SAVE weekly-client-report {first['draft_hash']}"
    )
    assert "?token=" not in first["skill_md"]
    assert "#private" not in first["skill_md"]
    assert "0123456789abcdef0123456789abcdef" not in first["skill_md"]
    assert "hunter2" not in first["skill_md"]
    assert fake_secret() not in first["skill_md"]
    assert "fresh human input gate" in first["skill_md"]
    assert first["steps"][0] == {
        "kind": "navigate",
        "value": "https://reports.example.com/week",
    }


def test_semantic_capture_drops_raw_values_and_private_browser_data():
    api = load_api()
    body = api.TrainingDraftRequest(
        name="account-review",
        trigger="Review the account dashboard and verify the final status.",
        steps=[
            api.TrainingStep(kind="note", note="Type 1234 into the account field"),
            api.TrainingStep(kind="note", note="Use cookie SID=abc"),
            api.TrainingStep(kind="note", note="Paste huntertwo into the access field"),
            api.TrainingStep(kind="note", note="The access code is open-sesame"),
            api.TrainingStep(kind="type_redacted", label="Password hunter2"),
            api.TrainingStep(kind="note", note="Set the login field to swordfish"),
            api.TrainingStep(kind="note", note="Authenticate as hunterseven"),
            api.TrainingStep(kind="note", note="Log in as huntereight"),
            api.TrainingStep(kind="note", note="Submit OTP 123456"),
            api.TrainingStep(kind="note", note="Submit the code 654321"),
            api.TrainingStep(kind="note", note="Confirm the code is 777777"),
            api.TrainingStep(
                kind="note", note="Then paste hunterthree into the client field"
            ),
            api.TrainingStep(kind="note", note="Confirm with code 246810"),
            api.TrainingStep(kind="note", note="Click Continue with code 135790"),
            api.TrainingStep(kind="note", note="Confirm the code is hunterfive"),
            api.TrainingStep(kind="note", note="Confirm reference 8675309"),
            api.TrainingStep(kind="note", note="Submit the reviewed report"),
            api.TrainingStep(kind="note", note="Confirm the dashboard shows Complete"),
        ],
    )

    draft = api._draft(body)

    assert "1234" not in draft["skill_md"]
    assert "SID=abc" not in draft["skill_md"]
    assert "huntertwo" not in draft["skill_md"]
    assert "open-sesame" not in draft["skill_md"]
    assert "Password hunter2" not in draft["skill_md"]
    assert "swordfish" not in draft["skill_md"]
    assert "hunterseven" not in draft["skill_md"]
    assert "huntereight" not in draft["skill_md"]
    assert "123456" not in draft["skill_md"]
    assert "654321" not in draft["skill_md"]
    assert "777777" not in draft["skill_md"]
    assert "hunterthree" not in draft["skill_md"]
    assert "246810" not in draft["skill_md"]
    assert "135790" not in draft["skill_md"]
    assert "hunterfive" not in draft["skill_md"]
    assert "8675309" not in draft["skill_md"]
    assert [step["kind"] for step in draft["steps"][:17]] == [
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "type_redacted",
        "note",
    ]
    assert (
        draft["steps"][16]["value"]
        == "Perform the reviewed consequential action only after fresh user approval."
    )
    with pytest.raises(ValueError, match="semantic trigger"):
        api._draft(
            api.TrainingDraftRequest(
                name="unsafe-trigger",
                trigger="Use cookie SID=abc to open the account.",
                steps=[api.TrainingStep(kind="note", note="Review the account")],
            )
        )
    with pytest.raises(ValueError, match="semantic trigger"):
        api._draft(
            api.TrainingDraftRequest(
                name="unsafe-trigger-action",
                trigger="Set client field to hunterfour.",
                steps=[api.TrainingStep(kind="note", note="Review the account")],
            )
        )
    with pytest.raises(ValueError, match="semantic trigger"):
        api._draft(
            api.TrainingDraftRequest(
                name="unsafe-trigger-reference",
                trigger="Review reference 8675309.",
                steps=[api.TrainingStep(kind="note", note="Review the account")],
            )
        )
    for trigger in (
        "Authenticate with hunterseven.",
        "Unlock the account with huntereight.",
    ):
        with pytest.raises(ValueError, match="semantic trigger"):
            api._draft(
                api.TrainingDraftRequest(
                    name="unsafe-trigger-credential-action",
                    trigger=trigger,
                    steps=[api.TrainingStep(kind="note", note="Review the account")],
                )
            )


def test_schema_rejects_raw_value_carriers_and_private_navigation():
    api = load_api()
    with pytest.raises(ValidationError):
        api.TrainingStep(kind="type_redacted", label="Password", value="secret")
    for url in (
        "https://127.0.0.1/admin",
        "https://127.0.0.1.nip.io/admin",
        "https://localhost.localtest.me/admin",
    ):
        with pytest.raises(ValueError, match="private navigation"):
            api._draft(
                api.TrainingDraftRequest(
                    name="local-task",
                    trigger="Use a local service.",
                    steps=[api.TrainingStep(kind="navigate", url=url)],
                )
            )


def test_wrong_or_stale_approval_has_zero_write_side_effect(monkeypatch):
    api = load_api()
    canonical = api._draft(draft_payload(api))
    writes = []
    monkeypatch.setattr(api, "_write_and_verify", lambda *args: writes.append(args))
    body = api.TrainingApprovalRequest(
        **draft_payload(api).model_dump(),
        draft_hash=canonical["draft_hash"],
        approval="SAVE weekly-client-report wronghash000",
    )

    with pytest.raises(ValueError, match="approval phrase"):
        api._approve(body, profile="default")

    assert writes == []


def test_full_hash_approval_supports_the_maximum_skill_name():
    api = load_api()
    name = "a" * 64
    body = api.TrainingDraftRequest(
        name=name,
        trigger="Review the account dashboard.",
        steps=[api.TrainingStep(kind="note", note="Review the dashboard")],
    )
    canonical = api._draft(body)

    approved = api.TrainingApprovalRequest(
        **body.model_dump(),
        draft_hash=canonical["draft_hash"],
        approval=canonical["approval_phrase"],
    )

    assert approved.approval == canonical["approval_phrase"]


def test_exact_approval_writes_canonical_bytes_and_disables_caching(monkeypatch):
    api = load_api()
    canonical = api._draft(draft_payload(api))
    captured = {}

    def write(name, content, digest, profile):
        captured.update(name=name, content=content, digest=digest, profile=profile)
        return {"saved": True, "idempotent": False, "name": name, "draft_hash": digest}

    monkeypatch.setattr(api, "_write_and_verify", write)
    body = api.TrainingApprovalRequest(
        **draft_payload(api).model_dump(),
        draft_hash=canonical["draft_hash"],
        approval=canonical["approval_phrase"],
    )
    result = api._approve(body, profile="research")

    assert result["saved"] is True
    assert captured == {
        "name": canonical["name"],
        "content": canonical["skill_md"],
        "digest": canonical["draft_hash"],
        "profile": "research",
    }


def test_write_and_verify_is_idempotent_and_rejects_different_collision(
    tmp_path, monkeypatch
):
    api = load_api()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    canonical = api._draft(draft_payload(api))

    first = api._write_and_verify(
        canonical["name"], canonical["skill_md"], canonical["draft_hash"], None
    )
    second = api._write_and_verify(
        canonical["name"], canonical["skill_md"], canonical["draft_hash"], None
    )

    assert first["saved"] is True and first["idempotent"] is False
    assert second["saved"] is True and second["idempotent"] is True
    with pytest.raises(ValueError, match="different skill"):
        api._write_and_verify(
            canonical["name"], canonical["skill_md"] + "changed", "0" * 64, None
        )


def test_write_verification_compares_literal_installed_bytes(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    canonical = api._draft(draft_payload(api))
    api._write_and_verify(
        canonical["name"], canonical["skill_md"], canonical["draft_hash"], None
    )
    installed = next(tmp_path.rglob("SKILL.md"))
    installed.write_bytes(canonical["skill_md"].replace("\n", "\r\n").encode("utf-8"))

    with pytest.raises(ValueError, match="different skill"):
        api._write_and_verify(
            canonical["name"], canonical["skill_md"], canonical["draft_hash"], None
        )


def test_invalid_endpoint_payload_never_echoes_secret_and_is_not_cacheable():
    api = load_api()
    app = FastAPI()
    app.include_router(api.router)
    secret = fake_secret()

    response = asyncio.run(
        post_json(
            app,
            "/draft",
            {
                "name": "weekly-client-report",
                "trigger": "Prepare the report.",
                "steps": [
                    {"kind": "type_redacted", "label": "API key", "value": secret}
                ],
            },
        )
    )

    assert response.status_code == 400
    assert response.headers["Cache-Control"] == "no-store"
    assert secret not in response.text
    assert response.json() == {"detail": "invalid training request"}


def test_endpoint_draft_approve_write_readback_and_retry(tmp_path, monkeypatch):
    api = load_api()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    app = FastAPI()
    app.include_router(api.router)
    request = draft_payload(api).model_dump()

    draft_response = asyncio.run(post_json(app, "/draft", request))
    assert draft_response.status_code == 200
    canonical = draft_response.json()
    approval = {
        **request,
        "draft_hash": canonical["draft_hash"],
        "approval": canonical["approval_phrase"],
    }

    first = asyncio.run(post_json(app, "/approve", approval))
    second = asyncio.run(post_json(app, "/approve", approval))

    assert first.status_code == 200
    assert first.json()["idempotent"] is False
    assert second.status_code == 200
    assert second.json()["idempotent"] is True
    installed = next(tmp_path.rglob("SKILL.md")).read_bytes()
    assert hashlib.sha256(installed).hexdigest() == canonical["draft_hash"]


def test_unexpected_save_failure_is_generic_and_not_cacheable(monkeypatch):
    api = load_api()
    canonical = api._draft(draft_payload(api))
    monkeypatch.setattr(
        api,
        "_write_and_verify",
        lambda *_args: (_ for _ in ()).throw(
            RuntimeError("private path /secret/value")
        ),
    )
    app = FastAPI()
    app.include_router(api.router)
    payload = draft_payload(api).model_dump()
    payload.update(
        draft_hash=canonical["draft_hash"], approval=canonical["approval_phrase"]
    )

    response = asyncio.run(post_json(app, "/approve", payload))

    assert response.status_code == 500
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {"detail": "training save verification failed"}
    assert "/secret/value" not in response.text


def test_plugin_exposes_only_draft_and_approve_routes():
    api = load_api()
    paths = {route.path for route in api.router.routes}
    assert paths == {"/draft", "/approve"}
