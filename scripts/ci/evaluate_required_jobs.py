#!/usr/bin/env python3
"""Fail-closed evaluation for GitHub Actions dependency results.

GitHub reports timed-out jobs as ``cancelled`` and conditionally disabled jobs
as ``skipped``. Required dependency gates must be ``success``; only lanes whose
classifier/event condition is explicitly false may be skipped.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Evaluation:
    compact: dict[str, str]
    failed: tuple[str, ...]


def _result(info: object) -> str:
    if not isinstance(info, dict):
        return "missing"
    result = info.get("result")
    return result if isinstance(result, str) and result else "missing"


def evaluate_required_jobs(
    needs: dict[str, object], *, allowed_skips: set[str]
) -> Evaluation:
    """Evaluate concrete job results, allowing only named conditional skips."""
    compact = {name: _result(info) for name, info in sorted(needs.items())}
    failed = tuple(
        name
        for name, result in compact.items()
        if result != "success" and not (result == "skipped" and name in allowed_skips)
    )
    return Evaluation(compact=compact, failed=failed)


def _outputs(needs: dict[str, object], job: str) -> dict[str, Any]:
    info = needs.get(job)
    if not isinstance(info, dict):
        return {}
    outputs = info.get("outputs")
    return outputs if isinstance(outputs, dict) else {}


def allowed_ci_skips(needs: dict[str, object]) -> set[str]:
    """Return skips proven intentional by explicit classifier/event outputs."""
    detect = _outputs(needs, "detect")
    event_name = detect.get("event_name")
    is_pr = event_name == "pull_request"
    is_push = event_name == "push"
    allowed = {"e2e-desktop"}  # Disabled explicitly in ci.yaml with ``false &&``.

    def allow_if_false(job: str, output: str) -> None:
        if detect.get(output) == "false":
            allowed.add(job)

    for job in ("tests", "tests-os", "lint", "contributor-check"):
        allow_if_false(job, "python")

    allow_if_false("js-tests", "frontend")
    allow_if_false("installer-tests", "installer")
    allow_if_false("rust-tests", "rust")
    allow_if_false("docs-site", "site")
    allow_if_false("uv-lockfile", "uv_lock")
    allow_if_false("docker-lint", "docker_meta")

    if is_push:
        allowed.update({"history-check", "lockfile-diff", "supply-chain", "review-labels"})
    elif is_pr:
        if detect.get("npm_lock") == "false":
            allowed.add("lockfile-diff")

        supply_disabled = detect.get("scan") == "false" and detect.get("deps") == "false"
        if supply_disabled:
            allowed.add("supply-chain")

        review_inputs_disabled = (
            detect.get("ci_review") == "false"
            and detect.get("mcp_catalog") == "false"
        )
        supply_outputs = _outputs(needs, "supply-chain")
        critical_explicitly_false = supply_outputs.get("critical_findings") == "false"
        if review_inputs_disabled and (supply_disabled or critical_explicitly_false):
            allowed.add("review-labels")

    return allowed


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--needs-json", required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="allow no skipped jobs (for required dependency-gate workflows)",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        needs = json.loads(args.needs_json)
    except json.JSONDecodeError as error:
        print(f"::error::invalid needs JSON: {error}")
        return 1
    if not isinstance(needs, dict):
        print("::error::needs JSON must be an object")
        return 1

    allowed_skips = set() if args.strict else allowed_ci_skips(needs)
    evaluation = evaluate_required_jobs(needs, allowed_skips=allowed_skips)
    compact_json = json.dumps(evaluation.compact, separators=(",", ":"))
    print(f"needs-json={compact_json}")

    output_path = args.github_output
    if output_path is None and (github_output := os.environ.get("GITHUB_OUTPUT")):
        output_path = Path(github_output)
    if output_path is not None:
        with output_path.open("a", encoding="utf-8") as output:
            output.write(f"needs-json={compact_json}\n")

    for name, result in evaluation.compact.items():
        accepted = result == "success" or (
            result == "skipped" and name in allowed_skips
        )
        print(f"{'✅' if accepted else '❌'} {name}: {result}")

    if evaluation.failed:
        names = ", ".join(evaluation.failed)
        print(
            f"::error::{len(evaluation.failed)} required job(s) incomplete or failed: {names}"
        )
        return 1

    print("All required jobs succeeded; only explicitly disabled lanes were skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
