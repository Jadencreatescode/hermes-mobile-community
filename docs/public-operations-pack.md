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

1. Renderer lives in `apps/desktop/src/plugins/operations` and uses only `@hermes/plugin-sdk`.
2. Durable Mailroom and meeting state live in `plugins/operations/dashboard` behind the authenticated plugin REST namespace.
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
