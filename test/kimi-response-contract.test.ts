import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { wakeKimi } from '../src/wake.ts';

const session = { session_id: 'session_contract', pid: null };
const server = { url: 'http://127.0.0.1:1', token: 'fixture-token' };
const receipt = { code: 0, data: { prompt_id: 'prompt_fixture', status: 'running' } };
const status = { code: 0, data: { busy: false, model: 'fixture-model' } };

for (const data of [undefined, null, [], {}, { busy: 0 }, { busy: 'false' }, { busy: null }, { busy: false, model: 3 }]) {
  test(`invalid status ${JSON.stringify(data)} cannot submit`, async () => {
    let posts = 0;
    const result = await wakeKimi(session, 'check inbox', { server, fetch: (async (_url, init) => {
      if (init?.method === 'POST') { posts++; return Response.json(receipt); }
      return Response.json({ code: 0, data });
    }) as typeof fetch });
    assert.equal(result.ok, false); assert.equal(posts, 0);
  });
}
for (const data of [undefined, null, [], {}, { prompt_id: '', status: 'running' }, { prompt_id: 3, status: 'running' },
  { prompt_id: 'p' }, { prompt_id: 'p', status: 'done' }, { prompt_id: 'p', status: 1 }]) {
  test(`invalid submission receipt ${JSON.stringify(data)} is not success`, async () => {
    const result = await wakeKimi(session, 'check inbox', { server, fetch: (async (_url, init) =>
      Response.json(init?.method === 'POST' ? { code: 0, data } : status)) as typeof fetch });
    assert.equal(result.ok, false);
  });
}
for (const accepted of ['running', 'queued', 'blocked']) {
  test(`valid ${accepted} receipt means accepted submission only`, async () => {
    const result = await wakeKimi(session, 'check inbox', { server, fetch: (async (_url, init) =>
      Response.json(init?.method === 'POST' ? { code: 0, data: { prompt_id: 'p', status: accepted } } : status)) as typeof fetch });
    assert.deepEqual(result, { ok: true, via: 'kimi web' });
  });
}
for (const stage of ['status', 'config', 'prompts']) {
  test(`does not follow ${stage} redirects`, async t => {
    let redirected = 0;
    const http = createServer((req, res) => {
      if (req.url === '/redirect-target') { redirected++; res.end(JSON.stringify(receipt)); return; }
      if (req.url?.endsWith('/' + stage)) { res.writeHead(307, { location: '/redirect-target' }); res.end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/status') ? { code: 0, data: { busy: false } } : receipt));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => { http.closeAllConnections(); http.close(); });
    const result = await wakeKimi(session, 'check inbox', { server: { ...server, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` } });
    assert.equal(redirected, 0);
    if (stage !== 'config') assert.equal(result.ok, false);
  });
}

test('Kimi msg error field is reported', async () => {
  const result = await wakeKimi(session, 'check inbox', { server, fetch: (async () =>
    Response.json({ code: 40401, msg: 'session is missing', data: null })) as typeof fetch });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /session is missing/);
});
