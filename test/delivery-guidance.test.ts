// T163: a held agent sees only its own outgoing delivery, raw queue errors stay a class, and connector guidance does not take the lease.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateKeyPair } from "../src/crypto.ts";
import { connectorKey } from "../src/diagnostics.ts";
import { MbxNode } from "../src/node.ts";
import type { OwnDelivery } from "../src/receipts.ts";

const SECRET = "fetch failed https://secret:password@host PRIVATE_BODY";

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), "mbx-t163-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const session = async (name: string) => {
    const c = new Client({ name: `t163-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    clients.push(c);
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name: tool, arguments: args });
      return r as unknown as { isError?: boolean; content: { text: string }[]; structuredContent?: OwnDelivery & { guidance: string[] } };
    };
  };
  return { n, session };
}

const parsed = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as OwnDelivery & { guidance: string[] };

test("T163: own delivery, a class instead of the raw error, and reconnect guidance that leaves the lease", async (t) => {
  const { n, session } = await world(t);
  const boss = await session("boss");
  const worker = await session("worker");
  const beta = generateKeyPair();
  n.upsertPendingPeer({ host: "beta", pubkey: beta.publicKey, owner_pubkey: null, addr: "127.0.0.1:9", code: "000000", nonce_local: "n", nonce_remote: "n" });
  n.approvePeer("beta");
  const localId = n.send({ from: "boss", to: ["worker"], subject: "local note", body: "LOCAL_PRIVATE_BODY" }).envelope.id;
  const remoteId = n.send({ from: "boss", to: ["worker@beta"], subject: "far note", body: "REMOTE_PRIVATE_BODY" }).envelope.id;
  n.store.db.prepare("UPDATE outbox SET attempts=3, last_error=? WHERE msg_id=?").run(SECRET, remoteId);

  const leaseOf = () => JSON.stringify(n.store.db.prepare("SELECT name, token, holder_pid, holder_start, released_at FROM identity_leases WHERE name='boss'").get());
  const requests = () => Number(n.store.db.prepare("SELECT COUNT(*) n FROM kv WHERE k GLOB 'identity-request:*'").get()!.n);
  const before = leaseOf();
  const beforeRequests = requests();
  const held = n.store.db.prepare("SELECT holder_pid, holder_start FROM identity_leases WHERE name='boss'").get() as { holder_pid: number; holder_start: string };
  const key = connectorKey(held.holder_pid);

  const fresh = parsed(await boss("mbx_delivery"));
  assert.deepEqual(fresh.guidance, [], n.store.get(key));
  assert.equal(fresh.drafts, null);
  assert.equal(fresh.draft_reason, "no draft store");
  assert.equal(fresh.task_completion, "not-reported");
  const localState = (n.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='worker'").get(localId) as { state: string }).state;
  const local = fresh.items.find((i) => i.id === localId && i.peer === "worker@alpha");
  const remote = fresh.items.find((i) => i.id === remoteId);
  assert.ok(local, JSON.stringify(fresh.items));
  assert.equal(local.state, localState);
  assert.equal(local.failure, null);
  assert.ok(remote, JSON.stringify(fresh.items));
  assert.equal(remote.state, "queued");
  assert.equal(remote.peer, "worker@beta");
  assert.deepEqual(remote.failure && { code: remote.failure.code, attempts: remote.failure.attempts }, { code: "PEER_UNREACHABLE", attempts: 3 });
  const dumped = JSON.stringify(fresh);
  assert.equal(dumped.includes("PRIVATE_BODY"), false);
  assert.equal(dumped.includes("secret"), false);
  assert.equal(dumped.includes("password"), false);
  assert.equal(dumped.includes("local note"), false);

  const other = parsed(await worker("mbx_delivery"));
  assert.equal(other.items.some((i) => i.id === localId || i.id === remoteId), false);

  const sent = await boss("mbx_sent");
  assert.equal(sent.isError, undefined);
  assert.match(sent.content[0].text, /PEER_UNREACHABLE/);
  assert.doesNotMatch(sent.content[0].text, /secret|PRIVATE_BODY|password/);
  const sentJson = JSON.stringify(sent.structuredContent);
  assert.equal(sentJson.includes("secret"), false);
  assert.equal(sentJson.includes("last_error\":"), false);
  assert.match(sentJson, /PEER_UNREACHABLE/);

  const staleReport = JSON.stringify({ v: 1, pid: held.holder_pid, start: held.holder_start, version: "0.0.0", build: "old", tools: [], at: new Date(Date.now() - 10 * 60_000).toISOString(), cli: "claude" });
  let stale = fresh;
  for (let i = 0; i < 3 && !stale.guidance.length; i++) {
    n.store.set(key, staleReport);
    stale = parsed(await boss("mbx_delivery"));
  }
  assert.ok(stale.guidance.length >= 2, stale.guidance.join("\n"));
  assert.match(stale.guidance.join("\n"), /reconnect the mbx MCP server before changing ownership/);
  assert.match(stale.guidance.join("\n"), /does not release it/);

  let missing = fresh;
  for (let i = 0; i < 3 && !missing.guidance.length; i++) {
    n.store.db.prepare("DELETE FROM kv WHERE k=?").run(key);
    missing = parsed(await boss("mbx_delivery"));
  }
  assert.ok(missing.guidance.length >= 2);
  assert.equal(leaseOf(), before);
  assert.equal(requests(), beforeRequests);
});
