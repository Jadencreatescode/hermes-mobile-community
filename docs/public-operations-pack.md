# Public Hermes Mobile Operations Pack

## Purpose

Operations adds a coordinated team view on top of existing Hermes authorities. It does not replace or duplicate Bot identity, profiles, sessions, Kanban, routines, approvals, tools, files, models, or computer use.

The public product answers two questions:

1. What are my Hermes Bots and delegated workers doing now?
2. How can I coordinate their messages, decisions, workspaces, and reusable training safely from an iPhone or iPad?

## Public surfaces

### Overview

Operations composes the live Bot roster, profile metadata, active sessions, delegated workers, Kanban assignments, diagnostics, and routines.

Allowed Bot states are `idle`, `working`, `waiting`, `blocked`, `reviewing`, and `unknown`.

Evidence precedence is:

1. Waiting when an authoritative session needs clarification or approval.
2. Blocked when an active Kanban assignment is blocked or carries an unresolved critical diagnostic.
3. Reviewing when an active assignment is in review.
4. Working when a turn, delegated worker, Kanban worker, routine, or fresh worker heartbeat is alive.
5. Idle only when the source is reachable and none of the earlier states apply.
6. Unknown whenever the source or required detail route is unreachable.

### Mailroom

Mailroom is a durable audit envelope around the existing Bot Mode delivery route.

An envelope contains only:

1. Stable identifier.
2. Exact source and target profile identity.
3. Bounded body.
4. Normal, Priority, or Critical urgency.
5. Queued, delivered, acknowledged, failed, expired, or cancelled status.
6. Bounded timestamps and status history.
7. Optional bounded session reference.
8. Bounded deduplication key.

Normal and Priority delivery never interrupt a running turn. Priority only moves ahead of Normal pending mail.

Critical is denied by default. It requires an exact source and target policy with a bounded expiration. Critical requests a cooperative checkpoint and must never forcibly cancel a turn or target an unrelated session. Every policy decision remains auditable.

Renderer responses never expose endpoint URLs, credentials, process commands, environment values, lease tokens, or transport internals.

### Meetings

Meetings provide bounded structured decisions over existing Bot profiles.

A meeting includes a stable identifier, title, agenda, chair, two to six participants, one to five rounds, immutable ordered speak or pass contributions, bounded evidence references, decisions, explicit dissent, action items, and state.

A chair cannot rewrite participant contributions. Meeting sessions must remove unrelated tools, memory, context files, and background review authority. Resuming must never reuse a live session with broader authority.

Conversion to Kanban is a separate explicit action and uses an idempotency key so retries cannot create duplicate work.

There are exactly two meeting shapes, and the wire is one canonical snake_case schema carrying `schema_version: 2`:

1. A **conclusion meeting** is the ordinary discussion/decision/action-item meeting. It carries none of the production fields and completes through the existing conclude path.
2. A **production meeting** carries the complete production bundle and completes only through owner approval of a verified artifact.

Records written before schema v2 are read exactly as stored and are never rewritten. Appending a new version normalizes camelCase input into the canonical keys without touching history.

### Production meetings

A meeting is a production meeting only when the **complete** bundle is present. A partial bundle is refused:

1. `orchestrator` and `producer`, distinct from each other and both participants.
2. `seats` — an ordered one-to-one assignment of every participant, with at least one `reviewer` seat distinct from both the orchestrator and the producer. Production therefore needs at least three source-qualified participant routes.
3. `product_kind`, one of `interactive_web_app`, `three_scene`, `audio_asset`, `video_asset`, or `document`.
4. `output_title` and `acceptance_statement`.

Meeting state stays `draft`, `running`, `waiting`, `completed`, `cancelled`, or `failed`. Production progress is tracked separately in `production_stage`: `briefing`, `working`, `production_ready`, `producing`, `reviewing`, `changes_requested`, `approval_ready`, `completed`.

`production_stage` and `artifact_binding` are **server owned**. A full-record meeting PUT may echo their current values but can neither create nor change them, and the generic conclude path refuses a production meeting outright. Round completion — all participants passing, or the round cap — makes a production meeting eligible for `production_ready`; it never auto-completes it.

The produced output kind is tracked separately as `deliverable_package_v1`, so the package schema and the product category are never conflated.

### Deliverable package format

A deliverable package is a ZIP archive whose member set is exactly the canonical manifest (`deliverable.json`) plus every file the manifest declares.

`deliverable.json` names `schema`, `product_kind`, `title`, `summary`, `primary_file`, and bounded file entries of `path`, `media_type`, `role`, `preview_policy`, `byte_size`, and `sha256`. The manifest has one canonical byte form (sorted keys, compact separators, UTF-8), and `manifest_sha256` is the digest of exactly those bytes.

`game_sha256` is the certified compatibility name for the manifest's **primary-file** digest. It carries no game-specific meaning: for a document, an audio asset, or a web app it is simply the digest of `primary_file`. It is retained on the parity wire on purpose, because renaming it would expand migration and desktop compatibility risk.

Builds are deterministic: members are sorted, timestamps and permissions are fixed, and compression settings are constant, so two builds over identical bytes produce byte-identical archives and the same `zip_sha256`.

Starting public limits are 64 MiB total uncompressed content, 16 MiB per file, a 256 KiB manifest, and 256 files. Collection refuses absolute paths, dot-dot segments, NUL and backslash characters, drive-like paths, duplicate and case-folded path collisions, unsupported preview policies, undeclared files, missing files, symbolic links, hard links, FIFOs, sockets, devices, and any declared digest or size that does not match the real bytes.

### Output lifecycle and immutable evidence

Output state is `candidate`, `reviewing`, `changes_requested`, `verified`, or `approved`. The lifecycle lives in additive tables inside the one existing public meeting database — there is no second database, event bus, or meeting identifier namespace.

1. **Freeze the brief.** The orchestrator's brief, its hash, the acceptance statement, the evidence references, and the source meeting version are stored durably, and the stage reaches `production_ready`.
2. **Checkpoint production.** Starting a run freezes the meeting version, producer route, producer session, frozen brief, and brief hash *before* any producer prompt is dispatched, and mints a server-owned workspace.
3. **Collect.** Collection verifies the workspace tree, builds the deterministic package, persists an immutable artifact version, and records a receipt. Replaying the single-use collection claim returns the original receipt byte-for-byte instead of rebuilding.
4. **Review independently.** A review run freezes the exact artifact version and all three hashes, so a later artifact version can never inherit an earlier verdict.
5. **Approve.** The owner approval transaction compares the meeting version, output version, artifact version, and all three hashes, then atomically approves the output and completes the meeting.

Artifact versions are immutable: `BEFORE UPDATE` and `BEFORE DELETE` triggers abort any attempt to change or remove one, including direct SQL. A revision creates artifact version N+1 with `parent_artifact_version` N; version N survives byte-for-byte, the current verification pointer is cleared, and N+1 requires its own independent review. Approved outputs are terminal — post-approval change needs a new meeting and a new output, never mutation of approved evidence.

Package bytes live in a content-addressed store keyed by the lowercase SHA-256 of the archive. Writes are staged in a mode-0600 temporary file inside the Operations artifact root, stream-hashed, fsynced, atomically renamed, and the parent directory is fsynced before any metadata row references them. A crash may leave an unreferenced blob but never a row pointing at missing bytes. An entry that already carries a blob's name is not trusted for its name: it is opened through its own descriptor with no-follow, required to be a single-link regular file within the package size bound, and re-hashed. Anything else — a link, a directory, a hard link, truncated or wrong bytes — is replaced with the verified bytes, or the write fails before any metadata row can reference the slot.

### Independent review

The selected reviewer must occupy a reviewer seat and differ from both the orchestrator and the producer; anyone else is refused.

Before any AI verdict is accepted, deterministic checks run: package digest, canonical manifest, manifest digest, primary-file digest, per-file digest and size, archive member set and order, fixed archive metadata, preview-policy safety, and frozen-brief identity. A `verified` verdict is impossible while any mandatory check fails or any unresolved high or critical finding exists; otherwise the verdict is `changes_requested` with structured findings.

A reviewer receives a read-only, server-prepared artifact summary and safe previews. It never receives the producer workspace or a writable artifact path.

### Authorization and request safety

Every output read and mutation runs inside the existing authenticated Operations REST authority. Read routes require the existing view capability; meeting and output mutations require the existing owner/admin mutation authority; approval additionally re-checks owner/admin and derives the approver from request authentication.

Approval has no editable approver field and no approval-time field. The authenticated approver's stable principal digest is recorded only in the protected database layer; public responses expose `approved_by` as the non-identifying label `Owner`.

Every lifecycle mutation **requires** `Idempotency-Key`, including the producer, revision, and reviewer dispatch claims; an unkeyed mutation is refused with 400 before any lifecycle work, because without a key a dropped response cannot be told apart from a second intent. Replaying the same key with an identical payload returns the original response without another prompt, run, artifact version, review, revision, or approval; reusing a key with a different payload, or against a different resource, returns 409.

The dispatch claims are keyed for recovery, not just for deduplication. Claiming consumes a dispatch lease and is the only door to the assigned cwd and the single-use collection claim, so the binding, the claim, the dispatcher response, and the replay receipt commit in one transaction on one connection. An exact retry replays that same response — cwd and collection claim included — even while the lease is active, so a dropped response no longer strands a run that can never be collected; a changed binding under the same key is a 409. The collect route hashes the presented collection claim into its canonical request, so one key cannot replay a receipt for a claim the request never presented, and the raw single-use token is never stored a second time.

Status codes are stable: 400 for malformed payloads or a missing/invalid idempotency key, 401 for missing authentication, 403 for insufficient authority or route mismatch, 404 for inaccessible records, 409 for stale versions, invalid transitions, active claims, or idempotency conflicts, 413 for package limits, and 422 for invalid manifests or failed collection checks. Error bodies carry a stable public code and nothing else, so a refusal cannot leak a host path, a claim token, SQL, or an identity.

Previews are served only through the authenticated artifact endpoint, after the stored file digest is recomputed and compared. Text and image previews are size-capped and restricted to a media allowlist; HTML, SVG, script, executable, archive, audio, and video members are download-only. Every artifact response carries `X-Content-Type-Options: nosniff`, a restrictive `Content-Security-Policy` with `sandbox`, `X-Frame-Options: DENY`, and no-store caching. Package HTML is never routed into the general local app preview. Downloads are served from the stored immutable package as an attachment, and the downloaded SHA-256 equals the stored `zip_sha256`.

Hash knowledge, an output id, an artifact version, or a copied URL is not authorization: every preview and download re-checks meeting and output authority.

### Recovery and host scope

Recovery reads the latest meeting, output, active run, prompt claim, workspace receipt, and review after a reload or a process restart. If collection already completed, the stored receipt is consumed instead of recollecting. If a prompt claim is active, the bound session is inspected rather than dispatched again. An expired claim may be renewed only under the identical durable binding, with a bounded renewal count and total lifetime.

Workspaces are reclaimed by a sweep that runs once per process, bounded to a fixed number of removals, on the first output-lifecycle call. A workspace a durable open run still needs is never removed, at any age. A workspace whose run is durably collected or failed is reclaimed immediately, because its immutable bytes live in the content-addressed store rather than in the workspace. A workspace that no durable row references at all — an abandoned or rolled-back run — is reclaimed only once it is older than an explicit grace cutoff, because a workspace minted inside a lifecycle transaction that has not committed yet is indistinguishable from an abandoned one. Mints and sweeps serialize on a lock in the artifact root, and durable state plus the entry's own age are re-read immediately before each removal, so a run published after the listing keeps its workspace.

Server-side collection requires the producer session and the Operations artifact store to share one filesystem authority. A producer on any other connection — including A2A — is **explicitly ineligible** rather than simulated, because pretending a text reply is a collected immutable package would create false parity and break hash provenance. Cross-host producer artifact transfer waits on a separate public, authenticated, size-bounded, hash-bound upload protocol.

Collection containment relies on descriptor-relative no-follow traversal and hard-link refusal. The artifact root itself is created the same way: every component below the deepest already-existing ancestor of the configured path is created with `mkdirat` and opened with `openat` + no-follow, each component's identity is checked, and the root's device and inode are pinned at construction. Every later operation reopens the root by pathname with no-follow and refuses it unless the pinned identity still matches, so a root replaced between the check and the open — by a link or by a different real directory at the same name — never redirects a write, a read, a mint, a sweep, or an assigned cwd. Refusals name no path. Where those guarantees cannot be implemented and tested, server-side collection is limited to supported hosts rather than claiming cross-platform parity.

### Agent Workspace

The workspace binds one exact connection, profile, and session or task. It opens existing Hermes surfaces rather than cloning them:

1. Transcript and activity.
2. Files and changes.
3. Terminal or worker log.
4. Preview.
5. Existing read only screen evidence when the connected Hermes exposes it.

The first public release does not ship private Owner screen takeover. Computer input remains behind the ordinary Hermes approval and computer use surfaces.

### Forge

Forge is a read-only Kanban board view inside Operations. It surfaces the active Hermes Forge pipeline (the `hermes-forge` board) as a responsive grid of columns — triage, todo, ready, running, blocked, review, and done — each holding a stack of cards.

Forge reuses the existing Kanban REST API (`/api/plugins/kanban/*`) through the operations plugin's own REST door, so it works whether or not the standalone Kanban plugin is enabled. It does not add a new public route: Forge is a section within `/operations`, not a route of its own. Each card shows the task title, status icon, assignee, priority, and a truncated summary. The board auto-refreshes every 8 seconds.

Forge is read-only by design. It has no drag-and-drop, no create or edit, and no board switcher. Full board interaction — moving cards, creating tasks, and the task drawer — lives on the standalone `/kanban` route, which Forge links toward when the user needs it.

### Training

Operations links to the existing public Training Mode. Training Mode creates a reviewed, deterministic skill draft and saves it only after hash bound approval. It does not run or schedule the task.

Private Owner browser capture, replay, automatic adoption, private input, fixed node targeting, and takeover authority do not ship in the public Operations Pack.

## Public architecture

1. Renderer lives in `apps/desktop/src/plugins/operations` and uses only `@hermes/plugin-sdk`. The renderer model is camelCase internally and converts at the wire boundary; it authors no hash, approver, approval time, production stage, or artifact binding.
2. Durable Mailroom and meeting state live in `plugins/operations/dashboard` behind the authenticated plugin REST namespace. The output lifecycle is additive tables in the same meeting database, so owner approval can approve the output and complete the meeting in one transaction.
3. Existing profile and session RPC remain authoritative for roster and activity.
4. Existing Kanban commands and plugin APIs remain authoritative for work.
5. Existing Bot Mode delivery remains authoritative for sending to Bot Chat.
6. Existing Training Mode remains authoritative for skill creation.
7. The mobile relay proxies the same authenticated API and WebSocket paths. Operations adds no new public listener, arbitrary node URL, or credential surface.

## Private exclusions

The public repository must not contain or infer:

1. Owner identities or owner credentials.
2. Fixed private node names, addresses, or Tailscale policy.
3. Private Android Owner or Watch broker code.
4. Private SMS, notification, or local message history.
5. Private browser capture, secret input, replay, or scheduling authority.
6. Owner only screen takeover or exact private machine bindings.
7. Deployment credentials, private release paths, or private service URLs.

## Responsive contract

Required widths are 344, 360, 390, 412, 768, 1024, and 1440 CSS pixels.

1. Phone uses one column and a full width section selector.
2. Tablet and desktop use a navigation rail plus content.
3. Every primary control is at least 44 CSS pixels high on coarse pointers.
4. Top and bottom safe area insets are consumed.
5. No horizontal document overflow is allowed.
6. Detail dialogs trap focus, make the background inert, and restore focus.
7. Loading, empty, partial source failure, offline, reconnecting, conflict, expired policy, and permission denied states are explicit.
8. The last verified snapshot remains visible during a refresh failure.
9. The responsive audit exercises every Operations section — Overview, Mailroom, Meetings, Agent Workspace, Forge, and Training — at every required width.
10. The deliverable package panel mounts inside the existing meeting room rather than on a separate production page, and shows the immutable version selector, hashes, manifest, findings, and lineage without horizontal overflow. It never asks the user to paste a hash or an approver identity, and each action appears only when the server marks it eligible.

## Release gates

1. Every behavior is introduced by a failing test and reaches focused green.
2. Renderer tests, backend plugin tests, Bot Mode tests, Kanban tests, Training tests, relay tests, type checks, lint, and production build pass.
3. Mobile audit policy and website audit pass.
4. Privacy scans find no Owner identifiers, credentials, private routes, node addresses, or secret shaped values.
5. Browser acceptance exercises every required width and every Operations section with zero overflow and zero console or page errors.
6. The Forge section renders its read-only board at every width without overflow, and its 8-second refresh cycle produces no console or page errors.
7. A fresh clone of the exact candidate reproduces tests and build.
8. Independent specification, code quality, security, and privacy reviews pass.
9. Merge occurs only through a pull request after required GitHub checks pass.
