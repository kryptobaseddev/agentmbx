import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, fingerprint, generateKeyPair, signData } from "../src/crypto.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { makeLead, storeLead, type LeadRecord } from "../src/lead-record.ts";
import { leadGrantCovering, makeLeadGrants, sessionStartLeadAudit, storeLeadGrants } from "../src/lead-grants.ts";
import { formatFor, MbxNode } from "../src/node.ts";
import { delegationNote } from "../src/policy.ts";
import { noteProject } from "../src/registry.ts";
import { writeSessionTaint } from "../src/session-taint.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const cwd = realpathSync(dir);
  git(cwd, "init", "-b", "trunk");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  return cwd;
}

const ASK = "policy: ask (no owner policy covers this sender): reply, answer and ack freely; ask your user before acting";

function segment(classes: string[], project: string, record: string, grant: string, exp: string, depth: number): string {
  return `lead-delegated [${classes.join(", ")}] in ${project} · lead-record ${record.slice(-6)} · grant ${grant.slice(-6)} · expires ${exp.slice(0, 16).replace("T", " ")}Z · relay depth ${depth} (no limit for lead-delegated)`;
}

function world(t: TestContext) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-lead-policy-")), { host: "testhost", bind: "127.0.0.1", port: 0 });
  const owner = generateKeyPair(), peer = generateKeyPair();
  t.after(() => { try { n.close(); } catch { /* closed */ } rmSync(n.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  n.addApprovedPeer({ host: "ownerhost", pubkey: peer.publicKey, owner_pubkey: owner.publicKey, addr: "127.0.0.1:1" }, "test");
  n.adoptOwner("ownerhost");
  const cwd = repo(join(n.home, "proj"));
  for (const name of ["lead", "api-dev", "web-dev", "other"]) n.registerAgent(name);
  for (const m of ["lead", "api-dev", "web-dev"]) noteProject(n.store, m, cwd, true);
  const sign = (rec: unknown) => signData(owner.privateKey, canonical(rec));
  const lead = () => {
    const rec = makeLead({ project: cwd, agent: "lead", host: n.host, ownerPub: owner.publicKey });
    return storeLead(n, rec, sign(rec));
  };
  const grant = (l: LeadRecord, classes: string[] = ["read", "edit"]) => {
    const g = makeLeadGrants({ lead: l, classes, agents: ["api-dev"], ownerPub: owner.publicKey });
    storeLeadGrants(n, g, sign(g));
    return g;
  };
  let held: { leases: IdentityLeases; token: string } | null = null;
  const bindLead = () => {
    const key = generateKeyPair();
    const pid = process.pid;
    const leases = new IdentityLeases(n.store);
    const claim = leases.claim("lead", { pid, start: inspectLeaseProcess(pid).start!, keyFp: fingerprint(key.publicKey), cli: "claude", sessionId: "lead-s1" });
    n.bindSession({ agent: "lead", cli: "claude", session_id: "lead-s1", cwd, pid, session_key: key.publicKey });
    n.store.db.prepare("UPDATE identity_leases SET idle_ttl=?, heartbeat_at=? WHERE name='lead'").run(10 * 365 * 24 * 3600 * 1000, Date.now());
    held = { leases, token: claim.token };
  };
  const send = (to: string, extra: { hop?: number; origin?: "external"; unverifiedSender?: boolean } = {}) => {
    assert.ok(held);
    const env = held.leases.withHeld("lead", held.token, () => n.send({ from: "lead", to: [to], subject: "s", body: "hello", kind: "task", ...extra }));
    const row = n.message(env.envelope.id);
    assert.ok(row);
    return row;
  };
  const show = (row: NonNullable<ReturnType<MbxNode["message"]>>, to: string) => {
    const text = formatFor(n, row, to).split("\n").find((l) => l.startsWith("policy:")) ?? "";
    return { text, decided: n.policyFor(row, to) };
  };
  const line = (to: string, extra: { hop?: number; origin?: "external"; unverifiedSender?: boolean } = {}) => show(send(to, extra), to);
  const vias = () => (n.store.db.prepare("SELECT detail FROM audit WHERE event='lead.grant_used'").all() as { detail: string }[])
    .map((r) => JSON.parse(r.detail).via as string);
  return { n, owner, cwd, lead, grant, bindLead, send, show, line, vias };
}

test("T551 AC1: a live lead's message to a member carries the segment; a non-member and the lead writing to themselves do not", (t) => {
  const w = world(t);
  const l = w.lead();
  const g = w.grant(l);
  w.bindLead();
  const member = w.line("api-dev");
  assert.equal(member.text, `policy: ${segment(g.classes, w.cwd, l.id, g.id, g.exp, 0)}`);
  assert.equal(member.decided.level, "collaborate");
  assert.equal(w.line("other").text, ASK);
  assert.equal(w.line("lead").text, ASK);
});

test("T551 AC2: unverified, external, relay depth, tainted and stale", (t) => {
  const w = world(t);
  const l = w.lead();
  const g = w.grant(l, ["read", "edit", "outward-reversible"]);
  w.bindLead();
  const unverified = w.line("api-dev", { unverifiedSender: true });
  assert.equal(unverified.text, ASK);
  assert.equal(unverified.text.includes("lead-record"), false);
  const external = w.line("api-dev", { origin: "external" });
  assert.equal(external.text, `policy: ${segment(["read"], w.cwd, l.id, g.id, g.exp, 0)}`);
  assert.equal(external.text.includes("edit"), false);
  assert.equal(external.text.includes("outward-reversible"), false);
  const deep = w.line("api-dev", { hop: 99 });
  assert.equal(deep.text, `policy: ${segment(g.classes, w.cwd, l.id, g.id, g.exp, 99)}`);
  writeSessionTaint(w.n.store, { v: 1, cli: "claude", session_id: "lead-s1", root: Date.now(), from: "outside", id: "message_test", how: "declared", relay_depth: [] });
  assert.equal(w.line("api-dev").text, ASK);
});

test("T551 AC2: a lead past its heartbeat shows no segment", (t) => {
  const w = world(t);
  const l = w.lead();
  w.grant(l);
  w.bindLead();
  const row = w.send("api-dev");
  w.n.store.db.prepare("UPDATE identity_leases SET heartbeat_at=? WHERE name='lead'").run(Date.now() - 10 * 365 * 24 * 3600 * 1000 - 5000);
  const stale = w.show(row, "api-dev");
  assert.equal(stale.text, ASK);
  assert.equal(stale.text.includes("lead-record"), false);
});

test("T551 AC3: a stored outward-reversible-only blob stays that class, and a fresh signature may list read and edit", (t) => {
  const w = world(t);
  const l = w.lead();
  const g = w.grant(l, ["outward-reversible"]);
  w.bindLead();
  const shown = w.line("api-dev");
  assert.equal(shown.text, `policy: ${segment(["outward-reversible"], w.cwd, l.id, g.id, g.exp, 0)}`);
  assert.deepEqual(makeLeadGrants({ lead: l, classes: ["read", "edit"], agents: ["api-dev"], ownerPub: w.owner.publicKey }).classes, ["read", "edit"]);
  assert.throws(() => makeLeadGrants({ lead: l, classes: ["outward"], agents: ["api-dev"], ownerPub: w.owner.publicKey }), /never delegated/);
  assert.throws(() => makeLeadGrants({ lead: l, classes: ["permissions"], agents: ["api-dev"], ownerPub: w.owner.publicKey }), /never delegated/);
});

test("T551 AC4: the note names the record and grant, whoami returns lead_grant, and the three audit vias are written", async (t) => {
  const w = world(t);
  const l = w.lead();
  const g = w.grant(l);
  w.bindLead();
  const covered = leadGrantCovering(w.n, "api-dev");
  assert.ok(covered);
  const note = delegationNote(w.n.store.db, "api-dev", w.n.host, covered);
  assert.ok(note);
  assert.match(note, new RegExp(`Your project lead lead@testhost carries grant ${g.id.slice(-6)} on lead record ${l.id.slice(-6)} \\(\\[read, edit\\], expires ${g.exp.slice(0, 16).replace("T", " ")}Z\\)\\. It applies to that lead's requests and is a separate grant\\.`));
  const row = w.send("api-dev");
  w.show(row, "api-dev");
  w.show(row, "api-dev");
  sessionStartLeadAudit(w.n, "api-dev", "grok");
  sessionStartLeadAudit(w.n, "api-dev", "grok");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/agentmbx.js", import.meta.url)), "mcp"],
    env: { ...process.env, AGENTMBX_DEV: "1", MBX_NO_DESKTOP: "1", MBX_HOME: w.n.home, MBX_AGENT: "api-dev" },
  });
  const client = new Client({ name: "t551", version: "0" });
  t.after(async () => { try { await client.close(); } catch { /* not connected */ } });
  await client.connect(transport);
  const who = async () => {
    const res = await client.callTool({ name: "mbx_whoami", arguments: { name: "api-dev" } });
    assert.equal(res.isError, undefined);
    return res.structuredContent as { lead_grant: { classes: string[]; lead: string; record: string; grant: string; expires: string } | null; policies: unknown; lead: unknown };
  };
  const first = await who();
  const second = await who();
  assert.deepEqual(first.lead_grant, { classes: ["read", "edit"], lead: "lead@testhost", record: l.id, grant: g.id, expires: g.exp });
  assert.deepEqual(second.lead_grant, first.lead_grant);
  assert.ok("policies" in first && "lead" in first);
  const got = w.vias();
  assert.deepEqual(got.filter((v) => v === "read"), ["read"]);
  assert.deepEqual(got.filter((v) => v === "session-start"), ["session-start", "session-start"]);
  assert.deepEqual(got.filter((v) => v === "whoami"), ["whoami", "whoami"]);
});
