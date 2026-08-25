# Hermes Mobile release security scope

Hermes Mobile release readiness is evaluated against the exact Strix Halo archive produced by `deploy/strix-halo/build_release.py`, not against every upstream development file retained in this public repository.

## Shipped surface

The archive contains only:

1. The built browser renderer from `apps/desktop/dist`, excluding Electron main process files and `node_modules`.
2. `server/mobile_relay.py`.
3. The transactional Strix Halo installer, lifecycle wrappers, and operator guide under `deploy/strix-halo`.
4. Version, source commit, and SHA 256 manifest evidence.

The verifier rejects unexpected archive members, symlinks, invalid modes, manifest drift, version drift, and source commit drift.

## Security gates

Every mobile release change must pass:

1. Mobile scoped CodeQL analysis for Actions, JavaScript and TypeScript, and Python.
2. The complete mobile dependency audit policy.
3. The website dependency audit.
4. Desktop type checking and renderer build.
5. Installer and relay tests.
6. Two byte identical candidate builds followed by exact archive verification.

The CodeQL configuration intentionally follows the release inputs listed above. Test fixtures, performance harnesses, generated output, dependency folders, and unrelated upstream Hermes components do not determine whether the mobile archive is releasable.

## Repository wide findings

A repository wide CodeQL discovery scan remains useful for upstream engineering triage, but its results must not be presented as findings in the mobile archive unless the affected file is an archive input or runtime dependency. Findings are never deleted or dismissed merely to improve a count. Each release claim is bound to the exact archive inventory and source commit.

## Electron development exceptions

Electron and `extract-zip` remain development only dependencies and are excluded from the Strix Halo archive. Their reviewed advisories, compensating controls, and upgrade criteria are recorded in `docs/npm-security-policy.md`. The project will not trade a verified fresh Windows installation path for a cosmetic zero in the dependency dashboard.
