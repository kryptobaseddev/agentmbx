import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";

for (const cli of ["codex", "opencode", "claude", "kimi"]) test(`${cli} initialization respects policy identity scope`, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-context-")), owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: cli, version: "test" });
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const grant = (agent: string, level: "yolo" | "collaborate") => {
    const rec = makePolicy({ level, agents: [agent], hosts: ["alpha"], ownerPub: owner.publicKey });
    assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
    return rec.id;
  };
  const basePolicy = grant("provisional", "yolo");
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "provisional", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const shared = cli === "codex" || cli === "opencode", instructions = c.getInstructions()!;
  if (!shared) { assert.ok(instructions.includes(basePolicy.slice(-6))); return; }
  assert.ok(!instructions.includes(basePolicy.slice(-6)), "base policy must not become transport-wide authority");
  assert.doesNotMatch(instructions, /Your owner has signed an AgentMBX policy for provisional/);
  assert.match(instructions, /mbx_whoami/);
  const meta = cli === "codex" ? { threadId: "01a0e578-d883-7e93-92e3-fbef626be300" } : { sessionID: "ses_scoped" };
  const who = async () => (await c.callTool({ name: "mbx_whoami", arguments: {}, _meta: meta })).structuredContent as { agent: string; policies: { id: string }[] };
  const before = await who(); assert.notEqual(before.agent, "provisional"); assert.deepEqual(before.policies, []);
  const ownPolicy = grant(before.agent, "collaborate");
  assert.deepEqual((await who()).policies.map(p => p.id), [ownPolicy]);
  const base = (await c.callTool({ name: "mbx_whoami", arguments: {} })).structuredContent as { policies: { id: string }[] };
  assert.deepEqual(base.policies.map(p => p.id), [basePolicy]);
});
