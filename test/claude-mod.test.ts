import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  bandText, currentSnapshot, readStatus, register, renderSections, renderStatus, resetStatusCache, resetStatusState, resolveSessionId,
  statusLineText, statusRequestUrl, statusText,
} from "../plugins/claude/hooks/register.js";

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
  assert.equal(parsed.searchParams.get("schema"), "mbx.status/v2");
  assert.equal(
    statusRequestUrl("a&b"),
    "http://127.0.0.1:7373/v1/status?cli=claude&session=a%26b&schema=mbx.status%2Fv2",
  );

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
  assert.match(v2, /^mbx agentmbx-kimi \(builder\)/);
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

test("T414: the band renders the shared v2 contract fixture (the same snapshot the OpenCode sidebar reads)", () => {
  const shared = JSON.parse(readFileSync(new URL("./fixtures/status-v2-bound.json", import.meta.url), "utf8"));
  const text = renderStatus("sess-fixture", shared);
  assert.match(text, /^mbx agentmbx-kimi \(builder\)/);
  assert.match(text, /unread 2/);
  assert.match(text, /needs_reply 1/);
  // the mod's local v2-bound fixture is the shared fixture byte for byte: one shape, two paths
  const local = readFileSync(new URL("../plugins/claude/fixtures/v2-bound.json", import.meta.url), "utf8");
  assert.equal(local, readFileSync(new URL("./fixtures/status-v2-bound.json", import.meta.url), "utf8"));
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

// ---- T415: the full mod — every v2 section, the unread indicator, the fallbacks ----

const SHARED_V2 = JSON.parse(readFileSync(new URL("./fixtures/status-v2-bound.json", import.meta.url), "utf8"));

const RICH_V2 = {
  ...SHARED_V2,
  identity: { name: "probe-staff", role: "builder", state: "bound" },
  cloud: {
    relay: { url: "https://relay.agentmbx.com", state: "connected", last_ack: "2026-10-07T16:00:00Z" },
    key_ad_expiry: "2026-11-05T04:06:34.926Z",
    account: "acct_owner",
  },
  devices: [
    { host: "fedora", address: "10.0.10.136:7373", reachability: "paired", last_presence: "2026-10-07T15:58:00Z" },
    { host: "mini", address: "10.0.10.20:7373", reachability: "unknown", last_presence: null },
  ],
  project: { directory: "/work/rich", lead: "agentmbx-lead", members: ["probe-staff", "agentmbx-lead"] },
};

test("T415: every v2 section renders from the shared fixture, pure and complete", () => {
  const lines = renderSections(SHARED_V2);
  assert.ok(lines);
  const text = lines.join("\n");
  assert.match(text, /^identity agentmbx-kimi\(builder\)/);
  assert.match(text, /registration registered · lease kimi\/sess-fixture verified/);
  assert.match(text, /inbox 2 unread · 1 needs reply · 0 from owner · 3 unsent/);
  assert.match(text, /harness kimi sess-fixture · wake watcher · policy autonomous/);
  assert.match(text, /cloud relay unset$/m, "nulls render as honest facts, never invented");
  assert.match(text, /devices none paired/);
  assert.match(text, /project \/work\/fixture · lead agentmbx-lead · members agentmbx-kimi/);
});

test("T415: populated cloud, devices and project render one line each", () => {
  const lines = renderSections(RICH_V2)!;
  assert.match(lines.join("\n"), /cloud relay connected \(https:\/\/relay\.agentmbx\.com\) · key ad until 2026-11-05 · account acct_owner/);
  assert.match(lines.join("\n"), /device fedora at 10\.0\.10\.136:7373 \(paired\) · seen 2026-10-07 15:58/);
  assert.match(lines.join("\n"), /device mini at 10\.0\.10\.20:7373 \(unknown\)/);
  assert.match(lines.join("\n"), /project \/work\/rich · lead agentmbx-lead · members probe-staff, agentmbx-lead/);
  assert.equal(renderSections(MINE), null, "v1 has no sections: the pane is a v2 surface");
  assert.equal(renderSections(null), null);
  assert.equal(renderSections({ service: "agentmbx" }), null);
  assert.deepEqual(renderSections({ ...SHARED_V2, identity: { name: null, role: null, state: "unbound" } }), ["mbx unbound"]);
});

test("T415: the unread indicator — band marker and the persistent status line", () => {
  assert.match(bandText("sess-fixture", SHARED_V2), /^● mbx agentmbx-kimi/, "unread mail marks the band");
  const quiet = { ...SHARED_V2, inbox: { unread: 0, needs_reply: 0, from_owner: 0, outbox_unsent: 0 } };
  assert.match(bandText("sess-fixture", quiet), /^mbx agentmbx-kimi/, "no unread: no marker");
  assert.doesNotMatch(bandText("sess-fixture", quiet), /^●/);
  assert.equal(statusLineText(SHARED_V2), "mbx: 2↑ 1↺");
  assert.equal(statusLineText({ ...SHARED_V2, inbox: { ...SHARED_V2.inbox, from_owner: 1 } }), "mbx: 2↑ 1↺ owner:1");
  assert.equal(statusLineText(quiet), null, "nothing to show: no status line");
  assert.equal(statusLineText(MINE), null, "v1 has no indicator line; the band text still renders");
});

test("T415: register wires the pane, the command fallback, and passes foreign render sites through", async () => {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const on = (event: string, matcherOrHook: unknown, hook?: unknown) => {
    const fn = (typeof matcherOrHook === "function" ? matcherOrHook : hook) as (...args: unknown[]) => unknown;
    const key = typeof matcherOrHook === "object" && matcherOrHook ? `${event}:${JSON.stringify(matcherOrHook)}` : event;
    (handlers[key] ??= []).push(fn);
  };
  const uiLog: string[] = [];
  const $ = {
    env: { get: async (name: string) => (name === "CLAUDE_CODE_SESSION_ID" ? "sess-mine" : "") },
    clock: { now: async () => 1_000, every: (ms: number, fn: () => unknown) => { handlers["timer"] = [fn]; return { cancel: () => {} }; } },
    http: { fetch: async () => ({ ok: true, status: 200, text: JSON.stringify(SHARED_V2) }) },
    command: { register: async (c: unknown) => { uiLog.push(`command:${(c as { name: string }).name}`); } },
    ui: {
      open: async (o: unknown) => { uiLog.push(`open:${(o as { id: string }).id}`); return { isPlaced: true }; },
      toast: (t: string) => { uiLog.push(`toast:${t}`); },
      status: (t: string) => { uiLog.push(`status:${t}`); },
      invalidate: (s: string) => { uiLog.push(`invalidate:${s}`); },
      resolve: (e: unknown) => ({
        Box: (p: { children: unknown[] }) => ({ kind: "Box", children: p.children }),
        Text: (p: { children: unknown[] }) => ({ kind: "Text", children: p.children }),
      }),
    },
  };
  register(on);
  // the host fires session.start: the command registers and the indicator timer arms
  await handlers["session.start"]![0]!($, {}, async () => "started");
  assert.deepEqual(uiLog, ["command:mbx-status"]);

  // /mbx-status: opens the pane and prints the full sections (the fallback surface)
  const ran = handlers["command.run:{\"command\":\"mbx-status\"}"]![0]!;
  const result = (await ran($, {})) as { text: string };
  assert.deepEqual(uiLog.slice(1), ["open:mbx-status"]);
  assert.match(result.text, /^identity agentmbx-kimi\(builder\)/);
  assert.match(result.text, /inbox 2 unread · 1 needs reply/);
  assert.match(result.text, /project \/work\/fixture/);

  // the pane renders the same sections as a tree
  const paneHook = handlers['ui.render:{"component":"Pane"}']![0]!;
  const tree = (await paneHook($, { requestId: "mbx-status" }, async () => "passed-on")) as { kind: string; children: { children: string[] }[] };
  assert.equal(tree.kind, "Box");
  assert.match(tree.children.map((c) => c.children.join("")).join("\n"), /registration registered/);

  // foreign panes and the hasSurvey band defer to the host
  let passed = 0;
  const passThrough = async () => { passed += 1; return "engine-ref"; };
  await paneHook($, { requestId: "someone-else" }, passThrough);
  assert.equal(passed, 1);
  const bandHook = handlers['ui.render:{"component":"AbovePrompt"}']![0]!;
  const band = (await bandHook($, { props: { hasSurvey: true } }, passThrough)) as string;
  assert.equal(band, "engine-ref");
  assert.equal(passed, 2);
  const bandTree = (await bandHook($, { props: {} }, passThrough)) as { children: string[] };
  assert.match(bandTree.children.join(""), /^● mbx agentmbx-kimi/);

  // the indicator timer polls, pins the status line, and asks for a redraw
  uiLog.length = 0;
  await handlers["timer"]![0]!();
  assert.ok(uiLog.includes("status:mbx: 2↑ 1↺"));
  assert.ok(uiLog.includes("invalidate:ui.render"));
  resetStatusState();
});

test("T415: the hooks module exposes the new surface for claude plugin validate", () => {
  const source = readFileSync(new URL("../plugins/claude/hooks/register.js", import.meta.url), "utf8");
  assert.match(source, /\$\.ui\.open\(\{ id: PANE_ID/);
  assert.match(source, /\$\.ui\.status\(line\)/);
  assert.match(source, /\$\.ui\.invalidate\("ui\.render"\)/);
  assert.match(source, /\$\.clock\.every\(INDICATOR_MS/);
  assert.match(source, /on\("ui\.render", \{ component: "Pane" \}/);
  assert.equal(source.includes("setInterval"), false, "the sandbox has no timer globals: $.clock.every only");
});

test("T415/T308 AC2: a stale snapshot never survives a session change or a failed fetch", async () => {
  resetStatusState();
  // session A fetches fine
  const ok = await readStatus({
    sessionId: "sess-a",
    fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify({ ...SHARED_V2, identity: { name: "agent-a", role: "qa", state: "bound" } }) }),
  });
  assert.match(ok.text, /agent-a/);
  assert.equal(currentSnapshot("sess-a") !== null, true);
  assert.match(bandText("sess-a", currentSnapshot("sess-a")), /agent-a/);

  // session id changes to B and the fetch fails: B shows unavailable, never A's data, anywhere
  const failed = await readStatus({ sessionId: "sess-b", fetchImpl: async () => ({ ok: false, status: 500, text: "" }) });
  assert.equal(failed.text, "mbx: unavailable");
  assert.equal(currentSnapshot("sess-b"), null);
  assert.equal(currentSnapshot("sess-a"), null, "the failure cleared the store entirely");
  assert.equal(bandText("sess-b", currentSnapshot("sess-b")), "mbx: unavailable");
  assert.equal(bandText("sess-b", currentSnapshot("sess-b")).includes("agent-a"), false);
  assert.deepEqual(renderSections(currentSnapshot("sess-b")), null, "the pane gets nothing to render");

  // a failed fetch for the SAME session also shows unavailable, not stale counts
  const ok2 = await readStatus({ sessionId: "sess-c", fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify(SHARED_V2) }) });
  assert.match(ok2.text, /agentmbx-kimi/);
  const failed2 = await readStatus({ sessionId: "sess-c", fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(failed2.text, "mbx: unavailable");
  assert.equal(currentSnapshot("sess-c"), null, "no stale counts after the failure");
  assert.equal(bandText("sess-c", currentSnapshot("sess-c")), "mbx: unavailable");

  // an unbound read (no session id) clears the store too
  await readStatus({ sessionId: null, fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify(SHARED_V2) }) });
  assert.equal(currentSnapshot("sess-c"), null);
  resetStatusState();
});
