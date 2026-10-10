# Research findings (2026-09-25/26)

Four research passes. The Codex, OpenCode and Kimi items were tested on the MacBook, Claude's came from its docs and a local inspection, and Hermes' came from its docs plus the old Fedora config.

## Prior art: nothing covers both needs
No existing tool both works across machines on a LAN and wakes an idle agent in all of our CLIs. The closest options:

| Tool | What it does | What it lacks |
|---|---|---|
| mcp_agent_mail (Python, about 2.2k★) | Mail-style MCP server: a git + SQLite store, agent names, file leases | Agents have to poll; built for one machine; 40+ tools |
| AgentWorkforce relay | Broker that runs each agent in its own PTY and types messages into it | Only works for agents it launched; routes through a cloud service |
| Claude cross-session messaging | Wakes idle sessions, with strong labelling that a message is not the user | Claude-only; cross-machine goes through Anthropic via Remote Control |
| A2A / SLIM | Enterprise agent protocols | None of our CLIs speaks them |

The predecessor, `mbx` v2 (a 58-line bash + jq tool: one JSON file per message on a shared network folder, written to a temp file and renamed), coordinated agents on two machines during a real workstation migration.

## SignalDock: what to keep
SignalDock was a hosted, multi-tenant platform: about 22k lines of Rust, with payments, a leaderboard, auth, five transports, S3 and two databases. Its local delivery still ended up as "write a JSON file". Despite all that it was at-most-once, had no signatures, and its owner model was a claim code.

What's worth keeping:
- **Metadata parsed from the message body:** `@mention`, `/directive` (claim, done, blocked, approve, decision, checkin), `#tag`, `T123` task refs, and an "action items" view built from them.
- **A trimmed agent card:** capabilities, `last_seen`.
- **Per-recipient delivered/read state.**
- **Client-side dedupe** on message id, plus a `since` cursor.
- **Signed hops:** HMAC over a timestamp, with a ±300 s window and a delivery-id header.
- **FTS5 search.**
- **A delivery result type:** `Delivered | Retry | Failed`.
- **CLEO's `ownerPubkeys` allowlist:** Ed25519 keys that authorise the owner.

## Waking each CLI
| CLI | Active session | Idle interactive session | Headless | Status |
|---|---|---|---|---|
| **Claude Code** | Channel event; hook `additionalContext` | **Channels**: the MCP server declares `experimental['claude/channel']` and emits `notifications/claude/channel`. Needs `--dangerously-load-development-channels server:<name>` until allowlisted. Fallback: an `asyncRewake` hook that long-polls (unverified), or a Stop hook | `claude -p --resume`, or channels with `-p` | docs |
| **Codex 0.156** | Stop hook `additionalContext`/`block`; app-server `turn/steer` | **`codex queue --thread <id> --message <text>`**: woke an idle TUI in about 1 s; messages queued while the thread is closed run on the next open | `codex exec resume`, app-server | **verified** |
| **OpenCode 2.0.15** | `POST /api/session/{id}/synthetic {text, delivery:"queue"\|"steer"}` | same call: woke an idle session with no human present | same + SSE `/api/event` | **verified** |
| **Kimi Code 2.1** | UserPromptSubmit hook adds context; one Stop continuation per turn | no push into the TUI; the agent's own CronCreate polls; or run under `kimi web` → `POST /api/v1/sessions/{id}/prompts` | `kimi web` REST, `kimi acp`, `kimi -S <id> -p` | source-read; the model isn't logged in |
| **Hermes** | plugin `ctx.inject_message(session_key=…)` (with `allow_gateway_injection`) | same, or a plugin that registers an "mbx" gateway platform; webhook with `mirror_to_session` | `POST /v1/runs` with `X-Hermes-Session-Id`, `hermes -z` | docs; not installed on the test Mac |

Every CLI has a SessionStart-style hook that reports its session or thread id, which is how the server binds an agent to a live session.

Claude's session sockets (`/tmp/cc-socks`) use a private wire format. Don't post to another session's socket.

## Trust
- A signature proves **who** sent a message. It does not make the content trusted.
- No message can approve a recipient CLI's permission prompts. Claude enforces this for peer messages, and we mirror it everywhere.
- The OS user account is the real boundary on one machine: any process running as that user can read files it owns. Owner signing therefore needs human presence: a Keychain item with no trusted apps, which prompts for the password, or a passphrase-protected key on Linux.
- Pairing: Syncthing-style mutual approval plus a 6-digit short authentication string (a fingerprint of both keys and nonces), confirmed by a human on both sides.
- Owner delegation: the owner key signs a grant `{sub, caps, exp}` for a master agent, one level only. Recipients see a verified label; the server checks capabilities.
- Later: X25519 sealed-box encryption (the `enc` field is reserved), mDNS `_mbx._tcp` discovery, advisory file leases with a TTL.

## Permission hooks per CLI (2026-09-26)
T051, for YOLO (`docs/POLICY.md` §5). Checked against the binaries installed on the test Mac: Claude Code 2.1.283, Codex 0.157.1, Kimi Code 2.1.1, OpenCode 2.0.15. Nothing was approved in a real session; the Kimi and OpenCode APIs were only read (`openapi.json`, pending lists).

| CLI | Mechanism | Verdict |
|---|---|---|
| Claude Code | `PermissionRequest` command hook returns `decision.behavior: "allow"` | **verified** (docs + binary schema) |
| Codex | `PermissionRequest` command hook, same output shape | **verified** (docs + binary strings) |
| Kimi Code | hooks can't allow. `PermissionRequest` is fire-and-forget; the hook posts the approval to the `kimi web` server, which works only for sessions that server hosts | **source-read**; plain TUI sessions have no mechanism |
| OpenCode | daemon polls `GET /api/session/{id}/permission`, answers `POST …/permission/{requestID}/reply {"decision":"once"}` | **verified** endpoints (live openapi); a plugin `permission` `evaluate` hook also exists |

### Claude Code
- Docs: https://code.claude.com/docs/en/hooks.md, "PermissionRequest" and "PermissionRequest decision control". Input carries the common fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`) plus `tool_name`, `tool_input`, optional `permission_suggestions`, and no `tool_use_id`. Allow:
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
- Binary schema (`strings ~/.local/share/claude/versions/2.1.283`): `hookEventName:R("PermissionRequest"),decision:$e([u({behavior:R("allow"),updatedInput:…optional(),updatedPermissions:…optional()}),u({behavior:R("deny"),message:…,interrupt:…})])`.
- It runs only when Claude is about to prompt, or would auto-deny a call that can't prompt. Deny and ask rules still apply after an allow. Exit code 2 is ignored for this event. Background subagents in headless mode also run it; when no hook decides, the call is denied.
- `PreToolUse` with `permissionDecision: "allow"` also skips the prompt, but it runs before every tool call, and needs `updatedInput` for `AskUserQuestion`/`ExitPlanMode`. `PermissionRequest` fires only when a prompt would appear, so it's cheaper and the better fit. We never auto-allow `AskUserQuestion` or `ExitPlanMode`: they collect an answer from the user.

### Codex
- Docs: https://developers.openai.com/codex/hooks.md, "PermissionRequest". It runs "when Codex is about to ask for approval, such as a shell escalation or managed-network approval", and not for commands that need no approval. Input: common fields (`session_id`, `cwd`, `transcript_path`, `hook_event_name`, `model`, `permission_mode`), `turn_id`, `tool_name` (`Bash`, `apply_patch`, `mcp__server__tool`), `tool_input`. Output is identical to Claude's: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. Any `deny` wins; when nobody decides, the normal approval prompt appears. `updatedInput`, `updatedPermissions` and `interrupt` fail closed today, so we don't send them.
- Binary strings (0.157.1): `PermissionRequestHookSpecificOutputWire`, `PermissionRequestDecisionWire`, `PermissionRequestBehaviorWire…behavior updatedInput updatedPermissions`. `codex features list` shows `hooks stable true`.
- Non-managed hooks need a one-time review/trust in Codex before they run (already noted for the other hooks).

### Kimi Code 2.1.1
Read from the bundled JS in `~/.kimi-code/bin/kimi` (`strings`):
- `registerPermissionHooks()` subscribes to `PermissionApprovalRequested` and calls `this.fireAndForget("PermissionRequest", inputData, e.toolName)`. The hook result is ignored, so it can't approve.
- `PreToolUse` goes through `runner.triggerBlock`, and the parser only reads `if (hookSpecificOutput?.permissionDecision !== "deny") return result;`. A hook can veto, never allow.
- The hook's stdin is the approval request with keys snake-cased (`toHookInputData`): `hook_event_name`, `session_id`, `cwd`, `id` (`approval_<uuid>`), `agent_id`, `turn_id`, `tool_call_id`, `tool_name`, `action`, `display`, `tool_input`. The event is dispatched just before `interactions.request({ id: approvalRequest.id, kind: "approval" … })` registers the approval.
- `kimi web` API (`GET http://127.0.0.1:<port>/openapi.json`, bearer `~/.kimi-code/server.token`; the port is in `~/.kimi-code/server/instances/<id>.json`): `GET /api/v1/sessions/{session_id}/approvals?status=pending` → `{code:0, data:{items:[{approval_id, session_id, tool_name, action, …}]}}`, and `POST /api/v1/sessions/{session_id}/approvals/{approval_id}` with `{"decision":"approved"|"rejected"|"cancelled", "scope"?:"session"}`.
- So the permission hook, when the policy allows, polls the pending list for its `id` for up to 5 s and then posts `approved`. That reaches only sessions hosted by the local server (`kimi web`, `kimi rc`, the desktop app). A plain `kimi` TUI session runs its engine in-process: on this Mac the server's `server/events/` only held the `kimi web` test sessions, not the latest TUI session. For those, the hook finds nothing and the prompt stays; the fallback is Kimi's own `--yolo` / `--auto` flags, documented in INSTALL.md. Matching the hook `id` with the API `approval_id` is source-read, not tested live.

### OpenCode 2.0.15
- Live `GET /openapi.json` on the running service ("opencode HttpApi"): `GET /api/permission/request`, `GET /api/session/{sessionID}/permission` → `{data:[Permission.Request]}` with `Permission.Request = {id:"per…", sessionID:"ses…", action, resources[], save?, metadata?, source?, message?}`, and `POST /api/session/{sessionID}/permission/{requestID}/reply` with `{"decision":"once"|"always"|"reject","message"?}` → 204. The body is `additionalProperties:false`; the older `{"reply":"once"}` in `scripts/e2e/wake-opencode.py` doesn't match 2.0.15's schema.
- The SSE stream `GET /api/event` sends `data: {"id","type","data"}` frames; the binary defines `permission.asked` (data = `Permission.Request`) and `permission.replied`.
- The binary also has a plugin hook: `c.trigger("permission","evaluate",{sessionID, agent, action, resources, metadata, source, effect})`, and a plugin can set `effect` (seen as `e.permission.hook("evaluate", f => { … f.effect = "deny" })`). That runs inside OpenCode and would need a JS plugin shipped into `~/.config/opencode/plugins`. We use the daemon instead, per POLICY.md: every 2 s it polls the pending requests of bound OpenCode sessions whose agent has an active policy, and replies `once`. Agents without a policy cost no request. The MCP server binds OpenCode as `mcp-<pid>`, not a `ses_…` id, so for those bindings the daemon reads `GET /api/permission/request?location[directory]=<cwd>` (checked live: it answers `{"location":{"directory":"/tmp"},"data":[]}`) and skips requests from sessions bound to another agent.

## Question

T539: which existing provider channels can apply an operation-specific outward-reversible decision without switching permission modes?

## Findings

The current implementation reuses the exact binding/lease guard and signed policy lookup, validates persisted taint, classifies a bounded literal shell command, performs read-only Git preflight outside SQLite, then rechecks authority before output or dispatch. Claude/Codex use the established PermissionRequest allow JSON; hosted Kimi uses the exact approval ID through its existing server API. These adapters are tested with isolated session fixtures and mocked provider requests, not live approval side effects.

N/A evidence, as coordinated by the lead for T539:

| Harness/surface | Evidence | Narrow-path result |
|---|---|---|
| Grok | src/setup.ts GROK_HOOK_EVENTS excludes PermissionRequest; test/grok-hooks.test.ts asserts its absence | N/A; no guessed hook installed |
| Hermes | AgentMBX wires on_session_start/pre_llm_call only. Installed agent/shell_hooks.py _parse_pre_tool_call maps action approve to human escalation; tools/human_input_hooks.py ignores observer returns | N/A; no fabricated allow output or global mode change |
| OpenCode | src/permission.ts models id/sessionID/action only, without command content | N/A for narrow authority; existing explicit permissions approval remains separate and gains taint checks |
| Kimi TUI | PermissionRequest is fire-and-forget; approveKimi requires the hosted server's matching pending approval | N/A in plain TUI; empty stdout and no successful hosted approval leave the prompt |

Unknown or malformed command payloads also keep prompting, even on a supported provider. No setup/provider adapter files or owner configuration were changed. The CLI wiring is coordinated after the T525 merge.

The classifier deliberately accepts one literal invocation, one branch destination with a proven actual-remote default, or an explicit-head draft PR. It rejects shell composition, force/delete/default pushes, multiple targets, custom Git execution/side effects and unassessed gh flags. Persisted live or unassessable taint blocks both narrow approval and YOLO. Provider dispatch and remote/configuration changes remain non-atomic race boundaries; no in-flight revocation claim is made.

## Sources

- src/outward-reversible.ts, src/permission.ts and src/session-taint.ts, with their targeted tests (T539).
- Canonical POLICY section 5 and the versioned T051 source observations above.
- Installed Hermes primary source under /Users/keatonhoskins/.hermes/hermes-agent: agent/shell_hooks.py, tools/human_input_hooks.py and tools/approval.py.
- Lead task message 01M4KCZZT3M68Q88C5DSMVQFZ2: implement real channels and record the listed N/A surfaces with evidence.
- https://cli.github.com/manual/gh_pr_create: explicit head skips implicit fork/push.
- https://git-scm.com/docs/git-push and https://git-scm.com/docs/git-ls-remote: destination refspec, push URLs, implicit effects and remote HEAD symref.
