"""Behavior tests for the fail-closed OSV finding review policy."""

from __future__ import annotations

import importlib.util
import json
import shlex
from pathlib import Path

import yaml

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "osv_review_status.py"
_SPEC = importlib.util.spec_from_file_location("osv_review_status", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

build_review_status = _MOD.build_review_status


_ALLOWED = {
    "braces": {
        "lock": "website/package-lock.json",
        "version": "3.0.3",
        "id": "GHSA-vfj7-8cjw-p6xm",
        "cve": "CVE-2026-93687",
        "severity": "HIGH",
        "score": "8.7",
        "cwe": "CWE-674",
        "last_affected": "3.0.3",
        "groups": None,
    },
    "sprintf-js": {
        "lock": "package-lock.json",
        "version": "1.1.3",
        "id": "GHSA-hp3w-g68c-fv3c",
        "cve": "CVE-2026-97058",
        "severity": "MODERATE",
        "score": "6.9",
        "cwe": "CWE-1284",
        "last_affected": "1.1.3",
        "groups": ["dev", "optional"],
    },
}


def _vulnerability(name: str) -> dict:
    policy = _ALLOWED[name]
    advisory = policy["id"]
    return {
        "affected": [
            {
                "database_specific": {
                    "source": (
                        "https://github.com/github/advisory-database/blob/main/"
                        f"advisories/github-reviewed/2026/09/{advisory}/{advisory}.json"
                    )
                },
                "package": {
                    "ecosystem": "npm",
                    "name": name,
                    "purl": f"pkg:npm/{name}",
                },
                "ranges": [
                    {
                        "events": [
                            {"introduced": "0"},
                            {"last_affected": policy["last_affected"]},
                        ],
                        "type": "SEMVER",
                    }
                ],
            }
        ],
        "aliases": [policy["cve"]],
        "database_specific": {
            "cwe_ids": [policy["cwe"]],
            "github_reviewed": True,
            "github_reviewed_at": "volatile",
            "severity": policy["severity"],
        },
        "details": "reviewed no-patch advisory",
        "id": advisory,
        "modified": "volatile",
        "published": "volatile",
        "references": [{"type": "PACKAGE", "url": "https://example.invalid/package"}],
        "schema_version": "1.9.0",
        "severity": [{"score": "CVSS:3.1/example", "type": "CVSS_V3"}],
        "summary": "reviewed no-patch advisory",
    }


def _package(name: str) -> dict:
    policy = _ALLOWED[name]
    package = {
        "package": {"name": name, "version": policy["version"], "ecosystem": "npm"},
        "groups": [
            {
                "ids": [policy["id"]],
                "aliases": [policy["cve"], policy["id"]],
                "max_severity": policy["score"],
            }
        ],
        "vulnerabilities": [_vulnerability(name)],
    }
    if policy["groups"] is not None:
        package["dependency_groups"] = policy["groups"]
    return package


def _document() -> dict:
    return {
        "results": [
            {
                "source": {"path": "/checkout/package-lock.json", "type": "lockfile"},
                "packages": [_package("sprintf-js")],
            },
            {
                "source": {
                    "path": "/checkout/website/package-lock.json",
                    "type": "lockfile",
                },
                "packages": [_package("braces")],
            },
        ],
        "experimental_config": {"licenses": {"allow": [], "ignore": []}},
    }


def _write_results(path: Path, document: dict | list | str) -> None:
    path.write_text(json.dumps(document), encoding="utf-8")


def _review(tmp_path: Path, document: dict, scan_result: str = "success"):
    results = tmp_path / "results.json"
    _write_results(results, document)
    return build_review_status(scan_result, results)


def test_exact_reviewed_no_patch_findings_pass(tmp_path: Path) -> None:
    status, failed = _review(tmp_path, _document())

    assert failed is False
    result = status[0]["results"][0]
    assert result["kind"] == "warning"
    assert "2 reviewed no-patch vulnerabilities" in result["summary"]
    assert "GHSA-vfj7-8cjw-p6xm" in result["detail"]
    assert "GHSA-hp3w-g68c-fv3c" in result["detail"]


def test_missing_reviewed_finding_fails_closed(tmp_path: Path) -> None:
    document = _document()
    document["results"].pop()

    status, failed = _review(tmp_path, document)

    assert failed is True
    assert "missing reviewed finding" in status[0]["results"][0]["detail"]


def test_extra_or_unknown_finding_fails_closed(tmp_path: Path) -> None:
    document = _document()
    extra = _package("braces")
    extra["package"]["name"] = "axios"
    document["results"][1]["packages"].append(extra)

    status, failed = _review(tmp_path, document)

    assert failed is True
    assert "unreviewed finding" in status[0]["results"][0]["detail"]


def test_patchable_allowed_advisory_fails_closed(tmp_path: Path) -> None:
    document = _document()
    events = document["results"][1]["packages"][0]["vulnerabilities"][0]["affected"][0]["ranges"][0]["events"]
    events[-1] = {"fixed": "3.0.4"}

    status, failed = _review(tmp_path, document)

    assert failed is True
    assert "patched version" in status[0]["results"][0]["detail"]


def test_wrong_package_version_or_source_lock_fails_closed(tmp_path: Path) -> None:
    for mutate in (
        lambda document: document["results"][1]["packages"][0]["package"].update(version="3.0.2"),
        lambda document: document["results"][1]["source"].update(path="/checkout/package-lock.json"),
        lambda document: document["results"][0]["packages"][0].update(dependency_groups=["prod"]),
    ):
        document = _document()
        mutate(document)
        _, failed = _review(tmp_path, document)
        assert failed is True


def test_advisory_identity_and_provenance_are_exact(tmp_path: Path) -> None:
    mutations = (
        lambda vulnerability: vulnerability.update(id="GHSA-unknown"),
        lambda vulnerability: vulnerability.update(aliases=[]),
        lambda vulnerability: vulnerability["affected"][0]["database_specific"].update(source="https://example.invalid"),
        lambda vulnerability: vulnerability["affected"][0]["package"].update(purl="pkg:npm/other"),
        lambda vulnerability: vulnerability["database_specific"].update(github_reviewed=False),
    )
    for mutate in mutations:
        document = _document()
        vulnerability = document["results"][1]["packages"][0]["vulnerabilities"][0]
        mutate(vulnerability)
        status, failed = _review(tmp_path, document)
        assert failed is True
        assert "provenance" in status[0]["results"][0]["detail"]


def test_multiple_vulnerabilities_for_an_allowed_package_fail_closed(tmp_path: Path) -> None:
    document = _document()
    document["results"][1]["packages"][0]["vulnerabilities"].append(_vulnerability("braces"))

    status, failed = _review(tmp_path, document)

    assert failed is True
    assert "exactly one vulnerability" in status[0]["results"][0]["detail"]


def test_malformed_truncated_or_omitted_results_fail_closed(tmp_path: Path) -> None:
    documents = [None, [], {}, {"results": None}, {"results": []}, {"results": [{}]}]
    for document in documents:
        status, failed = _review(tmp_path, document)  # type: ignore[arg-type]
        assert failed is True
        assert "could not be validated" in status[0]["results"][0]["detail"]


def test_missing_artifact_fails_closed(tmp_path: Path) -> None:
    status, failed = build_review_status("success", tmp_path / "missing.json")

    assert failed is True
    assert "not produced" in status[0]["results"][0]["detail"]


def test_failed_scanner_job_fails_closed_even_with_valid_results(tmp_path: Path) -> None:
    status, failed = _review(tmp_path, _document(), scan_result="failure")

    assert failed is True
    assert "scanner job result was failure" in status[0]["results"][0]["detail"]


def test_invalid_json_fails_closed(tmp_path: Path) -> None:
    results = tmp_path / "results.json"
    results.write_text("not json", encoding="utf-8")

    status, failed = build_review_status("success", results)

    assert failed is True
    assert "could not be validated" in status[0]["results"][0]["detail"]


def test_workflow_exports_json_and_required_aggregate_consumes_review() -> None:
    workflow_path = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "osv-scanner.yml"
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8"))
    jobs = workflow["jobs"]

    assert jobs["scan"]["with"]["export-results"] is True

    review = jobs["review-findings"]
    assert review["needs"] == "scan"
    emit = next(step for step in review["steps"] if step.get("id") == "emit")
    assert emit["env"] == {
        "OSV_RESULTS": "${{ needs.scan.outputs.results }}",
        "SCAN_RESULT": "${{ needs.scan.result }}",
        "RESULTS_PATH": "${{ runner.temp }}/osv-results.json",
    }

    aggregate = jobs["required-dependency-gates"]
    assert aggregate["needs"] == ["whatsapp-production-audit", "scan", "review-findings"]
    gate = next(step for step in aggregate["steps"] if step["name"] == "Fail unless every dependency gate succeeded")
    assert gate["env"] == {"NEEDS": "${{ toJSON(needs) }}"}
    assert shlex.split(gate["run"]) == [
        "python3",
        "scripts/ci/evaluate_required_jobs.py",
        "--strict",
        "--required-job",
        "whatsapp-production-audit",
        "--required-job",
        "scan",
        "--required-job",
        "review-findings",
        "--needs-json",
        "$NEEDS",
    ]
