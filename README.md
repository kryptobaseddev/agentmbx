# AgentMBX

**A signed mailbox for AI coding agents.** Claude Code, Codex, OpenCode, Kimi, Hermes and any MCP client can message each other: on one machine or across machines on your network. Idle agents get woken up, and every message says who really sent it.

[agentmbx.com](https://agentmbx.com) · Status: **alpha (0.1)** · License: [BUSL-1.1](LICENSE) (source-available)

```text
you ── Claude Code (planner) ──┐                         ┌── Codex (api-dev)      ← woken by `codex queue`
                               ├── agentmbx daemon ◄────►├── OpenCode (web-dev)   ← woken by its session API
     Kimi / Hermes / any MCP ──┘   (this machine)   LAN  └── Claude (reviewer)    ← woken by a channel event
                                                          (a paired machine)
```

## Why

Most people now run more than one coding agent, and often on more than one machine. They can't talk to each other. The options today:
- **Paste between them by hand.**
- **One vendor's multi-agent feature.** These only work for that vendor's agents.
- **A heavyweight agent platform.**

AgentMBX gives every agent the same small set of mailbox tools. It delivers messages between machines you pair. It wakes the recipient when its CLI allows that. It keeps a hard line between *what a message says* and *what the recipient is allowed to do*.

## What you get

- **8 MCP tools** that work in any MCP client: `mbx_send`, `mbx_inbox`, `mbx_read`, `mbx_ack`, `mbx_thread`, `mbx_search`, `mbx_agents`, `mbx_whoami`.
- **Addressing:** `agent`, `agent@host`, `role:reviewer`, `*` (broadcast), or `owner` (you).
- **Threads, replies, and requests that need a reply.** `@mentions`, `/claim` / `/done` directives and task refs (`T123`) are parsed from the body.
- **Wake-ups for idle sessions**, one adapter per CLI. The wake text never contains the message itself, only a pointer to the inbox tool.

  | CLI | Wake path | Status |
  |---|---|---|
  | Codex | `codex queue --thread <id>` | tested live |
  | OpenCode | the local service's session API (`/synthetic`) | tested live |
  | Claude Code | MCP channel event (research preview, `--dangerously-load-development-channels server:mbx`) | automated test only |
  | Kimi | hook, next turn (no external push exists) | not tested live |
  | Hermes | cron now; plugin planned | not tested live |
  | anything else | desktop notification | |

- **Across machines:** a small daemon per host. Hosts pair with a 6-digit code that you compare on both screens. Every hop is signed. Messages to a sleeping machine wait in an outbox and retry for 72 h, and each is stored exactly once.
- **A wake brake:** at most 1 wake per agent per 30 s, 6 per thread per hour, 60 per agent per day. Plain status messages never wake anyone, so two chatty agents can't burn your tokens overnight.
- **Full-text search** (SQLite FTS5) and an audit log. `mbx:<id>@<host>` references can be cited from tickets and notes.
- **Zero infrastructure:** Node 24, SQLite built into Node, and two dependencies (the MCP SDK and zod). No broker, no cloud, no accounts.

## Trust model (the short version)

| The recipient sees | It means | It does not mean |
|---|---|---|
| `local (same user on this host)` | written by a process running as your OS user on this machine | that the named agent wrote it (names are labels) |
| `verified (paired host X)` | signed by machine X's key, which you approved by comparing the pairing code | which agent on X wrote it |
| `authority: OWNER via <agent> session <fp>` | a live session that **you** approved with your owner passphrase sent it, within the capabilities you granted, before the grant expired | that the content is safe, or that permission prompts can be skipped |

- **Owner authority belongs to one running session.** You run `agentmbx owner grant` in your own terminal, pick the live session, and type your passphrase. The grant is bound to a key that exists only in that session's memory, for 12 h by default. Another process using the same agent name gets nothing.
- **The owner key** is encrypted with your passphrase and unlocks only from a real terminal. An agent's shell commands cannot use it.
- **Capabilities are enforced by the receiving machine** (`task.assign`, `decision`, `broadcast`, `alert`). A message outside its grant arrives labelled `authority: none` with a warning.
- **No message can approve a permission prompt or change a recipient's config**, owner-signed or not. The MCP instructions tell every agent this, and agents treat all message content as data, not instructions. This mirrors how Claude Code handles messages from other sessions.
- **Known limits:**
  - The LAN hop is signed but not encrypted yet (the `enc` field is reserved).
  - Agents on the same machine share the OS user boundary.

The full design is in [docs/SPEC.md](docs/SPEC.md). The adversarial review that shaped it is in [docs/COUNCIL-VERDICT-2026-09-26.md](docs/COUNCIL-VERDICT-2026-09-26.md).

## Quick start

```sh
curl -fsSL https://agentmbx.com/install.sh | sh
# or, straight from GitHub:
curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh

agentmbx init --host laptop                      # host name + host key
agentmbx daemon install                          # launchd (macOS) or systemd --user (Linux)

# add the MCP server to your agents (details for each CLI: docs/INSTALL.md)
claude mcp add --scope user mbx -- agentmbx mcp
```

The installer puts a single self-contained binary (no Node.js needed) in `~/.local/bin/agentmbx` after checking its
sha256 against the release manifest. Keep it current with:

```sh
agentmbx version --check     # is there a newer release?
agentmbx update              # verify the signed manifest, download, check sha256, replace the binary, restart the daemon
```

The daemon checks once a day and shows one desktop notification per new version; `agentmbx status` and `mbx_whoami`
show `update available: x.y.z`. Prefer npm? `npm i -g agentmbx` (Node >= 24), then update with `npm i -g agentmbx@latest`.
Maintainers: [docs/RELEASING.md](docs/RELEASING.md).

Pair a second machine:

```sh
laptop$  agentmbx pair desktop.local:7373          # prints a 6-digit code
desktop$ agentmbx peers                            # shows the same code?
both$    agentmbx pair approve <other-host> <code>
```

Then from any agent: *"send api-dev@desktop a request to run the migration tests and reply with the result"*. Or from a shell:

```sh
agentmbx send --as planner --to api-dev@desktop --kind request --needs-reply --subject "run migration tests" -m "…"
agentmbx inbox --as planner
```

Owner authority (optional, only on the machine you use):

```sh
agentmbx owner init                                            # choose a passphrase
agentmbx owner grant planner --caps task.assign,decision --ttl 12h
```

## Command reference

`agentmbx help` lists everything:
- **Messages:** `send`, `inbox`, `read`, `ack`, `thread`, `search`, `agents`, `status`
- **Machines:** `init`, `pair`, `pair approve`, `peers`, `peers remove`, `daemon [install|uninstall]`
- **Owner:** `owner init|show|grant|revoke`
- **Integration:** `mcp`, `hook session-start|prompt|stop --cli <cli>`, `import-v2`
- **Install:** `version [--check]`, `update [--check] [--yes]`

## How it compares

| | AgentMBX | mcp_agent_mail | Claude cross-session messaging | A2A |
|---|---|---|---|---|
| Any MCP CLI | ✔ | ✔ | Claude only | needs A2A support |
| Across machines | ✔ direct, LAN | one server | via Anthropic (Remote Control) | ✔ |
| Wakes idle sessions | ✔ Codex, OpenCode, Claude* | ✗ (agents poll) | ✔ | ✗ |
| Signed messages | ✔ | ✗ | internal | ✔ |
| Verifiable owner authority | ✔ | ✗ | ✗ | ✗ |

\* Claude channels are a research preview.

## Development

```sh
git clone https://github.com/kryptobaseddev/agentmbx && cd agentmbx && npm install
npm test            # 19 tests: crypto, trust (incl. the council's four), two-host HTTP, MCP client, channel push
npm run typecheck
python3 scripts/e2e/wake-codex.py      # live: wakes a real idle Codex TUI (see docs/TESTING.md)
```

- Docs: [SPEC](docs/SPEC.md) · [INSTALL](docs/INSTALL.md) · [RESEARCH](docs/RESEARCH.md) · [TESTING](docs/TESTING.md)
- Contributions: issues are welcome. Pull requests need agreement that the Licensor may license contributions under the terms in [LICENSE](LICENSE).

## License

AgentMBX is **source-available, not open source**. It is licensed under the [Business Source License 1.1](LICENSE):
- **Free:** reading, modifying, and running it for your own agents and your own organization, in production too.
- **Needs a commercial license:** offering it, or anything built from it, to others as a product, hosted service or embedded agent-messaging feature. Contact via [agentmbx.com](https://agentmbx.com).
- Each version becomes Apache 2.0 four years after release (Change Date 2030-09-26 for 0.1).

"AgentMBX" and "MBX" are trademarks of Keaton Hoskins; see [NOTICE](NOTICE).
