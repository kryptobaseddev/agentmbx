import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { wakeOpencode } from '../src/wake.ts';

/** The legacy fields; the typed outcome (T178) is asserted separately. */
const legacy = ({ outcome: _o, ...r }: { outcome?: unknown } & Record<string, unknown>) => r;
const session = 'ses_contract', text = 'check the mailbox';
const service = async () => ({ url: 'http://127.0.0.1:1', auth: 'Basic fixture' });
/** T524: these exercise the service-hosted path; a standalone host never reaches the endpoint. */
const host = () => 'service' as const;
const valid = () => ({ id: 'msg_fixture', sessionID: session, type: 'synthetic', delivery: 'queue', payload: { text }, time: { created: 1 } });
for (const data of [undefined, null, [], {}, ...[
  { id: '' }, { id: 'unexpected' }, { sessionID: 'ses_other' }, { type: 'user' }, { delivery: 'steer' },
  { payload: { text: 'different' } }, { payload: null }, { time: {} }, { time: { created: '1' } },
].map(p => ({ ...valid(), ...p }))]) {
  test(`invalid admission ${JSON.stringify(data)} fails`, async () => {
    const r = await wakeOpencode(session, text, { host, service, fetch: (async () => Response.json({ data })) as typeof fetch });
    assert.equal(r.ok, false);
  });
}
for (const body of ['', '<html>login</html>', '{']) test(`invalid JSON body ${body} fails`, async () => {
  const r = await wakeOpencode(session, text, { host, service, fetch: (async () => new Response(body)) as typeof fetch });
  assert.equal(r.ok, false);
});
test('matching receipt confirms admission with exactly one submission', async () => {
  let calls = 0;
  const r = await wakeOpencode(session, text, { host, service, fetch: (async (url, init) => {
    calls++; assert.equal(String(url), `http://127.0.0.1:1/api/session/${session}/synthetic`);
    assert.deepEqual(JSON.parse(init!.body as string), { text, delivery: 'queue', resume: true });
    return Response.json({ data: valid() });
  }) as typeof fetch });
  assert.deepEqual(legacy(r), { ok: true, via: 'opencode synthetic' }); assert.equal(r.outcome?.kind, 'admitted'); assert.equal(calls, 1);
});
test('HTTP rejection is failure even with a valid-looking receipt', async () => {
  const r = await wakeOpencode(session, text, { host, service, fetch: (async () => Response.json({ data: valid() }, { status: 409 })) as typeof fetch });
  assert.equal(r.ok, false);
});
test('synthetic redirect is not followed', async t => {
  let redirected = 0;
  const http = createServer((req, res) => {
    if (req.url === '/elsewhere') { redirected++; res.end(JSON.stringify({ data: valid() })); return; }
    res.writeHead(307, { location: '/elsewhere' }); res.end();
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const r = await wakeOpencode(session, text, { host, service: async () => ({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, auth: '' }) });
  assert.equal(r.ok, false); assert.equal(redirected, 0);
});
