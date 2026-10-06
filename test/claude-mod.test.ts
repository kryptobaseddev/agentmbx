import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as realExecFile } from "node:child_process";
import { readStatus, renderStatus, resetStatusCache, resolveSessionId, statusText } from "../plugins/claude/hooks/register.js";

const MINE = {
  schema: "mbx.status/v1",
  mbx_version: "0.5.13",
  host: "macbook",
  cli: "claude",
  session_id: "sess-mine",
  identity: { bound: true, name: "agentmbx-claude", host: "macbook", role: "claude" },
  policy: "autonomous [read, edit]",
  unread: 2,
  needs_reply: 1,
  from_owner: 0,
  outbox_unsent: 3,
  health: "ok",
};

const THEIRS = {
  ...MINE,
  session_id: "sess-other",
  identity: { bound: true, name: "someone-else", host: "macbook", role: "claude" },
  unread: 9,
};

test("T414: a missing session id is unbound and does not call status", async () => {
  assert.equal(resolveSessionId({}), null);
  assert.equal(resolveSessionId({ CLAUDE_CODE_SESSION_ID: "  " }), null);
  assert.equal(resolveSessionId({ OTHER_SESSION: "sess-other" }), null);
  assert.equal(resolveSessionId({ CLAUDE_CODE_SESSION_ID: " sess-mine " }), "sess-mine");
  assert.equal(resolveSessionId({ CLAUDE_SESSION_ID: "sess-alias" }), "sess-alias");
  assert.equal(renderStatus(null, THEIRS), "unbound");
  let called = false;
  const result = await readStatus({
    sessionId: null,
    execFileImpl: (() => {
      called = true;
      return undefined;
    }) as unknown as typeof realExecFile,
  });
  assert.equal(called, false);
  assert.equal(result.text, "unbound");
});

test("T414: the band renders only the snapshot for the given session id", () => {
  const text = renderStatus("sess-mine", MINE);
  assert.match(text, /agentmbx-claude@macbook \(claude\)/);
  assert.match(text, /unread 2/);
  assert.match(text, /needs_reply 1/);
  assert.match(text, /from_owner 0/);
  assert.match(text, /outbox_unsent 3/);
  assert.match(text, /policy autonomous \[read, edit\]/);
  assert.equal(text.includes("someone-else"), false);
  assert.equal(text.includes("unread 9"), false);
  const other = renderStatus("sess-other", THEIRS);
  assert.match(other, /someone-else/);
  assert.equal(other.includes("agentmbx-claude"), false);
});

test("T414: a status failure is unavailable and does not throw", async () => {
  const seen: { bin?: string; args?: readonly string[]; timeout?: number; shell?: unknown } = {};
  const broken = await readStatus({
    sessionId: "sess-mine",
    execFileImpl: ((bin, args, opts, cb) => {
      seen.bin = bin;
      seen.args = args;
      seen.timeout = opts.timeout;
      seen.shell = opts.shell;
      const err = new Error("timed out") as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      cb(err, "");
      return { on() { return undefined; } };
    }) as unknown as typeof realExecFile,
  });
  assert.equal(broken.text, "mbx: unavailable");
  assert.equal(seen.bin, "agentmbx");
  assert.deepEqual(seen.args, ["status", "--cli", "claude", "--session", "sess-mine", "--json", "--schema", "mbx.status/v1"]);
  assert.equal(seen.timeout, 2000);
  assert.equal(seen.shell, undefined);

  const thrown = await readStatus({
    sessionId: "sess-mine",
    execFileImpl: (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof realExecFile,
  });
  assert.equal(thrown.text, "mbx: unavailable");

  const junk = await readStatus({
    sessionId: "sess-mine",
    execFileImpl: ((_bin, _args, _opts, cb) => {
      cb(null, "not-json");
      return { on() { return undefined; } };
    }) as unknown as typeof realExecFile,
  });
  assert.equal(junk.text, "mbx: unavailable");
});

test("T414: the cache does not reuse another session's snapshot", async () => {
  resetStatusCache();
  const calls: string[] = [];
  const exec = ((_bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const session = args[args.indexOf("--session") + 1] ?? "";
    calls.push(session);
    const body = session === "sess-mine" ? MINE : THEIRS;
    cb(null, JSON.stringify(body));
    return { on() { return undefined; } };
  }) as unknown as typeof realExecFile;

  const first = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-mine" }, { execFileImpl: exec, now: 1_000 });
  const again = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-mine" }, { execFileImpl: exec, now: 1_500 });
  const other = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-other" }, { execFileImpl: exec, now: 1_600 });
  assert.match(first, /agentmbx-claude/);
  assert.equal(again, first);
  assert.match(other, /someone-else/);
  assert.equal(other.includes("agentmbx-claude"), false);
  assert.deepEqual(calls, ["sess-mine", "sess-other"]);
  resetStatusCache();
});
