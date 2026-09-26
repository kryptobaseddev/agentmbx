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
| `--only claude,codex,opencode,kimi,hermes,skill` | limit it to some CLIs |
| `--yes` | don't ask before writing |
| `--uninstall` | remove exactly what setup added (the daemon keeps running; `agentmbx daemon uninstall` stops it) |

The owner key is separate, and only belongs on the machine the owner uses: `agentmbx owner init` asks for a passphrase (save it in a password manager).

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

Why this is safe: the token never crosses the network. Each side proves it knows the token with an HMAC over both machines' host keys and owner keys, so something in the middle can't swap in its own keys. Five wrong attempts burn the token. Anyone who sees the token before it's used could pair with A, so don't paste it anywhere shared.

`agentmbx discover` lists AgentMBX machines the daemon's mDNS advertisement reached, with their key fingerprints and whether they're paired. Discovery only finds addresses; trust still comes from the token. If multicast is blocked (some Wi-Fi networks, VPNs), `discover` shows nothing and you use the `host:port` or IP form. On Linux, the daemon shares UDP 5353 with avahi (both use `SO_REUSEADDR`); if a firewall is on, also allow mDNS (`sudo firewall-cmd --add-service=mdns --permanent`). Set `MBX_NO_MDNS=1` to turn advertising off.

**Manual alternative, comparing a code:** run `agentmbx pair --compare other-host.local:7373` on one machine. It prints a 6-digit code, and the other machine shows the same code (`agentmbx peers` there, or its `daemon.log`). If the codes match, approve on both machines with `agentmbx pair approve <other-host> <code>`. If they differ, don't approve; something is intercepting the connection.

Remove a pairing with `agentmbx peers remove <host>`.

## The master agent (owner authority)
1. Start the session you want as master, with mbx configured.
2. In your own terminal (not through an agent), run:
   `agentmbx owner grant <agent> --caps task.assign,decision --ttl 12h`
3. It lists the live sessions for that agent. Pick one, type the owner passphrase, and that session's messages carry `authority: OWNER` for 12 hours or until it exits.
4. Other sessions, even ones using the same agent name, cannot use the grant.

## Files
`~/.local/share/agentmbx/` (override with `MBX_HOME`) contains:
- `config.json`: host name, port, bind address
- `host.key`: the host's signing key (0600)
- `owner.key`: the owner key, encrypted with the passphrase. Only on the owner's machine.
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
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agentmbx hook prompt --cli claude", "timeout": 10 }] }]
}
```
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
In `~/.codex/hooks.json`, a SessionStart group running `agentmbx hook session-start --cli codex` and a UserPromptSubmit group running `agentmbx hook prompt --cli codex` (same JSON shape as Claude's).
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
# <<< agentmbx <<<
```
- Kimi's TUI accepts no push from outside, so an idle Kimi session only sees mail when its user next types.
- For hands-off agents: ask the Kimi session to create a CronCreate job that checks `mbx_inbox` every few minutes, or run it under `kimi web`.

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

### The skill
Setup copies `skill/` from the package to `~/.agents/skills/agentmbx/` and symlinks it into `~/.claude/skills/` and `~/.codex/skills/` when those folders exist. Other CLIs that read Agent Skills can point at the same folder.
