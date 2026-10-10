// T519: a standalone OpenCode binding is woken through the plugin in that serve. The shared service
// POST stays the service-hosted path (covered in opencode-no-duplicate-loop.test.ts) and is not used here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { OPENCODE_STANDALONE_NO_PUSH, wakeOpencode } from "../src/wake.ts";
import {
  completeOpencodeWake, listOpencodeWakeWaiters, opencodeWakeWaiting, pushOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake,
} from "../src/opencode-wake-queue.ts";
import { version } from "../src/version.ts";

const noFetch = (async () => { throw new Error("T519: the shared service must not be called"); }) as typeof fetch;
const noService = async () => { throw new Error("T519: service discovery must not run"); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(10);
  return pred();
}

test("plugin template polls the loopback queue and still never calls the shared service", () => {
  const src = opencodePluginSource(["/opt/bin/agentmbx"], version());
  assert.ok(src.includes("/v1/opencode-wake"), "loopback queue");
  assert.ok(src.includes("__mbxWakePort"), "tests can disable the poll");
  assert.ok(src.includes('id.startsWith("msg_")'), "the receipt is a native msg_ id");
  assert.ok(!src.includes("/api/session") && !src.includes('["service", "status"]'), "no shared-service call");
});

test("queue: matching pid delivers once; wrong pid, bad id, and a missing receipt do not resubmit", async () => {
  resetOpencodeWakeQueue();
  try {
    const waiting = waitForOpencodeWake("ses_q", 7, 2_000);
    assert.equal(opencodeWakeWaiting("ses_q", 7), true);
    assert.deepEqual(await pushOpencodeWake("ses_q", 8, "nope", 30), { ok: false, handedOff: false });
    const pushed = pushOpencodeWake("ses_q", 7, "hello", 500);
    assert.equal(await waiting, "hello");
    assert.equal(completeOpencodeWake("ses_q", "nope"), false);
    assert.equal(completeOpencodeWake("ses_q", "msg_native"), true);
    assert.equal(completeOpencodeWake("ses_q", "msg_native"), false);
    assert.deepEqual(await pushed, { ok: true, id: "msg_native" });

    const held = waitForOpencodeWake("ses_hold", 7, 2_000);
    const late = pushOpencodeWake("ses_hold", 7, "late", 50);
    assert.equal(await held, "late");
    assert.deepEqual(await late, { ok: false, handedOff: true });

    const first = waitForOpencodeWake("ses_rep", 7, 2_000);
    const second = waitForOpencodeWake("ses_rep", 7, 2_000);
    assert.equal(await first, null, "a new poller replaces one that has not been offered a wake");
    const again = pushOpencodeWake("ses_rep", 7, "second", 500);
    assert.equal(await second, "second");
    assert.equal(completeOpencodeWake("ses_rep", "msg_second"), true);
    assert.deepEqual(await again, { ok: true, id: "msg_second" });

    assert.deepEqual(await pushOpencodeWake("ses_none", 7, "x", 20), { ok: false, handedOff: false });
  } finally { resetOpencodeWakeQueue(); }
});

test("GET/POST /v1/opencode-wake holds on loopback and completes only a msg_ receipt", async () => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t519-http-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/v1/opencode-wake`;
  try {
    assert.equal((await fetch(base, { method: "PUT" })).status, 405);
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal((await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: "ses_h", id: "msg_early" }) })).status, 409);
    const pending = fetch(`${base}?session=${encodeURIComponent("ses_h")}&pid=42`);
    assert.equal(await until(() => opencodeWakeWaiting("ses_h", 42)), true);
    const pushed = pushOpencodeWake("ses_h", 42, "via-http", 2_000);
    const res = await pending;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "via-http" });
    const posted = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: "ses_h", id: "msg_http" }) });
    assert.equal(posted.status, 200);
    assert.deepEqual(await pushed, { ok: true, id: "msg_http" });
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 200, "the public status route is unchanged");
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/agents`)).status, 401, "the queue does not authorize a signed route");
  } finally {
    await closeServer(server);
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    resetOpencodeWakeQueue();
  }
});

test("wakeOpencode: the plugin in the matching serve admits, and the receipt is the host's msg_ id", async () => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t519-plugin-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "mbx-t519-src-"));
  const g = globalThis as { __mbxWakePort?: string | null; __mbxSpawn?: unknown };
  const prevPort = g.__mbxWakePort;
  g.__mbxWakePort = String(port);
  const notes: Array<{ sessionID: string; id?: string; text: string; resume: boolean; delivery: string }> = [];
  g.__mbxSpawn = (_bin: string[], args: string[], _input: string, cb: (out: string) => void) => {
    cb(args[0] === "hook" ? JSON.stringify({ decision: "block", reason: "[mbx] hook note" }) : "");
  };
  try {
    writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
    const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, unknown>> };
    const hooks = await mod.AgentMBXHooks({
      directory: "/work",
      session: {
        synthetic: async (body: { sessionID: string; id?: string; text: string; resume: boolean; delivery: string }) => {
          notes.push(body);
          if (body.text === "[mbx] from daemon") return { data: { id: "msg_fromhost" } };
          if (body.text === "[mbx] direct") return { id: "msg_direct" };
          return { id: body.id };
        },
      },
    });
    const event = hooks.event as (e: unknown) => Promise<void>;
    await event({ event: { type: "session.created", properties: { info: { id: "ses_live" } } } });
    assert.equal(await until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === "ses_live" && w.pid === process.pid)), true);
    const admitted = await wakeOpencode("ses_live", "[mbx] from daemon", { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });
    assert.equal(admitted.ok, true);
    assert.equal(admitted.outcome?.kind === "admitted" && admitted.outcome.receipt.nativeId, "msg_fromhost");
    const wake = notes.find((n) => n.text === "[mbx] from daemon");
    assert.ok(wake, "the wake was admitted in-process");
    assert.equal(wake?.resume, false);
    assert.equal(wake?.delivery, "queue");
    assert.notEqual(wake?.id, "msg_fromhost", "the receipt is the id the host returned");

    await event({ event: { type: "session.idle", properties: { info: { id: "ses_direct" } } } });
    assert.equal(await until(() => listOpencodeWakeWaiters().some((w) => w.sessionID === "ses_direct" && w.pid === process.pid)), true);
    const direct = await wakeOpencode("ses_direct", "[mbx] direct", { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });
    assert.equal(direct.outcome?.kind === "admitted" && direct.outcome.receipt.nativeId, "msg_direct");

    const missed = await wakeOpencode("ses_none", "[mbx] x", { pid: process.pid, host: () => "standalone", service: noService, fetch: noFetch });
    assert.equal(missed.ok, false);
    assert.equal(missed.outcome?.kind === "not_submitted" && missed.outcome.detail, OPENCODE_STANDALONE_NO_PUSH);

    const held = waitForOpencodeWake("ses_gap", 5, 2_000);
    const gap = wakeOpencode("ses_gap", "gap", { pid: 5, host: () => "standalone", service: noService, fetch: noFetch });
    assert.equal(await held, "gap");
    resetOpencodeWakeQueue();
    const lost = await gap;
    assert.equal(lost.ok, false);
    assert.equal(lost.outcome?.kind, "unknown");
    assert.equal(lost.outcome?.kind === "unknown" && lost.outcome.reason, "lost-response");
  } finally {
    g.__mbxWakePort = null;
    delete g.__mbxSpawn;
    await closeServer(server);
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(dir, { recursive: true, force: true });
    g.__mbxWakePort = prevPort === undefined ? null : prevPort;
    resetOpencodeWakeQueue();
  }
});

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
}
