import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../app/store.ts';
import { AppError, nowIso, type CampaignRun, type ManagedBrand, type Metric } from '../app/types.ts';
import { UsageLedger, type UsageEntry } from '../app/usage.ts';
import { currencyOffset } from '../meta/publish.ts';
import { createSeededRng, sampleGamma } from '../autonomy/posterior.ts';
import { BrandMemory } from './memory.ts';
import { bounded, object, text } from './contracts.ts';

export interface EconomicsConfig {
  currency: string; usdToCurrency: number | null; fxDate: string; fxSource: string;
  outcomesCompleteThrough: string; metricsCompleteThrough: string;
  unitContributionMinor: number | null; forecastCpaMinor: number | null;
}
export interface BusinessOutcome {
  id: string; brandId: string; externalId: string; version: number; runId: string; adId: string;
  occurredAt: string; currency: string; revenueMinor: number; contributionMinor: number; qualified: boolean; createdAt: string;
}
export interface CostAdjustment {
  id: string; brandId: string; kind: 'receipt' | 'overhead'; externalId: string; version: number;
  usageId: string; runId: string; amountMicros: number; amountMinor: number; currency: string; date: string; note: string; createdAt: string;
}
export interface Experiment {
  id: string; brandId: string; name: string; hypothesis: string; control: string[]; treatment: string[];
  from: string; to: string; minOutcomes: number; probabilityThreshold: number; minimumLift: number;
  design: 'observational' | 'external-randomized'; designReference: string; preregistered: boolean;
  economics: EconomicsConfig; attributionDays: number; createdAt: string; evaluations: Evaluation[];
}
export interface Evaluation {
  id: string; createdAt: string; evidenceHash: string; verdict: 'insufficient' | 'promote' | 'retain-control' | 'inconclusive';
  probabilityOfImprovement: number | null; reasons: string[]; control: RoiReport; treatment: RoiReport; memoryId: string;
}
export interface RoiReport {
  brandId: string; currency: string; from: string; to: string; runIds: string[];
  adSpendMinor: number; reportedMetaRevenueMinor: number; revenueMinor: number; contributionMinor: number; qualifiedOutcomes: number;
  aiUsd: number; estimatedAiUsd: number; reconciledRequests: number; unresolvedRequests: number; aiMinor: number | null;
  overheadMinor: number; marketingCostMinor: number | null; netContributionMinor: number | null; netRoi: number | null; provisionalRoi: number | null;
  costPerQualifiedMinor: number | null; complete: boolean; limitations: string[]; byRole: Array<{ role: string; requests: number; usd: number; estimatedUsd: number }>;
  fx: { rate: number | null; date: string; source: string }; outcomeValues: number[];
}
function date(raw: unknown, label: string): string {
  const value = text(raw, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new AppError(`Enter a valid ${label}.`);
  return value;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const minor = (v: unknown, label: string, min = 0) => { const n = bounded(v, label, min, 1e12); if (!Number.isSafeInteger(n)) throw new AppError(`${label} must be an integer in currency minor units.`); return n; };
const contributionBucketLimit = 512;
function contributionBuckets(values: number[]): Array<[number, number]> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]);
}
export class Economics {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  brand(id: string): ManagedBrand { const b = this.store.get<ManagedBrand>('brands', id); if (!b) throw new AppError('Brand not found.', 404); return b; }
  config(brandId: string): EconomicsConfig {
    const b = this.brand(brandId);
    return this.store.setting<EconomicsConfig>(`economics:${brandId}`, { currency: b.currency, usdToCurrency: b.currency === 'USD' ? 1 : null, fxDate: '', fxSource: '', outcomesCompleteThrough: '', metricsCompleteThrough: '', unitContributionMinor: null, forecastCpaMinor: null });
  }
  saveConfig(brandId: string, input: unknown): EconomicsConfig {
    const old = this.config(brandId), o = object(input);
    const value: EconomicsConfig = { currency: this.brand(brandId).currency,
      usdToCurrency: this.brand(brandId).currency === 'USD' ? 1 : o['usdToCurrency'] === undefined ? old.usdToCurrency : o['usdToCurrency'] === null || o['usdToCurrency'] === '' ? null : bounded(o['usdToCurrency'], 'USD exchange rate', 0.000001, 1000000, old.usdToCurrency ?? undefined),
      fxDate: o['fxDate'] ? date(o['fxDate'], 'FX date') : old.fxDate, fxSource: text(o['fxSource'] ?? old.fxSource, 'FX source', 250, false),
      outcomesCompleteThrough: o['outcomesCompleteThrough'] ? date(o['outcomesCompleteThrough'], 'outcome coverage date') : old.outcomesCompleteThrough,
      metricsCompleteThrough: o['metricsCompleteThrough'] ? date(o['metricsCompleteThrough'], 'Meta coverage date') : old.metricsCompleteThrough,
      unitContributionMinor: o['unitContributionMinor'] === null || o['unitContributionMinor'] === '' ? null : o['unitContributionMinor'] === undefined ? old.unitContributionMinor : minor(o['unitContributionMinor'], 'Contribution per outcome'),
      forecastCpaMinor: o['forecastCpaMinor'] === null || o['forecastCpaMinor'] === '' ? null : o['forecastCpaMinor'] === undefined ? old.forecastCpaMinor : minor(o['forecastCpaMinor'], 'Forecast CPA', 1) };
    if (value.currency !== 'USD' && value.usdToCurrency !== null && (!value.fxDate || !value.fxSource)) throw new AppError('Record the exchange-rate date and source.');
    if ([value.outcomesCompleteThrough, value.metricsCompleteThrough, value.fxDate].some(d => d > nowIso().slice(0, 10))) throw new AppError('Coverage and exchange rates cannot be dated in the future.');
    this.store.setSetting(`economics:${brandId}`, value); return value;
  }
  private ownedRun(brandId: string, id: string, live = false): CampaignRun {
    const run = this.store.get<CampaignRun>('runs', id);
    if (!run || run.brandId !== brandId || live && run.mode !== 'LIVE') throw new AppError('Choose a campaign belonging to this brand' + (live ? ' in live mode.' : '.'));
    return run;
  }
  private revisions<T>(collection: 'businessOutcomes' | 'costAdjustments', brandId: string): T[] {
    return this.store.db.prepare(`SELECT data FROM (
      SELECT data, ROW_NUMBER() OVER (PARTITION BY json_extract(data,'$.externalId') ORDER BY json_extract(data,'$.version') DESC) AS revision
      FROM documents WHERE collection=? AND brand_id=?) WHERE revision=1`).all(collection, brandId).map(r => JSON.parse(String(r['data'])) as T);
  }
  private previous<T>(collection: 'businessOutcomes' | 'costAdjustments', brandId: string, externalId: string): T | undefined {
    const row = this.store.db.prepare("SELECT data FROM documents WHERE collection=? AND brand_id=? AND json_extract(data,'$.externalId')=? ORDER BY json_extract(data,'$.version') DESC LIMIT 1").get(collection, brandId, externalId);
    return row ? JSON.parse(String(row['data'])) as T : undefined;
  }
  outcomes(brandId: string): BusinessOutcome[] { return this.revisions<BusinessOutcome>('businessOutcomes', brandId); }
  recordOutcome(brandId: string, input: unknown): BusinessOutcome {
    const b = this.brand(brandId), o = object(input), externalId = text(o['externalId'], 'opaque order or CRM record ID', 120);
    if (!/^[\w.:/-]+$/.test(externalId)) throw new AppError('Use an opaque order/CRM identifier without customer contact details.');
    const runId = text(o['runId'], 'campaign run ID', 100), run = this.ownedRun(brandId, runId, true), adId = text(o['adId'] ?? '', 'ad ID', 100, false);
    if (adId && !run.stages.some(s => s.adIds.includes(adId))) throw new AppError('This ad does not belong to the selected campaign.');
    const occurredAt = text(o['occurredAt'], 'outcome timestamp', 35);
    if (!Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now() + 60000 || Date.parse(occurredAt) < Date.parse(run.createdAt)) throw new AppError('Outcome time must fall after campaign creation and no later than now.');
    if (o['currency'] !== b.currency || typeof o['qualified'] !== 'boolean') throw new AppError('Supply the brand currency and a boolean qualification status.');
    const version = minor(o['version'], 'Outcome revision', 1);
    const value: BusinessOutcome = { id: digest([brandId, externalId, version]), brandId, externalId, version, runId, adId, occurredAt: new Date(occurredAt).toISOString(), currency: b.currency,
      revenueMinor: minor(o['revenueMinor'], 'Net revenue'), contributionMinor: minor(o['contributionMinor'], 'Contribution after fulfilment costs', -1e12), qualified: o['qualified'], createdAt: nowIso() };
    if (value.contributionMinor > value.revenueMinor) throw new AppError('Contribution cannot exceed net revenue.');
    return this.store.transaction(() => {
      const prior = this.previous<BusinessOutcome>('businessOutcomes', brandId, externalId);
      if (prior && prior.version === version) { if (JSON.stringify({ ...prior, createdAt: '' }) !== JSON.stringify({ ...value, createdAt: '' })) throw new AppError('This outcome revision already exists with different data.', 409); return prior; }
      if (version !== (prior?.version ?? 0) + 1) throw new AppError('Outcome revisions must be consecutive, starting at 1.', 409);
      if (prior && (prior.runId !== runId || prior.adId !== adId || prior.occurredAt !== value.occurredAt)) throw new AppError('A refund/revision keeps the original attribution and outcome time.');
      this.store.put('businessOutcomes', value); return value;
    });
  }
  adjustments(brandId: string): CostAdjustment[] { return this.revisions<CostAdjustment>('costAdjustments', brandId); }
  recordCost(brandId: string, input: unknown): CostAdjustment {
    const b = this.brand(brandId), o = object(input), kind = o['kind']; if (!['receipt', 'overhead'].includes(String(kind))) throw new AppError('Choose a provider receipt or operating cost.');
    const usageId = text(o['usageId'] ?? '', 'usage ID', 120, false), usage = usageId ? new UsageLedger(this.store).get(usageId) : undefined;
    if (kind === 'receipt' && (!usage || usage.brandId !== brandId)) throw new AppError('Choose a metered request belonging to this brand.');
    const runId = kind === 'receipt' ? usage?.runId ?? '' : text(o['runId'] ?? '', 'run ID', 100, false);
    if (runId) this.ownedRun(brandId, runId);
    const externalId = kind === 'receipt' ? `receipt:${usageId}` : `overhead:${text(o['externalId'], 'cost record ID', 120)}`;
    return this.store.transaction(() => {
      const prior = this.previous<CostAdjustment>('costAdjustments', brandId, externalId);
      const value: CostAdjustment = { id: randomUUID(), brandId, kind: kind as CostAdjustment['kind'], externalId, version: (prior?.version ?? 0) + 1, usageId, runId,
        amountMicros: kind === 'receipt' ? minor(o['amountMicros'], 'Receipt total in USD millionths') : 0,
        amountMinor: kind === 'overhead' ? minor(o['amountMinor'], 'Operating cost') : 0, currency: kind === 'receipt' ? 'USD' : b.currency,
        date: date(o['date'], 'cost date'), note: text(o['note'], 'invoice reference or cost explanation', 500), createdAt: nowIso() };
      if (value.date > nowIso().slice(0, 10)) throw new AppError('An incurred cost cannot be dated in the future.');
      this.store.put('costAdjustments', value);
      if (kind === 'receipt' && usage?.chargeKey) this.store.settleCharge(usage.chargeKey, value.amountMicros);
      return value;
    });
  }
  report(brandId: string, options: { from: string; to: string; runIds?: string[]; economics?: EconomicsConfig; attributionDays?: number }): RoiReport {
    const brand = this.brand(brandId), from = date(options.from, 'start date'), to = date(options.to, 'end date'), config = options.economics ?? this.config(brandId), coverage = this.config(brandId);
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new AppError('Choose an ordered reporting period of at most 367 days.');
    const runIds = options.runIds ?? [], runSet = new Set(runIds); for (const id of runIds) this.ownedRun(brandId, id);
    const included = (runId: string) => !runIds.length || runSet.has(runId), inPeriod = (d: string) => d.slice(0, 10) >= from && d.slice(0, 10) <= to;
    const limitations: string[] = [], seen = new Set<string>();
    const metricRows = this.store.list<Metric>('metrics', brandId, 100001);
    if (metricRows.length > 100000) limitations.push('The local report exceeds 100,000 metric observations. Reconcile an external aggregate before relying on ROI or promoting an experiment.');
    const metrics = metricRows.sort((a, b) => b.observedAt.localeCompare(a.observedAt)).filter(m => {
      const key = `${m.adId}:${m.date}`; if (m.simulation || !included(m.runId) || !inPeriod(m.date) || seen.has(key)) return false; seen.add(key);
      if (m.currency !== brand.currency) { limitations.push('Meta metrics contain a different currency.'); return false; } return true;
    });
    const outcomes = this.outcomes(brandId).filter(o => included(o.runId) && inPeriod(o.occurredAt));
    const adjustments = this.adjustments(brandId), receipts = new Map(adjustments.filter(a => a.kind === 'receipt').map(a => [a.usageId, a]));
    // For a campaign comparison charge all its production, including pre-launch and failed attempts, once.
    const usage = this.store.db.prepare('SELECT data FROM ai_usage WHERE brand_id=?').all(brandId).map(r => JSON.parse(String(r['data'])) as UsageEntry).filter(u => included(u.runId ?? '') && (runIds.length ? u.createdAt.slice(0, 10) <= to : inPeriod(u.createdAt)));
    let aiUsd = 0, estimatedAiUsd = 0, unresolvedRequests = 0, reconciledRequests = 0;
    const roles = new Map<string, { role: string; requests: number; usd: number; estimatedUsd: number }>();
    for (const entry of usage) {
      const receipt = receipts.get(entry.id), unknown = !receipt && entry.costStatus !== 'not-charged' && (entry.costMicros === null || ['pending', 'running', 'unknown'].includes(entry.state));
      const micros = receipt?.amountMicros ?? (entry.costStatus === 'not-charged' ? 0 : entry.costMicros ?? entry.estimatedMicros ?? 0);
      aiUsd += micros / 1e6; if (unknown) { estimatedAiUsd += micros / 1e6; unresolvedRequests++; } if (receipt) reconciledRequests++;
      const role = entry.agentRole ?? 'unattributed', row = roles.get(role) ?? { role, requests: 0, usd: 0, estimatedUsd: 0 }; row.requests++; row.usd += micros / 1e6; if (unknown) row.estimatedUsd += micros / 1e6; roles.set(role, row);
    }
    if (unresolvedRequests) limitations.push(`${unresolvedRequests} AI requests need a complete receipt or invoice reconciliation.`);
    if (coverage.outcomesCompleteThrough < to) limitations.push('Order/CRM outcome coverage has not been confirmed through the reporting end date.');
    if (coverage.metricsCompleteThrough < to) limitations.push('Meta spend coverage has not been confirmed through the reporting end date.');
    if (Date.parse(to + 'T23:59:59Z') + ((options.attributionDays ?? brand.attributionClickDays) + 2) * 86400000 > Date.now()) limitations.push('The attribution and reporting-lag window has not matured.');
    if (outcomes.some(o => o.currency !== brand.currency) || config.currency !== brand.currency) limitations.push('The saved reporting currency does not match current brand settings.');
    const adSpendMinor = metrics.reduce((n, m) => n + m.spendMinor, 0), revenueMinor = outcomes.reduce((n, o) => n + o.revenueMinor, 0), contributionMinor = outcomes.reduce((n, o) => n + o.contributionMinor, 0);
    const qualifiedOutcomes = outcomes.filter(o => o.qualified).length;
    const overheadMinor = adjustments.filter(a => a.kind === 'overhead' && included(a.runId) && inPeriod(a.date)).reduce((n, a) => n + a.amountMinor, 0);
    if (runIds.length && (this.store.db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE brand_id=? AND COALESCE(json_extract(data,'$.runId'),'')='' AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").get(brandId, from, to)?.['n'] || adjustments.some(a => a.kind === 'overhead' && !a.runId && inPeriod(a.date)))) limitations.push('Shared brand costs are unallocated. Assign operating costs to runs and include shared AI analysis in the brand-level ROI view.');
    const fx = brand.currency === 'USD' ? 1 : config.usdToCurrency;
    if (fx === null && aiUsd > 0) limitations.push('Set a dated USD exchange rate before combining AI and advertising costs.');
    const aiMinor = aiUsd === 0 ? 0 : fx === null ? null : Math.round(aiUsd * fx * currencyOffset(brand.currency));
    const marketingCostMinor = aiMinor === null ? null : adSpendMinor + aiMinor + overheadMinor;
    const provisionalRoi = marketingCostMinor && marketingCostMinor > 0 ? (contributionMinor - marketingCostMinor) / marketingCostMinor : null;
    const complete = !limitations.length;
    return { brandId, currency: brand.currency, from, to, runIds, adSpendMinor, reportedMetaRevenueMinor: metrics.reduce((n, m) => n + m.revenueMinor, 0), revenueMinor, contributionMinor, qualifiedOutcomes,
      aiUsd, estimatedAiUsd, reconciledRequests, unresolvedRequests, aiMinor, overheadMinor, marketingCostMinor, netContributionMinor: marketingCostMinor === null ? null : contributionMinor - marketingCostMinor,
      netRoi: complete ? provisionalRoi : null, provisionalRoi, costPerQualifiedMinor: qualifiedOutcomes && marketingCostMinor !== null ? marketingCostMinor / qualifiedOutcomes : null, complete, limitations: [...new Set(limitations)], byRole: [...roles.values()], fx: { rate: fx, date: config.fxDate, source: config.fxSource }, outcomeValues: outcomes.filter(o => o.qualified).map(o => o.contributionMinor) };
  }
  forecast(brandId: string, adBudgetMinor: number, aiUsd: number) {
    const config = this.config(brandId), b = this.brand(brandId);
    minor(adBudgetMinor, 'Scenario advertising budget'); bounded(aiUsd, 'Forecast AI cost', 0, 100000);
    const baseCpa = config.forecastCpaMinor, contribution = config.unitContributionMinor;
    return { currency: b.currency, assumptions: 'Owner-entered CPA and contribution after fulfilment costs. Low/high outcomes use ±30% CPA, not statistical confidence bounds. Advertising delivery and ROI are not guaranteed.',
      scenarios: ['low', 'base', 'high'].map((name, i) => {
        const cpaMinor = baseCpa === null ? null : baseCpa * [1.3, 1, 0.7][i]!, outcomes = cpaMinor ? adBudgetMinor / cpaMinor : null;
        const marketingMinor = config.usdToCurrency === null && aiUsd ? null : adBudgetMinor + aiUsd * (config.usdToCurrency ?? 0) * currencyOffset(b.currency);
        const netContributionMinor = outcomes === null || contribution === null || marketingMinor === null ? null : outcomes * contribution - marketingMinor;
        return { name, cpaMinor, outcomes, marketingMinor, netContributionMinor, netRoi: netContributionMinor !== null && marketingMinor ? netContributionMinor / marketingMinor : null };
      }) };
  }
  experiments(brandId: string): Experiment[] { return this.store.list<Experiment>('experiments', brandId); }
  createExperiment(brandId: string, input: unknown): Experiment {
    const b = this.brand(brandId), o = object(input);
    if (b.currency !== 'USD' && this.config(brandId).usdToCurrency === null) throw new AppError('Set a dated USD exchange rate before freezing experiment economics.');
    const ids = (key: string) => { const list = o[key]; if (!Array.isArray(list) || !list.length || list.length > 10) throw new AppError('Select 1–10 campaign runs in each experiment arm.'); return list.map(id => text(id, 'run ID', 100)); };
    const control = ids('control'), treatment = ids('treatment'), all = [...control, ...treatment];
    if (new Set(all).size !== all.length) throw new AppError('A campaign cannot appear twice or in both experiment arms.');
    for (const id of all) this.ownedRun(brandId, id, true);
    const from = date(o['from'], 'experiment start date'), to = date(o['to'], 'experiment end date');
    if (from > to || Date.parse(to) - Date.parse(from) > 90 * 86400000) throw new AppError('Experiment periods must be ordered and at most 91 days.');
    const design = o['design'] ?? 'observational'; if (!['observational', 'external-randomized'].includes(String(design))) throw new AppError('Choose the comparison design.');
    const designReference = text(o['designReference'] ?? '', 'external randomization reference', 500, false);
    if (design === 'external-randomized' && !designReference) throw new AppError('Record the externally configured audience split/randomization reference.');
    const value: Experiment = { id: randomUUID(), brandId, name: text(o['name'], 'experiment name', 150), hypothesis: text(o['hypothesis'], 'experiment hypothesis', 2000), control, treatment, from, to,
      minOutcomes: Math.floor(bounded(o['minOutcomes'], 'Minimum outcomes per arm', 30, 100000, 30)), probabilityThreshold: bounded(o['probabilityThreshold'], 'Evidence threshold', 0.95, 0.9999, 0.975), minimumLift: bounded(o['minimumLift'], 'Minimum relative improvement', 0.01, 1, 0.1),
      design: design as Experiment['design'], designReference, preregistered: from > nowIso().slice(0, 10), economics: this.config(brandId), attributionDays: b.attributionClickDays, createdAt: nowIso(), evaluations: [] };
    this.store.transaction(() => {
      for (const id of all) { const run = this.ownedRun(brandId, id, true); if (run.experimentId) throw new AppError('This campaign already belongs to an experiment.'); run.experimentId = value.id; this.store.put('runs', run); }
      this.store.put('experiments', value);
    }); return value;
  }
  evaluate(id: string): Evaluation {
    const experiment = this.store.get<Experiment>('experiments', id); if (!experiment) throw new AppError('Experiment not found.', 404);
    const options = { from: experiment.from, to: experiment.to, economics: experiment.economics, attributionDays: experiment.attributionDays };
    const control = this.report(experiment.brandId, { ...options, runIds: experiment.control }), treatment = this.report(experiment.brandId, { ...options, runIds: experiment.treatment });
    const evidenceHash = digest({ control, treatment }), previous = experiment.evaluations.at(-1); if (previous?.evidenceHash === evidenceHash) return previous;
    const reasons = [...control.limitations.map(s => `Control: ${s}`), ...treatment.limitations.map(s => `Treatment: ${s}`)];
    if (control.qualifiedOutcomes < experiment.minOutcomes || treatment.qualifiedOutcomes < experiment.minOutcomes) reasons.push(`At least ${experiment.minOutcomes} qualified outcomes are required in each arm.`);
    if (!control.marketingCostMinor || !treatment.marketingCostMinor) reasons.push('Both arms need recorded marketing expenditure.');
    const controlBuckets = contributionBuckets(control.outcomeValues), treatmentBuckets = contributionBuckets(treatment.outcomeValues);
    if (Math.max(controlBuckets.length, treatmentBuckets.length) > contributionBucketLimit) reasons.push(`This comparison exceeds ${contributionBucketLimit} distinct contribution values per arm. Use an external statistical evaluation; local automatic promotion is withheld.`);
    let probabilityOfImprovement: number | null = null, verdict: Evaluation['verdict'] = 'insufficient';
    if (!reasons.length) {
      // Gamma–Poisson efficiency plus a Bayesian bootstrap of observed contribution values.
      // This quantifies sampling uncertainty conditional on the comparison design, not causal identification.
      const rng = createSeededRng(parseInt(evidenceHash.slice(0, 8), 16)); let wins = 0;
      const drawReturn = (r: RoiReport, buckets: Array<[number, number]>) => {
        let weighted = 0, weight = 0;
        // Sum equal-value exponential weights with Gamma(count, 1), preserving the exact bootstrap distribution.
        for (const [value, count] of buckets) { const w = sampleGamma(count, 1, rng); weighted += w * value; weight += w; }
        const efficiency = sampleGamma(r.qualifiedOutcomes + 0.5, r.marketingCostMinor! + 0.5, rng);
        return efficiency * weighted / weight;
      };
      for (let i = 0; i < 4000; i++) if (drawReturn(treatment, treatmentBuckets) > drawReturn(control, controlBuckets) * (1 + experiment.minimumLift)) wins++;
      probabilityOfImprovement = wins / 4000;
      verdict = probabilityOfImprovement >= experiment.probabilityThreshold && treatment.netRoi !== null && treatment.netRoi > 0 && treatment.netRoi > (control.netRoi ?? 0) ? 'promote' : probabilityOfImprovement <= 1 - experiment.probabilityThreshold ? 'retain-control' : 'inconclusive';
    }
    if (experiment.design === 'observational') reasons.push('Observational comparison: audience, seasonality and delivery differences can explain the result.');
    if (!experiment.preregistered) reasons.push('This comparison was registered after its observation window began; it is exploratory.');
    const evaluation: Evaluation = { id: randomUUID(), createdAt: nowIso(), evidenceHash, verdict, probabilityOfImprovement, reasons, control, treatment, memoryId: '' };
    experiment.evaluations.push(evaluation); this.store.put('experiments', experiment);
    if (verdict !== 'promote') {
      const memory = new BrandMemory(this.store);
      for (const entry of memory.current(experiment.brandId).filter(m => m.experimentId === id && m.kind === 'playbook' && m.state === 'active')) {
        memory.append(experiment.brandId, { ...entry, state: 'retired', sourceIds: [id, evaluation.id], reason: 'Updated outcome or cost evidence no longer satisfies the experiment promotion gate.' }, 'evaluator');
      }
    }
    return evaluation;
  }
  promote(id: string, automatic = false) {
    const experiment = this.store.get<Experiment>('experiments', id); if (!experiment) throw new AppError('Experiment not found.', 404);
    const evaluation = this.evaluate(id);
    if (evaluation.verdict !== 'promote') throw new AppError('The evidence gate has not approved a playbook promotion.');
    if (automatic && (experiment.design !== 'external-randomized' || !experiment.preregistered)) throw new AppError('Automatic promotion requires a preregistered external randomized comparison.');
    if (evaluation.memoryId) return this.store.get('brandMemory', evaluation.memoryId);
    const memory = new BrandMemory(this.store).append(experiment.brandId, { kind: 'playbook', state: 'active', title: experiment.name, content: `${experiment.hypothesis}\nObserved treatment net marketing ROI ${(evaluation.treatment.netRoi! * 100).toFixed(1)}%, control ${(evaluation.control.netRoi! * 100).toFixed(1)}%. ${experiment.design === 'observational' ? 'An observational hypothesis to retest, not causal proof.' : 'Externally randomized design declared by owner; apply only within the tested brand and campaign context.'}`,
      sourceIds: [id, evaluation.id], experimentId: id, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), reason: automatic ? 'Automatic promotion passed fixed experiment evidence gates.' : 'Owner promoted the evaluated experiment.' });
    const fresh = this.store.get<Experiment>('experiments', id)!; fresh.evaluations.find(e => e.id === evaluation.id)!.memoryId = memory.id; this.store.put('experiments', fresh); return memory;
  }
}
