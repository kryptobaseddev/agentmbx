// Owner key backends (T052): the passphrase file, and the macOS Keychain helper (agentmbx-auth). The keychain tests use a
// FAKE helper (MBX_AUTH_HELPER) that keeps its key in a temp file, so no test touches the real Keychain or shows a prompt.
// The real Swift helper is exercised only through `summary` and `selftest`, which never read the Keychain or prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { canonical, fingerprint, generateKeyPair, verifyData } from "../src/crypto.ts";
import { buildEnvelope, buildGrant, checkAuthority, grantPayload, ownerSignRequest, type Envelope, type Grant } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import {
  authHelperPath, createKeychainOwner, createOwnerKey, defaultOwnerBackend, helperError, keychainOwnerStatus, ownerInfo, ownerJsonPath,
  ownerPublicKey, ownerSignCanonical, runAuthHelper,
} from "../src/owner.ts";
import { ownerStep } from "../src/setup.ts";

const tmp = (p = "mbx-owner-") => mkdtempSync(join(tmpdir(), p));
const CRYPTO = fileURLToPath(new URL("../src/crypto.ts", import.meta.url));

/** A stand-in for agentmbx-auth: same commands and exit codes, key in $dir/key.json, every call logged to $dir/calls.jsonl.
 *  FAKE_AUTH_MODE=cancel makes sign exit 6 (prompt cancelled); =wrongkey signs with a different key. */
function fakeHelper(dir = tmp("mbx-fakeauth-")): { path: string; dir: string; calls: () => { args: string[]; payload?: string }[] } {
  const path = join(dir, "agentmbx-auth");
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPair, signData } from ${JSON.stringify(CRYPTO)};
const dir = ${JSON.stringify(dir)}, keyFile = dir + "/key.json", [cmd, file] = process.argv.slice(2);
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ args: process.argv.slice(2), payload: cmd === "sign" ? readFileSync(file, "utf8") : undefined }) + "\\n");
const key = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : null;
if (cmd === "pubkey") { if (!key) { console.error("agentmbx-auth: no owner key in the Keychain"); process.exit(3); } console.log(key.publicKey); }
else if (cmd === "check") { if (process.env.FAKE_AUTH_MODE === "nogui") { console.error("agentmbx-auth: no GUI session here (SSH or a background session), so the Touch ID / password prompt can't be shown. Run this at the Mac"); process.exit(9); } console.log("ok"); }
else if (cmd === "init") { if (key) process.exit(4); const k = generateKeyPair(); writeFileSync(keyFile, JSON.stringify(k)); console.log(k.publicKey); }
else if (cmd === "sign") {
  if (!key) process.exit(3);
  if (process.env.FAKE_AUTH_MODE === "cancel") { console.error("agentmbx-auth: not approved (Canceled by user.)"); process.exit(6); }
  const priv = process.env.FAKE_AUTH_MODE === "wrongkey" ? generateKeyPair().privateKey : key.privateKey;
  console.log(signData(priv, readFileSync(file)));
} else process.exit(2);
`);
  chmodSync(path, 0o755);
  const calls = () => existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; payload?: string }) : [];
  return { path, dir, calls };
}

/** Run the CLI in-process with MBX_HOME/MBX_AUTH_HELPER set; returns the exit code and captured stdout. */
async function cli(env: Record<string, string>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const saved = { ...process.env }, log = console.log, write = process.stderr.write.bind(process.stderr);
  let out = "", err = "";
  Object.assign(process.env, env);
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try { process.exitCode = 0; await main(argv); return { code: Number(process.exitCode ?? 0), out, err }; }
  finally { console.log = log; process.stderr.write = write; process.env = saved; process.exitCode = 0; }
}

// ---- file backend (unchanged) --------------------------------------------------------------------------------------
test("file backend: owner.key records backend=file, ownerInfo/ownerPublicKey read it", () => {
  const h = tmp();
  const pub = createOwnerKey(h, "correct horse battery staple");
  assert.deepEqual(ownerInfo(h), { backend: "file", public_key: pub, path: join(h, "owner.key") });
  assert.equal(ownerPublicKey(h), pub);
  assert.equal(JSON.parse(readFileSync(join(h, "owner.key"), "utf8")).backend, "file");
  assert.equal(statSync(join(h, "owner.key")).mode & 0o777, 0o600);
  // an owner.key written before T052 (no backend field) is still the file backend
  const old = tmp(), f = JSON.parse(readFileSync(join(h, "owner.key"), "utf8")); delete f.backend;
  writeFileSync(join(old, "owner.key"), JSON.stringify(f));
  assert.equal(ownerInfo(old)?.backend, "file");
});

test("default backend: keychain only when the helper exists", () => {
  const fake = fakeHelper();
  assert.equal(defaultOwnerBackend({ MBX_AUTH_HELPER: fake.path }, tmp(), "linux"), "keychain");
  assert.equal(defaultOwnerBackend({ MBX_AUTH_HELPER: join(fake.dir, "missing") }, tmp(), "darwin"), "file");
  assert.equal(defaultOwnerBackend({}, tmp(), "linux"), "file");
  assert.equal(defaultOwnerBackend({}, tmp(), "darwin"), "file"); // no AgentMBX.app under this fake home
  assert.equal(authHelperPath({}, tmp(), "linux"), null);
});

// ---- keychain backend through a fake helper ------------------------------------------------------------------------
test("keychain backend: init creates the key via the helper, a second home adopts it without init", async () => {
  const fake = fakeHelper(), h1 = tmp(), h2 = tmp();
  const r1 = await createKeychainOwner(h1, fake.path);
  assert.equal(r1.adopted, false);
  assert.deepEqual(fake.calls().map((c) => c.args[0]), ["pubkey", "init"]);
  const j = JSON.parse(readFileSync(ownerJsonPath(h1), "utf8"));
  assert.equal(j.backend, "keychain"); assert.equal(j.public_key, r1.publicKey);
  assert.equal(ownerInfo(h1)?.backend, "keychain"); assert.equal(ownerPublicKey(h1), r1.publicKey);
  assert.equal(existsSync(join(h1, "owner.key")), false);
  const r2 = await createKeychainOwner(h2, fake.path);
  assert.equal(r2.adopted, true); assert.equal(r2.publicKey, r1.publicKey);
  assert.deepEqual(fake.calls().map((c) => c.args[0]), ["pubkey", "init", "pubkey"]);
  await assert.rejects(createKeychainOwner(h1, fake.path), /already exists/);
  assert.throws(() => createOwnerKey(h1, "correct horse battery staple"), /already exists/);
});

test("ownerSignCanonical (keychain): the helper signs the exact bytes; cancel and wrong-key signatures are errors", async () => {
  const fake = fakeHelper(), h = tmp();
  const { publicKey } = await createKeychainOwner(h, fake.path);
  const payload = canonical({ v: 1, type: "policy", level: "collaborate", z: "ü", a: [1, 2] });
  const env = process.env;
  process.env = { ...env, MBX_AUTH_HELPER: fake.path };
  try {
    const r = await ownerSignCanonical(h, payload, "test summary");
    assert.equal(r.pub, publicKey); assert.equal(r.fp, fingerprint(publicKey));
    assert.ok(verifyData(publicKey, payload, r.sig));
    const signCall = fake.calls().find((c) => c.args[0] === "sign")!;
    assert.equal(signCall.payload, payload); // byte-identical file handed to the helper
    assert.equal(existsSync(signCall.args[1]), false); // temp payload file removed afterwards
    process.env.FAKE_AUTH_MODE = "cancel";
    await assert.rejects(ownerSignCanonical(h, payload, "x"), /not approved/);
    process.env.FAKE_AUTH_MODE = "wrongkey";
    await assert.rejects(ownerSignCanonical(h, payload, "x"), /does not verify/);
    process.env = { ...env, MBX_AUTH_HELPER: join(fake.dir, "missing") };
    await assert.rejects(ownerSignCanonical(h, payload, "x"), /helper was not found/);
  } finally { process.env = env; }
});

/** alpha (keychain owner via the fake helper) and beta, paired both ways. */
async function keychainHosts() {
  const fake = fakeHelper();
  const a = new MbxNode(tmp(), { host: "alpha" }), b = new MbxNode(tmp(), { host: "beta" });
  await createKeychainOwner(a.home, fake.path);
  createOwnerKey(b.home, "correct horse battery staple");
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.upsertPendingPeer({ host: y.host, pubkey: y.key.publicKey, owner_pubkey: y.ownerPub, addr: "127.0.0.1:0", code: "000000", nonce_local: "n", nonce_remote: "n" });
    x.approvePeer(y.host);
  }
  a.registerAgent("master"); a.registerAgent("helper"); b.registerAgent("worker");
  return { a, b, fake, env: { MBX_HOME: a.home, MBX_AUTH_HELPER: fake.path, MBX_NO_UPDATE_CHECK: "1" } };
}

test("owner send (CLI) signs through the helper; local and paired receivers verify it unchanged", async () => {
  const { a, b, fake, env } = await keychainHosts();
  const r = await cli(env, ["owner", "send", "--to", "helper,worker@beta", "--subject", "ship it", "-m", "go", "--kind", "task"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /owner-signed/);
  const sign = fake.calls().filter((c) => c.args[0] === "sign");
  assert.equal(sign.length, 1);
  const payload = JSON.parse(sign[0].payload!) as Envelope;
  assert.equal(payload.subject, "ship it"); assert.deepEqual(payload.authority, { owner_fp: fingerprint(a.ownerPub!) });
  // local delivery on alpha
  const local = a.inbox("helper")[0];
  assert.equal(JSON.parse(local.authority!).ok, true);
  // remote delivery on beta: the unchanged checkAuthority accepts the helper-made signature
  const rows = a.store.db.prepare("SELECT m.envelope FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE o.host='beta'").all() as { envelope: string }[];
  for (const row of rows) b.receive(JSON.parse(row.envelope), "alpha");
  const got = JSON.parse(b.inbox("worker")[0].authority!);
  assert.equal(got.ok, true); assert.equal(got.session, "signed by the owner");
  const e = JSON.parse(rows[0].envelope) as Envelope;
  assert.equal(checkAuthority(e, a.ownerPub, new Set()).ok, true);
  assert.equal(checkAuthority({ ...e, subject: "tampered" }, a.ownerPub, new Set()).ok, false);
});

test("owner grant and revoke (CLI) sign through the helper; the grant verifies like a file-key grant", async () => {
  const { a, fake, env } = await keychainHosts();
  const session = generateKeyPair();
  a.bindSession({ agent: "master", cli: "claude", session_id: "s1", pid: process.pid, session_key: session.publicKey, cwd: "/tmp" });
  const r = await cli(env, ["owner", "grant", "master", "--caps", "task.assign,decision", "--ttl", "2h"]);
  assert.equal(r.code, 0, r.err);
  const id = /granted (\S+)/.exec(r.out)![1];
  const g = JSON.parse((a.store.db.prepare("SELECT grant FROM grants WHERE id=?").get(id) as { grant: string }).grant) as Grant;
  const { sig, ...rest } = g;
  assert.ok(verifyData(a.ownerPub!, grantPayload(rest), sig));
  assert.equal(g.iss, fingerprint(a.ownerPub!)); assert.equal(g.sub, `session:${session.publicKey}`);
  assert.equal(fake.calls().find((c) => c.args[0] === "sign")!.payload, grantPayload(rest));
  // a message from that session under the grant is accepted
  a.registerAgent("worker2");
  const sent = a.send({ from: "master", to: ["worker2"], subject: "t", body: "b", kind: "task" }, { priv: session.privateKey, pub: session.publicKey, grant: g });
  assert.equal(JSON.parse(a.message(sent.envelope.id)!.authority!).ok, true);

  const rv = await cli(env, ["owner", "revoke", id]);
  assert.equal(rv.code, 0, rv.err);
  const rec = JSON.parse(fake.calls().filter((c) => c.args[0] === "sign")[1].payload!);
  assert.equal(rec.type, "revocation"); assert.deepEqual(rec.revokes, [id]); assert.equal(rec.owner_fp, fingerprint(a.ownerPub!));
  assert.equal((a.store.db.prepare("SELECT revoked FROM grants WHERE id=?").get(id) as { revoked: number }).revoked, 1);
});

test("owner init (CLI) defaults to the keychain when the helper exists; show and doctor status report it", async () => {
  const fake = fakeHelper(), home = tmp();
  new MbxNode(home, { host: "gamma" }).close();
  const env = { MBX_HOME: home, MBX_AUTH_HELPER: fake.path };
  const r = await cli(env, ["owner", "init"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Touch ID \/ password prompt will appear/);
  assert.equal(ownerInfo(home)?.backend, "keychain");
  assert.match((await cli(env, ["owner", "show"])).out, /macOS Keychain, Touch ID/);
  assert.notEqual((await cli(env, ["owner", "init"])).code, 0); // already exists
  assert.deepEqual(await keychainOwnerStatus(home, fake.path), { ok: true, detail: fake.path });
  writeFileSync(join(fake.dir, "key.json"), JSON.stringify(generateKeyPair())); // Keychain now holds a different key
  assert.match((await keychainOwnerStatus(home, fake.path)).detail, /holds owner key/);
  assert.match((await keychainOwnerStatus(home, null)).detail, /missing/);
});

test("setup owner step: present, printed command without a helper, created via the helper, never throws", async () => {
  const lines: string[] = [], log = (l: string) => lines.push(l);
  const cmd = ["/usr/local/bin/agentmbx"];
  assert.equal(await ownerStep({ mbxHome: tmp(), cmd, helper: null, log }), "manual");
  assert.match(lines.join("\n"), /\/usr\/local\/bin\/agentmbx owner init/);
  const fake = fakeHelper(), h = tmp();
  assert.equal(await ownerStep({ mbxHome: h, cmd, helper: fake.path, dryRun: true, log }), "dry-run");
  assert.equal(ownerInfo(h), null);
  assert.equal(await ownerStep({ mbxHome: h, cmd, helper: fake.path, log }), "created");
  assert.match(lines.join("\n"), /Touch ID \/ password prompt will appear: approve it/);
  assert.equal(await ownerStep({ mbxHome: h, cmd, helper: fake.path, log }), "present");
  const failing = await ownerStep({ mbxHome: tmp(), cmd, helper: fake.path, log, create: async () => { throw new Error("not approved"); } });
  assert.equal(failing, "failed");
  assert.match(lines.at(-1)!, /Run later: \/usr\/local\/bin\/agentmbx owner init/);
  // SSH / no GUI: nothing waits on a prompt that can't appear; both commands are printed
  const h2 = tmp(), env = process.env;
  process.env = { ...env, FAKE_AUTH_MODE: "nogui" };
  try { assert.equal(await ownerStep({ mbxHome: h2, cmd, helper: fake.path, log }), "manual"); } finally { process.env = env; }
  assert.match(lines.at(-1)!, /no GUI session here/);
  assert.match(lines.at(-1)!, /agentmbx owner init --backend file/);
  assert.equal(ownerInfo(h2), null);
});

test("helper failures are results, not crashes: missing binary, timeout, cancel", async () => {
  const d = tmp();
  const missing = await runAuthHelper(join(d, "nope"), ["pubkey"]);
  assert.equal(missing.code, 127);
  const slow = join(d, "slow"); writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n"); chmodSync(slow, 0o755);
  const t = await runAuthHelper(slow, ["sign", "x"], 200);
  assert.equal(t.code, 124);
  assert.match(helperError("owner signature not made", t).message, /timed out waiting/);
  assert.equal((helperError("x", { code: 9, stdout: "", stderr: "" }) as Error & { helperExit: number }).helperExit, 9);
  assert.match(helperError("x", { code: 6, stdout: "", stderr: "" }).message, /not approved/);
});

// ---- the real Swift helper: summary + selftest only (no Keychain, no prompt) ---------------------------------------
function realHelper(): string | null {
  if (process.platform !== "darwin") return null;
  const src = fileURLToPath(new URL("../macos/Auth/main.swift", import.meta.url));
  const built = fileURLToPath(new URL("../build/AgentMBX.app/Contents/MacOS/agentmbx-auth", import.meta.url));
  if (existsSync(built) && statSync(built).mtimeMs >= statSync(src).mtimeMs) return built;
  if (spawnSync("swiftc", ["--version"]).status !== 0) return null;
  const out = join(tmp("mbx-auth-build-"), "agentmbx-auth");
  try { execFileSync("swiftc", ["-Onone", src, "-o", out], { stdio: "ignore", timeout: 180_000 }); return out; } catch { return null; }
}
const REAL = realHelper();
const skip = REAL ? false : "real agentmbx-auth needs macOS + swiftc (scripts/build-macos-app.sh)";

function summary(payload: string): { code: number; text: string; err: string } {
  const f = join(tmp("mbx-summary-"), "p.json");
  writeFileSync(f, payload);
  const r = spawnSync(REAL!, ["summary", f], { encoding: "utf8" });
  return { code: r.status ?? -1, text: r.stdout.trim(), err: r.stderr.trim() };
}
const ok = (payload: unknown) => { const r = summary(canonical(payload)); assert.equal(r.code, 0, r.err); return r.text; };
const iat = "2026-09-26T12:00:00.000Z", hours = (h: number) => new Date(Date.parse(iat) + h * 3_600_000).toISOString();

test("real helper: selftest signatures (CryptoKit Ed25519) verify with Node crypto", { skip }, () => {
  const f = join(tmp("mbx-selftest-"), "p.json"), data = canonical({ v: 1, hello: "wörld", n: [1, 2, 3] });
  writeFileSync(f, data);
  for (let i = 0; i < 3; i++) {
    const r = JSON.parse(execFileSync(REAL!, ["selftest", f], { encoding: "utf8" })) as { pub: string; sig: string };
    assert.ok(verifyData(r.pub, data, r.sig));
    assert.equal(verifyData(r.pub, data + " ", r.sig), false);
  }
});

test("real helper: takeover summary identifies both sessions and refuses ambiguous display text", { skip }, () => {
  const payload = { v: 1, type: "identity-takeover", owner_fp: "1111-1111-1111-1111", name: "reader", host: "alpha", host_fp: "2222-2222-2222-2222",
    previous: { cli: "claude", session_id: "old", key_fp: "3333-3333-3333-3333", generation: "a".repeat(64), pid: 123, start: "birth" },
    claimant_cli: "codex", claimant_session: "new", claimant_key: "4444-4444-4444-4444", claimant_hash: "b".repeat(64), expires_at: Date.parse(hours(1)) };
  const text = ok(payload);
  assert.match(text, /Take over reader@alpha/); assert.match(text, /from claude session old/);
  assert.match(text, /to codex session new/); assert.match(text, /previous session loses access; mail is preserved/);
  assert.ok(text.includes(payload.previous.generation)); assert.ok(text.includes(payload.claimant_hash));
  assert.equal(summary(canonical({ ...payload, claimant_session: "hidden\\nnew".replace("\\n", "\n") })).code, 5);
  assert.equal(summary(canonical({ ...payload, previous: {} })).code, 5);
});

test("real helper: prompt text for each payload type", { skip }, () => {
  const policy = { v: 1, type: "policy", id: "01J", level: "collaborate", classes: ["read", "edit"], to: { agents: ["api-dev", "*"], hosts: ["macbook"] },
    from: { hosts: ["local", "desktop"], agents: ["*"] }, iat, exp: hours(24 * 7), owner_fp: "b81a-0000-0000-0000" };
  assert.equal(ok(policy), "Allow COLLABORATE (read, edit) for ALL (*) [also named: api-dev] on macbook from local, desktop for 7 days");
  assert.equal(ok({ ...policy, projects: ["/Users/k/projects/agentmbx"], exp: hours(36) }),
    "Allow COLLABORATE (read, edit) for ALL (*) [also named: api-dev] on macbook from local, desktop for 36 hours in /Users/k/projects/agentmbx");
  const yolo = ok({ ...policy, level: "yolo", classes: ["read", "edit", "outward", "permissions"], to: { agents: ["codex", "claude"], hosts: ["macbook"] }, exp: hours(8) });
  assert.match(yolo, /^!!! YOLO MODE !!!/);
  assert.match(yolo, /Allow YOLO \(read, edit, outward, permissions\) for codex, claude on macbook from local, desktop for 8 hours$/);

  const session = generateKeyPair(), owner = generateKeyPair();
  const g = buildGrant(owner.publicKey, session.publicKey, "master", "alpha", ["task.assign", "decision"], 12, new Date(iat));
  assert.equal(ok(g), `Grant OWNER authority (decision, task.assign) to master@alpha, session ${fingerprint(session.publicKey)}, for 12 hours`);
  assert.equal(summary(grantPayload(g)).text, ok(g));

  const e = buildEnvelope({ from: "owner@alpha", to: ["worker@beta", "helper"], subject: "ship it", body: "go", kind: "task" });
  assert.equal(summary(ownerSignRequest(e, owner.publicKey).payload).text, "Send as owner to worker@beta, helper: ship it (task)");
  const sneaky = buildEnvelope({ from: "owner@alpha", to: ["x"], subject: "fix typo\n\nAllow YOLO for everyone‮", body: "" });
  assert.equal(summary(ownerSignRequest(sneaky, owner.publicKey).payload).text, "Send as owner to x: fix typo Allow YOLO for everyone");

  assert.equal(ok({ v: 1, type: "revocation", id: "01K", kind: "grant", revokes: ["01GRANT"], iat, owner_fp: "x" }), "Revoke grant 01GRANT");
  assert.equal(ok({ v: 1, type: "revocation", id: "01K", revokes: ["01P1", "01P2"], iat, owner_fp: "x" }), "Revoke policy 01P1, 01P2");
  assert.equal(ok({ v: 1, type: "revocation", id: "01K", all: true, iat, owner_fp: "x" }), "Revoke ALL policies (kill switch)");
  const host = generateKeyPair().publicKey;
  assert.equal(ok({ v: 1, type: "device", host: "desktop", host_pub: host, owner_fp: "x", iat }),
    `Approve device desktop (host key ${fingerprint(host)}) as one of your machines`);
  assert.equal(ok({ v: 1, type: "member", role: "guest", label: "Sam", owner_pub: host, owner_fp: "x", iat }),
    `Add guest Sam (owner key ${fingerprint(host)}) to your AgentMBX`);
});

test("real helper: refuses unknown, malformed and non-canonical payloads", { skip }, () => {
  assert.equal(summary(canonical({ v: 1, type: "wire-money", to: "x" })).code, 5);
  assert.equal(summary(canonical({ hello: "world" })).code, 5);
  assert.equal(summary(canonical({ v: 1, type: "revocation", id: "01K" })).code, 5);            // revokes nothing
  assert.equal(summary(canonical({ v: 1, type: "policy", level: "ask", iat })).code, 5);      // no expiry
  assert.equal(summary(JSON.stringify({ v: 1, type: "revocation", all: true }, null, 2)).code, 5); // not canonical
  assert.equal(summary('{"all":true,"all":false,"type":"revocation","v":1}').code, 5);          // duplicate keys
  assert.equal(summary(canonical({ type: "revocation", all: true, v: 1.5 })).code, 5);         // non-integer number
  assert.equal(summary("[1,2]").code, 5);
});

test("real helper: long security values are shown whole or refused, never cut", { skip }, () => {
  const exp = new Date(Date.parse(iat) + 7 * 86_400_000).toISOString();
  const base = { v: 1, type: "policy", id: "01P", level: "collaborate", classes: ["read", "edit"], to: { agents: ["api"], hosts: ["macbook"] }, from: { hosts: ["local"], agents: ["*"] }, iat, exp, owner_fp: "x" };
  const mid = `/Users/k/${"segment/".repeat(40)}hidden-destination`; // ~340 chars: fits, shown in full
  assert.match(ok({ ...base, projects: [mid] }), /hidden-destination$/);
  const long = `/Users/k/${"segment/".repeat(60)}hidden-destination`; // ~500 chars: over the cap with the rest, refused
  const r = summary(canonical({ ...base, projects: [long, long] }));
  assert.equal(r.code, 5); assert.match(r.err, /too much to show/);
});
