import type { Store } from '../app/store.ts';
import type { Vault } from '../app/security.ts';
import { AppError, DEFAULT_SETTINGS, nowIso, type Settings, type SecretName, type CampaignRun } from '../app/types.ts';
import { chatRate, speechRate, type UsageRate } from '../app/usage.ts';
import { ROLES, object, text, bounded, type Role, type ModelConfig, type StudioConfig, type FrozenConfig, type Adapter, type Capability, type RoleBinding } from './contracts.ts';

export const DEFAULT_STUDIO: StudioConfig = { version: 1, mode: 'off', maxRunUsd: 15, dailyUsd: 30, concurrency: 3, analysisHours: 24, autoLearn: false, bindings: {} };
export function modelEndpoint(raw: string): string {
  let u: URL; try { u = new URL(raw); } catch { throw new AppError('Model endpoints need a complete public HTTPS URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.port && u.port !== '443') || /(^localhost$|\.local$|\.internal$)/i.test(u.hostname)) throw new AppError('Model endpoints must use public HTTPS without credentials or query parameters.');
  return u.href.replace(/\/$/, '');
}
export class Registry {
  readonly store: Store; readonly vault: Vault;
  constructor(store: Store, vault: Vault) { this.store = store; this.vault = vault; }
  config(brandId = ''): StudioConfig {
    const global = this.store.setting<StudioConfig>('studio', DEFAULT_STUDIO);
    return brandId ? this.store.setting<StudioConfig>(`studio:${brandId}`, global) : global;
  }
  saveConfig(brandId: string, input: unknown): StudioConfig {
    if (brandId && !this.store.get('brands', brandId)) throw new AppError('Brand not found.', 404);
    const o = object(input), old = this.config(brandId);
    const mode = o['mode'] ?? old.mode;
    if (!['off', 'shadow', 'review', 'auto'].includes(String(mode))) throw new AppError('Choose an agent operating mode.');
    const bindings: StudioConfig['bindings'] = {};
    for (const [role, raw] of Object.entries(object(o['bindings'] ?? old.bindings))) {
      if (!Object.hasOwn(ROLES, role)) throw new AppError('Unknown agent role.');
      const b = object(raw), modelId = text(b['modelId'] ?? '', 'model selection', 80, false);
      if (modelId) {
        const model = this.get(modelId, undefined, brandId);
        if (role === 'video-producer') throw new AppError('Choose the video provider in Connections.');
        this.assertCapabilities(model, role as Role);
      }
      bindings[role as Role] = { modelId, dailyUsd: bounded(b['dailyUsd'], 'Role daily allowance', 0.001, 100000, 10), maxRequestUsd: bounded(b['maxRequestUsd'], 'Request allowance', 0.000001, 10000, 2), enabled: b['enabled'] !== false };
    }
    const value: StudioConfig = { version: old.version + 1, mode: mode as StudioConfig['mode'], bindings,
      maxRunUsd: bounded(o['maxRunUsd'], 'Run allowance', 0.001, 100000, old.maxRunUsd), dailyUsd: bounded(o['dailyUsd'], 'Daily AI allowance', 0.001, 100000, old.dailyUsd),
      concurrency: Math.floor(bounded(o['concurrency'], 'Parallel tasks', 1, 8, old.concurrency)), analysisHours: bounded(o['analysisHours'], 'Analysis interval', 1, 168, old.analysisHours), autoLearn: o['autoLearn'] === undefined ? old.autoLearn : o['autoLearn'] === true };
    this.store.setSetting(brandId ? `studio:${brandId}` : 'studio', value);
    this.store.event(brandId, 'info', 'Agent configuration saved', `Version ${value.version}; ${value.mode}. Existing runs keep their model snapshots.`);
    return value;
  }
  builtins(brandId = ''): ModelConfig[] {
    const settings = { ...DEFAULT_SETTINGS, ...this.store.setting<Partial<Settings>>('app', {}) };
    const base = { version: 1, maxInputTokens: 64000, maxOutputTokens: 3500, timeoutMs: 60000, concurrency: 3, fallbacks: [], voice: 'alloy', createdAt: '', verifiedAt: 'builtin-contract', jsonMode: 'schema' as const };
    const models: ModelConfig[] = [
      { ...base, id: 'builtin-openai', name: 'OpenAI · workspace model', provider: 'openai', adapter: 'responses', endpoint: 'https://api.openai.com/v1', model: settings.textModel, capabilities: ['text', 'vision', 'json'], rate: chatRate(this.store, 'openai', settings.textModel), builtin: 'openaiKey' },
      { ...base, id: 'builtin-voice', name: 'OpenAI · narration', provider: 'openai', adapter: 'speech', endpoint: 'https://api.openai.com/v1', model: 'tts-1', capabilities: ['speech'], rate: speechRate(), builtin: 'openaiKey' },
    ];
    for (const [provider, model] of [['glm', 'glm-5.2'], ['minimax', 'MiniMax-M2.7'], ['minimax', 'MiniMax-M2.7-highspeed'], ['minimax', 'MiniMax-M3']]) models.push({ ...base,
      id: `builtin-${model!.toLowerCase()}`, name: model!, provider: provider!, adapter: 'chat', endpoint: provider === 'glm' ? 'https://api.z.ai/api/paas/v4' : 'https://api.minimax.io/v1',
      model: model!, capabilities: ['text', 'json'], jsonMode: provider === 'glm' ? 'object' : 'prompt', rate: chatRate(this.store, provider!, model!), builtin: provider === 'glm' ? 'glmKey' : 'minimaxKey' });
    return models;
  }
  models(brandId = ''): Array<ModelConfig & { connected: boolean }> {
    const rows = this.store.db.prepare('SELECT data FROM agent_models m WHERE version=(SELECT MAX(version) FROM agent_models WHERE id=m.id) ORDER BY id').all();
    return [...this.builtins(brandId), ...rows.map(r => JSON.parse(String(r['data'])) as ModelConfig)].map(m => ({ ...m, connected: Boolean(this.credential(m)) }));
  }
  get(id: string, version?: number, brandId = ''): ModelConfig {
    const builtin = this.builtins(brandId).find(m => m.id === id); if (builtin) return builtin;
    const row = version === undefined ? this.store.db.prepare('SELECT data FROM agent_models WHERE id=? ORDER BY version DESC LIMIT 1').get(id) : this.store.db.prepare('SELECT data FROM agent_models WHERE id=? AND version=?').get(id, version);
    if (!row) throw new AppError('Model configuration not found.', 404);
    return JSON.parse(String(row['data'])) as ModelConfig;
  }
  saveModel(input: unknown): ModelConfig {
    const o = object(input), id = text(o['id'], 'model configuration ID', 60);
    if (!/^[a-z][a-z0-9-]+$/.test(id) || id.startsWith('builtin-')) throw new AppError('Use a unique lowercase model configuration ID.');
    const adapter = text(o['adapter'], 'adapter') as Adapter;
    if (!['responses', 'chat', 'anthropic', 'gemini', 'speech'].includes(adapter)) throw new AppError('Unsupported model adapter.');
    const capabilities = Array.isArray(o['capabilities']) ? [...new Set(o['capabilities'])] as Capability[] : [];
    if (!capabilities.length || capabilities.some(c => !['text', 'vision', 'json', 'speech'].includes(c)) || (adapter === 'speech' ? !capabilities.includes('speech') : !capabilities.includes('text') || !capabilities.includes('json'))) throw new AppError('Set the model capabilities required by this adapter.');
    const prices = object(o['rates']);
    const rate: UsageRate = { ...chatRate(this.store, 'openai', ''), unit: adapter === 'speech' ? 'characters' : 'tokens',
      cacheWrite: prices['cacheWrite'] == null ? null : bounded(prices['cacheWrite'], 'Cache write rate', 0, 10000),
      input: bounded(prices['input'], 'Input rate per million', 0, 10000, 0), output: bounded(prices['output'], 'Output rate per million', 0, 10000, 0), cached: prices['cached'] === null || prices['cached'] === undefined ? null : bounded(prices['cached'], 'Cache rate', 0, 10000),
      perMillionCharacters: adapter === 'speech' ? bounded(prices['characters'], 'Narration character rate', 0, 10000, 15) : null, source: 'Owner-configured model rates', verifiedAt: nowIso().slice(0, 10), note: 'Owner-configured rates; provider invoices may differ.' };
    if (rate.input === 0 && rate.output === 0 && !rate.perMillionCharacters) throw new AppError('Set a nonzero rate for metered model usage.');
    const old = this.store.db.prepare('SELECT version,secret FROM agent_models WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
    const apiKey = typeof o['apiKey'] === 'string' ? o['apiKey'].trim() : '';
    if (!apiKey && !old) throw new AppError('Enter the model connection API key.');
    if (apiKey.length > 20000) throw new AppError('API key is too long.');
    const fallbackIds = Array.isArray(o['fallbacks']) ? o['fallbacks'].map(v => text(v, 'fallback model ID', 80)) : [];
    if (fallbackIds.length > 2 || fallbackIds.includes(id)) throw new AppError('Choose at most two different fallback models.');
    for (const fallbackId of fallbackIds) this.get(fallbackId);
    const jsonMode = o['jsonMode'] ?? 'prompt';
    if (!['schema', 'object', 'prompt'].includes(String(jsonMode))) throw new AppError('Unknown JSON output mode.');
    const value: ModelConfig = { id, version: Number(old?.['version'] ?? 0) + 1, name: text(o['name'], 'model name', 100), provider: text(o['provider'], 'provider', 60), adapter,
      endpoint: modelEndpoint(text(o['endpoint'], 'endpoint', 500)), model: text(o['model'], 'model ID', 150), capabilities, rate,
      maxInputTokens: Math.floor(bounded(o['maxInputTokens'], 'Input token ceiling', 1024, 1000000, 64000)), maxOutputTokens: Math.floor(bounded(o['maxOutputTokens'], 'Output token ceiling', 256, 32000, 3500)),
      timeoutMs: Math.floor(bounded(o['timeoutMs'], 'Request timeout', 1000, 120000, 60000)), concurrency: Math.floor(bounded(o['concurrency'], 'Provider concurrency', 1, 8, 2)),
      fallbacks: fallbackIds, voice: text(o['voice'] ?? 'alloy', 'voice', 100), jsonMode: jsonMode as ModelConfig['jsonMode'], createdAt: nowIso(), verifiedAt: '' };
    if (!/^[\w.\-/:]+$/.test(value.model)) throw new AppError('Invalid model ID.');
    this.store.db.prepare('INSERT INTO agent_models(id,version,data,secret) VALUES(?,?,?,?)').run(id, value.version, JSON.stringify(value), apiKey ? this.vault.seal(apiKey) : String(old!['secret']));
    return value;
  }
  credential(model: ModelConfig): string {
    if (model.builtin) return this.vault.get(model.builtin as SecretName);
    const row = this.store.db.prepare('SELECT secret FROM agent_models WHERE id=? AND version=?').get(model.id, model.version);
    return row ? this.vault.open(String(row['secret'])) : '';
  }
  verify(model: ModelConfig): void {
    if (model.builtin) return;
    this.store.db.prepare('UPDATE agent_models SET data=? WHERE id=? AND version=?').run(JSON.stringify({ ...model, verifiedAt: nowIso() }), model.id, model.version);
  }
  assertCapabilities(model: ModelConfig, role: Role): void {
    const needed: Capability[] = role === 'voice-producer' ? ['speech'] : role === 'creative-reviewer' ? ['text', 'json', 'vision'] : ['text', 'json'];
    if (needed.some(c => !model.capabilities.includes(c))) throw new AppError(`${model.name} lacks a required capability for ${ROLES[role]}.`);
  }
  resolve(role: Role, brandId = ''): ModelConfig {
    const config = this.config(brandId), binding = config.bindings[role];
    let id = binding?.modelId || (role === 'voice-producer' ? 'builtin-voice' : 'builtin-openai');
    if (!binding?.modelId && ['community-manager', 'response-reviewer', 'brand-researcher'].includes(role)) {
      const engagement = this.store.get<{ model: string }>('engagement', brandId);
      if (engagement?.model) id = `builtin-${engagement.model.toLowerCase()}`;
    }
    const model = this.get(id, undefined, brandId); this.assertCapabilities(model, role); return model;
  }
  freeze(brandId: string): FrozenConfig {
    const models: FrozenConfig['models'] = {}, fallbacks: FrozenConfig['fallbacks'] = {};
    for (const role of Object.keys(ROLES) as Role[]) {
      if (role === 'video-producer') continue;
      const model = this.resolve(role, brandId); models[role] = model;
      fallbacks[role] = model.fallbacks.map(id => { const m = this.get(id, undefined, brandId); this.assertCapabilities(m, role); return m; });
    }
    const settings = { ...DEFAULT_SETTINGS, ...this.store.setting<Partial<Settings>>('app', {}) };
    return structuredClone({ config: this.config(brandId), models, fallbacks, video: {provider:settings.provider,model:settings.videoModel,usdPerSecond:settings.h3UsdPerSecond ?? 0.08} });
  }
  forCampaign(role: Role, brandId: string, runId: string): { model: ModelConfig; fallbacks: ModelConfig[] } {
    const run = this.store.get<CampaignRun>('runs', runId);
    if (run && !run.agentConfig) { run.agentConfig = this.freeze(brandId); this.store.put('runs', run); }
    return { model: run?.agentConfig?.models[role] ?? this.resolve(role, brandId), fallbacks: run?.agentConfig?.fallbacks[role] ?? [] };
  }
}
