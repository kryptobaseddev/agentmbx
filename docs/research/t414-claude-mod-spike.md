# T414 spike — the Claude Code mod API surface (Claude Code 2.1.291)

Date: 2026-10-07. The mod lives in `plugins/claude/` on `feat/t401-claude-mod` (draft #143, taken
over from Grok). This note is the spike record of the mods API the mod actually uses, for T415
(full mod) and T416 (setup wiring).

## The sandbox (hard constraints, validated by test)

- A hooks module may import **nothing but relative files and the `claude-code` package**; Node
  built-ins are unavailable (`node:*`, `process`, `child_process` are all absent). The mod is
  therefore pure JS with zero imports (`test/claude-mod.test.ts` asserts the source shape).
- All host I/O goes through the `$` facade passed to hooks: `$.env.get(name)`,
  `$.clock.now()`, `$.http.fetch(url)`, `$.command.register(...)`, `$.ui.resolve(event)`.
  `claude plugin validate` statically inspects the module, so `$` stays on the top-level hook
  functions and every `$.*` call uses a string literal it can see.
- No documented fetch timeout: the mod must degrade, not hang — every failure path renders
  `mbx: unavailable` (or `unbound`) and never throws into the host.

## Session identity

`session.start` delivers only `{ cwd }` — no session id. The binary sets `CLAUDE_CODE_SESSION_ID`
on the process and substitutes `${CLAUDE_SESSION_ID}`; the mod reads both with `$.env.get` and
treats both-missing as `unbound` (it never guesses from cwd or ppid — T308 AC2).

## Hooks used

| Hook | Use |
| --- | --- |
| `session.start` | registers the `/mbx-status` command (`$.command.register`) and passes through |
| `command.run` `{ command: "mbx-status" }` | answers with the current band text — a `/command` that runs without a Claude turn (T414 AC2) |
| `ui.render` `{ component: "AbovePrompt" }` | draws the status band above the prompt via `$.ui.resolve(e)` → `Text({ children: [text] })`; defers to `next(e)` when the host marks the slot taken (`hasSurvey`) or on any error |

## The status read (T414 AC1)

`statusRequestUrl(sessionId)` is `GET http://127.0.0.1:7373/v1/status?cli=claude&session=<id>&schema=mbx.status/v2`
— the **same v2 snapshot the OpenCode sidebar reads** (T407 endpoint, #157). The origin and path
are pinned inside the function; only the session id crosses as a query value (URL-encoded by
`URL.searchParams`), and a constructed URL that leaves the local daemon throws.

`renderStatus(sessionId, snapshot)` is pure and read-only: v2 `inbox` counts (v1 flat counts
tolerated for daemons older than v0.5.17), policy from `harness.policy` (v1: top-level `policy`),
`unbound` for missing/unknown, `ambiguous` without naming candidates. The band text is cached for
2 s per session id (`$.clock.now` in production, injectable in tests); the cache key is the
session id, so one session's snapshot is never reused for another.

## Fixtures and evidence

- `test/fixtures/status-v2-bound.json` (main, T431) is the shared v2 contract fixture;
  `plugins/claude/fixtures/v2-bound.json` is byte-identical to it (asserted in the test), and the
  v1 fixtures stay for the v1-tolerance path. Unbound and ambiguous cases render explicitly.
- Evidence is fixture renders + tests; nothing installs into the owner's `~/.claude`.

## Known limits for T415/T416

- The band renders one text block; a richer layout (separating identity, inbox, cloud) is T415.
- Setup/install wiring (`agentmbx setup --only claude-mod` or equivalent) is T416 and needs
  `src/setup.ts`, currently unheld.
- Live verification in a real Claude Code session (band visible above the prompt) is the T415
  acceptance; the render path is fully covered by tests here.
