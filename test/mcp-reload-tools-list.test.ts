// T506: lock in the T469 fix. On 2026-10-06 (21:44-21:52Z) four sessions logged "Failed to fetch tools: Connection closed"
// 15-20ms after tools/list_changed during an in-place reload. A client that refreshes its catalog straight from the
// notification must get the full tool list back on the same transport, and the transport must stay open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { MbxNode } from "../src/node.ts";

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

test("tools/list refreshed straight from tools/list_changed returns the full catalog after an in-place reload", async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-reload-list-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  // Distinct registered names: startup may temporarily register and remove a name before its real tool is installed.
  const registered = [...new Set([...readFileSync(join(install, "dist/mcp.js"), "utf8").matchAll(/server\.registerTool\("([a-z_]+)"/g)].map(m => m[1]))].sort();
  assert.ok(registered.length > 0, "the installed build must register tools");

  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "reload-list-test", version: "1" });
  // Anything that closes or breaks the transport during the reload shows up here, not only in a rejected request.
  const transportEvents: string[] = [];
  client.onclose = () => transportEvents.push("close");
  client.onerror = error => transportEvents.push(`error: ${error.message}`);
  // Claude refreshes immediately on the notification, before the next agent tool call (the 15-20ms window of the incident).
  let catalogChanges = 0;
  const refreshes: Promise<Awaited<ReturnType<typeof client.listTools>>>[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    catalogChanges++;
    const refresh = client.listTools(); refresh.catch(() => {}); refreshes.push(refresh);
  });
  t.after(async () => { await client.close(); node.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // The provider may unref the replacement's stdin; keep that so the replacement is held up only by its own timers.
  const preload = join(root, "unref-stdio.mjs");
  writeFileSync(preload, `if (process.env.MBX_MCP_REEXEC) {
    const input = process.stdin, on = input.on;
    input.on = function(event, ...args) { const value = on.call(this, event, ...args);
      if (event === 'data') queueMicrotask(() => input.unref?.()); return value; };
  }`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import=${preload}`, HOME: root, XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    MBX_HOME: home, MBX_AGENT: "reload-reader", MBX_CLI: "claude", MBX_NO_DESKTOP: "1" };
  for (const key of ["AGENTMBX_DEV", "MBX_MCP_REEXEC", "MBX_MCP_REEXEC_BUILD", "MBX_MCP_DETACHED", "MBX_MCP_PROVIDER_PID", "MBX_MCP_ORIGINAL_PID"]) delete env[key];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string> }));

  const before = (await client.listTools()).tools;
  assert.equal(before.length, new Set(before.map(tool => tool.name)).size, "the live catalog has no duplicate tool names");
  assert.deepEqual(before.map(tool => tool.name).sort(), registered, "the first connection serves the full catalog");
  assert.equal(catalogChanges, 0, "fresh initialization needs no replacement notification");
  assert.deepEqual(transportEvents, []);

  const holder = () => node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE released_at IS NULL").all() as { holder_pid: number; token: string }[];
  assert.equal(holder().length, 1, "the launch identity is held by the original process");
  let previous = holder()[0];

  for (let generation = 1; generation <= 2; generation++) {
    if (generation === 1) {
      // The deployed build accepts the upgraded store; the already loaded server must refuse and reload.
      const store = join(install, "dist/store.js"), source = readFileSync(store, "utf8");
      const schema = node.store.schemaVersion() + 1;
      const upgraded = source.replace(/SCHEMA_VERSION = \d+/, `SCHEMA_VERSION = ${schema}`);
      assert.notEqual(upgraded, source, "the fixture upgrades the installed schema reader");
      writeFileSync(store, upgraded);
      node.store.db.exec(`PRAGMA user_version=${schema}`);
    }
    // Deploy a new build under the running server: the next call finishes on the old code, then hands the transport over.
    appendFileSync(join(install, "dist/cli.js"), `\n// deployed build ${generation}\n`);
    const final = await client.callTool({ name: "mbx_whoami", arguments: {} });
    if (generation === 1) {
      assert.equal(final.isError, true, "the stale schema is refused before handover");
      assert.match(JSON.stringify(final.content), /Restart your CLI session/);
    } else {
      assert.notEqual(final.isError, true, "the call that triggers the handover must still be answered");
      assert.match(String((final.structuredContent as { switching?: string }).switching), /hands over to it after this call/);
    }

    const deadline = Date.now() + 10_000;
    while (catalogChanges < generation) {
      assert.ok(Date.now() < deadline, `replacement ${generation} did not announce its catalog on the same transport`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // This is the request the incident lost: it was sent from the notification and answered by a closed transport.
    const refreshed = (await within(refreshes[generation - 1], 10_000, `the tools/list sent on tools/list_changed (generation ${generation})`)).tools;
    assert.deepEqual(refreshed.map(tool => tool.name).sort(), registered, `generation ${generation}: tools/list returns every registered tool`);
    assert.deepEqual(refreshed, before, `generation ${generation}: tool definitions are unchanged by the handover`);
    // A request made after the handover settles is answered by the same replacement, on the same transport.
    assert.deepEqual((await client.listTools()).tools, before, `generation ${generation}: a later tools/list matches`);
    assert.notEqual((await client.callTool({ name: "mbx_whoami", arguments: {} })).isError, true, `generation ${generation}: tool calls still work`);

    const now = holder();
    assert.equal(now.length, 1, "exactly one live holder after the handover");
    assert.notEqual(now[0].token, previous.token, `generation ${generation}: a fresh runtime took over the lease`);
    if (typeof process.execve === "function") assert.equal(now[0].holder_pid, previous.holder_pid, "exec preserves the PID");
    else assert.notEqual(now[0].holder_pid, previous.holder_pid, "unsupported exec spawns a replacement");
    previous = now[0];
    assert.equal(catalogChanges, generation, "exactly one tools/list_changed per replacement");
    assert.deepEqual(transportEvents, [], `generation ${generation}: the transport was never closed or errored`);
  }
});
