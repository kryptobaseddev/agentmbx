# Native feature roadmap

## Goal

Keep shipped behavior, partial implementations, accepted designs and remaining release gates distinct. This snapshot was reconciled on 2026-10-14 against current CLEO records and the published npm `agentmbx@latest` artifact: **0.5.32**, registry `gitHead 64ee20ebb1dd97b64be7dd122a11a5a5ce5eacbf`, integrity `sha512-pPMJGFekrmiSeqh7HsgUSAs5V7qweC4SybDaHAWAN62qRMLv39rrclUXN5HWqavuSR9GMMTlfbOzx4yRIaVAjQ==` (rechecked at 14:10Z). The registry dist-tag is the install authority; [check npm for the current release](https://www.npmjs.com/package/agentmbx). A repository version or GitHub tag alone does not establish what people install.

The T614 Codex first-entry restart fix `97718a7` is packaged in npm 0.5.32. T614 remains pending alongside the broader T162/T185–T189 live restart/provider proof. Historical v0.5.0 planning and live receipts remain evidence for their recorded revisions, not proof of every current provider or deployment.

## Status and evidence

- **Shipped** means the implementation commit is included in the published npm gitHead, with recorded task checks.
- **Partial** means code or a contract exists but the complete task or live acceptance gate is still open.
- **Accepted design** is an approved contract; it does not prove runtime implementation.
- **Pending / blocked / deferred** retain the recorded work and owner decisions.
- **Historical proof** records an observed version/session/device. It does not guarantee a current frontend behaves identically.

Task status is authoritative for dispatch; source and release evidence determine implementation claims. Fetch a task with `cleo show T### --full` before starting it. A green historical gate does not automatically complete a still-pending task.

## Current product boundary

Published code seals bodies on the direct LAN to a paired host's pinned body key. Metadata remains visible: addresses, subject, thread, refs, tags, sizes and timing, including body-derived metadata. The local store remains plaintext inside the same OS-user boundary. See [current security status](../security-status.md) for the outstanding metadata decision and response-authentication gap.

Relay v2 has persistent SQLite queues and enrollment, immutable encrypted retries, signed durable acceptance, receiver checkpoints and crash/restore/retention drills (T164–T168). Its implementation is shipped. Production operations, end-to-end cloud enrollment, bilateral sharing and a physical home-to-work relay test remain separate open gates; the self-hosted relay is not proof of a fully launched managed service.

Replay, explicit catch-up checkpoint commits, handoff notes and bounded own-mailbox delivery guidance are shipped. Capture/checkpoint, delivery, read, mailbox ACK and CLEO task completion remain separate. There is no durable draft store. Local console, topic subscriptions and a conforming A2A gateway remain future work.

## Steps

1. Preserve current mailbox identity, permission and exact-session boundaries while qualifying provider startup/resume. Reuse T162/T185–T189 and later harness regressions; unsupported paths stay explicit.
2. Finish production relay operations and enrollment before claiming WAN readiness. T172 requires another physical host; a second local daemon is useful transport coverage, not physical home/work proof.
3. Complete reviewed contracts before new local console, topics, cards or gateway runtime work. Reuse existing tasks rather than treating old proposal labels as new tasks.
4. Keep trust-design changes separate from current policy behavior. D044 is accepted design for T579/T580; its seven ordered implementation slices are pending. D045's accepted YOLO lifetime correction is pending T639: npm 0.5.32 still permits `--ttl never` at every actual CLI level. The proposed refusal for YOLO and report of existing non-expiring records are not shipped; see [current security status](../security-status.md).

## Complete task trace

The original 39-task trace now contains **17 done and 22 pending tasks**. Five of those pending tasks (T185–T189) have merged adapter code and recorded checks; their broader live acceptance remains open. Dependencies below are the current recorded execution dependencies, not the original September proposal.

| Task | Parent | Current status | Remaining boundary or evidence | Dependencies |
|---|---|---|---|---|
| T151 | T004 | Done; historical physical LAN proof | MacBook/Fedora receipts at `023688a`; Fedora retired. This does not satisfy T172 WAN proof. | T091, T183, T192 |
| T152 | T129 | Pending design | Private local console contract/access/redaction; historical T120 audit retained. | T131 |
| T153 | T129 | Pending | Local console access boundary after T152. | T152 |
| T154 | T129 | Pending | Searchable owner thread/handoff views. | T128, T153 |
| T155 | T129 | Pending | Browser privacy, read-only state and packaging verification. | T154 |
| T156 | T145 | Done; contract shipped | Consumer checkpoint/resume contract, PR 61. | None |
| T157 | T145 | Done; shipped | Durable captured-page/checkpoint CAS, PR 62. | T156, T183 |
| T158 | T145 | Done; shipped | Guided catch-up MCP surface, PR 62. | T157 |
| T159 | T145 | Done; shipped in 0.5.28 | Durable bounded handoff note and verifiable refs, PR 268. Supersedes earlier planned-only notes. | T156 |
| T160 | T145 | Pending; draft design exists | Canonical draft/delivery-state spec awaits rulings; no draft runtime. | None |
| T161 | T145 | Deferred | Draft store/explicit send parked for a later release after T160 decisions. | T160 |
| T162 | T145 | Pending live verification | Cross-provider automatic resume matrix; per-provider restart/context proof remains required. | T158, T159, T185, T186, T187, T188, T189 |
| T163 | T145 | Done; shipped in 0.5.28 | Own-mailbox delivery/recovery guidance, `6ae111e`; no draft store. | T156 |
| T164 | T146 | Done; contract shipped | Transactional relay acceptance/recovery contract, PR 73. | T035 |
| T165 | T146 | Done; shipped in 0.5.5 | Durable relay store, PR 79 (component PR 74). | T151, T164, T183 |
| T166 | T146 | Done; shipped in 0.5.5 | Signed accept before outbox removal, immutable retry bytes, checkpoints, PR 79. | T165, T168 |
| T167 | T146 | Done; shipped in 0.5.7 | Crash/restore/retention drills and receipts, PR 95; production rehearsal is separate. | T166 |
| T168 | T146 | Done; shipped in 0.5.7 | Relay pinning, signed expiring encryption ads and enrollment recovery, PR 93. | T164, T183 |
| T169 | T231 | Pending operations proof | Actual HTTPS deployment, alerts and exercised production upgrade/restore/rollback. | T029, T031, T032, T167 |
| T170 | T231 | Partial | Enrollment/configuration, lost-device revocation and recovery still need end-to-end proof. | T030, T036, T165, T168 |
| T171 | T229 | Pending | Bilateral cross-owner consent and bounded sharing/revocation. | T037, T170 |
| T172 | T231 | Blocked | New second physical host required; forced relay home/work test never ran on retired Fedora. | T028, T151, T169, T170, T180 |
| T173 | T231 | Pending readiness | Actual WAN/deployment, sharing, licensing, support, prototype metrics and decision date. T039 merged here. | T038, T171, T172 |
| T174 | T148 | Pending design | Topic namespace, membership and late-delivery semantics. | None |
| T175 | T148 | Pending | Authorized topic memberships/routing; tags alone do not subscribe. | T069, T084, T174 |
| T176 | T148 | Pending | Topic exposure and provider workflow validation. | T128, T175 |
| T177 | T149 | Done; contract shipped | Explicit native wake outcomes, `61f58dd`. | T191 |
| T178 | T149 | Done; shipped | Exact-session adapter boundaries and receipt checks, `6446909`. | T177, T183 |
| T179 | T149 | Done; shipped | Unknown/busy reconciliation and retry pressure, `a977df9`. | T178 |
| T180 | T149 | Done; historical live proof | Receipt files reuse T091 evidence at `023688a`; later harness versions need their own observations. | T091, T179, T192 |
| T181 | T150 | Blocked design | Owner consumer choice and reviewed gateway scope; preview metadata is not conformance. | T064, T068, T132 |
| T182 | T150 | Blocked | Bounded gateway after approved contract/conformance prerequisites. | T133, T181 |
| T183 | T004 | Done; historical connector proof | Recorded same-conversation Claude adoption; tests/receipts do not establish universal current frontend adoption. | T138, T191 |
| T184 | T145 | Done; accepted design | D041/canonical provider-resume spec; accepted design is distinct from per-provider runtime/live proof. | T156, T183 |
| T185 | T145 | Partial; code shipped | Claude startup/resume adapter checks exist; exact live context coverage remains open. | T158, T184 |
| T186 | T145 | Partial; code shipped | Codex adapter and T614 first-entry correction are packaged in npm 0.5.32; post-fix live proof remains pending. | T158, T184 |
| T187 | T145 | Partial; code shipped | OpenCode fresh session supported; no distinguishing native reopen/resume signal proven. | T158, T184 |
| T188 | T145 | Partial; code shipped | Kimi drops SessionStart stdout; first bound UserPromptSubmit/MCP fallback. | T158, T184 |
| T189 | T145 | Partial; code shipped | Hermes entry notice code/tests exist; broader live context/restart proof remains open. | T158, T184 |

## Owners

| Theme | Current owner tasks | Boundary |
|---|---|---|
| Local product T001 | T004, T006, T040, T116, T122, T129, T145, T148, T149, T150 | LAN, identity, history, private console, resume, topics and gateway |
| Cross-network/cloud T002 | T146, T221–T231 | Relay, accounts, console, owner authority, sharing, commercial and operational gates |
| Identity/conduit follow-up | T586, T587 | T065/T066/T068 signed immutable principals/cards and real CLEO contract integration |
| Security/trust design | T579, T580; T628→T629→T630→T631→T632→T627→T626 | D044 implementation and proven task isolation; no runtime authority widening yet |
| Policy lifetime correction | T639 | D045 accepted; YOLO `never` refusal and report-only doctor diagnostic remain pending |

T574 consolidated T007 into T221, T147 into T231, T073 into T002 and T039 into T173 while preserving unmet criteria and historical evidence. T078 retains legacy security/cutover closeout. T073 is no longer a separate active commercial saga. Cancellation or reparenting is not a claim that a service was decommissioned.

## Other roadmap and audit documents

- [Production network/wake readiness](production-network-wake-readiness.md) is a pinned v0.5.0 planning audit. Its memory-relay/plaintext-LAN observations are historical and superseded by the shipped work above.
- [Mailbox foundation delivery](mailbox-foundation-delivery.md) records the pre-release implementation sequence; T123–T126/T134 shipped its replay foundation. Its staging labels are historical.
- [Native collaboration coverage](../research/native-collaboration-coverage.md), source audits and [independent foundation review](../research/mailbox-foundation-independent-review.md) retain their September evidence; this roadmap supplies current status.
- [Native agent workflow](../spec/native-agent-workflow.md) explains the supported workflow. [Automatic resume verification](../spec/automatic-resume-verification.md) defines proof obligations; a test plan is not proof that every live restart passed.
- Cloud backlog disposition is recorded in canonical `t574-cloud-application` (2026-10-13); it is a task-reconciliation receipt, not a deployment/release report.

## Verification and recovery

All cited public implementation commits above were checked as ancestors of npm `gitHead 64ee20e`; the extracted artifact reports version 0.5.32. Live platform/provider and production gates are qualified separately. No new product tests, physical probes, deployment or security pentest were run for this documentation reconciliation.

Preserve mailbox/ACK state and historical evidence when recovering. No wake receipt, capture checkpoint, relay ACK or documentation update grants permissions or completes a CLEO task. Keep scoped task gates and current owner decisions explicit.
