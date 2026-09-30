import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { listIdentityControls } from "../src/identity-control.ts";

for (const cli of ["claude", "codex", "opencode"]) test(`${cli} build handover finishes the current call and retires all hosted leases`, async t => {
  const root = mkdtempSync(join(tmpdir(), "mbx-update-")), install = join(root, "install"), home = join(root, "mail");
  mkdirSync(install);
  for (const path of ["bin", "dist", "package.json"]) cpSync(resolve(path), join(install, path), { recursive: true });
  symlinkSync(resolve("node_modules"), join(install, "node_modules"), "dir");
  const node = new MbxNode(home, { host: "alpha" }), client = new Client({ name: "handoff-test", version: "1" });
  t.after(async () => { await client.close(); node.close(); rmSync(root, { recursive: true, force: true }); });
  const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, MBX_AGENT: "update-reader", MBX_CLI: cli, MBX_NO_DESKTOP: "1" };
  delete env.AGENTMBX_DEV;
  delete env.MBX_MCP_REEXEC;
  delete env.MBX_MCP_REEXEC_BUILD;
  delete env.MBX_MCP_DETACHED;
  delete env.MBX_MCP_PROVIDER_PID;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(install, "bin/agentmbx.js"), "mcp"], env: env as Record<string, string> }));
  const ids = cli === "claude" ? [undefined] : cli === "codex"
    ? ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] : ["ses_updatealpha", "ses_updatebeta"];
  const call = (sid: string | undefined, tool: string, args = {}) => client.callTool({ name: tool, arguments: args,
    ...(sid ? { _meta: cli === "codex" ? { threadId: sid } : { sessionID: sid } } : {}) });
  const names: string[] = [], pending: string[] = [];
  for (const [i, sid] of ids.entries()) {
    const name = `handoff-${i}`;
    assert.notEqual((await call(sid, "mbx_whoami", { name })).isError, true);
    names.push(name);
    pending.push(node.send({ from: "sender", to: [name], subject: "preserved", body: "history" }).envelope.id);
  }
  for (let generation = 1; generation <= 2; generation++) {
    const old = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name=?").get(names[0])!;
    const messages = node.store.db.prepare("SELECT * FROM messages ORDER BY id").all();
    appendFileSync(join(install, "dist/cli.js"), "\n// deployed build\n");
    const final = await call(ids[0], "mbx_inbox");
    assert.notEqual(final.isError, true, "the final call must finish under the old lease");
    const deadline = Date.now() + 10_000;
    while (node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get(names[0])!.released_at === null) {
      assert.ok(Date.now() < deadline, "old generation did not retire");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const [i, sid] of ids.entries()) {
      const who = await call(sid, "mbx_whoami");
      assert.notEqual(who.isError, true, JSON.stringify(who));
      assert.equal((who.structuredContent as { agent: string }).agent, names[i]);
      const lease = node.store.db.prepare("SELECT holder_pid,token,released_at FROM identity_leases WHERE name=?").get(names[i])!;
      assert.notEqual(lease.holder_pid, old.holder_pid);
      assert.notEqual(lease.token, old.token);
      assert.equal(lease.released_at, null);
      assert.equal(node.inbox(names[i])[0].id, pending[i]);
      // Session bindings stay attached to the provider, not the obsolete MCP wrapper.
      assert.equal(node.store.db.prepare("SELECT pid FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(names[i])!.pid, process.pid);
    }
    assert.deepEqual(node.store.db.prepare("SELECT * FROM messages ORDER BY id").all(), messages);
  }
  const held = node.store.db.prepare("SELECT holder_pid,token FROM identity_leases WHERE name=?").get(names[0])!;
  assert.notEqual((await call(ids[0], "mbx_identity", { action: "release" })).isError, true);
  appendFileSync(join(install, "dist/cli.js"), "\n// deployed after explicit handoff\n");
  assert.notEqual((await call(ids[0], "mbx_identity", { action: "list" })).isError, true);
  const deadline = Date.now() + 10_000;
  while (!listIdentityControls(node.store).some(d => d.agent === names[0] && d.mcp_pid !== held.holder_pid)) {
    assert.ok(Date.now() < deadline, "detached control endpoint was not restored by the new process");
    assert.notEqual((await call(ids[0], "mbx_identity", { action: "list" })).isError, true);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const detached = node.store.db.prepare("SELECT token,released_at FROM identity_leases WHERE name=?").get(names[0])!;
  assert.equal(detached.token, held.token, "reload must not mint a lease for a detached identity");
  assert.notEqual(detached.released_at, null);
  assert.equal((await call(ids[0], "mbx_inbox")).isError, true);
  assert.notEqual((await call(ids[0], "mbx_identity", { action: "list" })).isError, true);
  assert.notEqual((await call(ids[0], "mbx_identity", { action: "claim" })).isError, true, "detached session still supports explicit recovery");
  assert.equal(node.inbox(names[0])[0].id, pending[0]);
});
