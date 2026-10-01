import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { MbxNode } from "../src/node.ts";
import { humanPromptKey, isHumanPrompt, wakeText } from "../src/wake.ts";

for (const implicitReply of [false, true]) test(implicitReply ? "mbx_send reply_to records parent provenance" : "expired relay state cannot be revived by a fresh read", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-test", version: "1" });
  for (const name of ["receiver", "one", "two"]) n.registerAgent(name); // T205: sends need existing recipients
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  // Test-only child clock injection: exercise the real MCP handlers without waiting an hour.
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    // Keep the lease valid while independently advancing the one-hour relay provenance clock.
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_IDENTITY_IDLE_TTL_MS: "7200000", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const parent = n.send({ from: "sender", to: ["reader"], subject: "external", body: "data", hop: 5, origin: "external" }).envelope;
  const fresh = n.send({ from: "sender", to: ["reader"], subject: "fresh", body: "data", hop: 0 }).envelope;
  const send = async (reply_to?: string) => {
    const r = await c.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "relay", body: "data", ...(reply_to ? { reply_to } : {}) } });
    assert.notEqual(r.isError, true);
    return JSON.parse(n.message((r.structuredContent as { id: string }).id)!.envelope);
  };
  if (implicitReply) {
    const e = await send(parent.id); assert.equal(e.thread, parent.thread); assert.equal(e.meta.hop, 6); assert.equal(e.meta.origin, "external"); return;
  }
  const read = (id: string) => c.callTool({ name: "mbx_read", arguments: { ids: [id] } });
  await read(parent.id); await read(fresh.id);
  const active = await send(); assert.equal(active.meta.hop, 6); assert.equal(active.meta.origin, "external");
  now += 3600000; writeFileSync(clock, String(now));
  const expired = await send(); assert.equal(expired.meta.hop ?? 0, 0); assert.equal(expired.meta.origin ?? "agent", "agent");
  await read(fresh.id);
  const renewed = await send(); assert.equal(renewed.meta.hop, 1); assert.equal(renewed.meta.origin ?? "agent", "agent");
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli}: unrelated reads cannot renew expired high-depth or external exposure`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-depth-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-depth-test", version: "1" });
  for (const name of ["receiver", "one", "two"]) n.registerAgent(name); // T205: sends need existing recipients
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_IDENTITY_IDLE_TTL_MS: "10800000", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const old = n.send({ from: "sender", to: ["reader"], subject: "old context", body: "data", hop: 65, origin: "external" }).envelope;
  const fresh = n.send({ from: "sender", to: ["reader"], subject: "unrelated", body: "data" }).envelope;
  const read = async (id: string) => assert.notEqual((await c.callTool({ name: "mbx_read", arguments: { ids: [id] } })).isError, true);
  const send = async (to: string[]) => {
    const result = await c.callTool({ name: "mbx_send", arguments: { to, subject: "new work", body: "direct message" } });
    assert.notEqual(result.isError, true);
    return JSON.parse(n.message((result.structuredContent as { id: string }).id)!.envelope);
  };
  await read(old.id);
  // Unrelated reads retain their own depth without renewing the older exposure.
  for (let i = 0; i < 4; i++) {
    now += 30 * 60_000; writeFileSync(clock, String(now));
    await read(fresh.id);
    if (i === 0) {
      const middle = n.send({ from: "sender", to: ["reader"], subject: "newer internal exposure", body: "data", hop: 4 }).envelope;
      await read(middle.id);
    }
    for (const to of [["one"], ["one", "two"]]) {
      const sent = await send(to);
      assert.equal(sent.thread, sent.id);
      assert.notEqual(sent.thread, old.thread);
      assert.equal(sent.reply_to, null);
      assert.equal(sent.meta.hop, i === 0 ? 66 : i === 1 ? 5 : 1);
      assert.equal(sent.meta.origin ?? "agent", i === 0 ? "external" : "agent");
    }
  }
  // Explicit replies re-read their parent; expiry must not erase actual reply provenance. Forwarding the old thread to
  // someone else keeps its depth; answering its own sender does not relay it (T104), but external origin stays.
  const fwd = await c.callTool({ name: "mbx_send", arguments: { to: ["one"], subject: "fwd", body: "fwd", reply_to: old.id } });
  assert.notEqual(fwd.isError, true);
  const forwarded = JSON.parse(n.message((fwd.structuredContent as { id: string }).id)!.envelope);
  assert.equal(forwarded.meta.hop, 66);
  assert.equal(forwarded.meta.origin, "external");
  const reply = await c.callTool({ name: "mbx_reply", arguments: { id: old.id, body: "reply" } });
  assert.notEqual(reply.isError, true);
  const replied = JSON.parse(n.message((reply.structuredContent as { id: string }).id)!.envelope);
  assert.equal(replied.meta.hop ?? 0, 0);
  assert.equal(replied.meta.origin, "external");

});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli}: maximum relay depth remains deliverable and restricted`, async t => {
  const { checkShape } = await import("../src/envelope.ts");
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-cap-"));
  const owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-cap-test", version: "1" });
  for (const name of ["receiver", "one", "two"]) n.registerAgent(name); // T205: sends need existing recipients
  const rec = makePolicy({ level: "collaborate", agents: ["receiver"], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const parent = n.send({ from: "sender", to: ["reader"], subject: "max depth", body: "data", hop: 1000, origin: "external" }).envelope;
  assert.equal(checkShape(parent), null);
  assert.notEqual((await c.callTool({ name: "mbx_read", arguments: { ids: [parent.id] } })).isError, true);
  for (const request of [
    { name: "mbx_send", arguments: { to: ["receiver"], subject: "new thread", body: "data" } },
    { name: "mbx_send", arguments: { to: ["receiver"], subject: "reply", body: "data", reply_to: parent.id } },
  ]) {
    const result = await c.callTool(request);
    assert.notEqual(result.isError, true);
    const row = n.message((result.structuredContent as { id: string }).id)!;
    const envelope = JSON.parse(row.envelope);
    assert.equal(checkShape(envelope), null, "a relay of a valid message must retain a valid wire envelope");
    assert.equal(envelope.meta.hop, 1000);
    assert.equal(envelope.meta.origin, "external");
    const policy = n.policyFor(row, "receiver");
    assert.equal(policy.level, "ask");
    assert.match(policy.notes.join(" "), /relay depth 1000 exceeds 20 for collaborate/);
    assert.ok((result.structuredContent as { warnings: string[] }).warnings.some(w => /relay depth 1000 exceeds 20: .*will not be woken.*autonomous and yolo have no depth limit/.test(w)),
      "the sender learns the brake applies, instead of a silent missed wake (Fedora T151 report)");
  }
  // answering the deep message's own sender is a conversation, not a relay: no depth, but external origin stays
  const answer = await c.callTool({ name: "mbx_reply", arguments: { id: parent.id, body: "data" } });
  const answered = JSON.parse(n.message((answer.structuredContent as { id: string }).id)!.envelope);
  assert.equal(answered.meta.hop ?? 0, 0); assert.equal(answered.meta.origin, "external");
});

test("a prompt the owner typed ends the relay chain; wake prompts and external origin do not reset (T104)", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-relay-human-"));
  const n = new MbxNode(home, { host: "alpha" }), c = new Client({ name: "relay-human-test", version: "1" });
  for (const name of ["receiver", "one", "two"]) n.registerAgent(name); // T205: sends need existing recipients
  t.after(async () => { await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_IDENTITY_IDLE_TTL_MS: "7200000", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: "reader", MBX_NO_DESKTOP: "1" } as Record<string, string> }));
  const deep = n.send({ from: "sender", to: ["reader"], subject: "deep chain", body: "data", hop: 5 }).envelope;
  const external = n.send({ from: "sender", to: ["reader"], subject: "web page", body: "data", origin: "external" }).envelope;
  const read = async (id: string) => assert.notEqual((await c.callTool({ name: "mbx_read", arguments: { ids: [id] } })).isError, true);
  const send = async () => {
    const r = await c.callTool({ name: "mbx_send", arguments: { to: ["receiver"], subject: "new work", body: "direct message" } });
    assert.notEqual(r.isError, true);
    return JSON.parse(n.message((r.structuredContent as { id: string }).id)!.envelope);
  };
  await read(deep.id);
  assert.equal((await send()).meta.hop, 6, "within a chain, depth accumulates");
  assert.equal(isHumanPrompt(wakeText("reader", [n.message(deep.id)!])), false, "a daemon wake is not the owner");
  assert.equal(isHumanPrompt("[mbx-watch] Call mbx_inbox."), false, "a self-check is not the owner");
  assert.equal(isHumanPrompt(undefined), false, "an unknown hook shape never resets");
  assert.equal(isHumanPrompt("please ask the reviewer again"), true);
  now += 1000; writeFileSync(clock, String(now));
  n.store.set(humanPromptKey("reader"), new Date(now).toISOString()); // what the prompt hook records for a typed prompt
  assert.equal((await send()).meta.hop ?? 0, 0, "the owner's prompt ended the chain");
  await read(external.id);
  now += 1000; writeFileSync(clock, String(now));
  n.store.set(humanPromptKey("reader"), new Date(now).toISOString());
  const after = await send();
  assert.equal(after.meta.hop ?? 0, 0);
  assert.equal(after.meta.origin, "external", "external origin survives a typed prompt: it cannot be laundered");
});
