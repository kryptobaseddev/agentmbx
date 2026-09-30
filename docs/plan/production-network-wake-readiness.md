# AgentMBX wake and network production readiness

## Question

Which bounded work makes the existing local mailbox dependable across provider sessions, physical LAN devices and home-to-work networks without changing who can authorize work?

This is a planning audit for T141/T139 at revision `60638c8267476d87d3cca67e28febf9235b3a5b1` (v0.5.0), not implementation or a new live deployment. Three primary source files were assessed: `src/relay.ts`, `src/relay-client.ts`, `src/wake.ts` (the proposed `src/adapters.ts` does not exist). Other source references and task records supply boundary context. The symbol graph is unavailable; direct source inspection supplies partial runtime coverage. No physical-device probes, provider prompts or network messages were sent for this audit. Preserve historical records; this plan corrects readiness claims rather than rewriting them.

## Goal

Produce a phased, deduplicated readiness plan that preserves exact sessions, durable mail and current recipient authority. Close existing connector/physical validation gaps first; specify reliable adapter and relay boundaries before deployment.

## Current evidence and gaps

| Requirement | Current source/evidence | Reuse and remaining work |
|---|---|---|
| Same existing conversation survives upgrade | v0.5.0 handover tests exercise reused transports/catalog changes; the installed CLI/app/daemon reached v0.5.0, but the existing root native connector retained v0.4.1 and failed closed against schema 3. Legitimate CLI caller validation refused; no PID/context spoof, takeover or shared-process kill was used. | T140 planning and T091 live validation; a scoped existing-thread recovery experiment is the first readiness gate. Automatic replacement tests do not prove every native frontend refreshes. |
| Physical LAN messaging | Existing pairing, signed hops, `/v2/envelopes`, mDNS/manual-address discovery and persistent local outbox retry ship. T020/T021 are done historical records; T021 evidence is dated September 26 at f647fe6, not new v0.5.0 physical validation. | Reuse T004/T091 for version-pinned two-device request/reply/offline recovery; preserve T020/T021 provenance. T022 live grant/impostor and T023 Mac mini remain pending. |
| Confidentiality over direct LAN | Direct HTTP body delivery is plaintext; signature integrity/authentication is not confidentiality. Relay path seals bodies, which does not finish direct-LAN encryption. | T028 pending under T006; T029 limits/fuzzing, T030 rotation/revocation, T031 backup/retention, T032 threat review are the existing owners. |
| Exact provider wake routing | `wake.ts` captures held identity, checks automatic wake authority, excludes provisional IDs from normal adapters, rechecks generation after submission. Codex queues exact thread; OpenCode checks synthetic admission receipt; Kimi checks busy/status/submission response. | T090/T097/T098/T100/T105/T111/T112 done provide regressions, not universal live receipts. T091 active remains owner of submission/model/read/reply/ACK validation. |
| Isolated adapter compatibility | `WakeResult` reduces success to `{ok,via}`; OpenCode admission means queued, not executed. Busy Kimi retains delivered mail and releases only known-unsent reservations. Dispatcher can fall back to desktop, which is a notification, not model completion. | Missing bounded provider adapter contract proposal W1; extend existing checks without a framework rewrite. T044 pending Claude-without-channel; T087/T093/T094 active cover Claude arrivals/binding/channel; T033 pending still contains Hermes/Kimi live scope despite T049 completed Kimi code. |
| Brake/mute/reservation behavior | Existing `wantsWake`, `reserveWake`, generation rechecks and busy deferral remain authoritative; `notified` never proves read or handled. | T040 hardening umbrella; W2 proposal adds persistent attempt outcomes, pending/unknown retries and isolated contract checks. Preserve existing delivery ACK semantics. |
| Relay is implemented | `agentmbx relay serve` and `relay set/unset` exist; daemon calls drain/pull behind `MBX_RELAY_URL` or config relay. Enrollment, encrypted bodies, polling and owner-labelled quotas ship. | T007 is pending despite merged implementation; T035 ADR done is provenance. T034 transport research, T036 enrollment design, T037 sharing, T038 licensing/business, T039 go/no-go remain pending. Do not describe relay as merely planned or as production ready. |
| Relay durable acceptance | Relay queues, enrollments, sequence counters, dedup and encryption advertisements are Map/Set state. Client deletes local outbox on any HTTP 200. A relay restart after that handoff can lose pending mail. | Missing R1 persistent relay and R2 sender/receiver recovery proposals; these precede real WAN use. |
| Relay trust and enrollment | Enrollment proves possession of host key; supplied owner fingerprint is not owner-certified account membership. Relay returns encryption advertisement without its original signature; client accepts its key string. Host labels can be claimed by separate enrollments. | T036 and T032 must define verified host-key/owner/device binding and receiver-pinned encryption advertisements. Relay metadata is never owner authority or permission. |
| Deployment and home/work | Self-hosted HTTP entry point exists; no managed account service or production hosting was demonstrated. Current local relay config is absent; a persistent approved Fedora address proves pairing configuration, not current reachability. | Missing D1 deployment/operator contract and V2 physical WAN qualification; T039 owns go/no-go. VPN-address/manual pairing is a feasible transport route, not built-in VPN or NAT traversal. |

T004/T006/T007/T040 are existing epic umbrellas, not new duplicate implementation tasks. T141 proposes missing tasks only; the lead must reconcile and file exact IDs. No new task IDs are invented here.

## Steps

1. Recover and validate the same existing provider conversation/connector, then prove v0.5.0 on two physical devices. Until recovery is observed, report the native connector as stale rather than claiming every component updated.
2. Define narrow provider adapters and observable wake outcomes; retain policy/lease decisions in the mailbox core. Provider admission is not model execution, read, ACK or business completion.
3. Make relay acceptance and receive checkpoints durable and unambiguous before a cloud rollout. Retain local outbox entries until an explicitly validated durable acceptance receipt covers their target.
4. Qualify TLS deployment, enrollment/revocation and operator recovery; then test physical home/work outages and obtain a T039 go/no-go. Cross-owner sharing remains separately consented under T037.

Recommended default relay semantics: at-least-once transport with recipient-scoped idempotent storage, not an end-to-end exactly-once execution promise. Relay commits a fixed resolved recipient fanout set/hash, immutable wire bytes, dedup, sequence allocation and its acceptance receipt in one transaction before success. Local receive commits accepted envelope/delivery before advancing a received-through checkpoint. Relay cursor ACK confirms durable receiver storage; it does not call `mbx_ack`, grant policy or mean an agent handled the work. User-facing ACK retains its existing mailbox meaning.

Recommended adapter boundary: core supplies an exact CLI/session target, opaque message IDs, wake hint, current generation guard and permission profile; adapter reports `not_submitted`, `admitted`, `busy`, `blocked`, `unknown` or `failed` plus sanitized native receipt and retry advice. Core revalidates lease/policy before submission and before finishing notification, persists attempt identity, schedules bounded backoff and respects mute/brakes. An ambiguous timeout is not safely retryable as a fresh prompt unless provider idempotency or native receipt reconciliation proves the previous attempt. Missing native hooks remain explicit unsupported capability, not simulated success.

## Owners

The lead owns task reconciliation, final publication, filed dependencies and implementation admission. T091 owns live provider receipt validation, T004 physical qualification, T006 LAN security work, and T007 historical relay planning. T145/T146/T147 are the proposed new planning containers; no implementation authorization or production readiness follows from this document. Atomic proposal labels below are not CLEO IDs.

## Atomic proposals for lead reconciliation

### V1 — Existing-thread connector recovery and two-device v0.5.0 qualification

Reuse T091 under T004, coordinated with T140 and completed T138 regression evidence. Size medium. Dependencies: installed verified v0.5.0; an authorized native reconnect surface that preserves the original conversation. Do not create a replacement conversation merely to pass.

Acceptance: record original thread/persona/lease before and after reconnect; runtime whoami reports v0.5.0 and actual tool listing includes replay; mailbox replay is read-only and cursor continuity survives reconnect. On physical MacBook/Fedora, record exact versions, paired keys, signed request/reply IDs both ways, local send/outbox acceptance, remote delivery, wake admission, model execution, read, reply and ACK separately. Include offline peer/restart catch-up with unchanged original signed envelopes and no visibility leakage. No fabricated permission approvals or blanket shared-process kills. If native reconnect is denied/unavailable, record that gap and keep qualification open.

Verification/recovery: disposable test messages only within authorized personas, before/after metadata/ACK inventory, native session receipts, process/version evidence and targeted regression fixtures; retain uncertain receipts, never force takeover or restore an old snapshot over newer mail.

### W1 — Isolated provider wake adapter contract

Missing small task; reuse T090/T098/T105/T111/T112 tests and coordinate T091/T033/T044/T087/T093/T094. Dependencies: V1 same-thread identity baseline and existing held-generation guards. Primary bounded files: wake entry plus a small adapter contract/module and focused adapter fixtures; avoid restructuring unrelated message storage.

Acceptance: declare provider capabilities (exact-session targeting, busy inspection, admission receipt, idempotency lookup, channel delivery); typed outcomes preserve provider receipt/session/generation without secrets; keep no-body wake hints and normal permission profile; unknown/busy/missing targets cannot become successful model execution. Test wrong-session/mismatched receipt, busy race, permission blockage, process reuse, lost response and lease change immediately before/after submission across supported adapters. Existing Claude channel and desktop outcomes remain distinct.

Verification/recovery: isolated synthetic native endpoints/CLI adapters plus version-pinned live receipt under T091; no native approval bypass. Roll back adapter-only changes while preserving pending attempts and mailbox messages.

### W2 — Persistent wake-attempt reconciliation and bounded retries

Missing medium task, depends W1. Reuse T100 reservation behavior and T119 measurements. Acceptance: unique attempt identity links mailbox/message IDs to exact session/generation; store admitted receipt separately from execution/read/ACK; busy retries keep delivery pending without spending an unsent reservation; unknown submissions reconcile native receipt or wait for operator action; retry schedule and error redaction are bounded; muted/braked mail remains searchable and replayable with truthful diagnostics. Test crash after admission/before state update, restart while busy, stale receipt, provider unavailable, mute/unmute, lease turnover, lost-response dedup and no notification loop. Failure cannot advance ACK or widen policy. No unauthenticated external callback grants completion.

Verification/recovery: deterministic clock and crash/reopen fixtures with actual provider outcome contracts, focused throughput measurement; preserve attempt receipts rather than deleting them to reset budgets.

### R1 — Persistent relay transaction and recipient-scoped dedup

Missing medium implementation task under T007, depends T035 and T032 threat boundaries. Persist enrollments/host identity binding, encryption advertisements, queues, per-target sequence counters, accepted-through state and dedup in a bounded SQLite store. Nonces can expire after restart; enrollment state must not silently disappear.

Acceptance: success response follows committed state, never memory-only acceptance. One immutable message/target fanout transaction validates all recipients/quotas first and persists the resolved target set/hash so retries cannot silently add or drop targets after resolution changes; any failure rolls back all writes for that envelope. Unique dedup key binds sender host key, message ID and recipient host key; a conflicting duplicate is rejected rather than accepted under another principal. Multiple addresses on one target host create one transport queue item. Sender retries reuse persisted encrypted wire bytes (avoid generating new nonce/ciphertext under the same ID each retry). Receipt identifies accepted message/target and committed position; no receipt grants authority. Tests restart after commit/before response, before commit, partial fanout/quota failure, conflicting ID reuse, reordered fanout, duplicate retries, concurrent writers and schema migration. Bound request body/pull batch sizes before allocating; retention/tombstones preserve the stated dedup horizon.

Verification/recovery: real child-process crashes and reopened DB, transactional fault injection, privacy assertions, deterministic delivery/queue counts. Preserve failed DB/receipts for diagnosis; old writer compatibility and rollback require a documented coordinated migration, not discarding new durable rows.

### R2 — Durable relay sender acceptance and receive checkpoint protocol

Missing medium task depends R1 and T028 encryption/key validation. Current client deletes on status200 and advances cursor after receive loop/ACK call without validating acknowledgment success; current server can return200 with partial stored/error. Repair protocol narrowly before production.

Acceptance: validate explicit per-target durable receipt and matching ID before dropping that outbox row; HTTP200 alone and `stored:0`/partial/error/malformed receipts never prove acceptance. Pending local retry survives timeout/relay restart. Commit contiguous receive progress only after each item is durably accepted/duplicate or deliberately quarantined with a durable rejection record; report gaps, never silently skip rejected/lost rows. ACK HTTP failures preserve retryable state; received-through and relay-ACK-confirmed positions stay distinct. Tests restart at every send/commit/response/delete and receive/commit/checkpoint/ACK boundary, lost response, duplicate pull, malformed cursor, reordered batch, rejected item and unauthorized peer. Reject replay/cursor input outside authenticated host scope.

Verification/recovery: end-to-end loopback relay processes with faults/restarts and byte-identical original mail, then physical V2. Preserve receiver audit evidence and sender pending entries on ambiguity; never reinterpret transport ACK as mailbox ACK.

### D1 — Supported self-hosted relay deployment and recovery

Missing medium task depends R1/R2 and T029/T030/T031/T032 readiness. CLI server exists; this is its bounded production operator layer, not an account platform rewrite.

Acceptance: supported service installation, restricted bind and TLS reverse proxy/HTTPS endpoint verification; secrets/keys remain local; backup/restore/drain procedures preserve accepted queues, sequence/cursors and dedup; monitor health, committed depth, oldest pending item, delivery failure, disk capacity, restart recovery and version compatibility without exposing bodies/control tokens. Test TLS expiration/wrong endpoint, request flood/size cap, disk-full transaction failure, operator restart, backup restoration and rollback with post-backup mail accounted for. Document relay-visible metadata and retention; owner fingerprint supplied by a host is not verified account authorization or billing identity.

### E1 — Verified device enrollment/configuration

Reuse T036 design followed by a missing scoped implementation after ADR/consent review; depends T030/T032 plus D1. Acceptance: distinguish pairing, relay enrollment, owner-certified device membership and quota ownership; unique host-key bindings reject name collisions; encryption advertisements carry verifiable host signatures tied to the pinned peer rather than trusting a relay-provided key string; revoked/rotated devices fail closed; enrollment/config/unenroll recovery is supported without losing mail or treating relay claims as owner grants. Account UI is optional later work, not a prerequisite to an account-free private deployment. Test malicious key advertisement, relabelled host, self-asserted owner quota, revoked device, certificate rotation and enrollment recovery after relay restart.

### S1 — Cross-owner sharing consent

Reuse T037 design, then only its separately admitted implementation. Depends E1 and relevant T065/T066/T068 principal/policy work as reconciled by lead. Acceptance: explicit sender/receiver owner consent, permitted scope/expiry/revocation and current recipient-side policy; discovery/agent-card/relay metadata never creates owner authority; rejection leaves visible diagnostic receipt. Test owner mismatch, permission expiry during queued transit, revoked membership, cross-project isolation and spoofed authority claims. No automatic adoption of a paired remote owner.

### V2 — Physical home-to-work and outage qualification

Missing medium validation task under T004/T007, depends V1, R1/R2/D1/E1 and T028; T039 is final go/no-go owner. Use two physical devices behind separate networks, a reachable private VPN path and a relay-only path. Acceptance: distinguish direct LAN, VPN direct and relay routing; show exact-version signed request/reply/read/ACK evidence for each supported provider; exercise one device offline, network switch, NAT blocked direct route, DNS/address change, relay outage/restart, permission block, cursor resume, retry duplicate and key revocation. Inspect body confidentiality and metadata exposure on each route. No claim of managed cloud readiness until documented recovery, enrollment and monitoring gates pass. Every missing provider or physical path remains a reported gap, not a skipped success.

## Planning verification and bounded recovery

Validate all cited source paths/line ranges at pinned revision, all reused task IDs/statuses via CLEO, dependency ordering, atomic task scopes, named acceptance/verification/recovery criteria and explicit implemented-versus-proposed claims. No product full suite or network deployment is required to validate this document; that would not establish the missing physical/provider observations. Lead serially publishes this canonical attachment and files deduplicated implementation tasks. This audit creates no implementation tasks, no user decisions and no authority change. The lead has separately indicated planning containers T145 (managed resume), T146 (durable relay), T147 (production operations) and T148 (topics); new atomic proposals below must be reconciled into those containers rather than blindly filed under the historical T007 umbrella. Preserve original cloud-relay-design/T035 records as historical architecture; do not silently promote their intended durable semantics into proof of current code.

## Sources

Pinned source revision: https://github.com/kryptobaseddev/agentmbx/tree/60638c8267476d87d3cca67e28febf9235b3a5b1

- [Relay memory state and owner-labelled enrollment](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/relay.ts#L17-L73).
- [Relay fanout, dedup, pull and ACK](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/relay.ts#L76-L119).
- [HTTP relay auth, partial acceptance and encryption advertisement response](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/relay.ts#L133-L186).
- [Client enrollment persistence and key discovery](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/relay-client.ts#L31-L57).
- [Client sealed push/outbox deletion and receive/checkpoint behavior](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/relay-client.ts#L61-L99).
- [Wake authority/no-body hints and provider admission validation](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/wake.ts#L15-L68).
- [Kimi busy/status/submission handling](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/wake.ts#L111-L150).
- [Dispatcher lease guards, brakes, retry and notification completion](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/wake.ts#L205-L301).
- Context: [supported relay CLI and daemon integration](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/cli.ts#L463-L503); [direct HTTP retry](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/src/http.ts#L205-L249); [loopback relay test](https://github.com/kryptobaseddev/agentmbx/blob/60638c8267476d87d3cca67e28febf9235b3a5b1/test/relay-client.test.ts#L32-L83).
- CLEO full/read task records: T004,T006,T007,T040,T091,T021,T033,T036,T037,T098; child inventories under T004/T006/T007/T040 (all rows requested). Canonical cloud-relay-design fetched via CLEO; its intended architecture is historical guidance, not runtime storage proof. September 30 rollout observations are recorded in T134-review-20260930071728 and the root deployment receipts.