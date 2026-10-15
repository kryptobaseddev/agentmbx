// T650: every count used to mean "unacked", including mail already read, so mail read and replied to without an ack looked
// like it came back after a restart. The status line headline now counts new mail only (queued, delivered, notified), and
// read-but-unacked mail is its own segment ("3↑ 2 read"). `unread` keeps its meaning (every unacked delivery) for existing
// readers, and both snapshots carry `new` and `read` additively. Counts stay the snapshot's own identity's only (T308 AC2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode } from "../src/node.ts";
import { hudLine, hudSessionLinePath, hudSessionPath, hudSessionV2Path, hudStatus, newCount, writeHud, type HudStatus } from "../src/hud.ts";
import { IdentityLeases, inspectLeaseProcess } from "../src/identity-leases.ts";
import { opencodeSidebarSchemaSource, opencodeSidebarSource } from "../src/opencode-sidebar.ts";
import { version } from "../src/version.ts";

const home = () => mkdtempSync(join(tmpdir(), "mbx-t650-"));
const claim = (n: MbxNode, name: string, sid: string, cli: string) =>
  new IdentityLeases(n.store).claim(name, { pid: process.pid, start: inspectLeaseProcess(process.pid).start!, keyFp: "aaaa-bbbb-cccc-dddd", cli, sessionId: sid });

/** drum (cli) with `fresh` new and `read` read-but-unacked messages, one acked, plus mail for another identity. */
function seeded(t: { after: (fn: () => void) => void }, cli: string, fresh: number, read: number) {
  const h = home(), n = new MbxNode(h, { host: "alpha" });
  t.after(() => { n.close(); rmSync(h, { recursive: true, force: true }); });
  n.bindSession({ agent: "drum", cli, session_id: `${cli}-sess`, pid: process.pid, session_key: "k" });
  claim(n, "drum", `${cli}-sess`, cli);
  const ids: string[] = [];
  for (let i = 0; i < fresh + read + 1; i++) ids.push(n.send({ from: "boss", to: ["drum"], subject: `m${i}`, body: "b", needs_reply: i === 0 }).envelope.id);
  n.markRead(ids.slice(0, read).map((id) => ({ id })), "drum"); // the first `read` messages: read, never acked
  n.ack(ids[ids.length - 1], "drum"); // one handled message
  // T308 AC2: another identity's new and read mail never reaches drum's counts
  const other = [n.send({ from: "boss", to: ["other"], subject: "x", body: "b" }).envelope.id, n.send({ from: "boss", to: ["other"], subject: "y", body: "b" }).envelope.id];
  n.markRead([{ id: other[0] }], "other");
  writeHud(n);
  const v1 = JSON.parse(readFileSync(hudSessionPath(h, cli, `${cli}-sess`), "utf8")) as HudStatus;
  const v2 = JSON.parse(readFileSync(hudSessionV2Path(h, cli, `${cli}-sess`), "utf8")) as { inbox: Record<string, number> };
  const line = readFileSync(hudSessionLinePath(h, cli, `${cli}-sess`), "utf8");
  return { n, v1, v2, line };
}

test("the snapshot splits unacked mail into new and read; unread keeps meaning every unacked delivery", (t) => {
  const { v1, v2 } = seeded(t, "claude", 3, 2);
  assert.deepEqual([v1.unread, v1.new, v1.read], [5, 3, 2], "unread = new + read; the acked message counts nowhere");
  assert.equal(v1.needs_reply, 1, "a read request still needs its reply: ↺ counts every unacked request");
  assert.deepEqual([v2.inbox.unread, v2.inbox.new, v2.inbox.read], [5, 3, 2], "status v2 carries both counts");
});

test("the status line headline is new mail only, with read-but-unacked as its own segment", (t) => {
  const { line } = seeded(t, "claude", 3, 2);
  assert.equal(line, "mbx drum 3↑ 2 read 1↺\n");
});

test("read-only mail shows only the read segment; nothing pending shows neither", (t) => {
  assert.equal(seeded(t, "claude", 0, 2).line, "mbx drum 2 read 1↺\n", "the read request still shows ↺");
  assert.equal(seeded(t, "grok", 0, 0).line, "mbx drum\n");
});

test("Kimi's alert-only line appears for new mail, not for read-but-unacked alone", (t) => {
  assert.equal(seeded(t, "kimi", 0, 2).line, "", "read-only mail leaves Kimi's own footer in place");
  assert.equal(seeded(t, "kimi", 1, 2).line, "mbx drum 1↑ 2 read 1↺\n");
});

test("a snapshot from before T650 (no new/read fields) still renders its unacked total as the headline", () => {
  const old = { schema: "mbx.status/v1", mbx_version: "0.5.35", update_available: null, identity: { name: "drum", role: null, state: "bound" },
    unread: 4, needs_reply: 0, from_owner: 0, outbox_unsent: 0, policy: [], resolved_by: "session_id" } as HudStatus;
  assert.equal(newCount(old), 4);
  assert.equal(hudLine(old), "mbx drum 4↑");
});

test("T308 AC2: hudStatus counts the named identity's own deliveries only", (t) => {
  const { n } = seeded(t, "claude", 1, 1);
  const s = hudStatus(n, { agent: "other", state: "bound", resolvedBy: "session_id" });
  assert.deepEqual([s.unread, s.new, s.read], [2, 1, 1]);
  const none = hudStatus(n, { agent: null, state: "unbound", resolvedBy: "none" });
  assert.deepEqual([none.unread, none.new, none.read], [0, 0, 0]);
});

test("the OpenCode sidebar renders the same split: headline new, a read segment, and the Inbox section line", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mbx-t650-sidebar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "status-schema.ts"), opencodeSidebarSchemaSource());
  writeFileSync(join(dir, "agentmbx-sidebar.ts"), opencodeSidebarSource(version()));
  const mod = await import(join(dir, "agentmbx-sidebar.ts")) as { formatStatusV2: (s: unknown) => string; statusSections: (s: unknown) => { title: string; lines: string[] }[] };
  const snap = (inbox: Record<string, number>) => ({ schema: "mbx.status/v2", mbx_version: "0.5.36", identity: { name: "drum", role: "builder", state: "bound" },
    registration: { registered: true, lease: { holder_cli: "opencode", holder_session: "ses_x", verified: true } },
    inbox: { needs_reply: 1, from_owner: 0, outbox_unsent: 0, ...inbox }, harness: { cli: "opencode", session_id: "ses_x", wake_path: "plugin", policy: [] },
    cloud: { relay: { url: null, state: "unset", last_ack: null }, key_ad_expiry: null, account: null }, devices: [], project: null, resolved_by: "session_id" });
  assert.equal(mod.formatStatusV2(snap({ unread: 5, new: 3, read: 2 })), "mbx drum(builder) 3↑ 2 read 1↺");
  assert.equal(mod.formatStatusV2(snap({ unread: 2, new: 0, read: 2 })), "mbx drum(builder) 2 read 1↺", "no headline for read-only mail");
  assert.equal(mod.formatStatusV2(snap({ unread: 4 })), "mbx drum(builder) 4↑ 1↺", "a pre-T650 daemon's unread is the headline");
  const inbox = mod.statusSections(snap({ unread: 5, new: 3, read: 2 })).find((x) => x.title === "Inbox")!;
  assert.equal(inbox.lines[0], "3 new · 2 read · 1 needs reply");
});
