// T448: skill links for every CLI skills directory that already exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/doctor.ts";
import { runSetup, skillDest, type SetupCtx } from "../src/setup.ts";

const ctxFor = (home: string): SetupCtx => ({ home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false });
const linkWarns = async (home: string) => (await doctor(ctxFor(home), join(home, ".local/share/agentmbx")))
  .filter((c) => c.label.includes("skill not linked"))
  .map((c) => ({ label: c.label, fix: c.fix }));

test("setup links only skills directories that already exist, and doctor names just those", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-skill-"));
  try {
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    mkdirSync(join(home, ".codex/skills"), { recursive: true });
    const absent = [".hermes", ".grok", ".kimi-code", ".kimi", ".config/opencode"];
    const before = await linkWarns(home);
    assert.deepEqual(before.map((c) => c.label).sort(), [
      "claude: skill not linked at ~/.claude/skills/agentmbx",
      "codex: skill not linked at ~/.codex/skills/agentmbx",
    ].sort());
    assert.ok(before.every((c) => c.fix === "agentmbx setup --only skill"));

    const dry = runSetup(ctxFor(home), { mode: "install", only: ["skill"], dryRun: true });
    assert.ok(dry.some((r) => r.action === "added" && r.path === join(home, ".claude/skills/agentmbx")));
    assert.ok(!existsSync(join(home, ".claude/skills/agentmbx")));
    for (const rel of absent) assert.ok(!existsSync(join(home, rel)), `${rel} was created`);

    const rows = runSetup(ctxFor(home), { mode: "install", only: ["skill"] });
    for (const rel of [".claude/skills/agentmbx", ".codex/skills/agentmbx"]) {
      assert.equal(readlinkSync(join(home, rel)), skillDest(home));
      assert.equal(rows.find((r) => r.path === join(home, rel))?.action, "added");
    }
    for (const rel of absent) assert.ok(!existsSync(join(home, rel)), `${rel} was created`);
    assert.deepEqual(await linkWarns(home), []);

    const again = runSetup(ctxFor(home), { mode: "install", only: ["skill"] });
    assert.ok(again.filter((r) => r.item === "symlink").every((r) => r.action === "unchanged"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a correct link is unchanged, a foreign occupant is skipped, and uninstall removes only our symlinks", async () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-skill-"));
  const dest = skillDest(home);
  const at = (rel: string) => join(home, rel);
  try {
    for (const rel of [".claude/skills", ".codex/skills", ".hermes/skills", ".config/opencode/skills", ".kimi-code/skills", ".grok/skills", ".kimi/skills"])
      mkdirSync(at(rel), { recursive: true });
    symlinkSync(dest, at(".hermes/skills/agentmbx"));
    const hermesIno = lstatSync(at(".hermes/skills/agentmbx")).ino;
    symlinkSync("/tmp/not-the-skill", at(".codex/skills/agentmbx"));
    mkdirSync(at(".claude/skills/agentmbx"));
    writeFileSync(at(".claude/skills/agentmbx/KEEP"), "keep");
    symlinkSync("../../.agents/skills/agentmbx", at(".grok/skills/agentmbx"));
    mkdirSync(at(".config/opencode/skills/other"));
    writeFileSync(at(".config/opencode/skills/other/SKILL.md"), "sibling");
    writeFileSync(at(".kimi/skills/sentinel.txt"), "moonshot");

    const rows = runSetup(ctxFor(home), { mode: "install", only: ["skill"] });
    const action = (rel: string) => rows.find((r) => r.item === "symlink" && r.path === at(rel))?.action;
    assert.equal(action(".hermes/skills/agentmbx"), "unchanged");
    assert.equal(lstatSync(at(".hermes/skills/agentmbx")).ino, hermesIno);
    assert.equal(readlinkSync(at(".hermes/skills/agentmbx")), dest);
    assert.equal(action(".codex/skills/agentmbx"), "skipped");
    assert.equal(readlinkSync(at(".codex/skills/agentmbx")), "/tmp/not-the-skill");
    assert.equal(action(".claude/skills/agentmbx"), "skipped");
    assert.equal(readFileSync(at(".claude/skills/agentmbx/KEEP"), "utf8"), "keep");
    assert.equal(action(".grok/skills/agentmbx"), "skipped");
    assert.equal(readlinkSync(at(".grok/skills/agentmbx")), "../../.agents/skills/agentmbx");
    assert.equal(action(".config/opencode/skills/agentmbx"), "added");
    assert.equal(action(".kimi-code/skills/agentmbx"), "added");
    assert.equal(readlinkSync(at(".config/opencode/skills/agentmbx")), dest);
    assert.equal(readlinkSync(at(".kimi-code/skills/agentmbx")), dest);
    assert.ok(!existsSync(at(".kimi/skills/agentmbx")));

    const warns = await linkWarns(home);
    assert.deepEqual(warns.map((c) => c.label).sort(), [
      "claude: skill not linked at ~/.claude/skills/agentmbx",
      "codex: skill not linked at ~/.codex/skills/agentmbx",
      "grok: skill not linked at ~/.grok/skills/agentmbx",
    ].sort());
    assert.ok(warns.every((c) => c.fix === "agentmbx setup --only skill"));
    assert.ok(!warns.some((c) => /^(hermes|opencode|kimi):/.test(c.label)));

    const removed = runSetup(ctxFor(home), { mode: "uninstall", only: ["skill"] }).filter((r) => r.item === "symlink" && r.action === "removed");
    assert.deepEqual(removed.map((r) => r.path).sort(), [
      at(".hermes/skills/agentmbx"),
      at(".config/opencode/skills/agentmbx"),
      at(".kimi-code/skills/agentmbx"),
    ].sort());
    for (const rel of [".hermes/skills/agentmbx", ".config/opencode/skills/agentmbx", ".kimi-code/skills/agentmbx"])
      assert.ok(!existsSync(at(rel)));
    assert.equal(readFileSync(at(".claude/skills/agentmbx/KEEP"), "utf8"), "keep");
    assert.equal(readlinkSync(at(".codex/skills/agentmbx")), "/tmp/not-the-skill");
    assert.equal(readlinkSync(at(".grok/skills/agentmbx")), "../../.agents/skills/agentmbx");
    assert.equal(readFileSync(at(".config/opencode/skills/other/SKILL.md"), "utf8"), "sibling");
    assert.equal(readFileSync(at(".kimi/skills/sentinel.txt"), "utf8"), "moonshot");
    assert.ok(!existsSync(at(".kimi/skills/agentmbx")));
    assert.ok(!existsSync(dest));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
