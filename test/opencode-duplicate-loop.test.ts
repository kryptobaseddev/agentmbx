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
  type AssistantTurn,
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

    const found = auditOpencodeDuplicateLoops(node, { dbPath });
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

    auditOpencodeDuplicateLoops(node, { dbPath });
    assert.equal(audits(node).length, 1, "the same overlap is one audit row");

    const checks = opencodeDuplicateLoopChecks(node, { dbPath });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.level, "warn");
    assert.match(checks[0]!.label, /overlapping assistant messages on bound session ses_bound/);
    assert.match(checks[0]!.label, /with snapshots/);
    assert.equal(failed(checks), false);

    writeDb(dbPath, [
      { id: "msg_a", session: "ses_bound", created: 1_000, completed: 2_000 },
      { id: "msg_b", session: "ses_bound", created: 1_500, completed: 2_500 },
      { id: "msg_c", session: "ses_bound", created: 2_200, completed: 3_000 },
    ]);
    auditOpencodeDuplicateLoops(node, { dbPath });
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
    assert.deepEqual(opencodeDuplicateLoopChecks(node, { dbPath }), []);
  } finally {
    node.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("T522: the plugin spawns no per-hook opencode child, and the daemon arm starts the audit", () => {
  const src = opencodePluginSource(["/opt/bin/agentmbx"], version());
  assert.equal((src.match(/execFile\(/g) ?? []).length, 1);
  assert.ok(src.includes('spawnCli(bin, ["hook", event, "--cli", "opencode"]'), "the only child is agentmbx hook");
  assert.ok(!src.includes("service status"));
  assert.ok(!src.includes('execFile("opencode"') && !src.includes("execFileSync("));
  assert.match(armConversationLoopReports.toString(), /armOpencodeDuplicateLoopAudit/);
});
