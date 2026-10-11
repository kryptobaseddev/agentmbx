// T546: signed /v1/agents. State, harness and project_keys are verified only under the pinned host key.
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Server } from "node:net";
import { canonical, generateKeyPair, signData, verifyData } from "../src/crypto.ts";
import { refreshDirectory, signHop, startServer } from "../src/http.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";
import { MbxNode } from "../src/node.ts";
import { buildRoster, rosterText } from "../src/roster.ts";
import { validateAgentsV1 } from "../src/status-schema.ts";
import { SCHEMA_VERSION } from "../src/store.ts";

process.env.MBX_NO_DESKTOP = "1";
const KEY = "github.com/example/widget";

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function hold(n: MbxNode, name: string, cli: string): void {
  const ev = inspectLeaseProcess(process.pid);
  if (ev.alive !== true || !ev.start) throw new Error("this test needs a readable process start time");
  const now = Date.now();
  n.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(name, "t", process.pid, ev.start, "k", cli, "s", now, now, 86_400_000);
}

async function pair(t: { after: (fn: () => Promise<void> | void) => void }) {
  const homes = [mkdtempSync(join(tmpdir(), "mbx-dir-a-")), mkdtempSync(join(tmpdir(), "mbx-dir-b-"))];
  const repo = mkdtempSync(join(tmpdir(), "mbx-dir-repo-"));
  const env = gitEnv();
  execFileSync("git", ["init", "-q", repo], { env });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/example/widget.git"], { env });
  const a = new MbxNode(homes[0], { host: "alpha" });
  const b = new MbxNode(homes[1], { host: "beta" });
  const sa = await startServer(a, 0, "127.0.0.1");
  const sb = await startServer(b, 0, "127.0.0.1");
  const addr = (s: Server) => `127.0.0.1:${(s.address() as AddressInfo).port}`;
  a.addApprovedPeer({ host: "beta", pubkey: b.key.publicKey, owner_pubkey: null, addr: addr(sb) }, "fixture");
  b.addApprovedPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: addr(sa) }, "fixture");
  t.after(async () => {
    await Promise.all([sa, sb].map((s) => new Promise<void>((r) => s.close(() => r()))));
    a.close(); b.close();
    for (const h of [...homes, repo]) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { a, b, repo, aAddr: addr(sa) };
}

function seed(a: MbxNode, repo: string): void {
  a.registerAgent("live-one", { role: "dev", cli: "grok", description: "holding" });
  a.registerAgent("offline-one", { role: "dev", cli: "claude", description: "away" });
  hold(a, "live-one", "grok");
  const now = new Date().toISOString();
  a.store.db.prepare("INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)").run("live-one", repo, now, now);
}

const reply = (body: unknown): typeof fetch => (async () => Response.json(body)) as typeof fetch;

test("AC1: GET /v1/agents carries verified state, harness and project keys under the host signature", async (t) => {
  const { a, b, repo, aAddr } = await pair(t);
  seed(a, repo);
  a.store.db.prepare("INSERT INTO agents (name,host,role,cli,description,last_seen) VALUES ('foreign','beta',NULL,NULL,NULL,NULL)").run();
  assert.equal(a.store.schemaVersion(), SCHEMA_VERSION, "the directory columns do not bump the schema version");
  const res = await fetch(`http://${aAddr}/v1/agents`, { headers: signHop(b, "GET", "/v1/agents", "") });
  assert.equal(res.status, 200);
  const j = await res.json() as { v: number; host: string; agents: Record<string, unknown>[]; sig: string };
  assert.equal(verifyData(a.key.publicKey, canonical({ v: 1, host: j.host, agents: j.agents }), j.sig), true);
  assert.equal(j.host, "alpha");
  assert.equal(j.agents.some((row) => row.name === "foreign"), false, "another host's row is not republished");
  const live = j.agents.find((row) => row.name === "live-one");
  const offline = j.agents.find((row) => row.name === "offline-one");
  assert.ok(live && offline);
  assert.equal(live.state, "live");
  assert.equal(live.harness, "grok");
  assert.deepEqual(live.project_keys, [KEY]);
  assert.equal(live.role, "dev");
  assert.equal(typeof live.last_seen, "string");
  assert.equal(Object.hasOwn(live, "unread"), false);
  assert.equal(offline.state, "offline");
  assert.equal(offline.harness, null);
  assert.deepEqual(offline.project_keys, []);
});

test("AC2: refreshDirectory stores a signed directory, clears an unsigned one, and rejects a bad signature", async (t) => {
  const { a, b, repo } = await pair(t);
  seed(a, repo);
  await refreshDirectory(b);
  const stored = () => b.agents().find((row) => row.name === "live-one" && row.host === "alpha");
  assert.equal(stored()?.state, "live");
  assert.equal(stored()?.harness, "grok");
  assert.deepEqual(stored()?.project_keys, [KEY]);
  const shown = () => buildRoster(b, { ask: "*" });
  const text = () => rosterText(shown());
  const listed = (address: string) => shown().agents.find((row) => row.address === address);
  assert.deepEqual(validateAgentsV1(shown()), []);
  assert.equal(listed("live-one@alpha")?.state, "live");
  assert.equal(listed("live-one@alpha")?.harness, "grok");
  assert.deepEqual(listed("live-one@alpha")?.project_keys, [KEY]);
  assert.match(listed("live-one@alpha")?.reason ?? "", /verified by paired host alpha/);
  assert.equal(listed("offline-one@alpha")?.state, "offline");
  assert.equal(listed("offline-one@alpha")?.harness, null);
  assert.deepEqual(listed("offline-one@alpha")?.project_keys, []);
  assert.match(text(), /live-one@alpha {2}live/);
  assert.match(text(), /offline-one@alpha {2}offline/);

  const forged = { v: 1, host: "alpha", agents: [
    { name: "live-one", role: "dev", cli: "grok", description: "holding", last_seen: null, state: "offline", harness: null, project_keys: [] },
    { name: "spoof", role: null, cli: null, description: null, last_seen: null, state: "live", harness: "grok", project_keys: [KEY] },
  ] };
  const wrong = generateKeyPair();
  await refreshDirectory(b, reply({ ...forged, sig: signData(wrong.privateKey, canonical(forged)) }));
  assert.equal(stored()?.state, "live", "a bad signature does not replace a verified row");
  assert.equal(b.agents().some((row) => row.name === "spoof"), false);
  assert.equal((b.store.db.prepare("SELECT count(*) n FROM audit WHERE event='directory.rejected'").get() as { n: number }).n, 1);

  await refreshDirectory(b, reply({ host: "alpha", agents: [
    { name: "live-one", role: "dev", cli: "grok", description: "legacy", last_seen: "2020-01-01T00:00:00.000Z" },
  ] }));
  assert.equal(stored()?.state, null, "an unsigned directory is unverified, not offline");
  assert.equal(stored()?.harness, null);
  assert.equal(stored()?.project_keys, null);
  assert.equal(stored()?.description, "legacy");
  assert.equal(listed("live-one@alpha")?.state, "remote");
  assert.equal(listed("live-one@alpha")?.harness, null);
  assert.equal(listed("live-one@alpha")?.project_keys, undefined);
  assert.match(listed("live-one@alpha")?.reason ?? "", /cannot verify/);
  assert.match(text(), /live-one@alpha {2}remote/);
  const away = b.agents().find((row) => row.name === "offline-one");
  assert.ok(away, "a name missing from the unsigned list keeps its row");
  assert.equal(away?.state, null);

  const mixed = { v: 1, host: "alpha", agents: [
    { name: "live-one", role: "dev", cli: "grok", description: "holding", last_seen: stored()?.last_seen ?? null, state: "live", harness: "grok", project_keys: [KEY] },
    { name: "remote-one", role: null, cli: null, description: null, last_seen: null, state: "remote", harness: "grok", project_keys: [] },
  ] };
  await refreshDirectory(b, reply({ ...mixed, sig: signData(a.key.privateKey, canonical(mixed)) }));
  assert.equal(stored()?.state, "live");
  const remote = b.agents().find((row) => row.name === "remote-one");
  assert.equal(remote?.state, null, "state remote is not a verified state");
  assert.equal(remote?.harness, null);
});

test("AC3: two hosts report a remote live persona and a remote offline one, and a departed name loses verification", async (t) => {
  const { a, b, repo } = await pair(t);
  seed(a, repo);
  await refreshDirectory(b);
  const row = (name: string) => b.agents().find((r) => r.name === name && r.host === "alpha");
  assert.equal(row("live-one")?.state, "live");
  assert.equal(row("live-one")?.harness, "grok");
  assert.deepEqual(row("live-one")?.project_keys, [KEY]);
  assert.equal(row("offline-one")?.state, "offline");
  assert.equal(row("offline-one")?.harness, null);
  assert.deepEqual(row("offline-one")?.project_keys, []);

  a.store.db.prepare("DELETE FROM agents WHERE name='offline-one' AND host='alpha'").run();
  await refreshDirectory(b);
  assert.ok(row("offline-one"), "the row stays");
  assert.equal(row("offline-one")?.state, null);
  assert.equal(row("live-one")?.state, "live");
});
