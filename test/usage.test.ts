import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/app/store.ts';
import { UsageLedger, tokenRate, videoRate, chatRate } from '../src/app/usage.ts';
import { MiniMaxProvider } from '../src/generation/minimax.ts';
import type { GenerationSpec } from '../src/generation/provider.ts';
import { DEFAULT_SETTINGS } from '../src/app/types.ts';
import { Production } from '../src/app/production.ts';
import { workspace, fixture } from './support/mock-workspace.ts';
import { planFor } from '../src/app/planner.ts';

const day = '2026-09-13';
const base: GenerationSpec = { modelId: 'MiniMax-H3', prompt: 'A ceramic vessel in soft daylight.', durationSeconds: 8, aspectRatio: '9:16', resolution: '768p', audio: true };
const usageParams = () => new URLSearchParams();
const receipt = (extra: Record<string, unknown> = {}) => ({ task: { id: 'task-1', model: 'MiniMax-H3', status: 'succeeded', resolution: '768P', duration: 8, ratio: '9:16', task_type: 'generation', content: { url: 'https://media.example.com/shot.mp4' }, usage: { input_seconds: 0, output_seconds: 8, input_image_count: 1, prompt_tokens: 1200, completion_tokens: 200000, total_tokens: 201200 }, ...extra } });
function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-usage-')), store = new Store(dir), ledger = new UsageLedger(store);
  return { dir, store, ledger, clean() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function context(key: string) { return { brandId: 'nord', provider: 'openai', model: 'gpt-4.1-mini', action: 'creative-copy' as const, effectKey: key, rate: tokenRate(0.4, 1.6, 0.1, 'test rate'), estimatedMicros: 10000 }; }

test('H3 uses the v2 multimodal contract and meters 768P in seconds', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const p = new MiniMaxProvider({ apiKey: 'injected', fetchImpl: async (u, init) => {
    calls.push({ url: String(u), init });
    return init?.method === 'POST' ? Response.json({ task_id: 'task-1' }, { headers: { 'x-request-id': 'req-1' } }) : Response.json(receipt());
  } });
  const spec = { ...base, referenceImages: [{ kind: 'uri' as const, uri: 'https://example.com/product.png', mimeType: 'image/png' as const }] };
  const submitted = await p.submit(spec), result = await p.poll(submitted.taskId);
  assert.equal(submitted.estimate.microUnits, 640000); assert.equal(submitted.requestId, 'req-1');
  assert.equal(calls[0]!.url, 'https://api.minimax.io/v2/video_generation');
  assert.equal(calls[1]!.url, 'https://api.minimax.io/v2/query/video_generation/task-1');
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.resolution, '768P'); assert.equal(body.ratio, '9:16'); assert.equal(body.duration, 8);
  assert.equal(body.content[1].role, 'reference_image'); assert.equal(body.generate_audio, undefined); assert.equal(body.audio, undefined);
  assert.equal(result.billedUnits, 8); assert.equal(result.usage!['total_tokens'], 201200); assert.equal(result.videos[0]!.uri, 'https://media.example.com/shot.mp4');
});
for (const [field, patch] of Object.entries({ duration: { durationSeconds: 3 }, fractional: { durationSeconds: 8.5 }, resolution: { resolution: '720p' }, model: { modelId: 'MiniMax-H3-Max' }, audio: { audio: false }, ratio: { aspectRatio: '4:5' }, adaptiveText: { aspectRatio: 'adaptive' }, prompt: { prompt: '' }, tooLong: { prompt: 'a'.repeat(7001) }, samples: { samples: 2 }, seed: { seed: 42 } })) test(`H3 refuses unsupported ${field} before a paid call`, async () => {
  let calls = 0; const p = new MiniMaxProvider({ apiKey: 'test', fetchImpl: async () => { calls++; throw new Error('Unexpected paid request'); } });
  await assert.rejects(p.submit({ ...base, ...patch } as GenerationSpec)); assert.equal(calls, 0);
});
test('H3 image charges include every image above the free five', () => {
  const p = new MiniMaxProvider({ apiKey: 'test' }), image = { kind: 'uri' as const, uri: 'https://example.com/product.png', mimeType: 'image/png' as const };
  assert.equal(p.estimateCost({ ...base, referenceImages: Array(7).fill(image) }).microUnits, 720000);
  assert.equal(videoRate(p.estimateCost({ ...base, referenceImages: Array(7).fill(image) })).perSecond, 0.08);
  assert.throws(() => p.estimateCost({ ...base, firstFrame: image }), /keyframes determine/);
  assert.throws(() => p.estimateCost({ ...base, referenceImages: [image], firstFrame: image }), /cannot mix/);
  assert.throws(() => p.estimateCost({ ...base, referenceImages: Array(10).fill(image) }), /nine/);
});
for (const patch of [{ id: 'different-task' }, { model: 'MiniMax-H3-Max' }, { status: 'new-status' }, { resolution: '2K' }, { task_type: 'regeneration' }]) test(`H3 rejects inconsistent task receipt ${JSON.stringify(patch)}`, async () => {
  const p = new MiniMaxProvider({ apiKey: 'test', fetchImpl: async () => Response.json(receipt(patch)) }); await assert.rejects(p.poll('task-1'));
});
test('cache and reasoning tokens are retained without double charging', () => {
  const w = storeFixture(); try {
    const e = w.ledger.begin(context('copy:run:0'), { day, limitUsd: 1 });
    w.ledger.response(e.id, Response.json({}), { id: 'resp-1', usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200, input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 50 }, private_key: 'must-not-be-retained' } });
    const row = w.ledger.get(e.id)!;
    assert.equal(row.costMicros, 480); assert.equal(row.metrics.totalTokens, 1200); assert.equal(row.metrics.reasoningTokens, 50);
    assert.equal(row.agentRole, 'copywriter'); assert.equal(row.metrics.cachedTokens, 800); assert.equal(row.requestId, 'resp-1');
    assert.equal(row.costStatus, 'calculated'); assert.equal(w.store.spent('nord', day), 480);
    assert.ok(!JSON.stringify(row).includes('must-not-be-retained'));
    w.ledger.failure(e.id, 'Response was rejected by creative validation.');
    assert.equal(w.ledger.get(e.id)!.costMicros, 480); assert.equal(w.ledger.get(e.id)!.state, 'failed');
  } finally { w.clean(); }
});
test('budgets and effects are acquired atomically across SQLite connections', () => {
  const w = storeFixture(), second = new Store(w.dir); try {
    w.ledger.begin(context('first'), { day, limitUsd: 0.015 });
    assert.throws(() => new UsageLedger(second).begin(context('second'), { day, limitUsd: 0.015 }), /allowance/);
    assert.equal(second.effect('second'), undefined); assert.equal(w.ledger.query(usageParams()).entries.length, 1);
    assert.throws(() => new UsageLedger(second).begin(context('first'), { day, limitUsd: 1 }), /recorded outcome/);
    assert.equal(w.store.spent('nord', day), 10000);
  } finally { second.close(); w.clean(); }
});
test('definitive rejection releases its reservation and retries retain separate receipts', () => {
  const w = storeFixture(); try {
    const first = w.ledger.begin(context('same-effect'), { day, limitUsd: 1 });
    w.ledger.response(first.id, new Response(null, { status: 429 })); w.store.failEffect('same-effect', 'rate limited');
    const second = w.ledger.begin(context('same-effect'), { day: '2026-09-14', limitUsd: 1 });
    assert.equal(first.attempt, 1); assert.equal(second.attempt, 2); assert.notEqual(first.chargeKey, second.chargeKey);
    assert.equal(w.store.spent('nord', day), 0); assert.equal(w.store.spent('nord', '2026-09-14'), 10000);
    assert.equal(w.ledger.query(usageParams()).entries.length, 2); assert.equal(w.ledger.get(first.id)!.costStatus, 'not-charged');
  } finally { w.clean(); }
});
test('timeouts retain cost exposure and never become a free request or automatic retry', () => {
  const w = storeFixture(); try {
    const e = w.ledger.begin(context('unknown'), { day, limitUsd: 1 }); w.ledger.failure(e.id, 'Transport closed.');
    assert.equal(w.ledger.get(e.id)!.costStatus, 'unknown'); assert.equal(w.ledger.get(e.id)!.costMicros, null); assert.equal(w.store.spent('nord', day), 10000);
    assert.throws(() => w.ledger.begin(context('unknown'), { day, limitUsd: 1 }), /recorded outcome/);
    const t = w.ledger.query(usageParams()).totals; assert.equal(t['calculatedMicros'], 0); assert.equal(t['estimatedMicros'], 10000); assert.equal(t['unknownRequests'], 1); assert.equal(t['totalTokensReports'], 0);
  } finally { w.clean(); }
});
for (const usage of [{}, { total_tokens: 750 }, { input_tokens: 100, output_tokens: 20 }, { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: -1 } }, { input_tokens: 100, output_tokens: 20, total_tokens: 900 }, { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 120 } }]) test(`incomplete or inconsistent token metrics do not become a claimed actual cost ${JSON.stringify(usage)}`, () => {
  const w = storeFixture(); try { const e = w.ledger.begin(context('incomplete')); w.ledger.response(e.id, Response.json({}), { usage }); assert.equal(w.ledger.get(e.id)!.costMicros, null); assert.equal(w.ledger.get(e.id)!.costStatus, 'estimated'); } finally { w.clean(); }
});
test('H3 receipt charges seconds and extra images, retains tokens, and is idempotent', async () => {
  const w = storeFixture(); try {
    const p = new MiniMaxProvider({ apiKey: 'test', fetchImpl: async () => Response.json(receipt({ usage: { input_seconds: 2, output_seconds: 8, input_image_count: 7, input_audio_seconds: 6, prompt_tokens: 1200, completion_tokens: 200000, total_tokens: 201200 } })) });
    const estimate = p.estimateCost(base), e = w.ledger.begin({ ...context('video:creative:0:0'), action: 'video-generation', provider: 'minimax', model: 'MiniMax-H3', rate: videoRate(estimate), estimatedMicros: estimate.microUnits }, { day, limitUsd: 10 });
    const task = await p.poll('task-1'); w.ledger.task(e.effectKey, task); w.ledger.task(e.effectKey, task);
    assert.equal(w.ledger.get(e.id)!.costMicros, 880000); assert.equal(w.store.spent('nord', day), 880000);
    assert.equal(w.ledger.get(e.id)!.metrics.totalTokens, 201200); assert.equal(w.ledger.get(e.id)!.metrics.inputAudioSeconds, 6);
    w.ledger.task(e.effectKey, { ...task, usage: {}, billedUnits: undefined });
    assert.equal(w.ledger.get(e.id)!.costMicros, 880000);
  } finally { w.clean(); }
});
test('engagement model prices include cached input and select the M3 long-context tier', () => {
  const w = storeFixture(); try {
    const rate = chatRate(w.store, 'minimax', 'MiniMax-M3');
    const e = w.ledger.begin({ ...context('m3'), rate, model: 'MiniMax-M3', provider: 'minimax' });
    w.ledger.response(e.id, Response.json({}), { usage: { prompt_tokens: 600000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 500000 } } });
    assert.equal(w.ledger.get(e.id)!.costMicros, 122400);
  } finally { w.clean(); }
});
test('usage survives restarts and filters and totals are independent of page size', () => {
  const w = storeFixture(); try {
    for (let i = 0; i < 3; i++) w.ledger.begin({ ...context(`req-${i}`), brandId: i === 2 ? 'other' : 'nord' });
    const second = new Store(w.dir); try {
      const result = new UsageLedger(second).query(new URLSearchParams({ brand: 'nord', agent: 'copywriter', limit: '1' }));
      assert.equal(result.entries.length, 1); assert.equal(result.totals['requests'], 2); assert.equal(result.hasMore, true); assert.equal(result.totals['estimatedMicros'], 20000);
      assert.equal(new UsageLedger(second).query(new URLSearchParams({ brand: "' OR 1=1 --" })).entries.length, 0);
      assert.throws(() => w.ledger.query(new URLSearchParams({ from: '2026-02-30' })), /valid/);
      assert.throws(() => w.ledger.query(new URLSearchParams({ offset: '-1' })), /pagination/);
    } finally { second.close(); }
  } finally { w.clean(); }
});
test('legacy allowances and token-only history migrate once without invented billing data', () => {
  const w = storeFixture(); try {
    w.store.setSetting('usageMigration', 0);
    w.store.reserveCharge('copy:old:0', 'nord', day, 12345, 1);
    w.store.db.prepare('INSERT INTO engagement_ai_usage VALUES(?,?,?,?,?)').run('old-chat', 'nord', day, 'glm-5.2', 750);
    const second = new Store(w.dir); second.close(); const third = new Store(w.dir);
    try {
      const rows = new UsageLedger(third).query(usageParams()); assert.equal(rows.entries.length, 2);
      assert.equal(rows.totals['estimatedMicros'], 12345); assert.equal(rows.totals['calculatedMicros'], 0); assert.equal(rows.totals['unpricedRequests'], 1);
      assert.equal(rows.entries.find(e => e.model === 'glm-5.2')!.metrics.inputTokens, null);
    } finally { third.close(); }
  } finally { w.clean(); }
});
test('production runs H3, records each shot and narration, and keeps submitted rates across edits', async () => {
  const w = workspace(); try {
    w.store.setSetting('app', { ...DEFAULT_SETTINGS });
    const b = fixture({ creativesPerCycle: 1, productImage: 'https://example.com/product.png' }); w.store.put('brands', b);
    const r = w.engine.createRun(b.id); r.plan = planFor(b); const [c] = await w.production.draft(b, r);
    assert.equal(c!.provider, 'minimax'); assert.equal(c!.model, 'MiniMax-H3'); await w.production.submit(b, c!);
    w.store.setSetting('app', { ...DEFAULT_SETTINGS, h3UsdPerSecond: 0.2 });
    assert.equal(await w.production.poll(c!), true); await w.production.voice(b, c!, join(w.dir, 'voice.mp3'), false);
    const result = new UsageLedger(w.store).query(usageParams()), videos = result.entries.filter(e => e.action === 'video-generation');
    assert.equal(videos.length, 2); assert.equal(videos.reduce((n, e) => n + e.costMicros!, 0), 1280000);
    assert.ok(videos.every(e => e.runId === r.id && e.creativeId === c!.id && e.agentRole === 'video-producer'));
    assert.equal(result.entries.find(e => e.action === 'narration')!.metrics.characters, Array.from(c!.voiceover).length);
    assert.equal(result.entries.find(e => e.action === 'narration')!.costStatus, 'estimated');
    assert.equal(result.entries.filter(e => e.action === 'creative-copy').length, 1);
  } finally { w.clean(); }
});
test('an H3 download failure preserves its bill and reuses the original task', async () => {
  const w = workspace(); try {
    w.store.setSetting('app', { ...DEFAULT_SETTINGS }); const b = fixture({ creativesPerCycle: 1 }); w.store.put('brands', b);
    const r = w.engine.createRun(b.id); r.plan = planFor(b); const [c] = await w.production.draft(b, r); await w.production.submit(b, c!);
    const broken = new Production(w.store, w.vault, w.services.fetch, async () => { throw new Error('Download interrupted'); });
    await assert.rejects(broken.poll(c!), /Download interrupted/);
    assert.equal(new UsageLedger(w.store).query(usageParams()).entries.find(e => e.shotIndex === 0)!.costMicros, 640000);
    await w.production.poll(c!); assert.equal(w.services.requests.filter(r => r.path === '/v2/video_generation').length, 2);
  } finally { w.clean(); }
});
test('simulation does not record paid AI usage', async () => {
  const w = workspace(); try {
    const b = fixture({ mode: 'SIMULATE', creativesPerCycle: 1 }); w.store.put('brands', b); const r = w.engine.createRun(b.id); r.plan = planFor(b);
    const [c] = await w.production.draft(b, r); await w.production.submit(b, c!, true);
    assert.equal(new UsageLedger(w.store).query(usageParams()).entries.length, 0);
  } finally { w.clean(); }
});
