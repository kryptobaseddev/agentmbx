// Project ledger and lead (T208): agents in a project folder see its traffic (roles, states, liveness), bodies only for
// their own mail; an owner-signed lead sees every body and can forward. Lead records are re-verified on every read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { MbxNode } from "../src/node.ts";
import { activeLead, makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/project-ledger.ts";
import { registerIdentity } from "../src/registry.ts";

function ownerNode(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-ledger-"));
  const n = new MbxNode(join(root, "home"), { host: "alpha" });
  createOwnerKey(n.home, "test-only-passphrase"); n.syncOwner();
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  const projA = join(root, "proj-a"), projB = join(root, "proj-b");
  mkdirSync(projA); mkdirSync(projB);
  t.after(() => { n.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const lead = (agent: string, project: string, ttlMs?: number) => {
    const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey, ttlMs });
    return storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  };
  return { n, owner, lead, projA: realpathSync(projA), projB: realpathSync(projB) };
}

test("lead records: owner-signed, re-verified on read, superseded, expiring and revocable", (t) => {
  const { n, owner, lead, projA } = ownerNode(t);
  assert.equal(activeLead(n, projA), null);
  const first = lead("ada", projA);
  assert.equal(activeLead(n, projA)!.agent, "ada");
  // a stranger's key cannot set a lead
  const stranger = generateKeyPair();
  const forged = makeLead({ project: projA, agent: "mallory", host: "alpha", ownerPub: stranger.publicKey });
  assert.throws(() => storeLead(n, forged, signData(stranger.privateKey, canonical(forged))), /not signed by an owner key/);
  // a row tampered with after storage no longer counts (verified at read time, not only at write time)
  n.store.db.prepare("UPDATE project_leads SET record=json_set(record,'$.agent','mallory') WHERE id=?").run(first.id);
  assert.equal(activeLead(n, projA), null);
  // a newer record supersedes; an expired one does not count
  lead("bob", projA);
  assert.equal(activeLead(n, projA)!.agent, "bob");
  const later = new Date(Date.now() + 31 * 86_400_000);
  assert.equal(activeLead(n, projA, later), null, "the default TTL is 30 days");
  // revocation: signed by the owner, takes the lead away
  const cur = activeLead(n, projA)!;
  const rev = makeLeadRevocation(cur.id, owner.publicKey);
  revokeLead(n, rev, signData(owner.privateKey, canonical(rev)));
  assert.equal(activeLead(n, projA), null);
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='lead.revoke'").get());
  // a forged revocation takes nothing away
  const again = lead("cyd", projA);
  const fake = makeLeadRevocation(again.id, stranger.publicKey);
  assert.throws(() => revokeLead(n, fake, signData(stranger.privateKey, canonical(fake))), /not signed/);
  assert.equal(activeLead(n, projA)!.agent, "cyd");
});

async function sessions(t: { after: (fn: () => Promise<void>) => void }, n: MbxNode) {
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); });
  return async (name: string, cwd: string) => {
    const c = new Client({ name: `ledger-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: n.home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return async (tool: string, args: Record<string, unknown> = {}) =>
      (await c.callTool({ name: tool, arguments: args })) as unknown as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
  };
}
type Ledger = { project: string; lead: string | null; messages: { id: string; body: string | null; body_withheld?: string; recipients: { address: string; role: string | null }[] }[] };

test("the ledger: project members see traffic with roles; bodies for their own mail; the lead sees all; other projects see nothing", async (t) => {
  const { n, lead, projA, projB } = ownerNode(t);
  const open = await sessions(t, n);
  const ada = await open("ada", projA), bob = await open("bob", projA), eve = await open("eve", projA), cyd = await open("cyd", projB);
  registerIdentity(n.store, { name: "bob", role: "lab-staff" });
  const sent = (await ada("mbx_send", { to: ["bob"], subject: "results", body: "SECRET-RESULTS", kind: "request" })).structuredContent as { id: string };
  const asBob = (await bob("mbx_project")).structuredContent as unknown as Ledger;
  const row = asBob.messages.find((m) => m.id === sent.id)!;
  assert.equal(asBob.project, projA);
  assert.equal(row.body, "SECRET-RESULTS", "a recipient sees its own mail");
  assert.deepEqual(row.recipients.map((r) => [r.address, r.role]), [["bob@alpha", "lab-staff"]]);
  const asEve = (await eve("mbx_project")).structuredContent as unknown as Ledger;
  const seen = asEve.messages.find((m) => m.id === sent.id)!;
  assert.equal(seen.body, null); assert.match(seen.body_withheld!, /project lead can read it/);
  assert.match((await eve("mbx_project")).content[0].text, /role: lab-staff/);
  // another project's agent sees none of it, and cannot ask for it
  assert.equal(((await cyd("mbx_project")).structuredContent as unknown as Ledger).messages.some((m) => m.id === sent.id), false);
  const scoped = await cyd("mbx_project", { project: projA });
  assert.equal(scoped.isError, true); assert.match(scoped.content[0].text, /only the ledger of the project it works in/);
  // the lead sees every body
  lead("eve", projA);
  const asLead = (await eve("mbx_project")).structuredContent as unknown as Ledger;
  assert.equal(asLead.lead, "eve@alpha");
  assert.equal(asLead.messages.find((m) => m.id === sent.id)!.body, "SECRET-RESULTS");
});

test("mbx_forward: lead only, project messages only, known local recipients only; audited and labelled", async (t) => {
  const { n, lead, projA, projB } = ownerNode(t);
  const open = await sessions(t, n);
  const ada = await open("ada", projA), eve = await open("eve", projA), fay = await open("fay", projA), cyd = await open("cyd", projB);
  await open("bob", projA);
  const sent = (await ada("mbx_send", { to: ["bob"], subject: "handover", body: "pick this up", kind: "request" })).structuredContent as { id: string };
  const other = (await cyd("mbx_send", { to: ["cyd"], subject: "elsewhere", body: "b" })).structuredContent as { id: string };
  const refused = await eve("mbx_forward", { id: sent.id, to: "fay" });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /only the project lead can forward/);
  lead("eve", projA);
  const fwd = await eve("mbx_forward", { id: sent.id, to: "fay" });
  assert.notEqual(fwd.isError, true, fwd.content[0].text);
  assert.equal(n.inbox("fay").length, 1);
  assert.match((await fay("mbx_read", { ids: [sent.id] })).content[0].text, /forwarded by lead eve@alpha/);
  assert.ok(n.store.db.prepare("SELECT 1 FROM audit WHERE event='message.forwarded' AND json_extract(detail,'$.to')='fay@alpha'").get());
  assert.match((await eve("mbx_project")).content[0].text, /forwarded by eve@alpha/);
  const outside = await eve("mbx_forward", { id: other.id, to: "fay" });
  assert.equal(outside.isError, true); assert.match(outside.content[0].text, /is not a message of project/);
  const unknown = await eve("mbx_forward", { id: sent.id, to: "nobody" });
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /"nobody" is not an agent/);
});
