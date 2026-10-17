# Portability: verify the complete path on each machine

AgentMBX supports macOS and Linux. This page records installation and provider
boundaries against published npm 0.5.32 (source `64ee20ebb1dd97b64be7dd122a11a5a5ce5eacbf`), checked on
2026-10-14. It doesn't assert that every current provider build or physical
network has been tested. Historical live receipts prove their recorded
versions/sessions; see [the current roadmap](plan/native-feature-roadmap.md) and
[the harness validation recipe](harness-validation-recipe.md) for remaining gates.

## 1. Install the current npm release

```sh
npm install --global agentmbx@latest
agentmbx setup
agentmbx doctor
```

Node.js 24 or newer is required. `@latest` resolves npm's current published tag
each time the install command runs; it doesn't schedule automatic updates.
Compare `npm view agentmbx@latest version` with `agentmbx version`. A source
checkout, GitHub release, or tag can be ahead of the npm artifact.

| Step | macOS | Linux | Boundary |
|---|---|---|---|
| npm installation | Supported | Supported | Requires Node ≥24 and npm's global bin directory on PATH |
| Optional `curl …/install.sh \| sh` binary | darwin-arm64/x64 release targets | linux-x64/arm64 release targets | SHA-256 checked; no separate Node install required. Windows isn't supported |
| AgentMBX.app notifier/launcher/auth helper | Universal app, installed to `~/Applications` | Not applicable | Release workflow builds the app; its actual signing identity depends on release configuration |
| App signing | Stable configured identity supported (T056); ad-hoc fallback | Not applicable | An ad-hoc update can trigger another Keychain trust prompt; see [macOS release signing](RELEASING-macos.md) |
| Daemon service | launchd | systemd `--user` | Setup refuses to replace the real service from a HOME that isn't the account's real home |
| Upgrade | npm installs use `npm install --global agentmbx@latest`; binary installs use `agentmbx update` | Same | `version --check` and the binary updater use the signed GitHub release manifest, not npm's dist-tag |
| Node/version-manager paths | Setup stores resolved absolute Node and entry-script paths | Same | Setup doesn't rely on a mutable mise/asdf shim. Re-run it after moving/removing a Node or package install |

See [INSTALL.md](INSTALL.md) for PATH conflicts and manual configuration.

## 2. Wire and qualify agent CLIs

Setup has adapters for Claude Code, Codex, OpenCode, Kimi, Hermes, and Grok.
Copilot, Cursor, and Gemini status-line renderers exist, but automatic session
detection/wiring remains a separate boundary. An arbitrary MCP client can wire
`agentmbx mcp` manually; that doesn't imply a wake adapter exists.

| CLI | MCP and hooks in published setup | Idle wake path | Limit to verify on the actual provider |
|---|---|---|---|
| Claude Code | MCP; SessionStart, UserPromptSubmit, PermissionRequest, Stop, PostToolUse, SessionEnd | Its own MCP server sends a no-body hint through the per-session messaging socket; optional `agentmbx claude` channel launcher | Socket/channel support and exact-session binding; historical macOS/Linux receipts aren't proof of every current frontend |
| Codex | MCP; SessionStart, UserPromptSubmit, PermissionRequest, Stop | `codex app-server` experimental `thread/queue/add`, `thread/queue/list`, and `thread/queue/delete`; tracks owned notices and withdraws them after read/ack, release, or handover while still queued; unowned items are preserved | Requires a Codex build with the experimental queue API and hooks. Consumed notices cannot be recalled. Startup, same-thread resume, and new-thread isolation are separate live gates |
| OpenCode | MCP; plugin session-created, post-tool, and idle hooks; sidebar plugin | Service sessions use their API; standalone sessions use their own plugin/loopback queue. Both daemon wake paths use `resume: true` (T544) | An idle standalone turn was observed with T544; a receipt alone still doesn't prove model execution. Shared-service permission coverage doesn't establish standalone coverage |
| Kimi terminal | MCP, skill, SessionStart/UserPromptSubmit/PermissionRequest/Stop hooks | One background `agentmbx watch` task exits with a hint and starts the next turn | Re-arm the watcher after handling mail. `MBX_SELF_WATCH` opts into a periodic self-check. Terminal permission hooks can't approve prompts |
| Kimi web/rc/desktop | MCP and hosted-session hooks; one-time conversation bind ticket | Web prompts API or desktop control socket | Restart a hosted server started before setup; verify the current exact conversation. Approval API coverage applies to hosted sessions |
| Hermes terminal/TUI | MCP; `on_session_start` and `pre_llm_call` shell hooks with exact hook approvals | Background `agentmbx watch` task with completion notifications | Re-arm after each wake. Hooks load at session start; a shared gateway/desktop host isn't covered. No Hermes permission-approval adapter is claimed |
| Grok | MCP, status line, SessionStart/UserPromptSubmit/PostToolUse/Stop hooks | Background `agentmbx watch --cli grok --session <id>` | Re-arm each completion; verify exact session ID and provider background-task notification |
| Other MCP clients | Manual MCP configuration | Desktop notification fallback | No automatic model turn or permission adapter implied |

For long-lived OpenCode agents, prefer plain `opencode` against the shared service, started once with
`opencode service start`: one service per machine, not per project. After MCP eviction, standalone
bindings remain wakeable while their plugin polls the local daemon (T659); service-hosted bindings
remain wakeable while their recorded service process lives (T688). Both paths verify the recorded PID
and process birth, and refuse an old binding when a different session holds the mailbox lease.
See [OpenCode run modes and eviction recovery](OPENCODE.md#after-opencode-evicts-the-sessions-mcp).

Setup preserves other tools' hook groups, backs up files before editing, and
uninstall removes AgentMBX-owned entries. Modified/foreign configuration can
require manual review. See [the wake reference](SPEC.md#waking-recipients).

## 3. Keep owner identity explicit

| Step | macOS | Linux / SSH |
|---|---|---|
| Owner key | Keychain via `agentmbx-auth`; signatures require Touch ID or account-password approval | Passphrase-encrypted file, unlocked on `/dev/tty`; proves knowledge of the passphrase, not human presence |
| No GUI session | The helper fails promptly; setup prints a command for the owner | Terminal passphrase path |
| Second machine | Pair, then approve `agentmbx owner add-device <host>` from the owner machine | Same, using that machine's owner approval method |
| Hosted accounts and cross-owner members | Account/device-authorization components exist, with production enrollment and bilateral sharing still requiring live proof | Same; local/LAN messaging requires no account |

Agents may initiate an owner-signature request; they can't turn its message body
into owner approval. See [POLICY.md](POLICY.md).

## 4. Apply current policy and session limits

| Step | Current boundary |
|---|---|
| Setup policy choice | `--policy <level>` selects onboarding behavior; signed changes still require the owner's signing method. `ask` signs no delegation |
| Paired-machine propagation | Signed policy push/pull is implemented; verify the actual paired hosts and current revocations |
| Kill switch | `policy revoke --all` is signed and applies against stale replayed policy |
| Expiry and renewal | Setup uses 30 days for collaborate/autonomous and 8 hours for YOLO. Published 0.5.32 accepts owner-signed `--ttl never` at all actual levels, including YOLO; finite defaults/maxima apply when expiry is finite. D045 accepts refusing YOLO `never` and reporting existing records without revoking them, but T639 is pending. `policy renew` requires a signature; see [POLICY.md](POLICY.md#3-the-policy-record) |
| Expiry reminders | The daemon can notify the owner-key machine 48 hours before expiry; desktop notification availability remains an OS condition |
| Acting on peer requests | Owner-signed collaboration is implemented (T048); each message's current computed header supplies the applicable classes, scope, sender restrictions, and expiry |
| Permission approvals | Read/edit grants alone don't approve pushes or PRs. Eligible untainted `outward-reversible` grants cover non-default pushes/draft PRs; `permissions` enables YOLO through supported adapters. No message itself approves a prompt |
| Trust design | D044 isolation and taint-clearance choices are accepted design, with pending implementation slices; don't claim a shipped isolation boundary |

## 5. Preserve the boundaries

Same-user agents share the OS-user boundary. Policies limit authorized actions;
they don't sandbox a process or encrypt local mailbox data from the same user.
Body sealing protects host-to-host transport while metadata stays visible.
See [the threat model](THREAT-MODEL.md).

A provider with no hook/API for an action keeps its own behavior. AgentMBX
documents supported paths and visible gaps instead of claiming a universal wake,
restart, approval, or production-network guarantee.
