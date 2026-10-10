// T431: the status-surface checks from docs/harness-validation-recipe.md, check 7, as machine-
// runnable evidence. (a) The v2 fixture is a valid mbx.status/v2 snapshot and renders through the
// existing v1 line renderer. (b) The statusline adapter renders the owner's session segment for a
// bound session and nothing for an unknown session, for a composing CLI (opencode) and the
// alert-only CLI (kimi). Live plugin-surface evidence (Claude mod, OpenCode sidebar) is their own
// tests on their branches; this file is the fixture-render evidence every renderer shares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MbxNode } from "../src/node.ts";
import { hudLine, writeHud } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";

const FIXTURE = JSON.parse(readFileSync(join(resolve("test"), "fixtures", "status-v2-bound.json"), "utf8"));

test("the v2 fixture satisfies the mbx.status/v2 contract and renders to the shared v1 line", () => {
  assert.equal(FIXTURE.schema, "mbx.status/v2");
  for (const block of ["identity", "registration", "inbox", "harness", "cloud", "devices", "project"]) {
    assert.ok(block in FIXTURE, `v2 fixture carries the ${block} block`);
  }
  assert.equal(FIXTURE.identity.state, "bound");
  assert.equal(typeof FIXTURE.inbox.unread, "number");
  // the same numbers through the line renderer every statusline composes with
  const line = hudLine({
    schema: "mbx.status/v1", mbx_version: FIXTURE.mbx_version, update_available: null,
    identity: { name: FIXTURE.identity.name, role: FIXTURE.identity.role, state: "bound" },
    unread: FIXTURE.inbox.unread, needs_reply: FIXTURE.inbox.needs_reply,
    from_owner: FIXTURE.inbox.from_owner, outbox_unsent: FIXTURE.inbox.outbox_unsent,
    policy: FIXTURE.harness.policy, resolved_by: "session_id",
  });
  assert.equal(line, "mbx agentmbx-kimi(builder) 2↑ 1↺ 3 unsent", "fixture renders to the one line every CLI shows");
});

const statusline = (h: string, cli: string, sessionId: string) =>
  spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "statusline", cli],
    { input: JSON.stringify({ session_id: sessionId }), encoding: "utf8",
      env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: h, MBX_NO_DESKTOP: "1" } });

test("statusline check: own session renders the segment, unknown session renders nothing (opencode)", (t) => {
  const h = mkdtempSync(join(tmpdir(), "mbx-status-surface-")), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "probe-staff", cli: "opencode", session_id: "ses_surf", pid: process.pid, session_key: "k" });
  new IdentityLeases(n.store).claim("probe-staff", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "opencode", sessionId: "ses_surf" });
  n.send({ from: "boss", to: ["probe-staff"], subject: "one", body: "b" });
  n.send({ from: "boss", to: ["probe-staff"], subject: "two", body: "b", needs_reply: true });
  writeHud(n);
  const own = statusline(h, "opencode", "ses_surf");
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /^mbx probe-staff/);
  assert.ok(own.stdout.includes("2↑") && own.stdout.includes("1↺"));
  const unknown = statusline(h, "opencode", "ses_nope");
  assert.equal(unknown.stdout.trim(), "", "an unknown session renders nothing, never another identity (T308 AC2)");
});

test("statusline check: kimi is alert-only — nothing to show means an empty line", (t) => {
  const h = mkdtempSync(join(tmpdir(), "mbx-status-surface-kimi-")), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "quiet-staff", cli: "kimi", session_id: "ses_q", pid: process.pid, session_key: "k" });
  new IdentityLeases(n.store).claim("quiet-staff", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "kimi", sessionId: "ses_q" });
  writeHud(n);
  const quiet = statusline(h, "kimi", "ses_q");
  assert.equal(quiet.stdout, "", "kimi with no unread renders an empty line and leaves the footer alone");
  n.send({ from: "boss", to: ["quiet-staff"], subject: "ping", body: "b" });
  writeHud(n);
  const alert = statusline(h, "kimi", "ses_q");
  assert.match(alert.stdout, /^mbx quiet-staff/);
  assert.ok(alert.stdout.includes("1↑"));
});

// T527 AC1: the daemon's generic HUD writer covers bound Hermes sessions — hermes-<sid> v1, v2 and
// .line snapshots exist for `agentmbx status` and any future surface (Hermes itself has no status
// line to render one; doctor documents that separately).
test("hud check: a bound hermes session gets hermes-<sid> v1, v2 and line snapshots (T527)", (t) => {
  const h = mkdtempSync(join(tmpdir(), "mbx-status-surface-hermes-")), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "hermes-staff", cli: "hermes", session_id: "hermes-ses_hud", pid: process.pid, session_key: "k" });
  new IdentityLeases(n.store).claim("hermes-staff", { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli: "hermes", sessionId: "hermes-ses_hud" });
  n.send({ from: "boss", to: ["hermes-staff"], subject: "one", body: "b" });
  writeHud(n);
  const v1 = JSON.parse(readFileSync(join(h, "hud", "hermes-hermes-ses_hud.json"), "utf8"));
  assert.equal(v1.identity.name, "hermes-staff");
  assert.equal(v1.identity.state, "bound");
  assert.equal(v1.unread, 1);
  const v2 = JSON.parse(readFileSync(join(h, "hud", "hermes-hermes-ses_hud.v2.json"), "utf8"));
  assert.equal(v2.schema, "mbx.status/v2");
  assert.equal(v2.harness.cli, "hermes");
  assert.equal(v2.identity.name, "hermes-staff");
  const line = readFileSync(join(h, "hud", "hermes-hermes-ses_hud.line"), "utf8");
  assert.match(line, /^mbx hermes-staff/);
  assert.ok(line.includes("1↑"));
  // the binding dies (pid reused by a fake start): the snapshot prunes on the next pass
  n.store.db.prepare("UPDATE sessions SET pid_start=? WHERE cli='hermes' AND session_id=?").run("2000-01-01T00:00:00Z", "hermes-ses_hud");
  writeHud(n);
  assert.throws(() => readFileSync(join(h, "hud", "hermes-hermes-ses_hud.json"), "utf8"), "a stale hermes snapshot prunes once its process is proven reused");
});
