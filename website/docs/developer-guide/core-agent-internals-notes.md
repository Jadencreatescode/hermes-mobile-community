---
sidebar_position: 30
title: "Core Agent Internals Notes"
description: "Hardening invariants, timing pitfalls, and PR-numbered lessons for hermes-agent core internals — not end-user usage docs."
---

# Core Agent Internals Notes

Institutional memory for engineers editing `run_agent.py`, `model_tools.py`,
`cli.py`, `gateway/run.py`, `cron/`, `plugins/`, and related core modules.
This is not a usage guide — for usage see the linked feature docs under
`user-guide/features/`. This page exists so hard-won lessons (regressions,
PR numbers, the reasoning behind an invariant) survive refactors instead of
getting rediscovered the expensive way.

## Plugin discovery timing pitfall

`discover_plugins()` only runs as a side effect of importing `model_tools.py`.
Code paths that read plugin state without importing `model_tools.py` first
must call `discover_plugins()` explicitly — it's idempotent, so calling it
defensively is always safe.

## Rule (Teknium, May 2026): plugins must not modify core files

Plugins MUST NOT modify core files (`run_agent.py`, `cli.py`,
`gateway/run.py`, `hermes_cli/main.py`, etc.). If a plugin needs a
capability the framework doesn't expose, expand the generic plugin surface
(new hook, new `ctx` method) — never hardcode plugin-specific logic into
core. PR #5295 removed 95 lines of hardcoded honcho argparse from
`main.py` for exactly this reason; that PR is the canonical example of
what NOT to do again.

## Model-provider plugin discovery caveat

The general `PluginManager` records `kind: model-provider` manifests but
deliberately does NOT import them — importing would double-instantiate
`ProviderProfile`. `providers/__init__.py._discover_providers()` is a
separate, lazy discovery system scanned on first `get_provider_profile()`
or `list_providers()` call. Plugins without an explicit `kind:` field get
auto-coerced via a source-text heuristic (`register_provider` +
`ProviderProfile` found in `__init__.py`). See
[model-provider-plugin.md](./model-provider-plugin.md) for the full scan
order and authoring guide.

## Cron hardening invariants

Beyond the usage doc ([cron.md](../user-guide/features/cron.md)) and
[cron-internals.md](./cron-internals.md), three specific numbers are
load-bearing and not documented elsewhere:

- **3-minute hard interrupt** on cron sessions — runaway agent loops
  cannot monopolize the scheduler.
- **Catchup window**: half the job's period, clamped to 120s–2h.
- **Grace window**: 120s for one-shot jobs whose fire time was missed.

Also: a file lock at `~/.hermes/cron/.tick.lock` prevents duplicate ticks
across processes, and cron sessions pass `skip_memory=True` by default —
memory providers intentionally do not run during cron. Cron deliveries are
**not** mirrored into the target gateway session; they land in their own
cron session with a header/footer frame so the main conversation's
message-role alternation stays intact.

## Kanban isolation model

- **Board** is the hard boundary — workers are spawned with
  `HERMES_KANBAN_BOARD` pinned in their env so they can't see other boards.
- **Tenant** is a soft namespace *within* a board — one specialist fleet
  can serve multiple businesses with workspace-path + memory-key isolation.
- After `kanban.failure_limit` consecutive non-success attempts on the
  same task (default: 2), the dispatcher auto-blocks it to prevent spin
  loops.

See [kanban.md](../user-guide/features/kanban.md) and
[kanban-worker-lanes.md](../user-guide/features/kanban-worker-lanes.md)
for usage; this page only covers the isolation invariants.

## Update pipeline (`hermes update`): why each stage exists

The updater is transactional in shape (fleet-update campaign, #91277 —
Aug 2026). Every stage exists because its absence was a real field
failure; a PR that weakens a stage needs to answer for the failure class
it guards:

```
plan → snapshot → apply → restart-per-kind → verify → report
```

- **Plan**: read-only inventory — install kind, all profiles, every live
  gateway with supervisor + running code version. Deployment kinds are
  first-class: `git` updates in place; `docker`/`nix`/`apt` are NOT
  in-place-updatable and the updater reports the correct external command
  instead of fighting the deployment model.
- **Snapshot**: pre-update quick snapshot for EVERY profile (the code
  swap + fleet restart touch all of them), each into its own
  `state-snapshots/`, identical file set + 1 GiB per-file cap + keep=1.
  Never add a partial/tiered snapshot set — mixed coverage creates
  torn-restore states across schema generations. Quick snapshots are
  FILE-LOSS RECOVERY, NOT code-rollback insurance; `--backup` full mode
  owns rollback.
- **Apply**: git pull, or the Windows ZIP fallback — which fires ONLY
  when git itself failed (argv-classified; a dependency-install failure
  must never trigger a tree-clobbering re-download), REFUSES a dirty
  working tree, and grafts the live `apps/desktop/release/` into the
  staged swap (the GitHub source ZIP has no built desktop app; without
  the graft the swap deletes it).
- **Restart-per-kind**: systemd and launchd restarts are FLEET-WIDE
  (every `hermes-gateway*` unit / `ai.hermes.gateway*` LaunchAgent),
  drain-first (SIGUSR1) with per-unit/per-label failure isolation.
  Restarting only the invoking profile's service leaves siblings on
  stale `sys.modules` until they crash — the largest dupe-PR cluster in
  the repo's history came from that bug.
- **Verify**: gateways stamp their running `code_sha`/`code_version` into
  `gateway_state.json` on every runtime-status write; after the restart
  phase the updater compares each live gateway against the fresh checkout
  and prints a fleet version matrix. A provably-stale gateway fails the
  update (exit 1) — automation must never treat a mixed-version fleet as
  healthy.
- **Report**: every run writes a machine-readable receipt to
  `~/.hermes/logs/update_receipts/` (`latest.json` pointer). A
  begun-but-unwritten receipt is a bug: refused/failed runs are exactly
  the ones receipts exist for.

Architecture direction: process-scan-based coordination between the
updater, serve/dashboard, and the gateway is being replaced by a
gateway-owned control socket (#92091). Do not add new scan heuristics
without checking that design first.

### Gateway lifecycle vs. the Desktop app

`hermes serve` (control plane, desktop-spawned child) dies with the app —
by design. The messaging gateway (`gateway run`) SURVIVES the app: the
serve backend's `/api/gateway/*` endpoints spawn it detached, so
`before-quit`'s backend SIGTERM never reaches it. Bots keep running when
the user closes the app. The known breach of this contract is the
Windows shim-unlock teardown (`taskkill /T /F` on venv-shim holders,
#85265) — it exists to let updates proceed, and its replacement is
#92091's `pause-for-update`. Do not "fix" gateway-dies-with-app reports
by re-parenting the gateway under the backend, and do not "fix" update
locks by widening the tree-kill.

## Process-identity classification: do NOT infer from argv substrings

The bug class behind ~10 fleet-update issues (#90778, #87594, #78089,
#76129, #91964, ...): classifying a process by `"serve" in cmdline` or
similar. `kanban --preserve-cache` contains "serve"; a flag VALUE can
equal a subcommand (`-m dashboard serve`); truncated cmdlines hide the
real subcommand. Rules:

- Use the canonical matchers: `gateway.status.looks_like_gateway_command_line`
  (gateway run), `hermes_cli.update_cmd._hermes_holder_subcommand`
  (top-level subcommand of any Hermes argv). Never hand-roll token scans.
- Flag sets must be DERIVED from the parser (`_holder_value_flags()`
  introspects `build_top_level_parser()`), never hand-written lists —
  they drift.
- Never blanket-exclude ancestors from process scans: when `/update` runs
  as the gateway's child, a gateway ancestor must stay visible to the
  pause machinery (#87594). Exclude interactive ancestry, carve out
  gateway-shaped ancestors.
- Match on FULL cmdlines; truncate only at display time (#78089).
- Before adding any new scan heuristic, read #92091 — the gateway control
  socket replaces scans as the primary coordination mechanism; scans are
  the fallback layer for old/crashed processes.

## Streaming delivery contract (stream-is-the-message adapters)

Adapters with `draft_stream_is_message = True` (relay Slack native
streaming) keep ONE cumulative native stream per turn; the stream IS the
final message. Four invariants, each learned from a live duplicate-final
incident (NS-658 canary ledger, hermes#85796 / gateway-gateway#210):

1. **Draft frames must be prefix-stable.** The connector computes
   append-only deltas: frame N must be a string prefix of frame N+1. NEVER
   mutate draft frames per-tick — no fence-closing, no cursor suffix, no
   segment-state resets at tool boundaries, no mrkdwn conversion. Any
   non-prefix frame triggers a whole-snapshot re-append on the platform
   ("stacked copies"). The finalize path may still transform the real
   final.
2. **The consumer declares the final; the adapter never guesses.**
   `finish(final_text)` carries the completed `final_response` as the
   authoritative finalize payload. New post-stream response augmentation
   MUST ride this payload.
3. **Interim sends must carry `_interim_send` metadata.** Any
   consumer-side `adapter.send()` that is NOT the turn-final must set
   `metadata["_interim_send"] = True`, or the relay adapter's
   seal-interception will seal the live stream with interim text.
   Seal-interception exists at BOTH egress doors (`send()` AND
   `send_for_platform()`).
4. **Reconcile by edit, never by plain send.** Any lane that delivers a
   final beside an already-sealed stream must first try `edit_message`
   on the consumer's `message_id`; plain `send()` is the fallback only
   when no editable message exists.

Contract tests: `tests/gateway/test_stream_final_contract.py`.

## Multiplex profile-scoped env reads must fail closed

`agent/secret_scope.py` contract (#72348, #86905): under
`gateway.multiplex_profiles`, `os.environ` holds the **default profile's**
values; a secondary profile's `.env` lives only in its secret scope
(installed per-turn by `_profile_runtime_scope`). Any profile-level env
config — credentials AND authorization (allowlists, allow-all flags,
group policy) — must be read scope-aware and must NEVER fall through to
`os.environ` on a scoped miss (that leaks another profile's value and can
silently break routing/admission — a leaked default allowlist skips the
allow-all check and rejects every secondary-profile sender, #86905).
Unscoped default-profile and single-profile deployments keep the
`os.environ` read; there it IS the profile's own value.

## Gateway message guards (two, both must bypass control commands)

When an agent is running, messages pass through two sequential guards:
(1) the base adapter (`gateway/platforms/base.py`) queues messages in
`_pending_messages` when the session is active, and (2) the gateway
runner (`gateway/run.py`) intercepts `/stop`, `/new`, `/queue`,
`/status`, `/approve`, `/deny` before they reach
`running_agent.interrupt()`. Any new command that must reach the runner
while the agent is blocked must bypass BOTH guards and be dispatched
inline, not via `_process_message_background()` (which races session
lifecycle).
