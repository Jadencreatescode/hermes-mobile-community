# Hermes Agent - Development Guide

Instructions for AI coding assistants and developers working on the hermes-agent codebase.

**Never give up on the right solution.**

> **This repo's scope:** see `README.md` — this tree is the public Hermes
> Mobile Control Center split (renderer, relay, tests, Strix Halo installer),
> vendored from the upstream hermes-agent monorepo. Most of the rubric below
> is upstream-authored and still describes the vendored code faithfully, but
> is not mobile-specific. Where it conflicts with `README.md`'s stated
> boundaries, `README.md` wins.

## What Hermes Is

Hermes is a personal AI agent running the same core across a CLI, a
messaging gateway (~20 platforms), a TUI, and an Electron desktop app. It
learns across sessions (memory + skills), delegates to subagents, runs
scheduled jobs, and drives a real terminal and browser. Extended primarily
through **plugins and skills**, not by growing the core.

Two properties shape almost every design decision:

- **Per-conversation prompt caching is sacred.** Anything that mutates past
  context, swaps toolsets, or rebuilds the system prompt mid-conversation
  invalidates the cache and multiplies cost. Only exception: context
  compression.
- **The core is a narrow waist; capability lives at the edges.** Every
  model tool ships on every API call, so the bar for a new *core* tool is
  high. Prefer a CLI command + skill, a service-gated tool, or a plugin.

## Contribution Rubric

Full priority ordering and process: `CONTRIBUTING.md` § Contribution
Priorities. This adds the triage-safety framing CONTRIBUTING doesn't cover:
this rubric also guides the automated PR-triage sweeper's 3 allowed close
reasons (`implemented_on_main`, `cannot_reproduce`, `incoherent`) and — just
as important — when NOT to close (taste-based "out of scope" closes stay
with a human). We're expansive at the edges, conservative at the waist.

**What we want** (beyond CONTRIBUTING.md's list):
- Fix real bugs well: reproduce on `main`, cite the exact line, fix the
  whole bug class (sibling call paths included).
- Refactor god-files (`cli.py`, `run_agent.py`, `gateway/run.py`) into
  clean modules — wanted even at huge, mechanical diff size.
- Keep the core narrow (see Footprint Ladder below).
- Extend, don't duplicate — check existing infra first; when 3+ PRs
  integrate the same category, design one ABC + orchestrator instead of
  merging them one at a time.
- Behavior contracts over snapshots (see Testing).
- E2E validation against a real temp `HERMES_HOME`, not just mocks, for
  anything touching resolution chains, config, security boundaries, or I/O.
- Cache-, alternation-, and invariant-safe (strict role alternation, no
  synthetic user messages mid-loop, byte-stable system prompt).
- Preserve contributor credit — cherry-pick (rebase-merge), don't reimplement.

**What we don't want** (rejected even when well-built):
- Speculative hooks/callbacks with no concrete consumer.
- New `HERMES_*` env vars for non-secret config — `.env` is secrets only;
  behavioral settings go in `config.yaml`.
- A new core tool where terminal + file (or a skill) already suffice.
- `offset`/`limit` pagination on instructional tools the agent must read in
  full (skills, prompts, playbooks).
- "Fixes" that destroy the feature they secure — read `git log -p -S`
  before restricting behavior.
- Outbound telemetry/attribution without opt-in gating.
- Change-detector tests, cache-breaking mid-conversation, dead code wired
  in without E2E proof, plugins that touch core files.
- Third-party products folded into the core tree — see CONTRIBUTING.md
  § Third-Party Product Integrations; same policy, no exception here.

### Before you call it a bug — verify the premise

The most common reason a well-written PR gets closed isn't code quality —
it's a **wrong premise**, or treating **intentional design as a gap**. Tells
a human reviewer what to scrutinize, and tells the sweeper when NOT to
close (when in doubt, leave it for a human):

- **Intentional design, not a gap.** A limitation that looks like an
  oversight is often deliberate — e.g. profiles are independent islands on
  purpose; a PR adding live config inheritance from the default profile was
  closed because that coupling is exactly what the design prevents. Check
  `git log -p -S "<symbol>"` before assuming something's unfinished.
- **Premise doesn't hold against how X actually works.** Trace the real
  code before accepting a PR's rationale. Real closes: a rate-limit
  "re-probe during cooldown" PR (the breaker only trips on a
  confirmed-empty bucket — re-probing hammers a bucket already proven
  empty); a fix whose new branch never executes because an earlier guard
  already popped the state it depended on.
- **The omission was deliberate.** Restoring "missing" `__init__.py` files
  once made a test tree shadow the real plugin, deleting its `register()`
  at import time. Absence can be load-bearing.
- **Overreached / resurrected a closed direction.** Scope creep beyond the
  agreed base gets rejected even when the code works.

Verify the claim AND the intent against the codebase before writing or
merging a fix. When in doubt, ask rather than ship a fix that fights the
design.

### The Footprint Ladder

Choose the highest (least-footprint) rung that correctly solves the problem:

1. **Extend existing code** — zero new surface.
2. **CLI command + skill** — zero model-tool footprint (`hermes webhook`,
   `hermes cron`, `hermes tools`).
3. **Service-gated tool (`check_fn`)** — zero footprint until a
   prerequisite is configured.
4. **Plugin** — third-party/niche capability, `~/.hermes/plugins/` or pip.
5. **MCP server (catalog)** — structured I/O tool that isn't core-fundamental.
6. **New core tool** — only when fundamental, broadly useful, and
   unreachable via terminal + file or MCP (terminal, read_file, web_search).

3+ open PRs integrating the same category (memory backends, providers,
notifiers) → design an ABC + orchestrator once, turn competitors into
plugins against it.

### Surface capability is a property of the SESSION, not the process env

A tool that only works because of *who's on the other end* (desktop panes,
in-app browser, reactions, Projects) must resolve availability from the
**session's own source**, never an env var on the backend process — the
client and backend are separate machines on separate clocks (local
Electron, SSH, URL+token, Hermes Cloud all connect to the same backend
code). An env-keyed gate silently no-ops on every topology but the first.

Pattern that works:
- **The toolset is the surface gate.** Keep such tools off
  `_HERMES_CORE_TOOLS`, put them in a named toolset (`desktop_ui`,
  `project`); the GUI gateway folds it in per-session by platform.
- **`check_fn` answers reachability/opt-in, not surface.** "Is the
  renderer bridge wired?" — fine. "Was I spawned by Electron?" — not fine
  (also TTL-cached process-wide, so a per-session answer can't live there).
- **`HERMES_DESKTOP=1` means "spawned by the app"**, not "a GUI is
  watching" — the embedded terminal pane (`hermes --tui` on that same
  backend) is the standing counterexample.

Test: if the capability still makes sense with the client on another
machine, it's session-scoped — assert the GUI session gets the tool with
the env var absent.

## Repository Map & Pointers

Canonical source is the filesystem; this only names the one non-obvious
fact per area, then points to the doc that has the rest. Fuller tree +
dev setup: `CONTRIBUTING.md`.

- **Core loop**: `run_agent.py` (`AIAgent`), `model_tools.py`
  (`handle_function_call()`), `toolsets.py` (`TOOLSETS` dict,
  `_HERMES_CORE_TOOLS` default bundle; enable/disable via `hermes tools`
  or `tools.<platform>.enabled/disabled`). Deps: `tools/registry.py` ←
  `tools/*.py` (auto-registered) ← `model_tools.py` ← `run_agent.py`/`cli.py`.
- **CLI**: `cli.py` (`HermesCLI`). All slash commands live in one
  `COMMAND_REGISTRY` (`hermes_cli/commands.py`) — every consumer (CLI,
  gateway, Telegram, Slack, autocomplete) derives from it automatically.
  Wrapper-CLI extension hooks: `developer-guide/extending-the-cli.md`.
- **TUI** (`ui-tui/` + `tui_gateway/`): Ink renders, Python owns
  sessions/tools over JSON-RPC. Dashboard's embedded chat is the REAL
  `hermes --tui` via a PTY bridge — never re-implement it there.
- **Electron Desktop** (`apps/desktop/`): separate chat surface over the
  same `tui_gateway` JSON-RPC. Scoped rules incl. the Bot Mode
  canonical-forever-chat contract: `apps/desktop/AGENTS.md` — read before
  touching that tree.
- **Gateway** (`gateway/`): `run.py` + `session.py` + one adapter per
  platform in `platforms/` (see
  `developer-guide/adding-platform-adapters.md`).
- **Plugins** (`plugins/`): general (`hermes_cli/plugins.py`,
  `register(ctx)` hooks) plus three separate discovery systems — memory
  (`plugins/memory/`), model-provider (`plugins/model-providers/`),
  image-gen/context-engine. Authoring guides:
  `developer-guide/{memory,model}-provider-plugin.md`,
  `context-engine-plugin.md`, `image-gen-provider-plugin.md`,
  `plugins/index.md` (compatibility contract). Policy: no new in-tree
  memory or third-party-product plugins — standalone repo instead
  (CONTRIBUTING.md § Memory Providers / § Third-Party Product
  Integrations). Discovery-timing pitfall, the core-file rule, and the
  model-provider `kind:` caveat: `developer-guide/core-agent-internals-notes.md`.
- **Skills** (`skills/` bundled + `optional-skills/` niche, installed via
  `hermes skills install official/<category>/<skill>`). Frontmatter +
  authoring HARDLINE rules live in `developer-guide/creating-skills.md`
  and `CONTRIBUTING.md` — don't restate here. Loader quirk not in either:
  top-level `tags:`/`category:` are accepted and mirrored from
  `metadata.hermes.*`.
- **Skins** (`hermes_cli/skin_engine.py`, `~/.hermes/skins/*.yaml`):
  pure-data, no code for a new skin. Current roster + what each key
  customizes: `user-guide/features/skins.md`. Authoring walkthrough:
  `CONTRIBUTING.md` § Adding a Skin/Theme.
- **Delegation** (`tools/delegate_tool.py`): full usage in
  `user-guide/features/delegation.md` — read that, not a paraphrase.
  Durability: background delegation is process-local; for
  restart-survival use `cronjob` or
  `terminal(background=True, notify_on_complete=True)`.
- **Curator**: usage in `user-guide/features/curator.md`. Safety
  invariants: only touches `created_by: "agent"` skills, never deletes
  (max action = archive), pinned skills exempt from auto-transitions.
- **Cron** (`cron/jobs.py`+`scheduler.py`): usage in
  `user-guide/features/cron.md` + `developer-guide/cron-internals.md`.
  Hardening numbers (3-min hard interrupt, catchup/grace windows, tick
  lock): `core-agent-internals-notes.md`.
- **Kanban**: usage in `user-guide/features/kanban*.md`. Isolation model
  (board = hard boundary, tenant = soft namespace, failure_limit
  auto-block): `core-agent-internals-notes.md`.
- **Update pipeline** (`hermes update`): stage-by-stage rationale (why
  plan/snapshot/apply/restart/verify/report each exist, what field
  failure each guards): `core-agent-internals-notes.md` only — no
  user-doc equivalent.
- **Config**: `config.yaml` keys → `DEFAULT_CONFIG`
  (`hermes_cli/config.py`); `.env` keys (secrets only) →
  `OPTIONAL_ENV_VARS`. Three loaders exist (`load_cli_config()`,
  `load_config()`, gateway's direct YAML read) — a key working in one but
  not another means a missing loader. Working dir: CLI uses `os.getcwd()`;
  gateway uses `terminal.cwd` (bridged to `TERMINAL_CWD` for children;
  `MESSAGING_CWD` is removed, don't reintroduce).
- **Adding a tool**: settle the Footprint Ladder first — most capability
  should be a plugin, not core. Core tools need exactly 2 files
  (`tools/your_tool.py` + a toolset entry); full example +
  `display_hermes_home()`/`get_hermes_home()` rules: `CONTRIBUTING.md`
  § Adding a New Tool.
- **Dependencies**: all need upper bounds (`>=floor,<next_major`; git
  URLs pin a commit SHA). Full policy + PR refs: `CONTRIBUTING.md`
  § Dependency pinning policy.

## TypeScript Style

Applies across desktop, TUI, website, and future TS packages.

- Small nanostores over component state for shared/reused/distant-read state.
- Each feature owns its atoms (chat state near chat, shell state near shell).
- `useStore` for rendering; `$atom.get()` for non-rendering reads.
- Don't thread state through 3 components when the leaf can subscribe directly.
- Keep persistence beside the atom that owns it; route roots stay thin.
- No monolithic hooks — one narrow job per hook; prefer colocated action
  modules over hidden god hooks.
- Pure-side-effect callbacks use the terse void form: `onClick={() => void save()}`.
- Prefer `interface` for public props/shared shapes; extend React
  primitives (`React.ComponentProps<'button'>`, `Omit<...>`).
- Table-driven beats condition ladders for ids/routes/views.
- `src/app` = routes/pages; `src/store` = shared atoms; `src/lib` = pure helpers.

## Profiles: Multi-Instance Support

`_apply_profile_override()` (`hermes_cli/main.py`) sets `HERMES_HOME`
before any imports; `get_hermes_home()` scopes to it automatically.

1. **Use `get_hermes_home()`**, never hardcode `~/.hermes` — source of 5
   bugs fixed in PR #3575.
2. **Use `display_hermes_home()`** for user-facing messages.
3. Module-level constants are fine — they cache after the override runs.
4. Tests mocking `Path.home()` must also set `HERMES_HOME` explicitly.
5. **`_get_profiles_root()` is HOME-anchored**, not HERMES_HOME-anchored —
   intentional, so `hermes -p x profile list` sees every profile.
6. Gateway adapters connecting with a unique credential should use
   `acquire_scoped_lock()`/`release_scoped_lock()` (`gateway.status`) so
   two profiles can't share one. See `plugins/platforms/irc/adapter.py`.
7. Multiplex profile-scoped env reads must fail closed (never borrow from
   `os.environ`) — full contract: `core-agent-internals-notes.md`.

## Known Pitfalls

- **Never hardcode `~/.hermes`** — use `get_hermes_home()`/`display_hermes_home()`.
- **CLI menu-pickers must use curses** (`hermes_cli/curses_ui.py`).
- **Never use `\033[K`** in spinner/display code — leaks under
  `prompt_toolkit`; pad with spaces instead (`f"\r{line}{' ' * pad}"`).
- **`_last_resolved_tool_names`** (`model_tools.py`) is a process-global
  saved/restored around subagent execution — may be stale mid-child-run.
- **Never hardcode cross-tool references in schema descriptions** (a
  named tool may be unavailable) — add cross-refs dynamically in
  `get_tool_definitions()` instead.
- **Two gateway message guards** (base adapter + gateway runner) both
  must bypass approval/control commands — detail:
  `core-agent-internals-notes.md`.
- **Never infer process identity from argv substrings** — use the
  canonical matchers (`looks_like_gateway_command_line`,
  `_hermes_holder_subcommand`); ~10 issues came from hand-rolled scans.
  Detail: `core-agent-internals-notes.md`.
- **Squash-merge only after rebasing onto `main`** — a stale branch can
  silently revert recent fixes; verify with `git diff HEAD~1..HEAD`.
- **Don't wire in dead code without E2E proof** against a temp
  `HERMES_HOME` — it was dead for a reason.
- **Streaming delivery contract** (stream-is-the-message adapters): 4
  invariants, detail in `core-agent-internals-notes.md`.

## Testing

**Always use `scripts/run_tests.sh`**, never call `pytest` directly — it
enforces CI parity (hermetic env, TZ=UTC, per-file subprocess isolation).
Full flags + flake policy: `CONTRIBUTING.md` § Run tests.

```bash
scripts/run_tests.sh                                    # full suite
scripts/run_tests.sh tests/agent/test_foo.py -k test_x   # one test
```

Tests auto-redirect `HERMES_HOME` to temp dirs (`_isolate_hermes_home`
fixture) — never hardcode `~/.hermes/` in a test.

**Don't fake the host OS.** Real per-host differences are tested by
running on that host (`@pytest.mark.linux_only`/`macos_only`/`windows_only`),
not by patching `sys.platform` (code also calls `platform.system()`
independently — patch both if you must mock). Use the marker, never a
bare `skipif` — the OS-lane classifier greps for the marker name, so a
bare `skipif` runs on no host at all, silently.

**Don't write change-detector tests** — assertions that fail whenever
*expected-to-change* data updates (model catalogs, version literals,
enumeration counts) add no coverage, they just break CI on every routine
update. Assert invariants instead:

```python
# DON'T: assert "gemini-2.5-pro" in _PROVIDER_MODELS["gemini"]
# DO:    assert "gemini" in _PROVIDER_MODELS and len(_PROVIDER_MODELS["gemini"]) >= 1
# DO:    for m in _PROVIDER_MODELS["huggingface"]: assert m.lower() in DEFAULT_CONTEXT_LENGTHS_LOWER
```

**Never read source code in tests** — a test asserting on `.py`/`.ts`
file text checks source shape, not behavior; it passes on subtly broken
code and fails on a correct refactor. Extract the logic into a small
pure/DI-testable function and call it for real instead. If the logic is
inline in a god-file and extracting feels disruptive, that's the signal
to extract, not to regex around it.

**Place tests by what changed**: the CI change classifier
(`scripts/ci/classify_changes.py`) runs jobs based on changed files — a
Python test asserting on `package.json`/`.ts` content belongs in the JS
suite, or it can go green on the PR and red on `main`.
