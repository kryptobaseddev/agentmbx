// T315/T316: a mailbox that exists here is resumed by name without a role (the list and the claim agree), a brand-new
// name still needs one; and the session holding a lease sees it as held by this session, never as claimable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { registeredIdentity } from "../src/registry.ts";

type Item = { name: string; state: string; claimable: boolean; reason: string };
test("claim by name resumes a known unregistered mailbox; new names need a role; the holder sees its own lease as held", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-claim-known-"));
  const n = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "claim-known", version: "1" });
  t.after(async () => { await client.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  n.registerAgent("vida-claude", { role: "builder" }); // a mailbox from before chosen identities: agents row, never registered
  n.send({ from: "boss", to: ["vida-claude"], subject: "s", body: "b" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "", MBX_CLI: "claude", AGENTMBX_DEV: "1" } as Record<string, string> }));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const list = async () => ((await call("mbx_identity", { action: "list", all: true })).structuredContent as { identities: Item[] }).identities;

  assert.equal((await list()).find((i) => i.name === "vida-claude")?.claimable, true);
  const fresh = await call("mbx_identity", { action: "claim", name: "brand-new-name" });
  assert.equal(fresh.isError, true); assert.match((fresh.content as { text: string }[])[0].text, /pass role/);
  const claimed = await call("mbx_identity", { action: "claim", name: "vida-claude" });
  assert.notEqual(claimed.isError, true, JSON.stringify(claimed.content));
  assert.equal(registeredIdentity(n.store, "vida-claude")?.role, "builder", "keeps the role it was known by");
  const who = (await call("mbx_whoami")).structuredContent as { agent: string; unread: number };
  assert.equal(who.agent, "vida-claude"); assert.equal(who.unread, 1);

  const own = (await list()).find((i) => i.name === "vida-claude")!;
  assert.equal(own.state, "held"); assert.equal(own.claimable, false); assert.equal(own.reason, "held by this session");
});
