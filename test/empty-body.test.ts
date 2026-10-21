import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MbxNode } from "../src/node.ts";

test("T726 a send with an empty or whitespace-only body is refused and stores nothing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mbx-t726-")), n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  for (const body of ["", "  \n\t "])
    assert.throws(() => n.send({ from: "sender", to: ["drum"], subject: "design note", body }), (e: Error & { code?: string }) => e.code === "EMPTY_BODY" && /nothing was sent/.test(e.message));
  assert.equal((n.store.db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number }).c, 0);
  assert.ok(n.send({ from: "sender", to: ["drum"], subject: "design note", body: "the text" }).envelope.id);
});

test("T726 agentmbx send refuses a positional body instead of dropping it", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "mbx-t726-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [resolve("bin/agentmbx.js"), "send", "--as", "sender", "--to", "drum", "--subject", "s", "the body"],
    { encoding: "utf8", input: "", env: { ...process.env, AGENTMBX_DEV: "1", MBX_HOME: home, MBX_NO_DESKTOP: "1" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unexpected argument "the body": pass the body with -m/);
});
