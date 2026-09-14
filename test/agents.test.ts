import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { workspace, fixture, MockProduction } from './support/mock-workspace.ts';
import { Store } from '../src/app/store.ts';
import { Registry } from '../src/agents/registry.ts';
import { ModelRouter } from '../src/agents/router.ts';
import { modelFetch } from '../src/agents/transport.ts';
import { AgentCoordinator } from '../src/agents/coordinator.ts';
import { Economics } from '../src/agents/economics.ts';
import { BrandMemory } from '../src/agents/memory.ts';
import { quoteWorkflow } from '../src/agents/forecast.ts';
import { UsageLedger, tokenRate } from '../src/app/usage.ts';
import { DEFAULT_STUDIO } from '../src/agents/registry.ts';
import { DEFAULT_SETTINGS, nowIso, type CampaignRun, type Metric, type Creative } from '../src/app/types.ts';
import { objectSchema, type Adapter, type AgentTask } from '../src/agents/contracts.ts';
import { Engine } from '../src/app/engine.ts';
import { planFor } from '../src/app/planner.ts';
import { studioApi } from '../src/agents/api.ts';

const schema = objectSchema({ answer: { type: 'string', maxLength: 100 } });
function modelInput(adapter: Adapter = 'chat', id = 'custom-model') { return { id, name: 'Configured model', provider: 'custom', adapter, endpoint: 'https://models.example.com/v1', model: 'owner-chosen-model', capabilities: adapter === 'speech' ? ['speech'] : ['text', 'json', 'vision'], apiKey: 'private-test-credential', rates: { input: 1, output: 2, cached: 0.5 }, jsonMode: 'schema' }; }
function envelopes(adapter: Adapter, answer: unknown = { answer: 'Validated result' }) {
  const text = JSON.stringify(answer);
  if (adapter === 'responses') return { status: 'completed', id: 'receipt-r', output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } } };
  if (adapter === 'anthropic') return { stop_reason: 'end_turn', id: 'receipt-a', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (adapter === 'gemini') return { responseId: 'receipt-g', candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 15, thoughtsTokenCount: 5, totalTokenCount: 120, cachedContentTokenCount: 0 } };
  return { id: 'receipt-c', choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } };
}
function setup() { const w = workspace(), brand = fixture(); w.store.put('brands', brand); const registry = new Registry(w.store, w.vault); return { ...w, brand, registry }; }
async function waves(agents: AgentCoordinator, id: string, limit = 30) {
  for (let i = 0; i < limit; i++) { agents.pump(); await agents.drain(); const r = agents.get(id)!; if (['complete', 'review', 'failed', 'uncertain', 'cancelled'].includes(r.state)) return r; }
  throw new Error('Agent DAG did not settle.');
}
for (const adapter of ['responses', 'chat', 'anthropic', 'gemini'] as Adapter[]) test(`${adapter} adapter validates the response and retains a single metered receipt`, async () => {
  const w = setup(); try {
    const model = w.registry.saveModel(modelInput(adapter)); let calls = 0;
    const router = new ModelRouter(w.store, w.vault, async (url, init) => { calls++; assert.ok(String(url).startsWith(model.endpoint)); assert.ok(!String(init?.body).includes('private-test-credential')); return Response.json(envelopes(adapter)); });
    const options = { brandId: w.brand.id, role: 'copywriter' as const, key: 'contract', instruction: 'Write a result.', input: { topic: 'test' }, schema, model, probe: true };
    assert.deepEqual(await router.call(options), { answer: 'Validated result' }); assert.deepEqual(await router.call(options), { answer: 'Validated result' }); assert.equal(calls, 1);
    const entry = router.ledger.forEffect('contract')!; assert.equal(entry.costMicros, 140); assert.equal(entry.metrics.inputTokens, 100); assert.equal(entry.metrics.outputTokens, 20);
    assert.ok(!JSON.stringify(w.registry.models()).includes('private-test-credential')); assert.ok(!JSON.stringify(w.store.db.prepare("SELECT data,secret FROM agent_models").all()).includes("private-test-credential"));
  } finally { w.clean(); }
});
test('custom models require verification, capability matching and public endpoints', async () => {
  const w = setup(); try {
    const model = w.registry.saveModel({ ...modelInput(), capabilities: ['text', 'json'] });
    const router = new ModelRouter(w.store, w.vault, async () => { throw new Error('No request should be sent'); });
    await assert.rejects(router.call({ brandId: w.brand.id, role: 'copywriter', key: 'unverified', instruction: '', input: {}, schema, model }), /Verify/);
    assert.throws(() => w.registry.saveConfig(w.brand.id, { bindings: { 'creative-reviewer': { modelId: model.id } } }), /capability/);
    for (const endpoint of ['http://localhost:3000', 'https://api.example.com/?key=secret', 'https://name:secret@example.com', 'https://service.local']) assert.throws(() => w.registry.saveModel({ ...modelInput(), endpoint }), /HTTPS|public/);
    await assert.rejects(modelFetch('https://127.0.0.1/v1/chat/completions'), /private|reserved/);
    assert.equal(new UsageLedger(w.store).query(new URLSearchParams()).entries.length, 0);
  } finally { w.clean(); }
});
test('immutable model versions retain their original credential, rates and fallback order', () => {
  const w = setup(); try {
    const fallback = w.registry.saveModel(modelInput('chat', 'fallback-model')); w.registry.verify(fallback);
    const original = w.registry.saveModel({ ...modelInput(), fallbacks: [fallback.id] }); w.registry.verify(original);
    w.registry.saveConfig(w.brand.id, { mode: 'auto', bindings: { copywriter: { modelId: original.id } } });
    const frozen = w.registry.freeze(w.brand.id);
    w.registry.saveModel({ ...modelInput(), model: 'replacement-model', apiKey: 'new-private-credential', rates: { input: 10, output: 20 } });
    assert.equal(frozen.models.copywriter!.model, original.model); assert.equal(frozen.models.copywriter!.rate.input, 1); assert.equal(frozen.fallbacks.copywriter![0]!.id, fallback.id);
    assert.equal(w.registry.credential(frozen.models.copywriter!), 'private-test-credential'); assert.equal(w.registry.get(original.id).version, 2);
  } finally { w.clean(); }
});
test('fallback requests are individually charged and unknown outcomes stop the chain', async () => {
  const w = setup(); try {
    const one = w.registry.saveModel(modelInput('chat', 'primary-model')), two = w.registry.saveModel(modelInput('chat', 'backup-model'));
    let calls = 0; const router = new ModelRouter(w.store, w.vault, async () => ++calls === 1 ? new Response(null, { status: 429 }) : Response.json(envelopes('chat')));
    const opts = { brandId: w.brand.id, role: 'copywriter' as const, key: 'fallback-test', instruction: '', input: {}, schema, model: one, fallbacks: [two], probe: true };
    assert.deepEqual(await router.call(opts), { answer: 'Validated result' }); assert.equal(calls, 2); assert.equal(router.ledger.query(new URLSearchParams()).entries.length, 2);
    assert.equal(router.ledger.forEffect('fallback-test')!.costStatus, 'not-charged');
    let unknownCalls = 0; const lost = new ModelRouter(w.store, w.vault, async () => { unknownCalls++; throw new Error('Lost reply'); });
    await assert.rejects(lost.call({ ...opts, key: 'unknown-test' }), /uncertain/); await assert.rejects(lost.call({ ...opts, key: 'unknown-test' }), /uncertain/); assert.equal(unknownCalls, 1);
  } finally { w.clean(); }
});
test('paid invalid JSON is accounted for and cannot pass an output contract', async () => {
  const w = setup(); try {
    const model = w.registry.saveModel(modelInput());
    const router = new ModelRouter(w.store, w.vault, async () => Response.json(envelopes('chat', { invented: true })));
    await assert.rejects(router.call({ brandId: w.brand.id, role: 'copywriter', key: 'invalid', instruction: '', input: {}, schema, model, probe: true }), /Invalid model output/);
    assert.equal(router.ledger.forEffect('invalid')!.costMicros, 140); assert.equal(router.ledger.forEffect('invalid')!.state, 'failed');
  } finally { w.clean(); }
});
test('cache creation is never priced at the ordinary input rate without an explicit price', async () => {
  const w = setup(); try {
    const original = w.registry.saveModel(modelInput('anthropic'));
    const fetcher: typeof fetch = async () => Response.json({ ...envelopes('anthropic'), usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } });
    const router = new ModelRouter(w.store, w.vault, fetcher), options = { brandId: w.brand.id, role: 'copywriter' as const, key: 'cache-unknown', instruction: '', input: {}, schema, model: original, probe: true };
    await router.call(options); assert.equal(router.ledger.forEffect(options.key)!.costMicros, null);
    const priced = w.registry.saveModel({ ...modelInput('anthropic'), rates: { input: 1, output: 2, cached: 0.5, cacheWrite: 1.25 } });
    await router.call({ ...options, key: 'cache-priced', model: priced }); assert.equal(router.ledger.forEffect('cache-priced')!.costMicros, 188);
  } finally { w.clean(); }
});
test('workspace, brand and role ceilings reserve atomically across independent connections', () => {
  const w = setup(), second = new Store(w.dir); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow', dailyUsd: 0.015, bindings: { copywriter: { modelId: '', dailyUsd: 0.012, maxRequestUsd: 0.011 } } });
    w.store.setSetting('aiWorkspaceDailyUsd', 0.015);
    const context = { brandId: w.brand.id, action: 'creative-copy' as const, provider: 'test', model: 'test', rate: tokenRate(1, 2, 0, 'fixture'), estimatedMicros: 10000 };
    const ledger = new UsageLedger(w.store); ledger.begin({ ...context, effectKey: 'first' });
    assert.throws(() => new UsageLedger(second).begin({ ...context, effectKey: 'second' }), /allowance/); assert.equal(second.effect('second'), undefined);
    assert.throws(() => ledger.begin({ ...context, estimatedMicros: 11001, effectKey: 'third' }), /allowance/);
    assert.equal(ledger.query(new URLSearchParams()).entries.length, 1);
  } finally { second.close(); w.clean(); }
});
test('independent specialists start together, dependency tasks wait, and outputs retain task provenance', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow', concurrency: 3 });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered = 0;
    const agents = new AgentCoordinator(w.store, w.vault, w.production, async (u, i) => { if (++entered <= 2) await gate; return w.services.fetch(u, i); });
    const r = agents.create(w.brand.id); agents.pump(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, 2); assert.equal(agents.tasks(r.id).filter(t => t.state === 'running').length, 2); assert.equal(agents.tasks(r.id).find(t => t.role === 'creative-strategist')!.state, 'queued');
    release(); await agents.drain(); assert.equal((await waves(agents, r.id)).state, 'complete');
    const usage = new UsageLedger(w.store).query(new URLSearchParams({ agentRun: r.id })).entries; assert.equal(usage.length, 5); assert.ok(usage.every(u => u.agentTaskId && u.modelConfigVersion));
  } finally { w.clean(); }
});
test('review mode gates paid media, then completes campaign production through the existing worker', async () => {
  const w = setup(); try {
    w.store.setSetting('app', { ...DEFAULT_SETTINGS }); w.registry.saveConfig(w.brand.id, { mode: 'review', maxRunUsd: 20 });
    const engine = new Engine(w.store, w.vault, { production: w.production, meta: w.meta, fetchImpl: w.services.fetch });
    const campaign = engine.createRun(w.brand.id); await engine.advance(campaign.id); await engine.advance(campaign.id);
    const agentId = w.store.get<CampaignRun>('runs', campaign.id)!.agentRunId!;
    assert.equal((await waves(engine.agents, agentId)).state, 'review'); assert.ok(!w.services.requests.some(r => r.path === '/v2/video_generation'));
    const snapshots = engine.agents.get(agentId)!; assert.equal(snapshots.snapshot.video!.provider, 'minimax');
    w.store.setSetting('app', { ...DEFAULT_SETTINGS, h3UsdPerSecond: 0.4 });
    engine.agents.approve(agentId); assert.equal((await waves(engine.agents, agentId)).state, 'complete');
    for (let i = 0; i < 8 && w.store.get<CampaignRun>('runs', campaign.id)!.status !== 'complete'; i++) await engine.advance(campaign.id);
    const completed = w.store.get<CampaignRun>('runs', campaign.id)!; assert.equal(completed.status, 'complete'); assert.equal(completed.creativeIds.length, w.brand.creativesPerCycle);
    assert.ok(completed.stages.every(s => s.active));
    const entries = new UsageLedger(w.store).query(new URLSearchParams({ run: campaign.id })).entries;
    assert.ok(entries.every(e => e.agentRunId === agentId && e.agentTaskId)); assert.ok(entries.filter(e => e.action === 'video-generation').every(e => e.rate.perSecond === 0.08));
    const paidBefore = entries.length; engine.agents.pump(); await engine.agents.drain(); assert.equal(new UsageLedger(w.store).query(new URLSearchParams({ run: campaign.id })).entries.length, paidBefore);
  } finally { w.clean(); }
});
test('cancellation during a model call preserves its receipt and blocks descendants', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow' }); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const agents = new AgentCoordinator(w.store, w.vault, w.production, async (u, i) => { await gate; return w.services.fetch(u, i); });
    const run = agents.create(w.brand.id); agents.pump(); await new Promise(resolve => setImmediate(resolve)); agents.cancel(run.id); release(); await agents.drain(); agents.pump();
    assert.equal(agents.get(run.id)!.state, 'cancelled'); assert.ok(agents.tasks(run.id).every(t => t.state === 'cancelled'));
    assert.equal(new UsageLedger(w.store).query(new URLSearchParams()).entries.length, 2);
  } finally { w.clean(); }
});
test('a lost worker lease with a pending request is stopped without a paid replay', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow' }); const agents = new AgentCoordinator(w.store, w.vault, w.production, w.services.fetch), run = agents.create(w.brand.id), task = agents.tasks(run.id)[0]!;
    task.state = 'running'; task.lease = 'dead-worker'; task.leaseUntil = Date.now() - 1;
    w.store.db.prepare('UPDATE agent_tasks SET state=?,lease_until=?,data=? WHERE id=?').run(task.state, task.leaseUntil, JSON.stringify(task), task.id);
    new UsageLedger(w.store).begin({ brandId: w.brand.id, action: 'agent-analysis', agentRunId: run.id, agentTaskId: task.id, provider: 'openai', model: 'test', rate: tokenRate(1, 2, null, 'test'), estimatedMicros: 1000, effectKey: `agent:${task.id}` });
    agents.pump(); await agents.drain(); assert.equal(agents.get(run.id)!.state, 'uncertain'); assert.equal(w.services.requests.length, 0);
  } finally { w.clean(); }
});
test('a recoverable worker lease resumes queued work with its original model snapshot', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow' }); const agents = new AgentCoordinator(w.store, w.vault, w.production, w.services.fetch), run = agents.create(w.brand.id), task = agents.tasks(run.id)[0]!;
    task.state = 'running'; task.leaseUntil = Date.now() - 1; w.store.db.prepare('UPDATE agent_tasks SET state=?,lease_until=?,data=? WHERE id=?').run(task.state, task.leaseUntil, JSON.stringify(task), task.id);
    w.store.setSetting('app', { ...DEFAULT_SETTINGS, textModel: 'changed-after-start' });
    assert.equal((await waves(agents, run.id)).state, 'complete'); assert.ok(new UsageLedger(w.store).query(new URLSearchParams()).entries.every(e => e.model === 'gpt-4.1-mini'));
  } finally { w.clean(); }
});
test('source IDs not present in the evidence cannot become agent-approved work', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow' });
    const agents = new AgentCoordinator(w.store, w.vault, w.production, async () => Response.json(envelopes('responses', { summary: 'Invented evidence', recommendations: [], sourceIds: ['not-provided'], confidence: 1 })));
    const run = agents.create(w.brand.id); assert.equal((await waves(agents, run.id)).state, 'failed'); assert.match(agents.get(run.id)!.error, /evidence/);
  } finally { w.clean(); }
});
test('memory snapshots are brand scoped, expire, and preserve prior versions on restore', () => {
  const w = setup(); try {
    const memory = new BrandMemory(w.store), first = memory.append(w.brand.id, { title: 'A verified detail', content: 'A supported product detail.', kind: 'approved' });
    memory.append(w.brand.id, { ...first, content: 'An updated detail.' }); const restored = memory.rollback(first.id); assert.equal(restored.version, 3); assert.equal(restored.content, first.content);
    memory.append(w.brand.id, { title: 'Expired offer', content: 'Do not use.', expiresAt: '2020-01-01' });
    assert.ok(!memory.snapshot(w.brand).sources.some(s => s.text.includes('Do not use.')));
    assert.throws(() => memory.append(w.brand.id, { title: 'Bad automatic fact', content: 'Not approved', kind: 'approved' }, 'evaluator'), /owner/);
    assert.equal(memory.history(w.brand.id).length, 4);
  } finally { w.clean(); }
});
test('H3, Seedance and Veo quotes use real catalogue estimates without sending requests', () => {
  const w = setup(); try {
    for (const [provider, model] of [['minimax', 'MiniMax-H3'], ['seedance', 'seedance-1-5-pro-251215'], ['veo', 'veo-3.1-fast-generate-001']] as const) {
      w.store.setSetting('app', { ...DEFAULT_SETTINGS, provider, videoModel: model });
      const quote = quoteWorkflow(w.store, w.brand, w.registry.freeze(w.brand.id), { plan: planFor(w.brand) } as CampaignRun);
      assert.ok(quote.typicalUsd > 0); assert.ok(quote.upperUsd >= quote.typicalUsd); assert.ok(quote.rows.find(r => r.role === 'video-producer')!.typicalUsd > 0);
    }
    assert.equal(w.services.requests.length, 0);
  } finally { w.clean(); }
});
test('studio API returns configuration without secrets and rejects unsupported actions', async () => {
  const w = setup(); try {
    w.registry.saveModel(modelInput());
    const result = await studioApi(w.engine, 'GET', new URL('https://workspace.test/api/studio?brand=nord'), async () => ({}));
    assert.ok(result); assert.ok(!JSON.stringify(result).includes('private-test-credential'));
    await assert.rejects(studioApi(w.engine, 'POST', new URL('https://workspace.test/api/studio/runs'), async () => ({ brandId: w.brand.id, kind: 'campaign' })), /review or automatic/);
  } finally { w.clean(); }
});
test('Studio views and work details render the real API contracts with escaped owner content', async () => {
  const w = setup(); try {
    w.registry.saveConfig(w.brand.id, { mode: 'shadow' });
    w.engine.agents.memory.append(w.brand.id, { title: '<script>owner input</script>', content: 'A substantiated brand fact.', kind: 'approved' });
    const run = w.engine.agents.create(w.brand.id);
    const events = new Map<string, (event: unknown) => Promise<void>>(); let dialog = '';
    const createStudio = runInNewContext(readFileSync('ui/studio.js', 'utf8').replace('export function createStudio', 'function createStudio') + '\ncreateStudio;', {
      document: { addEventListener: (name: string, handler: (event: unknown) => Promise<void>) => events.set(name, handler) }, location: { hash: '#agents' }, Intl, Date, URLSearchParams,
    });
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const studio = createStudio({ state: { brand: w.brand.id, data: { brands: [w.brand], runs: [], currencyRules: { wholeUnits: ['JPY'] } } },
      api: async (path: string) => (await studioApi(w.engine, 'GET', new URL('https://workspace.test/api' + path), async () => ({})))!.data,
      esc, heading: (...args: string[]) => args.join(' '), badge: esc, stat: (...args: string[]) => args.join(' '), modal: (_title: string, _subtitle: string, html: string) => { dialog = html; }, toast: () => {}, render: () => {}, refresh: async () => {},
    });
    studio.render('agents'); await new Promise(resolve => setImmediate(resolve));
    const team = studio.render('agents'); assert.equal((team.match(/class="eyebrow">Specialist/g) || []).length, 14);
    const click = (action: string, id: string) => events.get('click')!({ target: { closest: () => ({ dataset: { studioAction: action, id }, disabled: false }) } });
    await click('tab', 'models'); assert.match(studio.render('agents'), /OpenAI · workspace model/);
    await click('tab', 'memory'); assert.match(studio.render('agents'), /&lt;script&gt;owner input/); assert.ok(!studio.render('agents').includes('<script>owner input'));
    await click('tab', 'runs'); assert.ok(studio.render('agents').includes(run.id));
    await click('run', run.id); assert.match(dialog, /Memory snapshot/); assert.match(dialog, /independent/);
    assert.match(studio.render('roi'), /Confirmed net revenue/); assert.match(studio.render('roi'), /Final result awaits complete evidence/);
  } finally { w.clean(); }
});
