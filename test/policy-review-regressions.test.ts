// Regression expectations from Codex's review of 67a4dd8 (branch codex/mbx-policy-review-20260926), adapted to the
// fixes: owner adoption is an explicit step (adoptOwner), identity is pid + process start time, and publish issues
// records through issueSigned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MbxNode } from '../src/node.ts';
import { canonical, generateKeyPair, signData } from '../src/crypto.ts';
import { acceptSigned, effectivePolicy, hasClass, issueSigned, makePolicy, type PolicyRecord } from '../src/policy.ts';
import { decidePermission } from '../src/permission.ts';
import { signedRecords } from '../src/http.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const n = new MbxNode(mkdtempSync(join(tmpdir(), 'mbx-review-')), { host: 'reviewhost' });
  t.after(() => n.close());
  const owner = generateKeyPair(), peer = generateKeyPair();
  n.addApprovedPeer({ host: 'peerhost', pubkey: peer.publicKey, owner_pubkey: owner.publicKey, addr: '127.0.0.1:1' }, 'test');
  n.adoptOwner('peerhost'); // the explicit consent step (join --adopt-owner / owner adopt)
  const sign = (rec: PolicyRecord) => ({ rec, sig: signData(owner.privateKey, canonical(rec)) });
  const policy = (extra: Partial<Parameters<typeof makePolicy>[0]> = {}) => makePolicy({
    level: 'yolo', agents: ['trusted'], hosts: [n.host], ownerPub: owner.publicKey, ...extra,
  });
  const grant = (rec: PolicyRecord) => assert.equal(acceptSigned(n.store.db, sign(rec), n.host), null);
  return { n, sign, policy, grant };
}

test('fresh PID reuse must not transfer a previous session identity', t => {
  const { n } = fixture(t);
  // Simulate a newly alive process reusing a PID while the old binding remains fresh.
  n.bindSession({ agent: 'old-owner', cli: 'codex', session_id: 'old-mcp', pid: process.pid, session_key: 'old-key' });
  // the old binding was recorded for an earlier process that had this PID: a different start time
  n.store.db.prepare("UPDATE sessions SET pid_start='Thu Jan  1 00:00:00 1970' WHERE session_id='old-mcp'").run();
  assert.equal(n.bindSession({ agent: 'new-owner', cli: 'codex', session_id: 'new-thread', pid: process.pid }), 'new-owner');
});

test('permission hook rejects stale PID identity when the requesting session is unknown', t => {
  const { n, policy, grant } = fixture(t);
  grant(policy());
  n.bindSession({ agent: 'trusted', cli: 'codex', session_id: 'old-mcp', pid: process.pid, session_key: 'old-key' });
  n.store.db.prepare('UPDATE sessions SET updated_at=?').run('2000-01-01T00:00:00.000Z');
  const d = decidePermission({ hook_event_name: 'PermissionRequest', session_id: 'unknown-thread', cwd: '/outside', tool_name: 'Bash', tool_input: { command: 'echo harmless' } },
    'codex', agent => hasClass(n.store.db, agent, n.host, 'permissions'), { node: n, pid: process.pid });
  assert.equal(d.allow, false);
});

test('scoped permission policy cannot grant approval without matching sender and project context', t => {
  const { n, policy, grant } = fixture(t);
  grant(policy({ from: ['peerhost'], fromAgents: ['planner'], projects: ['/allowed'] }));
  assert.equal(effectivePolicy(n.store.db, { agent: 'trusted', host: n.host, fromAgent: 'outsider', fromHost: n.host }).level, 'ask');
  // The production YOLO lookup has no sender/project arguments: it must fail closed for scoped grants.
  assert.equal(hasClass(n.store.db, 'trusted', n.host, 'permissions').ok, false);
});

test('unpair removes permission authority adopted solely from that pairing', t => {
  const { n, policy, grant } = fixture(t);
  grant(policy());
  n.removePeer('peerhost');
  assert.equal(hasClass(n.store.db, 'trusted', n.host, 'permissions').ok, false);
});

test('unpaired owner cannot authorize new policy via retained trust', t => {
  const { n, sign, policy } = fixture(t);
  n.removePeer('peerhost');
  assert.equal(acceptSigned(n.store.db, sign(policy()), n.host), "not signed by this host's owner");
});

test('remote-only issued policy must be retained for the advertised pull retry', t => {
  const { n, sign, policy } = fixture(t);
  const rec = policy({ hosts: ['remotehost'] });
  // publish's local stage on the issuing machine. No network delivery can supply the missing durable record.
  assert.equal(issueSigned(n.store.db, sign(rec), n.host), null);
  assert.match(acceptSigned(n.store.db, sign(rec), n.host)!, /not reviewhost/, 'a receiver still rejects it');
  assert.equal(signedRecords(n).some(s => s.rec.id === rec.id), true);
});
