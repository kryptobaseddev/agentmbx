// Cross-host project ledger (T219): the same repository lives in a different folder on each host, so its mail is matched
// by the normalized git origin a sender stamps (meta.project_key); the ledger shows mail exchanged with paired hosts and
// the recipients' states from their hosts' signed receipts (T218).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, signData } from "../src/crypto.ts";
import { buildEnvelope, signEnvelope, checkShape } from "../src/envelope.ts";
import { MbxNode } from "../src/node.ts";
import { ledgerPage } from "../src/project-ledger.ts";
import { noteProject, normalizeRemote, projectKey, registerIdentity } from "../src/registry.ts";
import { acceptReceipt } from "../src/remote-receipts.ts";

function repo(dir: string, origin: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return realpathSync(dir);
}

test("a repository's mail from a paired host's own folder joins this host's project ledger, with remote receipt states", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mbx-xledger-"));
  const A = new MbxNode(join(root, "a"), { host: "alpha" }), B = new MbxNode(join(root, "b"), { host: "beta" });
  t.after(() => { A.close(); B.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  A.addApprovedPeer({ host: "beta", pubkey: B.key.publicKey, owner_pubkey: null, addr: "127.0.0.1:9" }, "fixture");
  const mac = repo(join(root, "mac", "agentmbx"), "git@github.com:Org/AgentMBX.git");
  const fed = repo(join(root, "fedora", "src", "agentmbx-clone"), "https://github.com/org/agentmbx");
  const other = repo(join(root, "fedora", "elsewhere"), "git@github.com:org/other.git");
  assert.equal(projectKey(mac), "github.com/org/agentmbx");
  assert.equal(projectKey(fed), projectKey(mac), "the same origin is the same project on every host");
  assert.equal(projectKey(join(root, "a")), undefined, "a folder that is no repository has no key");
  // "no key" is retried after a minute (a git call that timed out under load heals without a restart)
  const late = repo(join(root, "late"), "git@github.com:org/late.git");
  execFileSync("git", ["-C", late, "remote", "remove", "origin"]);
  assert.equal(projectKey(late), undefined);
  execFileSync("git", ["-C", late, "remote", "add", "origin", "git@github.com:org/late.git"]);
  assert.equal(projectKey(late), undefined, "cached for a minute");
  assert.equal(projectKey(late, Date.now() + 61_000), "github.com/org/late");
  assert.equal(normalizeRemote("/srv/git/agentmbx.git"), undefined, "a local-path origin means nothing on another host");
  // a self-hosted remote's path never leaves the machine in clear: both hosts compute the same digest
  const nas = normalizeRemote("keaton@nas.local:/volume1/homes/keaton/git/foo.git")!;
  assert.match(nas, /^h:[0-9a-f]{32}$/); assert.doesNotMatch(nas, /keaton|volume1|nas/);
  assert.equal(normalizeRemote("ssh://keaton@NAS.local/volume1/homes/keaton/git/foo"), nas, "same repository, same digest on every host");

  registerIdentity(A.store, { name: "mac-lead", role: "lead" }); A.registerAgent("mac-lead"); noteProject(A.store, "mac-lead", mac);
  A.registerAgent("bystander"); // works elsewhere: only the project key ties this mail to the project
  const from = (project: string, subject: string) => signEnvelope(buildEnvelope({ from: "fedora-dev@beta", to: ["bystander@alpha"], subject, body: "b",
    project, project_key: projectKey(project) }), "beta", B.key.publicKey, B.key.privateKey);
  const same = from(fed, "same repo, other folder"), diff = from(other, "another repo");
  assert.equal(checkShape(same), null);
  assert.equal(same.meta.project_key, "github.com/org/agentmbx");
  assert.equal(A.receive(same, "beta"), "accepted"); assert.equal(A.receive(diff, "beta"), "accepted");

  // and a message this host's lead sent to the paired host, which reported it acked
  const out = A.send({ from: "mac-lead", to: ["fedora-dev@beta"], subject: "ship it", body: "b", project: mac, project_key: projectKey(mac) }).envelope.id;
  const rec = { v: 1 as const, type: "receipt" as const, msg: out, recipient: "fedora-dev@beta", state: "acked" as const, at: new Date().toISOString(), did: "tagged v0.5.3", seq: 3 };
  assert.equal(acceptReceipt(A, { rec, sig: signData(B.key.privateKey, canonical(rec)) }, "beta"), "accepted");

  const page = ledgerPage(A, "mac-lead", mac);
  assert.deepEqual(page.messages.map((m) => m.subject), ["same repo, other folder", "ship it"]);
  assert.deepEqual(page.messages.map((m) => [m.project, m.project_key]), [[fed, "github.com/org/agentmbx"], [mac, "github.com/org/agentmbx"]], "each row says which repository matched");
  const shipped = page.messages.find((m) => m.id === out)!;
  assert.deepEqual(shipped.recipients.map((r) => [r.address, r.state, r.did]), [["fedora-dev@beta", "acked", "tagged v0.5.3"]]);
  assert.equal(page.messages[0].body, null, "not the caller's own mail and the caller is not the lead: body withheld");
  assert.equal(ledgerPage(A, "mac-lead", realpathSync(join(root, "a"))).messages.length, 0, "a folder without the key sees none of it");

  const bad = structuredClone(same);
  (bad.meta as unknown as Record<string, unknown>).project_key = 7;
  assert.equal(checkShape(bad), "bad project key");
});
