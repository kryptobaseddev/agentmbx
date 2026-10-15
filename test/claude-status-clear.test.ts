// T658: the Claude plugin's under-prompt line ("⚠ agentmbx: mbx: 1↑ 1↺") stayed after the inbox emptied, because the
// 5 s timer only called $.ui.status when there was a line, and the host keeps a status line until it is changed. The
// timer now clears it with $.ui.status(undefined). The line also follows the T650 split: new mail is the headline and
// read-but-unacked mail is its own "M read" segment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, resetStatusState, statusLineText } from "../plugins/claude/hooks/register.js";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/status-v2-bound.json", import.meta.url), "utf8"));
const withInbox = (inbox: Record<string, number>) => ({ ...BASE, inbox: { outbox_unsent: 0, from_owner: 0, ...inbox } });

/** A fake `$` that serves whatever snapshot `serve` holds and records every ui.status call, argument included. */
function harness() {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const on = (event: string, matcherOrHook: unknown, hook?: unknown) => {
    if (typeof matcherOrHook === "function") handlers[event] = matcherOrHook as (...args: unknown[]) => unknown;
    else handlers[`${event}:${JSON.stringify(matcherOrHook)}`] = hook as (...args: unknown[]) => unknown;
  };
  const state: { serve: unknown; ok: boolean; calls: { args: unknown[] }[]; tick?: () => Promise<unknown> } = { serve: null, ok: true, calls: [] };
  let now = 1_000;
  const $ = {
    env: { get: async (name: string) => (name === "CLAUDE_CODE_SESSION_ID" ? "sess-t658" : "") },
    clock: {
      now: async () => (now += 10_000), // past the status cache, so every tick refetches
      every: (_ms: number, fn: () => Promise<unknown>) => { state.tick = fn; return { cancel: () => {} }; },
    },
    http: { fetch: async () => (state.ok ? { ok: true, status: 200, text: JSON.stringify(state.serve) } : { ok: false, status: 503, text: "" }) },
    command: { register: async () => {} },
    ui: {
      status: (...args: unknown[]) => { state.calls.push({ args }); },
      invalidate: () => {},
      toast: () => {},
      open: async () => ({ isPlaced: true }),
      resolve: () => ({ Box: (p: unknown) => p, Text: (p: unknown) => p }),
    },
  };
  register(on);
  return { $, state, start: () => handlers["session.start"]!($, {}, async () => "started") };
}

test("T658: mail then no mail clears the under-prompt line with ui.status(undefined)", async (t) => {
  resetStatusState();
  t.after(() => resetStatusState());
  const { state, start } = harness();
  await start();
  state.serve = withInbox({ unread: 1, new: 1, read: 0, needs_reply: 1 });
  await state.tick!();
  assert.deepEqual(state.calls.at(-1)!.args, ["mbx: 1↑ 1↺"]);
  state.serve = withInbox({ unread: 0, new: 0, read: 0, needs_reply: 0 });
  await state.tick!();
  assert.equal(state.calls.length, 2, "the empty inbox is a call, not a skipped tick");
  assert.equal(state.calls[1]!.args.length, 1);
  assert.equal(state.calls[1]!.args[0], undefined, "cleared with undefined");
  state.serve = withInbox({ unread: 2, new: 2, read: 0, needs_reply: 0 });
  await state.tick!();
  assert.deepEqual(state.calls.at(-1)!.args, ["mbx: 2↑"], "new mail pins it again");
});

test("T658: an unreachable daemon also clears the line rather than leaving a stale count", async (t) => {
  resetStatusState();
  t.after(() => resetStatusState());
  const { state, start } = harness();
  await start();
  state.serve = withInbox({ unread: 3, new: 3, read: 0, needs_reply: 0 });
  await state.tick!();
  assert.deepEqual(state.calls.at(-1)!.args, ["mbx: 3↑"]);
  state.ok = false;
  await state.tick!();
  assert.equal(state.calls.at(-1)!.args[0], undefined, "unavailable: no stale count");
  state.ok = true;
  state.serve = withInbox({ unread: 3, new: 3, read: 0, needs_reply: 0 });
  await state.tick!();
  assert.deepEqual(state.calls.at(-1)!.args, ["mbx: 3↑"], "back once the daemon answers");
});

test("T658: the line splits new from read (T650), and a pre-T650 snapshot keeps the old rendering", () => {
  assert.equal(statusLineText(withInbox({ unread: 3, new: 1, read: 2, needs_reply: 1 })), "mbx: 1↑ 2 read 1↺");
  assert.equal(statusLineText(withInbox({ unread: 2, new: 0, read: 2, needs_reply: 0 })), "mbx: 2 read", "read only: no 0↑ headline");
  assert.equal(statusLineText(withInbox({ unread: 1, new: 0, read: 1, needs_reply: 1, from_owner: 1 })), "mbx: 1 read 1↺ owner:1");
  assert.equal(statusLineText(withInbox({ unread: 4, new: 4, read: 0, needs_reply: 0 })), "mbx: 4↑");
  assert.equal(statusLineText(withInbox({ unread: 0, new: 0, read: 0, needs_reply: 0 })), null);
  // a daemon from before T650 sends only unread: unread stays the headline and there is no read segment
  assert.equal(statusLineText(withInbox({ unread: 2, needs_reply: 1 })), "mbx: 2↑ 1↺");
  assert.equal(statusLineText(withInbox({ unread: 2, read: 5, needs_reply: 0 })), "mbx: 2↑", "read without new is ignored");
});
