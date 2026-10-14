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
   Evidence: the `mbx_whoami` JSON (`cli`, `harness_session`, `agent`) and the identity-list row.
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
5. **Statusline renders the owner's session only.** Use the **harness session id** — the
   `harness_session` field of this session's `mbx_whoami` JSON (NOT `session`, which is the lease
   key fingerprint, and NOT the lease session id; T548). `echo '{"session_id":"<harness_session>"}'
   | agentmbx statusline <cli>` prints this session's segment (`mbx <identity> …`); an unknown
   session id prints nothing (never another identity's data — T308 AC2). Evidence: stdout for both
   cases. Automated per CLI by `test/status-surface.test.ts`; the whoami→statusline id hand-off is
   automated in `test/whoami-harness-session.test.ts`.
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

### Hermes evidence (T527, recorded 2026-10-10)

agentmbx-hermes verified live in its terminal:

- Hermes has **no status-line feature** — there is nothing in the TUI to render a segment, so the
  statusline surface is N/A for Hermes and `agentmbx doctor` says so explicitly (the opencode
  precedent). The daemon still writes `hud/hermes-<sid>.json`/`.v2.json`/`.line` for
  `agentmbx status` and any future surface (automated in `test/status-surface.test.ts`).
- Only `pre_llm_call` consumes hook stdout as injected context (`{"context": ...}`). Hermes also
  runs `on_session_start` (an observer; its stdout is dropped) and supports `pre_tool_call` /
  `post_tool_call`, but neither injects stdout — so there is no post-tool injection channel, and
  none was wired. Mid-turn mail instead rides `pre_llm_call`, which fires per LLM call: mail that
  arrives between two calls of one tool loop is injected on the next call of the same turn
  (automated in `test/hermes-hooks.test.ts`).

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

## Appendix: collecting the evidence on Hermes

Hermes-specific ways to get each check's evidence, from the 0.5.27–0.5.30 runs (T527, T606, T610). Hermes has no Stop
hook and no status line, so checks 3 and 5 are N/A. For an agent doing this as a repository task, the general
workflow is in [`docs/contributing/agent-workflow.md`](contributing/agent-workflow.md).

**Order.**
1. Read-only checks (1, 3, 5, 6, 7) first, then an interim report.
2. Then the wake test (2): end the turn with the `agentmbx watch` watcher armed, so the probe lands while the session is idle.
3. Then the restart checks (4 and the resume notice). Hooks and MCP wiring are read at session start, so only an
   owner-approved restart can prove them.

**Where to look.**
- **Run `agentmbx` through the install the hooks use.** Take it from the `command:` lines under `hooks:` in
  `~/.hermes/config.yaml`, and run it as `<node> <install>/bin/agentmbx.js`. Grep the file; never print it, it holds
  secrets.
- **Hermes's own session id** (`YYYYMMDD_HHMMSS_<6 hex>`) appears as `session=` on the `conversation turn` lines of
  `~/.hermes/logs/agent.log`. Those lines also show the first characters of each turn's prompt, which is how you prove
  what started a turn.
- **The mbx store** is `~/.local/share/agentmbx/mbx.db`. Open it read-only (`sqlite3 -readonly`).
  - `audit` columns are `at, event, detail`.
  - `kv` columns are `k, v`.
- **Hook output is not stored in `~/.hermes/state.db`.** Quote the injected `[mbx]` lines verbatim from your own turn
  input, and back them with `kv` rows.
- **Save a read-only collector script in scratch.** It prints `mbx_whoami`, the `sessions` row for `cli='hermes'`, the
  lease, the hermes `kv` rows, recent audit rows and the doctor rows. Run it at every stage (baseline, after install,
  after each restart) and diff the outputs.

**Evidence per check.**
1. **Bind.** The `sessions` row for `cli='hermes'` carries Hermes's id, not `mcp-<pid>`. `kv name:hermes:<sid>` holds the
   identity, and doctor reports `1 real session ID(s)`.
   - `kv guided:hermes:<sid>` and `session-hint:hermes:<gateway pid>` are written on the hook's unbound path. They prove
     the hook ran even when it did not bind.
2. **Wake.** An audit `wake.attempt` with `via:watcher`, `outcome:admitted`, `receipt:transport` and the real session id,
   plus a turn whose prompt starts `[IMPORTANT: Background process … agentmbx watch` with no human input.
   - On an idle session the turn starts about 0.1 s after the row.
   - A probe that landed mid-turn is not a pass; ask for a resend.
   - Under a goal loop, a continuation prompt can start the turn instead. Name which one did.
3. **Stop hook: N/A.** `hooks:` lists only `on_session_start` and `pre_llm_call`. Note that mail arriving mid-turn stayed
   unseen until the turn ended.
4. **Resume and rebind.** After the owner restarts (quit, then `hermes --resume <id>`):
   - Make `mbx_whoami` the first mbx call, with no claim.
   - `ps -o pid,ppid,lstart,command -p <mcp pid>` shows the new MCP's parent is the new gateway. Find the gateway with
     `ps -axo pid,ppid,lstart,command | grep tui_gateway`; `pgrep -f` can miss it.
   - PASS means:
     - the audit `identity.claim` row carries the real session id (not `mcp-<pid>`);
     - there was no manual claim;
     - a marker message kept unacked through every step is still unacked.
   - The claim lands with your first mbx call, so the audit cannot tell whether your call or the MCP caused it. Say so.
   - The release-to-claim gap may write one `mailbox.escalated` row for unread needs-reply mail. Report whether one
     appeared.
   - An in-place version handover (release, then claim within a second, same parent) is not check 4.
5. **Statusline: N/A.** `agentmbx statusline hermes` prints the usage text. Hermes's status bar takes no command.
6. **Doctor.** Expect hermes rows for MCP wired, hooks wired, hooks approved, and the binding count. Cross-check a "hooks
   not approved" row with `hermes hooks list`, which is read-only. Don't use `hermes hooks doctor` or `hermes hooks test`:
   they write `kv` rows into the live store.
7. **Status surfaces.** Compare CLI v1 and v2, the loopback endpoint and `hud/hermes-<sid>.*` for the real id. An unknown
   id must read `unbound`.

**Resume notice (0.5.28+; restart behaviour 0.5.30+, T189 and T610).** Test each entry kind on its own: `/new`,
`/resume`, and a full restart. Record `mbx_whoami.version` at each one.
- **On `/new` and `/resume`,** the first bound turn carries the notice: identity and role, the catch-up hint and the
  open-thread count. `kv resume-entry:hermes:<gateway pid>` becomes `<pid start> <session id>`.
- **After a full restart,** the first turn carries `[mbx] Resuming <name>@<host> … Call mbx_whoami`.
  - Read the `kv` rows before your first mbx call, because that call claims: `session-hint:hermes:<new gateway>` should
    be present and `resume-entry:hermes:<new gateway>` absent.
  - The next turn (a watcher wake counts) carries the notice, and `resume-entry` appears.
- **The entry is consumed when the hook emits the notice,** not when the model receives it. A turn whose model request
  failed still consumes it.

**Recording.** Record a dated note on the validation task: host, build, and one line per check with its evidence. Failures
go to the lead as findings with a repro, for the lead to file.
