import { writeFileSync } from "node:fs";

/** Native queue protocol stub, persisted across helper processes; only adds enter the existing wake log. */
export function writeCodexQueueStub(path: string, options: { format?: "session" | "args" | "argv"; onAdd?: string; beforeInitialize?: string; onList?: string } = {}) {
  writeFileSync(path, `#!${process.execPath}
(async () => {
const fs = await import('node:fs'), { createInterface } = await import('node:readline'), { DatabaseSync } = await import('node:sqlite');
const path = ${JSON.stringify(path + '.queue.json')};
const load = () => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : [];
const save = rows => fs.writeFileSync(path, JSON.stringify(rows));
${options.beforeInitialize ?? ''}
createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line), p = request.params; let result;
 if (request.method === 'initialize') result = {};
 else if (request.method === 'initialized') return;
 else if (request.method === 'thread/queue/list') {
  result = { data: load().filter(x => x.threadId === p.threadId), nextCursor: null };
  ${options.onList ?? ''}
 }
 else if (request.method === 'thread/queue/delete') {
  const rows = load(), next = rows.filter(x => !(x.threadId === p.threadId && x.id === p.queuedSubmissionId));
  save(next); result = { deleted: rows.length !== next.length };
 } else if (request.method === 'thread/queue/add') {
  const text = p.input.map(x => x.text ?? '').join(''), args = ['queue', '--thread', p.threadId, '--message', text];
  if (process.env.MBX_TEST_WAKE_LOG) fs.appendFileSync(process.env.MBX_TEST_WAKE_LOG,
    ${JSON.stringify(options.format)} === 'args' ? args.map(a => a + '\\x1f').join('') + '\\n'
    : ${JSON.stringify(options.format)} === 'argv' ? args.join(' ') : p.threadId + '\\n');
  if (process.env.MBX_TEST_DB && process.env.MBX_TEST_MARKERS) {
   const db = new DatabaseSync(process.env.MBX_TEST_DB, { readOnly: true });
   for (const row of db.prepare("SELECT v FROM kv WHERE k GLOB 'wake-attempt:*'").all()) fs.appendFileSync(process.env.MBX_TEST_MARKERS, row.v + '\\n');
   db.close();
  }
  const rows = load(), item = { id: 'queued-' + p.clientUserMessageId, clientUserMessageId: p.clientUserMessageId, threadId: p.threadId, input: p.input };
  rows.push(item); save(rows);
  ${options.onAdd ?? ''}
  if (process.env.MBX_TEST_KILL) process.exit(1); // lost reply after persistence, no native wake duplication
  result = { queuedSubmission: item };
 } else throw new Error('unexpected method ' + request.method);
 process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
})();
`, { mode: 0o700 });
}
