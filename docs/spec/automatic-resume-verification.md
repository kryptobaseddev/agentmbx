# Automatic resume across providers: verification plan (T162)

## Goal

T162 verifies that sessions resume automatically across supported providers under epic T145: after a
crash or provider restart, the same persona keeps its identity, its catch-up checkpoint, and its
unread/acked state. This document is the accepted verification plan (design review, 2026-10-02); it
records what is proven with which evidence, and what remains. It changes no runtime behavior.

## Definitions

- **Resume**: after a crash or provider restart, the same persona keeps (a) its identity lease and
  mailbox, (b) its catch-up checkpoint (`catchup:<name>`, docs/spec/session-catchup.md), (c) its
  delivery states, untouched by any resume path.
- **Exact-session restart**: the provider reopens the same native session id (Codex thread,
  OpenCode sessionID); identity and checkpoint continue without a claim.
- **New-session claim**: a fresh kernel/conversation session claims the identity; `claimFor`
  initializes the checkpoint from the replaced lease (last-held anchor).
- **Pending auto-resume**: an unbound session waits for a remembered name another session holds and
  binds automatically when that holder ends (T204 flow).

## Shared invariants (all providers)

1. A new holder continues at the committed catch-up position — never from zero, unless the agent
   explicitly restarts (CU-04, test/catchup.test.ts).
2. Rename moves the checkpoint; release, retire and forward leave it; a later claim continues it
   (CU-05).
3. No resume action mutates delivery state or ACKs: catch-up is history and never marks read;
   `mbx_ack` remains the sole handling acknowledgement (CU-06; T207 semantics unchanged).
4. A saved replay cursor survives an explicit cross-provider connector handoff
   (test: "mailbox cursor survives an explicit cross-provider connector handoff").
5. Lease-generation fencing: a generation change between capture and write produces zero native
   writes (WC-02/WC-03); no rewind, wake or resume action changes owner permission.

## Per-provider map

| Provider | Resume path | Proven (evidence) | Missing |
|---|---|---|---|
| Claude (dedicated) | New kernel session id on restart → claim with prior anchor; live push via channel/socket (T202). Inside one process the id also changes on `claude --resume`, `/resume`, `/clear` and compaction: the SessionStart hook rebinds the holder to the id named in `~/.claude/sessions/<pid>.json` (T309), and the MCP server follows that file on its next tool call or 60 s heartbeat (T326). After a crash the remembered name `name:claude:<id>` is restored automatically; after a clean exit the SessionEnd release deletes it, so the next session claims the mailbox by name | Clean + crash reconnect tests ("claude: renamed mailbox survives clean/crash reconnect"); claim/adopt idempotency; pending-resume test; persona handoff test; test/hooks.test.ts "Claude /clear with a real session file: the hook rebinds the holder to the new id; a forged id is refused (T309)"; test/status-identity.test.ts (T310); test/resume-binding.test.ts (T326) | Live capture on this host: restart or `/resume` a Claude session in a real folder, confirm the channel wake arrives before the next prompt and that `agentmbx status --cli claude --session <resumed id>` resolves the same mailbox |
| Codex (shared, resumable thread) | Exact-session restart keeps threadId; sessionHint + claim resume identity | Clean + crash reconnect tests; "MCP disconnect retires its key and reconnects to the hook session" (test/mcp.test.ts, runs as Codex); "list and claim agree" idle-conversation takeover; remembered-name pending resume | Live capture: resume a Codex thread, confirm `mbx_whoami` shows the same identity and the missed counter |
| OpenCode (shared service) | sessionID resume; same hint + claim machinery | Clean + crash reconnect tests; "an MCP-only opencode binding never wakes a guessed session" (exact session only); explicit OpenCode→Claude handoff test | Live capture, same shape as Codex |
| Kimi — terminal | Dedicated process, new session id per start; watcher wake (T033) | Clean + crash reconnect tests; live T033 watcher proofs and the 2026-10-01 wake probes, recorded as CLEO evidence on T033 (local evidence cache, not in git) | None blocking |
| Kimi — hosted (web/desktop daimon) | Bind-ticket conversation linking (T033); identity + checkpoint per conversation | Fixture: "a desktop conversation links its own mbx server by ticket, registers its own identity, resumes it, and its hooks then work"; wakeKimiDesktop outcome matrix | Live proof of resume after the daimon restarts (checkpoint continues, bind re-links); needs the app running — manual/live item |
| Hermes | MCP-only wiring exists; Hermes deferred (T189) with explicit fixture/live coverage gaps | Wiring only | Everything resume-specific: no hooks, no wake path, no reconnect test. Record as the accepted deferral; a fixture-level claim test is the only near-term item |

## Evidence to record now

- CU-01..CU-10 suite (merged; CI green) for the checkpoint contract.
- Per-CLI reconnect matrix above (test suite).
- The two-host live proof (T220, macbook ↔ fedora, 2026-10-02) and the T033 live evidence, both recorded as CLEO task
  evidence (the evidence cache is local and not in git).

## Missing-work list

1. Live restart captures: Claude channel wake after a real terminal restart; Codex and OpenCode
   thread/session resumes showing identity + missed counter. Each is a short manual run on this
   host; record the outputs as CLEO evidence on T162.
2. Hosted-Kimi daimon-restart proof (checkpoint continuity and bind re-link).
3. Hermes: fixture claim test plus a documented deferral referencing T189.

No resume path may widen policy, mutate delivery state, or acknowledge mail; the plan is complete
when every row above is either proven-with-evidence or recorded as an accepted gap.
