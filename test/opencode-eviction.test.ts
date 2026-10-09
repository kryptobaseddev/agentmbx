/**
 * T450: doctor recognises OpenCode's hourly identity.release / identity.claim signature
 * and explains it as known upstream behaviour, not an install error.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doctor, opencodeEvictionCheck } from "../src/doctor.ts";
import { MbxNode } from "../src/node.ts";

const HOUR = 61 * 60 * 1000;

function homeNode(): { home: string; node: MbxNode } {
  const home = mkdtempSync(join(tmpdir(), "t450-"));
  return { home, node: new MbxNode(home, { host: "testhost" }) };
}

function stamp(node: MbxNode, atMs: number, event: "identity.release" | "identity.claim", cli: string, name = "agentmbx-opencode"): void {
  node.store.db.prepare("INSERT INTO audit (at, event, detail) VALUES (?, ?, ?)").run(
    new Date(atMs).toISOString(),
    event,
    JSON.stringify({ name, holder: { pid: 1, start: "s", keyFp: "k", cli, sessionId: "sess" }, at: atMs }),
  );
}

/** Release, then a claim two seconds later. That is one eviction rebind. */
function pair(node: MbxNode, atMs: number, cli = "opencode"): void {
  stamp(node, atMs, "identity.release", cli);
  stamp(node, atMs + 2000, "identity.claim", cli);
}

test("T450: two OpenCode release/claim pairs about 61 minutes apart are known upstream behaviour", () => {
  const { home, node } = homeNode();
  try {
    const t0 = Date.now() - 3 * HOUR;
    pair(node, t0);
    pair(node, t0 + HOUR);
    pair(node, t0 + 2 * HOUR + 8000);
    const check = opencodeEvictionCheck(node.store.db);
    assert.ok(check);
    assert.equal(check.level, "info");
    assert.match(check.label, /known upstream behaviour/);
    assert.match(check.label, /not a broken install/);
    assert.match(check.label, /identity\.release/);
    assert.match(check.fix ?? "", /timeToLive/);
  } finally { node.store.db.close(); rmSync(home, { recursive: true, force: true }); }
});

test("T450: one pair, a short gap, a long gap, and a non-OpenCode holder stay silent", () => {
  const cases: Array<(node: MbxNode, t0: number) => void> = [
    (node, t0) => pair(node, t0),
    (node, t0) => { pair(node, t0); pair(node, t0 + 10 * 60 * 1000); },
    (node, t0) => { pair(node, t0); pair(node, t0 + 3 * HOUR); },
    (node, t0) => { pair(node, t0, "claude"); pair(node, t0 + HOUR, "claude"); },
    (node, t0) => {
      stamp(node, t0, "identity.release", "opencode");
      stamp(node, t0 + 70 * 60 * 1000, "identity.claim", "opencode");
      stamp(node, t0 + 3 * HOUR, "identity.release", "opencode");
      stamp(node, t0 + 3 * HOUR + 70 * 60 * 1000, "identity.claim", "opencode");
    },
    (node) => {
      const old = Date.now() - 30 * 60 * 60 * 1000;
      pair(node, old);
      pair(node, old + HOUR);
    },
  ];
  for (const fill of cases) {
    const { home, node } = homeNode();
    try {
      fill(node, Date.now() - 4 * HOUR);
      assert.equal(opencodeEvictionCheck(node.store.db), null);
    } finally { node.store.db.close(); rmSync(home, { recursive: true, force: true }); }
  }
});

test("T450: doctor reports the eviction when OpenCode is detected and stays quiet otherwise", async () => {
  const { home, node } = homeNode();
  try {
    const t0 = Date.now() - 3 * HOUR;
    pair(node, t0);
    pair(node, t0 + HOUR);
    node.close();
    const shown = await doctor({ home, cmd: ["agentmbx"], which: (cli) => cli === "opencode" ? "/usr/bin/opencode" : null, useClis: false }, home);
    const hit = shown.find((c) => c.label.includes("LocationActivity"));
    assert.ok(hit);
    assert.equal(hit.level, "info");
    assert.equal(shown.some((c) => c.level === "fail" && c.label.includes("LocationActivity")), false);
    const hidden = await doctor({ home, cmd: ["agentmbx"], which: () => null, useClis: false }, home);
    assert.equal(hidden.some((c) => c.label.includes("LocationActivity")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
