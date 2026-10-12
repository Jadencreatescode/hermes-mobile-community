#!/usr/bin/env python3
"""Turn OSV Scanner JSON into a fail-closed reviewed-finding status."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
from typing import Any


_ALLOWED = {
    ("website/package-lock.json", "braces", "3.0.3"): {
        "advisory": "GHSA-vfj7-8cjw-p6xm",
        "cve": "CVE-2026-93687",
        "severity": "HIGH",
        "score": "8.7",
        "cwe": "CWE-674",
        "last_affected": "3.0.3",
        "dependency_groups": None,
        "source": (
            "https://github.com/github/advisory-database/blob/main/"
            "advisories/github-reviewed/2026/09/GHSA-vfj7-8cjw-p6xm/"
            "GHSA-vfj7-8cjw-p6xm.json"
        ),
    },
    ("package-lock.json", "sprintf-js", "1.1.3"): {
        "advisory": "GHSA-hp3w-g68c-fv3c",
        "cve": "CVE-2026-97058",
        "severity": "MODERATE",
        "score": "6.9",
        "cwe": "CWE-1284",
        "last_affected": "1.1.3",
        "dependency_groups": ["dev", "optional"],
        "source": (
            "https://github.com/github/advisory-database/blob/main/"
            "advisories/github-reviewed/2026/09/GHSA-hp3w-g68c-fv3c/"
            "GHSA-hp3w-g68c-fv3c.json"
        ),
    },
}


def _as_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _as_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _same_members(actual: Any, expected: list[str]) -> bool:
    return isinstance(actual, list) and len(actual) == len(expected) and sorted(actual) == sorted(expected)


def _relative_lock(path_value: Any) -> str:
    if not isinstance(path_value, str) or not path_value:
        raise ValueError("OSV source path must be a non-empty string")
    normalized = path_value.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    candidates = sorted({key[0] for key in _ALLOWED}, key=len, reverse=True)
    for candidate in candidates:
        candidate_parts = PurePosixPath(candidate).parts
        if len(parts) >= len(candidate_parts) and parts[-len(candidate_parts) :] == candidate_parts:
            return candidate
    return normalized


def _validate_no_patch_provenance(
    vulnerability: Any,
    name: str,
    policy: dict[str, Any],
) -> None:
    item = _as_record(vulnerability, f"{name} vulnerability")
    if item.get("id") != policy["advisory"]:
        raise ValueError(f"{name} advisory provenance has an unexpected id")
    if item.get("aliases") != [policy["cve"]]:
        raise ValueError(f"{name} advisory provenance has unexpected aliases")
    if item.get("schema_version") != "1.9.0":
        raise ValueError(f"{name} advisory provenance has an unsupported schema")
    if not isinstance(item.get("summary"), str) or not item["summary"]:
        raise ValueError(f"{name} advisory provenance has no summary")
    if not isinstance(item.get("details"), str) or not item["details"]:
        raise ValueError(f"{name} advisory provenance has no details")
    _as_list(item.get("references"), f"{name} advisory references")
    _as_list(item.get("severity"), f"{name} advisory severity")

    database = _as_record(item.get("database_specific"), f"{name} advisory database metadata")
    if database.get("github_reviewed") is not True:
        raise ValueError(f"{name} advisory provenance is not GitHub reviewed")
    if database.get("severity") != policy["severity"]:
        raise ValueError(f"{name} advisory provenance severity changed")
    if database.get("cwe_ids") != [policy["cwe"]]:
        raise ValueError(f"{name} advisory provenance CWE changed")

    affected = _as_list(item.get("affected"), f"{name} affected packages")
    if len(affected) != 1:
        raise ValueError(f"{name} advisory provenance must have exactly one affected package")
    affected_item = _as_record(affected[0], f"{name} affected package")
    affected_database = _as_record(
        affected_item.get("database_specific"), f"{name} affected database metadata"
    )
    if affected_database.get("source") != policy["source"]:
        raise ValueError(f"{name} advisory provenance source changed")
    if set(affected_database) != {"source"}:
        raise ValueError(f"{name} advisory provenance source metadata changed")

    package = _as_record(affected_item.get("package"), f"{name} affected package identity")
    expected_package = {
        "ecosystem": "npm",
        "name": name,
        "purl": f"pkg:npm/{name}",
    }
    if package != expected_package:
        raise ValueError(f"{name} advisory provenance package identity changed")

    ranges = _as_list(affected_item.get("ranges"), f"{name} affected ranges")
    if len(ranges) != 1:
        raise ValueError(f"{name} advisory provenance must have exactly one range")
    affected_range = _as_record(ranges[0], f"{name} affected range")
    if affected_range.get("type") != "SEMVER":
        raise ValueError(f"{name} advisory provenance range is not SEMVER")
    events = _as_list(affected_range.get("events"), f"{name} affected events")
    if any(isinstance(event, dict) and "fixed" in event for event in events):
        raise ValueError(f"{name} advisory now names a patched version")
    expected_events = [{"introduced": "0"}, {"last_affected": policy["last_affected"]}]
    if events != expected_events:
        raise ValueError(f"{name} advisory provenance no-patch range changed")


def _validate_package(
    package_result: Any,
    source_lock: str,
) -> tuple[tuple[str, str, str], str]:
    result = _as_record(package_result, "OSV package result")
    package = _as_record(result.get("package"), "OSV package identity")
    name = package.get("name")
    version = package.get("version")
    ecosystem = package.get("ecosystem")
    if not isinstance(name, str) or not isinstance(version, str) or ecosystem != "npm":
        raise ValueError("OSV package identity is malformed")

    key = (source_lock, name, version)
    policy = _ALLOWED.get(key)
    if policy is None:
        raise ValueError(f"unreviewed finding: {name}@{version} in {source_lock}")

    expected_keys = {"package", "groups", "vulnerabilities"}
    expected_groups = policy["dependency_groups"]
    if expected_groups is None:
        if "dependency_groups" in result:
            raise ValueError(f"{name} unexpectedly became a grouped non-production dependency")
    else:
        expected_keys.add("dependency_groups")
        if not _same_members(result.get("dependency_groups"), expected_groups):
            raise ValueError(f"{name} dependency groups changed from reviewed dev/optional scope")
    if set(result) != expected_keys:
        raise ValueError(f"{name} package result has missing or unexpected fields")

    groups = _as_list(result.get("groups"), f"{name} advisory groups")
    expected_group = {
        "ids": [policy["advisory"]],
        "aliases": [policy["cve"], policy["advisory"]],
        "max_severity": policy["score"],
    }
    if groups != [expected_group]:
        raise ValueError(f"{name} advisory provenance group changed")

    vulnerabilities = _as_list(result.get("vulnerabilities"), f"{name} vulnerabilities")
    if len(vulnerabilities) != 1:
        raise ValueError(f"{name} must have exactly one vulnerability")
    _validate_no_patch_provenance(vulnerabilities[0], name, policy)
    return key, f"- {policy['advisory']} in {source_lock} ({name}@{version})"


def _validate_results(document: Any) -> list[str]:
    root = _as_record(document, "OSV results document")
    results = _as_list(root.get("results"), "OSV results")
    if not results:
        raise ValueError("OSV results contain no findings; reviewed findings are missing")

    found: set[tuple[str, str, str]] = set()
    summaries: list[str] = []
    for result_index, raw_result in enumerate(results):
        result = _as_record(raw_result, f"OSV result {result_index}")
        if set(result) != {"source", "packages"}:
            raise ValueError(f"OSV result {result_index} has missing or unexpected fields")
        source = _as_record(result.get("source"), f"OSV result {result_index} source")
        if source.get("type") != "lockfile" or set(source) != {"path", "type"}:
            raise ValueError(f"OSV result {result_index} source is malformed")
        source_lock = _relative_lock(source.get("path"))
        packages = _as_list(result.get("packages"), f"OSV result {result_index} packages")
        if not packages:
            raise ValueError(f"OSV result {result_index} has no package findings")
        for package in packages:
            key, summary = _validate_package(package, source_lock)
            if key in found:
                raise ValueError(f"duplicate reviewed finding: {key[1]}@{key[2]}")
            found.add(key)
            summaries.append(summary)

    missing = set(_ALLOWED) - found
    if missing:
        names = ", ".join(sorted(f"{name}@{version} in {lock}" for lock, name, version in missing))
        raise ValueError(f"missing reviewed finding: {names}")
    if found - set(_ALLOWED):
        raise ValueError("unreviewed OSV findings were present")
    return sorted(summaries)


def _failure_status(failures: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "source": "osv scan",
            "results": [
                {
                    "kind": "action_required",
                    "title": "OSV finding review failed",
                    "summary": "The dependency scan did not match the exact reviewed no-patch findings.",
                    "detail": "\n".join(f"- {failure}" for failure in failures),
                    "how_to_fix": (
                        "Patch every finding with an available fix. Review any changed no-patch advisory "
                        "against the exact lock artifact before updating this policy."
                    ),
                }
            ],
        }
    ]


def build_review_status(scan_result: str, results_path: Path) -> tuple[list[dict[str, Any]], bool]:
    """Return ``(status, policy_failure)`` for one OSV workflow run."""
    failures: list[str] = []
    summaries: list[str] = []

    if scan_result != "success":
        failures.append(f"scanner job result was {scan_result or '<missing>'}")
    if not results_path.is_file():
        failures.append("OSV JSON artifact was not produced")
    else:
        try:
            document = json.loads(results_path.read_text(encoding="utf-8"))
            summaries = _validate_results(document)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            failures.append(f"OSV JSON artifact could not be validated: {exc}")

    if failures:
        return _failure_status(failures), True

    count = len(summaries)
    return (
        [
            {
                "source": "osv scan",
                "results": [
                    {
                        "kind": "warning",
                        "title": "Reviewed OSV no-patch findings",
                        "summary": f"{count} reviewed no-patch vulnerabilities remain in pinned dependencies.",
                        "detail": "\n".join(summaries),
                        "how_to_fix": "Update these exact dependencies when upstream publishes patched releases.",
                    }
                ],
            }
        ],
        False,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan-result", required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--status-file", type=Path, required=True)
    args = parser.parse_args(argv)

    status, policy_failure = build_review_status(args.scan_result, args.results)
    encoded = json.dumps(status, separators=(",", ":"))
    args.status_file.write_text(f"review_status={encoded}\n", encoding="utf-8")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as output:
            output.write(f"review_status={encoded}\n")

    return 1 if policy_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
