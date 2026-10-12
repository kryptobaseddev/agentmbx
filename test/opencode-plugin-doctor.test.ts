import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { opencodePluginChecks, doctor } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";
import { edits, opencodeSidebarDir, runSetup, type SetupCtx } from "../src/setup.ts";
import { hudAlivePath, hudSessionV2Path, HUD_ALIVE_MAX_MS } from "../src/hud.ts";

const NOW = 1_800_000_000_000;
function fixture(t: { after: (fn: () => void) => void }, install = true) {
  const home = mkdtempSync(join(tmpdir(), "mbx-plugin-doctor-"));
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false };
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), "{}\n");
  if (install) runSetup(ctx, { mode: "install", only: ["opencode"] });
  const node = new MbxNode(join(home, "data"), { host: "scratch" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true }); });
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const bind = (sid = "ses_alpha", pid = 123, agent = "alpha") => {
    node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,pid,updated_at) VALUES (?,'opencode',?,?,?)").run(agent, sid, pid, new Date(NOW).toISOString());
  };
  const snapshot = (sid = "ses_alpha", agent = "alpha") => {
    const path = hudSessionV2Path(node.home, "opencode", sid);
    put(path, JSON.stringify({ schema: "mbx.status/v2", harness: { cli: "opencode", session_id: sid }, identity: { state: "bound", name: agent }, inbox: { unread: 987, recent: [{ subject: "PRIVATE SUBJECT" }] } }));
    return path;
  };
  const alive = (stamp = NOW) => put(hudAlivePath(node.home), String(stamp));
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ waiters: [{ sessionID: "ses_alpha", pid: 123 }] }));
  };
  const check = (f: typeof fetch = fetcher) => opencodePluginChecks(ctx, node, { now: NOW, fetch: f });
  return { home, ctx, node, bind, snapshot, alive, put, check, urls };
}

test("T412: wiring absence and no-session runtime are explicit with setup guidance and no HTTP", async t => {
  const f = fixture(t, false), result = await f.check();
  assert.equal(result[0].level, "warn");
  assert.match(result[0].label, /missing/);
  assert.equal(result[0].fix, "agentmbx setup --only opencode");
  assert.match(result[1].label, /no session bindings.*TUI load\/read\/render budget unobserved/);
  assert.deepEqual(f.urls, []);
});

test("T412: managed wiring, exact server poll and producer heartbeat stay distinct from UI proof", async t => {
  const f = fixture(t); f.bind(); f.snapshot(); f.alive();
  const result = await f.check();
  assert.equal(result[0].level, "ok");
  assert.match(result[0].label, /present\/current/);
  assert.match(result[1].label, /session ses_alpha.*server poll observed.*producer heartbeat fresh.*exact snapshot available.*TUI load\/read\/render budget unobserved/);
  assert.equal(result[1].level, "info", "producer health must not become a UI PASS");
  assert.match(result[1].fix!, /agentmbx setup --only opencode; reopen only the affected OpenCode TUI when the owner permits it\./);
  assert.equal(f.urls.length, 1);
  assert.match(f.urls[0], /^http:\/\/127\.0\.0\.1:\d+\/v1\/opencode-wake\/waiters$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE SUBJECT|987|unread/);
});

test("T412: version-only header/package changes are current, not stale", async t => {
  const f = fixture(t), dir = opencodeSidebarDir(f.home);
  const tui = join(dir, "tui.ts"), pkg = join(dir, "package.json");
  writeFileSync(tui, readFileSync(tui, "utf8").replace(/\(agentmbx [^)]+\)/, "(agentmbx 0.0.1)"));
  const json = JSON.parse(readFileSync(pkg, "utf8")); json.version = "0.0.1"; writeFileSync(pkg, JSON.stringify(json, null, 2) + "\n");
  assert.equal((await f.check())[0].level, "ok");
});

for (const name of ["tui.ts", "status-schema.ts"]) test(`T412: outdated managed and foreign ${name} have different non-destructive guidance`, async t => {
  const f = fixture(t), path = join(opencodeSidebarDir(f.home), name), current = readFileSync(path, "utf8");
  writeFileSync(path, current + "\n// outdated body\n");
  const stale = await f.check();
  assert.match(stale[0].label, /outdated managed wiring/);
  assert.equal(stale[0].fix, "agentmbx setup --only opencode");
  const foreign = "// foreign owner plugin\nexport default {};\n"; writeFileSync(path, foreign);
  const result = await f.check();
  assert.match(result[0].label, /foreign or malformed \(preserved\)/);
  assert.match(result[0].fix!, /Back up your local plugin edits.*setup preserves foreign files/);
  assert.equal(readFileSync(path, "utf8"), foreign);
});

test("T412: malformed registration and oversized plugin source do not throw", async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".config/opencode/tui.json"), "{bad json");
  writeFileSync(join(opencodeSidebarDir(f.home), "tui.ts"), "x".repeat(262_145));
  const result = await f.check();
  assert.equal(result[0].level, "warn");
  assert.match(result[0].label, /malformed/);
  assert.match(result[0].label, /unreadable or oversized/);
});

test("T412: one bounded request scopes poll and snapshot evidence by session AND pid", async t => {
  const f = fixture(t); f.bind(); f.bind("ses_beta", 456, "beta"); f.snapshot(); f.alive();
  // Another session's well-formed snapshot cannot satisfy beta, even with a fresh daemon.
  f.put(hudSessionV2Path(f.node.home, "opencode", "ses_beta"), readFileSync(hudSessionV2Path(f.node.home, "opencode", "ses_alpha"), "utf8"));
  const wrongPid: typeof fetch = async () => new Response(JSON.stringify({ waiters: [{ sessionID: "ses_alpha", pid: 456 }, { sessionID: "ses_beta", pid: 123 }] }));
  const result = await f.check(wrongPid);
  assert.ok(result.slice(1).every(c => c.label.includes("server poll unobserved")));
  assert.match(result[1].label, /ses_alpha.*exact snapshot available/);
  assert.match(result[2].label, /ses_beta.*invalid or mismatched/);
});

test("T412: no waiter does not imply the service-hosted TUI is unloaded", async t => {
  const f = fixture(t); f.bind(); f.snapshot(); f.alive();
  const result = await f.check(async () => new Response('{"waiters":[]}'));
  assert.match(result[1].label, /unobserved.*service hosts need no standalone waiter/);
  assert.equal(result[1].level, "info");
  assert.doesNotMatch(result[1].label, /unloaded|crashed|rendered|loaded successfully/);
});

test("T412: unreachable, malformed and oversized waiters are unobserved, not failed UI", async t => {
  const f = fixture(t); f.bind(); f.snapshot(); f.alive();
  for (const fetcher of [async () => { throw new Error("offline"); }, async () => new Response("{bad"), async () => new Response('{"waiters":42}'), async () => new Response(" ".repeat(262_145)), async () => new Response("down", { status: 503 })] satisfies (typeof fetch)[]) {
    const result = await f.check(fetcher);
    assert.match(result[1].label, /server poll unobserved \(waiters endpoint unavailable\)/);
    assert.equal(result[1].level, "info");
  }
});

test("T412: slow waiters are aborted within the 300ms timeout", async t => {
  const f = fixture(t); f.bind(); f.snapshot(); f.alive();
  let aborted = false;
  const result = await f.check(async (_url, init) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("request was not aborted")), 1000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); aborted = true; reject(init.signal?.reason); }, { once: true });
  }));
  assert.equal(aborted, true);
  assert.match(result[1].label, /endpoint unavailable/);
});

test("T412: unchanged snapshot mtime is not a staleness signal; heartbeat governs producer age", async t => {
  const f = fixture(t); f.bind(); const path = f.snapshot(); f.alive();
  utimesSync(path, new Date(0), new Date(0));
  assert.match((await f.check())[1].label, /heartbeat fresh.*exact snapshot available/);
  assert.equal(statSync(path).mtimeMs, 0, "doctor did not touch the cache");
  f.alive(NOW - HUD_ALIVE_MAX_MS - 1);
  assert.match((await f.check())[1].label, /heartbeat stale/);
  f.alive(NOW + 1);
  assert.match((await f.check())[1].label, /heartbeat unknown/);
  f.put(hudAlivePath(f.node.home), "invalid");
  assert.match((await f.check())[1].label, /heartbeat unknown/);
});

test("T412: absent or invalid snapshots and path-unsafe session ids are explicit", async t => {
  const f = fixture(t); f.bind(); f.bind("../escape", 456, "beta"); f.alive();
  assert.ok((await f.check()).some(c => c.label.includes("invalid identity — snapshot not read")));
  assert.ok((await f.check()).some(c => c.label.includes("missing or unreadable")));
  const path = f.snapshot();
  for (const text of ["{bad", '{"schema":"mbx.status/v1"}', JSON.stringify({ schema: "mbx.status/v2", harness: { cli: "opencode", session_id: "ses_alpha" }, identity: { state: "bound", name: "another" } })]) {
    f.put(path, text);
    assert.ok((await f.check()).some(c => c.label.includes("invalid or mismatched")));
  }
});

test("T412: session inventory is bounded and reports omitted coverage", async t => {
  const f = fixture(t); for (let i = 0; i < 25; i++) f.bind("ses_" + i, 123, "alpha"); f.alive();
  const result = await f.check();
  assert.equal(result.filter(c => c.label.startsWith("opencode: plugin session ")).length, 20);
  assert.match(result.at(-1)!.label, /5 additional bindings not assessed/);
  assert.equal(f.urls.length, 1);
});

test("T412: checks never rewrite wiring, snapshots, session rows or deliveries", async t => {
  const f = fixture(t); f.bind(); const snap = f.snapshot(); f.alive();
  const files = [...edits(f.ctx, "opencode").filter(e => e.kind === "sidebar" || e.kind === "hooks").map(e => e.path), snap, hudAlivePath(f.node.home)];
  const before = files.map(path => [path, readFileSync(path, "utf8"), statSync(path).mtimeMs]);
  f.node.send({ from: "peer", to: ["alpha"], subject: "PRIVATE SUBJECT", body: "PRIVATE BODY" });
  const rows = f.node.store.db.prepare("SELECT * FROM sessions").all(), mail = f.node.store.db.prepare("SELECT * FROM deliveries").all();
  await f.check();
  assert.deepEqual(files.map(path => [path, readFileSync(path, "utf8"), statSync(path).mtimeMs]), before);
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM sessions").all(), rows);
  assert.deepEqual(f.node.store.db.prepare("SELECT * FROM deliveries").all(), mail);
});

test("T412: the doctor CLI checklist includes the new plugin wiring check", async t => {
  const f = fixture(t);
  const checks = await doctor(f.ctx, f.node.home, { peerTimeoutMs: 10 });
  assert.ok(checks.some(c => c.label.startsWith("opencode: plugin wiring")));
});
