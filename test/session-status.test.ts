import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";

test("session status follows rename, counts linked mail, and rejects stale or unknown bindings", () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-status-")), { host: "alpha" });
  try {
    n.registerAgent("folder", { cli: "claude" });
    n.bindSession({ agent: "folder", cli: "claude", session_id: "thread", pid: process.pid });
    n.bindSession({ agent: "renamed", cli: "claude", session_id: "mcp-session", pid: process.pid, session_key: "k" });
    n.linkIdentity("shell", "renamed");
    const send = (to: string, needs_reply = false) => n.send({ from: "sender", to: [to], subject: "PRIVATE", body: "SECRET", needs_reply }).envelope.id;
    send("folder", true); // a folder-derived HUD would count this unrelated mailbox
    const id = send("renamed", true);
    send("shell");
    const agentsBefore = n.agents();
    const run = (session = "thread", cli = "claude") => spawnSync(process.execPath,
      ["bin/agentmbx.js", "status", "--cli", cli, "--session", session, "--json"], {
        encoding: "utf8", env: { ...process.env, MBX_HOME: n.home, AGENTMBX_DEV: "1" },
      });
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { agent: "renamed", host: "alpha", address: "renamed@alpha", cli: "claude",
      session_id: "thread", mailboxes: ["renamed", "shell"], unread: 2, needs_reply: 1, owner_authority: 0, outbox: 0 });
    assert.doesNotMatch(r.stdout, /PRIVATE|SECRET/);
    assert.deepEqual(n.agents(), agentsBefore, "status does not register or relabel an agent");
    assert.equal(n.inbox("renamed")[0].state, "delivered");
    n.ack(id, "renamed");
    assert.equal(JSON.parse(run().stdout).unread, 1);
    assert.notEqual(run("missing").status, 0);
    assert.notEqual(run("thread", "codex").status, 0);
    n.store.db.prepare("UPDATE sessions SET pid_start='different-process' WHERE session_id='thread'").run();
    assert.notEqual(run().status, 0, "reused process identity is rejected");
    n.store.db.prepare("UPDATE sessions SET updated_at='2000-01-01T00:00:00Z'").run();
    assert.notEqual(run("mcp-session").status, 0);
  } finally { n.close(); }
});

for (const cli of ["claude", "codex", "kimi", "opencode"]) test(`${cli} status revalidates owner claims after revocation`, async t => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const { generateKeyPair } = await import("../src/crypto.ts");
  const { makeGrant } = await import("../src/envelope.ts");
  const home = mkdtempSync(join(tmpdir(), "mbx-status-authority-"));
  const owner = generateKeyPair(), session = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  n.bindSession({ agent: "worker", cli, session_id: "status-authority", pid: process.pid });
  const grant = makeGrant(owner.publicKey, owner.privateKey, session.publicKey, "master", "alpha", ["task.assign"], 1);
  const id = n.send({ from: "master", to: ["worker"], subject: "PRIVATE", body: "SECRET", kind: "task" },
    { pub: session.publicKey, priv: session.privateKey, grant }).envelope.id;
  const status = () => {
    const r = spawnSync(process.execPath, ["bin/agentmbx.js", "status", "--cli", cli, "--session", "status-authority", "--json"],
      { encoding: "utf8", env: { ...process.env, MBX_HOME: home, AGENTMBX_DEV: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /PRIVATE|SECRET/);
    return JSON.parse(r.stdout);
  };
  assert.equal(status().owner_authority, 1);
  n.store.db.prepare("INSERT INTO grants VALUES (?,?,?,?,1)").run(grant.id, grant.sub, JSON.stringify(grant), grant.exp);
  assert.equal(status().owner_authority, 0);
  assert.equal(status().unread, 1);
  const raw = n.store.db.prepare("SELECT authority FROM messages WHERE id=?").get(id) as { authority: string };
  assert.equal(JSON.parse(raw.authority).ok, true, "historical receipt is retained");
});
