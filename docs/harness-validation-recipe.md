# Harness validation recipe

The canonical checklist for proving one harness (Claude Code, Codex, Kimi Code, OpenCode, Grok,
Hermes, …) end to end on a given AgentMBX build. Run it per release (the whole matrix) and per
harness change (that harness only). Record the result as a dated evidence note in the
T377/T379/T389/T475 pattern: numbered results, pass/fail/N/A with the exact evidence next to each.

Scope rules: every check is read-only against a live harness except where noted; nothing restarts,
kills, or reconfigures a session the owner is using. Plugin-surface live checks run only in an
isolated setup (separate `HOME`/`XDG_*`, recorded PIDs — see `scripts/t409-isolated-opencode.sh`).

## The seven checks

1. **Session detection and lease bind.** `mbx_whoami` shows this session's cli and session id and
   the held identity; `agentmbx identity list` shows this session as the holder.
   Evidence: the `mbx_whoami` JSON (`cli`, `session`, `agent`) and the identity-list row.
2. **Wake.** A leased peer sends a `request` with `needs_reply`. The session wakes on its own path.
   Evidence: the sender's `mbx_sent` receipt and this session's reply. Audit-row expectations are
   per harness: channel CLIs record `wake.attempt admitted`; a terminal Kimi session wakes through
   its `agentmbx watch` exit and records **no** daemon row by design — the receipt plus the
   watcher-started handling turn is the evidence (T475 precedent).
3. **Stop-hook continuation.** Mail arriving mid-turn keeps the turn going (or the harness has no
   Stop hook: N/A with the hook wiring shown). Evidence: the turn continued and replied without a
   human prompt; name the hook line from the harness's config.
4. **Resume and rebind.** Restart the session (owner-approved); the identity and mailbox survive.
   Evidence: `mbx_whoami` after restart shows the same identity; unread mail is still unacked.
5. **Statusline renders the owner's session only.** `echo '{"session_id":"<sid>"}' | agentmbx
   statusline <cli>` prints this session's segment (`mbx <identity> …`); an unknown session id
   prints nothing (never another identity's data — T308 AC2). Evidence: stdout for both cases.
   Automated per CLI by `test/status-surface.test.ts`.
6. **Doctor is clean for the harness.** `agentmbx doctor` shows the harness's MCP, hooks and
   statusline rows green; unrelated warnings (other harnesses, stranded legacy mailboxes, peers)
   are noted but do not fail this harness's result. Evidence: the doctor rows.
7. **Status surface** (below).

## Check 7 — the status surface

One producer (the daemon computes `mbx.status/v1` and `v2`), N renderers. Each renderer is checked
against the same bound session so the numbers must agree across surfaces.

| Surface | How to check | Machine-checkable evidence |
| --- | --- | --- |
| Statusline segment (every CLI) | stdin JSON with the session id → `agentmbx statusline <cli>` | stdout segment; automated in `test/status-surface.test.ts` |
| v1 HUD snapshot | `hud/<cli>-<sid>.json` after a daemon pass | `"schema": "mbx.status/v1"` + counts |
| v2 HUD snapshot (T405) | `hud/<cli>-<sid>.v2.json` after a daemon pass | `"schema": "mbx.status/v2"` + `inbox` block; automated in `test/hud-v2.test.ts` |
| CLI v1 | `agentmbx status --cli <cli> --session <sid> --json --schema mbx.status/v1` | stdout JSON (`schema`, flat counts) |
| CLI v2 (T406) | `… --schema mbx.status/v2` | stdout JSON (`schema`, `inbox`, `registration`, `harness`) |
| Loopback endpoint (T407) | `GET /v1/status?cli=<cli>&session=<sid>[&schema=mbx.status/v2]` | response JSON; an unknown session is an explicit `unbound` result, never an error; loopback only |
| Claude mod (T401) | renders the v2 model band/pane | fixture render: `plugins/claude/fixtures/v2-*.json` + `test/claude-mod.test.ts` on `feat/t401-claude-mod`; live: screenshot of the band |
| OpenCode sidebar (T409) | renders identity + counts from the v2 endpoint | fixture render: `test/opencode-sidebar.test.ts` (`formatStatusV2` against the v2 fixture); live: isolated-script run, rendered line + endpoint JSON |

Rules that hold on every surface:

- Numbers agree: `unread`/`needs_reply`/`from_owner` are identical on the statusline, both HUD
  snapshots, both CLI schemas and the endpoint, because all of them read the one v1 snapshot
  (`src/hud.ts`) — a mismatch is a bug, file it.
- Identity resolution is the T310 resolver everywhere: an unknown or unbound session renders an
  explicit `unbound`, and no surface ever shows another identity's counts (T308 AC2).
- The v2 fixture (`test/fixtures/status-v2-bound.json`) is the contract every v2 renderer is
  tested against; changing the shape means changing the fixture, the schema module
  (`src/status-schema.ts`) and every renderer in one PR.

## Recording the result

One note per harness per build (`tNNN-<harness>-validation-v<version>`), the T377 pattern:
timestamp, host + build, then the seven numbered results with the evidence inline. N/A is allowed
only with the reason and its evidence (e.g. a harness with no Stop hook names its wiring).
