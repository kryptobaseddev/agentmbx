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

for (const seed of ["none", "dead", "unknown"] as const) test(`shared-connection exclusion is atomic (${seed} owner)`, { skip: !supported, timeout: 12000 }, t => {
  const home = mkdtempSync(join(tmpdir(), "mbx-connection-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const worker = `import {claimMcpConnection,startMcpLifecycle} from ${JSON.stringify(lifecycleUrl)};
    const life=startMcpLifecycle(${JSON.stringify(home)}); const end=Date.now()+1500; let claim;
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
    const timer=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(2)},7000);
    let exited=0;for(const c of children)c.on('exit',()=>{if(++exited===8){clearTimeout(timer);process.exit(0)}});`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:MBX_MCP_|CLAUDE_|CODEX_|CLEO_|ORCA_)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", manager], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const { reports, unchanged, alive } = JSON.parse(result.stdout);
  assert.equal(alive, true, "all contenders retain the pipe until the contention result is captured");
  if (seed === "unknown") { assert.equal(unchanged, true); assert.ok(reports.every((r: { state: string }) => r.state === "unknown")); }
  else { assert.equal(reports.filter((r: { state: string }) => r.state === "held").length, 1); assert.equal(reports.filter((r: { state: string }) => r.state === "duplicate").length, 7); }
});
