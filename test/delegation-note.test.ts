import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonical, generateKeyPair, signData } from "../src/crypto.ts";
import { MbxNode } from "../src/node.ts";
import { acceptSigned, delegationNote, makePolicy } from "../src/policy.ts";

const AUTO = /permission prompts may be auto-approved for bounded outward-reversible operations on supported harnesses/;
const OUTSIDE = /pushes and PRs are outside the grant/;

function note(t: { after: (fn: () => void) => void }, classes: Array<"read" | "edit" | "outward-reversible" | "outward" | "permissions">): string {
  const home = mkdtempSync(join(tmpdir(), "mbx-note-"));
  const owner = generateKeyPair();
  writeFileSync(join(home, "owner.json"), JSON.stringify({ backend: "keychain", public_key: owner.publicKey }), { mode: 0o600 });
  const n = new MbxNode(home, { host: "alpha" });
  t.after(() => { n.close(); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const rec = makePolicy({ level: "autonomous", classes, agents: ["reader"], hosts: ["alpha"], ownerPub: owner.publicKey });
  assert.equal(acceptSigned(n.store.db, { rec, sig: signData(owner.privateKey, canonical(rec)) }, "alpha"), null);
  const text = delegationNote(n.store.db, "reader", "alpha");
  assert.ok(text);
  return text;
}

test("T558: auto-approval is named only when a listed policy grants outward-reversible", (t) => {
  const limited = note(t, ["read", "edit"]);
  assert.match(limited, OUTSIDE);
  assert.doesNotMatch(limited, AUTO);
  const granted = note(t, ["read", "edit", "outward-reversible"]);
  assert.match(granted, AUTO);
  assert.doesNotMatch(granted, OUTSIDE);
  const outward = note(t, ["outward"]);
  assert.match(outward, AUTO);
  assert.doesNotMatch(outward, OUTSIDE);
});
