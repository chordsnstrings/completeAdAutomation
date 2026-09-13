import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { AppError, DEFAULT_SETTINGS, nowIso, type Settings } from './types.ts';
import type { TaskStatus, CostEstimate } from '../generation/provider.ts';

export const USAGE_ACTIONS = ['creative-copy', 'visual-review', 'video-generation', 'narration', 'page-profile', 'comment-draft', 'reply-verification', 'legacy'] as const;
export const AGENT_ROLES: Record<UsageAction, string> = { 'creative-copy': 'copywriter', 'visual-review': 'creative-reviewer', 'video-generation': 'video-producer', narration: 'voice-producer', 'page-profile': 'brand-researcher', 'comment-draft': 'community-manager', 'reply-verification': 'response-reviewer', legacy: 'unattributed' };
export type UsageAction = typeof USAGE_ACTIONS[number];
export interface UsageRate {
  unit: 'tokens' | 'seconds' | 'pixel-frame-tokens' | 'characters' | 'unknown';
  input: number | null; output: number | null; cached: number | null;
  perSecond: number | null; perMillionCharacters: number | null;
  extraImage: number | null; freeImages: number;
  source: string; verifiedAt: string; note: string;
  longContext?: { threshold: number; input: number; output: number; cached: number };
}
export interface UsageMetrics {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  cachedTokens: number | null; reasoningTokens: number | null;
  inputAudioTokens: number | null; outputAudioTokens: number | null;
  inputVideoSeconds: number | null; outputVideoSeconds: number | null;
  inputImages: number | null; inputAudioSeconds: number | null;
  characters: number | null; pixelFrameTokens: number | null;
}
export interface UsageContext {
  brandId: string; action: UsageAction; agentRole?: string; agentVersion?: string; modelConfigVersion?: string; experimentId?: string; runId?: string; creativeId?: string; stageId?: string;
  pageId?: string; commentId?: string; threadId?: string; adIds?: string[]; shotIndex?: number;
}
export interface UsageEntry extends UsageContext {
  id: string; effectKey: string; chargeKey: string; attempt: number;
  provider: string; model: string; createdAt: string; updatedAt: string; latencyMs: number | null;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'unknown' | 'legacy';
  costStatus: 'reserved' | 'calculated' | 'estimated' | 'unknown' | 'not-charged';
  estimatedMicros: number | null; costMicros: number | null; currency: 'USD';
  rate: UsageRate; metrics: UsageMetrics; requestId: string; taskId: string; httpStatus: number | null;
  detail: string; rawUsage: Record<string, unknown>;
}
export const emptyMetrics = (): UsageMetrics => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedTokens: null, reasoningTokens: null,
  inputAudioTokens: null, outputAudioTokens: null, inputVideoSeconds: null, outputVideoSeconds: null, inputImages: null, inputAudioSeconds: null, characters: null, pixelFrameTokens: null });
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const seconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : null;
const identifier = (v: unknown) => typeof v === 'string' && /^[\w.:/-]{1,250}$/.test(v) ? v : '';
const blankRate = (): UsageRate => ({ unit: 'unknown', input: null, output: null, cached: null, perSecond: null, perMillionCharacters: null, extraImage: null, freeImages: 0, source: '', verifiedAt: '', note: '' });
export function tokenRate(input: number, output: number, cached: number | null, source: string): UsageRate {
  return { ...blankRate(), unit: 'tokens', input, output, cached, source, verifiedAt: '2026-09-13', note: 'USD per million tokens. Cached input is part of input; reasoning is part of output. Standard pay-as-you-go pricing.' };
}
export function defaultChatRates(): Record<string, UsageRate> {
  const source = 'https://platform.minimax.io/docs/guides/pricing-paygo';
  return {
    'minimax:MiniMax-M2.7': tokenRate(0.3, 1.2, 0.06, source),
    'minimax:MiniMax-M2.7-highspeed': tokenRate(0.6, 2.4, 0.06, source),
    'minimax:MiniMax-M3': { ...tokenRate(0.3, 1.2, 0.06, source), longContext: { threshold: 512000, input: 0.6, output: 2.4, cached: 0.12 } },
    'glm:glm-5.2': tokenRate(1.4, 4.4, 0.26, 'https://docs.z.ai/guides/overview/pricing'),
  };
}
export function chatRate(store: Store, provider: string, model: string): UsageRate {
  if (provider === 'openai') {
    const s = { ...DEFAULT_SETTINGS, ...store.setting<Partial<Settings>>('app', {}) };
    return { ...tokenRate(s.textInputUsdPerMillion, s.textOutputUsdPerMillion, s.textCachedUsdPerMillion ?? null, 'Workspace OpenAI rates'), verifiedAt: '', note: 'Configured USD per million tokens; confirm these rates when changing the text model.' };
  }
  return structuredClone(store.setting<Record<string, UsageRate>>('chatRates', {})[`${provider}:${model}`] ?? defaultChatRates()[`${provider}:${model}`] ?? blankRate());
}
export function videoRate(estimate: CostEstimate): UsageRate {
  return { ...blankRate(), unit: estimate.billingUnit === 'seconds-of-output' ? 'seconds' : 'pixel-frame-tokens',
    perSecond: estimate.billingUnit === 'seconds-of-output' ? estimate.usdPerUnit ?? estimate.microUnits / estimate.billedUnits / 1e6 : null,
    output: estimate.billingUnit === 'pixel-frame-tokens' ? estimate.microUnits / estimate.billedUnits : null,
    extraImage: estimate.providerId === 'minimax' ? 0.04 : null, freeImages: estimate.providerId === 'minimax' ? 5 : 0,
    source: estimate.providerId === 'minimax' ? 'https://platform.minimax.io/docs/guides/pricing-paygo' : 'Configured video provider catalogue',
    verifiedAt: estimate.providerId === 'minimax' ? '2026-09-13' : '', note: estimate.basis };
}
export function speechRate(): UsageRate {
  return { ...blankRate(), unit: 'characters', perMillionCharacters: 15, source: 'https://developers.openai.com/api/docs/pricing', verifiedAt: '', note: 'tts-1: $15 per million requested Unicode characters. The binary response supplies no billed character receipt; the cost remains an estimate.' };
}
/** Save only recognised numeric metering fields, never response text, reasoning or credentials. */
function cleanUsage(raw: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}, u = object(raw);
  const keys = ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens', 'audio_tokens', 'total_seconds', 'input_seconds', 'output_seconds', 'input_image_count', 'input_audio_seconds'];
  for (const key of keys) if (seconds(u[key]) !== null) result[key] = u[key];
  for (const key of ['input_tokens_details', 'output_tokens_details', 'prompt_tokens_details', 'completion_tokens_details']) {
    const d = object(u[key]), clean: Record<string, unknown> = {};
    for (const field of ['cached_tokens', 'reasoning_tokens', 'audio_tokens']) if (count(d[field]) !== null) clean[field] = d[field];
    if (Object.keys(clean).length) result[key] = clean;
  }
  return result;
}
function validUsage(raw: unknown): boolean {
  const u = object(raw);
  for (const key of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens', 'audio_tokens', 'input_image_count'])
    if (u[key] !== undefined && u[key] !== null && count(u[key]) === null) return false;
  for (const key of ['total_seconds', 'input_seconds', 'output_seconds', 'input_audio_seconds'])
    if (u[key] !== undefined && u[key] !== null && seconds(u[key]) === null) return false;
  for (const key of ['input_tokens_details', 'output_tokens_details', 'prompt_tokens_details', 'completion_tokens_details'])
    if (u[key] !== undefined && u[key] !== null && !validUsage(u[key])) return false;
  return true;
}
export function parseUsage(raw: unknown): UsageMetrics {
  const u = object(raw), input = object(u['input_tokens_details'] ?? u['prompt_tokens_details']), output = object(u['output_tokens_details'] ?? u['completion_tokens_details']);
  const m = emptyMetrics();
  m.inputTokens = count(u['input_tokens'] ?? u['prompt_tokens']); m.outputTokens = count(u['output_tokens'] ?? u['completion_tokens']);
  m.totalTokens = count(u['total_tokens']) ?? (m.inputTokens !== null && m.outputTokens !== null ? count(m.inputTokens + m.outputTokens) : null);
  m.cachedTokens = count(input['cached_tokens'] ?? u['cached_tokens']); m.reasoningTokens = count(output['reasoning_tokens'] ?? u['reasoning_tokens']);
  m.inputAudioTokens = count(input['audio_tokens']); m.outputAudioTokens = count(output['audio_tokens']);
  m.inputVideoSeconds = seconds(u['input_seconds']); m.outputVideoSeconds = seconds(u['output_seconds']);
  m.inputImages = count(u['input_image_count']); m.inputAudioSeconds = seconds(u['input_audio_seconds']);
  return m;
}
function price(rate: UsageRate, m: UsageMetrics): number | null {
  let micros: number | null = null;
  if (rate.unit === 'tokens' && m.inputTokens !== null && m.outputTokens !== null) {
    const r = rate.longContext && m.inputTokens > rate.longContext.threshold ? rate.longContext : rate;
    const cache = m.cachedTokens ?? 0;
    // With a cache discount, absent cache telemetry is not evidence of zero cache use.
    if (m.inputTokens > 0 && m.cachedTokens === null && r.cached !== null && r.cached !== r.input) return null;
    if (cache > m.inputTokens || (m.reasoningTokens ?? 0) > m.outputTokens || (m.totalTokens !== null && m.totalTokens !== m.inputTokens + m.outputTokens)) return null;
    if (r.input !== null && r.output !== null && (!cache || r.cached !== null)) micros = (m.inputTokens - cache) * r.input + cache * (r.cached ?? 0) + m.outputTokens * r.output;
  } else if (rate.unit === 'seconds' && m.outputVideoSeconds !== null && rate.perSecond !== null) {
    if (rate.extraImage !== null && (m.inputVideoSeconds === null || m.inputImages === null)) return null;
    micros = ((m.outputVideoSeconds + (m.inputVideoSeconds ?? 0)) * rate.perSecond + Math.max(0, (m.inputImages ?? 0) - rate.freeImages) * (rate.extraImage ?? 0)) * 1e6;
  } else if (rate.unit === 'pixel-frame-tokens' && m.pixelFrameTokens !== null && rate.output !== null) micros = m.pixelFrameTokens * rate.output;
  return micros !== null && Number.isSafeInteger(Math.ceil(micros)) && micros >= 0 ? Math.ceil(micros) : null;
}

export class UsageLedger {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  begin(context: UsageContext & { provider: string; model: string; effectKey?: string; rate: UsageRate; estimatedMicros: number | null }, budget?: { day: string; limitUsd: number }, quota?: { day: string; limit: number }): UsageEntry {
    return this.store.transaction(() => {
      const id = randomUUID(), key = context.effectKey ?? id;
      if (context.effectKey && !this.store.startEffect(key)) throw new AppError('This paid request already has a recorded outcome. Reconcile it before resubmitting.');
      const entry: UsageEntry = { ...context, agentRole: context.agentRole ?? AGENT_ROLES[context.action], agentVersion: context.agentVersion ?? "workflow-v1", id, effectKey: key, chargeKey: budget ? `usage:${id}` : '', attempt: Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE effect_key=?').get(key)?.['n'] ?? 0) + 1,
        createdAt: nowIso(), updatedAt: nowIso(), latencyMs: null, state: 'pending', costStatus: context.estimatedMicros === null ? 'unknown' : 'reserved', costMicros: null, currency: 'USD', metrics: emptyMetrics(), requestId: '', taskId: '', httpStatus: null, detail: '', rawUsage: {} };
      if (budget) {
        if (context.estimatedMicros === null) throw new AppError('Configure a production rate before starting a paid request.');
        this.store.reserveChargeInTransaction(entry.chargeKey, context.brandId, budget.day, context.estimatedMicros, budget.limitUsd);
      }
      if (quota) {
        const used = Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM engagement_ai_usage WHERE brand_id=? AND day=?').get(context.brandId, quota.day)?.['n'] ?? 0);
        if (used >= quota.limit) throw new AppError('Daily AI request allowance reached. This conversation needs review.');
        this.store.db.prepare('INSERT INTO engagement_ai_usage(id,brand_id,day,model) VALUES(?,?,?,?)').run(id, context.brandId, quota.day, context.model);
      }
      this.save(entry); return entry;
    });
  }
  get(id: string): UsageEntry | undefined {
    const row = this.store.db.prepare('SELECT data FROM ai_usage WHERE id=?').get(id);
    return row ? JSON.parse(String(row['data'])) as UsageEntry : undefined;
  }
  forEffect(key: string): UsageEntry | undefined {
    const row = this.store.db.prepare('SELECT data FROM ai_usage WHERE effect_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(key);
    return row ? JSON.parse(String(row['data'])) as UsageEntry : undefined;
  }
  save(entry: UsageEntry): void {
    this.store.db.prepare('INSERT INTO ai_usage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entry.id, entry.effectKey, entry.brandId, entry.createdAt, JSON.stringify(entry));
  }
  update(id: string, patch: Partial<UsageEntry>): UsageEntry {
    return this.store.transaction(() => {
      const old = this.get(id); if (!old) throw new AppError('Usage record not found.', 404);
      const entry = { ...old, ...patch, updatedAt: nowIso() };
      this.save(entry);
      if (entry.chargeKey && entry.costMicros !== null) this.store.settleCharge(entry.chargeKey, entry.costMicros);
      return entry;
    });
  }
  response(id: string, response: Response, envelope: unknown = {}): void {
    const e = this.get(id)!, data = object(envelope), raw = cleanUsage(data['usage']), metrics = parseUsage(raw);
    const cost = validUsage(data['usage']) ? price(e.rate, metrics) : null, rejected = !response.ok && response.status >= 400 && response.status < 500 && response.status !== 408 && cost === null && !Object.keys(raw).length && !Object.keys(object(data['usage'])).length;
    this.update(id, { rawUsage: raw, metrics, requestId: identifier(response.headers.get('x-request-id')) || identifier(data['request_id']) || identifier(data['id']), httpStatus: response.status,
      latencyMs: Math.max(0, Date.now() - Date.parse(e.createdAt)), state: response.ok ? 'succeeded' : rejected ? 'rejected' : 'unknown',
      costMicros: cost ?? (rejected ? 0 : null), costStatus: cost !== null ? 'calculated' : rejected ? 'not-charged' : response.ok && e.estimatedMicros !== null ? 'estimated' : 'unknown',
      detail: cost !== null ? 'Calculated from provider usage and the saved rate; excludes taxes, credits and account discounts.' : rejected ? `Request rejected before generation (HTTP ${response.status}).` : 'Provider did not return enough valid billing metrics. The request estimate is retained.' });
  }
  failure(id: string, detail: string): void {
    const e = this.get(id)!;
    if (e.state === 'rejected') return;
    this.update(id, { state: e.state === 'pending' || e.state === 'unknown' ? 'unknown' : 'failed', costStatus: e.costStatus === 'reserved' ? 'unknown' : e.costStatus,
      latencyMs: Math.max(0, Date.now() - Date.parse(e.createdAt)), detail });
  }
  task(key: string, task: TaskStatus): void {
    const e = this.forEffect(key); if (!e || e.taskId && e.taskId !== task.taskId) return;
    if (!['SUCCEEDED', 'FAILED', 'EXPIRED'].includes(task.state)) return;
    const raw = cleanUsage(task.usage), metrics = parseUsage(raw);
    if (e.rate.unit === 'pixel-frame-tokens') metrics.pixelFrameTokens = count(task.billedUnits);
    if (e.rate.unit === 'seconds' && metrics.outputVideoSeconds === null) metrics.outputVideoSeconds = seconds(task.billedUnits);
    const cost = validUsage(task.usage) ? price(e.rate, metrics) : null;
    // Repeated polling/download recovery must not replace an earlier complete receipt.
    if (e.costStatus === 'calculated' && cost === null) return;
    if (e.costStatus === 'calculated' && cost === e.costMicros && JSON.stringify(raw) === JSON.stringify(e.rawUsage)) return;
    this.update(e.id, { rawUsage: raw, metrics, taskId: task.taskId, state: task.state === 'SUCCEEDED' ? 'succeeded' : 'failed', costMicros: cost,
      costStatus: cost !== null ? 'calculated' : e.estimatedMicros !== null ? 'estimated' : 'unknown', latencyMs: Math.max(0, Date.now() - Date.parse(e.createdAt)),
      detail: cost !== null ? 'Calculated from the provider task receipt and the rate saved at submission. H3 token counts are informational; H3 is billed in seconds and extra images.' : 'Task ended without a complete billing receipt. Estimated cost is retained, including failed or filtered generations.' });
  }
  query(params: URLSearchParams, exportAll = false) {
    const clauses: string[] = [], values: Array<string | number> = [];
    for (const [param, column] of [['brand', 'brand_id'], ['provider', "json_extract(data,'$.provider')"], ['model', "json_extract(data,'$.model')"], ['action', "json_extract(data,'$.action')"], ['agent', "json_extract(data,'$.agentRole')"], ['status', "json_extract(data,'$.costStatus')"], ['run', "json_extract(data,'$.runId')"], ['creative', "json_extract(data,'$.creativeId')"]]) {
      const value = params.get(param!); if (value) { if (value.length > 250) throw new AppError('Usage filter is too long.'); clauses.push(`${column}=?`); values.push(value); }
    }
    for (const date of ['from', 'to']) {
      const value = params.get(date); if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError('Usage dates must be valid YYYY-MM-DD dates in UTC.');
      clauses.push(`created_at${date === 'from' ? '>=' : '<='}?`); values.push(value + (date === 'from' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'));
    }
    if (params.get('from') && params.get('to') && params.get('from')! > params.get('to')!) throw new AppError('Start date must be before the end date.');
    const offset = Number(params.get('offset') ?? 0), limit = exportAll ? 10000 : Number(params.get('limit') ?? 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > (exportAll ? 10000 : 200)) throw new AppError('Invalid usage pagination.');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const aggregate = `COUNT(*) AS requests,COALESCE(SUM(CASE WHEN json_extract(data,'$.costStatus')='calculated' THEN json_extract(data,'$.costMicros') ELSE 0 END),0) AS calculatedMicros,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.costStatus') IN ('reserved','estimated','unknown') THEN json_extract(data,'$.estimatedMicros') ELSE 0 END),0) AS estimatedMicros,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.costStatus')='reserved' THEN 1 ELSE 0 END),0) AS pendingRequests,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.costStatus')='unknown' THEN 1 ELSE 0 END),0) AS unknownRequests,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.estimatedMicros') IS NULL AND json_extract(data,'$.costMicros') IS NULL THEN 1 ELSE 0 END),0) AS unpricedRequests,
      ${Object.keys(emptyMetrics()).map(k => `COALESCE(SUM(json_extract(data,'$.metrics.${k}')),0) AS ${k},COUNT(json_extract(data,'$.metrics.${k}')) AS ${k}Reports`).join(',')},
      COALESCE(SUM(CASE WHEN json_extract(data,'$.metrics.totalTokens') IS NULL THEN 1 ELSE 0 END),0) AS missingTokenRequests`;
    const totals = this.store.db.prepare(`SELECT ${aggregate} FROM ai_usage${where}`).get(...values)!;
    if (exportAll && Number(totals['requests']) > limit) throw new AppError('This export exceeds 10,000 requests. Narrow the date or brand filters.');
    const rows = this.store.db.prepare(`SELECT data FROM ai_usage${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values, limit + 1, exportAll ? 0 : offset);
    const grouped = (expression: string) => this.store.db.prepare(`SELECT ${expression} AS label,${aggregate} FROM ai_usage${where} GROUP BY ${expression} ORDER BY calculatedMicros+estimatedMicros DESC,label`).all(...values);
    return { currency: 'USD', timezone: 'UTC', totals, byModel: grouped("json_extract(data,'$.provider') || ' / ' || json_extract(data,'$.model')"), byAction: grouped("json_extract(data,'$.action')"), byAgent: grouped("COALESCE(json_extract(data,'$.agentRole'),'unattributed')"), byBrand: grouped('brand_id'),
      byDay: grouped('substr(created_at,1,10)'), entries: rows.slice(0, limit).map(r => JSON.parse(String(r['data'])) as UsageEntry), offset, limit, hasMore: rows.length > limit };
  }
}

/** Preserve historical allowances without inventing token splits or billed receipts. */
export function migrateUsage(store: Store): void {
  if (store.setting('usageMigration', 0) >= 1) return;
  store.transaction(() => {
    const ledger = new UsageLedger(store);
    for (const row of store.db.prepare('SELECT * FROM charges').iterate()) {
      const key = String(row['key']), parts = key.split(':'), entity = parts[1] ?? '';
      const creative = store.get<{ runId: string; provider: string; model: string }>('creatives', entity);
      const effect = store.effect(key);
      ledger.save({ id: `legacy:${key}`, effectKey: key, chargeKey: key, brandId: String(row['brand_id']), action: 'legacy', runId: creative?.runId ?? (parts[0] === 'copy' ? entity : ''), creativeId: creative ? entity : '',
        attempt: 1, provider: parts[0] === 'video' ? creative?.provider ?? 'unknown' : ['copy', 'speech', 'visual'].includes(parts[0] ?? '') ? 'openai' : 'unknown', model: parts[0] === 'video' ? creative?.model ?? 'Historical video' : parts[0] === 'speech' ? 'tts-1' : 'Historical production', createdAt: `${row['day']}T00:00:00.000Z`, updatedAt: nowIso(), latencyMs: null, state: 'legacy',
        costStatus: effect?.state === 'pending' ? 'unknown' : 'estimated', estimatedMicros: Number(row['micros']), costMicros: null, currency: 'USD', rate: blankRate(), metrics: emptyMetrics(), requestId: '', taskId: parts[0] === 'video' && effect?.state === 'done' ? identifier(effect.value) : '', httpStatus: null,
        detail: 'Historical production allowance. Original request time, rate and provider receipt were not captured.', rawUsage: {} });
    }
    for (const row of store.db.prepare('SELECT * FROM engagement_ai_usage').iterate()) ledger.save({ id: `legacy-ai:${row['id']}`, effectKey: String(row['id']), chargeKey: '', brandId: String(row['brand_id']), action: 'legacy', attempt: 1, provider: String(row['model']).startsWith('MiniMax') ? 'minimax' : 'glm', model: String(row['model']), createdAt: `${row['day']}T00:00:00.000Z`, updatedAt: nowIso(), latencyMs: null, state: 'legacy', costStatus: 'unknown', estimatedMicros: null, costMicros: null, currency: 'USD', rate: blankRate(), metrics: { ...emptyMetrics(), totalTokens: Number(row['tokens']) || null }, requestId: '', taskId: '', httpStatus: null, detail: 'Historical engagement request. Token split and USD charge are unavailable.', rawUsage: {} });
    store.setSetting('usageMigration', 1);
  });
}
