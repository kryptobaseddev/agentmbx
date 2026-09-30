# Native session catch-up ergonomics audit

## Question

How easy is startup, resume and catching up across providers in the shipped native mailbox, and what bounded improvements preserve processing and authority semantics?

## Sources

Audited revision 60638c8267476d87d3cca67e28febf9235b3a5b1. Exactly three source files inspected: src/mcp.ts (startup instructions 27–43; identity/claim descriptions 559–566; send 594; inbox/read/replay 636–676), src/replay.ts (options and pagination 6–102), and bundled skill/SKILL.md (quick reference 13–24; replay 27–53; recovery 55–111; handling 136–151). These are repository source observations, not executed provider acceptance tests. Static graph coverage is missing; no claim of complete runtime coverage. Historical source audits and their licence provenance remain unchanged. No upstream code was copied.

## Findings

The native startup instructions describe inbox→read→act→reply→ACK. Identity whoami and claim also direct agents to inbox. This is a useful pending-work path, but there is no unified startup/resume walkthrough distinguishing pending requests from historical context. Replay is documented in a separate skill section and tool description; it is not automatically invoked.

Replay is a read-only bounded query. Its cursor contains version, epoch, mailbox, immutable filter hash, position and finite end. A completed cursor refreshes the horizon while retaining position; repeated completed polls may include later arrivals. Filtered/hidden ranges advance, and oversized first items return omission metadata. Mailbox/filter mismatch, invalid bounds and restore epoch changes fail explicitly. Message-ID deduplication is necessary for retry/rewind overlap. Cursor encoding grants no authority; each invocation still requires its held mailbox.

No automatic cursor storage or named server consumer checkpoint is present in these three files. The tool explicitly says it saves no server checkpoint; the skill requires caller persistence. No checkpoint should be advertised as automatic resume. Cursor scope includes mailbox and filters but does not encode a logical workflow consumer; independent consumers must keep independent positions.

There is a documentation ambiguity: tool description says save after observing the page, whereas skill says after processing. Neither establishes an atomic processing commit. Checkpointing received context, completing application work, replying, and ACK are separate. A durable cursor alone cannot provide exactly-once actions. Acknowledged mail remains replayable; a cursor never clears inbox mail.

The send surface creates conversations and says answers arrive in inbox. It exposes no draft API, pending send API, or send-status lookup in this audited surface. This does not prove durable outbox or retry storage absent elsewhere: transport/store implementation is outside the allowed audit scope. Drafting and delivery confirmation need a separate source audit before feature claims.

Replay envelopes and bodies are data. Stored sender/authority-looking fields are not computed current policy. mbx_read is required before acting on any replayed request. Provider handoff releases the old holder, claims the same persona in the new session, and reuses the cursor without transferring credentials. Crash recovery and retained shared MCP holders remain explicit ownership recovery, not a cursor feature.

## Proposed decisions

Adopt a native startup/resume recipe first: mbx_whoami verifies current identity; inbox finds pending requests; optional replay from the caller's saved cursor reconstructs history/context; mbx_read supplies current policy before actions; reply and ACK occur when dealt with. Startup catch-up must be bounded by pages/bytes and report unfinished traversal rather than secretly scan all history.

Define the first checkpoint as an ingestion/context checkpoint: advance only after IDs/page outcomes are durably retained by the caller. If no durable caller store exists, retain the input cursor and allow duplicate-safe retry. Processing progress must use a separate record keyed by message ID; ACK means dealt with, not merely received. Do not make agents await every long task before saving a history position, or mistake position advancement for task completion.

For a later opt-in local named consumer, key state by mailbox plus exact filter plus consumer ID and store no lease credentials. Use compare-and-set expected old cursor to avoid parallel lost updates. Core replay remains read-only; checkpoint writes need an explicit separate operation and reauthorization. Same-persona provider transfer may reuse consumer state; rename/filter change requires explicit new consumer or rewind. Current authority is rechecked on every operation. This is proposed, not shipped.

## Suggested atomic slices

1. Startup/skill guidance alignment: src/mcp.ts and skill/SKILL.md plus focused description-contract test. Acceptance: clear pending-work versus context path; identical ingestion checkpoint definition; bounded catch-up and no ACK/authority inference. Dependency: reviewed checkpoint meaning.
2. Separate send lifecycle audit: inspect store, node send and transport retry source in a new scoped research task. Acceptance: distinguish accepted locally, queued remotely, delivered and reply pending; identify draft persistence facts before design. No product changes.
3. Optional durable consumer specification before implementation: one canonical spec and a focused concurrency fixture plan. Acceptance: consumer/filter/mailbox scope, atomic CAS, crash-before/after capture behavior, no credential persistence, restore/rename behavior and separate processing/ACK. Dependency: source coverage plus root consensus; no automatic startup consumer enabled by default.

## Verification

Read-only source audit only. Findings are tied to revision and file/line slices above; no runtime tests, release status or wake/provider behavior is self-attested. Full mailbox delivery storage and provider skill loading remain outside this audit. No roadmap tasks inserted.
