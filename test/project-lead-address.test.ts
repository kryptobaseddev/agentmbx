// T393: `lead` and `role:lead` are the owner-designated lead, not a role fan-out and not an agent named lead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { makeLead, projectLeadLine, projectLeadView, storeLead } from "../src/project-ledger.ts";
import { assertKnownRecipients, offlineWarnings, recipientReceipts } from "../src/receipts.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { escalateUnheldMail } from "../src/stranded.ts";

function ownerNode(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-lead-addr-"));
  const n = new MbxNode(join(root, "home"), { host: "alpha" });
  createOwnerKey(n.home, "test-only-passphrase");
  n.syncOwner();
  const owner = unlockOwnerKey(n.home, "test-only-passphrase");
  const projA = realpathSync(mkdirSync(join(root, "proj-a"), { recursive: true }) ?? join(root, "proj-a"));
  t.after(() => { n.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const lead = (agent: string, project: string, host = "alpha") => {
    const rec = makeLead({ project, agent, host, ownerPub: owner.publicKey });
    return storeLead(n, rec, signData(owner.privateKey, canonical(rec)));
  };
  const messages = () => (n.store.db.prepare("SELECT count(*) c FROM messages").get() as { c: number }).c;
  return { n, owner, lead, projA, messages };
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

test("lead and role:lead reach only the designated agent, as that agent's address", async (t) => {
  const { n, owner, lead, projA } = ownerNode(t);
  n.registerAgent("agentmbx-lead");
  n.registerAgent("lead", { role: "decoy" });
  n.registerAgent("pretend", { role: "lead" });
  n.registerAgent("reviewer", { role: "reviewer" });
  registerIdentity(n.store, { name: "pretend", role: "lead" });
  n.bindSession({ agent: "pretend", cli: "codex", session_id: "mcp-pretend", pid: process.pid, session_key: "pretend" });
  n.bindSession({ agent: "reviewer", cli: "codex", session_id: "mcp-reviewer", pid: process.pid, session_key: "reviewer" });
  const rec = lead("agentmbx-lead", projA);

  const byToken = n.send({ from: "worker", to: ["lead"], subject: "direct", body: "one", project: projA });
  const byRole = n.send({ from: "worker", to: ["role:lead"], subject: "role", body: "two", project: projA });
  const both = n.send({ from: "worker", to: ["lead", "role:lead", "agentmbx-lead"], subject: "once", body: "three", project: projA });
  assert.deepEqual(byToken.envelope.to, ["agentmbx-lead"]);
  assert.deepEqual(byRole.envelope.to, ["agentmbx-lead"]);
  assert.deepEqual(both.envelope.to, ["agentmbx-lead"]);
  assert.deepEqual(byToken.local, ["agentmbx-lead"]);
  assert.equal(n.inbox("agentmbx-lead").length, 3);
  assert.equal(n.inbox("lead").length, 0, "an agent named lead is not the token");
  assert.equal(n.inbox("pretend").length, 0, "a role label of lead is not the designated lead");

  const fan = n.send({ from: "worker", to: ["role:reviewer"], subject: "review", body: "four", project: projA });
  assert.deepEqual(fan.envelope.to, ["role:reviewer"]);
  assert.deepEqual(fan.local, ["reviewer"]);
  assert.equal(n.inbox("pretend").length, 0);
  assert.equal(n.inbox("agentmbx-lead").length, 3);

  const owned = await n.sendAsOwner({ from: "owner", to: ["lead"], subject: "from owner", body: "five", project: projA }, async (payload) => ({ sig: signData(owner.privateKey, payload) }));
  assert.equal(owned.envelope.from, "owner@alpha");
  assert.deepEqual(owned.envelope.to, ["agentmbx-lead"]);
  assert.equal(n.inbox("agentmbx-lead").some((m) => m.subject === "from owner"), true);
  assert.equal(projectLeadLine(projectLeadView(n, projA)), `lead: agentmbx-lead@alpha until ${rec.exp}`);
});

test("a missing lead or a missing project refuses before any message is stored", (t) => {
  const { n, projA, messages } = ownerNode(t);
  n.registerAgent("lead");
  const before = messages();
  assert.throws(() => n.send({ from: "worker", to: ["lead"], subject: "x", body: "y", project: projA }), (err: unknown) => {
    assert.equal(codeOf(err), "NO_LEAD");
    assert.match((err as Error).message, /no owner-designated/);
    return true;
  });
  assert.throws(() => n.send({ from: "worker", to: ["role:lead"], subject: "x", body: "y" }), (err: unknown) => {
    assert.equal(codeOf(err), "NO_PROJECT");
    assert.match((err as Error).message, /no project/);
    return true;
  });
  assert.equal(messages(), before);
  assert.equal(n.inbox("lead").length, 0);
  assert.doesNotThrow(() => assertKnownRecipients(n, ["lead", "role:lead"]));
  assert.throws(() => assertKnownRecipients(n, ["nobody"]), (err: unknown) => codeOf(err) === "UNKNOWN_RECIPIENT");
});

test("a send without a project field uses the sender's newest project", (t) => {
  const { n, lead, projA } = ownerNode(t);
  n.registerAgent("agentmbx-lead");
  n.registerAgent("worker");
  lead("agentmbx-lead", projA);
  noteProject(n.store, "worker", projA, true);
  const sent = n.send({ from: "worker", to: ["role:lead"], subject: "remembered", body: "b" });
  assert.deepEqual(sent.envelope.to, ["agentmbx-lead"]);
  assert.equal(sent.envelope.meta.project, undefined, "the fallback does not invent a project stamp");
  assert.equal(n.inbox("agentmbx-lead").length, 1);
});

test("a remote lead is a paired address, and an unpaired one is refused", (t) => {
  const { n, lead, projA, messages } = ownerNode(t);
  lead("agentmbx-lead", projA, "fedora");
  const before = messages();
  assert.throws(() => n.send({ from: "worker", to: ["lead"], subject: "x", body: "y", project: projA }), (err: unknown) => {
    assert.equal(codeOf(err), "NO_LEAD");
    assert.match((err as Error).message, /agentmbx-lead@fedora/);
    return true;
  });
  assert.equal(messages(), before);
  const peer = generateKeyPair();
  n.addApprovedPeer({ host: "fedora", pubkey: peer.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "test");
  const sent = n.send({ from: "worker", to: ["role:lead"], subject: "remote", body: "y", project: projA });
  assert.deepEqual(sent.envelope.to, ["agentmbx-lead@fedora"]);
  assert.deepEqual(sent.remote, ["fedora"]);
  assert.deepEqual(sent.local, []);
});

test("T491: lead mail with no live holder queues as queued-no-holder, warns the sender, and escalates urgent mail to the owner", (t) => {
  const { n, lead, projA } = ownerNode(t);
  n.registerAgent("agentmbx-lead");
  n.registerAgent("worker");
  lead("agentmbx-lead", projA);
  // The lead's session has ended: the mailbox is established but no session holds it.
  const alert = n.send({ from: "worker", to: ["lead"], kind: "alert", subject: "deploy failed", body: "now", project: projA });
  const byRole = n.send({ from: "worker", to: ["role:lead"], kind: "request", needs_reply: true, subject: "pick one", body: "a or b", project: projA });
  const plain = n.send({ from: "worker", to: ["agentmbx-lead"], subject: "fyi", body: "no lead token" });

  const stateOf = (r: ReturnType<MbxNode["send"]>) =>
    recipientReceipts(n, r.envelope.id, r.targets).find((x) => x.address === "agentmbx-lead@alpha")!.state;
  assert.equal(stateOf(alert), "queued-no-holder", "lead mail to an unheld lead mailbox is queued-no-holder");
  assert.equal(stateOf(byRole), "queued-no-holder", "role:lead mail to an unheld lead mailbox is queued-no-holder");
  assert.equal(stateOf(plain), "offline", "a plainly addressed unheld agent keeps the offline state");

  const warnings = offlineWarnings(recipientReceipts(n, alert.envelope.id, alert.targets));
  assert.ok(warnings.some((w) => w.includes("agentmbx-lead@alpha")), "the sender-facing warning names the lead recipient");

  const notes: string[] = [];
  const notify = (subtitle: string, body: string) => notes.push(`${subtitle} — ${body}`);
  const escalated = escalateUnheldMail(n, Date.now(), notify);
  assert.deepEqual(escalated.map((e) => `${e.mailbox}:${e.id}`).sort(),
    [`agentmbx-lead:${alert.envelope.id}`, `agentmbx-lead:${byRole.envelope.id}`].sort(),
    "alert and needs_reply copies to the unheld lead mailbox are escalated");
  assert.ok(n.store.get(`escalated:${alert.envelope.id}:agentmbx-lead`), "an exactly-once kv marker is written");
  assert.equal(n.store.get(`escalated:${plain.envelope.id}:agentmbx-lead`), undefined, "mail with no urgency is not escalated");
  assert.equal(notes.length, 2, "the owner gets one desktop notice per escalated copy");
  assert.ok(notes.every((x) => x.includes("agentmbx-lead")), "each notice names the unheld mailbox");

  assert.deepEqual(escalateUnheldMail(n, Date.now(), notify), [], "a second pass escalates nothing new");
  assert.equal(notes.length, 2, "exactly one notice per copy");
});

test("projectLeadView and agentmbx status show none, no project, and the address until exp", (t) => {
  const { n, lead, projA } = ownerNode(t);
  assert.deepEqual(projectLeadView(n, undefined), { project: null, address: null, exp: null });
  assert.equal(projectLeadLine(projectLeadView(n, undefined)), "lead: no project");
  assert.equal(projectLeadLine(projectLeadView(n, projA)), "lead: none");
  const rec = lead("agentmbx-lead", projA);
  assert.equal(projectLeadLine(projectLeadView(n, projA)), `lead: agentmbx-lead@alpha until ${rec.exp}`);
  assert.equal(projectLeadLine(projectLeadView(n, projA, new Date(Date.parse(rec.exp) + 1000))), "lead: none");
  const run = spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), "status"], {
    encoding: "utf8", cwd: projA, timeout: 20_000,
    env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout ?? "", new RegExp(`lead: agentmbx-lead@alpha until ${rec.exp.replace(/[.]/g, "\\.")}`));
});
