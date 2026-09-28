// Waking kimi web-hosted kimi sessions (T049): hosted-session detection from $KIMI_CODE_HOME/server/instances,
// the prompts/status REST shape against a fake HTTP server, the busy gate in dispatchWakes, and the shared
// wake brake + desktop fallback. All kimi-home dirs here are isolated temp dirs; KIMI_CODE_HOME is only ever
// pointed at them in this file, never at the user's real ~/.kimi-code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { kimiHostedServer, kimiServer } from "../src/kimi-web.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes, wakeKimi, type WakeResult } from "../src/wake.ts";

process.env.MBX_NO_DESKTOP = "1";
const tmp = () => mkdtempSync(join(tmpdir(), "mbx-kimi-"));

interface Seen { method: string; url: string; auth: string | null; body: string }
interface FakeState { busy?: boolean; model?: string | null; defaultModel?: string | null; failPrompts?: boolean }

/** The kimi web REST API as the wake adapter expects it (envelope: {code, data}), recording every request. */
function fakeKimiServer(state: FakeState) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: (req.headers.authorization as string | undefined) ?? null, body });
      const json = (x: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(x)); };
      const url = req.url ?? "";
      if (url.startsWith("/api/v1/sessions/") && url.endsWith("/status")) {
        const data: Record<string, unknown> = { busy: state.busy === true, thinking_level: "off", permission: "default", plan_mode: false, swarm_mode: false, context_tokens: 0 };
        if (state.model) data.model = state.model;
        return json({ code: 0, data });
      }
      if (url === "/api/v1/config") return json({ code: 0, data: { default_model: state.defaultModel ?? null } });
      if (url.endsWith("/prompts") && req.method === "POST") {
        if (state.failPrompts) return json({ code: 40040, message: "Model not set", data: null });
        return json({ code: 0, data: { prompt_id: "prm_test", status: "running" } });
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 40400, message: "not found" }));
    });
  });
  return new Promise<{ server: Server; url: string; seen: Seen[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }));
  });
}

/** An isolated fake $KIMI_CODE_HOME whose server/instances row names `pid` on `port` (hosted-session detection data). */
function kimiHomeWithInstance(port: number, pid = process.pid): string {
  const home = tmp();
  mkdirSync(join(home, "server/instances"), { recursive: true });
  writeFileSync(join(home, "server.token"), "test-token\n");
  writeFileSync(join(home, "server/instances/srv.json"), JSON.stringify({ server_id: "srv", pid, host: "127.0.0.1", port }));
  return home;
}

async function withKimiHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev; }
}

const err = (r: WakeResult): string => (r.ok ? "" : r.error);
/** SQLite rows are null-prototype objects; map them to plain ones for deepEqual. */
const deliveries = (n: MbxNode) => (n.store.db.prepare("SELECT state, note FROM deliveries ORDER BY msg_id").all() as { state: string; note: string | null }[])
  .map((r) => ({ state: r.state, note: r.note }));

for (const concurrent of [false, true]) test(`busy race releases only its reservation (concurrent continuation: ${concurrent})`, async (t) => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => n.close());
  let statusCalls = 0, prompts = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      statusCalls++;
      if (statusCalls === 2 && concurrent) assert.ok(n.allowContinue("web", "another-thread"));
      return Response.json({ code: 0, data: { busy: statusCalls === 2, model: "m" } });
    }
    assert.ok(url.endsWith("/prompts"));
    prompts++;
    return Response.json({ code: 0, data: { prompt_id: "p", status: "running" } });
  });
  await withKimiHome(kimiHomeWithInstance(12345), async () => {
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_race", pid: process.pid });
    n.send({ from: "boss", to: ["web"], subject: "race", body: "check inbox", kind: "request" });
    const first = await dispatchWakes(n);
    assert.equal(first[0].result.ok, false);
    assert.match(err(first[0].result as WakeResult), /busy/);
    assert.equal(prompts, 0);
    assert.deepEqual(deliveries(n), [{ state: "delivered", note: null }]);
    const wakes = n.store.db.prepare("SELECT thread FROM wakes").all() as { thread: string }[];
    assert.deepEqual(wakes.map((r) => r.thread), concurrent ? ["another-thread"] : []);
    const second = await dispatchWakes(n);
    if (concurrent) {
      assert.deepEqual(second, [], "the concurrent continuation still enforces the shared brake");
      assert.equal(prompts, 0);
    } else {
      assert.equal(second[0].result.ok, true, "idle retry is not delayed by an unused reservation");
      assert.equal(prompts, 1);
      assert.deepEqual(deliveries(n), [{ state: "notified", note: null }]);
    }
  });
});

// ---- hosted-session detection -------------------------------------------------------------------
test("reservation is retained if an earlier adapter attempt failed before the busy result", async (t) => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => n.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 2) return Response.json({ code: 50000, message: "status unavailable" });
    return Response.json({ code: 0, data: { busy: calls === 3, model: "m" } });
  });
  await withKimiHome(kimiHomeWithInstance(12345), async () => {
    for (const session_id of ["session_first", "session_second"])
      bindWakeLease(n, { agent: "web", cli: "kimi", session_id, pid: process.pid });
    n.send({ from: "boss", to: ["web"], subject: "race", body: "check inbox", kind: "request" });
    assert.match(err((await dispatchWakes(n))[0].result as WakeResult), /busy/);
    assert.equal(calls, 3);
    assert.equal((n.store.db.prepare("SELECT count(*) n FROM wakes").get() as { n: number }).n, 1);
    assert.deepEqual(deliveries(n), [{ state: "delivered", note: null }]);
  });
});

test("reservation release is idempotent even when SQLite reuses the row id", (t) => {
  const n = new MbxNode(tmp(), { host: "alpha" });
  t.after(() => n.close());
  const at = Date.now();
  const first = n.reserveWake("web", "thread", at);
  assert.equal(first.brake, null);
  first.release!();
  const second = n.reserveWake("web", "thread", at);
  assert.equal(second.brake, null);
  first.release!();
  assert.equal((n.store.db.prepare("SELECT count(*) n FROM wakes").get() as { n: number }).n, 1);
  assert.match(n.takeWake("web", "thread", at)!, /batched/);
});

test("kimiHostedServer: only a live instances row for this very pid counts as hosted", () => {
  const home = tmp();
  assert.equal(kimiHostedServer(111, home), null, "no instances dir, no token");
  mkdirSync(join(home, "server/instances"), { recursive: true });
  assert.equal(kimiHostedServer(111, home), null, "token file alone is not enough");
  writeFileSync(join(home, "server.token"), "tok\n");
  writeFileSync(join(home, "server/instances/a.json"), JSON.stringify({ server_id: "a", pid: 111, host: "127.0.0.1", port: 6001 }));
  assert.equal(kimiHostedServer(222, home, () => true), null, "another pid's row does not host this session");
  assert.equal(kimiHostedServer(111, home, () => false), null, "a dead server row does not count");
  assert.deepEqual(kimiHostedServer(111, home, () => true), { url: "http://127.0.0.1:6001", token: "tok" });
  writeFileSync(join(home, "server/instances/b.json"), JSON.stringify({ server_id: "b", pid: 222, host: "127.0.0.1", port: 6002 }));
  assert.deepEqual(kimiHostedServer(222, home, () => true), { url: "http://127.0.0.1:6002", token: "tok" }, "picks the row whose pid is the session's");
  assert.deepEqual(kimiServer(home, () => true), { url: "http://127.0.0.1:6001", token: "tok" }, "kimiServer still returns the first live instance");
  assert.equal(kimiHostedServer(undefined, home, () => true), null, "no pid: never hosted");
});

// ---- wakeKimi against a fake kimi web server -----------------------------------------------------
test("wakeKimi submits the wake text as a user prompt with the bearer token", async () => {
  const { server, url, seen } = await fakeKimiServer({ model: "kimi-code/kimi-for-coding" });
  const r = await wakeKimi({ session_id: "session_t", pid: null }, "wake text here", { server: { url, token: "tok" } });
  assert.deepEqual(r, { ok: true, via: "kimi web" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].url, /\/api\/v1\/sessions\/session_t\/status$/);
  assert.equal(seen[0].auth, "Bearer tok");
  assert.equal(seen[1].method, "POST");
  assert.match(seen[1].url, /\/api\/v1\/sessions\/session_t\/prompts$/);
  assert.equal(seen[1].auth, "Bearer tok");
  const body = JSON.parse(seen[1].body) as { content: { type: string; text: string }[]; model?: string };
  assert.deepEqual(body.content, [{ type: "text", text: "wake text here" }]);
  assert.equal(body.model, undefined, "a session that already has a model needs no model field");
  server.close();
});

test("wakeKimi on a busy session returns retry and submits no prompt", async () => {
  const { server, url, seen } = await fakeKimiServer({ busy: true, model: "m" });
  const r = await wakeKimi({ session_id: "session_t", pid: null }, "wake", { server: { url, token: "tok" } });
  assert.deepEqual(r, { ok: false, via: "kimi web", error: "session busy", retry: true });
  assert.equal(seen.filter((s) => s.method === "POST").length, 0, "no prompt submitted while the session is mid-turn");
  server.close();
});

test("wakeKimi passes the server default model when the session has none bound (the 'Model not set' fix)", async () => {
  const { server, url, seen } = await fakeKimiServer({ model: null, defaultModel: "kimi-code/kimi-for-coding" });
  const r = await wakeKimi({ session_id: "session_t", pid: null }, "wake", { server: { url, token: "tok" } });
  assert.deepEqual(r, { ok: true, via: "kimi web" });
  const post = seen.find((s) => s.method === "POST")!;
  assert.equal((JSON.parse(post.body) as { model?: string }).model, "kimi-code/kimi-for-coding");
  server.close();
});

test("wakeKimi surfaces the server's 'Model not set' error when no model can be resolved", async () => {
  const { server, url } = await fakeKimiServer({ model: null, defaultModel: null, failPrompts: true });
  const r = await wakeKimi({ session_id: "session_t", pid: null }, "wake", { server: { url, token: "tok" } });
  assert.equal(r.ok, false);
  assert.match(err(r), /Model not set/);
  server.close();
});

test("wakeKimi reports HTTP and envelope failures", async () => {
  const { server, url, seen } = await fakeKimiServer({ model: null, defaultModel: null, failPrompts: true });
  const r = await wakeKimi({ session_id: "session_t", pid: null }, "wake", { server: { url, token: "tok" } });
  assert.equal(r.ok, false);
  assert.match(err(r), /Model not set/);
  assert.equal(seen.filter((s) => s.method === "POST").length, 1, "the failed submission was attempted and surfaced");
  // unreachable server: a plain error, not a throw
  const down = await wakeKimi({ session_id: "session_t", pid: null }, "wake", { server: { url: "http://127.0.0.1:9", token: "tok" } });
  assert.equal(down.ok, false);
  server.close();
});

test("wakeKimi refuses terminal TUI sessions (no instances row for the pid) without any HTTP call", async () => {
  const home = tmp();
  let httpCalls = 0;
  const { server, url } = await fakeKimiServer({ model: "m" });
  server.on("request", () => { httpCalls++; });
  await withKimiHome(home, async () => {
    const r = await wakeKimi({ session_id: "session_t", pid: 2 ** 22 + 12345 }, "wake");
    assert.deepEqual(r, { ok: false, via: "kimi web", error: "not a kimi web-hosted session" });
  });
  assert.equal(httpCalls, 0, "terminal sessions are rejected before any request");
  server.close();
});

// ---- dispatchWakes wiring ------------------------------------------------------------------------
test("dispatchWakes wakes a hosted kimi session with the shared brake and no desktop notice", async () => {
  const { server, url, seen } = await fakeKimiServer({ model: "kimi-code/kimi-for-coding" });
  const home = kimiHomeWithInstance(Number(new URL(url).port));
  const n = new MbxNode(tmp(), { host: "alpha" });
  await withKimiHome(home, async () => {
    n.registerAgent("web");
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_t049", pid: process.pid });
    n.send({ from: "boss", to: ["web"], subject: "ping", body: "check your inbox", kind: "request" });
    const out = await dispatchWakes(n);
    assert.deepEqual(out.map((o) => [o.agent, o.result.ok, o.result.via]), [["web", true, "kimi web"]]);
    assert.deepEqual(deliveries(n), [{ state: "notified", note: null }]);
    const post = seen.find((s) => s.method === "POST")!;
    const body = JSON.parse(post.body) as { content: { type: string; text: string }[]; model?: string };
    assert.match(body.content[0].text, /^\[mbx\] 1 new message\(s\) for web from boss/);
    assert.match(body.content[0].text, /mbx_inbox/);
    assert.equal(body.model, undefined, "session already has a model");
    assert.equal((n.store.db.prepare("SELECT count(*) n FROM wakes WHERE agent='web'").get() as { n: number }).n, 1, "one wake recorded against the shared brake");
  });
  n.close();
  server.close();
});

test("a busy hosted session is skipped without spending the brake, and is woken once idle", async () => {
  const state: FakeState = { busy: true, model: "kimi-code/kimi-for-coding" };
  const { server, url, seen } = await fakeKimiServer(state);
  const home = kimiHomeWithInstance(Number(new URL(url).port));
  const n = new MbxNode(tmp(), { host: "alpha" });
  await withKimiHome(home, async () => {
    n.registerAgent("web");
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_t049", pid: process.pid });
    n.send({ from: "boss", to: ["web"], subject: "ping", body: "one", kind: "request" });
    const first = await dispatchWakes(n);
    assert.equal(first[0].result.ok, false);
    assert.match(err(first[0].result as WakeResult), /busy/);
    assert.deepEqual(deliveries(n), [{ state: "delivered", note: null }], "mail stays queued while the session works");
    assert.equal((n.store.db.prepare("SELECT count(*) n FROM wakes WHERE agent='web'").get() as { n: number }).n, 0, "the busy gate spends no wake budget");
    state.busy = false;
    const second = await dispatchWakes(n);
    assert.deepEqual(second.map((o) => [o.result.ok, o.result.via]), [[true, "kimi web"]]);
    assert.deepEqual(deliveries(n), [{ state: "notified", note: null }]);
    assert.equal(seen.filter((s) => s.method === "POST").length, 1, "exactly one prompt, submitted once idle");
  });
  n.close();
  server.close();
});

test("the shared wake brake batches a second wake inside 30 s (same as the other adapters)", async () => {
  const { server, url, seen } = await fakeKimiServer({ model: "m" });
  const home = kimiHomeWithInstance(Number(new URL(url).port));
  const n = new MbxNode(tmp(), { host: "alpha" });
  await withKimiHome(home, async () => {
    n.registerAgent("web");
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_t049", pid: process.pid });
    n.send({ from: "boss", to: ["web"], subject: "one", body: "x", kind: "request" });
    assert.equal((await dispatchWakes(n))[0].result.ok, true);
    n.send({ from: "boss", to: ["web"], subject: "two", body: "y", kind: "request" });
    const out = await dispatchWakes(n);
    assert.equal(out.length, 0, "batched: no result row, mail accumulates into one wake");
    assert.equal(seen.filter((s) => s.method === "POST").length, 1, "no second HTTP wake within the brake window");
    assert.equal((n.store.db.prepare("SELECT count(*) n FROM deliveries WHERE state='delivered'").get() as { n: number }).n, 1, "the second message waits for the next pass");
  });
  n.close();
  server.close();
});

test("terminal kimi sessions are never woken: the wake falls back to the desktop notice", async () => {
  const { server, url } = await fakeKimiServer({ model: "m" });
  const home = tmp(); // no instances: nothing is hosted
  const n = new MbxNode(tmp(), { host: "alpha" });
  await withKimiHome(home, async () => {
    n.registerAgent("term");
    bindWakeLease(n, { agent: "term", cli: "kimi", session_id: "session_term", pid: process.pid });
    n.send({ from: "boss", to: ["term"], subject: "ping", body: "check your inbox", kind: "request" });
    const out = await dispatchWakes(n);
    assert.equal(out.length, 1);
    assert.equal(out[0].result.ok, false);
    assert.equal(out[0].result.via, "kimi web", "the desktop is disabled in tests, so the original failure surfaces");
    assert.deepEqual(deliveries(n), [{ state: "notified", note: "desktop" }]);
    assert.equal(n.deliveryMode("term"), "no push: new mail shows on your user's next prompt, or when your [mbx-watch] self-check runs");
  });
  n.close();
  server.close();
});

test("mail that only reached the desktop is retried when a hosted kimi session binds", async () => {
  const { server, url } = await fakeKimiServer({ model: "m" });
  const home = kimiHomeWithInstance(Number(new URL(url).port));
  const n = new MbxNode(tmp(), { host: "alpha" });
  await withKimiHome(home, async () => {
    n.registerAgent("web");
    const id = n.send({ from: "boss", to: ["web"], subject: "s", body: "b", kind: "request" }).envelope.id;
    n.setDelivery(id, "web", "notified", "desktop");
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_t049", pid: process.pid });
    assert.equal((n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=?").get(id) as { state: string }).state, "delivered", "a hosted binding re-queues desktop-only mail for a real wake");
    assert.equal(n.deliveryMode("web"), "push (kimi web)");
  });
  n.close();
  server.close();
});

for (const change of ["release-before-post", "policy-before-post", "ack-before-post", "release-after-post", "ack-after-post"]) test(`wake rechecks authority across async adapter work: ${change}`, async t => {
  const n = new MbxNode(tmp(), { host: "alpha" }); t.after(() => n.close());
  let statusCalls = 0, prompts = 0, id = "";
  await withKimiHome(kimiHomeWithInstance(12345), async () => {
    const holder = bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_fence", pid: process.pid });
    id = n.send({ from: "boss", to: ["web"], subject: "guarded", body: "private", kind: "request" }).envelope.id;
    const mutate = () => {
      if (change.startsWith("release")) holder.release();
      else if (change.startsWith("policy")) n.store.db.prepare("UPDATE policies SET revoked=1").run();
      else n.ack(id, "web");
    };
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      if (String(input).endsWith("/status")) {
        statusCalls++;
        if (statusCalls === 2 && change.endsWith("before-post")) mutate();
        return Response.json({ code: 0, data: { busy: false, model: "m" } });
      }
      assert.ok(String(input).endsWith("/prompts")); prompts++;
      if (change.endsWith("after-post")) mutate();
      return Response.json({ code: 0, data: { prompt_id: "p" } });
    });
    const result = await dispatchWakes(n);
    assert.equal(result[0].result.ok, false); assert.equal(result[0].result.via, "lease");
    assert.equal(prompts, change.endsWith("before-post") ? 0 : 1);
    assert.equal(n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=?").get(id)!.state, change.startsWith("ack") ? "acked" : "delivered");
    assert.equal(n.store.db.prepare("SELECT count(*) n FROM wakes").get()!.n, change.endsWith("before-post") ? 0 : 1,
      "only known-unsent submissions refund their reservation");
  });
});

for (const downgrade of ["unverified", "relay-limit", "no-policy"]) test(`daemon never submits automatic prompts for ${downgrade} mail`, async t => {
  const n = new MbxNode(tmp(), { host: "alpha" }); t.after(() => n.close());
  await withKimiHome(kimiHomeWithInstance(12345), async () => {
    bindWakeLease(n, { agent: "web", cli: "kimi", session_id: "session_policy", pid: process.pid });
    if (downgrade === "no-policy") n.store.db.prepare("UPDATE policies SET revoked=1").run();
    const id = n.send({ from: "claimed", to: ["web"], subject: "ask", body: "private", kind: "request",
      unverifiedSender: downgrade === "unverified", hop: downgrade === "relay-limit" ? 1000 : undefined }).envelope.id;
    let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not call provider"); });
    await dispatchWakes(n);
    assert.equal(calls, 0); assert.equal(n.unreadCount("web"), 1);
    assert.equal(n.store.db.prepare("SELECT note FROM deliveries WHERE msg_id=?").get(id)!.note, "desktop");
  });
});
