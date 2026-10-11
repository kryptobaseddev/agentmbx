// T488 hard prerequisite: run unchanged on macOS and Linux before endpoint exclusion is enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = pathToFileURL(resolve("src/proc.ts")).href;
const read = `import {stdioEndpoint} from ${JSON.stringify(moduleUrl)};`;
const report = `JSON.stringify({pid:process.pid,key:stdioEndpoint()})`;
const child = (body: string) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", read + body], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result;
};
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const supported = process.platform === "darwin" || process.platform === "linux";

test("distinct connections from one provider have different socket endpoints", { skip: !supported }, () => {
  const a = JSON.parse(child(`console.log(${report});`).stdout), b = JSON.parse(child(`console.log(${report});`).stdout);
  assert.ok(a.key); assert.ok(b.key); assert.notEqual(a.key, b.key);
});

test("inheriting the same stdio preserves the endpoint in a different process", { skip: !supported }, () => {
  const nested = read + `console.error(${report});`;
  const result = child(`import {spawnSync} from 'node:child_process';
    const before=${report};
    const nested=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(nested)}],{stdio:['inherit','inherit','pipe'],encoding:'utf8',timeout:3000});
    if(nested.status!==0)throw Error(nested.stderr);
    console.error(JSON.stringify({before:JSON.parse(before),after:JSON.parse(nested.stderr)}));`);
  const { before, after } = JSON.parse(result.stderr);
  assert.ok(before.key); assert.equal(after.key, before.key); assert.notEqual(after.pid, before.pid);
});

test("exec preserves PID and both stdio endpoints", { skip: !supported || typeof process.execve !== "function" }, () => {
  const after = read + `console.error(${report});`;
  const result = child(`console.error(${report}); process.execve(process.execPath,[process.execPath,'--input-type=module','-e',${JSON.stringify(after)}],{});`);
  const [before, replaced] = result.stderr.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(before.key); assert.deepEqual(replaced, before);
});

test("real shell pipes retain their kernel endpoint across inherited processes", { skip: !supported }, () => {
  const nested = read + `console.log(${report});`;
  const body = read + `import {spawnSync} from 'node:child_process';
    const before=${report}; const after=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(nested)}],{stdio:['inherit','inherit','pipe'],encoding:'utf8',timeout:3000});
    if(after.status!==0)throw Error(after.stderr); console.error(before);`;
  const result = spawnSync("sh", ["-c", `printf '' | ${q(process.execPath)} --input-type=module -e ${q(body)} | cat`], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const before = JSON.parse(result.stderr), inherited = JSON.parse(result.stdout);
  assert.ok(before.key); assert.equal(inherited.key, before.key); assert.notEqual(inherited.pid, before.pid);
});

test("non-pipe stdio is unknown, never a shared endpoint", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", read + `console.error(${report});`], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stderr).key, null);
});

test("an OS exec failure terminates the owned process instead of continuing to serve", { skip: !supported || typeof process.execve !== "function" }, () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `try {process.execve('/nonexistent-t488-owned-fixture/executable',['fixture'],{});} catch {console.log('still serving');} console.log('still serving');`], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.signal, "SIGABRT");
  assert.match(result.stderr, /execve failed.*ENOENT/);
  assert.doesNotMatch(result.stdout, /still serving/);
});
