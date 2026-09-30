// Isolated synthetic SQL/process benchmark. Never opens a configured/user MBX_HOME.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { procTable, _resetProcCache } from '../src/proc.ts';
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1000, 10000, 100000);
assert(sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
const measure = (fn, count = 30) => {
  for (let i = 0; i < 3; i++) fn();
  const cpu = process.cpuUsage(), samples = [];
  for (let i = 0; i < count; i++) { const t = performance.now(); fn(); samples.push(performance.now() - t); }
  samples.sort((a,b) => a-b);
  return { median_ms: samples[Math.floor(count/2)], p95_ms: samples[Math.ceil(count*.95)-1], cpu_us: process.cpuUsage(cpu), iterations: count };
};
const result = { environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, workloads: [] };
for (const size of sizes) {
  const home = mkdtempSync(join(tmpdir(), 'agentmbx-benchmark-'));
  const store = new Store(home, { allowIdentityMigration: true }), db = store.db;
  try {
    const start = performance.now();
    const insert = db.prepare('INSERT INTO messages(id,ts,from_addr,thread,kind,subject,body,envelope,origin,trust,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const deliver = db.prepare('INSERT INTO deliveries(msg_id,agent,state,updated_at) VALUES (?,?,?,?)');
    const outgoing = db.prepare('INSERT INTO outbox(msg_id,host,next_at,created_at) VALUES (?,?,?,?)');
    const control = db.prepare('INSERT INTO kv(k,v) VALUES (?,?)');
    store.tx(() => {
      for (let i=0;i<size;i++) {
        const id = String(i).padStart(12,'0'), ts = new Date(1700000000000+i).toISOString(), agent = `agent-${i%100}`;
        insert.run(id,ts,`${agent}@bench`,`thread-${i%100}`, 'note','synthetic handoff', 'benchmark body '.repeat(16),'{}','local','local',ts);
        deliver.run(id,agent,i%3 ? 'delivered':'acked',ts);
        if (i%5===0) { outgoing.run(id,'peer-a',ts,ts); outgoing.run(id,'peer-b',ts,ts); }
        // Archived receipts make polling realistic; 1 pending request at each size.
        control.run(`identity-request:${id}`, JSON.stringify({status:i===size-1?'pending':'completed',target:{control_key:'benchmark-control'}}));
      }
    });
    const insertMs = performance.now()-start;
    const queries = {
      outbox: {sql:'SELECT count(DISTINCT o.msg_id) n FROM outbox o JOIN messages m ON m.id=o.msg_id WHERE m.from_addr=?', args:['agent-0@bench']},
      inbox: {sql:"SELECT m.*,d.state FROM deliveries d JOIN messages m ON m.id=d.msg_id WHERE d.agent=? AND d.state<>'acked' ORDER BY m.ts LIMIT ?",args:['agent-0',50]},
      history: {sql:'SELECT * FROM messages WHERE thread=? ORDER BY ts',args:['thread-0']},
      control_poll: {sql:"SELECT v FROM kv WHERE k GLOB 'identity-request:*' AND CASE WHEN json_valid(v) THEN json_extract(v,'$.status')='pending' AND json_extract(v,'$.target.control_key')=? ELSE 0 END LIMIT 20",args:['benchmark-control']}
    };
    const run = () => Object.fromEntries(Object.entries(queries).map(([name,q]) => {
      const s = db.prepare(q.sql), rows = s.all(...q.args);
      if(name==='outbox') assert.equal(rows[0].n,Math.ceil(size/100));
      if(name==='inbox') assert(rows.length<=50 && rows.every(r=>r.from_addr==='agent-0@bench' && r.state!=='acked'));
      if(name==='history') assert.equal(rows.length,Math.ceil(size/100));
      if(name==='control_poll') assert.equal(rows.length,1);
      return [name,{...measure(()=>s.all(...q.args)),rows:rows.length,plan:db.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.args).map(r=>r.detail)}];
    }));
    const baseline = run();
    db.exec('CREATE INDEX benchmark_messages_sender ON messages(from_addr,id)');
    const sender_index = run();
    db.exec('CREATE INDEX benchmark_pending_control ON kv(json_extract(v,\'$.target.control_key\')) WHERE k GLOB \'identity-request:*\' AND CASE WHEN json_valid(v) THEN json_extract(v,\'$.status\')=\'pending\' ELSE 0 END');
    const indexedPoll = db.prepare("SELECT v FROM kv WHERE k GLOB 'identity-request:*' AND CASE WHEN json_valid(v) THEN json_extract(v,'$.status')='pending' ELSE 0 END AND json_extract(v,'$.target.control_key')=? LIMIT 20");
    assert.equal(indexedPoll.all('benchmark-control').length,1);
    result.workloads.push({size,agents:100,peers:2,insert_ms:insertMs,baseline,sender_index,pending_index:{...measure(()=>indexedPoll.all('benchmark-control')),plan:db.prepare('EXPLAIN QUERY PLAN '+indexedPoll.sourceSQL).all('benchmark-control').map(r=>r.detail)},database_bytes:statSync(join(home,'mbx.db')).size,wal_bytes:statSync(join(home,'mbx.db-wal')).size,rss_bytes:process.memoryUsage().rss});
  } finally {store.close();rmSync(home,{recursive:true,force:true});}
}
result.process_snapshot = {fresh:measure(()=>{_resetProcCache();assert(procTable(0).has(process.pid));},10),cached:measure(()=>assert(procTable().has(process.pid)),100)};
console.log(JSON.stringify(result,null,2));
