import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MbxNode } from "../src/node.ts";
import { hudStatusV2 } from "../src/hud.ts";
import { resolveStatusIdentity } from "../src/status-identity.ts";

test("T410: preview producer requires exact session binding and keeps the base v2 contract additive", t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-inbox-snapshot-"));
  const n = new MbxNode(home, { host: "scratch" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true }); });
  for (const [sid, agent] of [["ses_alpha", "alpha"], ["ses_beta", "beta"]]) n.store.db.prepare("INSERT INTO sessions(agent,cli,session_id,updated_at) VALUES (?,'opencode',?,?)").run(agent, sid, new Date().toISOString());
  for (let i = 0; i < 5; i++) n.send({ from: "peer", to: ["alpha"], subject: "alpha-" + i, body: "PRIVATE BODY", needs_reply: i === 4 });
  n.send({ from: "peer", to: ["beta"], subject: "beta-private", body: "BETA BODY" });
  const read = (sid: string, includeInbox = true) => {
    const resolved = resolveStatusIdentity(n, "opencode", { sessionId: sid });
    return hudStatusV2(n, { cli: "opencode", sessionId: sid, agent: resolved.name, state: resolved.state, resolvedBy: resolved.resolved_by ?? "none", includeInbox });
  };
  const alpha = read("ses_alpha");
  assert.equal(alpha.inbox.recent?.length, 3);
  assert.ok(alpha.inbox.recent?.every(m => m.subject.startsWith("alpha-")));
  assert.ok(alpha.inbox.recent?.some(m => m.needs_reply));
  assert.equal(alpha.inbox.unread, 5);
  assert.doesNotMatch(JSON.stringify(alpha), /beta-private|PRIVATE BODY|BETA BODY/);
  assert.deepEqual(read("ses_beta").inbox.recent?.map(m => m.subject), ["beta-private"]);
  assert.deepEqual(read("ses_missing").inbox.recent, []);
  assert.equal(read("ses_alpha", false).inbox.recent, undefined);
  const wrong = hudStatusV2(n, { cli: "opencode", sessionId: "ses_beta", agent: "alpha", state: "bound", resolvedBy: "session_id", includeInbox: true });
  assert.deepEqual(wrong.inbox.recent, [], "a mismatched producer argument cannot expose message previews");
});
