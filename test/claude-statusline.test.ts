import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { hudLine, writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { STATUS_V2_SCHEMA, type StatusV2 } from "../src/status-schema.ts";

// T313: the bundled Claude segment renders from the daemon-written HUD snapshot (one cat, no SQL
// against the store), keeps following the bound identity, and counts only that identity's queue.
test("Claude HUD follows the session identity and excludes another sender's outgoing queue", t => {
  if (spawnSync("bash", ["--version"]).error) { t.skip("bash unavailable"); return; }
  const home = mkdtempSync(join(tmpdir(), "mbx-hud-")), node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // every production binder records the provider pid (hooks pass process.ppid, the MCP server env.ppid);
  // the HUD refuses rows with no pid, so this fixture must carry one
  node.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,pid,updated_at) VALUES ('renamed','claude','hud-session',?,?)").run(process.pid, new Date().toISOString());
  new IdentityLeases(node.store).claim("renamed", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "claude", sessionId: "hud-session" });
  const other = node.send({ from: "other", to: ["renamed"], subject: "incoming", body: "data" }).envelope.id;
  const own = node.send({ from: "renamed", to: ["other"], subject: "outgoing", body: "data" }).envelope.id;
  const queue = node.store.db.prepare("INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)"), now = new Date().toISOString();
  queue.run(other, "offline", now, now); // a copy of mail FROM someone else: never this identity's unsent
  // The script is pure sh (sed, date, one cat) and needs nothing on PATH but coreutils; MBX_HOME
  // points it at this fixture home.
  const env = { ...process.env, MBX_HOME: home, PATH: "/bin:/usr/bin" } as Record<string, string>;
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

for (const state of ["bound", "unbound", "cloud-down", "peers-down"]) test(`T408: statusline adapters consume the shared ${state} fixture without a daemon`, t => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/status-v2-${state}.json`, import.meta.url), "utf8")) as StatusV2;
  assert.equal(fixture.schema, STATUS_V2_SCHEMA);
  const before = JSON.stringify(fixture);
  const home = mkdtempSync(join(tmpdir(), "mbx-status-fixture-")), hud = join(home, "hud");
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(hud);
  const sid = fixture.harness.session_id!;
  // The real producer pre-renders lines only for bound identities; adapters never parse v2.
  const line = fixture.identity.state === "bound" ? hudLine({
    schema: "mbx.status/v1", mbx_version: fixture.mbx_version, update_available: null,
    identity: fixture.identity, ...fixture.inbox, policy: fixture.harness.policy, resolved_by: fixture.resolved_by,
  }) + "\n" : "";
  const expected = state === "unbound" ? "" : state === "bound"
    ? "mbx agentmbx-kimi(builder) 2↑ 1↺ 3 unsent\n" : "mbx agentmbx-fixture(builder) 2↑ 1↺ 3 unsent\n";
  assert.equal(line, expected);
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1", MBX_NO_UPDATE_CHECK: "1" };
  const run = (cli: string, session: string) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", cli], {
    input: JSON.stringify({ session_id: session }), encoding: "utf8", timeout: 20_000, env,
  });
  for (const cli of ["claude", "opencode", "kimi", "grok"]) {
    writeFileSync(join(hud, `${cli}-${sid}.v2.json`), JSON.stringify(fixture));
    writeFileSync(join(hud, `${cli}-sibling.line`), "mbx another-persona 99↑\n");
    if (line) writeFileSync(join(hud, `${cli}-${sid}.line`), line);
    writeFileSync(join(hud, ".alive"), String(Date.now()));
    const own = run(cli, sid);
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout, expected, `${cli} must render this fixture's identity and counts only`);
    const unknown = run(cli, "missing-fixture-session");
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.equal(unknown.stdout, "", `${cli} must not borrow a sibling's line`);
  }
  const shell = (session: string) => spawnSync("sh", [resolve("skill/scripts/claude-statusline.sh")], {
    input: JSON.stringify({ session_id: session, workspace: { session_id: "sibling" } }),
    encoding: "utf8", timeout: 10_000, env: { ...env, PATH: "/bin:/usr/bin" },
  });
  writeFileSync(join(hud, ".alive"), String(Date.now()));
  const rendered = shell(sid);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, expected, "the bundled pure-sh Claude adapter shares the fixture line");
  const unknown = shell("missing-fixture-session");
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.stdout, "", "nested sibling metadata must not supply another session's line");
  writeFileSync(join(hud, ".alive"), String(Date.now() - 20_000));
  const stale = shell(sid);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.stdout, "", "a stale producer suppresses even a bound fixture line");
  assert.deepEqual(readdirSync(home), ["hud"], "fixture rendering must not create a store or keys");
  assert.equal(JSON.stringify(fixture), before);
});
