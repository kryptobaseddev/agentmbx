// T522: overlapping assistant turns on one bound OpenCode session are an audit row and a doctor warn.
// The OpenCode database is a temp file. Nothing here opens the owner's opencode.db.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MbxNode } from "../src/node.ts";
import { failed } from "../src/doctor.ts";
import { armConversationLoopReports } from "../src/loop-detector.ts";
import { opencodePluginSource } from "../src/setup.ts";
import { version } from "../src/version.ts";
import {
  auditOpencodeDuplicateLoops, findOpencodeDuplicateLoops, opencodeDuplicateLoopChecks, overlappingTurns,
  OPENCODE_OVERLAP_WINDOW_MS, type AssistantTurn,
} from "../src/opencode-duplicate-loop.ts";

function turn(id: string, created: number, completed: number, snapshot = true): AssistantTurn {
  return { id, created, completed, snapshot };
}

test("overlapping turns are pairs whose ranges cross, not ones that only touch", () => {
  assert.deepEqual(overlappingTurns([turn("a", 0, 10), turn("b", 10, 20)]), []);
  const pairs = overlappingTurns([turn("a", 0, 10), turn("b", 5, 15), turn("c", 14, 16)]);
  assert.deepEqual(pairs.map(([a, b]) => [a.id, b.id]), [["a", "b"], ["b", "c"]]);
});

function writeDb(path: string, rows: Array<{ id: string; session: string; created: number; completed: number; snapshot?: boolean; raw?: string }>): void {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)`);
  const ins = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)");
  rows.forEach((row, i) => {
    const data = row.raw ?? JSON.stringify({
      time: { created: row.created, completed: row.completed },
      snapshot: row.snapshot === false ? {} : { start: "a".repeat(40), end: "b".repeat(40) },
    });
    ins.run(row.id, row.session, i, row.created, row.completed, data);
  });
  db.close();
}

function bind(node: MbxNode, sessionId: string, agent = "agentmbx-opencode"): void {
  node.store.db.prepare("INSERT INTO sessions (agent, cli, session_id, channel, updated_at) VALUES (?, 'opencode', ?, 0, ?)")
    .run(agent, sessionId, new Date().toISOString());
}

function audits(node: MbxNode): Array<{ event: string; detail: string }> {
  return node.store.db.prepare("SELECT event, detail FROM audit WHERE event = 'opencode.duplicate_loop' ORDER BY at").all() as Array<{ event: string; detail: string }>;
}

test("T522: the daemon audits a new overlap once, and doctor warns without failing", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t522-"));
  const dbPath = join(home, "opencode.db");
  const node = new MbxNode(home, { host: "alpha" });
  const options = { dbPath, now: 4_000 };
  try {
    writeDb(dbPath, [
      { id: "msg_a", session: "ses_bound", created: 1_000, completed: 2_000 },
      { id: "msg_b", session: "ses_bound", created: 1_500, completed: 2_500 },
      { id: "msg_other", session: "ses_unbound", created: 1_000, completed: 2_000 },
      { id: "msg_other2", session: "ses_unbound", created: 1_100, completed: 1_800 },
      { id: "msg_bad", session: "ses_bound", created: 0, completed: 0, raw: "{" },
    ]);
    bind(node, "ses_bound");
    bind(node, "mcp-not-a-session");
    assert.equal(findOpencodeDuplicateLoops(node, { dbPath: join(home, "missing.db") }).length, 0);

    const found = auditOpencodeDuplicateLoops(node, options);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.session_id, "ses_bound");
    assert.equal(found[0]!.pairs, 1);
    assert.equal(found[0]!.snapshots, true);
    assert.deepEqual(found[0]!.messages, ["msg_a", "msg_b"]);
    const rows = audits(node);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0]!.detail) as { session_id: string; snapshots: boolean; pairs: number };
    assert.equal(detail.session_id, "ses_bound");
    assert.equal(detail.snapshots, true);
    assert.equal(detail.pairs, 1);

    auditOpencodeDuplicateLoops(node, options);
    assert.equal(audits(node).length, 1, "the same overlap is one audit row");

    const checks = opencodeDuplicateLoopChecks(node, options);
    assert.equal(checks.length, 2);
    const warning = checks.find(c => c.level === "warn")!;
    assert.match(warning.label, /overlapping assistant messages began within the last hour on bound session ses_bound/);
    assert.match(warning.label, /with snapshots/);
    assert.doesNotMatch(warning.fix!, /two OpenCode processes|stop the extra serve/);
    assert.match(warning.fix!, /Do not stop a serve based on this check alone/);
    assert.equal(failed(checks), false);

    writeDb(dbPath, [
      { id: "msg_a", session: "ses_bound", created: 1_000, completed: 2_000 },
      { id: "msg_b", session: "ses_bound", created: 1_500, completed: 2_500 },
      { id: "msg_c", session: "ses_bound", created: 2_200, completed: 3_000 },
    ]);
    auditOpencodeDuplicateLoops(node, options);
    assert.equal(audits(node).length, 2, "a new overlapping turn writes another row");
  } finally {
    node.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("T522: a session whose turns only meet at an endpoint writes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t522-clean-"));
  const dbPath = join(home, "opencode.db");
  const node = new MbxNode(home, { host: "alpha" });
  try {
    writeDb(dbPath, [
      { id: "msg_a", session: "ses_clean", created: 1_000, completed: 2_000, snapshot: false },
      { id: "msg_b", session: "ses_clean", created: 2_000, completed: 3_000, snapshot: false },
    ]);
    bind(node, "ses_clean");
    assert.deepEqual(auditOpencodeDuplicateLoops(node, { dbPath }), []);
    assert.equal(audits(node).length, 0);
    const checks = opencodeDuplicateLoopChecks(node, { dbPath, now: 4000 });
    assert.ok(checks.every(c => c.level === "info"));
    assert.match(checks[0]!.label, /older overlaps are historical/);
  } finally {
    node.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("T561: real completed historical overlaps and old interrupted messages do not warn", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-overlap-history-")), path = join(home, "opencode.db");
  const node = new MbxNode(home, { host: "scratch" });
  const now = 10 * OPENCODE_OVERLAP_WINDOW_MS;
  try {
    bind(node, "ses_history");
    writeDb(path, [
      { id: "old-a", session: "ses_history", created: 1000, completed: 6000 },
      { id: "old-b", session: "ses_history", created: 2000, completed: 5000 },
      { id: "interrupted", session: "ses_history", created: 3000, completed: now, raw: JSON.stringify({ time: { created: 3000 } }) },
    ]);
    const options = { dbPath: path, now };
    assert.deepEqual(findOpencodeDuplicateLoops(node, options), []);
    assert.deepEqual(auditOpencodeDuplicateLoops(node, options), []);
    assert.equal(audits(node).length, 0);
    const checks = opencodeDuplicateLoopChecks(node, options);
    assert.ok(checks.every(c => c.level === "info"));
    assert.match(checks[0].label, /last hour.*1000 candidate messages.*older overlaps are historical/);
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T561: an old long tool can overlap a current message; old intersections and future starts stay out", () => {
  const home = mkdtempSync(join(tmpdir(), "mbx-overlap-current-")), path = join(home, "opencode.db");
  const node = new MbxNode(home, { host: "scratch" });
  const now = 10 * OPENCODE_OVERLAP_WINDOW_MS, cutoff = now - OPENCODE_OVERLAP_WINDOW_MS;
  try {
    bind(node, "ses_current");
    const long = { id: "long-tool", session: "ses_current", created: 1000, completed: now };
    writeDb(path, [long, { id: "current", session: "ses_current", created: cutoff, completed: cutoff + 100 },
      { id: "older", session: "ses_current", created: cutoff - 200, completed: cutoff + 50 },
      { id: "future", session: "ses_current", created: now + 1, completed: now + 200 }]);
    const options = { dbPath: path, now };
    const loops = findOpencodeDuplicateLoops(node, options);
    assert.equal(loops[0].pairs, 2, "both intersections with the cutoff-time message began inside the inclusive window");
    assert.ok(!loops[0].messages.includes("future"));
    const warnings = opencodeDuplicateLoopChecks(node, options).filter(c => c.level === "warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].label, /within the last hour/);
    assert.match(warnings[0].fix!, /possible concurrent loops/);
    assert.doesNotMatch(warnings[0].fix!, /two OpenCode processes/);
    assert.equal(audits(node).length, 0, "the doctor check does not write audit state");
    writeDb(path, [long, { id: "older-only", session: "ses_current", created: cutoff - 1, completed: cutoff + 10 }]);
    assert.deepEqual(findOpencodeDuplicateLoops(node, options), [], "a recent completion does not make an old intersection current");
  } finally { node.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T522: the plugin spawns no per-hook opencode child, and the daemon arm starts the audit", () => {
  const src = opencodePluginSource(["/opt/bin/agentmbx"], version());
  assert.equal((src.match(/execFile\(/g) ?? []).length, 1);
  assert.ok(src.includes('spawnCli(bin, ["hook", event, "--cli", "opencode"]'), "the only child is agentmbx hook");
  assert.ok(!src.includes("service status"));
  assert.ok(!src.includes('execFile("opencode"') && !src.includes("execFileSync("));
  assert.match(armConversationLoopReports.toString(), /armOpencodeDuplicateLoopAudit/);
});
