// T553: the current lead replays and catches up on the project mailbox. Personal replay stays personal.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { catchupKey, projectCatchupKey } from "../src/catchup.ts";
import { canonical, signData } from "../src/crypto.ts";
import { makeLead, makeLeadRevocation, revokeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { parseReplayFrame, type ReplayPage } from "../src/replay.ts";
import { slotFor } from "../src/project-slot.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const PASS = "test-only-passphrase";
const CLEO_ID = "5c1a9d3e-7b2f-4a60-9e11-0a1b2c3d4e5f";
const SUBJECT = "zebrafish project note";

function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mbx-t553-"));
  const home = join(root, "home");
  const user = mkdtempSync(join(tmpdir(), "mbx-t553-user-"));
  const projA = (() => {
    const d = join(root, "agentmbx");
    mkdirSync(join(d, ".cleo"), { recursive: true });
    writeFileSync(join(d, ".cleo", "project-id"), `# CLEO project id\n${CLEO_ID}\n`);
    return realpathSync(d);
  })();
  let node: MbxNode | null = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  for (const name of ["agentmbx-lead", "agentmbx-second", "agentmbx-builder"]) node.registerAgent(name);
  registerIdentity(node.store, { name: "decoy", role: "lead" });
  node.registerAgent("decoy", { role: "lead" });
  noteProject(node.store, "agentmbx-builder", projA, true);
  noteProject(node.store, "agentmbx-second", projA, true);
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    node?.close();
    for (const d of [root, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const withNode = <T>(fn: (n: MbxNode) => T): T => {
    if (node) return fn(node);
    const n = new MbxNode(home, { host: "alpha" });
    try { return fn(n); } finally { n.close(); }
  };
  const designate = (agent: string, now?: Date, ttlMs?: number) => withNode((n) => {
    const rec = makeLead({ project: projA, agent, host: "alpha", ownerPub: owner.publicKey, now, ...(ttlMs === undefined ? {} : { ttlMs }) });
    return storeLead(n, rec, sign(rec));
  });
  const revoke = (target: string) => withNode((n) => {
    const rev = makeLeadRevocation(target, owner.publicKey);
    revokeLead(n, rev, sign(rev));
  });
  const send = (to: string[], extra: Record<string, unknown> = {}) => withNode((n) => n.send({
    from: "agentmbx-builder", to, subject: SUBJECT, body: "zebrafish secret body", kind: "message", project: projA, ...extra,
  }).envelope.id);
  const connect = async (agent?: string) => {
    if (node) { node.close(); node = null; }
    const c = new Client({ name: "t553", version: "1" });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [BIN, "mcp"], cwd: projA,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: agent ?? "", MBX_NO_DESKTOP: "1" } as Record<string, string>,
    }));
    clients.push(c);
    if (agent) await c.callTool({ name: "mbx_whoami", arguments: {} });
    return c;
  };
  const db = () => new DatabaseSync(join(home, "mbx.db"), { readOnly: true });
  const kv = (key: string) => {
    const d = db();
    try { return (d.prepare("SELECT v FROM kv WHERE k=?").get(key) as { v: string } | undefined)?.v; }
    finally { d.close(); }
  };
  const stateOf = (id: string, agent: string) => {
    const d = db();
    try { return (d.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent=?").get(id, agent) as { state: string }).state; }
    finally { d.close(); }
  };
  return { projA, designate, revoke, send, connect, kv, stateOf };
}

const parsed = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text) as ReplayPage & {
  error?: { code: string; message: string }; catchup?: { position: number; missed: number }; from?: number; to?: number; noop?: boolean; position?: number; restarted?: string;
};
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
const ids = (page: { messages: { id: string }[] }) => page.messages.map((m) => m.id);
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

async function refusal(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(c, name, args);
  assert.equal(result.isError, true, textOf(result));
  const body = parsed(result);
  assert.equal(body.messages, undefined);
  assert.equal(body.next_cursor, undefined);
  assert.equal(body.error?.code, "NOT_FOUND");
  assert.deepEqual(Object.keys(body).sort(), ["error"]);
  return body.error!.message;
}

test("T553 AC1/AC4: the lead pages project history, including an acked message, and personal replay stays personal", async (t) => {
  const w = world(t);
  const slot = slotFor(CLEO_ID);
  w.designate("agentmbx-lead");
  const m1 = w.send(["agentmbx"]);
  const m2 = w.send(["agentmbx"]);
  const personal = w.send(["agentmbx-lead"], { subject: "personal note", body: "only for the lead persona" });
  const lead = await w.connect("agentmbx-lead");
  assert.match(textOf(await call(lead, "mbx_ack", { ids: [m1], did: "read the project copy" })), /Acked: /);
  assert.equal(w.stateOf(m1, slot), "acked");
  assert.equal(w.stateOf(m2, slot), "delivered");

  const first = parsed(await call(lead, "mbx_replay", { project_mailbox: "agentmbx", limit: 1 }));
  assert.deepEqual(ids(first), [m1]);
  assert.equal(parseReplayFrame(first.next_cursor).mailbox, slot);
  const second = parsed(await call(lead, "mbx_replay", { project_mailbox: "agentmbx", cursor: first.next_cursor, limit: 1 }));
  assert.deepEqual(ids(second), [m2]);
  assert.equal(second.has_more, false);
  const own = parsed(await call(lead, "mbx_replay"));
  assert.deepEqual(ids(own), [personal]);
  assert.equal(parseReplayFrame(own.next_cursor).mailbox, "agentmbx-lead");

  const ontoProject = await call(lead, "mbx_replay", { project_mailbox: "agentmbx", cursor: own.next_cursor });
  assert.equal(ontoProject.isError, true);
  assert.equal(parsed(ontoProject).error?.code, "CURSOR_SCOPE_MISMATCH");
  const ontoPersonal = await call(lead, "mbx_replay", { cursor: first.next_cursor });
  assert.equal(ontoPersonal.isError, true);
  assert.equal(parsed(ontoPersonal).error?.code, "CURSOR_SCOPE_MISMATCH");

  const large = w.send(["agentmbx"], { body: "🧠".repeat(3000) });
  const omitted = await call(lead, "mbx_replay", { project_mailbox: "agentmbx", cursor: second.next_cursor, max_bytes: 2048 });
  assert.notEqual(omitted.isError, true, textOf(omitted));
  const page = parsed(omitted);
  assert.deepEqual(page.messages, [{ id: large, content_omitted: true, reason: "REPLAY_ITEM_TOO_LARGE" }]);
  assert.ok(Buffer.byteLength(textOf(omitted), "utf8") <= 2048);
  assert.equal(w.stateOf(m1, slot), "acked");
  assert.equal(w.stateOf(m2, slot), "delivered");
  assert.equal(w.stateOf(large, slot), "delivered");
});

test("T553 AC2/AC3: a replaced lead, a non-lead, and an unbound client get no page and no cursor", async (t) => {
  const w = world(t);
  w.designate("agentmbx-lead", new Date(Date.now() - 2000));
  const mailed = w.send(["agentmbx"]);
  const lead = await w.connect("agentmbx-lead");
  const page = parsed(await call(lead, "mbx_replay", { project_mailbox: "agentmbx" }));
  assert.deepEqual(ids(page), [mailed]);
  w.designate("agentmbx-second", new Date());
  assert.equal(await refusal(lead, "mbx_replay", { project_mailbox: "agentmbx", cursor: page.next_cursor }), "no project mailbox");
  assert.equal(await refusal(lead, "mbx_replay", { project_mailbox: "agentmbx", cursor: "aaaa", limit: 1 }), "no project mailbox");
  assert.equal(await refusal(lead, "mbx_catchup", { project_mailbox: "agentmbx", cursor: "aaaa" }), "no project mailbox");

  const builder = await w.connect("agentmbx-builder");
  assert.equal(await refusal(builder, "mbx_replay", { project_mailbox: "agentmbx", cursor: page.next_cursor }), "no project mailbox");
  const current = await w.connect("agentmbx-second");
  assert.deepEqual(ids(parsed(await call(current, "mbx_replay", { project_mailbox: "agentmbx" }))), [mailed]);
  assert.equal(await refusal(current, "mbx_replay", { project_mailbox: "no-such-project", cursor: "aaaa" }), "no project mailbox");

  const unbound = await w.connect();
  const refused = await call(unbound, "mbx_replay", { project_mailbox: "agentmbx", cursor: page.next_cursor });
  assert.equal(refused.isError, true, textOf(refused));
  assert.equal(textOf(refused).includes("next_cursor"), false);
  const caught = await call(unbound, "mbx_catchup", { project_mailbox: "agentmbx", cursor: "aaaa" });
  assert.equal(caught.isError, true, textOf(caught));
  assert.equal(textOf(caught).includes("next_cursor"), false);
});

test("T553: a revoked or expired head grants no replay, and an older record does not fall through", async (t) => {
  const revoked = world(t);
  revoked.designate("agentmbx-lead", new Date(Date.now() - 10_000));
  const head = revoked.designate("agentmbx-second", new Date(Date.now() - 1000));
  const mailed = revoked.send(["agentmbx"]);
  const replacement = await revoked.connect("agentmbx-second");
  const page = parsed(await call(replacement, "mbx_replay", { project_mailbox: "agentmbx" }));
  assert.deepEqual(ids(page), [mailed]);
  revoked.revoke(head.id);
  assert.equal(await refusal(replacement, "mbx_replay", { project_mailbox: "agentmbx", cursor: page.next_cursor }), "no project mailbox");
  const former = await revoked.connect("agentmbx-lead");
  assert.equal(await refusal(former, "mbx_replay", { project_mailbox: "agentmbx", cursor: "aaaa" }), "no project mailbox");

  const expired = world(t);
  expired.designate("agentmbx-lead", new Date(Date.now() - 86_400_000));
  expired.designate("agentmbx-second", new Date(Date.now() - 5_000), 1000);
  expired.send(["agentmbx"]);
  const older = await expired.connect("agentmbx-lead");
  assert.equal(await refusal(older, "mbx_replay", { project_mailbox: "agentmbx", cursor: "aaaa" }), "no project mailbox");
  const stale = await expired.connect("agentmbx-second");
  assert.equal(await refusal(stale, "mbx_catchup", { project_mailbox: "agentmbx" }), "no project mailbox");
});

test("T553: project catch-up starts at the current end and does not move the personal checkpoint", async (t) => {
  const w = world(t);
  const slot = slotFor(CLEO_ID);
  w.designate("agentmbx-lead");
  const acked = w.send(["agentmbx"]);
  const lead = await w.connect("agentmbx-lead");
  await call(lead, "mbx_ack", { ids: [acked] });
  const personal = parsed(await call(lead, "mbx_catchup"));
  const personalKey = catchupKey("agentmbx-lead");
  const personalStored = w.kv(personalKey);

  const first = parsed(await call(lead, "mbx_catchup", { project_mailbox: "agentmbx" }));
  assert.deepEqual(ids(first), []);
  assert.equal(first.catchup!.position > 0, true);
  assert.equal(parseReplayFrame(first.next_cursor).mailbox, slot);
  assert.equal(w.kv(personalKey), personalStored);

  const fresh = w.send(["agentmbx"]);
  const next = parsed(await call(lead, "mbx_catchup", { project_mailbox: "agentmbx" }));
  assert.deepEqual(ids(next), [fresh]);
  assert.equal(next.catchup!.position, first.catchup!.position);
  const committed = parsed(await call(lead, "mbx_catchup", { project_mailbox: "agentmbx", commit: next.next_cursor }));
  assert.equal(committed.noop, false);
  assert.ok(committed.to! > committed.from!);
  assert.equal(w.kv(personalKey), personalStored);
  assert.equal(JSON.parse(w.kv(projectCatchupKey(slot))!).position, committed.to);
  const after = parsed(await call(lead, "mbx_catchup"));
  assert.equal(after.catchup!.position, personal.catchup!.position);

  const personalCommit = await call(lead, "mbx_catchup", { project_mailbox: "agentmbx", commit: personal.next_cursor });
  assert.equal(personalCommit.isError, true, textOf(personalCommit));
  assert.equal(parsed(personalCommit).error?.code, "CURSOR_SCOPE_MISMATCH");
  const projectCommit = await call(lead, "mbx_catchup", { commit: next.next_cursor });
  assert.equal(projectCommit.isError, true, textOf(projectCommit));
  assert.equal(w.kv(personalKey), personalStored);
  assert.equal(JSON.parse(w.kv(projectCatchupKey(slot))!).position, committed.to);

  const filtered = parsed(await call(lead, "mbx_replay", { project_mailbox: "agentmbx", topic: "no-such-topic" }));
  const filteredCommit = await call(lead, "mbx_catchup", { project_mailbox: "agentmbx", commit: filtered.next_cursor });
  assert.equal(filteredCommit.isError, true, textOf(filteredCommit));
  assert.equal(parsed(filteredCommit).error?.code, "CURSOR_SCOPE_MISMATCH");

  const restarted = parsed(await call(lead, "mbx_catchup", { project_mailbox: "agentmbx", restart: "all" }));
  assert.equal(restarted.position, 0);
  const history = parsed(await call(lead, "mbx_catchup", { project_mailbox: "agentmbx" }));
  assert.deepEqual(ids(history), [acked, fresh]);
  assert.equal(w.stateOf(acked, slot), "acked");
  assert.equal(w.stateOf(fresh, slot), "delivered");
  assert.equal(w.kv(personalKey), personalStored);
});
