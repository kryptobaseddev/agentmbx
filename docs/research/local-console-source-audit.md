# Local owner console: source audit and bounded specification

## Question

How can AgentMBX borrow AgentChatBus agent/thread visibility and diagnostics without replacing signed mailbox authority, importing a framework, or exposing private mail on its LAN listener?

## Sources

Audit date: 2026-09-30. AgentMBX revision `324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3`. AgentChatBus clone: `/tmp/agentmbx-agentchatbus-audit`, pinned commit `63d89ca8bf8bccca04966dae72cddcef6c42eb0c`; current TypeScript implementation, excluding deprecated Python.

- [MIT license](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/LICENSE#L1-L21): copied substantial snippets MUST preserve copyright/license notice and recorded source revision; vendored assets have separate LICENSES-vendor.md terms. No upstream code was copied in this audit.
- [Unified connection](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/agentchatbus-ts/src/adapters/mcp/tools.ts#L1902-L2020): register/resume, find/create topic thread, membership, after_seq replay, reply-token issuance and administrator role assignment are combined.
- [SSE transport](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/agentchatbus-ts/src/transports/http/server.ts#L970-L984) and [event bus](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/agentchatbus-ts/src/shared/eventBus.ts#L1-L26): subscribe/unsubscribe on connection close; in-memory broadcast, no durable replay ID in examined route.
- [Agent tree](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/vscode-agentchatbus/src/providers/agentsProvider.ts#L1-L69) and [thread tree](https://github.com/Killea/AgentChatBus/blob/63d89ca8bf8bccca04966dae72cddcef6c42eb0c/vscode-agentchatbus/src/providers/threadsProvider.ts#L1-L94): filtered lists, view-model separation and event-triggered refresh.
- AgentMBX `src/http.ts:123-136`: existing listener serves host-to-host signed hops; `/v1/status` is deliberately public runtime metadata only. `src/identity-status.ts:1-83`: read-only advisory inventory, snapshot transaction followed by process inspection. `src/store.ts:12-60`: FTS, recipient states, per-peer outbox attempts/error and current leases. `src/node.ts:573-645`: mailbox visibility filtering before selection; thread/search ownership boundaries. `src/identity-control.ts:98-123`: operation and receipt commit together, receipt pending/completed/failed. `src/cli-identity.ts:1-77`: exact provider lease and ancestry control.
- CLEO `show T076 --full`: pending SignalDock frontend salvage audit with zero attachments, scope includes Next.js tokens/screens and owner cloud flows. No sourced reusable component inventory presently exists.

## Findings

Borrow presentation patterns: distinguish mailbox persona, provider session/thread and message thread; filtered agent/thread views; event-driven invalidation; view models independent of UI framework. Reimplement read APIs against AgentMBX authority and schema. Do not copy AgentChatBus bus_connect: topic membership, generated role instructions and token lifecycle are different semantics from signed exact-session mailbox ownership. Thread system prompts MUST remain message data and MUST NOT acquire owner authority. Defer IDE extension and cloud management until the standalone local view is useful.

SSE is an optimization signal, not delivery proof or durable replay. The examined upstream broadcast does not solve slow subscriber buffering, reconnect gaps or cross-process writes. AgentMBX processes independently share SQLite; an in-process event emitter cannot observe all writes. Start with bounded refresh polling and visibility-aware backoff; add coalesced invalidation after measurement (T119), backed by T117 durable cursor contract. Do not create a second authoritative history database.

## Minimal screens and access boundary

1. Runtime/identities: installed, daemon and observed connector versions; exact provider CLI/session ID; held/available/unknown/conflict state, process birth evidence and heartbeat age. Unknown MUST never display as dead or safe to seize.
2. Mailbox/thread history: explicit owner selection of mailbox, FTS search and signed-envelope provenance, sender/recipient, message thread and reply chain. Opening a row MUST NOT mark read/acknowledged or claim a mailbox. Handoff entries are ordinary mail plus linked control receipts, not inferred completion.
3. Delivery/recovery: per-peer queued attempts, last error and next retry; local notified/read/acked states shown separately; receipt timeline with failed and uncertain outcomes preserved. No release/claim/takeover buttons in first scope.

The console MUST use a separate 127.0.0.1 / ::1 listener on an ephemeral port, never extend the configurable LAN host listener with private endpoints. Loopback alone is not authentication. A deliberate local owner CLI launch MUST issue a short-lived random read-only console capability, with bounded idle/absolute expiry and local private-file access protections. This capability MUST NOT confer signing or takeover authority. Browser bootstrap exchanges a fragment-carried secret via same-origin POST for HttpOnly, SameSite=Strict session cookie; secret is removed from history immediately and never logged or put in query strings. Launch is explicit owner access to metadata and selected private mailbox bodies; agents MUST NOT gain cross-mailbox reads through their session grants.

Every route MUST verify exact Host and Origin against launched localhost address; reject foreign Origin, DNS rebinding hostnames and unexpected content types. No permissive CORS, third-party scripts/CDN assets, remote embeds or external image fetches. CSP defaults to self and forbids framing. Websocket/SSE or long poll MUST enforce the same boundary. Native clients without Origin MUST require the capability rather than inherit browser cookies. Private endpoints return cache-control no-store. Tests MUST prove unauthenticated LAN, cross-origin localhost and wrong-host access fail.

## Diagnostic contract

Versioned DTO: `{v:1, observed_at, host, schema_version, installed:{version,build}, daemon:{version,started_at}, connectors:[{cli,session_id,identity,mcp_pid,provider_pid,version,build,evidence}], deliveries:[...], receipts:[...], coverage:{missing,unsupported}, next_cursor}`. Missing connector version MUST be null with an explicit unavailable reason, never guessed from installed CLI version. Process evidence includes observation timestamp, PID birth match and live/unknown/dead reason; identities retain generation fingerprint but never lease token.

Delivery DTO uses distinct `{message_id,recipient,peer,stage,attempts,last_error,next_retry_at,observed_at}`; transport accepted/notified/read/acked MUST NOT imply task processed. Receipt DTO is `{receipt_id,action,target:{cli,session_id,identity},status,created_at,completed_at,error_code,summary}`. MUST redact keys, grants, control tokens, passphrases, approval material, full environment and unfiltered command lines. Legacy receipts may have string-only errors; adapter preserves text and reports absent structured code. Unknown completion MUST NOT be automatically retried.

Query contract MUST bind opaque authenticated cursor to mailbox, filter and schema; stable keyset pagination `(received_at,id)` or T117 sequence, limit default 50/max 200, bounded search length and execution timeout. Filter visibility before LIMIT. Structured errors: `CONSOLE_AUTH_REQUIRED`, `CONSOLE_ORIGIN_DENIED`, `CURSOR_INVALID`, `CURSOR_SCOPE_MISMATCH`, `QUERY_LIMIT`, `STALE_SERVER`, `CONNECTOR_VERSION_UNAVAILABLE`. Export is explicit selected scope, default redacted JSON; body export requires separate explicit owner action and bounded page count/byte limit. No automatic bulk export or browser localStorage mail cache. Read-only diagnostic adapters MUST NOT expire leases or finalize pending receipts as a side effect.

## Reuse and dependencies

T076 can supply evaluated design tokens, accessible list/detail components and branding if its audit proves licensing and portability. It is not a blocker for a plain HTML local console; do not import the cloud Next.js/auth stack before evidence. Cloud policy/device/signing screens remain T074/T076 scope. T118 supplies diagnostics and receipt contracts, T117 cursor semantics, T119 performance baseline. Use existing Node HTTP/SQLite and packaged static HTML/CSS/JS first; no separate server framework or React dependency required. Windows support requires separate evidence for process birth/permissions, not a platform-specific Unix socket assumption.

## Atomic implementation plan

- D1 read-only diagnostic DTO adapter (T118): sources/version coverage, identity/receipt redaction, no mutation; AC fixture snapshots prove installed != connector version and pending receipts unchanged.
- D2 owner console launch/auth listener: depends D1; AC wrong Host/Origin/capability denied, private data unavailable from LAN, expiry and token-log redaction verified on macOS/Linux, documented Windows coverage.
- D3 paginated mailbox/thread/search views: depends D2 and T117 cursor contract; AC hidden mail never leaks through counts/cursors, 50/200 bounds, tied timestamps deterministic, opening preserves delivery state.
- D4 identity/delivery/receipt diagnostics UI: depends D1,D2; AC unknown holder rendered uncertain, transport versus processing labels distinct, offline peer and failed receipt recovery advice actionable without mutation.
- D5 bounded export and refresh: depends D3,D4 and T119 baseline; AC redaction/default scope/max bytes, disconnect cancellation, stale snapshot indicator, no unbounded event queues. SSE MAY be added only with coalescing, per-client buffer cap and reconnect resnapshot; Last-Event-ID MUST NOT imply replay unless backed by durable T117 events.

## Verification and limitations

Research-only: source paths and upstream pinned revision inspected; no product changes or upstream code copied. No runtime competitor benchmark, independent vulnerability audit or SignalDock UI inventory performed. T120 design criteria are covered, but implementation/QA task gates remain open for orchestrator review and commit evidence. Architecture graph unavailable; findings derive from direct source coverage, not a complete runtime caller graph.