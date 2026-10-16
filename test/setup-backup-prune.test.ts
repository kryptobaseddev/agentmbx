// T671: AgentMBX's own pre-edit images accumulate one per release (each setup run writes a new
// `<file>.bak-agentmbx-<stamp>` and nothing removes the old ones). Pruning keeps the newest per file, only ever touches
// names we wrote, and runs both when a backup is written and for the OpenCode sidebar package on every install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKUP_KEEP, pruneAgentmbxBackups, pruneSidebarBackups, runSetup, opencodeSidebarDir, type SetupCtx } from "../src/setup.ts";
import { opencodeSidebarSource, OPENCODE_SIDEBAR_MARKER } from "../src/opencode-sidebar.ts";
import { version } from "../src/version.ts";

const homeOf = () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-bak-"));
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
  return home;
};
const ctxFor = (home: string): SetupCtx => ({ home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false });
const put = (home: string, rel: string, body: string) => { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), body); };
const backupsOf = (dir: string, base: string) => readdirSync(dir).filter((n) => n.startsWith(`${base}.bak-agentmbx-`)).sort();
/** Five stamps in time order, as `agentmbx setup` writes them (YYYYMMDD-HHMMSS). */
const STAMPS = ["20261010-220333", "20261011-084250", "20261013-013022", "20261015-064245", "20261016-000000"];

test("T671: pruning keeps the newest two of our own backups per file and touches nothing else", (t) => {
  const home = homeOf();
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dir = join(home, "cfg"), live = join(dir, "tui.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(live, "live file\n");
  for (const s of STAMPS) writeFileSync(`${live}.bak-agentmbx-${s}`, `old ${s}\n`);
  writeFileSync(join(dir, "tui.ts.bak-t410"), "someone else's name\n");
  writeFileSync(join(dir, "notes.md"), "not a backup\n");
  const removed = pruneAgentmbxBackups(live);
  assert.deepEqual(removed.map((p) => p.slice(dir.length + 1)), [`tui.ts.bak-agentmbx-${STAMPS[2]}`, `tui.ts.bak-agentmbx-${STAMPS[1]}`, `tui.ts.bak-agentmbx-${STAMPS[0]}`], "oldest first, oldest dropped");
  assert.deepEqual(backupsOf(dir, "tui.ts"), [`tui.ts.bak-agentmbx-${STAMPS[3]}`, `tui.ts.bak-agentmbx-${STAMPS[4]}`], "the newest two survive");
  assert.equal(BACKUP_KEEP, 2);
  assert.equal(readFileSync(live, "utf8"), "live file\n", "the live file is never touched");
  assert.equal(readFileSync(join(dir, "tui.ts.bak-t410"), "utf8"), "someone else's name\n", "a foreign backup name is left alone");
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "not a backup\n");
  assert.deepEqual(pruneAgentmbxBackups(live), [], "nothing left to prune");
  assert.deepEqual(pruneAgentmbxBackups(join(dir, "never-written.ts")), [], "no backups, no work");
});

test("T671: sidebar pruning is per file and ignores foreign backup names", (t) => {
  const home = homeOf();
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dir = opencodeSidebarDir(home);
  mkdirSync(dir, { recursive: true });
  for (const s of STAMPS.slice(0, 4)) writeFileSync(join(dir, `tui.ts.bak-agentmbx-${s}`), `tui ${s}\n`);
  writeFileSync(join(dir, `status-schema.ts.bak-agentmbx-${STAMPS[0]}`), "schema\n");
  writeFileSync(join(dir, "tui.ts.bak-t410-before-close-20261010"), "foreign\n");
  writeFileSync(join(dir, "tui.ts"), "live\n");
  const removed = pruneSidebarBackups(home);
  assert.deepEqual(removed.map((p) => p.slice(dir.length + 1)).sort(), [`tui.ts.bak-agentmbx-${STAMPS[0]}`, `tui.ts.bak-agentmbx-${STAMPS[1]}`]);
  assert.deepEqual(backupsOf(dir, "tui.ts"), [`tui.ts.bak-agentmbx-${STAMPS[2]}`, `tui.ts.bak-agentmbx-${STAMPS[3]}`], "newest two per file");
  assert.deepEqual(backupsOf(dir, "status-schema.ts"), [`status-schema.ts.bak-agentmbx-${STAMPS[0]}`], "one backup is already within the bound");
  assert.equal(readFileSync(join(dir, "tui.ts.bak-t410-before-close-20261010"), "utf8"), "foreign\n");
  assert.equal(readFileSync(join(dir, "tui.ts"), "utf8"), "live\n");
});

test("T671: a setup install prunes the sidebar backups it inherits, without needing a rewrite", (t) => {
  const home = homeOf();
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: STAMPS[0] });
  const dir = opencodeSidebarDir(home);
  assert.deepEqual(backupsOf(dir, "tui.ts"), [], "a first install adds files; there is nothing to back up");
  for (const s of STAMPS.slice(1, 4)) writeFileSync(join(dir, `tui.ts.bak-agentmbx-${s}`), `stale ${s}\n`);
  writeFileSync(join(dir, "tui.ts.bak-t410"), "foreign\n");
  assert.equal(backupsOf(dir, "tui.ts").length, 3);
  const before = readFileSync(join(dir, "tui.ts"), "utf8");
  runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: STAMPS[4] });
  assert.equal(readFileSync(join(dir, "tui.ts"), "utf8"), before, "the managed file was already current and is unchanged");
  assert.deepEqual(backupsOf(dir, "tui.ts"), [`tui.ts.bak-agentmbx-${STAMPS[2]}`, `tui.ts.bak-agentmbx-${STAMPS[3]}`], "the oldest two are gone");
  assert.equal(readFileSync(join(dir, "tui.ts.bak-t410"), "utf8"), "foreign\n", "a foreign name survives the sweep");
});

test("T671: writing a new backup keeps the bound too, and a dry run changes nothing", (t) => {
  const home = homeOf();
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: STAMPS[0] });
  const dir = opencodeSidebarDir(home), live = join(dir, "tui.ts");
  // Make the file ours but stale, so the next install rewrites it and writes a backup of the previous bytes.
  writeFileSync(live, `${OPENCODE_SIDEBAR_MARKER}\n// an older body\n`);
  for (const s of STAMPS.slice(1, 4)) writeFileSync(`${live}.bak-agentmbx-${s}`, `stale ${s}\n`);
  const rows = runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: STAMPS[4] });
  const row = rows.find((r) => r.item === "packaged plugin tui.ts");
  assert.equal(row?.action, "updated");
  assert.equal(readFileSync(live, "utf8"), opencodeSidebarSource(version()), "the managed file is current again");
  assert.deepEqual(backupsOf(dir, "tui.ts"), [`tui.ts.bak-agentmbx-${STAMPS[3]}`, `tui.ts.bak-agentmbx-${STAMPS[4]}`], "the new image plus the previous newest");
  // A dry run never prunes: pre-seed an extra old name, then dry-run and look.
  writeFileSync(`${live}.bak-agentmbx-${STAMPS[0]}`, "old\n");
  runSetup(ctxFor(home), { mode: "install", only: ["opencode"], dryRun: true, stamp: STAMPS[0] });
  assert.equal(backupsOf(dir, "tui.ts").length, 3, "dry run leaves the directory alone");
  assert.equal(readFileSync(`${live}.bak-agentmbx-${STAMPS[0]}`, "utf8"), "old\n");
});
