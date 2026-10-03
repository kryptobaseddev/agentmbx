// External taint carries its ROOT exposure time (T344). Reading outside content makes a session's own sends external
// for an hour; before T344 every read of external mail restarted that hour, so two agents answering each other after
// either was exposed re-tainted each other forever and no one was told why. Now a message sent while tainted carries the
// root time (meta.external_since), a reader inherits that root (never the read time), and sender, reader and whoami
// each say why and until when.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildEnvelope, checkShape, EXTERNAL_TAINT_MS, externalExposure, signEnvelope, type Envelope } from "../src/envelope.ts";
import { externalLine, MbxNode } from "../src/node.ts";
import { humanPromptKey } from "../src/wake.ts";

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Env = Envelope & { meta: Envelope["meta"] & { external_since?: string; external_source?: string } };

/** MCP sessions on one host sharing a test clock: the preload replaces Date.now in each server (the module's clock seam). */
async function world(t: { after: (fn: () => Promise<void>) => void }, names: string[]) {
  const home = mkdtempSync(join(tmpdir(), "mbx-taint-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clock = join(home, "clock"), preload = join(home, "clock.mjs");
  let now = Date.now(); writeFileSync(clock, String(now));
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  const clients: Record<string, Client> = {};
  for (const name of names) {
    const c = new Client({ name: `taint-${name}`, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", preload, join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"],
      // keep the identity lease valid while the clock moves well past an hour
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_IDENTITY_IDLE_TTL_MS: "21600000", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    clients[name] = c;
  }
  t.after(async () => { for (const c of Object.values(clients)) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = async (who: string, name: string, args: Record<string, unknown>) => {
    const r = await clients[who].callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    return { out: (r.structuredContent ?? {}) as Record<string, unknown>, text: (r.content as { text: string }[]).map((c) => c.text).join("\n") };
  };
  const env = (id: string) => JSON.parse(n.message(id)!.envelope) as Env;
  const sent = async (p: Promise<{ out: Record<string, unknown> }>) => {
    const { out } = await p;
    return { e: env(out.id as string), warnings: (out.warnings ?? []) as string[] };
  };
  return {
    n, call, env,
    get now() { return now; },
    advance(ms: number) { now += ms; writeFileSync(clock, String(now)); },
    send: (who: string, to: string[], extra: Record<string, unknown> = {}) => sent(call(who, "mbx_send", { to, subject: "work", body: "data", ...extra })),
    reply: (who: string, id: string, extra: Record<string, unknown> = {}) => sent(call(who, "mbx_reply", { id, body: "answer", ...extra })),
    read: async (who: string, id: string) => (await call(who, "mbx_read", { ids: [id] })).text,
    whoami: async (who: string) => (await call(who, "mbx_whoami", {})).out.external as Record<string, unknown>,
    /** A stored message as it arrived, without the current sender code (old or malformed envelopes). */
    insert(e: Envelope, to: string) { const s = signEnvelope(e, "alpha", n.key.publicKey, n.key.privateKey); n.store.insertMessage(s, "local", "local", null); n.store.addDelivery(s.id, to); return s; },
  };
}

test("a conversation between two agents after an exposure clears at root + 1 h, however often they answer (T344)", async (t) => {
  const w = await world(t, ["ada", "bob"]);
  const outside = w.n.send({ from: "scout", to: ["ada"], subject: "issue text", body: "copied from a web page", origin: "external" }).envelope as Env;
  assert.equal(outside.meta.external_source, "declared", "a sender that marks content external declares it first-hand");
  assert.equal(outside.meta.external_since, outside.ts);
  const root = w.now, clears = iso(root + EXTERNAL_TAINT_MS);
  assert.match(await w.read("ada", outside.id), new RegExp(`origin: external, declared by the sender at ${esc(outside.ts)} .*your own sends external until ${esc(clears)}`));

  let m = await w.send("ada", ["bob"]);
  assert.equal(m.e.meta.origin, "external");
  assert.equal(m.e.meta.external_source, "inherited");
  assert.equal(m.e.meta.external_since, iso(root), "the message carries the root exposure, not its send time");
  assert.equal(checkShape(m.e), null);
  assert.ok(m.warnings.some((x) => x.startsWith("sent with origin external because this session read outside content")
    && x.includes(`until ${clears}`) && x.includes(`root exposure at ${iso(root)}: you read ${outside.id} from scout@alpha, which its sender declared external`)),
  `the sender is told why and until when: ${JSON.stringify(m.warnings)}`);

  // Every 10 minutes the other one reads and answers. Before T344 each read restarted the hour.
  for (let i = 1; i <= 5; i++) {
    w.advance(10 * MIN);
    const who = i % 2 ? "bob" : "ada";
    const header = await w.read(who, m.e.id);
    assert.match(header, new RegExp(`origin: external, inherited: the sender did not declare it, its session read outside content at ${esc(iso(root))} \\(root exposure\\), so the sender's taint clears at ${esc(clears)}; reading it makes your own sends external until ${esc(clears)}, never longer`));
    m = await w.reply(who, m.e.id);
    assert.equal(m.e.meta.origin, "external", `exchange ${i} is still inside the hour`);
    assert.equal(m.e.meta.external_since, iso(root), `exchange ${i} keeps the root`);
    assert.ok(m.warnings.some((x) => x.includes(`until ${clears}`)), `exchange ${i} warns`);
  }
  for (const who of ["ada", "bob"]) {
    const ext = await w.whoami(who);
    assert.equal(ext.tainted, true);
    assert.equal(ext.root_exposure, iso(root));
    assert.equal(ext.clears_at, clears);
  }

  w.advance(10 * MIN); // root + 1 h
  assert.match(await w.read("ada", m.e.id), /origin: external, inherited: .*the sender's taint cleared at .*reading it no longer makes your sends external/);
  const back = await w.reply("ada", m.e.id);
  assert.equal(back.e.meta.origin ?? "agent", "agent", "the hour since the root exposure is over: the conversation is clean");
  assert.equal(back.e.meta.external_since, undefined);
  assert.equal(back.warnings.filter((x) => /origin external/.test(x)).length, 0);
  await w.read("bob", back.e.id);
  assert.equal((await w.send("bob", ["ada"])).e.meta.origin ?? "agent", "agent");
  assert.deepEqual(await w.whoami("ada"), { tainted: false });

  // External mail from before T344 has no root time: it counts from its send time, not from when it is read.
  const old = buildEnvelope({ from: "elder@alpha", to: ["ada"], subject: "old relay", body: "data", origin: "external" }, new Date(w.now - 50 * MIN)) as Env;
  delete old.meta.external_since; delete old.meta.external_source;
  const legacy = w.insert(old, "ada");
  assert.match(await w.read("ada", legacy.id), new RegExp(`origin: external, from an older AgentMBX without a root exposure time: counted from its send time ${esc(legacy.ts)}`));
  const after = await w.send("ada", ["bob"]);
  assert.equal(after.e.meta.origin, "external");
  assert.equal(after.e.meta.external_since, legacy.ts);
  w.advance(10 * MIN);
  assert.equal((await w.send("ada", ["bob"])).e.meta.origin ?? "agent", "agent", "send time + 1 h has passed");
});

test("fresh outside content still taints; an owner prompt and origin agent never clear it; malformed mail counts as outside (T344, T104)", async (t) => {
  const w = await world(t, ["ada", "bob"]);
  const outside = w.n.send({ from: "scout", to: ["ada"], subject: "pr comment", body: "text from a PR", origin: "external" }).envelope;
  w.advance(5 * MIN);
  const root = w.now;
  await w.read("ada", outside.id);
  const first = await w.send("ada", ["bob"]);
  assert.equal(first.e.meta.external_since, iso(root), "first-hand content: the root is when the reader read it");

  // A prompt the owner typed resets relay depth only (T104), never external origin.
  w.advance(MIN);
  w.n.store.set(humanPromptKey("ada"), iso(w.now));
  w.advance(1000);
  const prompted = await w.send("ada", ["bob"]);
  assert.equal(prompted.e.meta.origin, "external");
  assert.equal(prompted.e.meta.external_since, iso(root));

  const overridden = await w.send("ada", ["bob"], { origin: "agent" });
  assert.equal(overridden.e.meta.origin, "external");
  assert.ok(overridden.warnings.some((x) => x.startsWith("origin \"agent\" overridden: sent with origin external because this session read outside content")), JSON.stringify(overridden.warnings));

  const declared = await w.send("bob", ["ada"], { origin: "external" });
  assert.equal(declared.e.meta.external_source, "declared");
  assert.ok(declared.warnings.some((x) => x.startsWith("sent with origin external, as you declared")), JSON.stringify(declared.warnings));

  // Re-reading first-hand content is a new exposure: the reader's root moves to the read time.
  w.advance(20 * MIN);
  await w.read("ada", outside.id);
  assert.equal((await w.send("ada", ["bob"])).e.meta.external_since, iso(w.now));

  // Malformed mail cannot erase unknown provenance: it is first-hand outside content.
  const bad = buildEnvelope({ from: "mallory@alpha", to: ["bob"], subject: "odd", body: "data" });
  const malformed = w.insert({ ...bad, meta: { ...bad.meta, origin: "external", external_since: "yesterday" } } as Envelope, "bob");
  assert.equal(checkShape(malformed), "bad external_since");
  w.advance(MIN);
  const readAt = w.now;
  assert.match(await w.read("bob", malformed.id), /origin: treated as external \(malformed envelope/);
  const relayed = await w.send("bob", ["ada"]);
  assert.equal(relayed.e.meta.origin, "external");
  assert.equal(relayed.e.meta.external_since, iso(readAt));
  assert.ok(relayed.warnings.some((x) => x.includes(`you read ${malformed.id} from mallory@alpha, a malformed message`)), JSON.stringify(relayed.warnings));
  const ext = await w.whoami("bob");
  assert.equal(ext.tainted, true);
  assert.equal(ext.clears_at, iso(readAt + EXTERNAL_TAINT_MS));
  assert.match(String(ext.cause), /malformed/);
});

test("external_since is validated on every path and interpreted safely (T344)", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const draft = (extra = {}) => buildEnvelope({ from: "a@alpha", to: ["b@beta"], subject: "s", body: "b", origin: "external", ...extra }, new Date(now - 10 * MIN));
  const declared = draft(), inherited = draft({ external_since: iso(now - 40 * MIN) });
  assert.equal(declared.meta.external_source, "declared"); assert.equal(declared.meta.external_since, iso(now - 10 * MIN));
  assert.equal(inherited.meta.external_source, "inherited");
  assert.deepEqual(externalExposure(declared, now), { how: "declared", root: now }, "first-hand: exposure at read");
  assert.deepEqual(externalExposure(inherited, now), { how: "inherited", root: now - 40 * MIN }, "inherited: the root, never now");
  const future = { ...inherited, meta: { ...inherited.meta, external_since: iso(now + 5 * 3_600_000) } };
  assert.equal(checkShape(future), null);
  assert.deepEqual(externalExposure(future, now), { how: "inherited", root: now }, "a future root counts as now, never later");
  const legacy = { ...declared, meta: { ...declared.meta, external_since: undefined, external_source: undefined } };
  assert.equal(checkShape(legacy), null);
  assert.deepEqual(externalExposure(legacy, now), { how: "legacy", root: now - 10 * MIN }, "no root time: the send time");
  assert.deepEqual(externalExposure({ ...legacy, ts: iso(now + MIN) }, now), { how: "legacy", root: now });
  const noSource = { ...inherited, meta: { ...inherited.meta, external_source: undefined } };
  assert.deepEqual(externalExposure(noSource, now), { how: "declared", root: now }, "an unlabelled root is treated as first-hand");
  assert.equal(externalExposure(buildEnvelope({ from: "a@alpha", to: ["b@beta"], subject: "s", body: "b" }), now), null);
  assert.equal(buildEnvelope({ from: "a@alpha", to: ["b@beta"], subject: "s", body: "b", external_since: iso(now) }).meta.external_since, undefined, "agent mail carries no root");

  for (const [meta, error] of [
    [{ external_since: "yesterday" }, "bad external_since"], [{ external_since: 1 }, "bad external_since"], [{ external_since: "" }, "bad external_since"],
    [{ external_since: "2026-10-03T12:00:00+02:00" }, "bad external_since"], [{ external_since: "2026-13-40T12:00:00Z" }, "bad external_since"],
    [{ external_since: `${iso(now)}${"0".repeat(300)}` }, "bad external_since"], [{ origin: "agent" }, "bad external_since"],
    [{ external_source: "relayed" }, "bad external_source"], [{ external_since: undefined }, "bad external_source"],
  ] as const) {
    const e = { ...inherited, meta: { ...inherited.meta, ...meta } };
    assert.equal(checkShape(e), error, JSON.stringify(meta));
    assert.deepEqual(externalExposure(e, now), { how: "malformed", root: now });
    assert.match(externalLine(e, now)!, /^origin: treated as external \(malformed envelope/);
  }
  assert.equal(externalLine(buildEnvelope({ from: "a@alpha", to: ["b@beta"], subject: "s", body: "b" }), now), null);
});

test("paired hosts carry external_since signed and reject a malformed one (T344, LAN and relay path)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-taint-lan-"));
  const a = new MbxNode(join(home, "a"), { host: "alpha" }), b = new MbxNode(join(home, "b"), { host: "beta" });
  t.after(() => { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  b.upsertPendingPeer({ host: "alpha", pubkey: a.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:0", code: "000000", nonce_local: "n", nonce_remote: "n" });
  b.approvePeer("alpha"); b.registerAgent("worker");
  const root = iso(Date.now() - 20 * MIN);
  const sign = (e: Envelope) => signEnvelope(e, "alpha", a.key.publicKey, a.key.privateKey);
  const good = sign(buildEnvelope({ from: "sender@alpha", to: ["worker@beta"], subject: "relay", body: "data", origin: "external", external_since: root }));
  assert.equal(b.receive(good, "alpha"), "accepted");
  const stored = JSON.parse(b.message(good.id)!.envelope) as Env;
  assert.equal(stored.meta.external_since, root);
  assert.equal(stored.meta.external_source, "inherited");
  assert.match(externalLine(stored)!, new RegExp(`inherited: .*read outside content at ${esc(root)}`));
  // The root is signed: changing it in transit breaks the host signature.
  const tampered = { ...good, id: buildEnvelope({ from: "x@alpha", to: ["y"], subject: "s", body: "b" }).id, meta: { ...good.meta, external_since: iso(Date.now() - 3 * 3_600_000) } };
  assert.equal(b.receive(tampered, "alpha"), "rejected:bad signature");
  const bad = buildEnvelope({ from: "sender@alpha", to: ["worker@beta"], subject: "relay", body: "data", origin: "external" });
  assert.equal(b.receive(sign({ ...bad, meta: { ...bad.meta, external_since: "soon" } }), "alpha"), "rejected:bad external_since");
  assert.equal(b.receive(sign({ ...bad, meta: { ...bad.meta, external_source: "forwarded" } } as unknown as Envelope), "alpha"), "rejected:bad external_source");
});
