// T496: mbx_agents over MCP returns the live roster (mbx.agents/v1). The unit tests in roster.test.ts cover the rules;
// this checks the tool: its schema, a bound and an unbound session, the project argument and its refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import { retiredKey } from "../src/identity-cleanup.ts";
import { makeLead, storeLead } from "../src/lead-record.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { noteProject, registerIdentity } from "../src/registry.ts";
import { validateAgentsV1, type AgentsV1 } from "../src/status-schema.ts";

const BIN = join(import.meta.dirname, "../bin/agentmbx.js");
const PASS = "test-only-passphrase";

function world(t: { after: (fn: () => unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), "mbx-roster-mcp-"));
  const home = join(root, "home");
  const user = mkdtempSync(join(tmpdir(), "mbx-roster-mcp-user-"));
  const projA = realpathSync(mkdirSync(join(root, "proj-a"), { recursive: true }) ?? join(root, "proj-a"));
  const projB = realpathSync(mkdirSync(join(root, "proj-b"), { recursive: true }) ?? join(root, "proj-b"));
  const node = new MbxNode(home, { host: "alpha" });
  createOwnerKey(home, PASS);
  const owner = unlockOwnerKey(home, PASS);
  const clients: Client[] = [];
  let open = true;
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    if (open) node.close();
    for (const d of [root, user]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const persona = (name: string, project: string, role: string) => {
    registerIdentity(node.store, { name, role });
    node.registerAgent(name, { role });
    noteProject(node.store, name, project, true);
  };
  const designate = (agent: string, project: string) => {
    const rec = makeLead({ project, agent, host: "alpha", ownerPub: owner.publicKey });
    return storeLead(node, rec, signData(owner.privateKey, canonical(rec)));
  };
  const connect = async (cwd: string, extra: Record<string, string> = {}) => {
    if (open) { node.close(); open = false; }
    const c = new Client({ name: "roster-mcp", version: "1" });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [BIN, "mcp"], cwd,
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, HOME: user, MBX_CLI: "claude", MBX_AGENT: "", MBX_NO_DESKTOP: "1", ...extra } as Record<string, string>,
    }));
    clients.push(c);
    return c;
  };
  return { node, projA, projB, persona, designate, connect };
}

const body = (r: unknown) => (r as { structuredContent: AgentsV1 }).structuredContent;
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

test("mbx_agents advertises project and all, and answers in mbx.agents/v1", async (t) => {
  const w = world(t);
  w.persona("agentmbx-lead", w.projA, "lead"); w.persona("old-retired", w.projA, "builder");
  w.node.store.set(retiredKey("old-retired"), "retired");
  w.designate("agentmbx-lead", w.projA);
  const c = await w.connect(w.projA, { MBX_AGENT: "worker" });

  const tool = (await c.listTools()).tools.find((x) => x.name === "mbx_agents")!;
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ["all", "project"]);
  assert.match(tool.description ?? "", /live \(a verified session holds it\)/);

  const r = await c.callTool({ name: "mbx_agents", arguments: {} });
  const roster = body(r);
  assert.deepEqual(validateAgentsV1(roster), []);
  assert.equal(roster.scope.project, w.projA);
  assert.equal(roster.lead?.address, "agentmbx-lead@alpha");
  const me = roster.agents.find((a) => a.name === "worker")!;
  assert.deepEqual([me.self, me.state, me.harness], [true, "live", "claude"], "the calling session holds its lease: live, verified, harness claude");
  const lead = roster.agents.find((a) => a.name === "agentmbx-lead")!;
  assert.deepEqual([lead.lead_of, lead.state, lead.role], [[w.projA], "offline", "lead"], "nobody holds the lead's mailbox, so it is offline though the lead record is valid");
  assert.equal(roster.agents.some((a) => a.name === "old-retired"), false, "retired names are hidden by default");
  assert.equal(roster.scope.hidden, 1);
  assert.match(textOf(r), /agentmbx-lead@alpha {2}offline {2}LEAD of proj-a/);
  assert.match(textOf(r), /worker@alpha {2}live {2}\(you\)/);
  assert.match(textOf(r), /lead: agentmbx-lead@alpha until /);
  assert.match(textOf(r), /1 retired or generated name\(s\) hidden/);
  for (const a of roster.agents) for (const k of ["unread", "messages"]) assert.equal(Object.hasOwn(a, k), false);

  const all = body(await c.callTool({ name: "mbx_agents", arguments: { all: true } }));
  assert.equal(all.agents.find((a) => a.name === "old-retired")?.retired, true);
  assert.equal(all.scope.hidden, 0);
});

test("mbx_agents: another project's lead is a row, project * lists everyone, an unrelated folder is refused", async (t) => {
  const w = world(t);
  w.persona("a-lead", w.projA, "lead"); w.persona("a-dev", w.projA, "builder");
  w.designate("a-lead", w.projA);
  const b = await w.connect(w.projB, { MBX_AGENT: "b-dev" });

  const def = body(await b.callTool({ name: "mbx_agents", arguments: {} }));
  assert.deepEqual(def.agents.map((a) => a.name).sort(), ["a-lead", "b-dev"], "B sees its own persona and A's lead, not A's other members");
  assert.deepEqual(def.agents.find((a) => a.name === "a-lead")!.lead_of, [w.projA]);
  assert.equal(def.lead, null, "the top-level lead stays this project's: B has none");

  const everyone = body(await b.callTool({ name: "mbx_agents", arguments: { project: "*" } }));
  assert.deepEqual(everyone.agents.map((a) => a.name).sort(), ["a-dev", "a-lead", "b-dev"]);
  assert.equal(everyone.scope.all_projects, true);

  const refused = await b.callTool({ name: "mbx_agents", arguments: { project: w.projA } });
  assert.equal((refused as { isError?: boolean }).isError, true);
  assert.match(textOf(refused), /lists its own project/);
  const own = body(await b.callTool({ name: "mbx_agents", arguments: { project: w.projB } }));
  assert.deepEqual(own.agents.map((a) => a.name).sort(), ["a-lead", "b-dev"], "asking for its own folder is the default view");
});

test("mbx_agents works for a session that holds no identity yet", async (t) => {
  const w = world(t);
  w.persona("a-lead", w.projA, "lead"); w.persona("a-dev", w.projA, "builder");
  w.designate("a-lead", w.projA);
  const u = await w.connect(w.projA);
  const roster = body(await u.callTool({ name: "mbx_agents", arguments: {} }));
  assert.deepEqual(validateAgentsV1(roster), []);
  assert.deepEqual(roster.agents.map((a) => a.name).sort(), ["a-dev", "a-lead"]);
  assert.equal(roster.agents.some((a) => a.self), false, "an unbound session has no row of its own");
  assert.equal(roster.lead?.address, "a-lead@alpha");
});
