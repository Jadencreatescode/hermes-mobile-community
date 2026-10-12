#!/usr/bin/env python3
"""Convert an OSV SARIF artifact into a fail-closed CI review status."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


def _as_record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _as_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _result_summary(result: Any) -> str:
    item = _as_record(result, "SARIF result")
    rule_id = item.get("ruleId")
    if not isinstance(rule_id, str) or not rule_id:
        raise ValueError("SARIF result ruleId must be a non-empty string")

    locations = _as_list(item.get("locations"), f"SARIF result {rule_id} locations")
    if not locations:
        raise ValueError(f"SARIF result {rule_id} has no location")
    location = _as_record(locations[0], f"SARIF result {rule_id} location")
    physical = _as_record(location.get("physicalLocation"), "physicalLocation")
    artifact = _as_record(physical.get("artifactLocation"), "artifactLocation")
    uri = artifact.get("uri")
    if not isinstance(uri, str) or not uri:
        raise ValueError(f"SARIF result {rule_id} has no artifact URI")

    return f"- {rule_id} in {uri}"


def build_review_status(scan_result: str, sarif_path: Path) -> tuple[list[dict[str, Any]], bool]:
    """Return ``(status, operational_failure)`` for one OSV workflow run."""
    failures: list[str] = []
    summaries: list[str] = []

    if scan_result != "success":
        failures.append(f"scanner job result was {scan_result or '<missing>'}")

    if not sarif_path.is_file():
        failures.append("SARIF artifact was not produced")
    else:
        try:
            document = _as_record(
                json.loads(sarif_path.read_text(encoding="utf-8")), "SARIF document"
            )
            runs = _as_list(document.get("runs"), "SARIF runs")
            if not runs:
                raise ValueError("SARIF document has no runs")
            for run_index, run in enumerate(runs):
                run_record = _as_record(run, f"SARIF run {run_index}")
                results = _as_list(
                    run_record.get("results"), f"SARIF run {run_index} results"
                )
                summaries.extend(_result_summary(result) for result in results)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            failures.append(f"SARIF artifact could not be validated: {exc}")

    if failures:
        return (
            [
                {
                    "source": "osv scan",
                    "results": [
                        {
                            "kind": "action_required",
                            "title": "OSV vulnerability scan unavailable",
                            "summary": "The dependency vulnerability scan did not produce a trustworthy verdict.",
                            "detail": "\n".join(f"- {failure}" for failure in failures),
                            "how_to_fix": "Inspect the OSV scanner job and rerun it. Do not treat a missing or malformed SARIF artifact as a clean scan.",
                        }
                    ],
                }
            ],
            True,
        )

    if not summaries:
        return [], False

    count = len(summaries)
    noun = "vulnerability" if count == 1 else "vulnerabilities"
    return (
        [
            {
                "source": "osv scan",
                "results": [
                    {
                        "kind": "warning",
                        "title": "OSV vulnerability scan",
                        "summary": f"{count} known {noun} found in pinned dependencies.",
                        "detail": "\n".join(summaries[:20]),
                        "how_to_fix": "Review the findings in the Security tab and update affected dependencies when a patched version is available.",
                    }
                ],
            }
        ],
        False,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan-result", required=True)
    parser.add_argument("--sarif", type=Path, required=True)
    parser.add_argument("--status-file", type=Path, required=True)
    args = parser.parse_args(argv)

    status, operational_failure = build_review_status(args.scan_result, args.sarif)
    encoded = json.dumps(status, separators=(",", ":"))
    args.status_file.write_text(f"review_status={encoded}\n", encoding="utf-8")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as output:
            output.write(f"review_status={encoded}\n")

    return 1 if operational_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
