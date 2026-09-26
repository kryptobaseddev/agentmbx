# Installing AgentMBX on a machine

```sh
curl -fsSL https://agentmbx.com/install.sh | sh   # single binary in ~/.local/bin, sha256-verified; no Node needed
#   fallback: curl -fsSL https://raw.githubusercontent.com/kryptobaseddev/agentmbx/main/install.sh | sh
#   or with Node >= 24: npm install -g https://github.com/kryptobaseddev/agentmbx/archive/refs/heads/main.tar.gz
agentmbx init --host laptop                      # host name others will see; creates the host key
agentmbx owner init                              # ONLY on the machine the owner uses; asks for a passphrase (save it in a password manager)
agentmbx daemon install                          # launchd (macOS) or systemd --user (Linux): LAN endpoint, retries, wake-ups
```

Update later with `agentmbx update` (binary installs; checks the Ed25519-signed release manifest and the sha256 of the
download, then restarts the daemon). npm and source installs print the command to run instead.

On Linux with a firewall, open TCP 7373 to the LAN (e.g. `sudo firewall-cmd --add-port=7373/tcp --permanent && sudo firewall-cmd --reload`).

## Pairing two machines
1. Make sure both machines run the daemon (`agentmbx daemon install`).
2. On one of them, run `agentmbx pair other-host.local:7373`. It prints a 6-digit code.
3. The other machine shows the same code: run `agentmbx peers` there, or look at `~/.local/share/mbx/daemon.log`.
4. If the codes match, approve on both machines: `agentmbx pair approve <other-host> <code>`.

If the codes differ, don't approve; something is intercepting the connection. Remove a pairing with `agentmbx peers remove <host>`.

## Adding mbx to each agent CLI
Every CLI runs the same stdio server: `agentmbx mcp` (registered under the server name `mbx`). Set `MBX_AGENT` to the agent name. If you leave it out, the name defaults to the project folder name.

### Claude Code
```sh
claude mcp add --scope user mbx -- agentmbx mcp
```
- Put `MBX_AGENT` in the project's `.mcp.json` `env` if you want a fixed name.
- **To let messages wake an idle session**, start Claude with the mbx channel:
  `claude --dangerously-load-development-channels server:mbx`
  - Claude asks for confirmation at startup.
  - This is a research-preview feature. It needs a claude.ai login.
- **Without the channel**, add the hooks below. Mail then shows up at the start of your next prompt:
```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "agentmbx hook session-start --cli claude" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agentmbx hook prompt --cli claude" }] }]
}
```

### Codex
In `~/.codex/config.toml`:
```toml
[mcp_servers.mbx]
command = "agentmbx"
args = ["mcp"]
default_tools_approval_mode = "approve"   # mbx tools only send/read mail; otherwise every send asks for approval
```
In `~/.codex/hooks.json`, add a SessionStart hook: `agentmbx hook session-start --cli codex`.
- It binds the session's thread id, which is what lets the daemon wake an idle Codex session through `codex queue`.
- Leave Orca's hook entries alone.

### OpenCode
In `~/.config/opencode/opencode.jsonc`, under `mcp.servers`:
```jsonc
"mbx": { "type": "local", "command": ["agentmbx", "mcp"] }
```
- The daemon finds the session by project folder through the local `opencode service`. It wakes it with `POST /api/session/{id}/synthetic`.
- If OpenCode asks before each mbx tool call, allow `mbx_*` in its permission settings. See the e2e notes in `docs/TESTING.md`.

### Kimi Code
Add the same MCP server to Kimi's MCP config. Add a UserPromptSubmit hook with `agentmbx hook prompt --cli kimi`; Kimi prints plain text into the context.
- Kimi's TUI accepts no push from outside, so an idle Kimi session only sees mail when its user next types.
- For hands-off agents: ask the Kimi session to create a CronCreate job that checks `mbx_inbox` every few minutes, or run it under `kimi web`.

### Hermes
Add it under `mcp_servers` in `~/.hermes/config.yaml`.
- For wake-ups, the plan is a small Hermes plugin that calls `ctx.inject_message`. Until that exists, use a Hermes cron job that checks `mbx_inbox`.

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
