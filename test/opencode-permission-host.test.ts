// T521: a standalone OpenCode plugin answers a permission in its own serve. The daemon pass
// calls the shared service only for a service-hosted binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { startServer } from "../src/http.ts";
import { MbxNode } from "../src/node.ts";
import type { OpencodeHost } from "../src/opencode-provider.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { opencodePermissionPass } from "../src/permission.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { version } from "../src/version.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function grantYolo(node: MbxNode, agent: string): void {
  if (!node.ownerPub) { createOwnerKey(node.home, "test-only-passphrase"); node.syncOwner(); }
  const owner = unlockOwnerKey(node.home, "test-only-passphrase");
  const rec = makePolicy({ level: "yolo", agents: [agent], hosts: [node.host], ownerPub: owner.publicKey });
  const error = acceptSigned(node.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, node.host);
  if (error) throw new Error(error);
}

test("GET /v1/opencode-permission allows a live yolo binding and skips everything else", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t521-route-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/v1/opencode-permission`;
  const pid = process.pid;
  try {
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
    assert.equal((await fetch(base)).status, 400);
    assert.equal((await fetch(`${base}?session=ses_x&pid=0`)).status, 400);
    const unbound = await fetch(`${base}?session=${encodeURIComponent("ses_missing")}&pid=${pid}`);
    assert.equal(unbound.status, 200);
    assert.deepEqual(await unbound.json(), { skip: true });

    const allowed = bindWakeLease(node, { cli: "opencode", pid, agent: "mbx-yolo", session_id: "ses_allow" });
    const skipped = bindWakeLease(node, { cli: "opencode", pid, agent: "mbx-auto", session_id: "ses_skip" });
    grantYolo(node, "mbx-yolo");

    const yes = await fetch(`${base}?session=ses_allow&pid=${pid}`);
    assert.equal(yes.status, 200);
    assert.deepEqual(await yes.json(), { decision: "allow" });

    const noClass = await fetch(`${base}?session=ses_skip&pid=${pid}`);
    assert.equal(noClass.status, 200);
    assert.deepEqual(await noClass.json(), { skip: true });

    const wrongPid = await fetch(`${base}?session=ses_allow&pid=${pid + 1}`);
    assert.deepEqual(await wrongPid.json(), { skip: true });

    const foreign = await fetch(`${base}?session=${encodeURIComponent("mcp-not-a-session")}&pid=${pid}`);
    assert.deepEqual(await foreign.json(), { skip: true });

    allowed.release();
    const released = await fetch(`${base}?session=ses_allow&pid=${pid}`);
    assert.deepEqual(await released.json(), { skip: true });
    void skipped;
  } finally {
    await closeServer(server);
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("opencodePermissionPass calls the shared service only for a service host", async () => {
  for (const kind of ["service", "standalone", "unknown"] as const) {
    const home = mkdtempSync(join(tmpdir(), "mbx-t521-pass-"));
    const node = new MbxNode(home, { host: "alpha" });
    bindWakeLease(node, { cli: "opencode", pid: process.pid, agent: "mbx-yolo", session_id: "ses_allow" });
    let svcCalls = 0;
    let fetches = 0;
    const fake = (async (_url: string, init: RequestInit = {}) => {
      fetches++;
      if ((init.method ?? "GET") === "POST") return new Response(null, { status: 204 });
      return Response.json({ data: [{ id: "per_1", sessionID: "ses_allow", action: "bash" }] });
    }) as typeof fetch;
    try {
      const n = await opencodePermissionPass(node, () => ({ ok: true, policy_id: "pol_1" }), async () => {
        svcCalls++;
        return { url: "http://oc", auth: "" };
      }, fake, () => kind satisfies OpencodeHost);
      if (kind === "service") {
        assert.equal(n, 1);
        assert.equal(svcCalls, 1);
        assert.equal(fetches, 2);
      } else {
        assert.equal(n, 0);
        assert.equal(svcCalls, 0, `${kind} must not call svc()`);
        assert.equal(fetches, 0, `${kind} must not fetch`);
      }
    } finally {
      node.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("the standalone plugin sets effect allow only when the route says allow", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t521-plugin-"));
  const node = new MbxNode(home, { host: "alpha" });
  const server = await startServer(node, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const pid = process.pid;
  const allowed = bindWakeLease(node, { cli: "opencode", pid, agent: "mbx-yolo", session_id: "ses_allow" });
  bindWakeLease(node, { cli: "opencode", pid, agent: "mbx-auto", session_id: "ses_skip" });
  grantYolo(node, "mbx-yolo");
  void allowed;
  const dir = mkdtempSync(join(tmpdir(), "mbx-t521-src-"));
  const g = globalThis as { __mbxWakePort?: string | null; __mbxSpawn?: unknown };
  const prevPort = g.__mbxWakePort;
  const prevSpawn = g.__mbxSpawn;
  const argv = process.argv.slice();
  g.__mbxWakePort = String(port);
  g.__mbxSpawn = () => { throw new Error("T521: the permission path must not spawn a hook"); };
  const hooks: Array<{ name: string; fn: (req: { sessionID?: string; effect?: string }) => Promise<void> | void }> = [];
  try {
    const src = opencodePluginSource(["/opt/bin/agentmbx"], version());
    assert.equal(src.includes("/api/session/"), false);
    assert.equal(src.includes("opencodeService"), false);
    assert.equal(src.split("watchPermission(ctx)").length - 1, 2);
    assert.equal(src.includes("/v1/opencode-wake"), true);
    assert.equal(src.includes("/v1/opencode-permission"), true);
    writeFileSync(join(dir, "agentmbx.ts"), src);
    const mod = await import(join(dir, "agentmbx.ts")) as {
      default: { setup: (ctx: unknown) => Promise<unknown> };
    };
    const ctx = {
      location: { directory: "/work" },
      event: { subscribe: () => undefined },
      session: { synthetic: async () => ({ id: "msg_unused" }) },
      permission: {
        hook: (name: string, fn: (req: { sessionID?: string; effect?: string }) => Promise<void> | void) => {
          hooks.push({ name, fn });
        },
      },
    };
    process.argv = ["opencode", "serve", "--service"];
    await mod.default.setup(ctx);
    assert.equal(hooks.length, 0, "a service-hosted plugin must not register evaluate");
    process.argv = ["opencode", "serve", "--stdio"];
    await mod.default.setup(ctx);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0]?.name, "evaluate");
    const evaluate = hooks[0]!.fn;
    const allow = { sessionID: "ses_allow", effect: "ask" };
    await evaluate(allow);
    assert.equal(allow.effect, "allow");
    const skip = { sessionID: "ses_skip", effect: "ask" };
    await evaluate(skip);
    assert.equal(skip.effect, "ask");
    const missing = { sessionID: "ses_missing", effect: "ask" };
    await evaluate(missing);
    assert.equal(missing.effect, "ask");
  } finally {
    process.argv = argv;
    if (prevPort === undefined) delete g.__mbxWakePort;
    else g.__mbxWakePort = prevPort;
    if (prevSpawn === undefined) delete g.__mbxSpawn;
    else g.__mbxSpawn = prevSpawn;
    await closeServer(server);
    node.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
