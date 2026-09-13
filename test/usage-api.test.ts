import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app/server.ts';
import { setupToken } from '../src/app/security.ts';
import { UsageLedger, chatRate } from '../src/app/usage.ts';

test('usage API protects receipts, snapshots model rates, validates input and exports every matching row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-api-'));
  const app = createApp({ dataDir: dir, uiDir: resolve('ui'), origin: 'http://localhost:3900', startWorker: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = '', csrf = '';
  const request = (path: string, method = 'GET', payload?: unknown, withCsrf = true) => fetch(origin + path, { method, headers: { cookie, origin: 'http://localhost:3900', ...(withCsrf ? { 'x-csrf-token': csrf } : {}), 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  try {
    assert.equal((await request('/api/usage')).status, 401); assert.equal((await request('/api/usage/export')).status, 401);
    const setup = await request('/api/setup', 'POST', { token: setupToken(app.store), password: 'isolated-test-password-34981' });
    assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie')!.split(';')[0]!; csrf = (await setup.json() as { csrf: string }).csrf;
    const ledger = new UsageLedger(app.store), provider = 'glm', model = 'glm-5.2', key = 'glm:glm-5.2';
    const entries = [];
    for (let i = 0; i < 3; i++) entries.push(ledger.begin({ brandId: i === 2 ? 'other' : 'nord', action: 'page-profile', provider, model, rate: chatRate(app.store, provider, model), estimatedMicros: 20000 }));
    const body = await (await request('/api/usage?brand=nord&limit=1')).json() as { totals: { requests: number }; entries: unknown[]; hasMore: boolean };
    assert.equal(body.totals.requests, 2); assert.equal(body.entries.length, 1); assert.equal(body.hasMore, true);
    assert.equal((await request('/api/usage?from=2026-02-30')).status, 400);
    const update = { key, input: 10, output: 20, cached: 1 };
    assert.equal((await request('/api/usage/pricing', 'POST', update, false)).status, 403);
    assert.equal((await request('/api/usage/pricing', 'POST', { ...update, key: 'unknown:model' })).status, 400);
    assert.equal((await request('/api/usage/pricing', 'POST', { ...update, cached: -1 })).status, 400);
    assert.equal((await request('/api/usage/pricing', 'POST', update)).status, 200);
    const later = ledger.begin({ brandId: 'nord', action: 'page-profile', provider, model, rate: chatRate(app.store, provider, model), estimatedMicros: 20000 });
    assert.equal(later.rate.input, 10); assert.equal(ledger.get(entries[0]!.id)!.rate.input, 1.4);
    ledger.response(entries[0]!.id, Response.json({}), { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 500 } } });
    assert.equal(ledger.get(entries[0]!.id)!.costMicros, 1710);
    const exported = await request('/api/usage/export?brand=nord&limit=1&offset=100');
    assert.equal(exported.status, 200); assert.match(exported.headers.get('content-type')!, /text\/csv/);
    const text = await exported.text(); assert.ok(text.includes(entries[0]!.id)); assert.ok(text.includes(entries[1]!.id)); assert.ok(text.includes(later.id)); assert.ok(!text.includes(entries[2]!.id));
    assert.ok(text.includes('0.001710')); assert.ok(text.includes('agentRole')); assert.ok(text.includes('rateSnapshot'));
    const unsafe = ledger.begin({ brandId: '=1+2', action: 'comment-draft', provider, model, rate: chatRate(app.store, provider, model), estimatedMicros: 1 });
    const csv = await (await request('/api/usage/export?brand=%3D1%2B2')).text(); assert.ok(csv.includes(unsafe.id)); assert.ok(csv.includes("'=1+2"));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
