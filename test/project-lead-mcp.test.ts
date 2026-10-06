// T393 AC2: mbx_whoami and mbx_agents show this session's project lead, and no other project's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { makeLead, storeLead } from "../src/project-ledger.ts";
import { registerIdentity } from "../src/registry.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const PASS = "test-only-passphrase";

type LeadField = { address: string; exp: string } | null;

function world(t: { after: (fn: () => unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-lead-mcp-"));
  const home = join(root, "home");
  const user = mkdtempSync(join(tmpdir(), "mbx-lead-mcp-user-"));
  const projA = realpathSync(mkdirSync(join(root, "proj-a"), { recursive: true }) ?? join(root, "proj-a"));
  const projB = realpathSync(mkdirSync(join(root, "proj-b"), { recursive: true }) ?? join(root, "proj-b"));
  const node = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  registerIdentity(node.store, { name: "decoy", role: "lead" });
  node.registerAgent("agentmbx-lead");
  node.registerAgent("decoy", { role: "lead" });
  const clients: Client[] = [];
  let open = true;
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    if (open) node.close();
    for (const d of [root, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const designate = (agent: string, project: string) => {
    const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey });
    return storeLead(node, rec, signData(owner.privateKey, canonical(rec)));
  };
  const connect = async (cwd: string, extra: Record<string, string> = {}) => {
    if (open) { node.close(); open = false; }
    const c = new Client({ name: "lead-mcp", version: "1" });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [BIN, "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1", ...extra } as Record<string, string>,
    }));
    clients.push(c);
    return c;
  };
  return { projA, projB, designate, connect };
}

const json = (r: unknown) => (r as { structuredContent?: Record<string, unknown> }).structuredContent ?? JSON.parse((r as { content: { text: string }[] }).content[0].text);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
const leadLine = (exp: string) => new RegExp(`lead: agentmbx-lead@alpha until ${exp.replace(/[.]/g, "\\.")}`);

test("unbound and bound whoami and agents show the designated lead, and a role label is not it", async (t) => {
  const { projA, designate, connect } = world(t);
  const rec = designate("agentmbx-lead", projA);
  const expected = { address: "agentmbx-lead@alpha", exp: rec.exp };

  const unbound = await connect(projA);
  const whoU = json(await unbound.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(whoU.agent, null);
  assert.equal(whoU.unbound, true);
  assert.equal(whoU.project, projA);
  assert.deepEqual(whoU.lead, expected);
  const agentsU = await unbound.callTool({ name: "mbx_agents", arguments: {} });
  const bodyU = json(agentsU) as { agents: Record<string, unknown>[]; lead: LeadField };
  assert.deepEqual(bodyU.lead, expected);
  assert.match(textOf(agentsU), leadLine(rec.exp));
  for (const row of bodyU.agents) assert.equal(Object.hasOwn(row, "lead"), false, "the lead is not a column on an agent row");

  const bound = await connect(projA, { MBX_AGENT: "worker" });
  const whoB = json(await bound.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(whoB.agent, "worker");
  assert.equal(whoB.unbound, undefined);
  assert.equal(whoB.project, projA);
  assert.deepEqual(whoB.lead, expected);
  const agentsB = json(await bound.callTool({ name: "mbx_agents", arguments: {} })) as { agents: Record<string, unknown>[]; lead: LeadField };
  assert.deepEqual(agentsB.lead, expected);
  for (const row of agentsB.agents) assert.equal(Object.hasOwn(row, "lead"), false);

  const labeled = await connect(projA, { MBX_AGENT: "decoy" });
  const whoL = json(await labeled.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(whoL.agent, "decoy");
  assert.equal(whoL.role, "lead");
  assert.deepEqual(whoL.lead, expected, "a role label of lead is not the designated lead");

  const send = (await labeled.listTools()).tools.find((tool) => tool.name === "mbx_send");
  assert.match(send?.description ?? "", /lead and role:lead/);
  assert.match(send?.description ?? "", /owner-designated lead of this session's project/);
});

test("whoami and agents are null and say none when the project has no lead", async (t) => {
  const { projA, connect } = world(t);
  const c = await connect(projA, { MBX_AGENT: "worker" });
  const who = json(await c.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(who.agent, "worker");
  assert.equal(who.lead, null);
  const agents = await c.callTool({ name: "mbx_agents", arguments: {} });
  assert.equal((json(agents) as { lead: LeadField }).lead, null);
  assert.match(textOf(agents), /lead: none/);
  const unbound = await connect(projA);
  assert.equal(json(await unbound.callTool({ name: "mbx_whoami", arguments: {} })).lead, null);
  const agentsU = await unbound.callTool({ name: "mbx_agents", arguments: {} });
  assert.equal((json(agentsU) as { lead: LeadField }).lead, null);
  assert.match(textOf(agentsU), /lead: none/);
});

test("a session in project B does not see project A's lead", async (t) => {
  const { projA, projB, designate, connect } = world(t);
  const rec = designate("agentmbx-lead", projA);
  const b = await connect(projB);
  const who = json(await b.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(who.unbound, true);
  assert.equal(who.project, projB);
  assert.equal(who.lead, null);
  const agents = await b.callTool({ name: "mbx_agents", arguments: {} });
  assert.equal((json(agents) as { lead: LeadField }).lead, null);
  assert.match(textOf(agents), /lead: none/);
  assert.doesNotMatch(textOf(agents), leadLine(rec.exp));
  const bound = await connect(projB, { MBX_AGENT: "other" });
  const whoB = json(await bound.callTool({ name: "mbx_whoami", arguments: {} }));
  assert.equal(whoB.agent, "other");
  assert.equal(whoB.project, projB);
  assert.equal(whoB.lead, null);
});
