// T515: a session cwd, including one shared by a host process, is not project membership.
// Membership is an identity_projects binding. Older bindings are listed by a dry run and removed by --apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { staleBindingSummary } from "../src/doctor.ts";
import { listIdentityStatus } from "../src/identity-status.ts";
import { MbxNode } from "../src/node.ts";
import { inLedger } from "../src/project-ledger.ts";
import { backfillRegistry, noteProject, projectIdentities, removeStaleProjectBindings, staleProjectBindings } from "../src/registry.ts";

const HERE = "/tmp/mbx-t515-agentmbx";
const STUDIO = "/tmp/mbx-t515-studio";
const GOAL = "/tmp/mbx-t515-goal";
const SCRATCH = "/tmp/mbx-t515-scratch";

function homeNode(t: { after: (fn: () => void) => void }, label: string) {
  const home = mkdtempSync(join(tmpdir(), `mbx-t515-${label}-`));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { try { n.close(); } catch { /* the repair test closes before the CLI */ } rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { home, n };
}

function session(n: MbxNode, agent: string, cwd: string, id: string) {
  n.store.db.prepare(
    "INSERT INTO sessions (agent,cli,session_id,cwd,pid,session_key,channel,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(agent, "opencode", id, cwd, 4242, null, 0, "2026-10-09T00:00:00.000Z");
}

function bound(n: MbxNode, name: string, project: string) {
  return !!n.store.db.prepare("SELECT 1 FROM identity_projects WHERE name=? AND project=?").get(name, project);
}

test("a shared host cwd is not membership, and a recorded binding still is", (t) => {
  const { home, n } = homeNode(t, "member");
  n.registerAgent("home-grok");
  n.registerAgent("persona-x");
  n.registerAgent("host-shared");
  noteProject(n.store, "home-grok", HERE);
  // One host process (pid 4242) recorded two personas in this folder. Neither has a binding.
  session(n, "persona-x", HERE, "shared-x");
  session(n, "host-shared", HERE, "shared-host");

  assert.deepEqual([...projectIdentities(n.store, HERE)].sort(), ["home-grok"]);
  const listed = listIdentityStatus(home, { project: HERE, inspect: () => ({ alive: false, start: null }) });
  assert.deepEqual(listed.identities.map((i) => i.name), ["home-grok"]);

  const foreign = n.send({ from: "persona-x", to: ["persona-x"], subject: "studio note", body: "not this ledger" });
  assert.equal(inLedger(n, HERE, foreign.envelope.id), false, "mail that exists only because of the session cwd stays out");
  const toMember = n.send({ from: "persona-x", to: ["home-grok"], subject: "for the project", body: "addressed here" });
  assert.equal(inLedger(n, HERE, toMember.envelope.id), true, "mail delivered to a real member stays project mail");

  backfillRegistry(n.store, "alpha");
  assert.equal(bound(n, "persona-x", HERE), false, "store open does not copy a session cwd into identity_projects");
  assert.equal(bound(n, "host-shared", HERE), false);

  noteProject(n.store, "persona-x", HERE);
  assert.ok(projectIdentities(n.store, HERE).has("persona-x"));
  assert.equal(inLedger(n, HERE, foreign.envelope.id), true, "a noteProject binding brings that persona's mail into the ledger");
  assert.deepEqual(
    listIdentityStatus(home, { project: HERE, inspect: () => ({ alive: false, start: null }) }).identities.map((i) => i.name),
    ["home-grok", "persona-x"],
  );
});

test("identity bindings is a dry run until --apply, and doctor names the count", (t) => {
  const { home, n } = homeNode(t, "repair");
  const at = (name: string, project: string, last: string) =>
    n.store.db.prepare("INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)")
      .run(name, project, last, last);
  at("axiom-lab-dev", HERE, "2026-10-06T00:00:00.000Z");
  at("axiom-lab-dev", STUDIO, "2026-10-09T00:00:00.000Z");
  at("axiom-lab-staff", GOAL, "2026-10-05T00:00:00.000Z");
  at("axiom-lab-staff", HERE, "2026-10-05T01:00:00.000Z");
  at("axiom-lab-staff", SCRATCH, "2026-10-07T00:00:00.000Z");
  at("axiom-lab-staff", STUDIO, "2026-10-09T00:00:00.000Z");
  at("agentmbx-grok", HERE, "2026-10-10T00:00:00.000Z");
  at("tied", HERE, "2026-10-08T00:00:00.000Z");
  at("tied", STUDIO, "2026-10-08T00:00:00.000Z");

  const stale = staleProjectBindings(n.store);
  assert.deepEqual(stale.map((r) => `${r.name} ${r.project}`).sort(), [
    `axiom-lab-dev ${HERE}`,
    `axiom-lab-staff ${HERE}`,
    `axiom-lab-staff ${GOAL}`,
    `axiom-lab-staff ${SCRATCH}`,
  ]);
  assert.ok(stale.every((r) => r.kept_project === STUDIO));
  const quiet = removeStaleProjectBindings(n.store, []);
  assert.equal(quiet, 0);
  assert.equal(bound(n, "axiom-lab-dev", HERE), true, "an empty apply deletes nothing, and the list alone deletes nothing");

  const hit = staleBindingSummary(n);
  assert.equal(hit.level, "warn");
  assert.match(hit.label, /4 project binding\(s\) are older/);
  assert.match(hit.fix!, /agentmbx identity bindings --apply/);

  // A row refreshed after the list was built no longer matches, so apply leaves it.
  const snapshot = staleProjectBindings(n.store);
  noteProject(n.store, "axiom-lab-dev", HERE, new Date("2030-01-01T00:00:00.000Z"));
  assert.equal(removeStaleProjectBindings(n.store, snapshot.filter((r) => r.name === "axiom-lab-dev")), 0);
  assert.equal(bound(n, "axiom-lab-dev", HERE), true);
  assert.equal(bound(n, "axiom-lab-dev", STUDIO), true);

  n.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
    encoding: "utf8", cwd: resolve("."), env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" }, timeout: 20_000,
  });
  const dry = run("identity", "bindings", "--json");
  assert.equal(dry.status, 0, dry.stderr);
  const listed = JSON.parse(dry.stdout) as { applied: boolean; removed: number; stale: { name: string; project: string }[] };
  assert.equal(listed.applied, false);
  assert.equal(listed.removed, 0);
  assert.deepEqual(listed.stale.map((r) => `${r.name} ${r.project}`).sort(), [
    `axiom-lab-dev ${STUDIO}`,
    `axiom-lab-staff ${HERE}`,
    `axiom-lab-staff ${GOAL}`,
    `axiom-lab-staff ${SCRATCH}`,
  ]);

  const check = new MbxNode(home, { host: "alpha" });
  assert.equal(bound(check, "axiom-lab-staff", HERE), true, "the dry run writes nothing");
  check.close();

  const applied = run("identity", "bindings", "--apply", "--json");
  assert.equal(applied.status, 0, applied.stderr);
  const done = JSON.parse(applied.stdout) as { applied: boolean; removed: number };
  assert.equal(done.applied, true);
  assert.equal(done.removed, 4);

  const after = new MbxNode(home, { host: "alpha" });
  t.after(() => after.close());
  assert.equal(bound(after, "axiom-lab-dev", HERE), true, "the refreshed visit is now the newest and stays");
  assert.equal(bound(after, "axiom-lab-dev", STUDIO), false, "the older studio binding is the one removed");
  assert.equal(bound(after, "axiom-lab-staff", STUDIO), true);
  assert.equal(bound(after, "axiom-lab-staff", HERE), false);
  assert.equal(bound(after, "axiom-lab-staff", GOAL), false);
  assert.equal(bound(after, "axiom-lab-staff", SCRATCH), false);
  assert.equal(bound(after, "agentmbx-grok", HERE), true, "a single project stays");
  assert.equal(bound(after, "tied", HERE), true);
  assert.equal(bound(after, "tied", STUDIO), true, "a tie for the newest last_seen stays");
  const clear = staleBindingSummary(after);
  assert.equal(clear.level, "info");
  assert.match(clear.label, /no project bindings older/);
  assert.equal(staleProjectBindings(after.store).length, 0);
  assert.ok(after.store.db.prepare("SELECT 1 FROM audit WHERE event='project.binding.removed'").get());
});
