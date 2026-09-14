import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workspace, fixture } from './support/mock-workspace.ts';
import { Economics } from '../src/agents/economics.ts';
import { Registry } from '../src/agents/registry.ts';
import { BrandMemory } from '../src/agents/memory.ts';
import { UsageLedger, tokenRate } from '../src/app/usage.ts';
import { exposure } from '../src/agents/budgets.ts';
import type { CampaignRun, Metric } from '../src/app/types.ts';

const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const from = ago(35), to = ago(12), observed = ago(20);
function setup(currency = 'USD') {
  const w = workspace(), brand = fixture({ currency }); w.store.put('brands', brand); const economics = new Economics(w.store);
  const run = { ...w.engine.createRun(brand.id), createdAt: ago(60) + 'T00:00:00Z', status: 'complete' as const, stages: [{ stageId: 'engine', campaignId: 'c1', adSetId: 's1', adIds: ['ad1'], active: true, dailyBudgetMinor: 10000, primaryAction: 'purchase', attributionClickDays: 7 }] };
  w.store.put('runs', run);
  economics.saveConfig(brand.id, { outcomesCompleteThrough: to, metricsCompleteThrough: to });
  const metric: Metric = { id: randomUUID(), brandId: brand.id, runId: run.id, adId: 'ad1', adSetId: 's1', date: observed, observedAt: new Date().toISOString(), currency, spendMinor: 1000, impressions: 1000, clicks: 40, conversions: 2, revenueMinor: 90000, attribution: '7d_click', simulation: false, videoViews: 0 };
  w.store.put('metrics', metric);
  const outcome = { externalId: 'order-1', version: 1, runId: run.id, adId: 'ad1', occurredAt: observed + 'T12:00:00Z', currency, revenueMinor: 10000, contributionMinor: 6000, qualified: true };
  return { ...w, brand, economics, run, metric, outcome };
}
function request(w: ReturnType<typeof setup>, usd = 1) {
  const ledger = new UsageLedger(w.store), usage = ledger.begin({ brandId: w.brand.id, action: 'creative-copy', runId: w.run.id, provider: 'test', model: 'test', rate: tokenRate(1, 1, null, 'test'), estimatedMicros: usd * 1e6 });
  ledger.update(usage.id, { createdAt: observed + 'T00:00:00Z', state: 'unknown', costStatus: 'estimated' }); w.store.db.prepare('UPDATE ai_usage SET created_at=? WHERE id=?').run(observed + 'T00:00:00Z', usage.id); return ledger.get(usage.id)!;
}
test('order retries are idempotent and refund revisions replace net amounts without another sale', () => {
  const w = setup(); try {
    const first = w.economics.recordOutcome(w.brand.id, w.outcome); assert.deepEqual(w.economics.recordOutcome(w.brand.id, w.outcome), first);
    assert.throws(() => w.economics.recordOutcome(w.brand.id, { ...w.outcome, revenueMinor: 9000 }), /different data/);
    assert.throws(() => w.economics.recordOutcome(w.brand.id, { ...w.outcome, version: 3 }), /consecutive/);
    w.economics.recordOutcome(w.brand.id, { ...w.outcome, version: 2, revenueMinor: 4000, contributionMinor: 1000 });
    const report = w.economics.report(w.brand.id, { from, to });
    assert.equal(report.revenueMinor, 4000); assert.equal(report.qualifiedOutcomes, 1); assert.equal(report.contributionMinor, 1000); assert.equal(w.store.count('businessOutcomes'), 2);
    assert.equal(report.reportedMetaRevenueMinor, 90000); assert.equal(report.netRoi, 0);
  } finally { w.clean(); }
});
test('cross-brand attribution, non-live campaigns and incorrect currencies are rejected', () => {
  const w = setup(); try {
    assert.throws(() => w.economics.recordOutcome(w.brand.id, { ...w.outcome, adId: 'foreign-ad' }), /does not belong/);
    assert.throws(() => w.economics.recordOutcome(w.brand.id, { ...w.outcome, currency: 'EUR' }), /brand currency/);
    assert.throws(() => w.economics.recordOutcome(w.brand.id, { ...w.outcome, runId: 'not-this-brand' }), /belonging/);
    w.run.mode = 'SIMULATE'; w.store.put('runs', w.run);
    assert.throws(() => w.economics.recordOutcome(w.brand.id, w.outcome), /live mode/);
  } finally { w.clean(); }
});
test('latest ad-day observations replace earlier metrics and simulated results are excluded', () => {
  const w = setup(); try {
    w.economics.recordOutcome(w.brand.id, w.outcome);
    w.store.put('metrics', { ...w.metric, id: randomUUID(), observedAt: '2000-01-01T00:00:00Z', spendMinor: 100 });
    w.store.put('metrics', { ...w.metric, id: randomUUID(), adId: 'sim', simulation: true, spendMinor: 999999 });
    const report = w.economics.report(w.brand.id, { from, to }); assert.equal(report.adSpendMinor, 1000); assert.equal(report.netRoi, 5);
  } finally { w.clean(); }
});
test('incomplete outcome coverage, immature attribution and estimated AI costs suppress final ROI', () => {
  const w = setup(); try {
    w.economics.recordOutcome(w.brand.id, w.outcome); request(w);
    const report = w.economics.report(w.brand.id, { from, to }); assert.equal(report.netRoi, null); assert.equal(report.unresolvedRequests, 1); assert.equal(report.aiUsd, 1); assert.ok(report.provisionalRoi !== null);
    w.economics.saveConfig(w.brand.id, { outcomesCompleteThrough: from });
    assert.ok(w.economics.report(w.brand.id, { from, to }).limitations.some(s => s.includes('outcome coverage')));
    assert.ok(w.economics.report(w.brand.id, { from, to: ago(0) }).limitations.some(s => s.includes('not matured')));
  } finally { w.clean(); }
});
test('dated FX and receipts combine costs correctly without mutating the original usage receipt', () => {
  const w = setup('AED'); try {
    w.economics.recordOutcome(w.brand.id, w.outcome); const usage = request(w);
    assert.equal(w.economics.report(w.brand.id, { from, to }).marketingCostMinor, null);
    assert.throws(() => w.economics.saveConfig(w.brand.id, { usdToCurrency: 3.67 }), /date and source/);
    w.economics.saveConfig(w.brand.id, { usdToCurrency: 3.67, fxDate: observed, fxSource: 'Owner receipt exchange rate' });
    w.economics.recordCost(w.brand.id, { kind: 'receipt', usageId: usage.id, amountMicros: 500000, date: observed, note: 'Invoice line 1' });
    w.economics.recordCost(w.brand.id, { kind: 'overhead', externalId: 'editing', amountMinor: 100, date: observed, note: 'Editing labour', runId: w.run.id });
    const report = w.economics.report(w.brand.id, { from, to }); assert.equal(report.aiUsd, 0.5); assert.equal(report.aiMinor, 184); assert.equal(report.marketingCostMinor, 1284); assert.equal(report.complete, true);
    assert.equal(new UsageLedger(w.store).get(usage.id)!.estimatedMicros, 1000000); assert.equal(new UsageLedger(w.store).get(usage.id)!.costMicros, null);
    assert.equal(exposure(w.store, 'brand_id=?', [w.brand.id]).micros, 500000);
  } finally { w.clean(); }
});
test('zero-decimal currency costs are not divided by one hundred', () => {
  const w = setup('JPY'); try {
    const usage = request(w, 2); w.economics.saveConfig(w.brand.id, { usdToCurrency: 150, fxDate: observed, fxSource: 'Recorded test rate' });
    w.economics.recordCost(w.brand.id, { kind: 'receipt', usageId: usage.id, amountMicros: 2000000, date: observed, note: 'Fixture invoice' });
    assert.equal(w.economics.report(w.brand.id, { from, to }).aiMinor, 300);
  } finally { w.clean(); }
});
test('campaign ROI includes pre-launch and failed production once and marks unallocated shared costs', () => {
  const w = setup(); try {
    const ledger = new UsageLedger(w.store), usage = request(w, 2); ledger.update(usage.id, { createdAt: ago(45) + 'T00:00:00Z', state: 'failed' });
    w.economics.recordCost(w.brand.id, { kind: 'receipt', usageId: usage.id, amountMicros: 2000000, date: observed, note: 'Failed render invoice' });
    const report = w.economics.report(w.brand.id, { from, to, runIds: [w.run.id] }); assert.equal(report.aiUsd, 2); assert.equal(report.aiMinor, 200);
    const shared = request(w, 3); ledger.update(shared.id, { runId: '' });
    assert.ok(w.economics.report(w.brand.id, { from, to, runIds: [w.run.id] }).limitations.some(s => s.includes('unallocated')));
    assert.equal(w.economics.report(w.brand.id, { from, to, runIds: [w.run.id] }).aiUsd, 2);
  } finally { w.clean(); }
});
test('forecasts require explicit unit economics and distinguish scenarios from confidence intervals', () => {
  const w = setup(); try {
    assert.equal(w.economics.forecast(w.brand.id, 10000, 1).scenarios[0]!.netRoi, null);
    w.economics.saveConfig(w.brand.id, { unitContributionMinor: 4000, forecastCpaMinor: 1000 });
    const f = w.economics.forecast(w.brand.id, 10000, 1); assert.equal(f.scenarios[1]!.outcomes, 10); assert.equal(f.scenarios[1]!.netContributionMinor, 29900); assert.match(f.assumptions, /not statistical/);
  } finally { w.clean(); }
});
test('experiments preserve fixed gates and repeatable evaluations; exploratory promotion never auto-approves facts', () => {
  const w = setup(); try {
    const treatment: CampaignRun = { ...w.run, id: randomUUID(), stages: [{ ...w.run.stages[0]!, adIds: ['ad2'] }] }; w.store.put('runs', treatment);
    w.store.put('metrics', { ...w.metric, id: randomUUID(), runId: treatment.id, adId: 'ad2' });
    for (let i = 0; i < 40; i++) for (const [run, contribution] of [[w.run, 100], [treatment, 2000]] as const) w.economics.recordOutcome(w.brand.id, { ...w.outcome, externalId: `${run.id}-${i}`, runId: run.id, adId: run.stages[0]!.adIds[0], contributionMinor: contribution });
    const experiment = w.economics.createExperiment(w.brand.id, { name: 'More useful hooks', hypothesis: 'A clearer hook improves contribution per marketing dollar.', control: [w.run.id], treatment: [treatment.id], from, to, design: 'observational' });
    const first = w.economics.evaluate(experiment.id), again = w.economics.evaluate(experiment.id);
    assert.deepEqual(first, again); assert.equal(first.verdict, 'promote'); assert.ok(first.probabilityOfImprovement! > 0.975);
    assert.throws(() => w.economics.promote(experiment.id, true), /preregistered/);
    const memory = w.economics.promote(experiment.id) as { id: string; kind: string; content: string }; assert.equal(memory.kind, 'playbook'); assert.match(memory.content, /observational/);
    assert.equal((w.economics.promote(experiment.id) as { id: string }).id, memory.id); assert.equal(new BrandMemory(w.store).current(w.brand.id).length, 1);
    assert.throws(() => w.economics.createExperiment(w.brand.id, { name: 'Duplicate', hypothesis: 'No', control: [w.run.id], treatment: [w.run.id], from, to }), /both/);
    for (let i = 0; i < 40; i++) w.economics.recordOutcome(w.brand.id, { ...w.outcome, externalId: `${treatment.id}-${i}`, version: 2, runId: treatment.id, adId: 'ad2', revenueMinor: 0, contributionMinor: 0, qualified: false });
    const revised = w.economics.evaluate(experiment.id); assert.equal(revised.verdict, 'insufficient');
    assert.equal(new BrandMemory(w.store).current(w.brand.id)[0]!.state, 'retired');
    assert.equal(w.store.get<{ state: string }>('brandMemory', memory.id)!.state, 'active');
    assert.equal(new BrandMemory(w.store).snapshot(w.brand).sources.some(s => s.id === memory.id), false);
  } finally { w.clean(); }
});
test('experiments require dated non-USD conversion before freezing costs', () => {
  const w = setup('AED'); try { assert.throws(() => w.economics.createExperiment(w.brand.id, {}), /dated USD exchange rate/); } finally { w.clean(); }
});
test('large contribution diversity withholds local promotion without running an unbounded bootstrap', () => {
  const w = setup(); try {
    const treatment = { ...w.run, id: randomUUID(), stages: [{ ...w.run.stages[0]!, adIds: ['ad2'] }] }; w.store.put('runs', treatment);
    w.store.put('metrics', { ...w.metric, id: randomUUID(), runId: treatment.id, adId: 'ad2' });
    for (let i = 0; i < 513; i++) for (const run of [w.run, treatment]) w.economics.recordOutcome(w.brand.id, { ...w.outcome, externalId: `${run.id}-${i}`, runId: run.id, adId: run.stages[0]!.adIds[0], contributionMinor: i });
    const experiment = w.economics.createExperiment(w.brand.id, { name: 'Many values', hypothesis: 'A bounded comparison.', control: [w.run.id], treatment: [treatment.id], from, to });
    const result = w.economics.evaluate(experiment.id); assert.equal(result.verdict, 'insufficient'); assert.equal(result.probabilityOfImprovement, null); assert.ok(result.reasons.some(s => s.includes('512 distinct')));
  } finally { w.clean(); }
});
