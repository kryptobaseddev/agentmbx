# Agent workflow for contributors

This is how an AI agent implements a task in this repository when a lead coordinates the work over AgentMBX. It covers
the repository rules learned from earlier tasks: worktrees, gates, sequencing, test fixtures and how to report.

How to use AgentMBX itself is in `skill/SKILL.md`. Test suites and live checks are in [`docs/TESTING.md`](../TESTING.md).
Release validation of one harness is in [`docs/harness-validation-recipe.md`](../harness-validation-recipe.md).

## Roles and limits

- **Who does what.** The lead assigns a task by mail with the files you own. You plan, wait for approval, implement,
  commit locally and report the commit SHA with the gate results. The lead pushes, opens the PR and merges.
- **Plan first.**
  - A task that says "design only" or "evidence only" edits no repo files.
  - Edit only the files on the approved list. Ask before you touch any other file.
- **Push, PR, merge and release belong to the lead** unless the message grants `outward`.
- **Never rewrite history on a task branch,** even one that isn't pushed.
  - No rebase, and no `--amend` after you have reported a SHA.
  - Bring in main with `git merge`, and land review fixes as new commits.

## Worktree setup

- **Create a worktree outside the shared checkout:**
  `git fetch origin && git worktree add -b <branch> <path> origin/main`, then `git branch --unset-upstream`.
  - Never `git checkout <ref>` in the shared checkout. It detaches the branch other sessions use; if it happens, run
    `git checkout main` at once.
  - To read code at another commit, use `git show <ref>:<path>`.
- **Dependencies:** a fresh worktree has no `node_modules`. Either symlink the main checkout's (`ln -s <main>/node_modules
  node_modules`; `.gitignore` covers it) or run `npm ci --include=dev`.
  - With `NODE_ENV=production` exported, plain `npm ci` omits devDependencies, and `npx tsc` then prints "This is not the
    tsc command you are looking for".
- **Commit identity:** commit with the repository's configured identity. Don't pass `-c user.name=…`.
- **Staging:** stage with explicit pathspecs (`git add src test skill dist CHANGELOG.md`). Keep scratch scripts outside
  the worktree.
- **Removing a worktree:** only after `git branch -r --contains <sha>` shows your commit on a remote branch and
  `git status` is clean.

## Gates

Report the exact command and the `ℹ tests/pass/fail/skipped/todo` counts for each gate. Say plainly which gates you did
not run.

- **Typecheck:** `npx tsc --noEmit`. It covers `test/` as well, so a new required field shows up in hand-written test
  fixtures here first.
- **Built output:** `dist/` is tracked. `npm run check-dist` builds, then runs `git diff --exit-code -- dist`.
  - Commit the rebuilt `dist/` with the `src/` change that produced it.
  - Unstaged rebuilt files make `check-dist` exit 1 even when the build is right.
  - A comment-only `src` edit leaves `dist` unchanged.
  - Read the exit code directly; piping through `tail` hides it.
- **One test file:**
  `AGENTMBX_DEV=1 node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit test/<file>.test.ts`.
  - With `AGENTMBX_DEV=1`, tests run `src/*.ts` directly, not `dist/`.
  - Always pass a literal path. A shell variable that expanded to nothing makes `node --test` run the whole directory.
- **Related suites:** run every suite that asserts the behaviour you changed. When you change what a hook or tool says,
  `grep -ln` the test tree for both the old and the new text (and the function name), and add every match to the run.
  The hook suites alone miss resume and binding suites that assert the start-of-session line.
- **Full suite:** `npm test`, once, on the finished tree. It takes 10 to 20 minutes.
  - Run it in the background with its own log file, and record `git rev-parse --short HEAD`, the dirty count and
    `uptime` at the top of the log.
  - Don't edit `src/` or `test/` while it runs. To keep working, run it from a detached worktree of the commit you will
    report.
  - Kill only processes you started, by pid. Check for leftover `node --test` children afterwards.
- **CHANGELOG:** one line under `## Unreleased`. Every commit subject carries the task id.
- **Delivery-query ratchet (T493):** any new SQL that touches `deliveries` (`FROM|JOIN|INTO|UPDATE deliveries`) in `src/`
  fails `test/project-mailbox.test.ts` until it is classified in `RATCHET`. Run that file whenever you add such a query.
- **A new MCP tool needs three things:**
  - its name in the exact tool list in `test/mcp.test.ts`;
  - an entry in the args map in `test/store-version.test.ts`;
  - a description ending with `Next: …`. The description contract in `test/mcp.test.ts` checks this.
- **Running gates in a script:** zsh does not word-split `$VAR`, so put multi-command runs in a bash script with arrays
  (`R=(env X=1 node --test …)`, then `"${R[@]}"`). Node test diagnostics print as `ℹ <text>`.

### Reading a failure before calling it unrelated

- **A `✖` under "failing tests" with exit 0 can be a `todo` subtest.** CI's `gh run view --log-failed` lists those too,
  with `actual: undefined`. Before calling it pre-existing:
  - check the cited line for `{ todo: … }`;
  - check that `gh run list --branch main` is green, or run the file with your change stashed.
- **One timing failure on a loaded host is not a verdict.**
  - Check `uptime`.
  - Run that file alone several times, on your tree and on `origin/main` in a detached worktree.
  - Compare the numbers the test prints with `t.diagnostic`.
  - Report the ranges and the load instead of rerunning until it goes green.

### Proving a test can fail

- **A regression test must fail on the old code.** Revert the `src` hunk (or stash it), run the test and show the
  failure message, then restore.
- **For new behaviour, use a mutation script** kept outside the repo. For each mutation it:
  - replaces one anchor that occurs exactly once (and reports a bad anchor otherwise);
  - runs the test files;
  - restores the source and prints red or green.

  Write one mutation per acceptance criterion and per security property. Add one no-op mutation as a control that must
  stay green.
- **When a mutation survives,** it is either a test gap (add the case and rerun only that mutation), an equivalent mutant
  (say why), or a redundant layer (show that a joint mutant removing both layers goes red).
- **Don't build, commit or start other suites** in that worktree while a mutation run holds a change in `src/`.
  Afterwards, confirm `git diff --stat -- src dist` is empty.

## Sequencing around in-flight work

- **Before editing,** list what open PRs touch: `gh pr view <n> --json files,state,headRefName`.
- **If a new task must edit files an in-flight PR also edits,** branch from that PR's branch and commit only the new work,
  so the lead can retarget the branch to main once the base merges.
- **When the lead pushes a commit onto your branch** (for example a CHANGELOG fix):
  - With no local commits of your own: `git fetch origin && git reset --hard origin/<branch>`, then build on that.
  - With local commits: merge the remote branch instead.
- **When main moves,** `git merge --no-commit --no-ff origin/main` shows conflicts before you commit. Then run:
  - `tsc`, `npm run build` and `check-dist`;
  - `git diff --check`;
  - the landed work's own suites together with yours, since a clean text merge can still break behaviour.
- **A hunk in a file another agent owns waits for the lead's word.** You can prepare it as a patch in a throwaway
  worktree, check it with `git apply --check`, and apply it after the merge.

## Changing behaviour or guidance

- **Guidance exists in several copies:** the server instructions, tool descriptions, `skill/SKILL.md` (served as
  `mbx://guide`), the README and `docs/spec`.
  - Grep the exact phrase across `src skill README.md docs` and move every copy together.
  - Pin the copy the server actually serves in a test.
- **Before turning an error into a result (or the reverse),** list every state that reaches that code path and decide each
  one. Existing tests that assert `isError` for neighbouring states say which must stay errors.
- **Before changing a tool's output,** grep the tests for the tool name. Existing assertions are the compatibility
  contract.
- **When a test you don't own fails after your change,** decide which side is right from the test's own later steps.
  - If the scenario goes on to reclaim the identity, "Resuming" is right and "claim or register" was the wrong guidance.
  - Change only that scenario's expectation, and show the updated test fails on the old source.
  - Ask the lead before narrowing your design to avoid an assertion.
- **A surface that lists other identities** (a roster, a directory, a ledger) is built from an explicit field list.
  Spreading a status object into a row leaks another identity's counts.
- **Extending a stored or signed record:** strict parsers in an older, still-running build drop records that gain a key.
  - Add new data in additive nullable columns or as a separate signed blob.
  - Pin backward compatibility in a test.
  - Audit a use where the decision commits, not inside a lookup.
- **A new kind of row in a table whose key has always meant an identity:** classify every query that enumerates that
  column before writing code, and guard the enumerators.

## Hook work for a CLI

- **Model a new installer on an existing one** that edits the same file format.
  - Text-edit; never parse and rewrite the user's file.
  - Recognise ours by its exact command; leave foreign and composed commands alone.
  - Uninstall must be byte-exact.
- **Check whether the CLI also requires approval** before a configured hook runs (Hermes does). Setup and doctor must
  report wired, approved, and wired-but-not-approved separately.
- **A hook that binds a session or injects context must first classify the caller,** and do nothing for side agents,
  subagents and non-interactive platforms.
- **Read stdin to EOF robustly.** Some harnesses send the whole conversation, well over 64 KiB. At least one test should
  drive the hook through an async `spawn` with a large payload and assert its effect, since `spawnSync({ input })` hides
  stdin bugs.

## Test fixture notes

- **Spawning `agentmbx mcp` in a test:** the child needs isolated `HOME`, `XDG_*` and `MBX_HOME`. Delete the inherited
  `MBX_MCP_REEXEC*`, `MBX_MCP_DETACHED`, `MBX_MCP_PROVIDER_PID`, `MBX_MCP_ORIGINAL_PID` and `AGENTMBX_DEV`.
- **Hook tests and their MCP share the test process as parent.** Fixtures built with `bindWakeLease` must bind with
  `pid: process.ppid` to be visible to a hook.
- **"Connected but not yet claimed"** (right after a harness restart) is a real `agentmbx mcp` that has been connected and
  `listTools()`-ed, with no mbx tool called. Its identity control has `agent: ""`.
  - Seed every `kv` row the live session already had (for example `guided:<cli>:<sid>`). Otherwise first-time guidance
    fills the output and the test passes or fails for the wrong reason.
- **For a liveness predicate,** write one case per branch in which only that branch differs and every other piece of
  evidence is live: live and unbound, live and held, a dead server, a reborn parent.
- **Process start times come in two formats.**
  - `sessions.pid_start` is the local `ps` lstart; compare it with `procStart`/`sameProcess`.
  - Leases and identity controls use `ps-utc:…` from `inspectLeaseProcess`.
- **`node:sqlite` rows have a null prototype.** Spread them before `assert.deepEqual`.
- **Message ids are time-ordered.** A prefix test needs a few milliseconds between sends and a prefix longer than the
  timestamp part.

## Release QA on macOS

PR CI runs on Linux only, so the lead may ask for a macOS run on an integration branch. It is report-only:

1. Create a detached worktree of the branch and link `node_modules`. Run `npm ci --include=dev` only if the lockfile
   changed.
2. Run `npm test` once, unmodified, in the background, and note the start time, SHA and `uptime`.
3. Report the totals, plus for each `✖`:
   - its `file:line`;
   - the first assertion;
   - whether it reproduces when that file runs alone (with `--test-force-exit`).
4. Make no commits or fixes.

## Measuring live process spawns (macOS)

`scripts/spawn-sampler.py <seconds> [poll_ms]` polls libproc in-process and records:
- agentmbx starts;
- the `claude-posttool.sh` wrapper;
- children of resident agentmbx processes, each with its ancestor chain.

It starts no `ps` of its own and never signals anything. `scripts/spawn-summarize.py <report.json>` groups one report by
kind and harness.

- **Exclude starts from dev checkouts** (other agents' test runs) by argv path.
- **State the poll floor.** Children that live for less than the poll interval are missed, so never claim "0 children"
  from the sampler. For exact counts in a test, preload a tracer that wraps `node:child_process`
  (`test/helpers/spawn-tracer.mjs`).
- **To check that a spawn fix held after a release:**
  1. Keep the baseline reports, then rerun the same windows.
  2. Prove the harness was busy during the window from its own store, read-only.
  3. Confirm with `agentmbx doctor` that the installed hook or plugin is current.
  4. Attribute any new top source to its configuration before blaming agentmbx; for example, a status line's refresh
     interval times its live sessions.

## Reproducing a hook or binding bug

Rebuild the real process topology in a scratch script outside the repo:

1. **One parent process** spawns the real `agentmbx mcp` and then every hook as its own child, with isolated `HOME`,
   `XDG_*` and `MBX_HOME`.
2. **Replay the live sequence:** an unbound turn, then a claim, a bound turn, a wait past the heartbeat, and a new MCP
   under the same parent. Dump the `sessions` and `kv` rows after each step.
3. **Send payloads in the harness's real shape and size,** written asynchronously.

To try read logic on real data, copy the mailbox with `sqlite3 ~/.local/share/agentmbx/mbx.db ".backup <tmp>/mbx.db"` and
open the copy. Never construct `MbxNode` on the live home: it migrates and repairs permissions.

## Docs and spec tasks (CLEO)

- **Run `cleo` from the main checkout** so it uses the shared database. `cleo docs publish --to` refuses paths outside the
  main checkout.
- **ADRs:** omit `--slug` and choose the title. The body needs `## Status` and `## Date` headings.
- **Specs** need `## Requirements`, `## Non-Goals` and `## Out-of-Scope` headings.
- **Revising a doc:** `cleo docs update <slug> --file F --allow-external true --status <s>`. Every update changes the
  sha256, so quote the new one.
- **Before claiming harness behaviour in a spec,** read the vendor's docs for that day (Claude and Codex serve `.md`
  pages) and label each claim by its basis: doc, code, live or to-verify.

## Reporting

- **A plan** lists:
  - the existing code involved, with `file:line`;
  - the files split by owner;
  - one test per acceptance criterion;
  - numbered decisions, each with a recommendation and the default you will take if the lead stays silent.
- **A root-cause plan** adds the reproduction and the numbers that separate pass from fail.
- **A finished-work report** gives:
  - the commit SHA and what each commit contains;
  - each gate's exact command and counts;
  - what was not run;
  - anything that differs from what was asked.
- **Report bugs, don't patch them.** A failure you find while validating goes to the lead as a finding with a repro, and
  the lead files the task. Correct your own earlier claim in the same thread as soon as you find it wrong.
- **Mail kinds:**
  - A report the lead must act on goes as `request` with `needs_reply`; a `status` never wakes it.
  - Check the receipt state (`live-wake` or `live-next-prompt`).
  - Ack the task mail with a one-line `did` once it is handled.
