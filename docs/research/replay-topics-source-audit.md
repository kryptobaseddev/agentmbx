# Replay cursors, project topics and handoff history: source audit

## Question

Which Agent Bus MCP mechanisms can AgentMBX adopt without weakening mailbox leases, signed mail or explicit acknowledgements? This is a source-derived design proposal, not a runtime benchmark or a claim of implemented functionality. AgentMBX baseline is 324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3. Agent Bus MCP was cloned read-only at 07f64925e03252ae09e4560539368a20d7203a71 on 2026-09-30. No upstream code is copied in this document.

## Sources

Pinned upstream links:

- [Schema and indices](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/src/lib.rs#L2591-L2648): topics, per-topic sequence allocator, messages, per-topic/per-agent cursor, name reservations.
- [Transactional exchange](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/src/lib.rs#L1880-L2178): validates topic, inserts/deduplicates outgoing messages, fetches limit+1 ascending sequence entries and updates cursor in one transaction.
- [Manual cursor reset](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/src/lib.rs#L2180-L2247): nonnegative bounds checked against latest topic sequence; backwards reset is allowed.
- [Topic creation](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/src/lib.rs#L1199-L1257): optional named reuse and transactional topic-version invalidation.
- [Destructive deletion](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/src/lib.rs#L1495-L1535): deletes messages, cursors and reservations together.
- [MIT license](https://github.com/alessandrobologna/agent-bus-mcp/blob/07f64925e03252ae09e4560539368a20d7203a71/LICENSE): copyright 2026 Alessandro Bologna. Substantial code copying requires preserving copyright and permission notices; conceptual independent implementation is recommended. Rust/PyO3/rusqlite is not AgentMBX's TypeScript/node:sqlite runtime.

AgentMBX source links:

- [Store schema](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/store.ts#L12-L58), [insert/delivery primitives](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/store.ts#L216-L240).
- [Inbox, visibility, read, ACK and search](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/node.ts#L563-L654).
- [Rename transfers pending deliveries](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/node.ts#L264-L299).
- [Signed project and body metadata](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/envelope.ts#L14-L59).
- [MCP inbox/thread/search contracts](https://github.com/kryptobaseddev/agentmbx/blob/324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3/src/mcp.ts#L636-L689).

## Findings

1. Borrow transactionally assigned sequence ordering and limit+1 keyset pagination. Do not use sender timestamps or ULID lexical order for resume: a late LAN message may have an earlier sender time/ID than an already observed message. AgentMBX currently orders inbox/thread by sender ts without a tie breaker.
2. Do not copy automatic cursor advancement. Upstream commits the cursor before returning exchange results. If the response disappears, a later automatic poll may start after an unseen page. AgentMBX MUST offer at-least-once replay with explicit checkpoint confirmation; replay cursor advancement MUST NOT acknowledge work.
3. A global message insertion sequence alone is insufficient. A stored message can gain a recipient delivery later, including an explicit rename transfer. Replay MUST order visibility grants to the mailbox, not just creation of the message. A deduplicated delivery ledger handles late fanout without skipped older messages.
4. Existing AgentMBX FTS already supports searchable mail and respects sender/recipient visibility before LIMIT. Project metadata, tags, task references and directives already exist in signed envelopes. Build narrow indexed filters and handoff conventions before adding embeddings or another vector database.
5. A topic is a filter, not a permission. Named public-room semantics cannot be imported directly into leased private mailboxes. Joining a project/topic MUST NOT reveal messages never sent or delivered to the claimant. Project paths are host-local and unsuitable as cross-host stable identity.
6. Upstream cursor activity is useful presence data but does not prove the agent is processing work. Diagnostic views SHOULD distinguish mailbox activity, connector heartbeat and provider/thread existence.

## Proposed integration contract

Normative words describe proposed behavior, not current implementation.

### Ordering and storage

Add `mailbox_replay_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL, message_id TEXT NOT NULL, visibility_kind TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(mailbox,message_id))`, indexed `(mailbox,seq)`, and `mailbox_checkpoints(mailbox,consumer,last_seq,version,updated_at)` with primary key `(mailbox,consumer)`. Emit events transactionally when a message first becomes visible as locally sent mail or recipient delivery. Ignore duplicate receipt retries and duplicate sent+received copies for one mailbox. Lease checks MUST surround API access, and visibility MUST be checked again when rendering an event. Events grant no authority.

Backfill existing visible pairs in deterministic `(received_at,message_id,mailbox)` order inside a gated schema migration. Historical rows can share timestamps; message ID is a tie breaker only for the one-time backfill, not future arrival ordering. Cover direct delivery inserts in rename and daemon paths, not only Store.addDelivery. Old binaries MUST refuse writes after the schema version bump using the existing store-version fence.

### API and durable checkpoint

Propose `mbx_replay({cursor?,limit?,consumer?,project?,topic?,thread?})` returning `{messages,next_cursor,has_more,snapshot_end}`. Limit defaults to 50, maximum 200, with a separate response-byte cap. Cursor is an opaque, authenticated versioned token bound to host/store epoch, mailbox, filter hash, position and snapshot end; it is a pagination reference, never a bearer authorization credential. A leased claimant MUST still authorize every call. A named consumer defaults to explicit `main`; it is not a random provider thread ID, so authorized provider switches can resume. Multiple simultaneous consumers SHOULD use distinct names.

The first page freezes a high-water mark in one read transaction; subsequent pages return `position < seq <= snapshot_end` ascending. The next poll starts a new snapshot after the confirmed position, including concurrent arrivals. Hidden/revoked visibility entries may be traversed but MUST NOT reveal IDs or bodies. Authenticated cursors MUST NOT expose global counts through raw sequence metadata; return opaque tokens rather than integer sequences to agents.

Propose `mbx_checkpoint({consumer,cursor,expected_version})` to confirm an actually observed page. This MUST atomically compare-and-swap the saved version and MUST NOT write delivery state, notes, wakes or grants. A lost replay response retries the same cursor. A lost checkpoint response resolves with a readback rather than blind advancement. Error contracts: `CURSOR_INVALID`, `CURSOR_SCOPE_MISMATCH`, `CURSOR_EXPIRED`, `CHECKPOINT_CONFLICT`, and existing lease/NOT_FOUND semantics. Out-of-order checkpoint confirmation MUST NOT silently regress or leap past unobserved pages; server-minted page receipts delimit valid advancement. Explicit rewind is a separate operation.

### Lifecycle, retention and invalidation

Connector restart and provider change resume the same mailbox's durable consumer only after a valid lease claim. Explicit release/claim of another name starts that other mailbox scope and MUST NOT carry a cursor across identities. A true rename that transfers pending deliveries emits new visibility events for the new name; its previous cursor remains invalid for that scope. Historical acknowledged mail retains its original mailbox scope; no implicit historical forwarding.

Do not introduce automatic message deletion in the first increment. Retain replay events while messages remain. A future retention policy MUST establish per-mailbox floors and tombstones, and return CURSOR_EXPIRED with an explicit recovery boundary rather than silently resetting. Database replacement/restore changes the store epoch; intentional restore needs an explicit new-epoch action because restoring the entire DB also restores its stored epoch. Backup rollback cannot be automatically inferred from that DB alone. Unknown epochs/cursor versions fail closed.

### Projects, topics and handoffs

First increment uses existing signed `meta.project` plus sender host as a local filter and documents its exact-match semantics. Add portable project IDs only after an owner-approved mapping between host roots and stable project identity; path similarity MUST NOT establish identity. Topic IDs SHOULD be opaque and scoped to the portable project, not global bare names. Creating topic metadata MAY be local owner administration; subscription-based recipient expansion is a later, separately signed/bounded feature with explicit membership rules. Existing envelopes MUST remain verifiable; indexed extracted metadata MUST NOT rewrite signed envelopes.

Represent handoff as ordinary signed status/decision messages with a documented tag, task refs and explicit prior/next session references. Search filters for project, topic, thread, kind and time complement existing FTS. A handoff record MUST NOT itself transfer lease or owner grants. CLEO remains task/decision truth; mailbox records link its task IDs and document references rather than duplicating its state machine.

## Atomic follow-up proposals

- Replay ledger migration: depends on T117 design approval and T064 semantics. AC: deterministic backfill, duplicate delivery idempotence, late recipient grant visible after prior checkpoint, transactional rollback and old-writer refusal. Scope: store migration and delivery insertion callers.
- Read-only replay API: depends on ledger. AC: bounded pages, timestamp collisions/clock skew/late LAN receipt, snapshot consistency with concurrent writers, visibility-before-limit and occupied mailbox denial. Scope: node query and MCP/CLI contract.
- Durable consumer checkpoint: depends on replay API. AC: lost-response retry yields same page, checkpoint CAS rejects concurrent regression, restart/provider switch resumes only same leased mailbox, no ACK/read/notified state mutations. Scope: checkpoint store and control API.
- Scoped history filters: depends on source audit, not replay implementation. AC: exact signed project extraction, indexed recipient-safe filters, handoff tag and task-ref search, remote-host collision isolation, old-envelope signatures unchanged. Scope: schema projection/index and search args.
- Portable topics design: depends on existing signed-card/group planning and scoped history filters. AC: host-root mappings explicit, membership and replay visibility specified, topic creation/archive distinct from deletion, migrations and mixed-version peers defined. Avoid building open rooms until authorization contract is settled.

## Migration and benchmark plan

Migration sizing is medium: new ledger/checkpoint tables, deterministic backfill, store-version bump and all visibility insertion callers. History filters are small to medium using existing FTS. Subscription routing is a separate large change. These are sizes, not time estimates.

Benchmark before optimizing: fixtures 10k/100k/1m messages, 1/10/100 mailboxes, skewed recipients, large bodies, late-delivery insertions and concurrent MCP/daemon connections. Measure first page and deep-page p50/p95 latency, inspected rows/query plan, migration elapsed/storage cost, WAL growth, lock contention and response bytes on macOS/Linux. Compare timestamp/offset baseline with `(mailbox,seq)` keyset; keep protocol parity across Codex/Claude/OpenCode. Include restart, fenced holder, rename and checkpoint retry process-level tests. No benchmark or runtime tests were executed for this source-only audit; evidence coverage is source inspection, not correctness proof.