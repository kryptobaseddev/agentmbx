// T673 (stop-window follow-up to T647/T670): the stop hook continued the turn for mail the agent had already read. Its "fresh"
// filter never checked the delivery state, so a request read (and answered) during the turn blocked the first stop of that
// session, and a new session id (restart, reopen) blocked again within its 10 minute fallback window. Stop now continues only
// for wake-worthy mail not read yet; read-but-unacked mail surfaces through T670's "read, not acked" prompt line instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, makePolicy } from "../src/policy.ts";
import { MbxNode } from "../src/node.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";
import { sendLeased } from "./helpers/leased-send.ts";

const SIDS: Record<string, string[]> = {
  claude: ["sess-1", "sess-2", "sess-3"],
  codex: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
  opencode: ["ses_one", "ses_two", "ses_three"],
  kimi: ["kimi-1", "kimi-2", "kimi-3"],
};
const CONTINUES = /Before stopping|arrived while you worked/;

for (const cli of Object.keys(SIDS)) test(`T673 ${cli}: stop does not continue for mail already read, in the same session or a new one; unread mail still does`, { timeout: 120_000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t673-"));
  createOwnerKey(home, "test-only-passphrase");
  const n = new MbxNode(home, { host: "alpha" }), owner = unlockOwnerKey(home, "test-only-passphrase");
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const [s1, s2, s3] = SIDS[cli]!;
  bindWakeLease(n, { agent: "worker", cli, session_id: s1, pid: process.pid });
  const rec = makePolicy({ level: "autonomous", agents: ["worker"], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  const stop = (sid: string): string => {
    const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "unrelated" };
    delete env.MBX_STOP_DIGEST;
    const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "stop", "--cli", cli], {
      input: JSON.stringify({ session_id: sid, cwd: process.cwd() }), encoding: "utf8", timeout: 30_000, env });
    return r.stdout + r.stderr; // kimi continues with exit 2 on stderr; the others print a block decision
  };
  const send = (subject: string) => sendLeased(n, { from: "boss", to: ["worker"], subject, body: "b", kind: "request", needs_reply: true }).envelope;

  // read (and answered) during the turn, not acked: the turn may end
  const handled = send("handled in the turn");
  n.setDelivery(handled.id, "worker", "read");
  assert.doesNotMatch(stop(s1), CONTINUES, "same session: mail read in the turn does not continue it");

  // restart or reopen: a new session id within the 10 minute fallback window
  bindWakeLease(n, { agent: "worker", cli, session_id: s2, pid: process.pid });
  assert.doesNotMatch(stop(s2), CONTINUES, "new session: mail already read does not continue it");

  // mail not read yet still continues, in the session that sees it and in a new one
  send("not read yet");
  assert.match(stop(s2), CONTINUES, "unread mail continues the turn");
  bindWakeLease(n, { agent: "worker", cli, session_id: s3, pid: process.pid });
  assert.match(stop(s3), CONTINUES, "a new session has not seen unread mail: it continues");
});

const DIGEST_CLIS: Record<string, string> = {
  claude: "sess-digest",
  codex: "44444444-4444-4444-8444-444444444444",
  opencode: "ses_digest",
  kimi: "kimi-digest",
  grok: "grok-digest-sid",
};

for (const [cli, sid] of Object.entries(DIGEST_CLIS)) test(`T584 ${cli}: MBX_STOP_DIGEST narrows Stop to request, task, decision, and alert`, { timeout: 180_000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t584-digest-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  bindWakeLease(n, { agent: "worker", cli, session_id: sid, pid: process.pid });
  const read: string[] = [];
  const stop = (digest: string | undefined, armed: boolean) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1", MBX_AGENT: "unrelated" };
    delete env.MBX_STOP_DIGEST;
    if (digest !== undefined) env.MBX_STOP_DIGEST = digest;
    const input: Record<string, unknown> = { session_id: sid, cwd: process.cwd() };
    if (cli === "grok") {
      input.reason = "end_turn";
      if (armed) input.backgroundTasks = [{ type: "shell", command: `agentmbx watch --cli grok --session ${sid}` }];
    }
    return spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "hook", "stop", "--cli", cli], {
      input: JSON.stringify(input), encoding: "utf8", timeout: 30_000, env,
    });
  };
  const send = (kind: "message" | "reply" | "status" | "request" | "task" | "decision" | "alert", body: string, needs_reply = false) => {
    for (const id of read) n.setDelivery(id, "worker", "read");
    n.store.set(`stopseen:${cli}:${sid}`, new Date(Date.now() - 60_000).toISOString());
    const id = sendLeased(n, { from: "boss", to: ["worker"], subject: kind, body, kind, needs_reply }).envelope.id;
    read.push(id);
    const row = n.inbox("worker", { limit: 20 }).find((m) => m.id === id);
    assert.ok(row, `${kind} is in the inbox`);
    return row;
  };
  const text = (digest: string | undefined, armed: boolean) => {
    const r = stop(digest, armed);
    return { r, out: r.stdout + r.stderr };
  };
  const waits = (digest: string | undefined, label: string) => {
    const { r, out } = text(digest, true);
    assert.doesNotMatch(out, CONTINUES, label);
    if (cli === "grok") assert.equal(r.stdout, "", `${label}: an armed grok watcher stays silent`);
  };
  const blocks = (digest: string | undefined, label: string) => {
    assert.match(text(digest, false).out, CONTINUES, label);
  };

  const status = send("status", "sitting", true);
  assert.equal(n.wantsWake("worker", status), false, "status is not wake-worthy");
  waits(undefined, "status does not continue while the digest is off");

  const note = send("message", "need you", true);
  assert.equal(n.wantsWake("worker", note), true, "needs_reply is wake-worthy before the digest");
  blocks(undefined, "digest off: a message that needs a reply still continues");
  const odd = send("message", "still need you", true);
  assert.equal(n.wantsWake("worker", odd), true);
  blocks("maybe", "an unrecognized value stays off");
  const held = send("message", "held for the prompt", true);
  assert.equal(n.wantsWake("worker", held), true);
  waits("1", "digest on: a message that needs a reply waits");
  waits("on", "on is the same switch");
  waits("true", "true is the same switch");

  const mention = send("reply", "@worker please");
  assert.equal(n.wantsWake("worker", mention), true, "an @mention is wake-worthy before the digest");
  waits("1", "digest on: a reply with an @mention waits");

  const later = send("status", "still sitting", true);
  assert.equal(n.wantsWake("worker", later), false);
  waits("1", "status still does not continue while the digest is on");

  for (const kind of ["request", "task", "decision", "alert"] as const) {
    const row = send(kind, "go", true);
    assert.equal(row.kind, kind);
    assert.equal(n.wantsWake("worker", row), true);
    blocks("1", `${kind} still continues`);
  }
});
