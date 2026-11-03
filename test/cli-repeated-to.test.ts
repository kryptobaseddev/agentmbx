// T769: `agentmbx send --to a --to b` kept only the last --to (exit 0, one delivery, the others silently dropped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";

test("T769: every repeated --to is a recipient, alone or mixed with comma lists", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t769-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const a of ["sender", "fixer", "accountant", "optimizer", "secretary"]) n.registerAgent(a);
  const bin = join(import.meta.dirname, "../bin/agentmbx.js");
  const env = { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" } as Record<string, string>;
  const r = spawnSync(process.execPath, [bin, "send", "--as", "sender", "--to", "fixer", "--to", "accountant,optimizer", "--to", "secretary",
    "--kind", "task", "--subject", "x", "-m", "y"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const id = (n.store.db.prepare("SELECT id FROM messages WHERE from_addr LIKE 'sender@%'").get() as { id: string }).id;
  const got = (n.store.db.prepare("SELECT agent FROM deliveries WHERE msg_id=? ORDER BY agent").all(id) as { agent: string }[]).map((d) => d.agent);
  assert.deepEqual(got, ["accountant", "fixer", "optimizer", "secretary"]);
});
