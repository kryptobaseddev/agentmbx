import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {MbxNode} from '../src/node.ts';
import {canonical,generateKeyPair,signData} from '../src/crypto.ts';
import {acceptSigned,makeDevice,makePolicy,makeRevocation,hasClass,ownerKeys,type AnyRecord} from '../src/policy.ts';
function fixture(t: {after:(fn:()=>void)=>void}) {
 const n=new MbxNode(mkdtempSync(join(tmpdir(),'mbx-device-review-')),{host:'target'});t.after(()=>n.close());
 const key=generateKeyPair(),peer=generateKeyPair();
 n.addApprovedPeer({host:'source',pubkey:peer.publicKey,owner_pubkey:key.publicKey,addr:'127.0.0.1:1'},'test');
 const sign=(rec:AnyRecord)=>({rec,sig:signData(key.privateKey,canonical(rec))});
 const device=sign(makeDevice(n.host,n.key.publicKey,key.publicKey));
 const policy=sign(makePolicy({level:'yolo',agents:['worker'],hosts:[n.host],ownerPub:key.publicKey,now:new Date(Date.now()-1000)}));
 const accept=(s:ReturnType<typeof sign>)=>acceptSigned(n.store.db,s,n.host,{hostPub:n.key.publicKey});
 return {n,key,sign,device,policy,accept};
}
test('device-adopted trust is removed when the sole originating peer is unpaired',t=>{
 const {n,device,policy,accept}=fixture(t);assert.equal(accept(device),null);assert.equal(accept(policy),null);
 n.removePeer('source');assert.equal(hasClass(n.store.db,'worker',n.host,'permissions').ok,false);
});
test('first synchronization cannot activate policy whose preceding revocation was rejected before adoption',t=>{
 const {n,key,sign,device,policy,accept}=fixture(t);
 const kill=sign(makeRevocation('*',key.publicKey));
 // the worst order for the receiver: kill switch, then the device record that adopts its signer, then the policy.
 // (adapted: revocations are now kept from any known owner key, scoped to that key's own policies, so the first
 // accept succeeds instead of being silently dropped; the invariant under test is that the policy stays dead)
 const errors=[accept(kill),accept(device),accept(policy)];
 assert.equal(errors[0],null);
 assert.equal(hasClass(n.store.db,'worker',n.host,'permissions').ok,false);
});
test('a different paired owner cannot replace an already-adopted owner with its own device certificate',t=>{
 const {n,key,device,accept}=fixture(t);assert.equal(accept(device),null);
 const second=generateKeyPair(),peer=generateKeyPair();
 n.addApprovedPeer({host:'second',pubkey:peer.publicKey,owner_pubkey:second.publicKey,addr:'127.0.0.1:2'},'test');
 const rec=makeDevice(n.host,n.key.publicKey,second.publicKey);
 acceptSigned(n.store.db,{rec,sig:signData(second.privateKey,canonical(rec))},n.host,{hostPub:n.key.publicKey});
 assert.deepEqual(ownerKeys(n.store.db),[key.publicKey]);
});
test('owner confirmation must expose or reject wildcard hidden after eight named recipients',t=>{
 if(process.platform!=='darwin'){t.skip('macOS helper');return;}
 const dir=mkdtempSync(join(tmpdir(),'mbx-summary-review-')), helper=join(dir,'auth');
 execFileSync('swiftc',['-Onone',resolve('macos/Auth/main.swift'),'-o',helper],{timeout:180000,stdio:'pipe'});
 const owner=generateKeyPair();
 const rec=makePolicy({level:'autonomous',agents:['one','two','three','four','five','six','seven','eight','*'],hosts:['target'],ownerPub:owner.publicKey});
 const file=join(dir,'payload.json');writeFileSync(file,canonical(rec));
 // summary invokes no Keychain access, signature, or human prompt.
 const summary=execFileSync(helper,['summary',file],{encoding:'utf8'});
 assert.match(summary, /\*|all agents|any agent/i, summary);
});
