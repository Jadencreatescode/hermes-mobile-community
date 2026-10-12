"""Behavior tests for the executable CI required-job aggregator."""

from __future__ import annotations

from scripts.ci.evaluate_required_jobs import allowed_ci_skips, evaluate_required_jobs


def _needs(**results: str) -> dict[str, dict[str, object]]:
    return {name: {"result": result, "outputs": {}} for name, result in results.items()}


def test_required_dependency_gate_cancellation_fails_closed():
    result = evaluate_required_jobs(
        _needs(detect="success", **{"osv-scanner": "cancelled"}),
        allowed_skips=set(),
    )

    assert result.failed == ("osv-scanner",)


def test_required_dependency_gate_timed_out_failure_fails_closed():
    result = evaluate_required_jobs(
        _needs(scan="cancelled", **{"whatsapp-production-audit": "success"}),
        allowed_skips=set(),
    )

    assert result.failed == ("scan",)


def test_only_explicitly_allowed_unrelated_lane_may_be_skipped():
    result = evaluate_required_jobs(
        _needs(detect="success", **{"js-tests": "skipped", "osv-scanner": "success"}),
        allowed_skips={"js-tests"},
    )

    assert result.failed == ()


def test_unexpected_skipped_required_gate_fails_closed():
    result = evaluate_required_jobs(
        _needs(detect="success", **{"js-tests": "skipped", "osv-scanner": "skipped"}),
        allowed_skips={"js-tests"},
    )

    assert result.failed == ("osv-scanner",)


def test_unknown_or_malformed_results_fail_closed():
    needs = _needs(detect="success")
    needs["osv-scanner"] = {"outputs": {}}

    result = evaluate_required_jobs(needs, allowed_skips=set())

    assert result.failed == ("osv-scanner",)


def test_classifier_disabled_lane_is_the_only_derived_skip():
    needs: dict[str, object] = {
        "detect": {
            "result": "success",
            "outputs": {
                "event_name": "pull_request",
                "frontend": "false",
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
        },
        "supply-chain": {"result": "success", "outputs": {"critical_findings": "true"}},
    }

    allowed = allowed_ci_skips(needs)

    assert "js-tests" in allowed
    assert "e2e-desktop" in allowed
    assert "osv-scanner" not in allowed


def test_missing_classifier_output_does_not_authorize_a_skip():
    needs: dict[str, object] = {
        "detect": {
            "result": "success",
            "outputs": {"event_name": "pull_request"},
        },
        "js-tests": {"result": "skipped", "outputs": {}},
        "osv-scanner": {"result": "success", "outputs": {}},
    }

    allowed = allowed_ci_skips(needs)
    result = evaluate_required_jobs(needs, allowed_skips=allowed)

    assert "js-tests" not in allowed
    assert result.failed == ("js-tests",)