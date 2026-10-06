// T439: a sibling MCP server of a live provider session (OpenCode code mode, a transient Codex connection) co-uses the
// session's identity under the live holder's lease: it acts as the identity without taking, renewing or releasing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { readSessionTaint } from "../src/session-taint.ts";
import { identityAvailability } from "../src/identity-availability.ts";
import type { IdentityLease, ProcessEvidence } from "../src/identity-leases.ts";

const bin = join(import.meta.dirname, "../bin/agentmbx.js");
const SESSIONS = { codex: { threadId: "44444444-4444-4444-8444-444444444444" }, opencode: { sessionID: "ses_siblingsession" } } as const;
type Cli = keyof typeof SESSIONS;

/** An isolated mailbox plus MCP servers of one provider session; every server is a child of this (provider) process. */
function fixture(t: { after: (fn: () => Promise<void>) => void }, cli: Cli) {
  const home = mkdtempSync(join(tmpdir(), "mbx-sibling-")), node = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients.reverse()) await c.close().catch(() => {});
    node.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const connect = async () => {
    const env: Record<string, string> = { ...process.env, MBX_HOME: home, MBX_CLI: cli, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1" } as Record<string, string>;
    for (const k of Object.keys(env)) if (k.startsWith("MBX_MCP_") || ["MBX_AGENT", "MBX_ROLE", "MBX_CHANNEL"].includes(k)) delete env[k];
    const c = new Client({ name: "sibling", version: "test" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env }));
    clients.push(c);
    return c;
  };
  const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
    c.callTool({ name, arguments: args, _meta: SESSIONS[cli] }, undefined, { timeout: 10_000 });
  const lease = (name: string) => node.store.db.prepare("SELECT * FROM identity_leases WHERE name=?").get(name) as unknown as IdentityLease;
  const audits = (event: string) => node.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE event=?").get(event)!.n as number;
  /** Holder registers `name`; the sibling (a second server of the same session and provider) then joins. */
  const pair = async (name: string) => {
    const holder = await connect();
    assert.notEqual((await call(holder, "mbx_identity", { action: "register", name, role: "reader" })).isError, true);
    const sibling = await connect();
    return { holder, sibling };
  };
  return { node, connect, call, lease, audits, pair };
}
type Who = { agent: string | null; co_use?: string; pending?: string | null };
const json = (r: unknown) => (r as { structuredContent?: unknown }).structuredContent as Who;
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map(c => c.text).join("\n");

for (const cli of ["opencode", "codex"] as const) {
  test(`${cli}: a sibling server of the live session acts as its identity under the holder's lease, and leaves it untouched`, async t => {
    const { node, call, lease, audits, pair } = fixture(t, cli);
    const { holder, sibling } = await pair("sib-reader");
    const held = lease("sib-reader");
    node.registerAgent("peer", { role: "peer" });
    const mail = node.send({ from: "peer", to: ["sib-reader"], subject: "question", body: "please answer" }).envelope.id;

    // (a) whoami shows the identity, flagged as co-use.
    const me = json(await call(sibling, "mbx_whoami"));
    assert.equal(me.agent, "sib-reader", JSON.stringify(me));
    assert.match(String(me.co_use), /co-using this session's identity/);
    const inbox = await call(sibling, "mbx_inbox");
    assert.notEqual(inbox.isError, true, textOf(inbox));
    assert.match(textOf(inbox), new RegExp(mail.slice(0, 8)));
    const read = await call(sibling, "mbx_read", { ids: [mail] });
    assert.notEqual(read.isError, true, textOf(read));
    assert.match(textOf(read), /please answer/);
    const reply = await call(sibling, "mbx_reply", { id: mail, body: "answered by the sibling" });
    assert.notEqual(reply.isError, true, textOf(reply));
    const send = await call(sibling, "mbx_send", { to: ["peer"], subject: "status", body: "sent by the sibling", kind: "status" });
    assert.notEqual(send.isError, true, textOf(send));
    const ack = await call(sibling, "mbx_ack", { ids: [mail] });
    assert.notEqual(ack.isError, true, textOf(ack));
    assert.equal(node.store.db.prepare("SELECT state FROM deliveries WHERE msg_id=? AND agent='sib-reader'").get(mail)!.state, "acked");
    // Both envelopes the sibling sent carry the holder-equivalent leased sender verification, from the identity's address.
    const sent = node.store.db.prepare("SELECT envelope FROM messages WHERE from_addr='sib-reader@alpha'").all().map(r => JSON.parse(r.envelope as string));
    assert.equal(sent.length, 2);
    for (const e of sent) assert.equal(e.meta.sender_verification, "leased", JSON.stringify(e.meta));
    // The sibling's own session key carries no owner grant: it gains nothing beyond the holder's lease.
    for (const e of sent) assert.equal(e.authority ?? null, null);

    // The identity list explains the co-use; the lease and audit trail show a single holder and no takeover (d).
    const list = await call(sibling, "mbx_identity", { action: "list" });
    const listed = JSON.parse(textOf(list)) as { identities: { name: string; claimable: boolean; state: string; reason: string; holder: { pid: number } }[]; you: { agent: string; co_use?: string } };
    const entry = listed.identities.find(i => i.name === "sib-reader")!;
    assert.deepEqual([entry.state, entry.claimable, entry.holder.pid], ["held", false, held.holder_pid]);
    assert.match(entry.reason, /co-uses it/);
    assert.equal(listed.you.agent, "sib-reader");
    assert.match(String(listed.you.co_use), /co-using/);
    assert.equal(node.store.db.prepare("SELECT COUNT(*) n FROM identity_leases").get()!.n, 1);
    assert.equal(audits("identity.takeover"), 0, "no takeover audit");
    assert.equal(audits("identity.claim"), 1, "only the holder ever claimed");
    assert.deepEqual(lease("sib-reader"), held, "co-use renewed, moved or replaced nothing");

    // (b) The sibling exits: the holder still holds and serves, the lease row unchanged.
    await sibling.close();
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(lease("sib-reader"), held, "the sibling released nothing on exit");
    assert.equal(lease("sib-reader").released_at, null);
    assert.equal(audits("identity.release"), 0);
    const still = await call(holder, "mbx_whoami");
    assert.equal(json(still).agent, "sib-reader");
    assert.equal(json(still).co_use, undefined, "the holder is not a co-user");
    assert.notEqual((await call(holder, "mbx_read", { ids: [mail] })).isError, true, "the holder keeps serving");
  });
}

test("a sibling stops acting as the identity once the holder's lease is released or moved", async t => {
  const { node, connect, call, lease, pair } = fixture(t, "opencode");
  const { holder, sibling } = await pair("sib-fenced");
  node.registerAgent("peer", { role: "peer" });
  const mail = node.send({ from: "peer", to: ["sib-fenced"], subject: "q", body: "b" }).envelope.id;
  assert.equal(json(await call(sibling, "mbx_whoami")).agent, "sib-fenced");

  // (c) moved: a new lease generation (as after a takeover or rename) fences the sibling's next call closed.
  const held = lease("sib-fenced");
  node.store.db.prepare("UPDATE identity_leases SET token=? WHERE name=?").run("moved-generation-token", "sib-fenced");
  const fenced = await call(sibling, "mbx_read", { ids: [mail] });
  assert.equal(fenced.isError, true, "a moved lease is not co-used");
  assert.match(textOf(fenced), /no longer holds the lease this server co-used/);
  assert.equal(lease("sib-fenced").token, "moved-generation-token", "the sibling did not touch the new generation");
  node.store.db.prepare("UPDATE identity_leases SET token=? WHERE name=?").run(held.token, "sib-fenced");

  // The sibling re-evaluates on its next call: the holder holds again, so it co-uses again.
  assert.equal(json(await call(sibling, "mbx_whoami")).agent, "sib-fenced");
  assert.deepEqual(lease("sib-fenced"), held);

  // (c) released: the holder explicitly releases; the sibling's next mailbox call does not act as the identity.
  assert.notEqual((await call(holder, "mbx_identity", { action: "release" })).isError, true);
  const released = lease("sib-fenced");
  assert.notEqual(released.released_at, null);
  const after = await call(sibling, "mbx_inbox");
  assert.equal(after.isError, true, "a released lease is not co-used");
  assert.deepEqual(lease("sib-fenced"), released, "the failing call claimed nothing");
  // T440: whoami must not undo the holder's explicit release. An explicit claim still can.
  const releasedWho = json(await call(sibling, "mbx_whoami"));
  assert.equal(releasedWho.agent, null, JSON.stringify(releasedWho));
  assert.deepEqual(lease("sib-fenced"), released, "whoami left the lease released");
  const claimed = await call(sibling, "mbx_identity", { action: "claim", name: "sib-fenced" });
  assert.notEqual(claimed.isError, true, textOf(claimed));
  assert.equal(lease("sib-fenced").released_at, null, "an explicit claim takes the released lease");
  assert.equal(json(await call(sibling, "mbx_whoami")).agent, "sib-fenced");

  // A later sibling of a different session never co-uses: co-use needs the same session as the holder.
  const other = await connect();
  const stranger = await other.callTool({ name: "mbx_whoami", arguments: {}, _meta: { sessionID: "ses_unrelatedsession" } }, undefined, { timeout: 10_000 });
  assert.equal(json(stranger).agent, null);
});

test("a co-using sibling sends with the holder's conversation taint (T346)", async (t) => {
  const { node, call, pair } = fixture(t, "opencode");
  const { holder, sibling } = await pair("sib-taint");
  node.registerAgent("peer", { role: "peer" });
  const outside = node.send({ from: "scout", to: ["sib-taint"], subject: "page", body: "copied from a web page", origin: "external" }).envelope;
  assert.notEqual((await call(holder, "mbx_read", { ids: [outside.id] })).isError, true, "holder reads the outside mail");
  const stored = readSessionTaint(node.store, "opencode", SESSIONS.opencode.sessionID);
  assert.ok(stored, "the holder persisted taint:<cli>:<session_id>");
  assert.equal(stored.id, outside.id);
  assert.equal(stored.from, "scout@alpha");
  assert.ok(stored.relay_depth.some((h) => h.from === "scout@alpha" && h.hop === 0));

  const who = await call(sibling, "mbx_whoami");
  assert.equal(json(who).agent, "sib-taint");
  const ext = (who.structuredContent as { external?: { tainted?: boolean; root_exposure?: string } } | undefined)?.external;
  assert.equal(ext?.tainted, true, "the sibling restored the shared conversation key");
  assert.equal(ext?.root_exposure, new Date(stored.root).toISOString());

  const send = await call(sibling, "mbx_send", { to: ["peer"], subject: "onward", body: "still outside" });
  assert.notEqual(send.isError, true, textOf(send));
  const id = (send.structuredContent as { id?: string } | undefined)?.id;
  assert.equal(typeof id, "string");
  const envelope = JSON.parse(node.message(id!)!.envelope) as { meta: { origin?: string; external_source?: string; external_since?: string; hop?: number } };
  assert.equal(envelope.meta.origin, "external");
  assert.equal(envelope.meta.external_source, "inherited");
  assert.equal(envelope.meta.external_since, new Date(stored.root).toISOString());
  assert.equal(envelope.meta.hop, 1, "the sibling kept the holder's hop history");
});

test("co-use requires the same session and the holder's own provider process", () => {
  const now = 1_000_000;
  const lease = { name: "x", token: "t", holder_pid: 50, holder_start: "s", key_fp: "k", cli: "opencode", session_id: "ses_a",
    claimed_at: now, heartbeat_at: now, idle_ttl: 60_000, released_at: null, release_reason: null } as IdentityLease;
  const live: ProcessEvidence = { alive: true, start: "s" };
  const at = (caller: { cli: string; sessionId: string; providerPid?: number; holderProviderPid?: number | null; holderProviderAlive?: boolean | null }, evidence: ProcessEvidence = live) =>
    identityAvailability({ lease, evidence, activity: null, now, caller });
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 10 }).coUse, true, "same session, same provider");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 20 }).coUse, undefined, "a different provider is not co-use");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 20, holderProviderAlive: false }).takeover, "same-session", "dead provider is takeover");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 20, holderProviderAlive: true }).takeover, undefined, "a live provider is not takeover");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 20, holderProviderAlive: true }).claimable, false);
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: null }).coUse, undefined, "unknown parentage");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a" }).coUse, undefined, "no provider evidence");
  assert.equal(at({ cli: "opencode", sessionId: "ses_b", providerPid: 10, holderProviderPid: 10 }).coUse, undefined, "another session");
  assert.equal(at({ cli: "codex", sessionId: "ses_a", providerPid: 10, holderProviderPid: 10 }).coUse, undefined, "another provider CLI");
  assert.equal(at({ cli: "opencode", sessionId: "ses_a", providerPid: 10, holderProviderPid: 10 }, { alive: false, start: null }).coUse, undefined, "dead holder: claimable");
});
