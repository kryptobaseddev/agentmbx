import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

// T613: the bundled Grok adapter cats this session's HUD line and starts no node.
// Output matches `agentmbx statusline grok`. An unknown session prints nothing (T308 AC2).
test("T613: grok statusline adapter matches the CLI and a refresh starts no node", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-grok-sl-"));
  const node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sid = "grok-session-1";
  node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,pid,updated_at) VALUES ('agentmbx-grok','grok',?,?,?)").run(sid, process.pid, new Date().toISOString());
  new IdentityLeases(node.store).claim("agentmbx-grok", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "grok", sessionId: sid });
  node.send({ from: "lead", to: ["agentmbx-grok"], subject: "task", body: "data", needs_reply: true });
  writeHud(node);

  const hud = join(home, "hud");
  writeFileSync(join(hud, "grok-sibling.line"), "mbx another-persona 99↑\n");
  writeFileSync(join(hud, `claude-${sid}.line`), "mbx claude-persona 7↑\n");

  const marker = join(home, "node-invocations");
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh\necho invoked >> ${JSON.stringify(marker)}\n`);
  chmodSync(fakeNode, 0o755);

  const script = resolve("skill/scripts/grok-statusline.sh");
  const env = { ...process.env, MBX_HOME: home, PATH: `${bin}:/bin:/usr/bin` } as Record<string, string>;
  const shell = (session: string) => spawnSync("/bin/sh", [script], {
    input: JSON.stringify({ session_id: session }), encoding: "utf8", env,
  });
  const cli = (session: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", "grok"], {
    input: JSON.stringify({ session_id: session }), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" },
  });

  const ownCli = cli(sid);
  assert.equal(ownCli.status, 0, ownCli.stderr);
  assert.match(ownCli.stdout, /^mbx agentmbx-grok/);
  for (let i = 0; i < 5; i++) {
    const own = shell(sid);
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout, ownCli.stdout, "the sh adapter matches agentmbx statusline grok");
  }
  assert.equal(existsSync(marker), false, "a steady refresh starts no node");

  const unknown = shell("00000000-0000-0000-0000-000000000000");
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.stdout, "");
  assert.equal(cli("00000000-0000-0000-0000-000000000000").stdout, "");
  assert.doesNotMatch(shell(sid).stdout, /another-persona|claude-persona/, "another session's line is not this one");

  writeFileSync(join(hud, ".alive"), String(Date.now() - 20_000));
  const stale = shell(sid);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.stdout, "", "a stale heartbeat prints nothing");
  assert.equal(existsSync(marker), false, "the stale path starts no node either");
});
