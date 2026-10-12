"""Tests for the fail-closed OSV SARIF review-status adapter."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "osv_review_status.py"
_SPEC = importlib.util.spec_from_file_location("osv_review_status", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

build_review_status = _MOD.build_review_status


def _write_sarif(path: Path, results: list[dict]) -> None:
    path.write_text(json.dumps({"runs": [{"results": results}]}), encoding="utf-8")


def _finding(rule_id: str = "GHSA-test", uri: str = "package-lock.json") -> dict:
    return {
        "ruleId": rule_id,
        "message": {"text": "test advisory"},
        "locations": [
            {
                "physicalLocation": {
                    "artifactLocation": {"uri": uri},
                }
            }
        ],
    }


def test_clean_success_emits_no_status(tmp_path: Path) -> None:
    sarif = tmp_path / "results.sarif"
    _write_sarif(sarif, [])

    status, failed = build_review_status("success", sarif)

    assert status == []
    assert failed is False


def test_findings_emit_warning_without_operational_failure(tmp_path: Path) -> None:
    sarif = tmp_path / "results.sarif"
    _write_sarif(sarif, [_finding()])

    status, failed = build_review_status("success", sarif)

    assert failed is False
    result = status[0]["results"][0]
    assert result["kind"] == "warning"
    assert "1 known vulnerability" in result["summary"]
    assert "GHSA-test in package-lock.json" in result["detail"]


def test_missing_artifact_fails_closed(tmp_path: Path) -> None:
    status, failed = build_review_status("success", tmp_path / "missing.sarif")

    assert failed is True
    result = status[0]["results"][0]
    assert result["kind"] == "action_required"
    assert "not produced" in result["detail"]


def test_failed_scanner_job_fails_closed_even_with_clean_sarif(tmp_path: Path) -> None:
    sarif = tmp_path / "results.sarif"
    _write_sarif(sarif, [])

    status, failed = build_review_status("failure", sarif)

    assert failed is True
    assert "scanner job result was failure" in status[0]["results"][0]["detail"]


def test_malformed_or_incomplete_sarif_fails_closed(tmp_path: Path) -> None:
    malformed = tmp_path / "malformed.sarif"
    malformed.write_text("not json", encoding="utf-8")
    incomplete = tmp_path / "incomplete.sarif"
    incomplete.write_text(json.dumps({"runs": [{}]}), encoding="utf-8")

    malformed_status, malformed_failed = build_review_status("success", malformed)
    incomplete_status, incomplete_failed = build_review_status("success", incomplete)

    assert malformed_failed is True
    assert incomplete_failed is True
    assert "could not be validated" in malformed_status[0]["results"][0]["detail"]
    assert "could not be validated" in incomplete_status[0]["results"][0]["detail"]


def test_result_without_a_real_location_fails_closed(tmp_path: Path) -> None:
    sarif = tmp_path / "results.sarif"
    _write_sarif(sarif, [{"ruleId": "GHSA-test", "locations": []}])

    status, failed = build_review_status("success", sarif)

    assert failed is True
    assert "has no location" in status[0]["results"][0]["detail"]
