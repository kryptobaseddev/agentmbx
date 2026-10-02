# Handoff context: a bounded, per-identity resume summary

## Goal

T159 specifies the persistence of concise handoff context under epic T145. When a session ends —
crash, provider switch, or an explicit owner handoff — the next session of the same identity must
recover, without bookkeeping of its own: what it was working on, which conversations are still open,
what it recently completed, and the task references to verify against authorized CLEO evidence. This
revision changes no runtime behavior; it is the design review gate for the implementation task.
MUST/MUST NOT/SHOULD/MAY follow RFC 2119.

The summary is **data, never authority**: it was written by an earlier session of the same identity,
it grants nothing, and every claim in it is re-verified at resume time against mailbox state and
authorized CLEO records. It never stores provider reasoning, plan text, or anything that is not a
reference or a bounded label.

## Sources and decisions

Builds on: `handoff()` in src/mcp.ts (unread, missed, open_threads, recent_notes), the catch-up
checkpoint (`catchup:<name>`, docs/spec/session-catchup.md), and release-on-handoff (the skill's
session-end flow). Task identifiers come from envelope `meta.task_refs` (already signed metadata).
Nothing here changes ACK semantics, delivery states, wake behavior, or policy.

## Terms

- **Handoff record**: `kv` key `handoff:<name>`, one per identity, written by the identity's own
  session and read back by a later session of the same identity.
- **Open thread**: a conversation with at least one unacked message addressed to (or mentioning) the
  identity, newest activity within the retention window.
- **Task reference**: a CLEO task id (e.g. `T159`) taken from a message's signed `meta.task_refs`.
  The record carries the reference only — never a status claim.
- **Resume session**: any later session that holds the identity's lease (same persona, new process).

## Requirements

### Storage and content (AC1: recoverable after crash or provider switch)

1. The record MUST be keyed by identity name, never session key or lease token. A resume session
   reads the same record after a crash (no release ran), after a provider switch, or after an
   explicit release-and-claim.
2. Content MUST be generated from mailbox state at write time, not free text: for each open thread
   `{ thread, subject, from, unacked, oldest_unacked_id, needs_reply }`; recent completions
   `{ msg_id, did, at }` from the identity's own acked deliveries (the ack `did` and note are already
   sender-scoped and bounded); task references `string[]` unioned from open threads' `meta.task_refs`;
   plus `{ at, by }` (write time and session id). Nothing else.
3. The record MUST NOT contain message bodies, envelope JSON, policy records, grant material, lease
   tokens, credentials, or provider reasoning. Subjects and `did` lines are the only free text, and
   both are already bounded elsewhere (subject 200, `did` 200, ack note 500).
4. A pointer to the catch-up checkpoint SHOULD be included (`catchup: { position, epoch }` read from
   `catchup:<name>` at write time) so a resume session sees the pair together; the checkpoint itself
   remains the only advanceable cursor.

### Write path (AC1, AC3)

5. The record MUST be written only by the identity's current holder, under the held write lease, at:
   explicit `mbx_identity release`; the session-end hook; and on demand (`mbx_handoff write` or a
   `save: true` call). It MUST NOT be written on every tool call.
6. Writes MUST be replace-only (one current record; no history, no append-only growth). Retention
   MUST be explicit: the record expires after 30 days, and a write older than that is dropped on
   read (same default as owner-signed lead records). Size bounds: at most 20 open threads, 10 recent
   completions, 20 task references; excess is dropped oldest-first, never truncated mid-string.
7. Release, retire (`identity prune`), and forward MUST leave the record alone; rename MUST move it
   (next to `moveCatchup`). Lifecycle parity with the catch-up checkpoint keeps one rule set.

### Read path and resume (AC1, AC2)

8. A new tool `mbx_handoff` (read-only, `withHeldRead`) returns the stored record, or an empty result
   with the reason (none, expired, malformed). `whoami` and the claim/register result SHOULD surface
   a one-line pointer ("handoff context from <date>: N open threads, M task refs; call mbx_handoff")
   so a resume session learns of it without polling.
9. Task status MUST come from authorized CLEO evidence at resume time (`cleo show <id>`), never from
   the record and never from message ACK state: the record carries task references only. The tool
   description and the skill MUST say so explicitly.
10. The record is data from a previous session of the same identity: receivers MUST treat every field
    as a hint to re-verify (thread state via `mbx_thread`, task state via CLEO), not as ground truth.
    No field widens policy, authorizes an action, or marks anything handled.

### Failure behavior and privacy (AC3)

11. A corrupted or schema-mismatched record MUST be dropped on read with an explicit reason, never
    partially interpreted. An injected write failure MUST leave the prior record intact.
12. The read response MUST leak nothing beyond the identity's own mailbox-derived facts: no other
    agent's state, no foreign diagnostics, no bodies. The record is never exposed through doctor,
    diagnostics, or the ledger.
13. Bounded like the rest of the surface: `mbx_handoff` answers one record (a few KB worst case), no
    paging needed.

## Non-goals

No draft state (T160/T161), no cross-host handoff exchange (a paired host's sessions hold their own
identities), no automatic resume actions (the resume session always decides), no change to the
catch-up checkpoint semantics, and no scoring/ranking of threads beyond recency.

## Open questions for review

- (a) Write triggers: release + session-end + explicit only, or also after each `mbx_ack` batch?
  (Cost: one small write per ack batch; benefit: fresher crash recovery.)
- (b) Should open threads carry the newest message id too, or only the oldest unacked?
- (c) 30-day retention vs the 10-day project activity window used elsewhere in the registry.

## Testable requirements (implementation task)

| ID | Requirement |
|---|---|
| HC-01 | Crash simulation: bind → work → kill → resume session claims the identity → `mbx_handoff` returns the record written at bind/ack time. |
| HC-02 | Provider switch: same identity in a different CLI reads the same record; a different identity reads none. |
| HC-03 | Content is generated from mailbox state and bounded: 20/10/20 caps enforced, subjects only, no bodies or envelopes in the stored JSON. |
| HC-04 | Task references come from signed `meta.task_refs` only; the tool text and skill state status must be re-verified via CLEO. |
| HC-05 | Release/retire/forward leave the record; rename moves it; expiry drops it after 30 days with an explicit reason. |
| HC-06 | Corrupted record and injected write failure behave per R11. |
| HC-07 | No write on ordinary tool calls; write path requires the held write lease. |
