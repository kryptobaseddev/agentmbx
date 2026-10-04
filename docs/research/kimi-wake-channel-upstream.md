# Upstream ask: a wake channel for terminal sessions (draft for the owner to post to Kimi Code)

**Title:** Feature request: let a local process inject a message into a running terminal session (channel/socket wake path)

## What we'd like

A way for another local process to wake a running Kimi Code terminal session — inject a short
message that becomes the session's next turn (or a context note), without the user typing.
Concretely, any of these shapes would work:

- a Unix-domain socket per session (e.g. `$KIMI_CODE_HOME/sessions/<id>.sock`) that accepts a
  newline-delimited JSON message and queues it as the session's next user turn;
- a `kimi queue <session-id> "text"` subcommand that does the same over that socket;
- a `kimi --channel <path>` flag that keeps a control socket open for the session's lifetime.

## Why

We run AgentMBX, a signed local mailbox between AI coding agents on one machine. A daemon
delivers mail to agent sessions as it arrives:

- **Claude Code** exposes a channel/socket mechanism, so a daemon can push into a live session.
- **Codex** exposes `codex queue`.
- **OpenCode** exposes a session API.
- **Kimi Code** has no external wake path: nothing outside the terminal can put text into a
  running session.

So for Kimi we poll instead of pushing: each session runs a background `agentmbx watch` process
that checks the mailbox every 2 s and exits when mail arrives (the task completion starts a new
turn), and a fallback cron self-check. It works, but it is polling by construction: latency up to
the poll interval, a background process per session, and instructions the agent must carry out by
hand. A real wake path would let the daemon deliver instantly, exactly like the other harnesses.

## What we need, precisely

1. Session-addressable: a message lands in exactly one running session (by session id or cwd).
2. Same-user only: the socket/file lives in the user's home with 0600 permissions; no network.
3. Text in, turn out: the injected string becomes the next turn (or a context note) — the session
   agent handles it like user input.
4. Best-effort: if the session is busy, the message queues; if the session is gone, the sender can
   detect that (socket absent / error).

Nothing more. No RPC surface, no remote access, no streaming.

## Existing art in Kimi Code

The `[status_line]` custom command (stdin JSON → first stdout line renders) is already a clean
minimal integration point; this asks for the same spirit in the opposite direction (outside → in).

---

*Drafted by the AgentMBX team (agentmbx dev lead + drum), 2026-10. Happy to spec the wire format
or test an early build.*
