import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readStatus, renderStatus, resetStatusCache, resolveSessionId, statusRequestUrl, statusText } from "../plugins/claude/hooks/register.js";

const MINE = {
  schema: "mbx.status/v1",
  mbx_version: "0.5.13",
  update_available: null,
  identity: { name: "agentmbx-claude", role: "claude", state: "bound" },
  policy: ["autonomous"],
  unread: 2,
  needs_reply: 1,
  from_owner: 0,
  outbox_unsent: 3,
  health: "ok",
  resolved_by: "session_id",
};

const THEIRS = {
  ...MINE,
  identity: { name: "someone-else", role: "claude", state: "bound" },
  unread: 9,
};

type FetchResponse = { ok?: boolean; status?: number; text?: unknown };

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
    fetchImpl: async () => {
      called = true;
      return { ok: true, text: JSON.stringify(MINE) };
    },
  });
  assert.equal(called, false);
  assert.equal(result.text, "unbound");
  const skipped = await statusText({}, {
    fetchImpl: async () => {
      called = true;
      return { ok: true, text: JSON.stringify(MINE) };
    },
    now: 1,
  });
  assert.equal(skipped, "unbound");
  assert.equal(called, false);
});

test("T414: the band renders only the snapshot for the given session id", () => {
  const text = renderStatus("sess-mine", MINE);
  assert.match(text, /agentmbx-claude \(claude\)/);
  assert.match(text, /unread 2/);
  assert.match(text, /needs_reply 1/);
  assert.match(text, /from_owner 0/);
  assert.match(text, /outbox_unsent 3/);
  assert.match(text, /policy autonomous/);
  assert.equal(text.includes("someone-else"), false);
  assert.equal(text.includes("unread 9"), false);
  const other = renderStatus("sess-other", THEIRS);
  assert.match(other, /someone-else/);
  assert.equal(other.includes("agentmbx-claude"), false);
});

test("T414: a status failure is unavailable and does not throw", async () => {
  const urls: string[] = [];
  const broken = await readStatus({
    sessionId: "sess-mine",
    fetchImpl: async (url) => {
      urls.push(url);
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    },
  });
  assert.equal(broken.text, "mbx: unavailable");
  const parsed = new URL(urls[0] ?? "");
  assert.equal(parsed.origin, "http://127.0.0.1:7373");
  assert.equal(parsed.pathname, "/v1/status");
  assert.equal(parsed.searchParams.get("cli"), "claude");
  assert.equal(parsed.searchParams.get("session"), "sess-mine");
  assert.equal(statusRequestUrl("a&b"), "http://127.0.0.1:7373/v1/status?cli=claude&session=a%26b");

  const thrown = await readStatus({
    sessionId: "sess-mine",
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
  });
  assert.equal(thrown.text, "mbx: unavailable");

  const down = await readStatus({
    sessionId: "sess-mine",
    fetchImpl: async () => ({ ok: false, status: 500, text: "" }),
  });
  assert.equal(down.text, "mbx: unavailable");

  const junk = await readStatus({
    sessionId: "sess-mine",
    fetchImpl: async () => ({ ok: true, status: 200, text: "not-json" }),
  });
  assert.equal(junk.text, "mbx: unavailable");

  const runtime = await readStatus({
    sessionId: "sess-mine",
    fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify({ service: "agentmbx", v: 1, host: "macbook" }) }),
  });
  assert.equal(runtime.text, "mbx: unavailable");
});

test("T414: the cache does not reuse another session's snapshot", async () => {
  resetStatusCache();
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<FetchResponse> => {
    const session = new URL(url).searchParams.get("session") ?? "";
    calls.push(session);
    const body = session === "sess-mine" ? MINE : THEIRS;
    return { ok: true, status: 200, text: JSON.stringify(body) };
  };

  const first = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-mine" }, { fetchImpl, now: 1_000 });
  const again = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-mine" }, { fetchImpl, now: 1_500 });
  const other = await statusText({ CLAUDE_CODE_SESSION_ID: "sess-other" }, { fetchImpl, now: 1_600 });
  assert.match(first, /agentmbx-claude/);
  assert.equal(again, first);
  assert.match(other, /someone-else/);
  assert.equal(other.includes("agentmbx-claude"), false);
  assert.deepEqual(calls, ["sess-mine", "sess-other"]);
  resetStatusCache();
});

test("T417: fixture v1 and v2 snapshots render only that snapshot's identity", () => {
  const dir = new URL("../plugins/claude/fixtures/", import.meta.url);
  const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, ["v1-ambiguous.json", "v1-bound.json", "v1-unbound.json", "v2-bound.json", "v2-unbound.json"]);
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

  const v1 = renderStatus("sess-mine", read("v1-bound.json"));
  assert.match(v1, /^mbx agentmbx-claude \(claude\)/);
  assert.match(v1, /unread 2/);
  assert.match(v1, /needs_reply 1/);
  assert.match(v1, /policy autonomous/);

  const v2 = renderStatus("sess-mine", read("v2-bound.json"));
  assert.match(v2, /^mbx agentmbx-claude \(claude\)/);
  assert.match(v2, /unread 2/);
  assert.match(v2, /needs_reply 1/);
  assert.match(v2, /from_owner 0/);
  assert.match(v2, /outbox_unsent 3/);
  assert.match(v2, /policy autonomous/);
  assert.equal(v2.includes("someone-else"), false);

  assert.equal(renderStatus("sess-mine", read("v1-unbound.json")), "unbound");
  assert.equal(renderStatus("sess-mine", read("v2-unbound.json")), "unbound");
  const ambiguous = renderStatus("sess-mine", read("v1-ambiguous.json"));
  assert.equal(ambiguous, "ambiguous");
  assert.equal(ambiguous.includes("agentmbx-claude"), false);
  assert.equal(ambiguous.includes("someone-else"), false);
  assert.equal(ambiguous.includes("unread"), false);
});

test("T414: the hooks module imports nothing but relative files and claude-code", () => {
  const source = readFileSync(new URL("../plugins/claude/hooks/register.js", import.meta.url), "utf8");
  assert.equal(source.includes("node:"), false);
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("import("), false);
  assert.match(source, /\$\.http\.fetch\(/);
  assert.match(source, /\$\.env\.get\("CLAUDE_CODE_SESSION_ID"\)/);
  assert.match(source, /\$\.env\.get\("CLAUDE_SESSION_ID"\)/);
  const imports = source.match(/^\s*import\s[\s\S]*?from\s+["'][^"']+["']/gm) ?? [];
  for (const line of imports) {
    const spec = line.match(/from\s+["']([^"']+)["']/)?.[1] ?? "";
    const allowed = spec === "claude-code" || spec.startsWith("./") || spec.startsWith("../");
    assert.equal(allowed, true, line);
  }
  assert.equal(imports.length, 0);
});
