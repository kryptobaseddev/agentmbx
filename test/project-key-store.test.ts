// T543 AC2 and AC3: the CLEO project id keys identity_projects and project_leads without losing a binding or a lead, and two
// checkouts of one CLEO project are one project (membership, lead, ledger, stale bindings, the probe rule, doctor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { projectKeyChecks } from "../src/doctor.ts";
import { buildEnvelope, signEnvelope } from "../src/envelope.ts";
import { activeLead, activeLeads, isLead, makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { cwdInProject } from "../src/probe.ts";
import { crossHostKey, projectKey, resolveProject } from "../src/project-key.ts";
import { ledgerPage } from "../src/project-ledger.ts";
import { backfillProjectKeys, noteProject, projectIdentities, registerIdentity, staleProjectBindings } from "../src/registry.ts";

const PASS = "test-only-passphrase";
const KEY = "071b70b3-551d-44bb-b993-1e84bfa2fe09", OTHER_KEY = "98069e9b-0e3a-4697-ab38-366a2ff83ec0";

function world(t: { after: (fn: () => unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-pkstore-"));
  const home = join(root, "home");
  let node = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  const open: MbxNode[] = [node];
  t.after(() => { for (const n of open) try { n.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  /** A checkout folder: .cleo/project-id with the id (when given) and a git repository with an origin (when given). */
  const checkout = (name: string, id: string | null, origin?: string) => {
    const dir = join(root, "work", name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
    if (id) { mkdirSync(join(dir, ".cleo")); writeFileSync(join(dir, ".cleo", "project-id"), `# CLEO portable project identity (ADR-094)\n${id}\n`); }
    return realpathSync(dir); // projectOf() hands out realpaths, and /var is /private/var on macOS
  };
  const persona = (name: string, project: string) => {
    registerIdentity(node.store, { name, role: "builder" }); node.registerAgent(name, { role: "builder" });
    noteProject(node.store, name, project, true);
  };
  const lead = (agent: string, project: string) => {
    const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey });
    return storeLead(node, rec, signData(owner.privateKey, canonical(rec)));
  };
  const reopen = () => { node.close(); node = new MbxNode(home, { host: "alpha" }); open.push(node); return node; };
  return { root, home, get node() { return node; }, checkout, persona, lead, reopen };
}

/** Turn the open store into one that has never heard of project_key: the old table shapes, same rows, definition marker gone. */
function toPreMigration(node: MbxNode) {
  const db = node.store.db;
  const bindings = db.prepare("SELECT name,project,first_seen,last_seen FROM identity_projects").all() as Record<string, string>[];
  const leads = db.prepare("SELECT id,project,agent,record,sig,revocation,revocation_sig,received_at FROM project_leads").all() as Record<string, string | null>[];
  db.exec(`DROP TABLE identity_projects; DROP TABLE project_leads;
    CREATE TABLE identity_projects (name TEXT NOT NULL, project TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (name, project));
    CREATE TABLE project_leads (id TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL, sig TEXT NOT NULL,
      revocation TEXT, revocation_sig TEXT, received_at TEXT NOT NULL);`);
  for (const b of bindings) db.prepare("INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES (?,?,?,?)").run(b.name, b.project, b.first_seen, b.last_seen);
  for (const l of leads) db.prepare("INSERT INTO project_leads (id,project,agent,record,sig,revocation,revocation_sig,received_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(l.id, l.project, l.agent, l.record, l.sig, l.revocation, l.revocation_sig, l.received_at);
  db.prepare("DELETE FROM kv WHERE k='schema-definition'").run();
  for (const table of ["identity_projects", "project_leads"]) {
    assert.equal((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "project_key"), false, `${table} is pre-migration`);
  }
}
const keys = (node: MbxNode, table: "identity_projects" | "project_leads") =>
  (node.store.db.prepare(`SELECT project, project_key FROM ${table} ORDER BY project, project_key`).all() as { project: string; project_key: string | null }[]).map((r) => ({ ...r }));

test("AC2: a pre-migration store keeps every binding and lead, gains keys only where a folder still resolves, and migrating again changes nothing", (t) => {
  const w = world(t);
  const a = w.checkout("agentmbx", KEY), plain = w.checkout("plain", null);
  const gone = join(realpathSync(w.root), "work", "deleted-worktree"); // never created: the folder of a lead and a binding that is no longer on disk
  w.persona("p-a", a); w.persona("p-plain", plain); w.persona("p-gone", gone);
  w.lead("lead-a", a); w.lead("lead-gone", gone);
  const rawBefore = w.node.store.db.prepare("SELECT id,project,agent,record,sig,received_at FROM project_leads ORDER BY id").all();
  const bindingsBefore = w.node.store.db.prepare("SELECT name,project,first_seen,last_seen FROM identity_projects ORDER BY name").all();
  assert.equal(activeLeads(w.node).length, 2);
  toPreMigration(w.node);

  const n = w.reopen(); // the migration runs on open
  assert.deepEqual(n.store.db.prepare("SELECT id,project,agent,record,sig,received_at FROM project_leads ORDER BY id").all(), rawBefore, "every lead row, record and signature byte-identical");
  assert.deepEqual(n.store.db.prepare("SELECT name,project,first_seen,last_seen FROM identity_projects ORDER BY name").all(), bindingsBefore, "every binding, folder and timestamp unchanged");
  assert.deepEqual(keys(n, "identity_projects"), [
    { project: a, project_key: KEY }, { project: gone, project_key: null }, { project: plain, project_key: null }], "only the folder that still has an id gets a key");
  assert.deepEqual(keys(n, "project_leads"), [{ project: a, project_key: KEY }, { project: gone, project_key: null }]);

  assert.equal(activeLead(n, a)?.agent, "lead-a");
  assert.equal(activeLead(n, gone)?.agent, "lead-gone", "the lead of a folder that is gone is still found by that folder");
  assert.equal(activeLeads(n).length, 2, "no lead was lost");
  assert.ok(projectIdentities(n.store, a).has("p-a") && projectIdentities(n.store, gone).has("p-gone") && projectIdentities(n.store, plain).has("p-plain"));

  const snapshot = JSON.stringify([keys(n, "identity_projects"), keys(n, "project_leads")]);
  assert.equal(backfillProjectKeys(n.store), 0, "nothing left to fill");
  w.reopen(); w.reopen();
  assert.equal(JSON.stringify([keys(w.node, "identity_projects"), keys(w.node, "project_leads")]), snapshot, "migrating again changes nothing");
});

test("AC2: a row an older runtime writes after the migration is keyed the next time the store opens", (t) => {
  const w = world(t);
  const a = w.checkout("a", KEY), b = w.checkout("b", KEY);
  w.persona("p-one", a);
  w.node.store.db.prepare("INSERT INTO identity_projects (name,project,first_seen,last_seen) VALUES ('p-old',?,?,?)").run(b, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"); // an old runtime's INSERT: no key column
  assert.equal((w.node.store.db.prepare("SELECT project_key FROM identity_projects WHERE name='p-old'").get() as { project_key: string | null }).project_key, null);
  assert.equal(projectIdentities(w.node.store, a).has("p-old"), false, "b is another checkout of a's project, but the unkeyed row only matches its own folder until it is keyed");
  assert.equal(projectIdentities(w.node.store, b).has("p-old"), true, "its own folder always matched");
  w.reopen();
  assert.equal((w.node.store.db.prepare("SELECT project_key FROM identity_projects WHERE name='p-old'").get() as { project_key: string | null }).project_key, KEY);
  assert.equal(projectIdentities(w.node.store, a).has("p-old"), true, "keyed on open: now the whole project");
});

test("AC3: two checkouts of one CLEO project share membership, the lead and the ledger; another id shares nothing", (t) => {
  const w = world(t);
  const one = w.checkout("clone-one", KEY, "git@github.com:Org/Proj.git"), two = w.checkout("clone-two", KEY, "https://github.com/org/proj");
  const other = w.checkout("other", OTHER_KEY, "git@github.com:org/other.git");
  w.persona("dev-one", one); w.persona("dev-two", two); w.persona("dev-other", other);
  assert.deepEqual([...projectIdentities(w.node.store, one)].sort(), ["dev-one", "dev-two"]);
  assert.deepEqual([...projectIdentities(w.node.store, two)].sort(), ["dev-one", "dev-two"], "the same project from the other checkout");
  assert.deepEqual([...projectIdentities(w.node.store, other)], ["dev-other"], "a different id is a different project");

  w.lead("dev-one", one);
  assert.equal(activeLead(w.node, two)?.agent, "dev-one", "a lead signed for one checkout is the project's lead from the other");
  assert.equal(isLead(w.node, "dev-one", two), true);
  assert.equal(activeLead(w.node, other), null, "and not another project's");
  assert.equal(activeLeads(w.node).length, 1, "one entry per project, not per checkout");
  w.lead("dev-two", two); // the owner later signs a newer record for the second checkout: the newest valid record for the project wins
  assert.equal(activeLead(w.node, one)?.agent, "dev-two");
  assert.equal(activeLeads(w.node).length, 1);

  // Mail stamped by a peer with the CLEO id, or (before this change) with the git origin only, joins the ledger of either checkout.
  const peer = new MbxNode(join(w.root, "peer"), { host: "beta" });
  t.after(() => peer.close());
  w.node.addApprovedPeer({ host: "beta", pubkey: peer.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  w.node.registerAgent("bystander");
  const peerId = w.checkout("peer-id", KEY), peerGit = w.checkout("peer-git", null, "git@github.com:org/proj.git"), peerOther = w.checkout("peer-other", OTHER_KEY, "git@github.com:org/other.git");
  const from = (project: string, key: string | undefined, subject: string) => signEnvelope(buildEnvelope({ from: "far-dev@beta", to: ["bystander@alpha"], subject, body: "b",
    project, ...(key ? { project_key: key } : {}) }), "beta", peer.key.publicKey, peer.key.privateKey);
  for (const [p, k, s] of [[peerId, crossHostKey(peerId), "stamped with the CLEO id"], [peerGit, projectKey(peerGit), "stamped with the git origin only"], [peerOther, crossHostKey(peerOther), "another project"]] as const)
    assert.equal(w.node.receive(from(p, k, s), "beta"), "accepted");
  assert.equal(crossHostKey(peerId), KEY);
  for (const folder of [one, two]) {
    const page = ledgerPage(w.node, "dev-one", folder);
    assert.deepEqual(page.messages.map((m) => m.subject), ["stamped with the CLEO id", "stamped with the git origin only"], `ledger of ${folder.split("/").pop()}`);
  }
});

test("AC3: a binding keeps its project after the folder is deleted, and a stale binding is judged per project, not per checkout", (t) => {
  const w = world(t);
  const a = w.checkout("a", KEY), b = w.checkout("b", KEY), c = w.checkout("c", OTHER_KEY);
  w.persona("walker", a);
  noteProject(w.node.store, "walker", b, true, new Date(Date.now() - 86_400_000));
  assert.deepEqual(staleProjectBindings(w.node.store), [], "an older binding in another checkout of the same project is not stale");
  noteProject(w.node.store, "walker", c, true, new Date(Date.now() - 2 * 86_400_000));
  assert.deepEqual(staleProjectBindings(w.node.store).map((s) => s.project), [c], "an older binding in a different project still is");

  w.persona("temp-dev", b);
  w.lead("temp-dev", b);
  rmSync(b, { recursive: true, force: true }); // the worktree is deleted after merge
  assert.equal(existsSync(b), false);
  const inB = keys(w.node, "identity_projects").filter((r) => r.project === b);
  assert.ok(inB.length >= 2 && inB.every((r) => r.project_key === KEY), "the key was stored at binding time, so it does not need the folder");
  assert.equal(projectIdentities(w.node.store, a).has("temp-dev"), true, "the key stored at binding time keeps temp-dev in the project");
  assert.equal(activeLead(w.node, a)?.agent, "temp-dev", "and the lead signed for the deleted checkout still leads it");
});

test("AC3: the probe rule recognises a second checkout of the same project, and only that", (t) => {
  const w = world(t);
  const one = w.checkout("one", KEY), two = w.checkout("two", KEY), other = w.checkout("other", OTHER_KEY), sub = join(two, "src");
  mkdirSync(sub);
  assert.equal(cwdInProject(two, one), true);
  assert.equal(cwdInProject(sub, one), true, "a subfolder of the other checkout");
  assert.equal(cwdInProject(other, one), false);
  assert.equal(cwdInProject(null, one), false);
});

test("AC3: doctor names the key and its source, and warns when one id spans different git origins", (t) => {
  const w = world(t);
  const cleo = w.checkout("cleo", KEY, "git@github.com:org/proj.git"), plain = w.checkout("plain", null, "git@github.com:org/plain.git"), bare = w.checkout("bare", null);

  const ok = projectKeyChecks(w.node, cleo);
  assert.deepEqual(ok.map((c) => c.level), ["ok"]);
  assert.match(ok[0].label, new RegExp(`project key ${KEY} \\(source \\.cleo/project-id in ${cleo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(ok[0].label, /github\.com\/org\/proj/, "the cloud still carries the git origin");

  const fall = projectKeyChecks(w.node, plain);
  assert.equal(fall[0].level, "info");
  assert.match(fall[0].label, /folder path .*no \.cleo\/project-id.*github\.com\/org\/plain \(git origin\)/);
  assert.match(fall[0].fix ?? "", /commit \.cleo\/project-id/);
  assert.match(projectKeyChecks(w.node, bare)[0].label, /no git origin either/);
  assert.deepEqual(projectKeyChecks(w.node, "/"), [], "no project folder, no row");

  // json fallback names its own source
  const jsonOnly = join(w.root, "work", "json-only"); mkdirSync(join(jsonOnly, ".cleo"), { recursive: true });
  writeFileSync(join(jsonOnly, ".cleo", "project.json"), JSON.stringify({ id: OTHER_KEY }));
  assert.match(projectKeyChecks(w.node, jsonOnly)[0].label, /source \.cleo\/project\.json/);

  // a copied .cleo directory: the same id on a folder with another origin
  const copied = w.checkout("copied", KEY, "git@github.com:org/unrelated.git");
  w.persona("in-cleo", cleo); w.persona("in-copy", copied);
  const warned = projectKeyChecks(w.node, cleo);
  assert.deepEqual(warned.map((c) => c.level), ["ok", "warn"]);
  assert.match(warned[1].label, /different git origins \(github\.com\/org\/proj, github\.com\/org\/unrelated\).*copied \.cleo directory/);
});

test("mcp stamps meta.project_key with the CLEO id of the session's folder, the git origin when there is no id, and nothing when there is neither", async (t) => {
  const w = world(t);
  const user = mkdtempSync(join(tmpdir(), "mbx-pkstore-user-"));
  t.after(() => rmSync(user, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cleo = w.checkout("sends-cleo", KEY, "git@github.com:org/proj.git"), gitOnly = w.checkout("sends-git", null, "https://github.com/org/gitonly"), bare = w.checkout("sends-bare", null);
  for (const n of ["sender-cleo", "sender-git", "sender-bare", "receiver"]) w.node.registerAgent(n);
  w.node.close();
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); });
  for (const [agent, cwd] of [["sender-cleo", cleo], ["sender-git", gitOnly], ["sender-bare", bare]] as const) {
    const c = new Client({ name: "pk-mcp", version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: w.home, HOME: user, MBX_CLI: "claude", MBX_AGENT: agent, MBX_NO_DESKTOP: "1" } as Record<string, string> }));
    clients.push(c);
    const sent = await c.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: `from ${agent}`, body: "hello" } });
    assert.notEqual(sent.isError, true, agent + ": " + JSON.stringify(sent.content));
  }
  const n = new MbxNode(w.home, { host: "alpha" });
  t.after(() => n.close());
  const rows = n.store.db.prepare("SELECT from_addr, json_extract(envelope,'$.meta.project') AS project, json_extract(envelope,'$.meta.project_key') AS key FROM messages ORDER BY from_addr").all() as
    { from_addr: string; project: string | null; key: string | null }[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { from_addr: "sender-bare@alpha", project: bare, key: null },
    { from_addr: "sender-cleo@alpha", project: cleo, key: KEY },
    { from_addr: "sender-git@alpha", project: gitOnly, key: "github.com/org/gitonly" },
  ], "meta.project is still the folder; meta.project_key is the CLEO id, else the git origin, else absent");
});
