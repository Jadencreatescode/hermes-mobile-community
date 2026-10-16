"""Regression coverage for production-only session and prompt fields."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tui_gateway.contracts.prompt_voice import PromptSubmitParams, PromptSubmitResult
from tui_gateway.contracts.sessions import SessionCreateParams, SessionResumeParams


CWD_IDENTITY = {
    "device": "2049",
    "inode": "9007199254740993",
    "output_device": "2049",
    "output_inode": "9007199254740994",
}
RESTRICTIONS = {
    "enabled_toolsets": ["clarify", "file"],
    "skip_background_review": True,
    "skip_context_files": True,
    "skip_memory": True,
}


def test_prompt_submit_contract_accepts_dispatch_idempotency_fields():
    params = PromptSubmitParams.model_validate(
        {"session_id": "runtime-1", "text": "produce", "idempotency_key": "mrun-1"}
    )
    result = PromptSubmitResult.model_validate(
        {"status": "streaming", "idempotent_replay": True}
    )

    assert params.idempotency_key == "mrun-1"
    assert result.idempotent_replay is True


def test_session_create_contract_accepts_restrictions_and_pinned_cwd_identity():
    params = SessionCreateParams.model_validate(
        {"cwd": "/workspace", "cwd_identity": CWD_IDENTITY, **RESTRICTIONS}
    )

    assert params.enabled_toolsets == ["clarify", "file"]
    assert params.cwd_identity.output_inode == "9007199254740994"


def test_session_resume_contract_accepts_restrictions_and_pinned_cwd():
    params = SessionResumeParams.model_validate(
        {
            "session_id": "stored-1",
            "cwd": "/workspace",
            "cwd_identity": CWD_IDENTITY,
            **RESTRICTIONS,
        }
    )

    assert params.cwd == "/workspace"
    assert params.skip_memory is True


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (PromptSubmitParams, {"session_id": "runtime-1", "unknown": True}),
        (SessionCreateParams, {"unknown": True}),
        (SessionResumeParams, {"session_id": "stored-1", "unknown": True}),
    ],
)
def test_ported_contracts_stay_closed(model, payload):
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        model.model_validate(payload)
