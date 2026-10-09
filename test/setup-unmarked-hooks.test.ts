import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { edits, runSetup, wired, type SetupCtx } from "../src/setup.ts";
import { doctor } from "../src/doctor.ts";

const pairs = [["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"], ["PermissionRequest", "permission"], ["Stop", "stop"]];
const kimiHooks = (ps = pairs) => ps.map(([event, sub]) => `[[hooks]]\nevent = "${event}"\ncommand = "agentmbx hook ${sub} --cli kimi"\ntimeout = 10\n`).join("\n");
const foreign = '# user hook\n[[hooks]]\nevent = "Stop"\ncommand = "echo agentmbx hook stop --cli kimi"\ntimeout = 7\n';
const count = (text: string, event: string, sub: string) => {
  const hooks = parse(text).hooks as { event: string; command: string }[];
  return hooks.filter(h => h.event === event && /^(?:agentmbx|\/opt\/bin\/agentmbx) hook /.test(h.command) && h.command.endsWith(` hook ${sub} --cli kimi`)).length;
};

for (const [name, text] of [
  ["unmarked", kimiHooks()],
  ["lost opening marker with CRLF", (kimiHooks() + "# <<< agentmbx <<<\n").replaceAll("\n", "\r\n")],
  ["partial unmarked hooks", kimiHooks(pairs.slice(0, 2))],
] as const) test(`Kimi ${name}: doctor recognizes existing hooks and setup never duplicates them`, async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t479-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, ".kimi-code/config.toml"); mkdirSync(dirname(path), { recursive: true });
  const before = foreign + text; writeFileSync(path, before);
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false };
  const hook = edits(ctx, "kimi").find(e => e.kind === "hooks")!;
  const complete = name !== "partial unmarked hooks";
  assert.equal(wired(hook), complete);
  if (complete) assert.ok((await doctor(ctx, join(home, "mbx"))).some(c => c.level === "ok" && c.label.startsWith("kimi: hooks wired")));
  runSetup(ctx, { mode: "install", only: ["kimi"], stamp: "first" });
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(before), "all existing config bytes survive");
  if (complete) assert.equal(after, before, "complete unmarked hooks are left alone");
  for (const [ev, sub] of pairs) assert.equal(count(after, ev, sub), 1, ev);
  assert.ok(wired(hook));
  runSetup(ctx, { mode: "install", only: ["kimi"], stamp: "again" });
  assert.equal(readFileSync(path, "utf8"), after);
});

test("Kimi comment-only commands and composed foreign hooks do not satisfy wiring", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t479-foreign-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, ".kimi-code/config.toml"); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, foreign + "# agentmbx hook session-start --cli kimi\n");
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false };
  assert.equal(wired(edits(ctx, "kimi").find(e => e.kind === "hooks")!), false);
  runSetup(ctx, { mode: "install", only: ["kimi"], stamp: "install" });
  const after = readFileSync(path, "utf8"); assert.ok(after.startsWith(foreign));
  for (const [ev, sub] of pairs) assert.equal(count(after, ev, sub), 1);
});

test("Hermes unmarked hooks are wired, preserved and not duplicated; missing hooks are restored once", async t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t479-hermes-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, ".hermes/config.yaml"); mkdirSync(dirname(path), { recursive: true });
  const ctx: SetupCtx = { home, cmd: ["/opt/bin/agentmbx"], which: () => null, useClis: false };
  const hook = edits(ctx, "hermes").find(e => e.kind === "hooks")!;
  const before = `model:\n  default: fake\nhooks:\n  on_session_start:\n    - command: "/opt/bin/agentmbx hook session-start --cli hermes"\n      timeout: 10\n  pre_llm_call:\n    - command: "/opt/bin/agentmbx hook prompt --cli hermes"\n      timeout: 10\n    - command: "echo user-hook"\n      timeout: 5\n`;
  writeFileSync(path, before); assert.ok(wired(hook));
  assert.ok((await doctor(ctx, join(home, "mbx"))).some(c => c.level === "ok" && c.label.startsWith("hermes: hooks wired")));
  for (const stamp of ["one", "two"]) runSetup(ctx, { mode: "install", only: ["hermes"], stamp });
  let after = readFileSync(path, "utf8"); assert.equal((after.match(/agentmbx hook /g) ?? []).length, 2); assert.ok(after.includes(before));
  // The incident also lost Hermes hooks entirely; setup restores just the required pairs.
  writeFileSync(path, "model:\n  default: fake\n"); assert.equal(wired(hook), false);
  for (const stamp of ["restore", "rerun"]) runSetup(ctx, { mode: "install", only: ["hermes"], stamp });
  after = readFileSync(path, "utf8"); assert.equal((after.match(/agentmbx hook /g) ?? []).length, 2); assert.ok(wired(hook));
});
