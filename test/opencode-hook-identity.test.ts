import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withCliIdentity, withHookIdentity } from "../src/cli-identity.ts";
import { findIdentityControl, publishIdentityControl } from "../src/identity-control.ts";
import { MbxNode } from "../src/node.ts";
import { bindWakeLease } from "./helpers/wake-lease.ts";

/** Two OpenCode projects under one serve: each ses_ id follows its own name, never the other holder. */
function world(): { n: MbxNode; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mbx-t466-"));
  const n = new MbxNode(home);
  return { n, close() { n.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("T466 two OpenCode sessions under one serve bind only their named agent", () => {
  const w = world();
  try {
    bindWakeLease(w.n, { agent: "agent-a", cli: "opencode", session_id: "mcp-a", pid: process.ppid });
    bindWakeLease(w.n, { agent: "agent-b", cli: "opencode", session_id: "mcp-b", pid: process.ppid });
    const holderA = findIdentityControl(w.n.store, "opencode", "mcp-a");
    const holderB = findIdentityControl(w.n.store, "opencode", "mcp-b");
    w.n.store.set("name:opencode:ses_aaaa", "agent-a");
    w.n.store.set("name:opencode:ses_bbbb", "agent-b");
    const first = withHookIdentity(w.n, "opencode", "ses_aaaa", (agent, _descriptor, bootstrap) => ({ agent, bootstrap }));
    assert.equal(first.agent, "agent-a");
    assert.equal(first.bootstrap, false);
    const second = withHookIdentity(w.n, "opencode", "ses_bbbb", (agent, _descriptor, bootstrap) => ({ agent, bootstrap }));
    assert.equal(second.agent, "agent-b");
    assert.equal(second.bootstrap, false);
    assert.equal(withHookIdentity(w.n, "opencode", "ses_aaaa", (agent) => agent), "agent-a");
    assert.equal(findIdentityControl(w.n.store, "opencode", "ses_aaaa").control_key, holderA.control_key);
    assert.equal(findIdentityControl(w.n.store, "opencode", "ses_bbbb").control_key, holderB.control_key);
    assert.equal(findIdentityControl(w.n.store, "opencode", "ses_aaaa").agent, "agent-a");
    assert.equal(findIdentityControl(w.n.store, "opencode", "ses_bbbb").agent, "agent-b");
    assert.throws(() => withHookIdentity(w.n, "opencode", "ses_cccc", () => {}), /no exact current MCP binding/);
    assert.throws(() => withCliIdentity(w.n, {}, () => {}), /specify --cli and --session/);
    assert.equal(withCliIdentity(w.n, { cli: "opencode", session: "ses_aaaa" }, (agent) => agent), "agent-a");
  } finally { w.close(); }
});

test("T466 a stale OpenCode control is replaced from the named live holder", () => {
  const w = world();
  try {
    bindWakeLease(w.n, { agent: "agent-a", cli: "opencode", session_id: "mcp-a", pid: process.ppid });
    bindWakeLease(w.n, { agent: "agent-b", cli: "opencode", session_id: "mcp-b", pid: process.ppid });
    const holder = findIdentityControl(w.n.store, "opencode", "mcp-a");
    w.n.store.set("name:opencode:ses_aaaa", "agent-a");
    publishIdentityControl(w.n.store, { ...holder, session_id: "ses_aaaa", mcp_pid: 1, generation: "0".repeat(64) });
    assert.equal(withHookIdentity(w.n, "opencode", "ses_aaaa", (agent) => agent), "agent-a");
    const restored = findIdentityControl(w.n.store, "opencode", "ses_aaaa");
    assert.equal(restored.control_key, holder.control_key);
    assert.equal(restored.agent, "agent-a");
    assert.notEqual(restored.mcp_pid, 1);
  } finally { w.close(); }
});

test("T466 one OpenCode control is not this session without a name or --session", () => {
  const w = world();
  try {
    bindWakeLease(w.n, { agent: "agent-a", cli: "opencode", session_id: "mcp-a", pid: process.ppid });
    assert.throws(() => withHookIdentity(w.n, "opencode", "ses_aaaa", () => {}), /no exact current MCP binding/);
    assert.throws(() => withCliIdentity(w.n, {}, () => {}), /specify --cli and --session/);
    assert.equal(withCliIdentity(w.n, { cli: "opencode", session: "mcp-a" }, (agent) => agent), "agent-a");
  } finally { w.close(); }
});
