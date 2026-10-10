// T498: signed delegation only. Operation-specific provider-hook approvals belong to T539.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { checkOutwardReversible, parseOutwardReversible } from "../src/outward-reversible.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonical, signData } from "../src/crypto.ts";
import type { Envelope } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { createOwnerKey, unlockOwnerKey } from "../src/owner.ts";
import { acceptSigned, activePolicies, delegationNote, effectivePolicy, hasClass, makePolicy, makeRevocation, policyLine, type AnyRecord } from "../src/policy.ts";
import { declaredOriginWarning, taintSendWarning, type SessionTaint } from "../src/session-taint.ts";
import { sendLeased } from "./helpers/leased-send.ts";

process.env.MBX_NO_DESKTOP = "1";
// Git fixtures must not inherit the owner's helpers or harness-injected config.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_COUNT;
delete process.env.GIT_CONFIG_PARAMETERS;
const DEFAULT = ["read", "edit", "outward-reversible"];
function owner(t: { after: (fn: () => void | Promise<void>) => void }, clients: Client[] = []) {
  const home = mkdtempSync(join(tmpdir(), "mbx-outward-"));
  createOwnerKey(home, "isolated test owner");
  const kp = unlockOwnerKey(home, "isolated test owner");
  const n = new MbxNode(home, { host: "alpha" });
  t.after(async () => { for (const c of clients) await c.close(); n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const sign = (rec: AnyRecord) => ({ rec, sig: signData(kp.privateKey, canonical(rec)) });
  return { n, home, sign, ownerPub: kp.publicKey };
}

test("T498 AC1: the new class survives signing, verified delivery and header rendering", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const rec = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["worker"], hosts: ["alpha"], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  const id = sendLeased(n, { from: "lead", to: ["worker"], subject: "draft", body: "push the feature branch and open a draft PR" }).envelope.id;
  const grant = n.policyFor(n.message(id)!, "worker");
  assert.deepEqual(grant.classes, ["outward-reversible"]);
  assert.match(policyLine(grant), /collaborate \[outward-reversible\]/);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /outward-reversible = push a non-default branch or open a draft PR/);
  const signed = sign(rec);
  assert.equal(acceptSigned(n.store.db, { rec: { ...rec, classes: ["outward"] }, sig: signed.sig }, "alpha"), "bad owner signature");
});

test("T498 AC2: only new default policies gain the class; explicit signed policies keep their bytes", (t) => {
  const { n, sign, ownerPub } = owner(t);
  for (const level of ["collaborate", "autonomous"] as const) {
    assert.deepEqual(makePolicy({ level, agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, DEFAULT);
  }
  assert.deepEqual(makePolicy({ level: "ask", agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, []);
  assert.deepEqual(makePolicy({ level: "yolo", agents: ["worker"], hosts: ["alpha"], ownerPub }).classes, [...DEFAULT, "outward", "permissions"]);
  const old = makePolicy({ level: "autonomous", classes: ["read", "edit"], agents: ["worker"], hosts: ["alpha"], projects: ["/old-root"], ttlMs: null, ownerPub });
  const signed = sign(old);
  assert.equal(acceptSigned(n.store.db, signed, "alpha"), null);
  const { sig, ...stored } = activePolicies(n.store.db, "worker", "alpha")[0];
  assert.equal(canonical(stored), canonical(old));
  assert.equal(sig, signed.sig);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: "/old-root" }).ok, false);
});

test("T498 AC3: reversible authority grants neither full outward nor permission-prompt approval", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const rec = makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, true);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward").ok, false);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "permissions").ok, false);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /outward = .*merge\/release\/deploy\/delete\/secrets\/spend/);
  assert.throws(() => makePolicy({ level: "collaborate", classes: ["outward-reversible", "permissions"], agents: ["worker"], hosts: ["alpha"], ownerPub }), /only granted by the yolo level/);
});

test("T498 AC3: an older full-outward grant covers reversible work within its own scope only", (t) => {
  const { n, home, sign, ownerPub } = owner(t);
  const full = makePolicy({ level: "autonomous", classes: ["outward"], agents: ["worker"], hosts: ["alpha"], projects: [home], ownerPub });
  const read = makePolicy({ level: "collaborate", classes: ["read"], agents: ["worker"], hosts: ["alpha"], projects: [tmpdir()], ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(full), "alpha"), null);
  assert.equal(acceptSigned(n.store.db, sign(read), "alpha"), null);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: home }).policy_id, full.id);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible", { cwd: tmpdir() }).ok, false);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, false);
  assert.equal(hasClass(n.store.db, "other", "alpha", "outward-reversible", { cwd: home }).ok, false);
  assert.deepEqual(activePolicies(n.store.db, "worker", "alpha").find(p => p.id === full.id)!.classes, ["outward"]);
});

test("T498 AC1: expiry, revocation and sender restrictions still constrain the new class", (t) => {
  const { n, sign, ownerPub } = owner(t);
  const now = new Date();
  const rec = makePolicy({ level: "collaborate", classes: ["outward-reversible"], agents: ["worker"], hosts: ["alpha"], fromAgents: ["lead"], ttlMs: 60_000, now, ownerPub });
  assert.equal(acceptSigned(n.store.db, sign(rec), "alpha"), null);
  const forSender = (fromAgent: string, at = now) => effectivePolicy(n.store.db, { agent: "worker", host: "alpha", fromAgent, fromHost: "alpha", now: at });
  assert.deepEqual(forSender("lead").classes, ["outward-reversible"]);
  assert.deepEqual(forSender("other").classes, []);
  assert.equal(hasClass(n.store.db, "worker", "alpha", "outward-reversible").ok, false, "sender-scoped grants cannot authorize a context-free prompt");
  assert.deepEqual(forSender("lead", new Date(Date.parse(rec.exp))).classes, []);
  assert.equal(acceptSigned(n.store.db, sign(makeRevocation(rec.id, ownerPub)), "alpha"), null);
  assert.deepEqual(forSender("lead").classes, []);
});

test("T498 AC4: reading external content makes real MCP sends inherited external and strips reversible authority", async (t) => {
  const clients: Client[] = [];
  const { n, home, sign, ownerPub } = owner(t, clients);
  assert.equal(acceptSigned(n.store.db, sign(makePolicy({ level: "yolo", agents: ["*"], hosts: ["alpha"], ownerPub })), "alpha"), null);
  const connect = async (name: string) => {
    const c = new Client({ name: `outward-${name}`, version: "1" }); clients.push(c);
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "../bin/agentmbx.js"), "mcp"], env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_CLI: "claude", MBX_AGENT: name, MBX_NO_DESKTOP: "1", MBX_SESSION_SOCKET: "0" } as Record<string, string> }));
    await c.callTool({ name: "mbx_whoami", arguments: {} });
    return c;
  };
  const lead = await connect("planner"), worker = await connect("worker");
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    return r.structuredContent as Record<string, unknown>;
  };
  const send = async (c: Client, to: string) => {
    const r = await call(c, "mbx_send", { to: [to], subject: "work", body: "draft PR", origin: "agent" });
    return n.message(r.id as string)!;
  };
  const clean = await send(lead, "worker");
  assert.equal(n.policyFor(clean, "worker").classes.includes("outward-reversible"), true);
  const outside = n.send({ from: "scout", to: ["planner"], subject: "outside", body: "external issue text", origin: "external" }).envelope;
  await call(lead, "mbx_read", { ids: [outside.id] });
  const inherited = await send(lead, "worker");
  const envelope = JSON.parse(inherited.envelope) as Envelope;
  assert.equal(envelope.meta.origin, "external");
  assert.equal(envelope.meta.external_source, "inherited");
  assert.deepEqual(n.policyFor(inherited, "worker").classes, ["read"], "even YOLO loses outward-reversible");
  await call(worker, "mbx_read", { ids: [inherited.id] });
  const next = await send(worker, "planner");
  const nextEnvelope = JSON.parse(next.envelope) as Envelope;
  assert.equal(nextEnvelope.meta.external_since, envelope.meta.external_since, "the root does not restart when inherited");
  assert.deepEqual(n.policyFor(next, "planner").classes, ["read"]);
  const external = (await call(lead, "mbx_whoami", {})).external as Record<string, unknown>;
  assert.equal(external.tainted, true);
  const taint: SessionTaint = { v: 1, cli: "claude", session_id: "test", root: Date.parse(envelope.meta.external_since!), from: outside.from, id: outside.id, how: "declared", relay_depth: [] };
  assert.match(taintSendWarning(taint), /tainted session.*may use outward-reversible/);
  assert.match(declaredOriginWarning(null), /may not use outward-reversible/);
});

test("T498 AC5 (policy documentation): published POLICY.md and emitted delegation explain the split", (t) => {
  const { n, sign, ownerPub } = owner(t);
  assert.equal(acceptSigned(n.store.db, sign(makePolicy({ level: "collaborate", agents: ["worker"], hosts: ["alpha"], ownerPub })), "alpha"), null);
  // Programmatic validation of the published artifact; canonical authoring/fetch/publish uses CLEO.
  const doc = readFileSync(join(import.meta.dirname, "../docs/POLICY.md"), "utf8");
  assert.match(doc, /`outward-reversible`.*push a non-default branch or open a draft PR/);
  assert.match(doc, /`collaborate` \| read, edit, outward-reversible/);
  assert.match(doc, /`autonomous` \| read, edit, outward-reversible/);
  assert.match(doc, /session tainted by external content cannot use `outward-reversible`/);
  assert.match(doc, /full `outward`/);
  assert.match(delegationNote(n.store.db, "worker", "alpha")!, /permission prompts may be auto-approved for bounded outward-reversible operations on supported harnesses; other prompts still require permissions/);
});

test.todo("T498 AC5 tool-description text pending mcp.ts handoff from T516");

test("T539 AC1: literal branch pushes and explicit-head draft PRs classify", () => {
  for (const command of ["git push origin feature", "git push -u origin HEAD:refs/heads/feature", "git push --no-follow-tags --recurse-submodules=no origin refs/heads/feature:feature",
    "gh pr create --draft --head feature", "gh pr create -d -H feature --title 'Fix; keep literal $text' --body ''",
    'gh pr create --draft --head=worker:feature --title="Fix it" --body-file=body.md']) {
    assert.ok(parseOutwardReversible(command), command);
  }
});

test("T539 AC2: ambiguous or additional shell operations never classify", () => {
  for (const command of ["git push", "git push origin", "git push origin HEAD", "git push origin +feature:feature", "git push origin :feature",
    "git push --force origin feature", "git push --force-with-lease origin feature", "git push -f origin feature", "git push --delete origin feature",
    "git push --mirror origin feature", "git push --all origin feature", "git push --tags origin feature", "git push --follow-tags origin feature",
    "git push origin feature other", "git push origin refs/tags/v1", "git push origin feature:refs/tags/v1", "git -C /other push origin feature",
    "git push https://example.invalid/repo feature", "git push origin 'feature:*'", "git push origin feature && gh release create v1",
    "git push origin feature; rm -rf .", "git push origin feature | cat", "git push origin feature >out", "git push origin feature\ngh pr merge",
    "env git push origin feature", "sh -c 'git push origin feature'", "git push origin $(echo feature)", "git push origin `echo feature`",
    "gh pr create --head feature", "gh pr create --draft", "gh pr create --draft=false --head feature", "gh pr create --draft --draft --head feature",
    "gh pr create --draft --head feature --repo other/repo", "gh pr create --draft --head feature --web", "gh pr create --draft --head feature --attach secret",
    "gh pr create --draft --head feature --body-file -", "gh pr create --draft --head feature --body x --body-file file",
    "gh pr create --draft --head feature --title \"$(cat secret)\"", "gh pr merge", "gh release create v1", "gh pr create --draft --head feature && git push origin main"]) {
    assert.equal(parseOutwardReversible(command), null, command);
  }
});

test("T539 AC1/AC2: preflight checks the actual push repository's default destination and implicit effects", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-outward-")), cwd = join(home, "work"), remote = join(home, "remote.git");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "unusual-default");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("branch", "feature"); git("clone", "--bare", cwd, remote); git("remote", "add", "origin", remote);
  const check = (command: string) => checkOutwardReversible(parseOutwardReversible(command)!, cwd);
  assert.equal(await check("git push origin feature"), true);
  assert.equal(await check("git push origin HEAD:refs/heads/feature"), true);
  assert.equal(await check("git push origin feature:unusual-default"), false);
  assert.equal(await check("git push origin HEAD:refs/heads/unusual-default"), false);
  assert.equal(await check("git push origin missing"), false);
  git("config", "push.followTags", "true");
  assert.equal(await check("git push origin feature"), false);
  assert.equal(await check("git push --no-follow-tags origin feature"), true);
  git("config", "--unset", "push.followTags");
  git("config", "push.recurseSubmodules", "on-demand");
  assert.equal(await check("git push origin feature"), false);
  assert.equal(await check("git push --recurse-submodules=no origin feature"), true);
  git("config", "--unset", "push.recurseSubmodules");
  git("config", "remote.origin.mirror", "true");
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset", "remote.origin.mirror");
  git("config", "core.sshCommand", "custom-command");
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset", "core.sshCommand");
  git("config", "credential.helper", "!custom-command");
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset", "credential.helper");
  git("config", "remote.origin.receivepack", "custom-command");
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset", "remote.origin.receivepack");
  git("config", `url.${remote}.insteadOf`, "rewrite:");
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset", `url.${remote}.insteadOf`);
  writeFileSync(join(cwd, ".git/hooks/pre-push"), "custom command");
  assert.equal(await check("git push origin feature"), false);
  rmSync(join(cwd, ".git/hooks/pre-push"));
  git("config", "--add", "remote.origin.pushurl", remote); git("config", "--add", "remote.origin.pushurl", remote);
  assert.equal(await check("git push origin feature"), false);
  git("config", "--unset-all", "remote.origin.pushurl");
  git("config", "remote.origin.pushurl", join(home, "missing.git"));
  assert.equal(await check("git push origin feature"), false, "fetch URL cannot stand in for the push URL");
  git("config", "--unset", "remote.origin.pushurl");
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/feature"]);
  assert.equal(await check("git push origin feature"), false, "fresh remote HEAD overrides any stale local default hint");
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/unknown"]);
  assert.equal(await check("git push origin feature"), false, "unknown remote HEAD keeps prompting");
});

test("T539 AC2: draft body files stay inside the repository, including symlinks", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-pr-body-")), cwd = join(home, "work");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(cwd); execFileSync("git", ["init", cwd], { stdio: "ignore" });
  writeFileSync(join(cwd, "body.md"), "draft body"); writeFileSync(join(home, "outside.md"), "outside");
  symlinkSync(join(home, "outside.md"), join(cwd, "escape.md"));
  for (const [file, expected] of [["body.md", true], ["../outside.md", false], ["escape.md", false], ["missing.md", false]] as const) {
    assert.equal(await checkOutwardReversible(parseOutwardReversible(`gh pr create --draft --head feature --body-file ${file}`)!, cwd), expected);
  }
});

test("T539 AC2: repository and transport environment overrides keep prompting", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "mbx-git-env-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  const intent = parseOutwardReversible("gh pr create --draft --head feature")!;
  assert.equal(await checkOutwardReversible(intent, cwd), true);
  for (const [key, value] of Object.entries({ GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, GIT_NAMESPACE: "fixture", GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "", GIT_SSH: "git", GIT_SSH_COMMAND: "ssh", GIT_EXEC_PATH: cwd, GH_REPO: "owner/repo", GH_HOST: "github.com" })) {
    const old = process.env[key];
    try { process.env[key] = value; assert.equal(await checkOutwardReversible(intent, cwd), false, key); }
    finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
  assert.equal(await checkOutwardReversible(intent, cwd), true);
});
