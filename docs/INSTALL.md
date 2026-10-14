# Installing AgentMBX on a machine

## Install and upgrade from npm

Install [Node.js 24 or newer](https://nodejs.org/en/download), then run:

```sh
npm install --global agentmbx@latest
agentmbx setup
agentmbx doctor
```

The public npm registry's `latest` dist-tag is the standard release. The same
install command upgrades an existing npm installation to that tag when you run it;
it doesn't create an automatic background upgrade.

```sh
npm view agentmbx@latest version    # published npm version
agentmbx version                  # installed version, installation kind, Node
npm install --global agentmbx@latest
agentmbx setup
agentmbx doctor
```

A source checkout or Git tag may be ahead of the published package. Don't use a
`main.tar.gz` URL or a hardcoded version as the default install path.

If a shell finds an older copy, inspect the active path:

```sh
command -v agentmbx
npm prefix --global
agentmbx version
```

On macOS and Linux, npm puts its executable in `<global-prefix>/bin`. Make that
directory available on PATH in the shell that starts your agent CLI; an older
`~/.local/bin/agentmbx` can otherwise take precedence. A Node version manager
avoids requiring administrator access for global npm packages. After changing
Node, the install location, or PATH, run setup again: it records absolute Node and
entry-script paths for MCP servers and hooks.

`agentmbx version --check`, `agentmbx update --check`, and the daemon's daily
update notice use the signed GitHub **binary release** manifest. They don't query
npm's dist-tag. On an npm installation, `agentmbx update` prints
`npm i -g agentmbx@latest`; it doesn't replace the npm package. Use `npm view`
and the npm install command above for npm release checks and upgrades.

## Optional standalone binary

For a machine without Node, the alternative installer downloads the platform's
self-contained binary to `~/.local/bin/agentmbx` and checks its SHA-256 against
the release manifest:

```sh
curl -fsSL https://agentmbx.com/install.sh | sh
agentmbx setup
agentmbx doctor
```

Binary upgrades use `agentmbx update`, which verifies the Ed25519-signed release
manifest and the asset checksum before replacing the binary and restarting its
daemon service. GitHub binary releases and npm publication are separate steps;
use the update path for the installation kind shown by `agentmbx version`.

## Configure the detected agent CLIs

Then restart your agent sessions so they load the `mbx` MCP server.

`agentmbx setup`:
1. Initializes this host if needed (host name: `scutil --get LocalHostName` on macOS, the hostname on Linux; override with `--host <name>`) and creates the host key.
2. Installs and starts the daemon (launchd on macOS, systemd `--user` on Linux).
3. Finds the agent CLIs on this machine (Claude Code, Codex, OpenCode, Kimi Code, Hermes, and Grok) and wires the MCP server and hooks into each.
4. Installs the `agentmbx` skill, which teaches any agent the mailbox loop and the trust rules.

It prints a table of every change. Every file it edits is first copied to `<file>.bak-agentmbx-<timestamp>`. Running it again preserves matching entries and refreshes AgentMBX-owned wiring when it has changed. Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | show what would change, write nothing |
| `--only claude,codex,opencode,kimi,hermes,grok,skill,daemon,owner` | limit it to some CLIs (or just the owner step) |
| `--no-owner` | skip the owner-key step |
| `--yes` | don't ask before writing |
| `--uninstall` | remove exactly what setup added (the daemon keeps running; `agentmbx daemon uninstall` stops it) |

### The owner key
The owner key is how **you**, not an agent, approve grants and policies. It only belongs on the machine you use. `agentmbx setup` has an owner step, and `agentmbx owner init` does the same on its own:
- **macOS with AgentMBX.app (the default there):** the key is created in your login Keychain by `AgentMBX.app/Contents/MacOS/agentmbx-auth`, and only that helper can read it. There is no passphrase. An agent may run `agentmbx setup` or `agentmbx owner init` for you: it tells you a Touch ID / password prompt is coming, and you approve it. Every owner signature after that (`owner grant`, `owner send`, `owner revoke`, policies) is one Touch ID tap, and the prompt text is written by the helper from exactly what is being signed, e.g. `Grant OWNER authority (task.assign) to planner@macbook, session 3f2a-…, for 12 hours`. An agent can start a request, but only you can approve it.
- **Linux, SSH sessions, or macOS without the app:** `agentmbx owner init` asks for a passphrase on the terminal (save it in a password manager), and each owner command asks for it again. Agents can't type it, so setup prints the exact command for you to run instead of failing. Force this backend on macOS with `agentmbx owner init --backend file`.

`agentmbx owner show` and `agentmbx doctor` show which backend holds the key. Macs without Touch ID (a Mac mini without a Touch ID keyboard, a VM) get the account-password prompt instead. Over SSH no prompt can appear, so the helper fails at once, setup prints the commands instead of waiting, and you can use `--backend file` there. With an ad-hoc signed app (a local build, or a release built without the signing certificate), rebuilding or updating the app changes its signature, and the next owner signature first shows a Keychain dialog asking to let `agentmbx-auth` use the item: choose Always Allow (once per update; denying it just means nothing is signed). To reset a Keychain owner key: `~/Applications/AgentMBX.app/Contents/MacOS/agentmbx-auth delete` (Touch ID), then remove `owner.json` from the mbx home.

### Mailbox identities
Every mailbox is an identity that an agent or you chose, with a role; AgentMBX never invents a name. A session
resumes the identity it held before (a resumed conversation) or the one its launch config names (`MBX_AGENT`, with
`MBX_ROLE`). Otherwise it starts without one and picks from `mbx_identity list` (this project's identities) or
registers a new name and role. Each identity has a **lease**: one live session per identity, one identity per
session. Mail and history survive lease transfers — reclaiming a name never loses messages. Sends
without a lease are labelled `unverified-sender` instead of silently trusted. Operators can inspect every
identity, its role, holder and recovery state with `agentmbx identity list [--project <dir>]`, retire mailboxes
older versions generated with `agentmbx identity prune`, and move a stranded mailbox's unread mail with
`agentmbx identity forward <from> <to>` (owner signature); replacing a live holder takes an owner
signature (`agentmbx identity takeover <name> --force …`, Touch ID / passphrase). Current connectors adopt a newly installed build on a subsequent tool call in the same conversation.
Check `mbx_whoami` for the actual connector version and identity. Older connectors may require a one-time
MCP reconnect; a CLI version alone doesn't prove that a long-running connector updated.

Start with `mbx_whoami`, then `mbx_inbox` once an identity is held. Read full messages with `mbx_read`
before acting on their current policy; reply in the thread and ACK only after handling the request.
Before ending the session, save any useful `mbx_handoff` references and release with `mbx_identity`.
A normal turn ending doesn't require release. See the [CLI and MCP reference](SPEC.md#mcp-tools) for
inputs, limits, and the distinction between history capture and acknowledgment.

On macOS, build the notifier app first if you want branded notifications (a clone or unpacked tarball; needs Xcode command line tools):
```sh
scripts/build-macos-app.sh      # build/AgentMBX.app; 'agentmbx daemon install' copies it to ~/Applications
agentmbx notify-test            # the first notification asks for permission
```
- With the app, notifications show "AgentMBX" and its icon. The launchd job runs through a launcher inside the app, so System Settings > General > Login Items lists it as AgentMBX instead of "node".
- Without it, `daemon install` still works and notifications use `osascript`.
- Re-run `agentmbx daemon install` after rebuilding or moving the app. `agentmbx daemon uninstall` stops the job and removes its plist.
- The build is ad-hoc signed, which is fine on the machine that built it. For distribution, see [RELEASING-macos.md](RELEASING-macos.md).

On Linux, notifications use `notify-send` (package `libnotify-bin` / `libnotify`).

On Linux with a firewall, open TCP 7373 to the LAN (e.g. `sudo firewall-cmd --add-port=7373/tcp --permanent && sudo firewall-cmd --reload`).

## Pairing two machines
1. Make sure both machines run the daemon (`agentmbx daemon install`).
2. On machine A, run `agentmbx pair`. It prints a one-time token (like `7K3M-QX9D-4HTR`, single use, valid 10 minutes; change with `--ttl 30m`, at most 1h) and the exact command for the other machine.
3. On machine B, run one of the printed lines, for example `agentmbx join laptop 7K3M-QX9D-4HTR` (found on the LAN by mDNS) or `agentmbx join laptop.local:7373 7K3M-QX9D-4HTR`.
4. Done: both machines are paired and show a "Paired with <host>" notification. There's no code to compare.

Prefer comparing codes instead? `agentmbx pair --compare <host>:7373`, check both screens show the same 6 digits, then `agentmbx pair approve <host> <code>` on both.

## Relay for offline peers
Paired hosts that can't reach each other over the LAN (different networks, NAT, a machine that's off) exchange
mail through an **untrusted store-and-forward relay**: it holds no host decryption keys, decides no agent authorization, and never
sees plaintext bodies — envelopes are sealed for the recipient before they leave the sender.
1. Run a relay on any always-on machine: `agentmbx relay serve --port 7374` (or `PORT`). It keeps its store and its
   signing key in `--store-dir` (default `~/.local/share/agentmbx-relay`, or `MBX_RELAY_DIR`): `relay.db` and
   `relay.key` (mode 0600). Back them up together; the relay refuses to start with a key that isn't its store's. The
   startup line prints the store epoch and the key fingerprint. Hosted deployments can inject the key instead:
   `agentmbx relay keygen` prints `MBX_RELAY_KEY=<base64 private key>` (store it as a secret) and the fingerprint;
   when `MBX_RELAY_KEY` is set it wins over `relay.key`. Behind a proxy add `--trust-proxy` (Railway: the rightmost
   X-Forwarded-For hop) or `MBX_RELAY_TRUST_PROXY=cloudflare` (behind Cloudflare: CF-Connecting-IP) so enrolment rate
   limits see client addresses. One relay process per store: `relay serve` holds `relay.lock` while it runs.
   **Backups:** `agentmbx relay backup <file> --store-dir <dir>` takes a consistent online copy while the relay runs
   and prints a receipt (sha256, epoch, counts). To restore, stop the relay and run
   `agentmbx relay restore <file> --store-dir <dir>`: it rotates the epoch (senders re-push what the recipient has not
   confirmed, receivers re-pull; nothing arrives twice), keeps every revocation and newer signed allowlist the store
   had, keeps the replaced store under `rollback/`, and prints the command that undoes it. A hosted relay restores at
   start with `MBX_RELAY_RESTORE_FROM=<backup on the volume>` (each path once; unset it afterwards). `agentmbx relay log` lists
   every receipt: backups, restores, epoch rotations and retention sweeps. After restoring the store any way other
   than `agentmbx relay restore` (a volume snapshot, a file copy), run `agentmbx relay rotate-epoch --store-dir <dir>`
   (a copy older than 10 minutes rotates at start by itself). Mail queued by 0.5.5 and newer daemons expires after 14
   days and its sender gets an "Undelivered to <host>" alert; mail from older (v1) daemons is kept until collected. The runbook is in [relay-durability.md §5.2](spec/relay-durability.md#52-runbook-t167).
2. Point each daemon at it and pin the relay key: `agentmbx relay set http://<relay-host>:7374 --key <fingerprint>`
   (the fingerprint the relay printed at startup), then restart the daemon using its service manager:
   `launchctl kickstart -k gui/$(id -u)/com.agentmbx.daemon` on macOS, or
   `systemctl --user restart agentmbx` on Linux. With `--key` the daemon uses the relay only while it
   serves exactly that key; a mismatch changes nothing and exits 1. Without `--key` the command pins the key the relay
   serves now and prints its fingerprint for you to compare. If the relay's key later changes, relay use stops and
   `agentmbx doctor` says so until you confirm the new key with `relay set <url> --key <new fingerprint>`.
3. That's it: mail to unreachable peers flows through the relay and is pulled by the peer; `agentmbx doctor`
   reports the pinned relay key, enrolment, why relay mail waits (a refused enrolment, a peer without a valid
   encryption key ad) and how many messages are queued. A relay problem never drops queued mail silently: the sender is alerted.

The self-hosted relay's default authority enrolls hosts through their existing host keys, with per-owner
quotas; paired-host trust still comes from host pairing. A hosted service can use an account-bound enrollment
authority. `agentmbx login` runs the device authorization flow against the accounts service; it doesn't pair
hosts or by itself prove that a particular hosted relay enrollment has completed. See [SPEC.md](SPEC.md#relay-protocol-untrusted-store-and-forward-adr-035) and the threat model
in [adr-035](adr/adr-035-cloud-architecture-threat-model.md).

Why this is safe: the token never crosses the network. Each side proves it knows the token with an HMAC over both machines' host keys and owner keys, so something in the middle can't swap in its own keys. Five wrong attempts burn the token. Anyone who sees the token before it's used could pair with A, so don't paste it anywhere shared.

`agentmbx discover` lists AgentMBX machines the daemon's mDNS advertisement reached, with their key fingerprints and whether they're paired. Discovery only finds addresses; trust still comes from the token. If multicast is blocked (some Wi-Fi networks, VPNs), `discover` shows nothing and you use the `host:port` or IP form. On Linux, the daemon shares UDP 5353 with avahi (both use `SO_REUSEADDR`); if a firewall is on, also allow mDNS (`sudo firewall-cmd --add-service=mdns --permanent`). Set `MBX_NO_MDNS=1` to turn advertising off.

**Manual alternative, comparing a code:** run `agentmbx pair --compare other-host.local:7373` on one machine. It prints a 6-digit code, and the other machine shows the same code (`agentmbx peers` there, or its `daemon.log`). If the codes match, approve on both machines with `agentmbx pair approve <other-host> <code>`. If they differ, don't approve; something is intercepting the connection.

Remove a pairing with `agentmbx peers remove <host>`.

## The master agent (owner authority)
1. Start the session you want as master, with mbx configured.
2. Run (on macOS an agent may run it for you; the Touch ID prompt is yours to approve):
   `agentmbx owner grant <agent> --caps task.assign,decision --ttl 12h`
3. It lists the live sessions for that agent (pick one with `--session <fp>` if there are several). Approve the Touch ID prompt, or type the owner passphrase on Linux, and that session's messages carry `authority: OWNER` for 12 hours or until it exits.
4. Other sessions, even ones using the same agent name, cannot use the grant.

## Files
`~/.local/share/agentmbx/` (override with `MBX_HOME`) contains:
- `config.json`: host name, port, bind address
- `host.key`: the host's signing key (0600)
- `owner.json` (macOS Keychain backend): the backend and the owner public key; the private key stays in the login Keychain. Only on the owner's machine.
- `owner.key` (file backend): the owner key, encrypted with the passphrase. Only on the owner's machine.
- `mbx.db`: messages, deliveries, peers, grants, audit log
- `daemon.log`

## Appendix: what setup does (manual configuration)

Every CLI runs the same stdio server, `agentmbx mcp`, registered under the server name `mbx`. Setup writes an absolute command line — the absolute path of the node binary running setup, plus the absolute, symlink-resolved path of the `agentmbx` entry script (`command = <node>`, `args = [<script>, "mcp"]`). The mise/asdf shim is deliberately not used: a mise upgrade or node pin rewrites or removes the shim and breaks every harness at once, while node + script stays valid as long as the install directory does. A single-binary (SEA) install has no node and registers just the binary. `agentmbx doctor` fails the row when that node binary or script path no longer exists, or when the script's package version differs from this install (a stale path, or a second older install the harness would actually start); the fix is `agentmbx setup --only <cli>`. The examples below say `agentmbx` for short.

Setup also writes an explicit MCP startup timeout (at least 30 s) in every harness whose config format has such a field. Cold starts sit close to the harness defaults (OpenCode connects in ~2.2 s against a 5000 ms default), so the timeout is written out rather than left implicit:

| CLI | Field | Value written |
|---|---|---|
| Codex | `startup_timeout_sec` (seconds) | `30` |
| OpenCode | `"timeout"` as `{ "startup", "catalog" }` (milliseconds) | `30000` each |
| Hermes | `connect_timeout` (seconds) | `60` |
| Grok | `startup_timeout_sec` (seconds) | `30` |
| Claude, Kimi | none in their MCP config shape — nothing written | — |

`agentmbx doctor` warns (never fails) when a wired entry has no startup timeout or one under 30 s; `agentmbx setup --only <cli>` repairs the line. A config an older setup wrote stays "wired" in the meantime. A session's identity is `MBX_AGENT` (with `MBX_ROLE`) if set, otherwise the identity it held before; a new session without either claims or registers one with `mbx_identity` (it is never named after its folder). An agent can rename itself with `mbx_whoami`.

Setup appends its own hook groups and never modifies or removes hook groups that other tools (Orca, for example) own.

### Claude Code
- MCP: `claude mcp add --scope user mbx -- agentmbx mcp` (setup edits `mcpServers.mbx` in `~/.claude.json` directly when the `claude` command isn't on PATH).
- Hooks, appended to `~/.claude/settings.json`. Mail then shows up at the start of your next prompt:
```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "agentmbx hook session-start --cli claude", "timeout": 10 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agentmbx hook prompt --cli claude", "timeout": 10 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "agentmbx hook permission --cli claude", "timeout": 10 }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "agentmbx hook stop --cli claude", "timeout": 10 }] }],
  "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "agentmbx hook post-tool --cli claude", "timeout": 10 }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "agentmbx hook session-end --cli claude", "timeout": 10 }] }]
}
```
- The `PermissionRequest` hook evaluates owner-signed policy. The `permissions` class enables YOLO; an eligible untainted `outward-reversible` grant can approve a bounded non-default-branch push or draft PR. Read/edit grants alone don't approve those actions. See [POLICY.md](POLICY.md).
- A plainly started Claude session wakes through its own MCP server and Claude's per-session inbox socket when supported. No channel flag or cron is required for this path.
- `agentmbx claude [args]` starts Claude with the optional mbx channel instead. This research-preview channel path requires Claude's own startup confirmation and a claude.ai login.
- Setup normally uses bundled hook scripts for its fast path. The JSON above shows equivalent direct commands for manual configuration; keep other tools' hook groups intact.
- Put `MBX_AGENT` and `MBX_ROLE` in the project's `.mcp.json` `env` if you want a fixed identity for every session there (one session at a time holds it).

### Codex
In `~/.codex/config.toml`:
```toml
[mcp_servers.mbx]
command = "agentmbx"
args = ["mcp"]
default_tools_approval_mode = "approve"   # applies only to this MCP server's mailbox tools
startup_timeout_sec = 30                  # codex aborts an MCP whose startup exceeds this
```
In `~/.codex/hooks.json`, a SessionStart group running `agentmbx hook session-start --cli codex`, a UserPromptSubmit group running `agentmbx hook prompt --cli codex`, and a PermissionRequest group running `agentmbx hook permission --cli codex`, and a Stop group running `agentmbx hook stop --cli codex` (same JSON shape as Claude's).
- The SessionStart hook binds the session's thread id, which is what lets the daemon wake an idle Codex session through `codex queue`.
- Codex may ask you to review and trust new hooks the next time it starts.

### OpenCode
In `~/.config/opencode/opencode.jsonc` (or `opencode.json`), under `mcp.servers`. Setup inserts this one line and keeps your comments and formatting:
```jsonc
"mbx": { "type": "local", "command": ["<node>", "<agentmbx script>", "mcp"], "timeout": { "startup": 30000, "catalog": 30000 } }
```
- OpenCode 2.0 rejects a plain numeric `timeout` and skips the whole `mbx` entry, so its MCP tools disappear. Setup therefore writes the object form above and rewrites a number an older setup wrote in place (T541); `agentmbx doctor` warns, with `agentmbx setup --only opencode`, while the field is still a number. `command` is the absolute node binary plus the absolute `agentmbx` script, as for every CLI (see above).
- If `opencode service` is running, setup restarts it so it picks up the server.
- OpenCode 2.x runs sessions two ways: a shared `opencode serve --service` process, or a private `opencode serve --stdio` that every `opencode --standalone` TUI spawns (both share one `opencode.db`). Hook notes go into the session in-process in both modes. A wake reaches a service-hosted session through `POST /api/session/{id}/synthetic` on the shared service, and a standalone session through the plugin inside its own serve, which long-polls the daemon's loopback queue (`/v1/opencode-wake`) and admits the text in-process; AgentMBX never posts to the shared service for a standalone session. Whether a standalone wake starts a turn on an idle session is unproven (T544). See [OPENCODE.md](OPENCODE.md) for what to expect from each mode.
- If OpenCode asks before each mbx tool call, allow `mbx_*` in its permission settings. See the [testing guide](TESTING.md).

**Hooks** are a plugin module, `~/.config/opencode/plugins/agentmbx.ts` (OpenCode has no settings-file hooks), translating OpenCode's `session.created`, `tool.execute.after` and session-idle events onto the shared `agentmbx hook` contract.

**Sidebar** (v0.5.18+): the same setup run installs a packaged TUI plugin that renders this session's AgentMBX status — identity, unread and needs-reply counts — in the OpenCode sidebar, refreshed from the daemon's loopback status endpoint at most every 5 s. It lives in `~/.config/opencode/plugins/agentmbx-sidebar/` (`package.json`, `server.ts`, `status-schema.ts`, `tui.ts`) and is registered by one line in `~/.config/opencode/tui.json`:
```jsonc
{ "plugin": ["/Users/you/.config/opencode/plugins/agentmbx-sidebar"] }
```
(the array entry is the absolute directory path). It needs the daemon of v0.5.17 or newer (the `/v1/status` schema the plugin reads); with an older daemon the sidebar shows `mbx ?`. Use `agentmbx setup --dry-run --only opencode` to preview this wiring, then `agentmbx setup --only opencode` to install it. `agentmbx setup --uninstall --only opencode` removes its own registration and files, preserving other plugins and TUI configuration. Files whose only difference from the template is the agentmbx release version are left untouched by setup and still count as wired to doctor.

### Kimi Code
Kimi's data directory is `$KIMI_CODE_HOME`, by default `~/.kimi-code`.
- MCP: `~/.kimi-code/mcp.json`:
```json
{ "mcpServers": { "mbx": { "command": "agentmbx", "args": ["mcp"] } } }
```
- Hooks: appended to `~/.kimi-code/config.toml` inside a marked block, so uninstall can find it:
```toml
# >>> agentmbx (managed by agentmbx setup; remove with: agentmbx setup --uninstall) >>>
[[hooks]]
event = "SessionStart"
command = "agentmbx hook session-start --cli kimi"
timeout = 10
[[hooks]]
event = "UserPromptSubmit"
command = "agentmbx hook prompt --cli kimi"
timeout = 10
[[hooks]]
event = "PermissionRequest"
command = "agentmbx hook permission --cli kimi"
timeout = 10
# Stop hooks continue handling authorized unread mail before the turn ends.
[[hooks]]
event = "Stop"
command = "agentmbx hook stop --cli kimi"
timeout = 10
# <<< agentmbx <<<
```
- Terminal Kimi accepts no push from outside, so the session wakes itself: it keeps one background task running `agentmbx watch` (the prompt hook and the skill ask it to). The task exits with a no-body hint when mail that wants the session arrives, and Kimi starts a turn from the task's completion. `MBX_SELF_WATCH=<minutes>` asks for a `[mbx-watch]` CronCreate self-check instead.
- `kimi web` / `kimi rc`: woken through the server's prompts API. A server reads its hooks once at start, so restart one that was started before `agentmbx setup` (`agentmbx doctor` flags it). A conversation in manual approval mode asks before every mbx tool call: allow `mbx_*` so mail handling isn't blocked.
- Kimi desktop app: it keeps a private Kimi Code home, so `agentmbx setup` (with the app running) installs AgentMBX into it as a native Kimi plugin (mbx MCP server and hooks). Conversations are woken through the app's local control socket. Run `agentmbx setup --only kimi` again after an app reinstall.
- Hosted conversations (web and desktop) share one app process, so each links itself to its own mbx server once: its first prompt carries a one-time bind ticket for `mbx_whoami`.

### Hermes
If `~/.hermes/config.yaml` exists, setup adds:
```yaml
mcp_servers:
  mbx:
    command: "agentmbx"
    args: ["mcp"]
    connect_timeout: 60
```
Restart Hermes to load it. Its tools then appear as `mcp_mbx_*`.
- Setup also writes `on_session_start` and `pre_llm_call` shell hooks in this YAML file and records their exact approvals in `~/.hermes/shell-hooks-allowlist.json`. Hermes loads them for sessions started after setup.
- Keep one `agentmbx watch` background terminal task running with `background=true, notify=true`. It exits with a no-body inbox hint when mail needs attention; Hermes starts a turn from the completion notification. Handle the mail and start the watcher again. Finishing a turn without re-arming it leaves no idle push path.
- This covers a terminal/TUI session with an exact session binding. A multi-session Hermes gateway or desktop host isn't covered by that watcher guarantee.

### Grok

Setup recognizes Grok and honors `GROK_HOME` (default `~/.grok`). It maintains
`[mcp_servers.mbx]`, the optional `[ui.status_line]` segment, and SessionStart,
UserPromptSubmit, PostToolUse, and Stop hooks in `config.toml`, preserving other
configuration. The MCP startup timeout is `startup_timeout_sec = 30`.

Keep an `agentmbx watch --cli grok --session <id>` background task armed for idle
mail, then re-arm it after handling each completion. Exact session IDs prevent a
sibling conversation's mailbox from being used.

### Owner policy and permission prompts
A message body never approves a permission prompt. Permission adapters use signed policy and the caller's verified session context. A bounded `outward-reversible` grant can approve a non-default-branch push or a draft PR while the session is untainted; merging, release, deployment, secrets, and spend aren't included. See [POLICY.md](POLICY.md) for restrictions.

When an owner policy gives an agent the `permissions` class ([POLICY.md](POLICY.md) §5), that agent's sessions approve their own permission prompts until the policy expires. With no such policy nothing changes. Every approval is written to the audit log as `yolo_allow`. How each CLI does it (evidence in [RESEARCH.md](RESEARCH.md), "Permission hooks per CLI"):
- **Claude Code** and **Codex**: the `PermissionRequest` hook above answers `allow`. Deny rules still win. Claude never auto-answers `AskUserQuestion` or `ExitPlanMode`, since those are questions for you. Codex asks you to trust the new hook once.
- **OpenCode**: no hook; the daemon asks the local `opencode service` for the pending permission requests of each bound session and replies `once`. A session is covered when the mbx MCP server has bound it (an exact provider session id and a live process; a project folder never stands in for it), its agent holds an active `permissions` policy, and the service is running. The daemon does not check which kind of serve hosts the session, and whether the service can see a standalone serve's (`opencode --standalone`) pending requests has not been verified — see [OPENCODE.md](OPENCODE.md).
- **Kimi Code**: Kimi's hooks can't approve. The `PermissionRequest` hook approves through the `kimi web` server, so it only works for sessions that server runs (`kimi web`, `kimi rc`, the Kimi desktop app). A plain `kimi` terminal session keeps prompting. For a hands-off Kimi agent there, start it with Kimi's own flag instead: `kimi --yolo` (routine edits and commands run; risky actions still ask) or `kimi --auto` (never asks). These flags ignore mbx policies, so use them only where you'd accept that.

### The skill
Setup copies `skill/` from the package to `~/.agents/skills/agentmbx/` and symlinks it into `~/.claude/skills/` and `~/.codex/skills/` when those folders exist. Other CLIs that read Agent Skills can point at the same folder.
