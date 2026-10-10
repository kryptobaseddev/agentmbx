import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MbxNode} from '../src/node.ts';
import {sameProcess,_resetProcCache} from '../src/proc.ts';
import {opencodePermissionPass,decidePermission} from '../src/permission.ts';
import {within} from '../src/policy.ts';

function fixture(t: {after:(fn:()=>void)=>void}) {
 const n=new MbxNode(mkdtempSync(join(tmpdir(),'mbx-followup-')), {host:'reviewhost'});
 t.after(()=>n.close()); return n;
}
test('legacy binding without process birth proof cannot authorize unknown session',async t=>{
 const n=fixture(t);
 n.bindSession({agent:'trusted',cli:'codex',session_id:'old-mcp',pid:process.pid,session_key:'key'});
 n.store.db.prepare('UPDATE sessions SET pid_start=NULL').run();
 const d=await decidePermission({hook_event_name:'PermissionRequest',session_id:'new-thread',tool_name:'Bash',cwd:'/tmp'},'codex',()=>({ok:true}),{node:n,pid:process.pid});
 assert.equal(d.allow,false);
});
test('process inspection failure cannot treat mismatched birth identity as verified',()=>{
 const prior=process.env.PATH;
 try {
  process.env.PATH='/nonexistent-agentmbx-review-bin'; _resetProcCache();
  assert.equal(sameProcess(process.pid,'definitely-not-this-process'),false);
 } finally {process.env.PATH=prior; _resetProcCache();}
});
test('OpenCode approval rejects obsolete dead process binding',async t=>{
 const n=fixture(t);
 n.bindSession({agent:'trusted',cli:'opencode',session_id:'ses-old',pid:2147483647,cwd:'/allowed'});
 n.store.db.prepare('UPDATE sessions SET updated_at=?').run('2000-01-01T00:00:00.000Z');
 let posts=0;
 const fake=async (_url: unknown, opts?: RequestInit)=>{
  if(opts?.method==='POST'){posts++;return Response.json({});}
  return Response.json({data:[{id:'per-one',sessionID:'ses-old',action:'Bash'}]});
 };
 await opencodePermissionPass(n,()=>({ok:true}),async()=>({url:'http://test.invalid',auth:''}),fake as typeof fetch);
 assert.equal(posts,0);
});
test('project containment fails closed for missing target behind outward symlink',t=>{
 const n=fixture(t);
 const root=realpathSync(n.home), allowed=join(root,'allowed'), outside=join(root,'outside');
 mkdirSync(allowed);mkdirSync(outside);symlinkSync(outside,join(allowed,'escape'));
 assert.equal(within(join(allowed,'escape','not-created'),[allowed]),false);
});
