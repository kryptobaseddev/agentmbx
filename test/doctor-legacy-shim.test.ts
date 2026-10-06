import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { doctor, legacyMbxShim } from "../src/doctor.ts";

/** Write a script and set its mode after create, so umask cannot strip the execute bit. */
function place(dir: string, name: string, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho hi\n");
  chmodSync(path, mode);
  return path;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mbx-legacy-shim-"));
}

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

test("legacy mbx ahead of agentmbx is a warning with a rename fix (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "early");
  const late = join(root, "late");
  mkdirSync(early);
  mkdirSync(late);
  const mbx = place(early, "mbx", 0o755);
  place(late, "agentmbx", 0o755);
  const check = legacyMbxShim(`${early}${delimiter}${late}`);
  assert.ok(check);
  assert.equal(check.level, "warn");
  assert.equal(check.label, `legacy mbx shim is ahead of agentmbx on PATH (${mbx})`);
  assert.equal(check.fix, `mv ${quote(mbx)} ${quote(`${mbx}.legacy`)}`);
});

test("a legacy path with a space and a quote is single-quoted in the fix (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "it is 'odd'");
  mkdirSync(early);
  const mbx = place(early, "mbx", 0o755);
  const check = legacyMbxShim(early);
  assert.ok(check);
  assert.equal(check.level, "warn");
  assert.equal(check.fix, `mv ${quote(mbx)} ${quote(`${mbx}.legacy`)}`);
  // Hand-written POSIX quoting, not the helper above: end-quote, escaped quote, start-quote.
  assert.ok(check.fix?.includes("it is '\\''odd'\\''/mbx'"));
  assert.ok(check.fix?.includes("it is '\\''odd'\\''/mbx.legacy'"));
});

test("agentmbx earlier on PATH is not flagged (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "early");
  const late = join(root, "late");
  mkdirSync(early);
  mkdirSync(late);
  place(early, "agentmbx", 0o755);
  place(late, "mbx", 0o755);
  assert.equal(legacyMbxShim(`${early}${delimiter}${late}`), null);
});

test("mbx that is a symlink to agentmbx is not a foreign binary (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "early");
  const late = join(root, "late");
  mkdirSync(early);
  mkdirSync(late);
  const agent = place(late, "agentmbx", 0o755);
  symlinkSync(agent, join(early, "mbx"));
  assert.equal(legacyMbxShim(`${early}${delimiter}${late}`), null);
});

test("no mbx on PATH is not flagged (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "bin");
  mkdirSync(dir);
  place(dir, "agentmbx", 0o755);
  assert.equal(legacyMbxShim(""), null);
  assert.equal(legacyMbxShim(delimiter), null);
  assert.equal(legacyMbxShim(dir), null);
});

test("mbx with no agentmbx anywhere is flagged (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "bin");
  mkdirSync(dir);
  const mbx = place(dir, "mbx", 0o755);
  const check = legacyMbxShim(dir);
  assert.equal(check?.level, "warn");
  assert.equal(check?.label, `legacy mbx shim is ahead of agentmbx on PATH (${mbx})`);
});

test("mbx beside agentmbx in the same directory is not ahead (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "bin");
  mkdirSync(dir);
  place(dir, "mbx", 0o755);
  place(dir, "agentmbx", 0o755);
  assert.equal(legacyMbxShim(dir), null);
});

test("a non-executable or directory named mbx is ignored (T314)", (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const mid = join(root, "mid");
  const last = join(root, "last");
  mkdirSync(first);
  mkdirSync(mid);
  mkdirSync(last);
  mkdirSync(join(first, "mbx"));
  place(mid, "mbx", 0o644);
  place(mid, "agentmbx", 0o755);
  place(last, "mbx", 0o755);
  assert.equal(legacyMbxShim(`${first}${delimiter}${mid}${delimiter}${last}`), null);
});

test("doctor reports the legacy shim and that warning is not a failure (T314)", async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "early");
  const late = join(root, "late");
  const home = join(root, "home");
  mkdirSync(early);
  mkdirSync(late);
  mkdirSync(home);
  const mbx = place(early, "mbx", 0o755);
  place(late, "agentmbx", 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${early}${delimiter}${late}`;
  try {
    const checks = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, join(home, "mbx-data"));
    const hit = checks.filter((c) => c.label.includes("legacy mbx"));
    assert.equal(hit.length, 1);
    assert.equal(hit[0]?.level, "warn");
    assert.equal(hit[0]?.label, `legacy mbx shim is ahead of agentmbx on PATH (${mbx})`);
    assert.equal(hit[0]?.fix, `mv ${quote(mbx)} ${quote(`${mbx}.legacy`)}`);
    assert.equal(checks.some((c) => c.level === "fail" && c.label.includes("legacy mbx")), false);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
});

test("doctor stays quiet when agentmbx comes first (T314)", async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, "early");
  const late = join(root, "late");
  const home = join(root, "home");
  mkdirSync(early);
  mkdirSync(late);
  mkdirSync(home);
  place(early, "agentmbx", 0o755);
  place(late, "mbx", 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${early}${delimiter}${late}`;
  try {
    const checks = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, join(home, "mbx-data"));
    assert.equal(checks.some((c) => c.label.includes("legacy mbx")), false);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
});
