// Sender receipts (T207): a sender can see what happened to every message it sent, per recipient: delivery state with
// note and did, liveness now, and for paired hosts whether the outbox still holds it. Paging mirrors replay cursors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeyPair } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { sentPage } from "../src/receipts.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { findIdentityControl, publishIdentityControl } from "../src/identity-control.ts";
import { dispatchWakes } from "../src/wake.ts";

type Receipt = { address: string; state: string; did: string | null; note: string | null; liveness: string; outbox?: { attempts: number } };
type Page = { messages: { id: string; subject: string; recipients: Receipt[] }[]; next_cursor: string; has_more: boolean };

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-sent-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = async (name: string) => {
    const c = new Client({ name: `sent-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name: tool, arguments: args });
      return r as unknown as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
    };
  };
  return { n, session };
}

test("T376: mbx_sent reports desktop fallback after a rejected Codex binding", async t => {
  const { n, session } = await world(t);
  bindWakeLease(n, { agent: "worker", cli: "codex", session_id: "exact-thread", pid: process.pid });
  const descriptor = findIdentityControl(n.store, "codex", "exact-thread");
  publishIdentityControl(n.store, { ...descriptor, generation: "0".repeat(64) });
  const old = process.env.MBX_NO_DESKTOP;
  process.env.MBX_NO_DESKTOP = "1";
  t.after(() => { if (old === undefined) delete process.env.MBX_NO_DESKTOP; else process.env.MBX_NO_DESKTOP = old; });
  const boss = await session("boss");
  const sent = (await boss("mbx_send", { to: ["worker"], subject: "wake", body: "private", kind: "request" })).structuredContent as unknown as
    { id: string; recipients: { state: string; detail: string }[] };
  assert.equal(sent.recipients[0].state, "live-next-prompt");
  assert.match(sent.recipients[0].detail, /lease or session binding could not be verified/);
  await dispatchWakes(n);
  const result = await boss("mbx_sent");
  const receipt = (result.structuredContent as unknown as Page).messages.find(m => m.id === sent.id)!.recipients[0];
  assert.equal(receipt.state, "notified");
  assert.equal(receipt.note, "desktop");
  assert.match(result.content[0].text, /owner desktop notice only/);
  assert.doesNotMatch(result.content[0].text, /woken now/);
});

test("the sender sees delivered → acked with the recipient's did and liveness, and the thread shows it too", async (t) => {
  const { session } = await world(t);
  const worker = await session("worker");
  const boss = await session("boss");
  const sent = (await boss("mbx_send", { to: ["worker"], subject: "review PR", body: "please", kind: "request" })).structuredContent as { id: string };
  let page = (await boss("mbx_sent")).structuredContent as unknown as Page;
  const r0 = page.messages.find((m) => m.id === sent.id)!.recipients[0];
  assert.equal(r0.address, "worker@alpha"); assert.match(r0.state, /^(delivered|notified)$/); assert.match(r0.liveness, /^live: held by claude/);
  await worker("mbx_read", { ids: [sent.id] }); // opening it marks the worker's copy read, and the sender sees that
  assert.equal(((await boss("mbx_sent")).structuredContent as unknown as Page).messages[0].recipients[0].state, "read");
  await boss("mbx_read", { ids: [sent.id] }); // the sender reading its own sent mail changes nothing for the recipient
  assert.equal(((await boss("mbx_sent")).structuredContent as unknown as Page).messages[0].recipients[0].state, "read");
  await worker("mbx_ack", { ids: [sent.id], did: "reviewed, two comments" });
  page = (await boss("mbx_sent")).structuredContent as unknown as Page;
  const r = page.messages[0].recipients[0];
  assert.equal(r.state, "acked"); assert.equal(r.did, "reviewed, two comments");
  const thread = (await boss("mbx_thread", { id: sent.id })).content[0].text;
  assert.match(thread, /→ worker@alpha: acked .* · did: reviewed, two comments · live: held by claude/);
  // a sender sees only its own sent mail
  assert.equal(((await worker("mbx_sent")).structuredContent as unknown as Page).messages.length, 0);
});

test("paging: opaque stable cursor, finite snapshot, a completed cursor polls for newer mail, scope and tamper checks", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-sent-page-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.registerAgent("worker");
  const ids = Array.from({ length: 5 }, (_, i) => n.send({ from: "boss", to: ["worker"], subject: `m${i}`, body: "b" }).envelope.id);
  const p1 = sentPage(n, "boss", { limit: 2 });
  assert.deepEqual(p1.messages.map((m) => m.id), ids.slice(0, 2)); assert.equal(p1.has_more, true);
  assert.deepEqual(sentPage(n, "boss", { limit: 2, cursor: p1.next_cursor }), sentPage(n, "boss", { limit: 2, cursor: p1.next_cursor }), "retrying a cursor is idempotent");
  const p2 = sentPage(n, "boss", { limit: 2, cursor: p1.next_cursor });
  // mail sent mid-traversal is not part of this snapshot ...
  const later = n.send({ from: "boss", to: ["worker"], subject: "later", body: "b" }).envelope.id;
  const p3 = sentPage(n, "boss", { limit: 2, cursor: p2.next_cursor });
  assert.deepEqual([...p2.messages, ...p3.messages].map((m) => m.id), ids.slice(2)); assert.equal(p3.has_more, false);
  // ... and polling the completed cursor picks it up, without repeating history
  const p4 = sentPage(n, "boss", { limit: 2, cursor: p3.next_cursor });
  assert.deepEqual(p4.messages.map((m) => m.id), [later]);
  assert.throws(() => sentPage(n, "worker", { cursor: p1.next_cursor }), (e: Error & { code?: string }) => e.code === "CURSOR_SCOPE_MISMATCH");
  assert.throws(() => sentPage(n, "boss", { cursor: p1.next_cursor.slice(0, -2) + "xx" }), (e: Error & { code?: string }) => e.code === "CURSOR_INVALID");
  assert.throws(() => sentPage(n, "boss", { limit: 0 }), /bounds/);
  n.store.set("replay:epoch", "restored");
  assert.throws(() => sentPage(n, "boss", { cursor: p1.next_cursor }), (e: Error & { code?: string }) => e.code === "CURSOR_EXPIRED");
});

test("paired-host recipients show the outbox: queued with attempts until accepted", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-sent-remote-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  const beta = generateKeyPair();
  n.upsertPendingPeer({ host: "beta", pubkey: beta.publicKey, owner_pubkey: null, addr: "127.0.0.1:9", code: "000000", nonce_local: "n", nonce_remote: "n" });
  n.approvePeer("beta");
  const id = n.send({ from: "boss", to: ["worker@beta"], subject: "far", body: "b" }).envelope.id;
  n.store.db.prepare("UPDATE outbox SET attempts=3, last_error='fetch failed'").run();
  let r = sentPage(n, "boss").messages[0].recipients[0];
  assert.equal(r.address, "worker@beta"); assert.equal(r.state, "queued"); assert.equal(r.outbox!.attempts, 3);
  assert.match(r.liveness, /not accepted yet/);
  n.store.db.prepare("DELETE FROM outbox WHERE msg_id=?").run(id);
  r = sentPage(n, "boss").messages[0].recipients[0];
  assert.equal(r.state, "handed-over"); assert.match(r.liveness, /accepted by paired host beta/);
});
