// T583 (a): message and reply mail woke a recipient only with needs_reply or an @mention typed into the body, and a sender
// asking for attention never heard which recipients would not be woken. `urgent` mentions the resolved recipients inside the
// signed envelope (no schema change); it is refused with status or *. A send that asked for attention (needs_reply or urgent)
// gets one warnings[] line per recipient that still won't be woken, saying why; plain FYI mail stays quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import type { Envelope } from "../src/envelope.ts";
import { urgentWarnings, wakeWarnings } from "../src/mcp.ts";
import type { RecipientReceipt } from "../src/receipts.ts";
import { delegateWake } from "./helpers/wake-lease.ts";

type Receipt = { to: string; address: string; state: string; detail: string };
type SendOut = { id: string; recipients: Receipt[]; warnings: string[] };
type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
const BIN = join(import.meta.dirname, "../bin/agentmbx.js");

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t583-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = async (name: string, extra: Record<string, string> = {}) => {
    const c = new Client({ name: `t583-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0", ...extra } as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return (tool: string, args: Record<string, unknown>) => c.callTool({ name: tool, arguments: args }) as Promise<Result>;
  };
  return { n, home, session };
}
const out = (r: Result) => { assert.notEqual(r.isError, true, r.content.map((c) => c.text).join("\n")); return r.structuredContent as SendOut; };
const byAddr = (o: SendOut, a: string) => o.recipients.find((r) => r.address === a)!;
const wontWake = (o: SendOut) => o.warnings.filter((w) => / will not be woken: /.test(w));
const mentions = (n: MbxNode, id: string) => (JSON.parse(n.message(id)!.envelope) as Envelope).meta.mentions;
const count = (n: MbxNode) => (n.store.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;

test("urgent message to a live push recipient: mentioned in the signed envelope, eligible for wake, no warning", async (t) => {
  const { n, session } = await world(t);
  await session("worker", { MBX_CHANNEL: "1" });
  delegateWake(n, "worker");
  const boss = await session("boss");
  const plain = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "fyi", kind: "message" }));
  assert.equal(byAddr(plain, "worker@alpha").state, "live-next-prompt");
  assert.deepEqual(wontWake(plain), [], "plain FYI mail stays quiet; recipients[] keeps the truth");
  const urgent = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "look now", kind: "message", urgent: true }));
  assert.equal(byAddr(urgent, "worker@alpha").state, "live-wake");
  assert.deepEqual(mentions(n, urgent.id), ["worker"]);
  assert.equal(n.wantsWake("worker", n.message(urgent.id)!), true);
  assert.deepEqual(wontWake(urgent), []);
  assert.deepEqual(mentions(n, plain.id), [], "no mention without urgent");
});

test("urgent resolves role: recipients to the agents they reached", async (t) => {
  const { n, session } = await world(t);
  await session("worker", { MBX_CHANNEL: "1" });
  n.registerAgent("worker", { role: "builder" });
  delegateWake(n, "worker");
  const boss = await session("boss");
  const r = out(await boss("mbx_send", { to: ["role:builder"], subject: "s", body: "b", urgent: true }));
  assert.deepEqual(mentions(n, r.id), ["worker"]);
  assert.equal(byAddr(r, "worker@alpha").state, "live-wake");
});

test("asking for attention warns per recipient that won't be woken, with the reason; needs_reply says the answer waits", async (t) => {
  const { n, session } = await world(t);
  await session("worker"); // live, no push path
  delegateWake(n, "worker");
  const boss = await session("boss");
  const ask = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", kind: "request", needs_reply: true }));
  assert.equal(byAddr(ask, "worker@alpha").state, "live-next-prompt");
  assert.deepEqual(wontWake(ask), ["worker@alpha will not be woken: the session has no push path; it sees this on its next prompt. Your needs_reply answer waits until then."]);
  const urg = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", urgent: true }));
  assert.deepEqual(wontWake(urg), ["worker@alpha will not be woken: the session has no push path; it sees this on its next prompt."]);
  const fyi = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b" }));
  assert.deepEqual(wontWake(fyi), []);
});

test("urgent is refused with status or *, before anything is stored", async (t) => {
  const { n, session } = await world(t);
  await session("worker");
  const boss = await session("boss");
  const before = count(n);
  const st = await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", kind: "status", urgent: true });
  assert.equal(st.isError, true);
  assert.match(st.content[0]!.text, /urgent never applies to kind=status .*use kind=request with needs_reply=true/);
  const all = await boss("mbx_send", { to: ["*"], subject: "s", body: "b", urgent: true });
  assert.equal(all.isError, true);
  assert.match(all.content[0]!.text, /urgent needs named recipients, not \*/);
  const orig = n.send({ from: "worker", to: ["boss"], subject: "q", body: "q" }).envelope;
  const rs = await boss("mbx_reply", { id: orig.id, body: "b", kind: "status", urgent: true });
  assert.equal(rs.isError, true);
  assert.equal(count(n), before + 1, "only the setup message was stored");
});

test("mbx_reply: urgent wakes the sender; a status reply with needs_reply gets the one status line, not a per-recipient one", async (t) => {
  const { n, session } = await world(t);
  await session("boss", { MBX_CHANNEL: "1" });
  delegateWake(n, "boss");
  const worker = await session("worker");
  const q = n.send({ from: "boss", to: ["worker"], subject: "q", body: "q", kind: "request" }).envelope;
  const r = out(await worker("mbx_reply", { id: q.id, body: "done", urgent: true }));
  assert.equal(byAddr(r, "boss@alpha").state, "live-wake");
  assert.deepEqual(mentions(n, r.id), ["boss"]);
  const q2 = n.send({ from: "boss", to: ["worker"], subject: "q2", body: "q", kind: "request" }).envelope;
  const s = out(await worker("mbx_reply", { id: q2.id, body: "fyi", kind: "status", needs_reply: true }));
  assert.equal(s.warnings.filter((w) => /kind=status never wakes/.test(w)).length, 1, "sendReply now carries statusWakeWarning");
  assert.deepEqual(wontWake(s), []);
  const q3 = n.send({ from: "boss", to: ["worker"], subject: "q3", body: "q", kind: "request" }).envelope;
  const viaSend = out(await worker("mbx_send", { id: q3.id, body: "done", urgent: true }));
  assert.deepEqual(mentions(n, viaSend.id), ["boss"], "the reply-shaped mbx_send passes urgent through");
});

test("agentmbx send --urgent mentions the recipient; --urgent with --kind status is refused and stores nothing", async (t) => {
  const { n, home } = await world(t);
  n.registerAgent("boss"); n.registerAgent("worker");
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" };
  const id = (JSON.parse(execFileSync(process.execPath, [BIN, "send", "--as", "boss", "--to", "worker", "--subject", "s", "-m", "b", "--urgent", "--json"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { id: string }).id;
  assert.deepEqual(mentions(n, id), ["worker"]);
  const before = count(n);
  assert.throws(() => execFileSync(process.execPath, [BIN, "send", "--as", "boss", "--to", "worker", "--subject", "s", "-m", "b", "--kind", "status", "--urgent"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /urgent never applies to kind=status/);
  assert.equal(count(n), before);
});

test("wakeWarnings caps at 10 lines; urgentWarnings names a nameless remote target once", () => {
  const e = { kind: "message", needs_reply: false, meta: { mentions: [] } } as unknown as Envelope;
  const rs: RecipientReceipt[] = Array.from({ length: 12 }, (_, i) => ({ to: `a${i}`, address: `a${i}@alpha`, state: "live-next-prompt", detail: "held; seen on its next prompt: the session has no push path" }));
  rs.push({ to: "owner", address: "owner@alpha", state: "live-next-prompt", detail: "the owner sees it in agentmbx inbox" });
  const w = wakeWarnings(rs, e, true);
  assert.equal(w.length, 11);
  assert.match(w[10]!, /^and 2 more recipients that will not be woken/);
  assert.deepEqual(wakeWarnings(rs, e, false), [], "no attention asked");
  assert.deepEqual(wakeWarnings(rs, { ...e, kind: "status", needs_reply: true } as Envelope, false), [], "status has its own line");
  const kindWhy: RecipientReceipt = { to: "w", address: "w@alpha", state: "forwarded", detail: "v was renamed to w; live-next-prompt: held; seen on its next prompt: this kind does not wake (status, or no needs_reply/mention)" };
  assert.match(wakeWarnings([kindWhy], e, true)[0]!, /^w@alpha will not be woken: this kind does not wake .* Send urgent=true \(or kind=request\) to wake it\.$/);
  const targets = [{ to: "role:builder", host: "beta" }, { to: "role:builder", host: "beta" }, { to: "x@beta", name: "x", host: "beta" }, { to: "y", name: "y" }];
  assert.deepEqual(urgentWarnings(targets, true), ["urgent can't name the recipients of role:builder on beta; they wake only if the kind does"]);
  assert.deepEqual(urgentWarnings(targets, false), []);
});
