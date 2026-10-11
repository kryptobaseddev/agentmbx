// T493 slices 2: the project mailbox over real MCP sessions. AC2 (the live lead sees a labelled section and one ack clears it), AC3 (a
// replacement lead inherits the unread mail, the old one loses it at once), AC4 (nobody else sees project mail or its counts).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { registerIdentity, noteProject } from "../src/registry.ts";
import { slotFor } from "../src/project-slot.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const PASS = "test-only-passphrase";
const CLEO_ID = "5c1a9d3e-7b2f-4a60-9e11-0a1b2c3d4e5f";
const SUBJECT = "zebrafish project note";

type Row = { id: string; state?: string; subject: string };

function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-pm-mcp-"));
  const home = join(root, "home");
  const user = mkdtempSync(join(tmpdir(), "mbx-pm-mcp-user-"));
  const mk = (name: string, cleo?: string) => {
    const d = join(root, name); mkdirSync(d, { recursive: true });
    if (cleo) { mkdirSync(join(d, ".cleo"), { recursive: true }); writeFileSync(join(d, ".cleo", "project-id"), `# CLEO project id\n${cleo}\n`); }
    return realpathSync(d);
  };
  const projA = mk("agentmbx", CLEO_ID), projB = mk("elsewhere", "9f8e7d6c-5b4a-4321-8fed-cba987654321");
  let node: MbxNode | null = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  for (const name of ["agentmbx-lead", "agentmbx-second", "agentmbx-builder", "worker", "foreign-dev"]) node.registerAgent(name);
  registerIdentity(node.store, { name: "decoy", role: "lead" }); node.registerAgent("decoy", { role: "lead" });
  noteProject(node.store, "worker", projA, true); noteProject(node.store, "agentmbx-builder", projA, true);
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    node?.close();
    for (const d of [root, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  /** Run `fn` on a short-lived node over the same home (before the first connect it is the open node itself). */
  const withNode = <T>(fn: (n: MbxNode) => T): T => {
    if (node) return fn(node);
    const n = new MbxNode(home, { host: "alpha" });
    try { return fn(n); } finally { n.close(); }
  };
  const designate = (agent: string, project = projA, now?: Date) => withNode((n) => { const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey, now }); return storeLead(n, rec, sign(rec)); });
  const send = (to: string[], extra: Record<string, unknown> = {}) => withNode((n) => n.send({ from: "agentmbx-builder", to, subject: SUBJECT, body: "zebrafish secret body", kind: "message", project: projA, ...extra }).envelope.id);
  const connect = async (cwd: string, extra: Record<string, string> = {}) => {
    if (node) { node.close(); node = null; }
    const c = new Client({ name: "pm-mcp", version: "1" });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [BIN, "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1", ...extra } as Record<string, string>,
    }));
    clients.push(c);
    return c;
  };
  const db = () => new DatabaseSync(join(home, "mbx.db"), { readOnly: true });
  return { root, home, user, projA, projB, designate, send, connect, withNode, db };
}

const json = (r: unknown) => (r as { structuredContent?: Record<string, any> }).structuredContent ?? JSON.parse((r as { content: { text: string }[] }).content[0].text);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
/** A tool call that must not hand over the message: an error result, or a thrown protocol error. */
const refused = async (c: Client, name: string, args: Record<string, unknown>) => {
  try { const r = await call(c, name, args); return isError(r) || /no message|not found|no thread|no matches/i.test(textOf(r)) ? textOf(r) : null; }
  catch (e) { return (e as Error).message; }
};

// ── AC2 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T493 AC2: the live lead sees the project mailbox as a labelled inbox section, and one ack clears it", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead");
  const m1 = w.send(["agentmbx"]), m2 = w.send(["agentmbx"], { kind: "request", needs_reply: true });
  const personal = w.withNode((n) => n.send({ from: "agentmbx-builder", to: ["agentmbx-lead"], subject: "personal note", body: "only for the lead persona", kind: "message", project: w.projA }).envelope.id);
  const slot = slotFor(CLEO_ID);

  const lead = await w.connect(w.projA, { MBX_AGENT: "agentmbx-lead" });
  const inbox = await call(lead, "mbx_inbox");
  const body = json(inbox);
  assert.deepEqual((body.messages as Row[]).map((m) => m.id), [personal], "the personal list stays personal");
  assert.equal(body.project_inboxes.length, 1);
  const section = body.project_inboxes[0];
  assert.equal(section.project, "agentmbx"); assert.equal(section.key, CLEO_ID); assert.equal(section.unread, 2);
  assert.deepEqual((section.messages as Row[]).map((m) => m.id).sort(), [m1, m2].sort());
  assert.match(textOf(inbox), /Project mailbox agentmbx \(2 unread; stored once for the project, you read it as its lead\)/);
  assert.match(textOf(inbox), /→ project:agentmbx/, "the reserved slot name is not shown");
  assert.equal(textOf(inbox).includes(slot), false);
  assert.match(textOf(inbox), /1 message\(s\) for agentmbx-lead@alpha/);

  const who = json(await call(lead, "mbx_whoami"));
  assert.deepEqual(who.project_mailboxes, [{ project: "agentmbx", key: CLEO_ID, unread: 2 }]);
  assert.equal(who.unread, 1, "the personal unread count does not include the project mailbox");

  // read: labelled, marks only the project copy read
  const read = await call(lead, "mbx_read", { ids: [m1] });
  assert.match(textOf(read), /addressed to the project mailbox agentmbx/); assert.match(textOf(read), /zebrafish secret body/);
  assert.equal(((json(await call(lead, "mbx_inbox"))).project_inboxes[0].messages as Row[]).find((m) => m.id === m1)?.state, "read");

  // one ack clears it; a repeat is harmless; the personal message and the other project message are untouched
  assert.match(textOf(await call(lead, "mbx_ack", { ids: [m1], did: "looked" })), /Acked: /);
  assert.match(textOf(await call(lead, "mbx_ack", { ids: [m1] })), /Acked: /);
  const after = json(await call(lead, "mbx_inbox"));
  assert.deepEqual((after.project_inboxes[0].messages as Row[]).map((m) => m.id), [m2]);
  assert.equal(after.project_inboxes[0].unread, 1);
  assert.deepEqual((after.messages as Row[]).map((m) => m.id), [personal]);
  const d = w.db();
  const states = d.prepare("SELECT msg_id,agent,state FROM deliveries ORDER BY msg_id,agent").all().map((r) => ({ ...r }));
  d.close();
  assert.deepEqual(states.filter((r) => r.msg_id === m1), [{ msg_id: m1, agent: slot, state: "acked" }], "one delivery, to the project mailbox");
  assert.deepEqual(states.filter((r) => r.msg_id === m2), [{ msg_id: m2, agent: slot, state: "delivered" }]);
  assert.deepEqual(states.filter((r) => r.msg_id === personal), [{ msg_id: personal, agent: "agentmbx-lead", state: "delivered" }]);

  // `all=true` shows acked project mail too, and an empty section is reported rather than hidden
  const everything = json(await call(lead, "mbx_inbox", { all: true }));
  assert.deepEqual((everything.project_inboxes[0].messages as Row[]).map((m) => m.id).sort(), [m1, m2].sort());
  await call(lead, "mbx_ack", { ids: [m2] });
  const drained = await call(lead, "mbx_inbox");
  assert.equal(json(drained).project_inboxes[0].unread, 0);
  assert.match(textOf(drained), /Project mailbox agentmbx \(0 unread/);
});

test("T493 AC2: a message that reached the lead personally and through the project is acknowledged personally first; the project copy needs the project argument", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead");
  const both = w.send(["agentmbx", "agentmbx-lead"]);
  const lead = await w.connect(w.projA, { MBX_AGENT: "agentmbx-lead" });
  const before = json(await call(lead, "mbx_inbox"));
  assert.deepEqual([(before.messages as Row[]).length, before.project_inboxes[0].unread], [1, 1]);
  await call(lead, "mbx_ack", { ids: [both] });
  let after = json(await call(lead, "mbx_inbox"));
  assert.deepEqual([(after.messages as Row[]).length, after.project_inboxes[0].unread], [0, 1], "the personal copy first; the project copy is not drained by accident");
  await call(lead, "mbx_ack", { ids: [both] });
  assert.equal(json(await call(lead, "mbx_inbox")).project_inboxes[0].unread, 1, "a repeat still leaves the project copy");
  await call(lead, "mbx_ack", { ids: [both], project: "agentmbx" });
  after = json(await call(lead, "mbx_inbox"));
  assert.equal(after.project_inboxes[0].unread, 0);
  assert.ok(await refused(lead, "mbx_ack", { ids: [both], project: "no-such-project" }), "an unknown or unled project is refused");
});

// ── AC3 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T493 AC3: after lead set to a different persona the new lead sees the unread project mail with no forward, and the old lead loses it at once", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead");
  const m1 = w.send(["agentmbx"]);
  const a = await w.connect(w.projA, { MBX_AGENT: "agentmbx-lead" });
  const b = await w.connect(w.projA, { MBX_AGENT: "agentmbx-second" });
  assert.equal(json(await call(a, "mbx_inbox")).project_inboxes[0].unread, 1);
  assert.equal(json(await call(b, "mbx_inbox")).project_inboxes, undefined, "not the lead yet");
  const d0 = w.db();
  const before = (d0.prepare("SELECT (SELECT count(*) FROM messages) m, (SELECT count(*) FROM deliveries) d, (SELECT count(*) FROM audit WHERE event LIKE '%forward%') f").get() as { m: number; d: number; f: number });
  d0.close();

  w.designate("agentmbx-second", w.projA, new Date(Date.now() + 2000)); // the owner signs a different lead

  const inboxB = json(await call(b, "mbx_inbox"));
  assert.equal(inboxB.project_inboxes.length, 1);
  assert.deepEqual((inboxB.project_inboxes[0].messages as Row[]).map((m) => m.id), [m1], "the same message id, unread, with nothing forwarded");
  assert.match(textOf(await call(b, "mbx_read", { ids: [m1] })), /zebrafish secret body/);

  assert.equal(json(await call(a, "mbx_inbox")).project_inboxes, undefined, "the old lead's project section is gone");
  assert.equal(json(await call(a, "mbx_whoami")).project_mailboxes, undefined);
  assert.ok(await refused(a, "mbx_read", { ids: [m1] }));
  assert.ok(await refused(a, "mbx_ack", { ids: [m1] }));
  assert.ok(await refused(a, "mbx_ack", { ids: [m1], project: "agentmbx" }));
  assert.ok(await refused(a, "mbx_thread", { id: m1 }));
  assert.match(textOf(await call(a, "mbx_search", { query: "zebrafish" })), /No matches/);

  await call(b, "mbx_ack", { ids: [m1] });
  const d1 = w.db();
  const after = (d1.prepare("SELECT (SELECT count(*) FROM messages) m, (SELECT count(*) FROM deliveries) d, (SELECT count(*) FROM audit WHERE event LIKE '%forward%') f").get() as { m: number; d: number; f: number });
  const state = d1.prepare("SELECT agent,state FROM deliveries WHERE msg_id=?").all(m1).map((r) => ({ ...r }));
  d1.close();
  assert.deepEqual(after, before, "no new body, no new delivery, no forward audit row");
  assert.deepEqual(state, [{ agent: slotFor(CLEO_ID), state: "acked" }]);
});

// ── AC4 ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("T493 AC4: no one but the lead sees project mail or its counts: a role-label decoy, a same-project worker, a foreign worker, an unbound client and a shell --as lead", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead");
  const secret = w.send(["agentmbx"]);
  await new Promise((r) => setTimeout(r, 5)); // ids made in one millisecond share nearly every character; keep the secret's long prefix its own
  const workerOwn = w.withNode((n) => n.send({ from: "agentmbx-builder", to: ["worker"], subject: "for the worker", body: "worker's own mail", kind: "message", project: w.projA }).envelope.id);

  const clients: [string, Client][] = [
    ["decoy (role lead, not the lead)", await w.connect(w.projA, { MBX_AGENT: "decoy" })],
    ["same-project worker", await w.connect(w.projA, { MBX_AGENT: "worker" })],
    ["foreign worker", await w.connect(w.projB, { MBX_AGENT: "foreign-dev" })],
    ["unbound client", await w.connect(w.projA)],
  ];
  const prefix = secret.slice(0, 22); // long enough to be this message alone (the first 10 characters are a millisecond timestamp)
  for (const [who, c] of clients) {
    const inbox = await call(c, "mbx_inbox");
    assert.equal(textOf(inbox).includes(secret) || textOf(inbox).includes(SUBJECT), false, `${who}: inbox`);
    assert.equal(json(inbox).project_inboxes, undefined, `${who}: no project section`);
    const me = json(await call(c, "mbx_whoami"));
    assert.equal(me.project_mailboxes, undefined, `${who}: whoami has no project mailbox`);
    assert.equal(JSON.stringify(me).includes(secret), false);
    if (me.agent === "worker") assert.equal(me.unread, 1, "worker: only its own personal mail is counted");
    else if (me.agent) assert.equal(me.unread, 0, `${who}: no project mail in the count`);
    if (!me.agent) continue; // an unbound client has no mailbox to read from at all
    assert.ok(await refused(c, "mbx_read", { ids: [secret] }), `${who}: read by id`);
    assert.ok(await refused(c, "mbx_read", { ids: [prefix] }), `${who}: read by prefix`);
    // A prefix that matches the hidden message AND something visible resolves among the visible ones only: no "matches 2 messages" error
    // (which would reveal that a hidden one exists), no body of the hidden one. Every message here shares its first 6 characters.
    const wide = await refused(c, "mbx_read", { ids: [secret.slice(0, 6)] });
    if (me.agent === "worker") { assert.equal(wide, null, "worker: its own mail still resolves"); } else assert.ok(wide, `${who}: nothing visible to resolve to`);
    assert.equal(/matches \d|more characters/.test(wide ?? ""), false, `${who}: ambiguity does not reveal a hidden message`);
    assert.ok(await refused(c, "mbx_thread", { id: secret }), `${who}: thread`);
    assert.ok(await refused(c, "mbx_ack", { ids: [secret] }), `${who}: ack`);
    assert.match(textOf(await call(c, "mbx_search", { query: "zebrafish" })), /No matches/, `${who}: search`);
    const replay = await call(c, "mbx_replay", {});
    assert.equal(textOf(replay).includes(secret) || textOf(replay).includes(SUBJECT), false, `${who}: replay`);
    const ledger = await call(c, "mbx_project", {});
    assert.equal(textOf(ledger).includes(secret) || textOf(ledger).includes(SUBJECT), false, `${who}: project ledger`);
  }
  const worker = clients[1]![1];
  assert.match(textOf(await call(worker, "mbx_read", { ids: [workerOwn] })), /worker's own mail/, "the worker's own personal mail is still readable");
  const wideRead = textOf(await call(worker, "mbx_read", { ids: [secret.slice(0, 6)] }));
  assert.match(wideRead, /worker's own mail/); assert.equal(wideRead.includes("zebrafish"), false);

  // A shell is not holder proof: the CLI refuses `--as <another identity>` outright (it must be the identity the calling session holds), and
  // prints nothing about project mail. What a lease-less read would see if it got further is pinned at node level ("only the project's
  // current lead, inside its own held lease").
  const cli = (...args: string[]) => { try { return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: w.home, HOME: w.user }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`; } };
  const refusal = /^agentmbx: (this session holds .* not the requested identity|no running MCP control endpoint|ambiguous provider sessions|no message)/m;
  for (const args of [["inbox", "--as", "agentmbx-lead", "--all"], ["read", secret, "--as", "agentmbx-lead"], ["ack", secret, "--as", "agentmbx-lead"]]) {
    const out = cli(...args);
    assert.match(out, refusal, `shell ${args[0]} --as lead is refused: ${out.slice(0, 200)}`);
    assert.equal(out.includes(secret) || out.includes(SUBJECT) || out.includes("zebrafish"), false, `shell ${args[0]} --as lead`);
  }
});

test("T493 AC4: project mail is left out of the project ledger before the page limit, so other members cannot count it or page through it", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead");
  const privateIds = Array.from({ length: 12 }, () => w.send(["agentmbx"]));
  const visible = Array.from({ length: 3 }, (_, i) => w.withNode((n) => n.send({ from: "agentmbx-builder", to: ["worker"], subject: `ordinary project note ${i}`, body: "visible to the project", kind: "message", project: w.projA }).envelope.id));

  const worker = await w.connect(w.projA, { MBX_AGENT: "worker" });
  const page = json(await call(worker, "mbx_project", { limit: 5 }));
  assert.deepEqual((page.messages as { id: string }[]).map((m) => m.id), visible, "filtered BEFORE the limit: all three ordinary messages, none of the twelve");
  assert.equal(page.has_more, false);
  for (const id of privateIds) assert.equal(JSON.stringify(page).includes(id), false);

  const lead = await w.connect(w.projA, { MBX_AGENT: "agentmbx-lead" });
  const all = [...(json(await call(lead, "mbx_project", { limit: 100 })).messages as { id: string; body: string | null }[])];
  assert.equal(privateIds.every((id) => all.some((m) => m.id === id && m.body)), true, "the lead's ledger carries them, with bodies");

  // The author keeps access to what it sent, as before.
  const author = await w.connect(w.projA, { MBX_AGENT: "agentmbx-builder" });
  const mine = json(await call(author, "mbx_project", { limit: 100 })).messages as { id: string }[];
  assert.equal(privateIds.every((id) => mine.some((m) => m.id === id)), true);
  assert.match(textOf(await call(author, "mbx_read", { ids: [privateIds[0]!] })), /zebrafish secret body/);
});
