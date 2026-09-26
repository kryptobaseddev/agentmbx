# Installing mbx on a machine

Requires Node 24 or later. The examples assume the repo is at `~/projects/mbx` and that `~/.local/bin` is on your `PATH`.

```sh
cd ~/projects/mbx && npm install
ln -sfn ~/projects/mbx/bin/mbx.js ~/.local/bin/mbx3     # "mbx3" while the old v2 `mbx` bash tool is still in use
mbx3 init --host macbook                                 # host name others will see; creates the host key
mbx3 owner init                                          # ONLY on the machine the owner uses; asks for a passphrase (save it in Bitwarden)
mbx3 daemon install                                      # launchd (macOS) or systemd --user (Linux): LAN endpoint, retries, wake-ups
```

## Pairing two machines
1. Make sure both machines run the daemon (`mbx3 daemon install`).
2. On one of them, run `mbx3 pair other-host.local:7373`. It prints a 6-digit code.
3. The other machine shows the same code: run `mbx3 peers` there, or look at `~/.local/share/mbx/daemon.log`.
4. If the codes match, approve on both machines: `mbx3 pair approve <other-host> <code>`.

If the codes differ, don't approve; something is intercepting the connection. Remove a pairing with `mbx3 peers remove <host>`.

## Adding mbx to each agent CLI
Every CLI runs the same stdio server: `mbx mcp`. Set `MBX_AGENT` to the agent name. If you leave it out, the name defaults to the project folder name.

### Claude Code
```sh
claude mcp add --scope user mbx -- node ~/projects/mbx/bin/mbx.js mcp
```
- Put `MBX_AGENT` in the project's `.mcp.json` `env` if you want a fixed name.
- **To let messages wake an idle session**, start Claude with the mbx channel:
  `claude --dangerously-load-development-channels server:mbx`
  - Claude asks for confirmation at startup.
  - This is a research-preview feature. It needs a claude.ai login.
- **Without the channel**, add the hooks below. Mail then shows up at the start of your next prompt:
```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node ~/projects/mbx/bin/mbx.js hook session-start --cli claude" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node ~/projects/mbx/bin/mbx.js hook prompt --cli claude" }] }]
}
```

### Codex
In `~/.codex/config.toml`:
```toml
[mcp_servers.mbx]
command = "node"
args = ["/Users/<you>/projects/mbx/bin/mbx.js", "mcp"]
default_tools_approval_mode = "approve"   # mbx tools only send/read mail; otherwise every send asks for approval
```
In `~/.codex/hooks.json`, add a SessionStart hook: `node ~/projects/mbx/bin/mbx.js hook session-start --cli codex`.
- It binds the session's thread id, which is what lets the daemon wake an idle Codex session through `codex queue`.
- Leave Orca's hook entries alone.

### OpenCode
In `~/.config/opencode/opencode.jsonc`, under `mcp.servers`:
```jsonc
"mbx": { "type": "local", "command": ["node", "/Users/<you>/projects/mbx/bin/mbx.js", "mcp"] }
```
- The daemon finds the session by project folder through the local `opencode service`. It wakes it with `POST /api/session/{id}/synthetic`.
- If OpenCode asks before each mbx tool call, allow `mbx_*` in its permission settings. See the e2e notes in `docs/TESTING.md`.

### Kimi Code
Add the same MCP server to Kimi's MCP config. Add a UserPromptSubmit hook with `mbx hook prompt --cli kimi`; Kimi prints plain text into the context.
- Kimi's TUI accepts no push from outside, so an idle Kimi session only sees mail when its user next types.
- For hands-off agents: ask the Kimi session to create a CronCreate job that checks `mbx_inbox` every few minutes, or run it under `kimi web`.

### Hermes
Add it under `mcp_servers` in `~/.hermes/config.yaml`.
- For wake-ups, the plan is a small Hermes plugin that calls `ctx.inject_message`. Until that exists, use a Hermes cron job that checks `mbx_inbox`.

## The master agent (owner authority)
1. Start the session you want as master, with mbx configured.
2. In your own terminal (not through an agent), run:
   `mbx3 owner grant <agent> --caps task.assign,decision --ttl 12h`
3. It lists the live sessions for that agent. Pick one, type the owner passphrase, and that session's messages carry `authority: OWNER` for 12 hours or until it exits.
4. Other sessions, even ones using the same agent name, cannot use the grant.

## Files
`~/.local/share/mbx/` (override with `MBX_HOME`) contains:
- `config.json`: host name, port, bind address
- `host.key`: the host's signing key (0600)
- `owner.key`: the owner key, encrypted with the passphrase. Only on the owner's machine.
- `mbx.db`: messages, deliveries, peers, grants, audit log
- `daemon.log`
