// T159: handoff context (docs/spec/handoff-context.md, HC-01..HC-07). Context is computed fresh from the mailbox; the one saved
// note is bounded, replace-only, references only (never a status) and survives a crash, a provider switch and release.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MbxNode } from "../src/node.ts";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { applyForward, buildForward, retireMailbox } from "../src/identity-cleanup.ts";
import { handoffKey, readHandoff, saveHandoff, validateHandoff, HANDOFF_NOTE_MAX, HANDOFF_REFS_MAX, HANDOFF_RETENTION_MS } from "../src/handoff.ts";
import { resumeNotice, RESUME_NOTICE_MAX_CHARS } from "../src/resume-notice.ts";
import { catchupHint } from "../src/catchup.ts";
import { sendLeased } from "./helpers/leased-send.ts";

type Out = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };

async function world(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-handoff-"));
  const n = new MbxNode(home, { host: "alpha" });
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const connect = async (agent: string, cli = "claude") => {
    const c = new Client({ name: `handoff-${agent}-${cli}`, version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("bin/agentmbx.js"), "mcp"],
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: cli, MBX_AGENT: agent, MBX_NO_DESKTOP: "1", MBX_CHANNEL: "0" } as Record<string, string> });
    await c.connect(transport); clients.push(c);
    const call = async (name: string, args: Record<string, unknown> = {}) => await c.callTool({ name, arguments: args }) as Out;
    await call("mbx_whoami");
    return { c, call, pid: transport.pid! };
  };
  const send = (to: string, body: string, extra: Record<string, unknown> = {}) =>
    sendLeased(n, { from: "boss", to: [to], subject: "PRIVATE SUBJECT", body, kind: "request", ...extra }).envelope.id;
  return { n, home, connect, send };
}
const json = (o: Out) => JSON.parse(o.content[0].text) as Record<string, any>;
const errorText = (o: Out) => (assert.equal(o.isError, true, JSON.stringify(o.content)), o.content.map((x) => x.text).join(" "));

test("HC-01/HC-02: a saved note and the fresh context survive a crash and a provider switch; another identity reads none", async t => {
  const { n, connect, send } = await world(t);
  const a = await connect("worker");
  const first = send("worker", "please pick up T159 and SECRET BODY", { needs_reply: true });
  send("worker", "a second note on the same work");
  const saved = await a.call("mbx_handoff", { action: "save", note: "halfway: spec read, tests next", task_refs: ["T159"], msg_refs: [first] });
  assert.notEqual(saved.isError, true, JSON.stringify(saved.content));
  const before = json(await a.call("mbx_handoff"));
  assert.equal(before.note.note, "halfway: spec read, tests next");
  assert.deepEqual(before.note.task_refs, [{ id: "T159", verify: "cleo show T159" }], "a reference plus how to verify it, never a status");
  assert.ok(before.context.threads.length >= 1);
  assert.equal(before.context.threads.some((x: { needs_reply: boolean }) => x.needs_reply), true);
  process.kill(a.pid, "SIGKILL"); // crash: no release, no cleanup
  await new Promise((r) => setTimeout(r, 300));
  const b = await connect("worker", "hermes"); // the same persona on another provider
  const who = json(await b.call("mbx_whoami"));
  assert.equal(who.agent, "worker");
  assert.equal(who.handoff_note.task_refs, 1, "whoami points at the note"); assert.equal(who.handoff_note.read, "mbx_handoff");
  assert.equal(JSON.stringify(who).includes("halfway"), false, "the pointer never carries the text");
  const after = json(await b.call("mbx_handoff"));
  assert.deepEqual(after.note, before.note, "the saved note is recovered");
  assert.deepEqual(after.context.threads, before.context.threads, "the context is computed again, the same, with nothing stored");
  assert.doesNotMatch(JSON.stringify(after), /SECRET BODY|"envelope"|"sig"|token/, "no bodies, envelopes or credentials");
  const other = await connect("bystander");
  assert.deepEqual(json(await other.call("mbx_handoff")).note, { note: null, reason: "none" }, "a different identity reads none");
  void n;
});

test("HC-03: the note is bounded: over-long refused, controls stripped, at most 20 refs each with the oldest dropped", async t => {
  const { connect, send } = await world(t);
  const a = await connect("worker");
  const ids = Array.from({ length: 25 }, (_, i) => `T${101 + i}`);
  send("worker", `tasks ${ids.join(" ")}`);
  assert.match(errorText(await a.call("mbx_handoff", { action: "save", note: "x".repeat(HANDOFF_NOTE_MAX + 1) })), /1001 characters; the limit is 1000/);
  const ok = json(await a.call("mbx_handoff", { action: "save", note: "a\u0007b\nc\u001b[31m", task_refs: ids }));
  assert.equal(ok.saved.note, "ab\nc[31m", "control characters other than tab and newline are removed");
  assert.deepEqual(ok.saved.task_refs.map((r: { id: string }) => r.id), ids.slice(5), `the last ${HANDOFF_REFS_MAX} are kept`);
  assert.deepEqual(ok.dropped.task_refs, ids.slice(0, 5), "and the dropped ones are reported, never cut mid-string");
  assert.equal(json(await a.call("mbx_handoff", { action: "save", note: "x".repeat(HANDOFF_NOTE_MAX) })).saved.note.length, HANDOFF_NOTE_MAX);
});

test("HC-04: refs must be linked by a message this identity can see; nothing carries a status", async t => {
  const { n, connect, send } = await world(t);
  const a = await connect("worker");
  send("worker", "see T159");
  const elsewhere = send("someone-else", "T777 for someone else");
  assert.match(errorText(await a.call("mbx_handoff", { action: "save", task_refs: ["T999"] })), /HANDOFF_REF_UNLINKED|appears in no message/);
  assert.match(errorText(await a.call("mbx_handoff", { action: "save", task_refs: ["T777"] })), /appears in no message/, "another mailbox's mention is not evidence");
  assert.match(errorText(await a.call("mbx_handoff", { action: "save", task_refs: ["159"] })), /not a CLEO task id/);
  assert.match(errorText(await a.call("mbx_handoff", { action: "save", msg_refs: [elsewhere] })), /no message .* in this identity's mailbox/);
  const sent = await a.call("mbx_send", { to: ["boss"], subject: "s", body: "my own note on T321" });
  const mine = (sent.structuredContent as { id: string }).id;
  const saved = json(await a.call("mbx_handoff", { action: "save", task_refs: ["T159", "T321"], msg_refs: [mine] }));
  assert.deepEqual(saved.saved.task_refs.map((r: { id: string }) => r.id), ["T159", "T321"], "received or sent, acked or not");
  assert.doesNotMatch(JSON.stringify(saved), /"status"|"done"|"state"/, "references only");
  const tool = (await a.c.listTools()).tools.find((x) => x.name === "mbx_handoff")!;
  assert.match(tool.description!, /never authority and never a status: task status comes only from authorized CLEO evidence at resume time \(cleo show <id>\), not from the note and not from ack state/);
});

test("HC-05: release (with a note), retire and owner forward keep the note; rename moves it; after 30 days it reads expired", async t => {
  const { n, home, connect, send } = await world(t);
  const a = await connect("worker");
  send("worker", "T159 work");
  const rel = (await a.call("mbx_identity", { action: "release", note: "stopping here", task_refs: ["T159"] })).structuredContent as Record<string, any>;
  assert.equal(rel.released, true); assert.ok(rel.handoff_note.saved_at, "the note is saved in the release itself");
  assert.equal(readHandoff(n.store, "worker").note?.note, "stopping here");
  const unbound = (await a.call("mbx_identity", { action: "release", note: "not mine", task_refs: ["T999"] })).structuredContent as Record<string, any>;
  assert.equal(unbound.handoff_note, null, "a session that no longer holds the identity saves nothing");
  assert.equal(readHandoff(n.store, "worker").note?.note, "stopping here");
  const raw = n.store.get(handoffKey("worker"));
  retireMailbox(n, "worker", "test");
  assert.equal(n.store.get(handoffKey("worker")), raw, "retire leaves it");
  createOwnerKey(home, "test-only-passphrase");
  const owner = unlockOwnerKey(home, "test-only-passphrase");
  const fwd = new MbxNode(home, { host: "alpha" }); t.after(() => fwd.close());
  fwd.registerAgent("worker-next");
  const payload = buildForward(fwd, "worker", "worker-next");
  applyForward(fwd, { payload, sig: signData(owner.privateKey, canonical(payload)) });
  assert.equal(n.store.get(handoffKey("worker")), raw, "an owner forward leaves it");
  const b = await connect("renamer");
  await b.call("mbx_handoff", { action: "save", note: "before rename" });
  assert.notEqual((await b.call("mbx_whoami", { name: "renamer-two", role: "builder" })).isError, true);
  assert.equal(n.store.get(handoffKey("renamer")), undefined);
  assert.equal(readHandoff(n.store, "renamer-two").note?.note, "before rename", "rename moves it with the registration");
  const old = JSON.parse(n.store.get(handoffKey("renamer-two"))!); old.saved_at = Date.now() - HANDOFF_RETENTION_MS - 60_000;
  n.store.set(handoffKey("renamer-two"), JSON.stringify(old));
  assert.deepEqual(json(await b.call("mbx_handoff")).note, { note: null, reason: "expired" });
});

test("HC-06: a corrupt note reads malformed, never in part; a failed write keeps the prior note", async t => {
  const { n, connect, send } = await world(t);
  const a = await connect("worker");
  send("worker", "T159");
  await a.call("mbx_handoff", { action: "save", note: "good", task_refs: ["T159"] });
  const raw = n.store.get(handoffKey("worker"))!;
  assert.throws(() => n.store.tx(() => {
    saveHandoff(n.store, "worker", validateHandoff(n, "worker", { note: "replacement" }), "test");
    throw new Error("injected write failure");
  }), /injected/);
  assert.equal(n.store.get(handoffKey("worker")), raw, "the transaction rolled back to the prior note");
  for (const bad of ["{", JSON.stringify({ v: 2, note: "x" }), JSON.stringify({ ...JSON.parse(raw), task_refs: ["DROP TABLE"] }),
    JSON.stringify({ ...JSON.parse(raw), note: "y".repeat(HANDOFF_NOTE_MAX + 1) })]) {
    n.store.set(handoffKey("worker"), bad);
    assert.deepEqual(json(await a.call("mbx_handoff")).note, { note: null, reason: "malformed" }, bad.slice(0, 40));
  }
});

test("HC-07: hooks and ack batches never write a note; the resume notice shows only the saved task ids, cut first", async t => {
  const { n, home, connect, send } = await world(t);
  const a = await connect("worker");
  const id = send("worker", "T159 and T185");
  for (const event of ["session-start", "prompt", "post-tool", "stop", "session-end"]) {
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", event, "--cli", "claude"], { encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ session_id: "hc07", cwd: process.cwd(), prompt: "hi", reason: "other" }), env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home } });
    assert.equal(r.status, 0, `${event}: ${r.stderr}`);
  }
  assert.equal(n.store.get(handoffKey("worker")), undefined, "no hook wrote one (session-end released the holder without a note)");
  assert.notEqual((await a.call("mbx_identity", { action: "claim", name: "worker" })).isError, true);
  await a.call("mbx_read", { ids: [id] }); await a.call("mbx_ack", { ids: [id], did: "done" });
  assert.equal(n.store.get(handoffKey("worker")), undefined, "only an explicit save or release writes one");
  assert.doesNotMatch(resumeNotice(n.store, "worker", "[mbx] id"), /Saved handoff/);
  const saved = await a.call("mbx_handoff", { action: "save", note: "PRIVATE NOTE TEXT", task_refs: ["T159", "T185"] });
  assert.notEqual(saved.isError, true, JSON.stringify(saved.content));
  const notice = resumeNotice(n.store, "worker", "[mbx] id");
  assert.match(notice, /\[mbx\] Saved handoff: task refs T159, T185 \(verify each with cleo show\); call mbx_handoff\./);
  assert.doesNotMatch(notice, /PRIVATE NOTE TEXT/, "ids only, never the note text");
  const hint = catchupHint(n.store, "worker")!;
  assert.ok(hint);
  const tight = resumeNotice(n.store, "worker", "x".repeat(RESUME_NOTICE_MAX_CHARS - hint.length - 21));
  assert.ok(tight.endsWith(hint), "the identity and catch-up hint still fit");
  assert.doesNotMatch(tight, /Saved handoff/, "the handoff line is the first one cut");
});
