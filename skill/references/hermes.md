# AgentMBX from a Hermes session

The protocol is in `SKILL.md`. This page covers Hermes specifics. Hermes cannot push a turn into an idle
session, and most of what follows comes from that.

## Joining

1. Call `mbx_whoami`. If it shows `agent: null` with `cli: hermes`, the session has no identity yet.
2. Call `mbx_identity {"action":"list"}`.
   - If there is a released identity with role `hermes`, claim it.
   - Otherwise register the name your user gave you. The default is `<project>-hermes`, with role `hermes`.
3. Arm the watcher (next section) in the same turn as your first send, before you wait for a reply.
4. `agentmbx identity list --project <dir>` may show `held by live hermes session mcp-<pid>`.
   - That id is provisional. A bound hook replaces it with Hermes's own id (`YYYYMMDD_HHMMSS_<6 hex>`) on your next turn.
   - If `agentmbx doctor` still reports `0 real session ID(s)` for hermes after that, the binding failed. Report it.
   - The `session` field in `mbx_whoami` is a key fingerprint, not a Hermes id. The Hermes id is `harness_session`.

## Waking an idle session: the background watcher

Run this from the project directory:

```
terminal(command="cd <project> && agentmbx watch", background=true, notify=true)
```

When mail that wants you arrives, the watcher prints `[mbx] N new message(s) … (ids …)` and exits. Hermes then opens a
new turn with that output wrapped in `[IMPORTANT: Background process … completed …]`.

The ids are pointers, not instructions. `mbx_read` them.

- **The watcher is one-shot.** Re-arm it in every wake turn, and before you end any turn in which you expect mail. A turn
  that ends without a live watcher leaves the session with no wake path, so a reply will sit unseen until your user
  prompts you.
- **Check before arming.** `ps -axo pid,etime,command | grep 'agentmbx watch'` lists the watchers of every session,
  including other agents in the same directory.
  - Yours is the one whose parent is the Hermes gateway: `ps -o ppid= -p <pid>`.
  - Do not start a second watcher.
- **Read the whole inbox on every wake.** The ids in the hint are not the whole unread list, so run `mbx_inbox`.
  - Rows in state `notified` are new.
  - Rows in state `read` you have already seen.
  - The `[mbx] N unread` banner counts unacked mail, not unseen mail. Ack what you have handled.
- **A late completion notice** can name mail you already handled (an old watcher exiting, or another background command
  finishing). Check the ids against what you have acked and confirm your current watcher is alive. Take no other action.
- **A watcher that exits during a turn starts no new turn.** Hermes queues the completion until the turn ends, so mail
  that lands mid-turn is seen only after it.
  - Re-arm right after reading a wake, before any long work.
  - After a long tool call, poll the watcher's process to see whether it has already exited.
- **The `(eval):1: can't change option: zle` lines** at the top of the output come from Hermes's `zsh -lic` wrapper. They
  are harmless.
- **`[mbx-watch] stopped: no current identity lease`** (exit 1) means the session lost its lease. It does not mean mail
  arrived.
  - Check with `mbx_whoami`, claim the identity again, then re-arm.
  - Hermes respawns its mbx server when `~/.hermes/config.yaml` is rewritten. That releases the lease.
  - An in-place build handover reclaims the lease by itself within about a second. A watcher started before such a
    handover exits with `the lease this watcher was started for moved to another holder`.
  - Never kill either mbx process. Arm a new watcher.
- **Answering a wake probe.** Say an idle wake worked only if a watcher exit started the turn you are in.
  - `~/.hermes/logs/agent.log` shows what started each turn: `grep 'conversation turn' … | tail`.
  - `[IMPORTANT: Background process … agentmbx watch` means the watcher started it.
  - A probe that landed mid-turn is not an idle wake. Say so.
- **Gateway and desktop hosts** that serve many sessions in one process are not covered by this.

## What you see when a conversation starts or resumes

A Hermes hook adds `[mbx]` lines to your turn input. They are not stored in `~/.hermes/state.db`.

- **First turn of a new conversation**, `/new`, `/resume`, or compression: the first turn after you hold your identity
  carries a short resume notice, once. It contains:
  - your identity and role;
  - the `mbx_catchup` hint;
  - the number of open threads with unacked mail.
- **After a full restart** (`hermes --resume <id>`):
  - The first turn says `[mbx] Resuming <name>@<host>: this session's mailbox server is still connecting. Call mbx_whoami …`.
    The new mbx server takes back the identity this conversation held on your first mbx call.
  - Call `mbx_whoami` first. Do not claim or register.
  - The resume notice follows on the next turn, which can be a watcher wake.
- **A turn whose model request failed** still counts as having shown the notice.
- **`mbx_whoami` shows `pending`:** the identity is still held by an older process of this session. It resumes when that
  process ends. Do not register a substitute.

## Hooks

`agentmbx setup` wires two Hermes shell hooks in `~/.hermes/config.yaml`.

- **`on_session_start`** runs on the first turn of a new conversation only. Hermes skips it on `/resume` and
  `hermes --resume`, because it fires only where a system prompt is built.
- **`pre_llm_call`** runs once per turn, including turns that a watcher completion starts. Its
  `{"context": …}` output is the only way a shell hook can add text to the model's input.
- **No post-tool or Stop equivalent.** Hermes has neither, so mail that arrives mid-turn is seen on the next turn.

**Consent decides whether a wired hook runs.** Each `(event, command)` pair must be approved, and the approvals are
stored in `~/.hermes/shell-hooks-allowlist.json`.
- The TUI skips an unapproved hook silently. The config is written and nothing runs.
- `hermes hooks list` shows the approval state and is read-only.
- `hermes hooks doctor` and `hermes hooks test` run the hooks on synthetic payloads. They write advisory rows into the
  live mbx store.
- `agentmbx doctor` reports wired and approved as separate rows.

**Hermes logs a hook only when it exits non-zero.** Judge whether a hook ran from its effects: the `[mbx]` lines in your
input, the `sessions` row, and `kv` rows such as `resume-entry:hermes:<gateway pid>` and `session-hint:hermes:<gateway pid>`.

**Side agents** (`/background`, `/btw`, previews, delegated subagents, cron) run in the same process and fire the same
hooks. The hooks bind and inject only for the user's own `tui`/`cli` conversation.

Never run `hermes`, or import its bootstrap, with `HERMES_HOME` pointed at a scratch directory. Hermes treats that
directory as a fresh install and rewrites the real install's launchers.
