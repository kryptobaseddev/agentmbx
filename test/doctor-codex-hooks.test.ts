import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexHooksChecks, doctor } from "../src/doctor.ts";
import { edits, type SetupCtx } from "../src/setup.ts";

const snapshot = (home: string) => readdirSync(home, { recursive: true, encoding: "utf8" }).map((rel) => {
  const path = join(home, rel), stat = statSync(path);
  return [rel, stat.mode, stat.isFile() ? readFileSync(path).toString("hex") : null];
});

function fixture(t: TestContext): SetupCtx {
  const home = mkdtempSync(join(tmpdir(), "mbx-doctor-codex-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ctx: SetupCtx = { home, cmd: ["agentmbx"], which: (bin) => bin === "codex" ? process.execPath : null, useClis: false };
  for (const edit of edits(ctx, "codex")) {
    mkdirSync(dirname(edit.path), { recursive: true });
    const content = edit.install(null);
    assert.ok(content !== null);
    writeFileSync(edit.path, content);
  }
  return ctx;
}

test("T186: doctor warns when wired Codex hooks are explicitly disabled, without changing provider state", async (t) => {
  const ctx = fixture(t), { home } = ctx;
  const config = join(home, ".codex", "config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[features]\nhooks = false\n");
  writeFileSync(join(home, ".codex", "hooks.state"), "owner trust state: leave untouched\n", { mode: 0o600 });
  const before = snapshot(home);

  const checks = await doctor(ctx, join(home, "mbx-data"), { peerTimeoutMs: 1 });

  assert.ok(checks.some((c) => c.level === "ok" && /^codex: hooks wired/.test(c.label)));
  const disabled = checks.find((c) => /^codex:.*features\.hooks=false/.test(c.label));
  assert.ok(disabled, "wiring alone must not hide disabled native hooks");
  assert.equal(disabled.level, "warn");
  assert.match(disabled.fix!, /mbx_whoami.*mbx_catchup/);
  assert.deepEqual(snapshot(home), before, "doctor must not write config, trust, approvals or mailbox state");
});

for (const [label, config] of [
  ["enabled", "[features]\nhooks = true\n"],
  ["unset", ""],
  ["a string rather than a boolean", '[features]\nhooks = "false"\n'],
  ["an unrelated setting", "[other]\nhooks = false\n"],
]) test(`T186: hooks ${label} never proves Codex runtime support or consent`, (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.home, ".codex", "config.toml"), config);
  const before = snapshot(ctx.home);

  const checks = codexHooksChecks(ctx);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "info");
  assert.match(checks[0].label, /native hook support and consent are unverified/);
  assert.match(checks[0].fix!, /normal trust prompts.*mbx_whoami.*mbx_catchup/);
  assert.deepEqual(snapshot(ctx.home), before, "missing trust state stays missing");
});

for (const invalid of ["malformed", "unreadable", "missing"]) test(`T186: ${invalid} Codex configuration warns without guessing hook support or consent`, (t) => {
  const ctx = fixture(t), config = join(ctx.home, ".codex", "config.toml");
  rmSync(config);
  if (invalid === "malformed") writeFileSync(config, "[features\nhooks = false\n");
  if (invalid === "unreadable") mkdirSync(config);
  const before = snapshot(ctx.home);

  const checks = codexHooksChecks(ctx);

  assert.equal(checks.length, 1);
  assert.equal(checks[0].level, "warn");
  assert.match(checks[0].label, /unreadable or invalid.*support and consent are unverified/);
  assert.match(checks[0].fix!, /mbx_whoami.*mbx_catchup/);
  assert.deepEqual(snapshot(ctx.home), before);
});

test("T186: unwired Codex hooks leave the generic wiring diagnostic in charge", (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.home, ".codex", "hooks.json"), "{}\n");
  assert.deepEqual(codexHooksChecks(ctx), []);
});
