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

`mbx` v2 (our own 58-line bash + jq tool, one JSON file per message on the NAS, written to a temp file and renamed) has worked in production for the Fedora → Mac migration.

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
| **Hermes** | plugin `ctx.inject_message(session_key=…)` (with `allow_gateway_injection`) | same, or a plugin that registers an "mbx" gateway platform; webhook with `mirror_to_session` | `POST /v1/runs` with `X-Hermes-Session-Id`, `hermes -z` | docs; not installed on the Mac |

Every CLI has a SessionStart-style hook that reports its session or thread id, which is how the server binds an agent to a live session.

Claude's session sockets (`/tmp/cc-socks`) use a private wire format. Don't post to another session's socket.

## Trust
- A signature proves **who** sent a message. It does not make the content trusted.
- No message can approve a recipient CLI's permission prompts. Claude enforces this for peer messages, and we mirror it everywhere.
- The OS user account is the real boundary on one machine: any process running as that user can read files it owns. Owner signing therefore needs human presence: a Keychain item with no trusted apps, which prompts for the password, or a passphrase-protected key on Linux.
- Pairing: Syncthing-style mutual approval plus a 6-digit short authentication string (a fingerprint of both keys and nonces), confirmed by a human on both sides.
- Owner delegation: the owner key signs a grant `{sub, caps, exp}` for a master agent, one level only. Recipients see a verified label; the server checks capabilities.
- Later: X25519 sealed-box encryption (the `enc` field is reserved), mDNS `_mbx._tcp` discovery, advisory file leases with a TTL.
