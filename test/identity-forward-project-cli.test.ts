// T495 AC2/AC3 end to end: `agentmbx identity forward` run by the project's lead from inside its own session moves mail without any owner
// prompt; the same command for another project, or from a caller that is not the holder, asks for the owner's signature instead (which
// a non-interactive test cannot give) and moves nothing.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { allocateProjectMailbox } from "../src/project-mailbox.ts";
import { noteProject } from "../src/registry.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const PASS = "test-only-passphrase";
const CLEO_A = "5c1a9d3e-7b2f-4a60-9e11-0a1b2c3d4e5f", CLEO_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-t495-cli-"));
  const home = join(root, "home"), user = mkdtempSync(join(tmpdir(), "mbx-t495-cli-user-"));
  const mk = (name: string, cleo: string) => {
    const d = join(root, name); mkdirSync(join(d, ".cleo"), { recursive: true });
    writeFileSync(join(d, ".cleo", "project-id"), `# CLEO project id\n${cleo}\n`);
    return realpathSync(d);
  };
  const projA = mk("alpha", CLEO_A), projB = mk("beta", CLEO_B);
  const n = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  for (const name of ["alpha-lead", "alpha-w1", "alpha-w2", "beta-w1", "sender"]) n.registerAgent(name);
  for (const name of ["alpha-lead", "alpha-w1", "alpha-w2"]) noteProject(n.store, name, projA, true);
  noteProject(n.store, "beta-w1", projB, true);
  n.registerAgent("alpha"); noteProject(n.store, "alpha", projA, true);
  const legacy = n.send({ from: "sender", to: ["alpha"], subject: "legacy pending", body: "x" }).envelope.id;
  const legacyRead = n.send({ from: "sender", to: ["alpha"], subject: "legacy read", body: "x" }).envelope.id;
  n.store.setDelivery(legacyRead, "alpha", "read", "historical read");
  const slotA = allocateProjectMailbox(n, projA).mailbox.slot; allocateProjectMailbox(n, projB);
  const rec = makeLead({ project: projA, agent: "alpha-lead", host: "alpha", ownerPub: owner.publicKey });
  storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  const mail = (to: string) => n.send({ from: "sender", to: [to], subject: `for ${to}`, body: "x", kind: "message" }).envelope.id;
  const ids = { w1: mail("alpha-w1"), w1b: mail("alpha-w1"), bw: mail("beta-w1"), legacy, legacyRead };
  n.close();
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); for (const d of [root, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1", ...extra }) as Record<string, string>;
  const connect = async (agent: string, cwd: string) => {
    const c = new Client({ name: "t495", version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], cwd, env: env({ MBX_AGENT: agent }) }));
    clients.push(c);
  };
  const cli = (...args: string[]) => { const r = spawnSync(process.execPath, [BIN, ...args], { env: env(), encoding: "utf8", cwd: projA, timeout: 60_000 }); return { status: r.status, out: r.stdout, err: r.stderr }; };
  const db = () => new DatabaseSync(join(home, "mbx.db"), { readOnly: true });
  const where = (id: string) => { const d = db(); try { return (d.prepare("SELECT agent FROM deliveries WHERE msg_id=?").all(id) as { agent: string }[]).map((r) => r.agent); } finally { d.close(); } };
  const audits = (event: string) => { const d = db(); try { return (d.prepare("SELECT detail FROM audit WHERE event=? ORDER BY rowid").all(event) as { detail: string }[]).map((r) => JSON.parse(r.detail) as Record<string, unknown>); } finally { d.close(); } };
  return { ids, slotA, connect, cli, where, audits, projA, projB, rec, home };
}

test("T495 AC2: the lead runs `identity forward` inside its own session and the mail moves with no owner prompt", async (t) => {
  const w = world(t);
  await w.connect("alpha-lead", w.projA);
  const r = w.cli("identity", "forward", "alpha-w1", "alpha-w2", "--json");
  assert.equal(r.status, 0, `${r.out}\n${r.err}`);
  const body = JSON.parse(r.out) as { from: string; to: string; moved: number; authority: string; project: string };
  assert.deepEqual({ from: body.from, to: body.to, moved: body.moved, authority: body.authority, project: body.project }, { from: "alpha-w1", to: "alpha-w2", moved: 2, authority: "lead", project: CLEO_A });
  assert.deepEqual(w.where(w.ids.w1), ["alpha-w2"]); assert.deepEqual(w.where(w.ids.w1b), ["alpha-w2"]);
  const row = w.audits("identity.forward").at(-1)!;
  assert.equal(row.authority, "lead"); assert.equal(row.lead, "alpha-lead@alpha"); assert.equal(row.lead_record, w.rec.id); assert.equal(row.moved, 2);
  assert.equal(r.err.includes("owner"), false, "no owner prompt or mention");

  // The text form, and into the project mailbox: the project's name is shown, never the reserved slot name.
  const text = w.cli("identity", "forward", "alpha-w2", w.slotA);
  assert.equal(text.status, 0, `${text.out}\n${text.err}`);
  assert.match(text.out, /Moved 2 unread message\(s\) from alpha-w2 to pm-[0-9a-f]{32} as alpha-lead, the lead of project alpha; no owner signature needed\./);
  assert.deepEqual(w.where(w.ids.w1), [w.slotA]);
});

test("T495 AC3: another project's mailbox, or a caller that is not the session's holder, falls through to the owner's signature and moves nothing", async (t) => {
  const w = world(t);
  await w.connect("alpha-lead", w.projA);
  // Across projects: the lead check says no, with the reason, and the command then needs the owner (who cannot sign in a test).
  const cross = w.cli("identity", "forward", "alpha-w1", "beta-w1");
  assert.notEqual(cross.status, 0, `${cross.out}\n${cross.err}`);
  assert.match(cross.err, /Not forwarded as a project lead: alpha-w1 and beta-w1 are not both mailboxes of one project that alpha-lead leads\. Asking for the owner's signature instead\./);
  assert.match(cross.err, /^agentmbx: owner commands need an interactive terminal/m, `the owner path is what refuses: ${cross.err}`);
  assert.deepEqual(w.where(w.ids.w1), ["alpha-w1"]); assert.deepEqual(w.where(w.ids.bw), ["beta-w1"]);
  const refused = w.audits("identity.forward_refused");
  assert.equal(refused.length, 1); assert.equal(refused[0]!.by, "alpha-lead"); assert.match(String(refused[0]!.reason), /not both mailboxes of one project/);
  assert.equal(w.audits("identity.forward").length, 0, "nothing was moved");

  // A shell that names another identity is not the session's holder: no lead path, no lead note, the owner path, nothing moved.
  const decoy = w.cli("identity", "forward", "alpha-w1", "alpha-w2", "--as", "sender");
  assert.notEqual(decoy.status, 0, `${decoy.out}\n${decoy.err}`);
  assert.equal(decoy.err.includes("Not forwarded as a project lead"), false);
  assert.deepEqual(w.where(w.ids.w1), ["alpha-w1"]);
  assert.equal(w.audits("identity.forward").length, 0);
});

test("T494: CLI apply uses the real lead lease, preserves read history and is a no-op on repeat", async t => {
  const w = world(t);
  await w.connect("alpha-lead", w.projA);
  const first = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--json");
  assert.equal(first.status, 0, first.err);
  assert.equal(JSON.parse(first.out).moved, 1);
  assert.deepEqual(w.where(w.ids.legacy), [w.slotA]); assert.deepEqual(w.where(w.ids.legacyRead), ["alpha"]);
  assert.equal(w.audits("identity.basename_migrated").length, 1);
  const repeated = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--json");
  assert.equal(repeated.status, 0, repeated.err); assert.equal(JSON.parse(repeated.out).moved, 0);
  assert.equal(w.audits("identity.basename_migrated").length, 1); assert.equal(w.audits("identity.forward").length, 1);
});

test("T494: CLI rejects a leased non-lead and a source that became live", async t => {
  const w = world(t);
  await w.connect("alpha-w1", w.projA);
  const denied = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--json");
  assert.notEqual(denied.status, 0); assert.match(denied.err, /not the current lead/);
  assert.deepEqual(w.where(w.ids.legacy), ["alpha"]); assert.equal(w.audits("identity.basename_migrated").length, 0);
  await w.connect("alpha", w.projA);
  const live = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--as", "alpha-w1");
  assert.notEqual(live.status, 0); assert.match(live.err, /held by live/);
  assert.deepEqual(w.where(w.ids.legacy), ["alpha"]);
});

test("T494: per-message audit failure rolls delivery and alias changes back", async t => {
  const w = world(t); await w.connect("alpha-lead", w.projA);
  const db = new DatabaseSync(join(w.home, "mbx.db"));
  db.exec("CREATE TRIGGER fail_basename_audit BEFORE INSERT ON audit WHEN NEW.event='identity.basename_migrated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END;"); db.close();
  const failed = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--json");
  assert.notEqual(failed.status, 0); assert.match(failed.err, /test audit failure/);
  assert.deepEqual(w.where(w.ids.legacy), ["alpha"]); assert.deepEqual(w.where(w.ids.legacyRead), ["alpha"]);
  assert.equal(w.audits("identity.basename_migrated").length, 0); assert.equal(w.audits("identity.forward").length, 0);
  const check = new DatabaseSync(join(w.home, "mbx.db"), { readOnly: true });
  try { assert.notEqual(check.prepare("SELECT v FROM kv WHERE k='alias:alpha'").get()?.v, w.slotA); } finally { check.close(); }
});

test("T494: preview does not authorize apply after the lead is revoked", async t => {
  const w = world(t); await w.connect("alpha-lead", w.projA);
  const preview = w.cli("identity", "migrate-basename", "--project", w.projA, "--json");
  assert.equal(preview.status, 0, preview.err); assert.deepEqual(JSON.parse(preview.out).ids, [w.ids.legacy]);
  const node = new MbxNode(w.home), owner = unlockOwnerKey(w.home, PASS);
  const rev = makeLeadRevocation(w.rec.id, owner.publicKey); revokeLead(node, rev, signData(owner.privateKey, canonical(rev))); node.close();
  const denied = w.cli("identity", "migrate-basename", "--project", w.projA, "--apply", "--json");
  assert.notEqual(denied.status, 0); assert.match(denied.err, /not the current lead/);
  assert.deepEqual(w.where(w.ids.legacy), ["alpha"]); assert.equal(w.audits("identity.basename_migrated").length, 0);
});
