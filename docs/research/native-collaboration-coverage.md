# Native collaboration coverage and roadmap reconciliation

## Question

Which requested collaboration features are shipped, already assigned, or missing, and where should their durable tasks live without duplicating work?

## Sources

Full CLEO records fetched 2026-09-30: T001, T002, T073, T116, T122, T129; T059, T064, T068, T069, T084, T120, T127, T128, T132. Parent-scoped T129 inventory returns only T130/T131, both done, with no truncated population. A2A lexical discovery was scoped and retained; absence is not a full semantic search. Canonical mailbox-foundation-integration SHA8146f6d1dc360ffcb83a9b3f5f33cb24ab5696242de61f9240010d463dfe055c; mailbox-foundation-delivery SHAc32906e52f35ac055a8baad229ef600e864d6dbca11500e152367f79995a4cd8; native-session-catchup-audit SHA50b48d538eaaf4fff1239cbe38c89ddfeb3b27d23a02ad7fe025dc5a6c77c407 fetched through CLEO. Source README.md v0.5.0 and replay.ts/mcp.ts consulted only to qualify shipped filtering facts. Historical delivery document says staged/not released: it predates T134 v0.5.0 completion and must remain historical, not current status authority.

## Coverage

| Requested capability | Current evidence | Reuse and remaining scope |
|---|---|---|
| Durable replay cursors | Shipped v0.5.0 MCP/CLI bounded replay; caller retains continuation, no server-owned consumer checkpoint | T123–T126 implementation and T134 release. T140 audits ergonomics; future opt-in consumer retention/checkpoint work must be separate from ACK |
| Project topics | Replay filters existing signed project+sender-host, tag topic and thread; these classify existing visible mail, do not subscribe or route | T069 owns attested project/function/rank selectors; T084 owns owner-managed named groups. Neither is a topic subscription system. Missing local topic specification and membership/routing slices below |
| Searchable handoff history | Existing FTS, thread tool and replay history include acknowledged mail | Reuse T127 scoped signed history filters and T128 handoff conventions/task/session refs. Both pending; existing replay filters do not prove their broader acceptance complete |
| Agent/thread visibility and diagnostics | Shipped read-only exact-session diagnostic CLI and advisory identity state, current tools for agents/thread | T120 research input; T129 owns console; T130/T131 done. Console auth/history/views/package tasks still proposal C1–C4, not filed IDs |
| Capability discovery | Existing agent enumeration does not prove authenticated interoperable execution | T059 card design overlaps T068 signed-card/directory implementation; retain historical design, use T068 canonical implementation. T132 native capability preview depends T068; preview is expressly nonconformant, no endpoints/tool execution |
| A2A interoperability | No executable conforming gateway proven | T064 wire semantics and T068/T132 discovery are prerequisites, not gateway implementation. Missing bounded protocol adapter contract/conformance/implementation |
| Event-driven framework patterns | Mail delivery, retries and receipts already exist | Independently define lifecycle/state semantics and adapters. No framework import, remote execution, or automatic task-completion claim. Transport ACK differs from processed/task-complete evidence |

## Missing atomic slices

These are proposals only; root creates IDs after deduplication and records exact dependencies.

1. Local topic contract: define whether topic is a signed classification or explicit owner-managed membership route; namespace by sender host plus project, recipient authorization unchanged, cross-host collisions and rename/leave semantics. Reuse T069/T084; no new generalized room framework.
2. Topic membership/routing: only after contract, owner-controlled membership and revocation; deterministic fanout existing delivery ledger; never let incoming tag auto-join or grant read access. Cases: direct isolation, nonmember rejection, host collision, leave/rejoin and duplicate delivery.
3. Topic CLI/MCP surface and provider verification: bounded list/join/leave under defined authority, replay authorized history, Linux/macOS; separate from contract and routing to keep scope reviewable.
4. Console loopback launch/auth (C1): depends T131; same-OS-user CLI capability, exact Host/Origin, private routes absent on LAN daemon, no permissive CORS, no read side effects.
5. Console history API (C2): depends C1/T124/T127; bounded paginated visibility-filtered history, explicit content/export action, unknown liveness remains unknown.
6. Console static views (C3): depends C2; agent/thread/holder/error/receipt views, text escaping, accessible keyboard, bounded polling.
7. Console package/browser checks (C4): depends C3; actual npm/SEA assets, browser origin/auth tests, real packaged views. Preserve necessary packaging files rather than a nominal three-file budget that omits integration.
8. Native consumer-retention contract: ingestion checkpoint advances only after page data or IDs and continuation are durably retained; processing status and ACK independent; recovery retries lost response input cursor. Optional consumer CAS mailbox/filter/store-epoch keyed; no authority credentials. T140/T144 govern final scope.
9. A2A gateway contract/conformance first: pin supported schema/version, identity trust mapping, read/send capabilities and task lifecycle semantics; no arbitrary URL discovery or execution claims. Depends T064/T068, coordinate T132. Adapter implementation then narrow one validated endpoint/action with bounds/idempotence/cancellation; remote execution remains a separate explicit decision.

## Hierarchy and decisions

Current full records already place T116, T122 and T129 beneath saga T001, not standalone. Keep these placements; no reparent required. T139 agent experience/roadmap also belongs T001. Keep local topics under existing T062 until a reviewed local-topics epic is warranted; selectors/groups are related contracts, not duplicates. Keep T127/T128 in T122 and console C1–C4 in T129. Keep signed discovery T068 and native preview T132 in T062. T059 in T040 is historical design provenance: add a nonblocking design-to-implementation relation, do not silently delete it. A future interoperability epic belongs local protocol saga T001 unless scope actually adds hosted/cross-owner service dependencies.

T002 Cloud and T073 commercial SignalDock are separate saga themes with substantial overlap. Do not duplicate local console into SignalDock or move owner authority into hosted UI. Record an owner decision establishing T002 research-theme versus T073 commercial execution boundary; relate overlapping relay/account research until a deliberate saga consolidation is authorized. This assessment does not reparent, archive or create anything.

Recommended durable decisions: native ingestion checkpoint versus processing/ACK separation; topics as classification versus membership routing; local console same-OS/browser boundary; signed capability preview versus conforming executable gateway; cloud research/commercial saga boundary. Their statuses must remain proposed until root records sourced agreement; accepted historical ADRs are not rewritten by this assessment.

## Verification and limits

This is read-only planning: full records and canonical documents were inspected, no product edits, framework imports, runtime feature claims or test runs. Source-backed v0.5.0 capabilities are separated from pending tasks. Current graph/task status alone cannot prove feature absence everywhere; missing items are coverage gaps in the reviewed records. Historical source audits and license records remain unchanged. Public documentation should use native feature names and describe independently implemented functionality; actual future copied material would require its own license/provenance review, but none is introduced here.