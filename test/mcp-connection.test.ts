import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const lifecycleUrl = pathToFileURL(resolve("src/mcp-lifecycle.ts")).href;
const procUrl = pathToFileURL(resolve("src/proc.ts")).href;
const supported = process.platform === "darwin" || process.platform === "linux";
// Retry budget includes scheduling delays; each enclosing process gets time to collect and clean up.
const claimTimeout = 10_000;

for (const seed of ["none", "dead", "unknown"] as const) test(`shared-connection exclusion is atomic (${seed} owner)`, { skip: !supported, timeout: claimTimeout + 15_000 }, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-connection-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const worker = `import {claimMcpConnection,startMcpLifecycle} from ${JSON.stringify(lifecycleUrl)};
    const life=startMcpLifecycle(${JSON.stringify(home)}); const end=Date.now()+${claimTimeout}; let claim;
    do {claim=life.claimConnection(); if(claim.state==='retry')await new Promise(r=>setTimeout(r,10));}while(claim.state==='retry'&&Date.now()<end);
    process.stderr.write(JSON.stringify({pid:process.pid,state:claim.state})+'\\n');`;
  const manager = `import {spawn} from 'node:child_process'; import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto'; import {stdioEndpoint} from ${JSON.stringify(procUrl)};
    const dir=${JSON.stringify(join(home, "mcp-connections"))};mkdirSync(dir,{recursive:true});
    const path=dir+'/'+createHash('sha256').update(stdioEndpoint()).digest('hex');
    const seed=${JSON.stringify(seed)}, body=JSON.stringify({pid:seed==='dead'?2000000000:process.pid,start:'unparseable birth'});
    if(seed!=='none')writeFileSync(path,body);
    const children=[],reports=[];
    for(let i=0;i<8;i++){const c=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(worker)}],{stdio:['inherit','inherit','pipe']});children.push(c);
      let buf='';c.stderr.on('data',data=>{buf+=data;const lines=buf.split('\\n');buf=lines.pop();for(const line of lines)if(line.startsWith('{'))reports.push(JSON.parse(line));
        if(reports.length===8){console.log(JSON.stringify({reports,alive:children.every(p=>p.exitCode===null),unchanged:seed==='unknown'?readFileSync(path,'utf8')===body:null}));for(const p of children)p.kill('SIGTERM');}});}
    const timer=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(2)},${claimTimeout + 5_000});
    let exited=0;for(const c of children)c.on('exit',()=>{if(++exited===8){clearTimeout(timer);process.exit(0)}});`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:MBX_MCP_|CLAUDE_|CODEX_|CLEO_|ORCA_)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", manager], { env, encoding: "utf8", timeout: claimTimeout + 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const { reports, unchanged, alive } = JSON.parse(result.stdout);
  assert.equal(alive, true, "all contenders retain the pipe until the contention result is captured");
  if (seed === "unknown") { assert.equal(unchanged, true); assert.ok(reports.every((r: { state: string }) => r.state === "unknown")); }
  else { assert.equal(reports.filter((r: { state: string }) => r.state === "held").length, 1, JSON.stringify(reports)); assert.equal(reports.filter((r: { state: string }) => r.state === "duplicate").length, 7, JSON.stringify(reports)); }
});

test("connection claim retries when a stale owner disappears before it is read", { skip: !supported }, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-connection-reap-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const worker = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {createHash} from 'node:crypto'; import {stdioEndpoint} from ${JSON.stringify(procUrl)};
    import {claimMcpConnection} from ${JSON.stringify(lifecycleUrl)};
    const dir=${JSON.stringify(join(home, "mcp-connections"))};fs.mkdirSync(dir,{recursive:true});
    const path=dir+'/'+createHash('sha256').update(stdioEndpoint()).digest('hex');
    fs.writeFileSync(path,JSON.stringify({pid:2000000000,start:'unparseable birth'}));
    const link=fs.linkSync;
    fs.linkSync=(from,to)=>{try{return link(from,to)}catch(error){
      if(error.code==='EEXIST'&&to===path)fs.unlinkSync(path);throw error;
    }};
    syncBuiltinESMExports();
    const first=claimMcpConnection(${JSON.stringify(home)}), second=claimMcpConnection(${JSON.stringify(home)});
    if(second.state==='held')second.release();
    console.log(JSON.stringify({first:first.state,second:second.state}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", worker], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { first: "retry", second: "held" });
});
