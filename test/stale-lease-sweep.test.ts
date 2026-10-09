// T507: the daemon sweeps lease, mcp-process and identity-control rows whose recorded process died
// before running its cleanup. Positive death only (ESRCH or a reused pid's different start time);
// unknown evidence and live processes keep their rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode, staleMcpKvCensus, sweepStaleMcpKvRows } from "../src/node.ts";
import { deadHolderLeases, sweepDeadHolderLeases, UNKNOWN_PROCESS } from "../src/identity-leases.ts";
import { listIdentityControls, publishIdentityControl } from "../src/identity-control.ts";
import { staleRowCheck } from "../src/doctor.ts";
import { procStart } from "../src/proc.ts";

const DEAD_PID = 99_999_999; // ESRCH, nobody owns it
const OLD_PSUTC = "ps-utc:Wed Jan  1 00:00:00 2020"; // an old birth, provably not this process
const OLD_LSTART = "Wed Jan  1 00:00:00 2020"; // procStart's raw local-zone format of the same moment
const KEY_FP = "aaaa-bbbb-cccc-dddd";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mbx-t507-"));
  const node = new MbxNode(home, { host: "alpha", port: 1 });
  const insertLease = (name: string, pid: number, start: string, heartbeatAt = Date.now()) =>
    node.store.db.prepare(`INSERT INTO identity_leases (name,token,holder_pid,holder_start,key_fp,cli,session_id,claimed_at,heartbeat_at,idle_ttl,released_at,release_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(name, `tok-${name}`, pid, start, KEY_FP, "kimi", `sess-${name}`, Date.now(), heartbeatAt, 1_800_000);
  const descriptor = (mcpPid: number, mcpStart: string, sessionId = `s-${mcpPid}`) => ({
    v: 1 as const, cli: "kimi", session_id: sessionId, lease_session_id: sessionId, control_key: `ck-${sessionId}`,
    mcp_pid: mcpPid, mcp_start: mcpStart, parent_pid: mcpPid, parent_start: mcpStart, agent: "", generation: null,
  });
  return { home, node, insertLease, descriptor, done: () => { node.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("T507: a dead holder's lease is released as dead, and the sweep is idempotent", () => {
  const f = fixture();
  try {
    f.insertLease("dead-agent", DEAD_PID, OLD_PSUTC);
    const released = sweepDeadHolderLeases(f.node.store, { now: 1_700_000_000_000 });
    assert.deepEqual(released, [{ name: "dead-agent", reason: "dead" }]);
    const row = f.node.store.db.prepare("SELECT released_at,release_reason FROM identity_leases WHERE name=?").get("dead-agent") as { released_at: number; release_reason: string };
    assert.equal(row.released_at, 1_700_000_000_000);
    assert.equal(row.release_reason, "dead");
    assert.deepEqual(sweepDeadHolderLeases(f.node.store), [], "already released: nothing more to sweep");
  } finally { f.done(); }
});

test("T507: a live process's lease is never swept, even when idle past its TTL", () => {
  const f = fixture();
  try {
    f.insertLease("live-agent", process.pid, procStart(process.pid)!, Date.now() - 10 * 1_800_000);
    assert.deepEqual(sweepDeadHolderLeases(f.node.store), []);
    const row = f.node.store.db.prepare("SELECT released_at FROM identity_leases WHERE name=?").get("live-agent") as { released_at: number | null };
    assert.equal(row.released_at, null);
  } finally { f.done(); }
});

test("T507: a recorded start time that differs from the live pid's start means pid reuse — released as pid-reused", () => {
  const f = fixture();
  try {
    f.insertLease("reused-agent", process.pid, OLD_PSUTC);
    assert.deepEqual(sweepDeadHolderLeases(f.node.store), [{ name: "reused-agent", reason: "pid-reused" }]);
  } finally { f.done(); }
});

test("T507: unknown process evidence keeps every row (fail closed)", () => {
  const f = fixture();
  try {
    f.insertLease("mystery-agent", DEAD_PID, OLD_PSUTC);
    const census = deadHolderLeases(f.node.store, { inspect: () => UNKNOWN_PROCESS });
    assert.equal(census.leases.length, 0);
    assert.equal(census.unknown, 1);
    assert.deepEqual(sweepDeadHolderLeases(f.node.store, { inspect: () => UNKNOWN_PROCESS }), []);
  } finally { f.done(); }
});

test("T507: mcp-process and identity-control rows of a dead MCP are swept; live and malformed rows stay", () => {
  const f = fixture();
  try {
    const liveStart = procStart(process.pid)!;
    f.node.store.set("mcp-process:dead-key", JSON.stringify({ pid: DEAD_PID, start: OLD_LSTART }));
    f.node.store.set("mcp-process:reused-key", JSON.stringify({ pid: process.pid, start: OLD_LSTART }));
    f.node.store.set("mcp-process:live-key", JSON.stringify({ pid: process.pid, start: liveStart }));
    f.node.store.set("mcp-process:malformed", "{not json");
    publishIdentityControl(f.node.store, f.descriptor(DEAD_PID, OLD_PSUTC));
    publishIdentityControl(f.node.store, f.descriptor(process.pid, liveStart, "live-session"));

    const census = staleMcpKvCensus(f.node.store);
    assert.deepEqual(census.mcpProcesses.sort(), ["mcp-process:dead-key", "mcp-process:reused-key"]);
    assert.deepEqual(census.identityControls, ["ck-s-99999999"]);

    const swept = sweepStaleMcpKvRows(f.node.store);
    assert.deepEqual(swept, { mcpProcesses: 2, identityControls: 1 });
    assert.equal(f.node.store.get("mcp-process:dead-key"), undefined);
    assert.equal(f.node.store.get("mcp-process:reused-key"), undefined);
    assert.ok(f.node.store.get("mcp-process:live-key"), "a live process's row stays");
    assert.ok(f.node.store.get("mcp-process:malformed"), "a malformed row is not proven dead");
    assert.deepEqual(listIdentityControls(f.node.store).map((d) => d.session_id), ["live-session"]);
    assert.deepEqual(staleMcpKvCensus(f.node.store), { mcpProcesses: [], identityControls: [] });
  } finally { f.done(); }
});

test("T507: node.sweepStaleRows sweeps leases and kv rows in one pass, and the doctor row reports the counts", () => {
  const f = fixture();
  try {
    f.insertLease("dead-agent", DEAD_PID, OLD_PSUTC);
    f.node.store.set("mcp-process:dead-key", JSON.stringify({ pid: DEAD_PID, start: OLD_LSTART }));

    let check = staleRowCheck(f.node);
    assert.equal(check.level, "warn");
    assert.match(check.label, /^stale rows of dead processes: 1 unreleased lease\(s\), 1 mcp-process, 0 identity-control$/);

    assert.deepEqual(f.node.sweepStaleRows(), { leases: 1, mcpProcesses: 1, identityControls: 0 });
    check = staleRowCheck(f.node);
    assert.equal(check.level, "ok");
    assert.match(check.label, /: 0 unreleased lease\(s\), 0 mcp-process, 0 identity-control$/);
    assert.equal(check.fix, undefined);
  } finally { f.done(); }
});
