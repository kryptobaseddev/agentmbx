// Provider wake contract (T177): outcome retry semantics and the honest capability declaration of current paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CURRENT_CAPABILITIES, isTerminal, retryAdvice, type WakeOutcome } from "../src/wake-contract.ts";

const base = { attemptId: "att_1", via: "fixture" };
const receipt = { strength: "native", nativeId: "msg_1", sessionId: "ses_1", nativeStatus: "queued", providerVersion: null } as const;
const outcomes: WakeOutcome[] = [
  { ...base, kind: "not_submitted", reason: "fenced" }, { ...base, kind: "admitted", receipt }, { ...base, kind: "busy" },
  { ...base, kind: "blocked", gate: "native-approval" }, { ...base, kind: "unknown", reason: "timeout" }, { ...base, kind: "failed", status: 409 },
];

test("six distinct outcome kinds", () => assert.deepEqual(outcomes.map(o => o.kind), ["not_submitted", "admitted", "busy", "blocked", "unknown", "failed"]));

test("only admitted and blocked are terminal", () =>
  assert.deepEqual(outcomes.filter(isTerminal).map(o => o.kind), ["admitted", "blocked"]));

test("unknown is never blindly resubmitted and never refunds budget", () => {
  for (const canLookup of [false, true]) {
    const a = retryAdvice({ ...base, kind: "unknown", reason: "lost-response" }, canLookup);
    assert.equal(a.resubmit, false); assert.equal(a.refund, false);
    assert.equal(a.next, canLookup ? "reconcile" : "hold");
  }
});

test("refund only when nothing was admitted by this attempt", () =>
  assert.deepEqual(outcomes.filter(o => retryAdvice(o).refund).map(o => o.kind), ["not_submitted", "busy", "blocked"]));

test("busy and not_submitted keep mail delivered for the next pass", () => {
  for (const o of outcomes.filter(o => o.kind === "busy" || o.kind === "not_submitted"))
    assert.deepEqual(retryAdvice(o), { next: "next-pass", resubmit: true, refund: true, keepDelivered: true });
});

test("admission settles the attempt without claiming more", () =>
  assert.deepEqual(retryAdvice(outcomes[1]), { next: "none", resubmit: false, refund: false, keepDelivered: false }));

test("blocked holds for a person instead of looping", () => assert.equal(retryAdvice(outcomes[3]).next, "hold"));
test("failed backs off without refunding", () =>
  assert.deepEqual(retryAdvice(outcomes[5]), { next: "backoff", resubmit: true, refund: false, keepDelivered: true }));
test("unsupported target holds instead of retrying", () =>
  assert.deepEqual(retryAdvice({ ...base, kind: "not_submitted", reason: "unsupported" }), { next: "hold", resubmit: false, refund: true, keepDelivered: true }));

test("absent capabilities are declared, not simulated", () => {
  assert.equal(CURRENT_CAPABILITIES.hermes.exactSession, "none");
  assert.equal(CURRENT_CAPABILITIES.hermes.admissionReceipt, "none");
  assert.equal(CURRENT_CAPABILITIES.desktop.noticeOnly, true);
  assert.equal(CURRENT_CAPABILITIES.desktop.exactSession, "none");
  for (const c of Object.values(CURRENT_CAPABILITIES)) {
    assert.equal(c.idempotencyLookup, false, `${c.provider}: no current path can reconcile a lost response`);
    assert.deepEqual(c.testedVersions, [], `${c.provider}: no path is version-pinned yet`);
  }
  assert.deepEqual(Object.values(CURRENT_CAPABILITIES).filter(c => c.busyInspection).map(c => c.provider), ["kimi"]);
  assert.deepEqual(Object.values(CURRENT_CAPABILITIES).filter(c => c.channelDelivery).map(c => c.provider), ["claude"]);
});
