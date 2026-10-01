// Relay depth counts relays, not conversation turns (T104): two agents answering each other stay at depth 0 however
// long they talk, while passing content on to a third agent still adds a hop, so chains are limited exactly as before.
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
import { sendLeased } from "./helpers/leased-send.ts";

type Env = { meta: { hop?: number; origin?: string }; id: string };

async function world(t: { after: (fn: () => Promise<void>) => void }, names: string[], policy?: "collaborate") {
  const home = mkdtempSync(join(tmpdir(), "mbx-depth-"));
  const owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  if (policy) {
    const rec = makePolicy({ level: policy, agents: ["*"], hosts: ["alpha"], from: ["local"], ownerPub: owner.publicKey });
    assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  }
  const clients: Record<string, Client> = {};
  for (const name of names) {
    const c = new Client({ name: `depth-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    clients[name] = c;
  }
  t.after(async () => { for (const c of Object.values(clients)) await c.close(); n.close(); rmSync(home, { recursive: true, force: true }); });
  const call = async (who: string, name: string, args: Record<string, unknown>) => {
    const r = await clients[who].callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    return r.structuredContent as Record<string, unknown>;
  };
  const env = (id: string) => JSON.parse(n.message(id)!.envelope) as Env;
  const send = async (who: string, to: string[], extra: Record<string, unknown> = {}) =>
    env((await call(who, "mbx_send", { to, subject: "work", body: "data", kind: "request", ...extra })).id as string);
  const reply = async (who: string, id: string) => env((await call(who, "mbx_reply", { id, body: "answer", kind: "request" })).id as string);
  const read = (who: string, id: string) => call(who, "mbx_read", { ids: [id] });
  return { n, call, send, reply, read, env };
}

test("two agents answering each other stay at depth 0 for 10 exchanges, and the mail stays actionable", async (t) => {
  const w = await world(t, ["ada", "bob"], "collaborate");
  let m = await w.send("ada", ["bob"]);
  for (let i = 0; i < 10; i++) {
    const who = i % 2 === 0 ? "bob" : "ada";
    await w.read(who, m.id);
    m = await w.reply(who, m.id);
    assert.equal(m.meta.hop ?? 0, 0, `exchange ${i + 1} must not grow the depth`);
    const to = who === "ada" ? "bob" : "ada";
    assert.equal(w.n.policyFor(w.n.message(m.id)!, to).level, "collaborate", "so it still wakes and may be acted on");
  }
});

test("content read from a third agent still raises the depth of a reply to the original sender", async (t) => {
  const w = await world(t, ["ada", "bob"]);
  const fromB = await w.send("bob", ["ada"]);
  const third = w.n.send({ from: "cyd", to: ["ada"], subject: "deep", body: "data", hop: 5 }).envelope;
  await w.read("ada", fromB.id); await w.read("ada", third.id);
  const back = await w.reply("ada", fromB.id);
  assert.equal(back.meta.hop, 6, "c's hop 5 is relayed to b: depth 6");
  // a role or broadcast send counts every read, recipients included
  const role = await w.send("ada", ["role:reviewer"]);
  assert.equal(role.meta.hop, 6);
});

test("a chain still adds one hop per relay, also when it loops back to its start", async (t) => {
  const w = await world(t, ["ada", "bob", "cyd"]);
  const ab = await w.send("ada", ["bob"]); assert.equal(ab.meta.hop ?? 0, 0);
  await w.read("bob", ab.id);
  const bc = await w.send("bob", ["cyd"]); assert.equal(bc.meta.hop, 1, "b relays a's content to c");
  await w.read("cyd", bc.id);
  const ca = await w.send("cyd", ["ada"]); assert.equal(ca.meta.hop, 2, "c read from b, not a: the loop back to a is still a relay");
});

test("whoami says when relay depth kept mail from waking this session", async (t) => {
  const w = await world(t, ["ada"], "collaborate");
  sendLeased(w.n, { from: "far", to: ["ada"], subject: "deep", body: "data", hop: 21, kind: "request", needs_reply: true });
  const me = await w.call("ada", "mbx_whoami", {});
  assert.match(String(me.wakes_suppressed), /1 unread message\(s\) from far@alpha did not wake this session: relay depth 21/);
  sendLeased(w.n, { from: "near", to: ["ada"], subject: "fine", body: "data", hop: 3, kind: "request" });
  assert.match(String((await w.call("ada", "mbx_whoami", {})).wakes_suppressed), /^1 unread/, "within the allowance: not listed");
});
