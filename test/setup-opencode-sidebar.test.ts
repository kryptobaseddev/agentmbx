// T411/T486: setup wires the OpenCode sidebar plugin (the T409 packaged shape) and tolerates
// managed-version-header-only drift. Everything runs against a temp HOME — never the owner's
// real ~/.config/opencode (the standing rule from the 2026-10-07 incident).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { edits, headerOnlyDiff, opencodePluginSource, opencodeSidebarDir, opencodeTuiConfig, runSetup, versionOnlyPackageDiff, wired, type SetupCtx } from "../src/setup.ts";
import { opencodeSidebarPackageJson, opencodeSidebarSource, OPENCODE_SIDEBAR_MARKER } from "../src/opencode-sidebar.ts";
import { version } from "../src/version.ts";
import { parseJsonc, valueOf } from "../src/jsonc.ts";

const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-oc-sidebar-"));
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/opencode.jsonc"), `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
  return home;
};
const ctxFor = (home: string, cmd = ["/opt/bin/agentmbx"]): SetupCtx => ({ home, cmd, which: () => null, useClis: false });
const rd = (home: string, rel: string) => readFileSync(join(home, rel), "utf8");
const wf = (home: string, rel: string, body: string) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), body);
};

test("T411: install wires the sidebar package + tui.json registration; idempotent", () => {
  const home = fakeHome();
  const rows = runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: "S1" });
  const side = rows.filter((r) => r.cli === "opencode" && ["tui.json plugin registration", "packaged plugin package.json", "packaged plugin server.ts", "packaged plugin tui.ts"].includes(r.item));
  assert.ok(side.length >= 4, "four sidebar rows");
  assert.ok(side.every((r) => r.action === "added"), "all added");
  // The three files, with the managed marker, and the tui.json registration pointing at the dir.
  const dir = opencodeSidebarDir(home);
  for (const f of ["package.json", "server.ts", "tui.ts"]) assert.ok(existsSync(join(dir, f)), f);
  assert.ok(rd(home, ".config/opencode/plugins/agentmbx-sidebar/tui.ts").startsWith(OPENCODE_SIDEBAR_MARKER));
  const tui = JSON.parse(rd(home, ".config/opencode/tui.json"));
  assert.deepEqual(tui.plugin, [dir]);
  // The hooks plugin is still written too (separate edit, untouched by ours).
  assert.ok(existsSync(join(home, ".config/opencode/plugins/agentmbx.ts")));
  // Second run: nothing changes.
  const again = runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: "S2" });
  assert.ok(again.every((r) => r.action === "unchanged"), JSON.stringify(again));
  assert.equal(rd(home, ".config/opencode/plugins/agentmbx-sidebar/tui.ts"), opencodeSidebarSource(version()));
});

test("T411: tui.json keeps foreign entries, comments and formatting byte-for-byte; uninstall removes only ours", () => {
  const home = fakeHome();
  const foreign = `{
  // my own plugins
  "theme": "dark",
  "plugin": [
    "orca",
    /* inline */ "someone-elses"
  ]
}
`;
  wf(home, ".config/opencode/tui.json", foreign);
  wf(home, ".config/opencode/plugins/orca.ts", "// the user's own plugin\nexport default {};\n");
  const rows = runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: "S1" });
  const after = rd(home, ".config/opencode/tui.json");
  const parsed = valueOf(after, parseJsonc(after)) as { plugin: string[]; theme: string };
  assert.deepEqual(parsed.plugin, ["orca", "someone-elses", opencodeSidebarDir(home)], "ours appended last");
  assert.equal(parsed.theme, "dark", "other keys intact");
  assert.ok(after.includes("// my own plugins") && after.includes("/* inline */"), "comments preserved");
  // The hooks plugin is written by ITS edit and the sidebar edits never touch it; a foreign
  // plugin file beside ours is untouched by both install and uninstall.
  assert.equal(rd(home, ".config/opencode/plugins/agentmbx.ts"), opencodePluginSource(["/opt/bin/agentmbx"], version()), "hooks plugin exactly its own template");
  assert.equal(rd(home, ".config/opencode/plugins/orca.ts"), "// the user's own plugin\nexport default {};\n");
  // Uninstall (--only opencode legitimately removes the hooks plugin too — its own edit); ours
  // leaves only our entry, restoring the user's tui.json byte-for-byte, and never the foreign file.
  runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"], stamp: "U1" });
  assert.equal(rd(home, ".config/opencode/tui.json"), foreign, "byte-for-byte the user's file again");
  assert.ok(!existsSync(join(opencodeSidebarDir(home), "tui.ts")), "sidebar files removed");
  assert.equal(rd(home, ".config/opencode/plugins/orca.ts"), "// the user's own plugin\nexport default {};\n", "foreign plugin untouched");
});

test("T411: a tui.json we created disappears on uninstall; foreign files are never touched", () => {
  const home = fakeHome();
  runSetup(ctxFor(home), { mode: "install", only: ["opencode"], stamp: "S1" });
  runSetup(ctxFor(home), { mode: "uninstall", only: ["opencode"], stamp: "U1" });
  assert.ok(!existsSync(opencodeTuiConfig(home)), "our tui.json gone");
  // Foreign sidebar file: reported manual, left alone.
  const home2 = fakeHome();
  wf(home2, ".config/opencode/plugins/agentmbx-sidebar/tui.ts", "// someone else's plugin\nexport default {};\n");
  wf(home2, ".config/opencode/plugins/agentmbx-sidebar/package.json", JSON.stringify({ name: "not-ours" }));
  wf(home2, ".config/opencode/tui.json", JSON.stringify({ plugin: "not-an-array" }));
  const rows = runSetup(ctxFor(home2), { mode: "install", only: ["opencode"], stamp: "S1" });
  assert.equal(rd(home2, ".config/opencode/plugins/agentmbx-sidebar/tui.ts"), "// someone else's plugin\nexport default {};\n");
  assert.equal(JSON.parse(rd(home2, ".config/opencode/plugins/agentmbx-sidebar/package.json")).name, "not-ours");
  assert.equal(JSON.parse(rd(home2, ".config/opencode/tui.json")).plugin, "not-an-array");
  assert.ok(rows.some((r) => r.action === "manual" && r.path.endsWith("tui.ts")));
  assert.ok(rows.some((r) => r.action === "manual" && r.path.endsWith("package.json")));
  assert.ok(rows.some((r) => r.action === "manual" && r.path.endsWith("tui.json")));
});

test("T486: header-only differences are wired and never rewritten", () => {
  // Unit level: the helpers see a version-only change.
  const current = opencodePluginSource(["/opt/bin/agentmbx"], "9.9.9");
  const stale = opencodePluginSource(["/opt/bin/agentmbx"], "0.5.16");
  assert.ok(headerOnlyDiff(stale, current), "hooks: header-only detected");
  assert.ok(!headerOnlyDiff(stale.replace("hookReason", "hookReason2"), current), "a body change is a real diff");
  const pkgCurrent = opencodeSidebarPackageJson();
  const pkgStale = pkgCurrent.replace(`"version": "${JSON.parse(pkgCurrent).version}"`, '"version": "0.0.1"');
  assert.ok(versionOnlyPackageDiff(pkgStale, pkgCurrent), "package.json: version-only detected");
  assert.ok(!versionOnlyPackageDiff(JSON.stringify({ name: "agentmbx-sidebar", opencode: {} }), pkgCurrent), "missing fields are a real diff");
  // Edit level: wired() tolerates the stale header.
  const home = fakeHome();
  const ctx = ctxFor(home);
  const hooksEdit = edits(ctx, "opencode").find((e) => e.kind === "hooks")!;
  const tuiEdit = edits(ctx, "opencode").find((e) => e.path.endsWith("agentmbx-sidebar/tui.ts"))!;
  const pkgEdit = edits(ctx, "opencode").find((e) => e.path.endsWith("agentmbx-sidebar/package.json"))!;
  mkdirSync(join(home, ".config/opencode/plugins"), { recursive: true });
  writeFileSync(join(home, ".config/opencode/plugins/agentmbx.ts"), stale);
  mkdirSync(opencodeSidebarDir(home), { recursive: true });
  writeFileSync(join(opencodeSidebarDir(home), "tui.ts"), opencodeSidebarSource("0.5.16"));
  writeFileSync(join(opencodeSidebarDir(home), "package.json"), pkgStale);
  for (const e of [hooksEdit, tuiEdit, pkgEdit]) assert.ok(wired(e), `${e.path} wired despite stale header`);
  // Run level: setup rewrites nothing (all unchanged — so also no service restart, which the
  // runner only triggers on added/updated/removed rows).
  const rows = runSetup(ctx, { mode: "install", only: ["opencode"], stamp: "S1" });
  assert.ok(rows.filter((r) => ["agentmbx.ts", "tui.ts", "package.json"].some((f) => r.path.endsWith(f))).every((r) => r.action === "unchanged"), JSON.stringify(rows));
  assert.equal(rd(home, ".config/opencode/plugins/agentmbx.ts"), stale, "stale-header file byte-for-byte untouched");
  assert.ok(!existsSync(join(home, ".config/opencode/plugins/agentmbx.ts.bak-agentmbx-S1")), "no backup written");
  // A real (body) difference still rewrites.
  writeFileSync(join(opencodeSidebarDir(home), "tui.ts"), opencodeSidebarSource("0.5.16").replace("REFRESH_MS", "REFRESH"));
  const rows2 = runSetup(ctx, { mode: "install", only: ["opencode"], stamp: "S2" });
  assert.equal(rows2.find((r) => r.path.endsWith("tui.ts"))?.action, "updated");
  assert.equal(rd(home, ".config/opencode/plugins/agentmbx-sidebar/tui.ts"), opencodeSidebarSource(version()));
});

test("doctor: the sidebar edits report wired through the generic kinds loop", async () => {
  const home = fakeHome();
  const ctx = ctxFor(home);
  runSetup(ctx, { mode: "install", only: ["opencode"], stamp: "S1" });
  const side = edits(ctx, "opencode").filter((e) => e.kind === "sidebar");
  assert.equal(side.length, 4);
  assert.ok(side.every(wired), "all four sidebar edits wired (files present + registered in the TUI plugin list)");
  rmSync(join(opencodeSidebarDir(home), "tui.ts"));
  assert.ok(!side.every(wired), "a missing file is not wired");
});

