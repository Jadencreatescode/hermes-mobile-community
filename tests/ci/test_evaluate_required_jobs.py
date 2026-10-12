"""Behavior tests for the executable CI required-job aggregator."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.ci.evaluate_required_jobs import (
    REQUIRED_CI_JOBS,
    allowed_ci_skips,
    evaluate_required_jobs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "ci" / "evaluate_required_jobs.py"
EXPECTED_REQUIRED_JOBS = {
    "detect",
    "tests",
    "tests-os",
    "lint",
    "js-tests",
    "installer-tests",
    "rust-tests",
    "e2e-desktop",
    "docs-site",
    "history-check",
    "contributor-check",
    "uv-lockfile",
    "infographic-check",
    "lockfile-diff",
    "docker-lint",
    "supply-chain",
    "review-labels",
    "osv-scanner",
}


def _full_needs() -> dict[str, object]:
    needs: dict[str, object] = {
        name: {"result": "success", "outputs": {}} for name in REQUIRED_CI_JOBS
    }
    needs["detect"] = {
        "result": "success",
        "outputs": {
            "event_name": "pull_request",
            "frontend": "true",
            "python": "true",
            "installer": "true",
            "rust": "true",
            "site": "true",
            "uv_lock": "true",
            "npm_lock": "true",
            "docker_meta": "true",
            "scan": "true",
            "deps": "true",
            "ci_review": "true",
            "mcp_catalog": "true",
        },
    }
    needs["supply-chain"] = {
        "result": "success",
        "outputs": {"critical_findings": "true"},
    }
    return needs


def _evaluate(needs: dict[str, object]):
    return evaluate_required_jobs(needs, allowed_skips=allowed_ci_skips(needs))


def test_required_job_contract_enumerates_every_blocking_ci_job():
    assert set(REQUIRED_CI_JOBS) == EXPECTED_REQUIRED_JOBS


def test_complete_successful_needs_payload_passes():
    assert _evaluate(_full_needs()).failed == ()


def test_empty_needs_payload_fails_closed_for_every_required_job():
    result = _evaluate({})

    assert set(result.failed) == EXPECTED_REQUIRED_JOBS
    assert set(result.compact) == EXPECTED_REQUIRED_JOBS
    assert set(result.compact.values()) == {"missing"}


@pytest.mark.parametrize("missing_job", sorted(EXPECTED_REQUIRED_JOBS))
def test_each_missing_required_job_fails_closed(missing_job: str):
    needs = _full_needs()
    del needs[missing_job]

    assert missing_job in _evaluate(needs).failed


@pytest.mark.parametrize("bad_result", [None, True, 1, [], {}, ""])
def test_unexpected_result_types_fail_closed(bad_result: object):
    needs = _full_needs()
    needs["osv-scanner"] = {"result": bad_result, "outputs": {}}

    result = _evaluate(needs)

    assert result.compact["osv-scanner"] == "invalid"
    assert "osv-scanner" in result.failed


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped", "timed_out", "neutral"])
def test_every_non_success_result_fails_without_an_explicit_lane_disable(result: str):
    needs = _full_needs()
    needs["osv-scanner"] = {"result": result, "outputs": {}}

    assert "osv-scanner" in _evaluate(needs).failed


def test_classifier_disabled_lane_is_the_only_derived_skip():
    needs = _full_needs()
    detect = needs["detect"]
    assert isinstance(detect, dict)
    outputs = detect["outputs"]
    assert isinstance(outputs, dict)
    outputs["frontend"] = "false"
    needs["js-tests"] = {"result": "skipped", "outputs": {}}

    allowed = allowed_ci_skips(needs)
    result = evaluate_required_jobs(needs, allowed_skips=allowed)

    assert "js-tests" in allowed
    assert "e2e-desktop" in allowed
    assert result.failed == ()


def test_missing_classifier_output_does_not_authorize_a_skip():
    needs = _full_needs()
    detect = needs["detect"]
    assert isinstance(detect, dict)
    outputs = detect["outputs"]
    assert isinstance(outputs, dict)
    del outputs["frontend"]
    needs["js-tests"] = {"result": "skipped", "outputs": {}}

    allowed = allowed_ci_skips(needs)
    result = evaluate_required_jobs(needs, allowed_skips=allowed)

    assert "js-tests" not in allowed
    assert result.failed == ("js-tests",)


def test_executable_rejects_empty_needs_payload():
    completed = subprocess.run(
        [sys.executable, str(SCRIPT), "--needs-json", "{}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "required job(s) incomplete or failed" in completed.stdout


def test_executable_accepts_complete_successful_payload(tmp_path: Path):
    github_output = tmp_path / "github-output"
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--needs-json",
            json.dumps(_full_needs()),
            "--github-output",
            str(github_output),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "All required jobs succeeded" in completed.stdout
    assert github_output.read_text(encoding="utf-8").startswith("needs-json={")


def test_strict_executable_evaluates_its_supplied_dependency_gate_set():
    needs = {
        "scan": {"result": "success", "outputs": {}},
        "whatsapp-production-audit": {"result": "success", "outputs": {}},
    }
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--strict",
            "--required-job",
            "scan",
            "--required-job",
            "whatsapp-production-audit",
            "--needs-json",
            json.dumps(needs),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "All required jobs succeeded" in completed.stdout


def test_strict_executable_rejects_a_missing_named_dependency_gate():
    needs = {
        "scan": {"result": "success", "outputs": {}},
        "whatsapp-production-audit": {"result": "success", "outputs": {}},
    }
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--strict",
            "--required-job",
            "scan",
            "--required-job",
            "whatsapp-production-audit",
            "--required-job",
            "emit-status",
            "--needs-json",
            json.dumps(needs),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "emit-status: missing" in completed.stdout
