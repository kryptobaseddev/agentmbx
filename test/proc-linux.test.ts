import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { procTable, provenProcess, _resetProcCache } from "../src/proc.ts";
import { inspectLeaseProcess } from "../src/identity-leases.ts";

test("Linux session and lease process proof works without ps and agrees on kernel birth identity", { skip: process.platform !== "linux" }, () => {
  const path = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent-agentmbx-test"; _resetProcCache();
    const own = procTable(0).get(process.pid);
    assert.ok(own); assert.equal(own.ppid, process.ppid);
    assert.match(own.start, /^linux:[a-f0-9-]{36}:\d+$/);
    assert.equal(provenProcess(process.pid, own.start), true);
    assert.equal(provenProcess(process.pid, "different-birth"), false);
    assert.deepEqual(inspectLeaseProcess(process.pid), { alive: true, start: own.start });
  } finally { process.env.PATH = path; _resetProcCache(); }
});

test("Linux process names with parentheses cannot shift birth or parent fields", { skip: process.platform !== "linux" }, () => {
  const script = `import { readLinuxProcess } from ${JSON.stringify(new URL("../src/proc.ts", import.meta.url).href)};
    const before=readLinuxProcess(process.pid); process.title='agent ) mbx (';
    console.log(JSON.stringify({before,after:readLinuxProcess(process.pid),ppid:process.ppid}));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.ok(result.before); assert.deepEqual(result.after, result.before); assert.equal(result.after.ppid, result.ppid);
});
