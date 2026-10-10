// T547: Hermes consent matches this install's entry script under any node, not the node that invoked doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { doctor, failed, hermesHooksChecks } from "../src/doctor.ts";
import { hermesConsent, hookCommand, installedEntry, runSetup, type SetupCtx } from "../src/setup.ts";

const ctxFor = (home: string, cmd: string[]): SetupCtx => ({ home, cmd, which: () => null, useClis: false });

test("T547: allowlist written with node A is approved when doctor runs as node B; a foreign script is not", async () => {
  const entry = installedEntry();
  assert.ok(entry, "this checkout has bin/agentmbx.js");
  const nodeA = process.execPath;
  const nodeB = nodeA === "/bin/sh" ? "/bin/echo" : "/bin/sh";
  assert.notEqual(nodeA, nodeB);
  assert.ok(existsSync(nodeA) && existsSync(nodeB));
  const home = mkdtempSync(join(tmpdir(), "mbx-t547-"));
  const mbx = join(home, ".local/share/agentmbx");
  try {
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes/config.yaml"), "model: 1\n");
    new MbxNode(mbx, { host: "alpha", port: 1 }).close();
    const wrote = runSetup(ctxFor(home, [nodeA, entry]), { mode: "install", only: ["hermes"] });
    assert.equal(wrote.some((row) => row.action === "error"), false);
    const asB = ctxFor(home, [nodeB, entry]);
    assert.deepEqual(hermesConsent(asB), { state: "approved", missing: [] });
    assert.match(hermesHooksChecks(asB)[0]?.label ?? "", /hooks approved to run/);
    const checks = await doctor(asB, mbx);
    assert.ok(checks.some((c) => c.level === "ok" && /hermes: hooks approved to run/.test(c.label)));
    assert.equal(failed(checks.filter((c) => /hermes: hooks approved/.test(c.label))), false);

    const foreign = join(home, "foreign.js");
    writeFileSync(foreign, "");
    const approvals = [
      { approved_at: "2026-09-01T00:00:00Z", event: "on_session_start", command: hookCommand([nodeA, foreign], "session-start", "hermes"), script_mtime_at_approval: null },
      { approved_at: "2026-09-01T00:00:00Z", event: "pre_llm_call", command: hookCommand([nodeA, foreign], "prompt", "hermes"), script_mtime_at_approval: null },
    ];
    writeFileSync(join(home, ".hermes/shell-hooks-allowlist.json"), JSON.stringify({ approvals }, null, 2));
    assert.deepEqual(hermesConsent(asB), { state: "missing", missing: ["on_session_start", "pre_llm_call"] });
    const warn = hermesHooksChecks(asB);
    assert.equal(warn[0]?.level, "warn");
    assert.match(warn[0]?.label ?? "", /not approved \(on_session_start, pre_llm_call\)/);
    const again = await doctor(asB, mbx);
    assert.ok(again.some((c) => c.level === "warn" && /hermes: hooks are wired but not approved/.test(c.label)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
