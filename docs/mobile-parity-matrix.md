# Mobile Parity Matrix

Status values: Layout verified, Interaction verified, Needs adaptation, Pending.

Viewport route matrix:

1. Android narrow, 320 by 568
2. Fold outer, 344 by 882
3. iPhone portrait, 390 by 844
4. iPhone landscape, 844 by 390
5. Fold inner portrait, 884 by 1104
6. Fold inner landscape, 1104 by 884
7. Tablet portrait, 768 by 1024
8. Desktop, 1440 by 900

| Surface | Core behavior | Phone | Fold outer | Fold inner | Tablet | iPhone | Desktop | Evidence and remaining work |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New assistant | Gateway boot, transcript, composer, model controls | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Real authenticated gateway and WebSocket verified. Disposable streaming turn remains pending. |
| Sessions and sidebar | List, search, resume, pin, profile groups | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Sidebar and Command Center render without overflow. Resume and mutation routes remain pending. |
| Bot Mode | Bots tab, roster, Bot Chat, group chats, routines, New Agent | Interaction verified | Interaction verified | Layout verified | Layout verified | Layout verified | Existing Desktop interface | Fold outer browser contract opens the sidebar and Bots tab, verifies the Bot Mode workspace and New Agent control, and retains screenshot evidence. The bundled Bot Mode suite passes 362 tests. iPhone acceptance still requires one real bot turn against a current compatible backend. |
| Training Mode | In-memory guided coaching, semantic task details, documented browser-demonstration boundary, server-generated draft review, full-hash approval, skill creation | Interaction verified | Interaction verified | Layout verified | Layout verified | Layout verified | Layout verified | Focused UI, contract, and backend tests prove zero-network coaching, the three-part entry gate, deterministic server draft, exact full-hash save phrase, canonical write and literal installed-byte readback, idempotent retry, collision refusal, raw-value and private-browser-data exclusion, private-target rejection, stale-input invalidation, non-echoing uncached errors, untrusted-data containment, and zero browser, task-execution, or scheduling routes. Physical iPhone skill creation remains pending. |
| Operations Pack | Bot and worker overview, source health, routines, durable Mailroom urgency, bounded meetings, exact Agent Workspaces, Training link | Interaction verified | Interaction verified | Layout verified | Layout verified | Layout verified | Layout verified | Uses existing profile, session, Kanban, routine, Bot Mode, and Training authorities. Critical delivery is denied until one exact expiring route is approved and never forcibly cancels work. Meetings use restricted hidden sessions. Public workspaces open existing Hermes surfaces and expose no private Owner takeover. Physical iPhone acceptance remains pending. |
| Files and artifacts | Attach, preview, download, artifact route | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Artifacts route renders. Camera, upload, download, and preview interactions remain pending. |
| Models | Main model, reasoning, auxiliary assignments | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Real model data loaded through authenticated relay. Writes protected from production testing. Unit behavior remains GREEN. |
| Mixture of Agents | Presets, references, aggregator, enable controls | Interaction verified | Interaction verified | Layout verified | Layout verified | Layout verified | Layout verified | Phone contract proves every ordinary action and field is at least 44 pixels, selectors stack, switches are labelled, no overflow or errors. Existing 21 behavior tests pass. |
| Cron and scheduled jobs | List, create, edit, run, pause, inspect | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/cron` route verified. State changing interactions remain pending. |
| Skills and MCP | Browse skills, tools, MCP, install and configure | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/skills` route verified. Full capability interaction audit remains pending. |
| Messaging | Channel and platform management | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/messaging` route verified. Configuration writes remain pending. |
| Webhooks | Create and manage subscriptions | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/webhooks` route verified. Create and revoke remain pending. |
| Profiles and agents | List, switch, create, configure specialists | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/profiles` and `/agents` routes verified. Browser bridge preserves registered connection and profile scope. Live switch remains pending. |
| Command Center and system | Sessions, system, usage, diagnostics | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/command-center` route verified. Native-only operations require explicit browser equivalents. |
| Starmap | Memory and activity visualization | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | Layout verified | `/starmap` route verified without overflow or errors. Gestures remain pending. |
| Node switching | VPS, Bridge, and Helm selection | Interaction verified | Interaction verified | Layout verified | Layout verified | Layout verified | Existing Desktop registry | Fixed relay, isolated cookies, all three logins and WebSockets, 44 pixel selector rows, persisted Bridge and Helm reloads, correct Bridge artifact routing, and return to VPS verified. The relay's emergency read-only policy remains available but is not assigned to Helm. |
| Installation | Standalone launch, icons, offline shell, safe update | Interaction verified | Interaction verified | Interaction verified | Interaction verified | Interaction verified | Browser verified | Manifest, icons, active service worker, shell cache, API cache exclusion, and user-controlled waiting update verified. iPhone and iPad builds include safe-area protection, dynamic viewport height, and authenticated browser media playback. Physical update acceptance remains pending. |

Automated matrix contract:

1. Thirteen routes
2. Eight viewports
3. One hundred four route and viewport combinations
4. Requires zero horizontal overflow failures
5. Requires zero fatal recovery surfaces
6. Requires zero browser console or page errors

The last complete compatible backend matrix covered the preceding eleven route, eighty eight combination baseline with zero failures. The Operations candidate separately exercised all five Operations sections across seven phone, tablet, and desktop widths against the authenticated built shell and bounded empty plugin fixtures. All thirty five checks passed with zero overflow, missing markers, undersized primary controls, fatal surfaces, console errors, or page errors. The complete one hundred four combination matrix and real plugin integration must be rerun after a matching public backend is installed.

Evidence:

1. `artifacts/evidence/route-matrix/results.json`
2. `artifacts/evidence/route-matrix/android-narrow--chat.png`
3. `artifacts/evidence/route-matrix/fold-inner-portrait--chat.png`
4. `artifacts/evidence/route-matrix/desktop--chat.png`
