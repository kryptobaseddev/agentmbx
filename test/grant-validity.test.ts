import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, signData } from "../src/crypto.ts";
import { attachAuthority, buildEnvelope, buildGrant, checkAuthority, grantPayload, MAX_GRANT_HOURS, type Grant } from "../src/envelope.ts";

const now = new Date("2026-09-28T06:00:00.000Z");
const owner = generateKeyPair(), session = generateKeyPair();
function envelope(change: Record<string, unknown> = {}) {
  const unsigned = { ...buildGrant(owner.publicKey, session.publicKey, "master", "alpha", ["task.assign"], 1, now), ...change };
  const grant = { ...unsigned, sig: signData(owner.privateKey, grantPayload(unsigned as Omit<Grant, "sig">)) } as Grant;
  return attachAuthority(buildEnvelope({ from: "master@alpha", to: ["worker@beta"], subject: "task", body: "fix it", kind: "task" }, now), grant, session.privateKey);
}
for (const [name, change] of Object.entries({
  "invalid expiry": { exp: "not-a-date" },
  "missing expiry": { exp: undefined },
  "non-string expiry": { exp: 2099 },
  "invalid issuance": { iat: "not-a-date" },
  "missing issuance": { iat: undefined },
  "reversed interval": { iat: new Date(now.getTime() + 7_200_000).toISOString() },
  "zero interval": { exp: now.toISOString() },
  "overlong interval": { exp: new Date(now.getTime() + (MAX_GRANT_HOURS + 1) * 3_600_000).toISOString() },
})) test(`valid owner/session signatures cannot authorize a grant with ${name}`, () => {
  const result = checkAuthority(envelope(change), owner.publicKey, new Set(), now);
  assert.equal(result.ok, false);
});
test("grant expiry is exclusive and valid maximum lifetime remains accepted", () => {
  assert.equal(checkAuthority(envelope(), owner.publicKey, new Set(), now).ok, true);
  assert.equal(checkAuthority(envelope(), owner.publicKey, new Set(), new Date(now.getTime() + 3_600_000 - 1)).ok, true);
  assert.equal(checkAuthority(envelope(), owner.publicKey, new Set(), new Date(now.getTime() + 3_600_000)).ok, false);
  assert.equal(checkAuthority(envelope({ exp: new Date(now.getTime() + MAX_GRANT_HOURS * 3_600_000).toISOString() }), owner.publicKey, new Set(), now).ok, true);
  assert.equal(checkAuthority(envelope(), owner.publicKey, new Set(), new Date(NaN)).ok, false);
});
