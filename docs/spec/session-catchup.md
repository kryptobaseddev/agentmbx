# Session catch-up: durable consumer checkpoints per identity

## Goal

T156 specifies the consumer checkpoint and resume contract for T145 (managed session resume and
durable catch-up, epic under T001) and T117 (durable mailbox replay cursors independent of
acknowledgement, under T116). An identity that stops mid-work — crash, provider restart, hosted
conversation closed — and resumes later, in the same or a new session, must be able to ask "what
did I miss?" and get a bounded, resumable answer without bookkeeping of its own. This revision
changes no runtime behavior; it is the design review gate for T157 (persistence) and T158
(MCP-guided catch-up). MUST/MUST NOT/SHOULD/MAY follow RFC 2119.

Agent Bus MCP server-side cursors were a reference, not a dependency. The design reuses this
repository's replay machinery (`src/replay.ts`): `mailbox_visibility` sequence positions, snapshot
frames, prune tombstones and the replay epoch. Nothing here changes message storage, delivery
states, ACK semantics, or policy.

## Terms

- **Identity**: a chosen or registered mailbox name (`src/registry.ts`). Identities survive
  restarts; sessions and session keys do not. The identity is the durable unit of catch-up.
- **Position**: a `mailbox_visibility.seq` for the identity's mailbox — the same coordinate
  `mbx_replay` pages over. History positions whose message was retention-pruned stay valid
  coordinates and are reported as gaps.
- **Record**: the stored checkpoint, `kv` key `catchup:<name>`, value
  `{ v: 1, epoch, position, filter, updated_at, by }`. `filter` is fixed to the unfiltered replay
  scope for now (hash of all-null filter values, matching replay frames).
- **Epoch**: the store's replay generation (`replay:epoch` in `src/replay.ts`). Restore/reset
  rotates it and invalidates every record's commits until the agent restarts explicitly.
- **Page**: one bounded replay result (limit 1–200, `maxBytes`, `scanLimit`), projected exactly
  like replay rows, with `next_cursor` the only advance token.
- **Missed**: messages first-visible after the stored position and at or before the current
  snapshot end.

## Requirements

### Position storage (T157)

1. The checkpoint MUST be keyed by identity name, never by session key, lease token, or process
   id. A resumed, re-claimed, or auto-resumed pending identity continues the same record.
2. The record MUST bind the current replay epoch. A commit whose frame epoch differs from the
   store's MUST fail with `CURSOR_EXPIRED` and MUST require an explicit restart decision
   (restart-from-zero or skip-to-now), never a silent reset.
3. **Origin.** On first use of an identity that has history, the position MUST start at the
   highest visibility seq first visible at or before the identity's lease `released_at` (or
   `heartbeat_at` when the lease expired without a release) — the last position the identity could
   have seen while it was last held. Starting at the current max would discard exactly what a
   crashed agent missed. Only an identity with no visibility history starts at the current max.
   The chosen origin MUST be recorded in the audit line, e.g. `origin: last-held 2026-10-01T19:02Z`
   or `origin: genesis`.
4. **Lifecycle.** A rename via `mbx_whoami` MUST move the record with the registration
   (`renameRegistration` or adjacent in the rename path). Release, retire (`identity prune`) and
   forward MUST leave the record untouched; a later claim continues it. Deleting a record is never
   part of those operations.
5. Restart and injected write failures MUST keep the prior committed position: a failed commit
   leaves the record unchanged, and a later holder re-reads the last committed value. Concurrent
   consumers cannot silently skip or overwrite a checkpoint: one identity has one lease holder,
   and commits run under the identity's held write lease.

### Fetching and advancing (T157, T117)

6. `mbx_catchup` runs under the identity's held lease (`withHeldRead` for fetch, `withHeld` for
   commit). It MUST page exactly like `mbx_replay` — same bounds, same byte budget, same
   `content_omitted` and `history_pruned` behavior — and MUST re-check per-message visibility, so
   holding a position grants no authority.
7. Fetching a page MUST NOT advance the stored position. The returned `next_cursor` is the only
   advance token; re-fetching a cursor MUST be idempotent (same page), so a lost response is a
   safe retry and agents dedupe by message id.
8. Advancing is an explicit second call, `mbx_catchup({ commit: <cursor> })`, after the agent has
   durably captured the page. Commits MUST be monotonic: a commit older than the stored position
   fails (`CURSOR_INVALID`, never rewind); a same-cursor re-commit is a no-op. A commit MUST fence
   on the current lease and generation: a superseded session's commit fails with the lease error.
9. Catch-up MUST NOT advance or mutate any delivery state (nothing becomes `read`, `notified`, or
   `acked`), MUST NOT mark messages read (only `mbx_read` does, per T207), and MUST NOT ACK:
   handling acknowledgement stays independent (`mbx_ack` only). Reading history MUST NOT grant
   policy or authority.
10. Every advance MUST write an audit line (`catchup.advance`: name, from, to, session, origin or
    gap count). Advancement failures MUST surface to the caller, not be retried blindly by the
    tool itself beyond the repository's existing unknown-evidence retry.

### Guided start and resume (T158)

11. A dedicated session that binds or claims an identity and has missed messages MUST get a
    bounded hint: "N messages since <updated_at>; call mbx_catchup". The count is an indexed count
    of the mailbox's own visibility rows after the stored position (seq is a global autoincrement,
    so a raw max-difference would count other mailboxes' interleaved positions); zero means no
    hint (no noise).
12. **Bounded hint.** When the gap exceeds 500 messages or 7 days, the hint MUST instead suggest
    `mbx_inbox` first and state that catch-up is optional, so a long-dormant identity is not
    pushed into replaying weeks of history.
13. Shared transports (Codex, OpenCode) MUST NOT get a session-start hint; their claim/register
    result (`handoff()` summary) and `mbx_whoami` MUST carry a `missed` count instead, visible the
    moment the conversation binds.
14. A fresh session that claims an identity MUST resume the stored checkpoint (requirement 1);
    the same persona under a newly authorized holder continues where the previous holder
    committed — never from zero, unless the agent explicitly restarts.

### Failure behavior (T156 acceptance)

15. Lost response between fetch and commit MUST be safe: re-fetch the same cursor, or re-commit it;
    both are idempotent. The position MUST advance only past pages the agent confirmed in hand.
16. Lease change between fetch and commit: the commit fails with the lease error and the agent
    re-authorizes as the new holder before continuing.
17. Filter and scope: catch-up uses the unfiltered scope; a cursor from a filtered replay MUST NOT
    be accepted as a commit (scope mismatch, matching replay's filter binding).
18. Concurrent consumers: the one-holder invariant plus requirement 8's lease fencing make
    double-advance impossible; two identities on one shared transport keep separate records.
19. Partial capture errors and occupied or stale connectors MUST preserve mail and the checkpoint,
    and MUST explain recovery in the error text, per the existing replay and lease error wording.

## Non-goals

No draft state (T160/T161 territory), no handoff-context persistence (T159), no cross-host
catch-up (a paired host's daemon owns its own mailboxes), no change to wake/notify decisions, no
per-message "seen" watermark in delivery states, and no claim that catching up equals handling.

## Decisions (design review, 2026-10-02)

- Position per identity in `kv` (`catchup:<name>`), reusing replay frames; no schema change.
- Two-phase fetch/commit through one tool, `mbx_catchup({ cursor?, limit?, max-bytes?, commit? })`.
- First-use origin is last-held, never current-max, for identities with history (change from the
  initial draft; genesis only for empty mailboxes).
- The guided hint is bounded (500 messages or 7 days) and dedicated-session-only; shared
  transports read `missed` from their bind summary and `mbx_whoami`.
- Rename moves the record; release/retire/forward never delete it.

## Testable requirements (T157/T158)

| ID | Requirement |
|---|---|
| CU-01 | Fresh identity with history starts at its last-held seq; audit names the origin. A fresh identity without history starts at current max. |
| CU-02 | Fetch returns a page and does not move the stored position; re-fetch with the returned cursor returns the same page. |
| CU-03 | `commit` advances monotonically; older commit fails; identical re-commit is a no-op. |
| CU-04 | Restart simulation: claim → catch-up → commit → new session claims the same identity → fetch resumes from the committed position, not from zero. |
| CU-05 | Rename moves the record; the old name has none; release/retire/forward leave it in place and a later claim continues it. |
| CU-06 | Catch-up mutates no delivery state: after fetch+commit, deliveries rows for the mailbox are byte-identical. |
| CU-07 | Epoch rotation invalidates commits (`CURSOR_EXPIRED`) and explicit restart re-anchors with a fresh audit origin. |
| CU-08 | Gap over 500 messages or 7 days produces the inbox-first hint; under it, the catch-up hint; shared transports get `missed` in bind/whoami, never a session-start hint. |
| CU-09 | A filtered replay cursor is rejected as a commit (`CURSOR_SCOPE_MISMATCH`). |
| CU-10 | Injected write failure during commit keeps the prior checkpoint (T157). |
