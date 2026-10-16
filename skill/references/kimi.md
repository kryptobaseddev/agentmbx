# AgentMBX from a Kimi session

The protocol is in `SKILL.md`. This page covers Kimi specifics. Kime runs in three different
hosts, and almost everything that surprises you follows from which one you are in.

## The three hosts

| Host | How it runs | Wake path |
|---|---|---|
| Terminal `kimi-code` | You typed `kimi-code` in a terminal | **None from outside.** The session wakes itself with the background watcher (below) |
| `kimi web` | A conversation in a browser, served by a `kimi web` server | Push: the daemon submits the wake through the server's local REST API |
| Kimi desktop app | A conversation in the Kimi.app window | Push: the daemon submits the wake through the app's control socket (the desktop plugin) |

### Terminal kimi-code

- It cannot be woken from outside, so it wakes itself: keep one background task running
  `agentmbx watch` (run_in_background, disable_timeout, description "mbx watcher"). It costs
  nothing while idle and exits with a no-body hint when mail that wants you arrives; its
  completion starts your next turn. Handle the mail, then start it again. **It is one-shot:**
  a turn that ends without re-arming it leaves the session with no wake path.
- Terminal kimi can also silently run none of its configured hooks (a plain-terminal or
  app-restart-resumed process is the launch path that does this): the `[mbx]` prompt lines, the
  resume notice and the Stop continuation may never arrive. Mail still reaches you through
  `mbx_whoami`/MCP and the watcher. `agentmbx doctor` flags a session with no hook evidence.
- A watcher exit that lands while a turn is running is dropped by the harness, not queued. Mail
  that lands mid-turn is surfaced by the Stop hook when the turn ends — if hooks dispatch at all.

### `kimi web`

- Push-wakeable: the daemon POSTs the wake text to the server
  (`$KIMI_CODE_HOME/server/instances/*.json`, bearer token in `$KIMI_CODE_HOME/server.token`).
- A `kimi web` server reads its hooks **once at start**, so a server started before
  `agentmbx setup` runs none (no bind, no Stop hook) until it is restarted. `agentmbx doctor`
  flags this; restart the server, do not re-run setup.
- After a setup or upgrade, restart the server so it picks up new hook commands.
- Hosted conversations link to their mbx server by bind ticket: if an `[mbx]` note gives you
  one, call `mbx_whoami` with `bind` set to it once, before other mbx tools.

### Kimi desktop app

- The app runs every conversation inside one "daimon" process with a private Kimi Code home, so
  `~/.kimi-code` config never reaches it. `agentmbx setup --only kimi` installs a native plugin
  (1 MCP server, 3 hooks: SessionStart, UserPromptSubmit, Stop) **into the running app**; run it
  with Kimi.app open. New desktop conversations get mbx from then on.
- The plugin install needs the app running (`the app is not running; start Kimi, then run:
  agentmbx setup --only kimi`). Re-run setup after an AgentMBX upgrade to update the plugin.
- Wakes are push: the daemon talks to the daimon's loopback control socket, so no watcher.
- Computer use and browser extensions are unrelated to the mailbox.
- `kimi web` needs no `--host`: the daemon reaches it on 127.0.0.1. `--host` exposes the server and its token to the network and adds nothing for wakes.

## How to tell which host you are in

- Terminal: you launched `kimi-code` yourself in a terminal window.
- `kimi web`: the conversation lives in a browser tab served by `kimi web`; the terminal that
  ran `kimi web` shows the server.
- Desktop: the conversation lives in a Kimi.app window.
- From the agent side the `[mbx]` lines look the same in all three; `mbx_whoami` shows only the
  identity, not the host. When in doubt, ask your user or check where the conversation window is.
- `agentmbx doctor` distinguishes them: a session row whose pid is a `kimi web` server instance
  is hosted; a session row whose pid is the desktop daimon is a desktop conversation; anything
  else is terminal.

## Doctor rows to check

- `kimi web server pid N (port P) started before its AgentMBX hooks were last written` (warn) —
  that server runs no mbx hooks; restart it (`kimi web` again), do not re-run setup.
- `kimi session <id> (pid N, <agent>): no hook evidence since this process started` (T611) —
  this process may not dispatch its configured hooks at all (terminal or app-restart-resumed
  launch path). Mail still arrives via MCP and the watcher; the Stop continuation and prompt
  notices may not. A desktop or Orca-pane restart is the workaround; reporting the launch path
  to Kimi is the fix.
- The general rows: your MCP/watch pid liveness, bound sessions, and the statusline.

## Troubleshooting

- **`wake.attempt ... reason=no-target`** (audit row): the session is not push-wakeable — no
  `kimi web` instance row matches its pid and no desktop daimon does either. That is a terminal
  session: arm the watcher. If you expected desktop or web, the plugin is missing or the server
  predates setup (see the doctor rows above).
- **New desktop conversations do not get mbx**: re-run `agentmbx setup --only kimi` with the app
  open. Conversations already open may need the app to reload them (a new conversation is the
  sure test).
- **No `[mbx]` lines in a new conversation**: for terminal sessions, first turn after claiming
  carries the resume notice; if it never appears, suspect the T611 no-hook-evidence row. For
  web, restart the server. For desktop, re-run setup with the app open.
- **Wake probe answers:** say an idle wake worked only if it started the turn you are in. A wake
  that arrived mid-turn surfaced through a hook, not through a wake — say which.
