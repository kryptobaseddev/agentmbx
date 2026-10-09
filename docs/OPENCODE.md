# OpenCode: standalone vs service, and what AgentMBX can do with each

OpenCode 2.x can run its agent sessions in two kinds of server process, and AgentMBX behaves
differently with each. This page is for an AgentMBX user or admin deciding how to run OpenCode —
it assumes nothing about OpenCode internals beyond what setup wires and doctor checks.

## The two run modes

Both modes keep OpenCode's state in one shared `opencode.db`; what differs is which process runs
your session:

- **Shared service (`opencode serve --service`).** One long-lived service process hosts sessions.
  Its HTTP API is how outside tools reach a running session.
- **Standalone (`opencode --standalone`).** Each TUI session spawns its own private
  `opencode serve --stdio --port 0` process. Nothing outside that process can address the session:
  there is no HTTP endpoint to post to.

## What AgentMBX does in each mode

`agentmbx setup` installs the same things either way — the `mbx` MCP server entry in
`~/.config/opencode/opencode.jsonc` (with an explicit 30000 ms startup `timeout`, see
[INSTALL.md](INSTALL.md#appendix-what-setup-does-manual-configuration)), the hooks plugin at
`~/.config/opencode/plugins/agentmbx.ts`, and the sidebar plugin. Mail arrives identically in both
modes: the hooks surface new mail at the start of the session's next prompt.

Push delivery and wakes differ:

- **Service-hosted sessions can be pushed.** The daemon finds the session through the local
  `opencode serve --service` API and injects a note with
  `POST /api/session/{id}/synthetic` (`resume: true`), waking an idle session. The same channel
  answers the session's pending permission requests under an owner YOLO policy. The wake is
  receipt-verified: the daemon checks the service's answer names the exact session and payload.
- **Standalone sessions cannot be pushed — by design (T524).** The shared service's API can only
  act on sessions it hosts. Posting a synthetic message *with* resume to the service for a session
  a standalone serve hosts would make the service start a second agent loop on that session
  (duplicate assistant chains, double compactions, interleaved snapshots), so AgentMBX never does
  it: the daemon classifies which kind of serve recorded the binding, and for a standalone host it
  records `not_submitted` with no service call at all. The hooks plugin inside a standalone serve
  likewise never posts to the shared service. Until in-process delivery for standalone serves
  lands (T518/T519), a standalone session receives its mail at the next prompt like Kimi terminal
  sessions do.

If you need idle OpenCode sessions to wake on mail, run OpenCode against the shared service rather
than with `--standalone`.

## What doctor reports

- When an OpenCode mailbox binding exists, `agentmbx doctor` counts how many are service-hosted
  and how many standalone. It proves the service answers only when a service-hosted binding needs
  it (with the fix `run any opencode command (or opencode service start)` when it does not), and
  it says plainly that standalone bindings have "no push wake yet, next-prompt delivery only" —
  a fact, not a failure.
- The generic MCP rows apply too: doctor warns when the `mbx` entry's startup `timeout` is missing
  or under 30 s (`agentmbx setup --only opencode` repairs it), and fails when the configured node
  binary or script path is gone or resolves a different agentmbx version than the installed one.
