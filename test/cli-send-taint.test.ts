// CLI send reads the conversation taint record (T345). These tests seed the key directly.
// MCP noteRead writes the same key; release and claim restore it (T346, external-taint.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EXTERNAL_TAINT_MS } from "../src/envelope.ts";
import { findIdentityControl } from "../src/identity-control.ts";
import { MbxNode } from "../src/node.ts";
import { readSessionTaint, taintKey, writeSessionTaint, type SessionTaint } from "../src/session-taint.ts";

const cliCommand = (home: string, ...args: string[]) => spawnSync(process.execPath, [resolve("bin/agentmbx.js"), ...args], {
  encoding: "utf8", timeout: 20_000, env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" },
});

test("session taint is live only until root + 1 h and keys do not collide (T345)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-taint-key-"));
  const node = new MbxNode(home, { host: "alpha" });
  t.after(() => { node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  const record: SessionTaint = {
    v: 1, cli: "grok", session_id: "01a10946-210f-7c41-a41e-4e3060e0a52f", root: now - 1000,
    from: "scout@alpha", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", how: "declared",
    relay_depth: [{ hop: 2, from: "other@alpha", at: now - 500 }, { hop: 1, from: "old@alpha", at: now - EXTERNAL_TAINT_MS }],
  };
  writeSessionTaint(node.store, record, now);
  const got = readSessionTaint(node.store, record.cli, record.session_id, now);
  assert.equal(got?.root, record.root);
  assert.deepEqual(got?.relay_depth, [{ hop: 2, from: "other@alpha", at: now - 500 }], "an hour-old hop is not history anymore");
  assert.equal(readSessionTaint(node.store, record.cli, record.session_id, record.root + EXTERNAL_TAINT_MS), null);
  assert.equal(readSessionTaint(node.store, "codex", record.session_id, now), null);

  writeSessionTaint(node.store, { ...record, cli: "a:b", session_id: "c" }, now);
  writeSessionTaint(node.store, { ...record, cli: "a", session_id: "b:c" }, now);
  assert.notEqual(taintKey("a:b", "c"), taintKey("a", "b:c"));
  assert.equal(readSessionTaint(node.store, "a:b", "c", now)?.cli, "a:b");
  assert.equal(readSessionTaint(node.store, "a", "b:c", now)?.session_id, "b:c");

  assert.throws(() => writeSessionTaint(node.store, { ...record, how: "agent" as SessionTaint["how"] }, now), /not a live session exposure/);
  assert.equal(readSessionTaint(node.store, record.cli, record.session_id, now)?.root, record.root, "a rejected write leaves the live record");
  writeSessionTaint(node.store, { ...record, root: now - EXTERNAL_TAINT_MS }, now);
  assert.equal(node.store.get(taintKey(record.cli, record.session_id)), undefined);
  node.store.set(taintKey("grok", "s1"), "{");
  assert.equal(readSessionTaint(node.store, "grok", "s1", now), null);
});

test("CLI send inherits a live session taint and refuses --origin agent (T345)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-cli-taint-"));
  const node = new MbxNode(home, { host: "alpha" });
  const client = new Client({ name: "claude", version: "test" });
  t.after(async () => { await client.close(); node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
    env: { ...process.env, MBX_HOME: home, MBX_AGENT: "reader", MBX_CLI: "claude", AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
  const who = await client.callTool({ name: "mbx_whoami", arguments: {} });
  assert.notEqual(who.isError, true, JSON.stringify(who.content));
  const me = who.structuredContent as { agent: string };
  assert.equal(me.agent, "reader");
  const sid = node.store.db.prepare("SELECT session_id FROM sessions WHERE agent=? AND session_key IS NOT NULL").get(me.agent)!.session_id as string;
  const descriptor = findIdentityControl(node.store, "claude", sid);
  node.registerAgent("recipient");
  const root = Date.now() - 60_000;
  const cause = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  writeSessionTaint(node.store, {
    v: 1, cli: descriptor.cli, session_id: descriptor.session_id, root, from: "scout@alpha", id: cause, how: "declared",
    relay_depth: [{ hop: 2, from: "scout@alpha", at: root }],
  });

  const send = (...extra: string[]) => cliCommand(home, "send", "--cli", "claude", "--session", sid, "--as", me.agent, "--to", "recipient", ...extra, "--json");
  const tainted = send("--subject", "inherited", "-m", "body");
  assert.equal(tainted.status, 0, tainted.stderr);
  const inherited = JSON.parse(node.message(JSON.parse(tainted.stdout).id)!.envelope);
  assert.equal(inherited.meta.origin, "external");
  assert.equal(inherited.meta.external_source, "inherited");
  assert.equal(inherited.meta.external_since, new Date(root).toISOString());
  assert.match(tainted.stderr, /sent with origin external because this session read outside content/);
  assert.match(tainted.stderr, new RegExp(cause));

  const refused = send("--subject", "refused-agent", "-m", "nope", "--origin", "agent");
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /--origin agent refused/);
  assert.equal(node.search("refused-agent").length, 0);

  const declared = send("--subject", "declared", "-m", "outside", "--origin", "external");
  assert.equal(declared.status, 0, declared.stderr);
  const declaredEnv = JSON.parse(node.message(JSON.parse(declared.stdout).id)!.envelope);
  assert.equal(declaredEnv.meta.origin, "external");
  assert.equal(declaredEnv.meta.external_source, "declared");
  assert.equal(declaredEnv.meta.external_since, declaredEnv.ts);
  assert.match(declared.stderr, /sent with origin external, as you declared/);

  writeSessionTaint(node.store, {
    v: 1, cli: "claude", session_id: "someone-else", root, from: "scout@alpha", id: cause, how: "inherited", relay_depth: [],
  });
  writeSessionTaint(node.store, {
    v: 1, cli: descriptor.cli, session_id: descriptor.session_id, root: Date.now() - EXTERNAL_TAINT_MS,
    from: "scout@alpha", id: cause, how: "declared", relay_depth: [],
  });
  assert.equal(readSessionTaint(node.store, descriptor.cli, descriptor.session_id), null);
  const clean = send("--subject", "clean-again", "-m", "body");
  assert.equal(clean.status, 0, clean.stderr);
  const cleanEnv = JSON.parse(node.message(JSON.parse(clean.stdout).id)!.envelope);
  assert.equal(cleanEnv.meta.origin, undefined);
  assert.equal(cleanEnv.meta.external_since, undefined);

  const bad = send("--subject", "bad-origin", "-m", "body", "--origin", "web");
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /--origin must be agent or external/);
  assert.equal(node.search("bad-origin").length, 0);
});
