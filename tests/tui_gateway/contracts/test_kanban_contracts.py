"""Strict wire contracts for the public Kanban read RPCs."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tui_gateway.contracts.registry import METHODS


def test_kanban_board_contract_matches_handler_wire_shape():
    contract = METHODS["kanban.board"]

    params = contract.params.model_validate(
        {
            "board": "release",
            "tenant": "public",
            "assignee": "worker-1",
            "include_archived": True,
            "profile": "default",
        }
    )
    result = contract.result.model_validate(
        {
            "tasks": [
                {
                    "id": "t_1234",
                    "title": "Port contracts",
                    "status": "running",
                    "assignee": None,
                    "priority": 7,
                    "latest_summary": None,
                }
            ],
            "count": 1,
        }
    )

    assert params.model_dump()["include_archived"] is True
    assert result.model_dump()["tasks"][0]["priority"] == 7
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        contract.params.model_validate({"unknown": True})
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        contract.result.model_validate({"tasks": [], "count": 0, "unknown": True})
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        contract.result.model_validate(
            {
                "tasks": [
                    {
                        "id": "t_1234",
                        "title": "Port contracts",
                        "status": "running",
                        "assignee": None,
                        "priority": 7,
                        "latest_summary": None,
                        "unknown": True,
                    }
                ],
                "count": 1,
            }
        )


def test_kanban_diagnostics_contract_matches_handler_wire_shape():
    contract = METHODS["kanban.diagnostics"]

    params = contract.params.model_validate(
        {"board": "release", "severity": "error", "profile": "default"}
    )
    result = contract.result.model_validate(
        {
            "diagnostics": [
                {
                    "task_id": "t_1234",
                    "task_title": "Port contracts",
                    "task_status": "running",
                    "task_assignee": None,
                    "diagnostics": [
                        {
                            "kind": "repeated_failures",
                            "severity": "critical",
                            "title": "Agent failed repeatedly",
                            "detail": "Three consecutive failures.",
                            "actions": [
                                {
                                    "kind": "cli_hint",
                                    "label": "Check logs",
                                    "payload": {"command": "hermes kanban log t_1234"},
                                    "suggested": True,
                                }
                            ],
                            "first_seen_at": 10,
                            "last_seen_at": 20,
                            "count": 3,
                            "run_id": None,
                            "data": {"consecutive_failures": 3, "last_error": None},
                        }
                    ],
                }
            ],
            "count": 1,
        }
    )

    assert params.model_dump()["severity"] == "error"
    assert (
        result.model_dump()["diagnostics"][0]["diagnostics"][0]["actions"][0]["payload"]["command"]
        == "hermes kanban log t_1234"
    )
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        contract.params.model_validate({"unknown": True})
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        contract.result.model_validate(
            {
                "diagnostics": [
                    {
                        "task_id": "t_1234",
                        "task_title": "Port contracts",
                        "task_status": "running",
                        "task_assignee": None,
                        "diagnostics": [],
                        "unknown": True,
                    }
                ],
                "count": 0,
            }
        )
