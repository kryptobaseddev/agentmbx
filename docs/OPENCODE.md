# OpenCode: standalone vs service, and what AgentMBX can do with each

OpenCode 2.x can run its agent sessions in two kinds of server process, and AgentMBX reaches them
by different paths. This page is for an AgentMBX user or admin deciding how to run OpenCode — it
assumes nothing about OpenCode internals beyond what setup wires and doctor checks.

## The two run modes

Both modes keep OpenCode's state in one shared `opencode.db`; what differs is which process runs
your session:

- **Shared service (`opencode serve --service`).** One long-lived service process hosts sessions.
  Its HTTP API is how outside tools reach a running session.
- **Standalone (`opencode --standalone`).** Each TUI session spawns its own private
  `opencode serve --stdio --port 0` process. Nothing outside that process can address the session:
  there is no HTTP endpoint to post to.

AgentMBX tells them apart from the process that hosts the mailbox binding. The binding records the
pid of the serve the plugin runs in. The daemon walks up from that pid (through at most a few
`node` or `bun` hops) to the first `opencode` process and reads its arguments: `--service` without
`--stdio` is **service-hosted**; any other `opencode` is **standalone**. If the pid is missing, the
process table cannot be read, or the chain hits anything that is not `node`, `bun` or `opencode`,
the host is **unknown**.

## What AgentMBX does in each mode

`agentmbx setup` installs the same things either way — the `mbx` MCP server entry in
`~/.config/opencode/opencode.jsonc` (with an explicit 30000 ms startup `timeout`, see
[INSTALL.md](INSTALL.md#appendix-what-setup-does-manual-configuration)), the hooks plugin at
`~/.config/opencode/plugins/agentmbx.ts`, and the sidebar plugin. Two separate paths then carry mail
into a session, and they are not the same in the two modes:

| | Service-hosted | Standalone |
|---|---|---|
| **Hook notes** (the plugin turns a hook's "you have mail" reason into a message in the session) | in-process, through the serve the plugin runs in | in-process, through the serve the plugin runs in |
| **Wake** (the daemon pushes a mailbox message at an idle session) | the daemon posts directly to the shared service | the daemon hands the text to the plugin through a loopback queue; the plugin admits it in-process |

A binding whose host is unknown is treated as neither: the daemon does not wake it and does not call
the service. AgentMBX never posts to the shared service for a session the service does not host. A synthetic
message with `resume: true` posted to the service for a session that a standalone serve hosts makes
the service start a second agent loop on that session (duplicate assistant chains, double
compactions, interleaved snapshots), so AgentMBX never sends one (T524).

### Hook notes (both modes)

The plugin runs `agentmbx hook <event> --cli opencode` on session start, session idle and after each
tool call. When the hook answers with a reason, the plugin admits it through the session API of the
serve it is already inside: `ctx.session.synthetic`, or `ctx.session.prompt` when `synthetic` is
missing or fails, with `resume: false` and `delivery: "queue"` (T518). `resume: false` admits the note
without starting a turn; `queue` waits for the current turn to finish rather than steering it. The
message id is a hash of the session, hook and text, so a retry of the same note is one admission.
The plugin does not look up or call the shared service for notes. If the host offers neither
`synthetic` nor `prompt`, nothing is admitted; the failure is silent, because hooks never surface
errors in the OpenCode TUI.

### Wake: service-hosted session

The daemon finds the service through `opencode service status` (or `MBX_OPENCODE_URL`) and reads
its password from `~/.config/opencode/service.json`. It posts
`POST /api/session/{id}/synthetic` with `{text, delivery: "queue", resume: true}`, which wakes an
idle session. The wake is receipt-verified: the daemon checks that the service's answer names the
exact session, the `synthetic` type, the `queue` delivery and the same text, and that it carries a
`msg_` id and a creation time. The same service API also answers the session's pending permission
requests under an owner YOLO policy. If the service is not running, the wake is `not_submitted`
(`unavailable`) and doctor says how to start it.

### Wake: standalone session (T519)

There is no endpoint to post to, so the plugin inside the serve comes to the daemon instead:

1. After its first hook event for a session, the plugin starts one long-poll per session:
   `GET http://127.0.0.1:<port>/v1/opencode-wake?session=<id>&pid=<serve pid>`. The port is
   `MBX_PORT`, default 7373. The endpoint answers loopback callers only and needs no host key.
2. The daemon holds the request for up to 20 s. With nothing to deliver it answers `204` and the
   plugin polls again after 200 ms. After a network error or a non-OK answer the plugin waits 1 s.
   The plugin keeps polling for as long as its serve process lives.
3. When a wake is due, the daemon offers the text to the poll whose `pid` equals the binding's pid.
   A poll from any other pid, or none, receives nothing.
4. The plugin admits the text with `ctx.session.synthetic` (`resume: false`, `delivery: "queue"`)
   and posts the `msg_` id the host returned back to `POST /v1/opencode-wake`. The daemon accepts
   only a `msg_` receipt, and only for a wake it has offered.
5. The daemon records the wake as admitted with that native id, state `queued`.

If no plugin is polling for the session, nothing is submitted: the wake is `not_submitted` with no
target, the shared service is not called, and the service starts no turn and takes no snapshot. If
the plugin took the text but no `msg_` receipt arrived within 5 s, the outcome is `unknown`
(`lost-response`) and the daemon does **not** post the same text to the service as a fallback.

### What the daemon records for a wake

| Host | Situation | Outcome |
|---|---|---|
| service | service answered with a matching receipt | `admitted` (native `msg_` id) |
| service | service not running / request never sent | `not_submitted` (`unavailable`) |
| service | wake authority changed before the send | `not_submitted` (`fenced`) |
| service | timeout, lost answer or a receipt that does not match | `unknown` (never resubmitted blindly) |
| service | service answered with an error status | `failed` |
| standalone | plugin admitted it and returned a `msg_` id | `admitted` (native `msg_` id) |
| standalone | plugin took the text, no receipt in 5 s | `unknown` (`lost-response`) |
| standalone | no plugin polling for this session | `not_submitted` (no target) |
| unknown | any | `not_submitted` (no target) |

`admitted` means the host accepted the message and returned its own `msg_` id. It is not evidence
that the model ran or handled it.

## Which mode should I run?

- **You need an idle session to wake on mail, and want the strongest evidence.** Run OpenCode
  against the shared service. That is the path the live end-to-end script
  (`scripts/e2e/wake-opencode.py`) and [RESEARCH.md](RESEARCH.md) record as waking an idle session
  with no human present. It posts `resume: true`, the flag the plugin's own comments say makes an
  admission wake the session.
- **You run `--standalone`.** Mail still reaches the session, through hook notes and through wakes
  admitted in-process with a native receipt. Two limits apply. The wake poll only starts after the
  plugin has seen a hook event for that session, and it needs the AgentMBX daemon running on the
  same machine. And because an in-process wake is admitted with `resume: false`, AgentMBX has
  verified that OpenCode accepted and queued it, but no test or live check shows that an idle
  standalone session starts a turn because of it. Treat a standalone wake as delivery to the
  session's queue, not as a guaranteed turn.

## What doctor reports

- When an OpenCode mailbox binding exists, `agentmbx doctor` counts how many are service-hosted
  and how many are not. Bindings whose host is unknown are counted with the standalone ones. It
  proves the service answers only when a service-hosted binding needs it (with the fix `run any
  opencode command (or opencode service start)` when it does not).
- For the others it prints "no push wake yet, next-prompt delivery only" — a fact about what doctor
  checks, not a failure. That wording predates T519. Doctor does not look at the loopback queue, so
  it cannot say whether a standalone plugin is polling; a standalone session with a polling plugin
  is wakeable as described above.
- The generic MCP rows apply too: doctor warns when the `mbx` entry's startup `timeout` is missing
  or under 30 s (`agentmbx setup --only opencode` repairs it), and fails when the configured node
  binary or script path is gone or resolves a different agentmbx version than the installed one.

## Where this lives in the code

| Behaviour | Code |
|---|---|
| Service vs standalone vs unknown | `opencodeHostOf`, `isOpencodeServiceArgv` in `src/opencode-provider.ts` |
| Wake dispatch and the outcomes above | `wakeOpencode` in `src/wake.ts` |
| Loopback queue, receipt, 20 s hold, 5 s receipt wait | `src/opencode-wake-queue.ts`; the `/v1/opencode-wake` route in `src/http.ts` |
| Hook notes, wake poll, plugin template | `opencodePluginSource` in `src/setup.ts` (`inject`, `admitWake`, `watchWake`) |
| Doctor's OpenCode row | `opencodeServiceCheck` in `src/doctor.ts` |
