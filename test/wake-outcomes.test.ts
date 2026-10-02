// T178: provider adapters report typed outcomes (docs/spec/provider-wake-contract.md WC-06..WC-10) and the dispatcher
// decides from them: status never wakes, an uncertain submission is never repeated, receipts keep their strength.
import { sendLeased } from "./helpers/leased-send.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { MbxNode } from "../src/node.ts";
import { dispatchWakes, muteWakes, UNKNOWN_HOLD_MS, wakeCodex, wakeOpencode, wakeText } from "../src/wake.ts";
import type { WakeOutcome } from "../src/wake-contract.ts";
import { statusWakeWarning, type Envelope } from "../src/mcp.ts";

function fixture(t: { after: (fn: () => void | Promise<void>) => unknown }, codexScript = 'printf "%s\\n" "$3" >> "$MBX_TEST_WAKE_LOG"') {
  const home = mkdtempSync(join(tmpdir(), "mbx-wake-outcome-"));
  const n = new MbxNode(home, { host: "alpha" });
  const log = join(home, "calls"), bin = join(home, "codex");
  writeFileSync(bin, `#!/bin/sh\n${codexScript}\n`, { mode: 0o700 });
  const keys = ["MBX_CODEX_BIN", "MBX_TEST_WAKE_LOG", "MBX_NO_DESKTOP", "MBX_OPENCODE_URL"] as const;
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { MBX_CODEX_BIN: bin, MBX_TEST_WAKE_LOG: log, MBX_NO_DESKTOP: "1" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return { n, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [] };
}
const delivery = (n: MbxNode, agent: string) => n.store.db.prepare("SELECT state, note FROM deliveries WHERE agent=?").all(agent) as { state: string; note: string | null }[];

test("a status message never wakes, even with a mention and needs_reply; it stays unread (WC-06)", async (t) => {
  const { n, calls } = fixture(t);
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "11111111-1111-4111-8111-111111111111", pid: process.pid });
  sendLeased(n, { from: "sender", to: ["worker"], subject: "fyi", body: "@worker build is green", kind: "status", needs_reply: true });
  assert.deepEqual(await dispatchWakes(n), []);
  assert.deepEqual(calls(), [], "no provider write");
  assert.equal(n.unreadCount("worker"), 1, "the status message waits for the next prompt");
  sendLeased(n, { from: "sender", to: ["worker"], subject: "please look", body: "need you", kind: "request" });
  assert.equal((await dispatchWakes(n))[0].result.ok, true, "a request still wakes");
  assert.equal(calls().length, 1);
});

test("codex exit 0 is admitted with exit-status strength; a missing binary is not_submitted; a failing exit is failed (WC-10)", async (t) => {
  const { calls } = fixture(t);
  const ok = await wakeCodex("22222222-2222-4222-8222-222222222222", "[mbx] hint");
  assert.equal(ok.outcome?.kind, "admitted");
  assert.equal(ok.outcome?.kind === "admitted" && ok.outcome.receipt.strength, "exit-status");
  assert.equal(calls().length, 1);
  process.env.MBX_CODEX_BIN = "/nonexistent/codex";
  const missing = await wakeCodex("22222222-2222-4222-8222-222222222222", "[mbx] hint");
  assert.equal(missing.outcome?.kind === "not_submitted" && missing.outcome.reason, "unavailable");
  const dir = mkdtempSync(join(tmpdir(), "mbx-codex-fail-")), bad = join(dir, "codex");
  writeFileSync(bad, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
  process.env.MBX_CODEX_BIN = bad;
  const failed = await wakeCodex("22222222-2222-4222-8222-222222222222", "[mbx] hint");
  assert.equal(failed.outcome?.kind === "failed" && failed.outcome.status, 2);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  let fenced = false;
  const r = await wakeCodex("22222222-2222-4222-8222-222222222222", "[mbx] hint", { recheck: () => fenced });
  assert.equal(r.outcome?.kind === "not_submitted" && r.outcome.reason, "fenced", "a fenced attempt writes nothing");
});

/** OpenCode service fake whose synthetic endpoint answers with `answer` and records every write. */
function opencode(t: { after: (fn: () => void | Promise<void>) => unknown }, answer: (session: string, text: string) => unknown) {
  const writes: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
      const m = /^\/api\/session\/([^/]+)\/synthetic$/.exec(new URL(req.url ?? "/", "http://x").pathname);
      if (!m || req.method !== "POST") { res.writeHead(404).end("{}"); return; }
      writes.push(m[1]);
      res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify(answer(m[1], JSON.parse(body).text)));
    });
  });
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { writes, listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

test("a mismatched receipt is unknown, and an unknown attempt is never repeated on any session (WC-07, WC-08)", async (t) => {
  const { n } = fixture(t);
  const svc = opencode(t, (session, text) => ({ data: { id: "msg_x", sessionID: `${session}-other`, type: "synthetic", delivery: "queue", payload: { text }, time: { created: 1 } } }));
  process.env.MBX_OPENCODE_URL = await svc.listen();
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: "ses_first", pid: process.pid });
  bindWakeLease(n, { agent: "worker", cli: "opencode", session_id: "ses_second", pid: process.pid });
  sendLeased(n, { from: "sender", to: ["worker"], subject: "wake", body: "private", kind: "request" });
  const [r] = await dispatchWakes(n);
  const o = (r.result as { outcome?: WakeOutcome }).outcome;
  assert.equal(o?.kind === "unknown" && o.reason, "mismatched-receipt");
  assert.equal(svc.writes.length, 1, "one write in the pass: the second session was not tried");
  assert.deepEqual(delivery(n, "worker").map((d) => d.note), ["unknown"], "held for reconciliation, not re-woken by the next pass");
  assert.deepEqual(await dispatchWakes(n), []);
  assert.equal(svc.writes.length, 1, "the next pass does not resubmit");
  assert.equal(n.unreadCount("worker"), 1, "the mail itself stays unread and readable");
});

test("opencode: an unreachable service is not_submitted, a timeout after the write is unknown, a rejection is failed", async (t) => {
  fixture(t);
  const closed = createServer(); // a port that was just released: connections are refused before anything is sent
  const port = await new Promise<number>((r) => closed.listen(0, "127.0.0.1", () => r((closed.address() as AddressInfo).port)));
  await new Promise<void>((r) => closed.close(() => r()));
  const service = async () => ({ url: `http://127.0.0.1:${port}`, auth: "" });
  const refused = await wakeOpencode("ses_x", "[mbx] hint", { service });
  assert.equal(refused.outcome?.kind === "not_submitted" && refused.outcome.reason, "unavailable");
  const slow = await wakeOpencode("ses_x", "[mbx] hint", { service, fetch: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as typeof fetch });
  assert.equal(slow.outcome?.kind === "unknown" && slow.outcome.reason, "timeout");
  const rejected = await wakeOpencode("ses_x", "[mbx] hint", { service, fetch: (async () => new Response("no such session", { status: 404 })) as typeof fetch });
  assert.equal(rejected.outcome?.kind === "failed" && rejected.outcome.status, 404);
  assert.equal(rejected.ok, false);
});

test("a sender who marks a status as needing attention is told it will not wake anyone", () => {
  const e = (kind: string, needs_reply: boolean, mentions: string[]) => ({ kind, needs_reply, meta: { mentions } }) as unknown as Envelope;
  assert.match(statusWakeWarning(e("status", true, []))[0], /never wakes.*kind=request/);
  assert.equal(statusWakeWarning(e("status", false, ["worker"])).length, 1);
  assert.deepEqual(statusWakeWarning(e("status", false, [])), [], "a plain progress update needs no warning");
  assert.deepEqual(statusWakeWarning(e("request", true, [])), []);
});

test("an attempt interrupted before its result was recorded is held as unknown, not submitted twice (WC-14)", async (t) => {
  const { n, calls } = fixture(t);
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "33333333-3333-4333-8333-333333333333", pid: process.pid });
  const m = sendLeased(n, { from: "sender", to: ["worker"], subject: "wake", body: "private", kind: "request" }).envelope;
  // what a daemon killed right after the native write leaves behind
  n.store.set("wake-attempt:worker", JSON.stringify({ attemptId: "01ATTEMPT", agent: "worker", messageIds: [m.id], sessionId: "x", at: new Date().toISOString() }));
  assert.deepEqual(await dispatchWakes(n), []);
  assert.deepEqual(calls(), [], "no second write for a possibly admitted hint");
  assert.deepEqual(delivery(n, "worker").map((d) => d.note), ["unknown"]);
  assert.equal(n.store.get("wake-attempt:worker"), undefined);
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='wake.unknown' AND detail LIKE '%killed%'").get());
  // after the hold, the mail may be woken once more, still under the brake
  await dispatchWakes(n, Date.now() + UNKNOWN_HOLD_MS + 60_000);
  assert.equal(calls().length, 1, "held mail is retried once the hold elapses");
  assert.deepEqual(delivery(n, "worker").map((d) => d.note), [null]);
});

test("mute suppresses hints and notices while mail stays unread; unmute resumes (WC-17)", async (t) => {
  const { n, calls } = fixture(t);
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "44444444-4444-4444-8444-444444444444", pid: process.pid });
  muteWakes(n, "worker", new Date(Date.now() + 60_000));
  sendLeased(n, { from: "sender", to: ["worker"], subject: "wake", body: "private", kind: "request" });
  assert.deepEqual(await dispatchWakes(n), []);
  assert.deepEqual(calls(), []);
  assert.deepEqual(delivery(n, "worker").map((d) => d.state), ["delivered"], "the mail waits, unread, for the mute to end");
  muteWakes(n, "worker", null);
  assert.equal((await dispatchWakes(n))[0].result.ok, true);
  assert.equal(calls().length, 1);
});

test("a busy backoff defers the next attempt instead of asking every pass", async (t) => {
  const { n, calls } = fixture(t);
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "55555555-5555-4555-8555-555555555555", pid: process.pid });
  n.store.set("wake-busy:worker", JSON.stringify({ n: 3, next: Date.now() + 16_000 }));
  sendLeased(n, { from: "sender", to: ["worker"], subject: "wake", body: "private", kind: "request" });
  assert.deepEqual(await dispatchWakes(n), []);
  assert.deepEqual(calls(), []);
  assert.equal((await dispatchWakes(n, Date.now() + 20_000))[0].result.ok, true);
  assert.equal(n.store.get("wake-busy:worker"), undefined, "a successful wake clears the backoff");
});

test("a wake hint names its message ids and says a handled message needs no action (T195)", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-hint-"));
  const n = new MbxNode(home, { host: "alpha" });
  try {
    const ms = Array.from({ length: 7 }, (_, i) => n.message(n.send({ from: "sender", to: ["worker"], subject: `s${i}`, body: `secret body ${i}`, kind: "request" }).envelope.id)!);
    const text = wakeText("worker", ms);
    assert.match(text, /^\[mbx\]/, "still an AgentMBX prompt: never resets relay depth");
    for (const m of ms.slice(0, 5)) assert.ok(text.includes(m.id));
    assert.match(text, /\+2 more/);
    assert.match(text, /mbx_inbox or mbx_read, reply, ack\. Already handled: no action needed\./);
    assert.ok(!text.includes("secret body"), "never a body");
  } finally { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
