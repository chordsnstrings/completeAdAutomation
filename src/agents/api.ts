import { randomUUID } from 'node:crypto';
import type { Engine } from '../app/engine.ts';
import { planFor } from '../app/planner.ts';
import { AppError, nowIso, type CampaignRun } from '../app/types.ts';
import { UsageLedger } from '../app/usage.ts';
import { quoteWorkflow } from './forecast.ts';
import { Economics } from './economics.ts';
import { ROLES, bounded, object, objectSchema, text, type Role } from './contracts.ts';
import { modelEndpoint } from './registry.ts';

/** The HTTP server authenticates and checks CSRF before dispatching here. */
export async function studioApi(engine: Engine, method: string, url: URL, readBody: () => Promise<unknown>): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname, agents = engine.agents, registry = agents.router.registry, store = engine.store, economics = new Economics(store);
  const brandId = url.searchParams.get('brand') ?? '';
  if (path === '/api/studio' && method === 'GET') {
    const brand = brandId ? engine.brand(brandId) : undefined;
    return { data: { roles: ROLES, config: registry.config(brandId), models: registry.models(brandId), runs: agents.runs(brandId), memory: brand ? agents.memory.current(brand.id) : [],
      memoryHistory: brand ? agents.memory.history(brand.id) : [], experiments: brand ? economics.experiments(brand.id) : [], economics: brand ? economics.config(brand.id) : null,
      resolved: Object.fromEntries((Object.keys(ROLES) as Role[]).filter(r => r !== 'video-producer').map(r => [r, registry.resolve(r, brandId).id])),
      workspaceDailyUsd: store.setting<number | null>('aiWorkspaceDailyUsd', null), rendererEndpoint: store.setting<string>('pageRendererEndpoint', '') } };
  }
  if (path === '/api/studio/config' && method === 'POST') return { data: registry.saveConfig(brandId, await readBody()) };
  if (path === '/api/studio/workspace' && method === 'POST') {
    const o = object(await readBody());
    store.setSetting('aiWorkspaceDailyUsd', bounded(o['dailyUsd'], 'Workspace daily AI allowance', 0.001, 100000));
    if (o['rendererEndpoint'] !== undefined) store.setSetting('pageRendererEndpoint', o['rendererEndpoint'] ? modelEndpoint(text(o['rendererEndpoint'], 'page renderer endpoint', 500)) : '');
    return { data: { saved: true } };
  }
  if (path === '/api/studio/models' && method === 'POST') return { data: registry.saveModel(await readBody()), status: 201 };
  const probe = /^\/api\/studio\/models\/([^/]+)\/probe$/.exec(path);
  if (probe && method === 'POST') {
    const model = registry.get(probe[1]!), ledger = new UsageLedger(store);
    if (model.adapter === 'speech') {
      const secret = registry.credential(model); if (!secret) throw new AppError('Save this model credential first.');
      const input = 'Connection verified.', characters = Array.from(input).length;
      const entry = ledger.begin({ brandId, action: 'model-probe', agentRole: 'voice-producer', provider: model.provider, model: model.model, modelConfigVersion: `${model.id}@${model.version}`, rate: model.rate, estimatedMicros: Math.ceil(characters * (model.rate.perMillionCharacters ?? 15)) });
      try {
        const response = await agents.router.fetchImpl(`${model.endpoint}/audio/speech`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(model.timeoutMs), headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.model, voice: model.voice, input, response_format: 'mp3' }) });
        ledger.response(entry.id, response);
        const bytes = await response.arrayBuffer();
        if (!response.ok || bytes.byteLength < 100 || bytes.byteLength > 1024 * 1024 || !/^audio\//i.test(response.headers.get('content-type') ?? '')) throw new AppError('Speech verification did not return a bounded audio response.');
        ledger.update(entry.id, { metrics: { ...ledger.get(entry.id)!.metrics, characters } }); registry.verify(model);
        return { data: { verified: true, usage: ledger.get(entry.id) } };
      } catch (error) { ledger.failure(entry.id, 'Speech connection test failed; cost exposure retained.'); throw error instanceof AppError ? error : new AppError('Speech connection test was interrupted.'); }
    }
    const key = `probe:${randomUUID()}`, schema = objectSchema({ verified: { type: 'boolean', enum: [true] } });
    const images = model.capabilities.includes('vision') ? ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII='] : [];
    await agents.router.call({ brandId, role: images.length ? 'creative-reviewer' : 'performance-analyst', key, probe: true, model: { ...model, maxOutputTokens: 256 }, instruction: 'Return {"verified":true}. This is a connection and JSON contract test.', input: { connectionTest: true }, schema, images, context: { action: 'model-probe' } });
    registry.verify(model); return { data: { verified: true, usage: ledger.forEffect(key) } };
  }
  if (path === '/api/studio/quote' && method === 'POST') {
    const o = object(await readBody()), brand = engine.brand(text(o['brandId'], 'brand ID', 100));
    const campaign = o['kind'] === 'campaign' ? { plan: planFor(brand) } as CampaignRun : undefined;
    const quote = quoteWorkflow(store, brand, registry.freeze(brand.id), campaign);
    return { data: { quote, forecast: economics.forecast(brand.id, typeof o['adBudgetMinor'] === 'number' ? o['adBudgetMinor'] : brand.spend.dailyBudgetMinor, quote.typicalUsd), plan: campaign?.plan ?? null } };
  }
  if (path === '/api/studio/runs' && method === 'POST') {
    const o = object(await readBody()), id = text(o['brandId'], 'brand ID', 100);
    if (o['kind'] === 'campaign') {
      if (!['review', 'auto'].includes(registry.config(id).mode)) throw new AppError('Choose review or automatic mode before starting agent campaign production.');
      return { data: engine.createRun(id), status: 202 };
    }
    return { data: agents.create(id), status: 202 };
  }
  const run = /^\/api\/studio\/runs\/([^/]+)(?:\/(approve|cancel))?$/.exec(path);
  if (run) {
    const found = agents.get(run[1]!); if (!found) throw new AppError('Agent run not found.', 404);
    if (method === 'GET' && !run[2]) return { data: { run: found, tasks: agents.tasks(found.id), usage: new UsageLedger(store).query(new URLSearchParams({ agentRun: found.id, limit: '100' })) } };
    if (method === 'POST' && run[2] === 'approve') return { data: agents.approve(found.id) };
    if (method === 'POST' && run[2] === 'cancel') { agents.cancel(found.id); return { data: { cancelled: true } }; }
  }
  if (path === '/api/studio/memory' && method === 'POST') return { data: agents.memory.append(brandId, await readBody()), status: 201 };
  const memory = /^\/api\/studio\/memory\/([^/]+)\/restore$/.exec(path);
  if (memory && method === 'POST') return { data: agents.memory.rollback(memory[1]!) };
  if (path === '/api/studio/economics' && method === 'POST') return { data: economics.saveConfig(brandId, await readBody()) };
  if (path === '/api/studio/roi' && method === 'GET') {
    const from = url.searchParams.get('from') ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to = url.searchParams.get('to') ?? nowIso().slice(0, 10);
    return { data: economics.report(brandId, { from, to, runIds: url.searchParams.getAll('run') }) };
  }
  if (path === '/api/studio/outcomes' && method === 'GET') return { data: economics.outcomes(brandId) };
  if (path === '/api/studio/outcomes' && method === 'POST') return { data: economics.recordOutcome(brandId, await readBody()), status: 201 };
  if (path === '/api/studio/costs' && method === 'GET') return { data: economics.adjustments(brandId) };
  if (path === '/api/studio/costs' && method === 'POST') return { data: economics.recordCost(brandId, await readBody()), status: 201 };
  if (path === '/api/studio/experiments' && method === 'POST') return { data: economics.createExperiment(brandId, await readBody()), status: 201 };
  const experiment = /^\/api\/studio\/experiments\/([^/]+)\/(evaluate|promote|explain)$/.exec(path);
  if (experiment && method === 'POST') {
    if (experiment[2] === 'promote') return { data: economics.promote(experiment[1]!) };
    const evaluation = economics.evaluate(experiment[1]!);
    if (experiment[2] === 'explain') return { data: agents.create(evaluation.control.brandId, undefined, { experimentId: experiment[1]!, evaluation }), status: 202 };
    return { data: evaluation };
  }
  return undefined;
}
