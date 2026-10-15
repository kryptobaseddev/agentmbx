// T646: one session loaded by a standalone tab and by the shared service. Each serve polls independently, a wake for a
// service-bound row goes to the tab's plugin when one is polling, and the service never gets a resume:true POST for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MbxNode } from "../src/node.ts";
import { startServer } from "../src/http.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { OPENCODE_DUAL_HOST_NO_PUSH, wakeOpencode } from "../src/wake.ts";
import { completeOpencodeWake, listOpencodeWakeWaiters, pushOpencodeWake, resetOpencodeWakeQueue, waitForOpencodeWake } from "../src/opencode-wake-queue.ts";
import { version } from "../src/version.ts";

const noFetch = (async () => { throw new Error("T646: the shared service must not be called"); }) as typeof fetch;
const noService = async () => { throw new Error("T646: service discovery must not run"); };
const SERVICE = 6301, TAB = 9150;
const hosts = (pid: number | null | undefined) => pid === SERVICE ? "service" as const : "standalone" as const;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("T646 queue: two serves polling one session keep separate slots", async () => {
  resetOpencodeWakeQueue();
  try {
    const service = waitForOpencodeWake("ses_d", SERVICE, 2_000), tab = waitForOpencodeWake("ses_d", TAB, 2_000);
    assert.deepEqual(listOpencodeWakeWaiters().map(w => w.pid).sort(), [SERVICE, TAB].sort());
    const pushed = pushOpencodeWake("ses_d", TAB, "hello", 500);
    assert.equal(await tab, "hello");
    assert.equal(completeOpencodeWake("ses_d", "msg_tab"), true);
    assert.deepEqual(await pushed, { ok: true, id: "msg_tab", turnSince: null });
    assert.deepEqual(listOpencodeWakeWaiters(), [{ sessionID: "ses_d", pid: SERVICE }], "the service's own poll was not cancelled");
    resetOpencodeWakeQueue();
    assert.equal(await service, null);
  } finally { resetOpencodeWakeQueue(); }
});

test("T646: a service-bound wake goes to the tab's plugin instead of a service POST", async () => {
  resetOpencodeWakeQueue();
  try {
    const tab = waitForOpencodeWake("ses_d", TAB, 2_000);
    const result = wakeOpencode("ses_d", "[mbx] wake", { pid: SERVICE, host: hosts, service: noService, fetch: noFetch });
    assert.equal(await tab, "[mbx] wake");
    completeOpencodeWake("ses_d", "msg_fromtab");
    const r = await result;
    assert.equal(r.outcome?.kind === "admitted" && r.outcome.receipt.nativeId, "msg_fromtab");
  } finally { resetOpencodeWakeQueue(); }
});

test("T646: a tab that can't take the wake now means no service POST either", async () => {
  resetOpencodeWakeQueue();
  const r = await wakeOpencode("ses_d", "[mbx] wake", { pid: SERVICE, host: hosts, service: noService, fetch: noFetch,
    waiters: () => [{ sessionID: "ses_d", pid: TAB }] });
  assert.equal(r.ok, false);
  assert.equal(r.outcome?.kind === "not_submitted" && r.outcome.detail, OPENCODE_DUAL_HOST_NO_PUSH);
});

test("T646 plugin: the shared service's plugin does not poll the wake queue", async () => {
  resetOpencodeWakeQueue();
  const home = mkdtempSync(join(tmpdir(), "mbx-t646-plugin-")), dir = mkdtempSync(join(tmpdir(), "mbx-t646-src-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const g = globalThis as { __mbxWakePort?: string | null; __mbxSpawn?: unknown };
  const prevPort = g.__mbxWakePort;
  g.__mbxWakePort = String((server.address() as AddressInfo).port);
  g.__mbxSpawn = (_bin: string[], _args: string[], _input: string, cb: (out: string) => void) => cb("");
  process.argv.push("--service");
  try {
    writeFileSync(join(dir, "agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()));
    const mod = await import(join(dir, "agentmbx.ts")) as { AgentMBXHooks: (ctx: unknown) => Promise<Record<string, unknown>> };
    const hooks = await mod.AgentMBXHooks({ directory: "/work", session: { synthetic: async () => ({ id: "msg_x" }) } });
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: "session.created", properties: { info: { id: "ses_svc" } } } });
    await sleep(500);
    assert.equal(listOpencodeWakeWaiters().some(w => w.sessionID === "ses_svc"), false);
  } finally {
    process.argv.splice(process.argv.indexOf("--service"), 1);
    g.__mbxWakePort = prevPort === undefined ? null : prevPort;
    delete g.__mbxSpawn;
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(dir, { recursive: true, force: true });
    resetOpencodeWakeQueue();
  }
});
