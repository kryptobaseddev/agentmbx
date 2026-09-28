# AgentMBX identity leases and migration safeguards

Status: implementation plan; not a shipped protocol or owner authorization.

## Evidence and scope

At AgentMBX revision 4ab6c47, sessions are keyed by `(cli, session_id)` and mail, policies and directory rows use mutable names. MCP processes hold ephemeral keys. The conduit experiment at test/conduit-transport.test.ts demonstrates that ordinary envelopes signed by the same host do not distinguish two sessions claiming the same sender label. Owner-grant verification is a separate protection and is not broken by this experiment.

This plan develops T081 and its integration with T066, T065, T082 and T083. The canonical research source is conduit-council-verdict (2026-09-26); it requires immutable identity and session attribution before production conduit cutover. The current test is a local mapping experiment, not production or cross-host conformance. T085 decision D001 retains plaintext mail until durable encryption and recovery are designed.

## Invariants

- One identity has at most one current lease holder, acquired atomically in a SQLite transaction.
- A holder is identified by a fresh lease token plus session key fingerprint and recorded process birth identity. PID equality alone is insufficient; hosted providers can run multiple sessions in one process.
- Every heartbeat, release and authorized operation must match the current lease token. A delayed old heartbeat cannot reacquire or release a successor's lease.
- A stale connection must fail before sending, acknowledging, renaming or approving permissions under a lost identity. Heartbeat-only checking is insufficient.
- Dead-holder recovery requires positive process-death or birth-mismatch evidence; failed inspection is not evidence of death. Idle expiration uses an explicit stored deadline, default 30 minutes, with validated configuration.
- Expiration releases ownership, not the identity or its mailbox. Historical envelopes and completed delivery records remain intact.
- An explicit claim may acquire a released or expired identity. A live forced takeover requires separately verified owner authorization covering that identity and operation; agents cannot infer approval from a mailbox request.
- Claim, release, expire and authorized takeover leave audit records, including prior/new holder provenance without private keys.

## Migration and compatibility

Implement on an isolated branch and use disposable database copies first. Bump the schema marker with the schema change and retain the existing early stale-server check. Do not upgrade the live shared database until the candidate passes migration, race, reconnect and all-provider binding checks.

Introduce immutable identity records and a distinct mutable handle mapping. Existing name-keyed mail can be attached to a migrated identity only with explicit provenance; ambiguous shared legacy names remain unresolved rather than being assigned to the latest session. A routing alias or saved name is not ownership evidence.

Historical host-signed envelopes remain byte-for-byte unchanged and are shown as unattributed. Do not synthesize a historical session signature. New session signatures must bind the immutable sender identity, session key and complete envelope, with a verifiable identity/key binding; merely adding an unbound public key does not authenticate a handle.

Existing owner-signed name policies remain legacy name policies over their original signed bytes. Migration must not rewrite their signed records or claim they authorize an immutable ID. New ID-bound policies require a versioned signed record and normal owner signing. Likewise, an existing owner grant to a session key cannot silently become a grant to all future holders of an identity.

Adopt existing bindings only when holder identity is unambiguous and current process evidence matches. Preserve ambiguous active rows as migration conflicts. Hook-before-MCP and MCP-before-hook adoption must use the same verified session evidence already enforced in bindSession. Shared Codex/OpenCode process IDs cannot choose a holder without their per-request thread/session IDs.

## Integration order

1. T063: retain and verify the experiment, including its attribution failure and complete INVENTED mapping list.
2. Define identity, handle, lease and session-binding records together; document legacy authority behavior before changing signed formats.
3. T081: implement atomic claim/renew/release/expiry, positive process evidence, fencing and audit. Integrate claims with MCP binding and disconnect, and validate every identity-bearing operation against the lease.
4. T066/T065: migrate handles/mail routing while preserving bytes, then add identity-bound session envelope attribution and honest legacy labels.
5. T082/T083: expose list/claim/release/owner-authorized takeover, handoff summaries and lease-aware CLI --as. Retire implicit identity links only with a migration path for their pending mail.
6. Validate Claude, Codex, Kimi and OpenCode startup, reconnect, rename, crash recovery and two sessions sharing one service process. Existing pending provider prompts remain explicit approval boundaries.
7. Ship a coordinated schema/runtime update with tested rollback and restart guidance; only then enable production conduit cutover.

## Required verification

Use independent SQLite connections/processes synchronized at a claim barrier; exactly one claimant must commit. Test old-token heartbeat and release after takeover, crash and PID reuse, idle boundary, unknown process status, simultaneous rename/claim, and transaction rollback on audit failure. Verify unread and acknowledged history survives release/reclaim. Test both startup orders and shared-process sessions for all four providers. Test migration from actual old layouts, ambiguous legacy bindings, early stale-server rejection and unchanged signed envelope/policy bytes. Never count a synthetic unit fixture as live provider receipt evidence.

## Open work

Lease/identity implementation, versioned signed identity and policy formats, canonical protocol review, and live Claude/Kimi receipt validation are still incomplete. This plan does not resolve cloud account topology, SignalDock deployment state or durable body encryption.