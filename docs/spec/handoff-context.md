# Handoff context: fresh read-time context plus one bounded, saved note

## Goal

T159 specifies handoff context under epic T145. When a session ends — crash, provider switch, or an
explicit owner handoff — the next session of the same identity must recover, without bookkeeping of
its own: what it was working on, which conversations are open, and the task references to verify
against authorized CLEO evidence. This revision (review change, 2026-10-02) splits the design in two:
**`mbx_handoff` computes context fresh at read time** (nothing stored, so a crash loses nothing), and
**one small, explicitly saved handoff note** is the only persisted artifact. This document is the
design review gate for the implementation task. MUST/MUST NOT/SHOULD/MAY follow RFC 2119.

The summary is **data, never authority**: it was written or computed by an earlier session of the
same identity, it grants nothing, and every claim in it is re-verified at resume time against
mailbox state and authorized CLEO records. It never stores provider reasoning, plan text, or
anything that is not a reference or a bounded label.

## Sources and decisions

Builds on: `handoff()` in src/mcp.ts (unread, missed, open_threads, recent_notes), the catch-up
checkpoint (`catchup:<name>`, docs/spec/session-catchup.md), release-on-handoff, and the T310 status
identity resolver (src/status-identity.ts). Task identifiers come from envelope `meta.task_refs`
(already signed metadata). Review answers: (a) no ack-batch writes; (b) carry both the newest and
the oldest unacked message id per open thread; (c) retention is 30 days.

## Terms

- **Handoff note**: `kv` key `handoff:<name>`, one per identity, written only by an explicit save.
- **Open thread**: a conversation with at least one unacked message addressed to (or mentioning) the
  identity, newest activity within the retention window.
- **Task reference**: a CLEO task id (e.g. `T159`) from a message's signed `meta.task_refs`; the note
  carries the reference only — never a status claim.
- **Resume session**: any later session that holds the identity's lease (same persona, new process).

## Requirements

### Read-time context (AC1: recoverable after crash or provider switch)

1. `mbx_handoff` (read-only, `withHeldRead`) computes its answer fresh from mailbox state at call
   time and stores nothing. A crash can therefore lose nothing: the context is derived, not kept.
2. The computed answer contains, per open thread: `{ thread, subject, from, unacked, oldest_unacked_id,
   newest_unacked_id, needs_reply }` — both end ids, so a resume session can page the thread from
   either side. Plus counts (unread, missed via the catch-up checkpoint, open threads) and the
   catch-up position. Nothing else.
3. The computed answer MUST NOT contain message bodies, envelope JSON, policy records, grant
   material, lease tokens, credentials, or provider reasoning. Subjects are the only free text, and
   they are already bounded (200) and mailbox-derived.

### The saved note (AC1, AC3)

4. The only persisted artifact is a handoff note authored by the agent's explicit act: `mbx_handoff save`
   or `mbx_identity release {note}`. Session-end hooks never author text — a note exists only when an
   agent chose to write one. The note is agent-entered text of at most **1000 characters**, plus
   `task_refs: string[]` and `msg_refs: string[]` that the agent chose and that are validated against
   the open threads' ids and their signed `meta.task_refs` (not auto-unioned). No other fields.
5. Writes are replace-only (one current note; no history) under the held write lease. There are no
   ack-batch or per-tool-call writes. Retention is explicit: 30 days, dropped on read with a reason.
   Size bounds: at most 20 task references and 20 message references; excess is dropped
   oldest-first, never truncated mid-string.
6. Release, retire (`identity prune`), and forward MUST leave the note alone; rename MUST move it
   (next to `moveCatchup`). Lifecycle parity with the catch-up checkpoint.

### Read path and resume (AC1, AC2)

7. `mbx_handoff` returns `{ context, note }`: the fresh computed context and the saved note (or null
   with a reason: none, expired, malformed). `whoami` and the claim/register result SHOULD surface a
   one-line pointer when either half is non-empty, so a resume session learns of it without polling.
8. Task status MUST come from authorized CLEO evidence at resume time (`cleo show <id>`), never from
   the note and never from message ACK state: the note carries task references only. The tool
   description and the skill MUST say so explicitly.
9. Everything returned is data from a previous or derived view of the same identity's mailbox:
   receivers MUST treat every field as a hint to re-verify (thread state via `mbx_thread`, task
   state via CLEO), not as ground truth. No field widens policy, authorizes an action, or marks
   anything handled.

### Failure behavior and privacy (AC3)

10. A corrupted or schema-mismatched note MUST be dropped on read with an explicit reason, never
    partially interpreted. An injected write failure MUST leave the prior note intact.
11. The read response MUST leak nothing beyond the identity's own mailbox-derived facts: no other
    agent's state, no foreign diagnostics, no bodies. The note is never exposed through doctor,
    diagnostics, or the ledger.
12. Bounded like the rest of the surface: one response of a few KB; no paging.

## Non-goals

No draft state (T160/T161), no cross-host handoff exchange, no automatic resume actions, no change
to the catch-up checkpoint semantics, and no stored per-thread history (the mailbox IS the history;
the note is a pointer, not a log).

## Testable requirements (implementation task)

| ID | Requirement |
|---|---|
| HC-01 | Crash simulation: bind → work → kill → resume session claims the identity → `mbx_handoff` computes the same open-thread context fresh (no stored state needed). |
| HC-02 | Provider switch: same identity in a different CLI reads the same context and note; a different identity reads none. |
| HC-03 | Saved note is bounded: ≤1000 chars, 20 task refs, 20 msg refs; subjects only in the computed context; no bodies or envelopes anywhere. |
| HC-04 | Task references come from signed `meta.task_refs` only; tool text and skill state status must be re-verified via CLEO. |
| HC-05 | Release/retire/forward leave the note; rename moves it; expiry drops it after 30 days with an explicit reason. |
| HC-06 | Corrupted note and injected write failure behave per R10. |
| HC-07 | Write triggers are explicit save and `mbx_identity release {note}` only (hooks never author text); no write on ordinary tool calls or ack batches. |
