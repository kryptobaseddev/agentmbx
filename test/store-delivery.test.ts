import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { Store, type DeliveryState } from "../src/store.ts";

test("a concurrent ack cannot be overwritten by a stale notification", (t) => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-delivery-")), { host: "alpha" });
  const other = new Store(n.home);
  try {
    const id = n.send({ from: "sender", to: ["receiver"], subject: "race", body: "x" }).envelope.id;
    const prepare = n.store.db.prepare.bind(n.store.db);
    let interleaved = false;
    t.mock.method(n.store.db, "prepare", (sql: string) => {
      if (!interleaved && sql.startsWith("UPDATE deliveries SET state=")) {
        interleaved = true;
        assert.equal(other.setDelivery(id, "receiver", "acked", "handled by receiver"), true);
      }
      return prepare(sql);
    });
    assert.equal(n.setDelivery(id, "receiver", "notified", "desktop"), false);
    assert.equal(interleaved, true, "the other connection acked immediately before the notification update");
    const row = other.db.prepare("SELECT state,note FROM deliveries WHERE msg_id=? AND agent=?").get(id, "receiver");
    assert.deepEqual({ ...row }, { state: "acked", note: "handled by receiver" });
    assert.equal(n.unreadCount("receiver"), 0);
  } finally { t.mock.restoreAll(); other.close(); n.close(); }
});

test("all delivery transitions are monotonic and only successful transitions update notes", () => {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), "mbx-delivery-")), { host: "alpha" });
  try {
    const id = n.send({ from: "sender", to: ["receiver"], subject: "states", body: "x" }).envelope.id;
    const states: DeliveryState[] = ["queued", "delivered", "notified", "read", "acked"];
    for (const [i, from] of states.entries()) for (const [j, to] of states.entries()) {
      n.store.db.prepare("UPDATE deliveries SET state=?,note='original',updated_at='old' WHERE msg_id=?").run(from, id);
      assert.equal(n.setDelivery(id, "receiver", to, "new"), j > i, `${from} -> ${to}`);
      const row = n.store.db.prepare("SELECT state,note,updated_at FROM deliveries WHERE msg_id=?").get(id)!;
      assert.equal(row.state, j > i ? to : from);
      assert.equal(row.note, j > i ? "new" : "original");
      assert.equal(row.updated_at === "old", j <= i);
    }
    n.store.db.prepare("UPDATE deliveries SET state='delivered',note='original' WHERE msg_id=?").run(id);
    assert.equal(n.setDelivery(id, "receiver", "read"), true);
    assert.equal(n.store.db.prepare("SELECT note FROM deliveries WHERE msg_id=?").get(id)!.note, "original");
    assert.equal(n.setDelivery(id, "another-agent", "acked"), false);
    assert.equal(n.setDelivery("missing", "receiver", "acked"), false);
  } finally { n.close(); }
});
