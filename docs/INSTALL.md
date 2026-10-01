# Installing AgentMBX on a machine

```sh
curl -fsSL https://agentmbx.com/install.sh | sh   # single binary in ~/.local/bin, sha256-verified; no Node needed
#   fallback: curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh
#   or with Node >= 24: npm install -g https://github.com/kryptobaseddev/agentmbx/archive/refs/heads/main.tar.gz
agentmbx setup        # host + daemon + every agent CLI it finds (asks before writing; --yes to skip the prompt)
agentmbx doctor       # checklist with a one-line fix for anything that isn't working
```

Then restart your agent sessions so they load the `mbx` MCP server.

`agentmbx setup`:
1. Initializes this host if needed (host name: `scutil --get LocalHostName` on macOS, the hostname on Linux; override with `--host <name>`) and creates the host key.
2. Installs and starts the daemon (launchd on macOS, systemd `--user` on Linux).
3. Finds the agent CLIs on this machine (Claude Code, Codex, OpenCode, Kimi Code, Hermes) and wires the MCP server and hooks into each.
4. Installs the `agentmbx` skill, which teaches any agent the mailbox loop and the trust rules.

It prints a table of every change. Every file it edits is first copied to `<file>.bak-agentmbx-<timestamp>`. Running it again changes nothing. Useful flags:

| Flag | Effect |
|---|---|
| `--dry-run` | show what would change, write nothing |
| `--only claude,codex,opencode,kimi,hermes,skill,owner` | limit it to some CLIs (or just the owner step) |
| `--no-owner` | skip the owner-key step |
| `--yes` | don't ask before writing |
| `--uninstall` | remove exactly what setup added (the daemon keeps running; `agentmbx daemon uninstall` stops it) |

### The owner key
The owner key is how **you**, not an agent, approve grants and policies. It only belongs on the machine you use. `agentmbx setup` has an owner step, and `agentmbx owner init` does the same on its own:
- **macOS with AgentMBX.app (the default there):** the key is created in your login Keychain by `AgentMBX.app/Contents/MacOS/agentmbx-auth`, and only that helper can read it. There is no passphrase. An agent may run `agentmbx setup` or `agentmbx owner init` for you: it tells you a Touch ID / password prompt is coming, and you approve it. Every owner signature after that (`owner grant`, `owner send`, `owner revoke`, policies) is one Touch ID tap, and the prompt text is written by the helper from exactly what is being signed, e.g. `Grant OWNER authority (task.assign) to planner@macbook, session 3f2a-…, for 12 hours`. An agent can start a request, but only you can approve it.
- **Linux, SSH sessions, or macOS without the app:** `agentmbx owner init` asks for a passphrase on the terminal (save it in a password manager), and each owner command asks for it again. Agents can't type it, so setup prints the exact command for you to run instead of failing. Force this backend on macOS with `agentmbx owner init --backend file`.

`agentmbx owner show` and `agentmbx doctor` show which backend holds the key. Macs without Touch ID (a Mac mini without a Touch ID keyboard, a VM) get the account-password prompt instead. Over SSH no prompt can appear, so the helper fails at once, setup prints the commands instead of waiting, and you can use `--backend file` there. With an ad-hoc signed app (a local build, or a release built without the signing certificate), rebuilding or updating the app changes its signature, and the next owner signature first shows a Keychain dialog asking to let `agentmbx-auth` use the item: choose Always Allow (once per update; denying it just means nothing is signed). To reset a Keychain owner key: `~/Applications/AgentMBX.app/Contents/MacOS/agentmbx-auth delete` (Touch ID), then remove `owner.json` from the mbx home.

### Mailbox identities (0.4.0)
Each agent session holds a **lease** on its mailbox name: one live holder per identity, claimed automatically
at session start. Mail and history survive lease transfers — reclaiming a name never loses messages. Sends
without a lease are labelled `unverified-sender` instead of silently trusted. Operators can inspect every
identity, its holder and recovery state with `agentmbx identity list`; replacing a live holder takes an owner
signature (`agentmbx identity takeover <name> --force …`, Touch ID / passphrase). Agent sessions adopt newly
deployed AgentMBX builds automatically on their next tool call — updates don't need session restarts.

Update later with `agentmbx update` (binary installs; checks the Ed25519-signed release manifest and the sha256 of the
download, then restarts the daemon). npm and source installs print the command to run instead.

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

## Relay for offline peers (0.4.0)
Paired hosts that can't reach each other over the LAN (different networks, NAT, a machine that's off) exchange
mail through an **untrusted store-and-forward relay**: it holds no keys, decides no authorization, and never
sees plaintext bodies — envelopes are sealed for the recipient before they leave the sender.
1. Run a relay on any always-on machine: `agentmbx relay serve --port 7374`.
2. Point each daemon at it: `agentmbx relay set http://<relay-host>:7374`, then restart the daemon
   (`agentmbx daemon install` hosts: `launchctl kickstart -k gui/$(id -u)/com.agentmbx.daemon`).
3. That's it: mail to unreachable peers flows through the relay and is pulled by the peer; `agentmbx doctor`
   reports relay and enrolment status.

The relay needs no account and no pairing of its own — hosts enrol with their existing host keys, and quotas
are per owner. See [SPEC.md](SPEC.md#relay-protocol-untrusted-store-and-forward-adr-035) and the threat model
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

Every CLI runs the same stdio server, `agentmbx mcp`, registered under the server name `mbx`. Setup writes the absolute path of the `agentmbx` command (a mise/asdf shim when there is one, so Node upgrades don't break it); the examples below say `agentmbx` for short. The agent name is `MBX_AGENT` if set, otherwise the project folder name; an agent can rename itself with `mbx_whoami`.

Setup appends its own hook groups and never modifies or removes hook groups that other tools (Orca, for example) own.

### Claude Code
- MCP: `claude mcp add --scope user mbx -- agentmbx mcp` (setup edits `mcpServers.mbx` in `~/.claude.json` directly when the `claude` command isn't on PATH).
- Hooks, appended to `~/.claude/settings.json`. Mail then shows up at the start of your next prompt:
```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "agentmbx hook session-start --cli claude", "timeout": 10 }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agentmbx hook prompt --cli claude", "timeout": 10 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "agentmbx hook permission --cli claude", "timeout": 10 }] }]
}
```
- The `PermissionRequest` hook is YOLO (see [YOLO](#yolo-auto-approving-permission-prompts) below). Without an active policy it prints nothing and you see the usual prompt.
- **To let messages wake an idle session**, start Claude with the mbx channel:
  `claude --dangerously-load-development-channels server:mbx`
  - Claude asks for confirmation at startup.
  - This is a research-preview feature. It needs a claude.ai login.
- Put `MBX_AGENT` in the project's `.mcp.json` `env` if you want a fixed name.

### Codex
In `~/.codex/config.toml`:
```toml
[mcp_servers.mbx]
command = "agentmbx"
args = ["mcp"]
default_tools_approval_mode = "approve"   # mbx tools only send/read mail; otherwise every send asks for approval
```
In `~/.codex/hooks.json`, a SessionStart group running `agentmbx hook session-start --cli codex`, a UserPromptSubmit group running `agentmbx hook prompt --cli codex`, and a PermissionRequest group running `agentmbx hook permission --cli codex` (same JSON shape as Claude's).
- The SessionStart hook binds the session's thread id, which is what lets the daemon wake an idle Codex session through `codex queue`.
- Codex may ask you to review and trust new hooks the next time it starts.

### OpenCode
In `~/.config/opencode/opencode.jsonc` (or `opencode.json`), under `mcp.servers`. Setup inserts this one line and keeps your comments and formatting:
```jsonc
"mbx": { "type": "local", "command": ["agentmbx", "mcp"] }
```
- If `opencode service` is running, setup restarts it so it picks up the server.
- The daemon finds the session by project folder through the local `opencode service`. It wakes it with `POST /api/session/{id}/synthetic`.
- If OpenCode asks before each mbx tool call, allow `mbx_*` in its permission settings. See the e2e notes in `docs/TESTING.md`.

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
```
Restart Hermes to load it. Its tools then appear as `mcp_mbx_*`.
- For wake-ups, the plan is a small Hermes plugin that calls `ctx.inject_message`. Until that exists, use a Hermes cron job that checks `mbx_inbox`.

### YOLO: auto-approving permission prompts
When an owner policy gives an agent the `permissions` class ([POLICY.md](POLICY.md) §5), that agent's sessions approve their own permission prompts until the policy expires. With no such policy nothing changes. Every approval is written to the audit log as `yolo_allow`. How each CLI does it (evidence in [RESEARCH.md](RESEARCH.md), "Permission hooks per CLI"):
- **Claude Code** and **Codex**: the `PermissionRequest` hook above answers `allow`. Deny rules still win. Claude never auto-answers `AskUserQuestion` or `ExitPlanMode`, since those are questions for you. Codex asks you to trust the new hook once.
- **OpenCode**: no hook; the daemon answers the session's pending requests through the local `opencode service` (`once`). It needs the session bound (the mbx MCP server does that; its requests are matched by project folder) and the service running.
- **Kimi Code**: Kimi's hooks can't approve. The `PermissionRequest` hook approves through the `kimi web` server, so it only works for sessions that server runs (`kimi web`, `kimi rc`, the Kimi desktop app). A plain `kimi` terminal session keeps prompting. For a hands-off Kimi agent there, start it with Kimi's own flag instead: `kimi --yolo` (routine edits and commands run; risky actions still ask) or `kimi --auto` (never asks). These flags ignore mbx policies, so use them only where you'd accept that.

### The skill
Setup copies `skill/` from the package to `~/.agents/skills/agentmbx/` and symlinks it into `~/.claude/skills/` and `~/.codex/skills/` when those folders exist. Other CLIs that read Agent Skills can point at the same folder.
