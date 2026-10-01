import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";

test("Claude HUD follows renamed session identity and excludes another sender's outgoing queue", t => {
  for (const bin of ["jq", "sqlite3"]) if (spawnSync(bin, ["--version"]).error) { t.skip(`${bin} unavailable`); return; }
  const home = mkdtempSync(join(tmpdir(), "mbx-hud-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,updated_at) VALUES ('renamed','claude','hud-session',?)").run(new Date().toISOString());
  const other = node.send({ from: "other", to: ["renamed"], subject: "incoming", body: "data" }).envelope.id;
  const own = node.send({ from: "renamed", to: ["other"], subject: "outgoing", body: "data" }).envelope.id;
  const queue = node.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)"), now = new Date().toISOString();
  queue.run(other, "offline", now, now);
  const run = (session: string) => spawnSync("bash", [resolve("skill/scripts/claude-statusline.sh")], {
    encoding: "utf8", input: JSON.stringify({ session_id: session, workspace: { project_dir: "/wrong-name" } }),
    env: { ...process.env, MBX_HOME: home },
  });
  assert.equal(run("hud-session").stdout, "MBX renamed: 1 new\n");
  for (const host of ["offline", "also-offline"]) queue.run(own, host, now, now);
  const displayed = run("hud-session");
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.equal(displayed.stdout, "MBX renamed: 1 new · 1 unsent\n");
  node.ack(other, "renamed");
  assert.equal(run("hud-session").stdout, "MBX renamed: no mail · 1 unsent\n");
  assert.equal(run("missing").stdout, "");
  assert.equal(run("'; DELETE FROM outbox; --").stdout, "");
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM outbox").get()!.n, 3);
});
