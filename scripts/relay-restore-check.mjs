#!/usr/bin/env node
// Read-only check for a hosted relay restore drill (T167, docs/spec/relay-durability.md §5 "Runbook"). It only reads the
// public GET /v2/relay/info and never writes to a relay.
//
//   node scripts/relay-restore-check.mjs <relay-url> > before.json             receipt of what the relay serves now
//   node scripts/relay-restore-check.mjs <relay-url> --before before.json [--wait 600]
//
// The second form polls (every 5 s, up to --wait seconds, default 600) until the relay answers with another epoch, then
// prints a receipt with both observations. Exit 0: the restore rotated the epoch under the same relay key, so senders
// re-push and receivers re-pull. Exit 1: the key changed (clients refuse it: wrong store or key secret), or the epoch
// did not change in time (run `agentmbx relay rotate-epoch --store-dir <dir>` on the relay). Exit 2: usage.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [url, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (!url || !/^https?:\/\//.test(url)) {
  console.error("usage: node scripts/relay-restore-check.mjs <relay-url> [--before <receipt.json>] [--wait <seconds>]");
  process.exit(2);
}
const fingerprint = (pub) => createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex").slice(0, 16).match(/.{4}/g).join("-");

async function observe() {
  const at = new Date().toISOString();
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v2/relay/info`, { signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) return { at, url, ok: false, status: res.status };
    const j = await res.json();
    return { at, url, ok: true, relay_fingerprint: fingerprint(j.relay_pubkey), epoch: j.epoch, version: j.version, retention_days: j.limits?.retention_days };
  } catch (e) { return { at, url, ok: false, error: e.message }; }
}

const beforeFile = flag("--before");
if (!beforeFile) {
  const now = await observe();
  console.log(JSON.stringify({ v: 1, type: "relay-observation", ...now }, null, 2));
  process.exit(now.ok ? 0 : 1);
}
const before = JSON.parse(readFileSync(beforeFile, "utf8"));
const waitMs = Number(flag("--wait") ?? 600) * 1000;
let after;
for (const end = Date.now() + waitMs; ;) {
  after = await observe();
  if (after.ok && after.epoch !== before.epoch) break;
  if (Date.now() >= end) break;
  await new Promise((r) => setTimeout(r, 5_000));
}
const sameKey = after.ok && after.relay_fingerprint === before.relay_fingerprint;
const rotated = after.ok && after.epoch !== before.epoch;
const verdict = !after.ok ? "relay not answering" : !sameKey ? "relay key changed: clients stop using this relay (wrong store or MBX_RELAY_KEY)"
  : rotated ? "restored: new epoch under the same key; senders re-push, receivers re-pull" : "epoch unchanged: run agentmbx relay rotate-epoch on the relay";
console.log(JSON.stringify({ v: 1, type: "relay-restore-check", before, after, same_key: sameKey, epoch_rotated: rotated, verdict }, null, 2));
process.exit(sameKey && rotated ? 0 : 1);
