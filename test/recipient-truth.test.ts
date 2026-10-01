// Send-time recipient truth (T205): every send says, per recipient, whether a live session is woken now, sees it on its
// next prompt, is offline (and since when), was renamed, or is on another host; a name that never existed is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeyPair } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { assertKnownRecipients, suggestNames } from "../src/receipts.ts";
import { delegateWake } from "./helpers/wake-lease.ts";

type Receipt = { to: string; address: string; state: string; detail: string };
type SendOut = { id: string; recipients: Receipt[]; warnings: string[] };

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-truth-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = async (name: string, extra: Record<string, string> = {}) => {
    const c = new Client({ name: `truth-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0", ...extra } as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return async (tool: string, args: Record<string, unknown>) => c.callTool({ name: tool, arguments: args });
  };
  return { n, session };
}
const out = (r: unknown) => (r as { structuredContent: unknown }).structuredContent as SendOut;
const byAddr = (o: SendOut, a: string) => o.recipients.find((r) => r.address === a)!;

test("live recipients: woken now for a request, next prompt for a status", async (t) => {
  const { n, session } = await world(t);
  await session("worker", { MBX_CHANNEL: "1" }); // a push path
  delegateWake(n, "worker");
  const boss = await session("boss");
  const req = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", kind: "request", needs_reply: true }));
  assert.equal(byAddr(req, "worker@alpha").state, "live-wake");
  assert.match(byAddr(req, "worker@alpha").detail, /held by claude session .*woken now/);
  assert.deepEqual(req.warnings.filter((w) => /offline/.test(w)), []);
  const st = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", kind: "status" }));
  assert.equal(byAddr(st, "worker@alpha").state, "live-next-prompt");
  assert.match(byAddr(st, "worker@alpha").detail, /next prompt: this kind does not wake/);
});

test("offline recipients: never held, or released, with since-when and last holder, plus a sender warning", async (t) => {
  const { n, session } = await world(t);
  n.registerAgent("ghost");
  const leaving = await session("leaver");
  assert.notEqual((await leaving("mbx_identity", { action: "release" })).isError, true);
  const boss = await session("boss");
  const r = out(await boss("mbx_send", { to: ["ghost", "leaver"], subject: "s", body: "b", kind: "request" }));
  assert.equal(byAddr(r, "ghost@alpha").state, "offline");
  assert.match(byAddr(r, "ghost@alpha").detail, /no session has ever held this mailbox/);
  assert.equal(byAddr(r, "leaver@alpha").state, "offline");
  assert.match(byAddr(r, "leaver@alpha").detail, /no live session since \d{4}-.*last holder claude session .*released/);
  assert.equal(r.warnings.filter((w) => /is offline: .*waits in its mailbox/.test(w)).length, 2);
});

test("a renamed mailbox is reported as forwarded to its successor", async (t) => {
  const { n, session } = await world(t);
  await session("worker", { MBX_CHANNEL: "1" });
  n.store.set("alias:old-worker", "worker");
  const boss = await session("boss");
  const r = out(await boss("mbx_send", { to: ["old-worker"], subject: "s", body: "b", kind: "request" }));
  assert.equal(byAddr(r, "worker@alpha").state, "forwarded");
  assert.match(byAddr(r, "worker@alpha").detail, /old-worker was renamed to worker; live-/);
});

test("paired-host recipients are remote; a name on both hosts goes local with a warning", async (t) => {
  const { n, session } = await world(t);
  const beta = generateKeyPair();
  n.upsertPendingPeer({ host: "beta", pubkey: beta.publicKey, owner_pubkey: null, addr: "127.0.0.1:9", code: "000000", nonce_local: "n", nonce_remote: "n" });
  n.approvePeer("beta");
  n.store.db.prepare("INSERT INTO agents (name,host,role,cli,description,last_seen) VALUES ('worker','beta',NULL,'claude',NULL,?)").run(new Date().toISOString());
  const boss = await session("boss");
  const remote = out(await boss("mbx_send", { to: ["worker@beta"], subject: "s", body: "b", kind: "request" }));
  assert.equal(byAddr(remote, "worker@beta").state, "remote");
  assert.match(byAddr(remote, "worker@beta").detail, /queued for paired host beta at 127\.0\.0\.1:9/);
  n.registerAgent("worker");
  const both = out(await boss("mbx_send", { to: ["worker"], subject: "s", body: "b", kind: "request" }));
  assert.equal(byAddr(both, "worker@alpha").state, "offline");
  assert.ok(both.warnings.some((w) => /worker also exists on beta: delivered to worker@alpha; use worker@<host>/.test(w)));
});

test("a local name that never existed is refused with suggestions, and nothing is stored", async (t) => {
  const { n, session } = await world(t);
  n.registerAgent("worker"); n.registerAgent("reviewer");
  const boss = await session("boss");
  const before = (n.store.db.prepare("SELECT count(*) c FROM messages").get() as { c: number }).c;
  const r = await boss("mbx_send", { to: ["wroker"], subject: "s", body: "b" });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /not sent: \\"wroker\\" is not an agent on alpha; did you mean worker\?/);
  assert.equal((n.store.db.prepare("SELECT count(*) c FROM messages").get() as { c: number }).c, before, "no message, no mailbox");
  assert.equal(n.inbox("wroker").length, 0);
  // explicit local host is checked too; other hosts are their business; known-but-quiet names pass
  assert.throws(() => assertKnownRecipients(n, ["nobody@alpha"]), /"nobody" is not an agent on alpha/);
  assert.doesNotThrow(() => assertKnownRecipients(n, ["worker", "owner", "role:reviewer", "*"]));
  assert.deepEqual(suggestNames(n, "rev"), ["reviewer"]);
  assert.deepEqual(suggestNames(n, "zzzzzz"), []);
});

test("the CLI refuses a never-held name unless the owner deliberately creates the mailbox", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { n } = await world(t);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../bin/agentmbx.js"), ...args],
    { encoding: "utf8", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: n.home, MBX_NO_DESKTOP: "1", MBX_AGENT: "" } });
  const refused = cli("send", "--as", "shell-boss", "--to", "later-agent", "--subject", "s", "-m", "b");
  assert.equal(refused.status, 1); assert.match(refused.stderr, /not sent: "later-agent" is not an agent/);
  const made = cli("send", "--as", "shell-boss", "--to", "later-agent", "--new-mailbox", "--subject", "s", "-m", "b", "--json");
  assert.equal(made.status, 0, made.stderr);
  const r = JSON.parse(made.stdout) as SendOut;
  assert.equal(byAddr(r, "later-agent@alpha").state, "offline");
  assert.equal(n.inbox("later-agent").length, 1);
});
