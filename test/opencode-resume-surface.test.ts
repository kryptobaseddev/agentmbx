// T187: the OpenCode entry signal that works without a resume event, plus the doctor row that states the surface.
// OpenCode's plugin fires session.created only for a new conversation, so a reopened tab or a restarted serve is
// entered through the provider process generation instead: one notice per (conversation, serve generation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, opencodeResumeSurfaceChecks } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";
import { takeServeEntry } from "../src/resume-notice.ts";
import { runSetup, type SetupCtx } from "../src/setup.ts";

const ctxFor = (home: string): SetupCtx => ({ home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false });

test("T187: takeServeEntry is once per conversation and serve generation", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t187-entry-"));
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const s = n.store, START = "ps-utc:Thu Oct 15 13:55:50 2026";
  assert.equal(takeServeEntry(s, "opencode", "ses_a", 100, START), true, "the first entry into this conversation");
  assert.equal(takeServeEntry(s, "opencode", "ses_a", 100, START), false, "the same serve generation again");
  assert.equal(takeServeEntry(s, "opencode", "ses_a", 100, "ps-utc:Thu Oct 15 14:30:00 2026"), true, "a respawned pid with a new birth");
  assert.equal(takeServeEntry(s, "opencode", "ses_a", 200, START), true, "a different serve process (a reopened tab)");
  assert.equal(takeServeEntry(s, "opencode", "ses_b", 100, START), true, "another conversation of the same serve");
  assert.equal(takeServeEntry(s, "claude", "ses_a", 100, START), true, "another harness is its own key");
  assert.equal(takeServeEntry(s, "opencode", "ses_a", 200, START), false, "and each of them is only once");
  assert.equal(s.get("resume-serve:opencode:ses_a"), `200 ${START}`);
});

test("T187: the doctor row states the missing resume surface and the fallback, as info that cannot fail doctor", async (t) => {
  const rows = opencodeResumeSurfaceChecks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "info");
  assert.match(rows[0].label, /^opencode: no native resume\/re-attach event \(session\.created fires only for a new conversation\)/);
  assert.match(rows[0].label, /once per serve generation/);
  assert.match(rows[0].label, /mbx_whoami \/ mbx_inbox$/);
  assert.equal(rows[0].fix, undefined);
  const h = mkdtempSync(join(tmpdir(), "mbx-t187-doctor-")), mbx = join(h, ".local/share/agentmbx");
  t.after(() => rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  new MbxNode(mbx, { host: "alpha", port: 1 }).close(); // nothing listens on port 1
  mkdirSync(join(h, ".config/opencode"), { recursive: true });
  writeFileSync(join(h, ".config/opencode/opencode.jsonc"), "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n");
  runSetup(ctxFor(h), { mode: "install" });
  const after = await doctor(ctxFor(h), mbx);
  const row = after.find(c => /^opencode: no native resume\/re-attach event/.test(c.label));
  assert.ok(row, `the row is part of a full doctor run: ${JSON.stringify(after.filter(c => /opencode:/.test(c.label)))}`);
  assert.equal(row.level, "info", "a harness fact, not a broken install");
});
