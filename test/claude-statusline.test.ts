import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

// T313: the bundled Claude segment renders from the daemon-written HUD snapshot (one cat, no SQL
// against the store), keeps following the bound identity, and counts only that identity's queue.
test("Claude HUD follows the session identity and excludes another sender's outgoing queue", t => {
  if (spawnSync("bash", ["--version"]).error) { t.skip("bash unavailable"); return; }
  const home = mkdtempSync(join(tmpdir(), "mbx-hud-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,updated_at) VALUES ('renamed','claude','hud-session',?)").run(new Date().toISOString());
  new IdentityLeases(node.store).claim("renamed", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "claude", sessionId: "hud-session" });
  const other = node.send({ from: "other", to: ["renamed"], subject: "incoming", body: "data" }).envelope.id;
  const own = node.send({ from: "renamed", to: ["other"], subject: "outgoing", body: "data" }).envelope.id;
  const queue = node.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)"), now = new Date().toISOString();
  queue.run(other, "offline", now, now); // a copy of mail FROM someone else: never this identity's unsent
  // The bundled script execs `agentmbx` from PATH; point PATH at this checkout so the test exercises
  // the working tree's adapter rather than a globally installed release.
  const binDir = mkdtempSync(join(tmpdir(), "mbx-bin-"));
  t.after(() => rmSync(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  symlinkSync(resolve("bin/agentmbx.js"), join(binDir, "agentmbx"));
  const env = { ...process.env, MBX_HOME: home, PATH: `${binDir}:${process.env.PATH}` } as Record<string, string>;
  const run = (session: string) => {
    writeHud(node); // the daemon keeps these current; the test drives them synchronously
    return spawnSync("bash", [resolve("skill/scripts/claude-statusline.sh")], {
      encoding: "utf8", input: JSON.stringify({ session_id: session, workspace: { project_dir: "/wrong-name" } }), env,
    });
  };
  assert.equal(run("hud-session").stdout, "mbx renamed 1↑\n");
  for (const host of ["offline", "also-offline"]) queue.run(own, host, now, now);
  const displayed = run("hud-session");
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.equal(displayed.stdout, "mbx renamed 1↑ 1 unsent\n", "only this identity's unsent queue is counted");
  node.ack(other, "renamed");
  assert.equal(run("hud-session").stdout, "mbx renamed 1 unsent\n");
  assert.equal(run("missing").stdout, "");
  assert.equal(run("'; DELETE FROM outbox; --").stdout, "");
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM outbox").get()!.n, 3);
});
