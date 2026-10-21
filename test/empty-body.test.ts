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
