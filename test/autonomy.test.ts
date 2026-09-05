import test from 'node:test';
import assert from 'node:assert/strict';

import { addDays, completenessFactor, type CompletenessCurve } from '../src/meta/insights.ts';
import {
  DEFAULT_PRIOR_CONVERSIONS,
  DecisionInputError,
  compareCpa,
  conversionsRequiredPerArm,
  cpaSummary,
  cpaUpperBoundMinor,
  createSeededRng,
  detectableEffect,
  expectedExcessCpa,
  fitPosterior,
  gammaP,
  gammaQuantile,
  incompleteBeta,
  logGamma,
  powerCheck,
  priorForBrand,
  priorForTargetCpa,
  probCpaAbove,
  probCpaRatioBelow,
  sampleGamma,
  thompsonPick,
  thompsonWinProbabilities,
  type DailyStat,
  type GammaPosterior,
} from '../src/autonomy/posterior.ts';
import {
  BUDGET_STEP_LIMIT,
  DEFAULT_THRESHOLDS,
  decideSlate,
  evaluateGates,
  gatesFor,
  portfolioBudgetDelta,
  proposeBudget,
  spendCeilings,
  testCapacity,
  type AdEvidence,
  type BudgetContext,
  type Verdict,
} from '../src/autonomy/decide.ts';
import type { Brand } from '../src/domain/brand.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AS_OF = '2026-09-05';
/** $40.00 in cents. Every money value in these tests is minor units. */
const TARGET_CPA = 4000;

/** F(a) = 1 everywhere: the naive, uncorrected read that this module exists to prevent. */
const FLAT_CURVE: CompletenessCurve = [
  { ageDays: 0, factor: 1 },
  { ageDays: 28, factor: 1 },
];

/**
 * Synthesise the rows an ad with a KNOWN true CPA would have reported by `AS_OF`.
 *
 * The generator applies the completeness curve to the true conversion count, which is
 * exactly what Meta does to us: the true number happened, only part of it has been
 * reported yet, and the shortfall is monotone in recency.
 */
function rowsFor(days: number, perDayMinor: number, trueCpaMinor: number): DailyStat[] {
  const rows: DailyStat[] = [];
  for (let age = 1; age <= days; age++) {
    const trueConversions = perDayMinor / trueCpaMinor;
    rows.push({
      statDate: addDays(AS_OF, -age),
      spendMinor: perDayMinor,
      conversions: Math.round(trueConversions * completenessFactor(Math.min(age, 28))),
    });
  }
  return rows;
}

function adFor(
  adId: string,
  days: number,
  perDayMinor: number,
  trueCpaMinor: number,
  overrides: Partial<AdEvidence> = {},
): AdEvidence {
  return {
    adId,
    adSetId: 'as_1',
    rows: rowsFor(days, perDayMinor, trueCpaMinor),
    ageDays: days,
    impressions: 500_000,
    impressionsLast24h: 20_000,
    effectiveStatus: 'ACTIVE',
    learningStatus: 'SUCCESS',
    daysSinceSignificantEdit: days,
    attributionSettings: ['1d_click'],
    ...overrides,
  };
}

/** A `1d_click` account, so the minimum-age gate is 1 day and does not mask the bias. */
const GATES = gatesFor(TARGET_CPA, 1);

function verdictOf(
  ads: readonly AdEvidence[],
  adId: string,
  curve?: CompletenessCurve,
): { verdict: Verdict; meanCpa: number | undefined; reason: string; pWorse: number | undefined } {
  const slate = decideSlate({
    asOfDate: AS_OF,
    targetCpaMinor: TARGET_CPA,
    gates: GATES,
    ads,
    rng: createSeededRng(1234),
    thompsonDraws: 500,
    ...(curve !== undefined ? { curve } : {}),
  });
  const d = slate.decisions.find((x) => x.adId === adId);
  assert.ok(d, `no decision for ${adId}`);
  return {
    verdict: d.verdict,
    meanCpa: d.cpa.meanMinor,
    reason: d.reason,
    pWorse: d.comparison?.pWorseByThreshold,
  };
}

// ---------------------------------------------------------------------------
// Special functions — everything downstream reads a threshold off one of these
// ---------------------------------------------------------------------------

test('logGamma matches known values including the reflection branch', () => {
  assert.ok(Math.abs(logGamma(1)) < 1e-12);
  assert.ok(Math.abs(logGamma(2)) < 1e-12);
  assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-10);
  // Γ(1/2) = √π, and 0.5 does not take the reflection branch; 0.2 does.
  assert.ok(Math.abs(logGamma(0.5) - 0.5 * Math.log(Math.PI)) < 1e-10);
  assert.ok(Math.abs(logGamma(0.2) - 1.5240638224307841) < 1e-9);
});

test('gammaP is the Gamma CDF on both the series and continued-fraction branches', () => {
  // shape 1 is Exponential(1): P(1, x) = 1 − e^−x. x=0.5 uses the series, x=9 the fraction.
  for (const x of [0.1, 0.5, 1, 2, 5, 9, 40]) {
    assert.ok(Math.abs(gammaP(1, x) - (1 - Math.exp(-x))) < 1e-12, `x=${x}`);
  }
  assert.equal(gammaP(3, 0), 0);
  assert.ok(gammaP(3, 1e6) > 1 - 1e-12);
  // Monotone across the branch switch at x = a + 1.
  let prev = 0;
  for (let x = 0.5; x < 20; x += 0.25) {
    const v = gammaP(4, x);
    assert.ok(v >= prev, `not monotone at x=${x}`);
    prev = v;
  }
});

test('incompleteBeta is the Beta CDF, symmetric where it must be', () => {
  for (const x of [0.05, 0.3, 0.5, 0.77, 0.99]) {
    assert.ok(Math.abs(incompleteBeta(1, 1, x) - x) < 1e-12, `uniform at ${x}`);
  }
  assert.ok(Math.abs(incompleteBeta(5, 5, 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(incompleteBeta(200, 200, 0.5) - 0.5) < 1e-9);
  // I_x(a,b) = 1 − I_{1−x}(b,a)
  assert.ok(Math.abs(incompleteBeta(3, 7, 0.4) - (1 - incompleteBeta(7, 3, 0.6))) < 1e-12);
  assert.equal(incompleteBeta(2, 3, 0), 0);
  assert.equal(incompleteBeta(2, 3, 1), 1);
});

test('gammaQuantile inverts gammaP', () => {
  for (const shape of [0.5, 1, 3, 40, 1500]) {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
      const q = gammaQuantile(shape, 1, p);
      assert.ok(Math.abs(gammaP(shape, q) - p) < 1e-9, `shape=${shape} p=${p}`);
    }
  }
  // The rate is a pure scale factor.
  assert.ok(Math.abs(gammaQuantile(5, 2, 0.3) - gammaQuantile(5, 1, 0.3) / 2) < 1e-12);
});

test('probCpaRatioBelow closed form agrees with Monte Carlo', () => {
  // The whole reason the verdicts are reproducible is that this identity holds. If it ever
  // stops holding, every kill threshold in the system is silently mis-calibrated.
  const a: GammaPosterior = { shape: 35, rate: 1695 };
  const b: GammaPosterior = { shape: 159, rate: 6230 };
  const rng = createSeededRng(99);
  const draws = 200_000;
  for (const ratio of [0.8, 1, 1.2, 1.5]) {
    let hits = 0;
    for (let i = 0; i < draws; i++) {
      const cpaA = 1 / sampleGamma(a.shape, a.rate, rng);
      const cpaB = 1 / sampleGamma(b.shape, b.rate, rng);
      if (cpaA < ratio * cpaB) hits += 1;
    }
    const mc = hits / draws;
    const exact = probCpaRatioBelow(a, b, ratio);
    assert.ok(Math.abs(mc - exact) < 0.005, `ratio=${ratio}: MC ${mc} vs exact ${exact}`);
  }
});

test('probCpaAbove holds a posterior against a fixed number, not against another ad', () => {
  // Everything else in this module is relative. This is the one statistic that knows the
  // difference between "better than the other ad" and "worth more money".
  // shape 1 is Exponential in θ, so P(CPA > c) = P(θ < 1/c) = 1 − exp(−r/c) exactly.
  const zeroConversions: GammaPosterior = { shape: 1, rate: 12_000 };
  for (const c of [2000, 4000, 8000]) {
    assert.ok(Math.abs(probCpaAbove(zeroConversions, c) - (1 - Math.exp(-12_000 / c))) < 1e-12, `c=${c}`);
  }
  const settled: GammaPosterior = { shape: 500, rate: 500 * TARGET_CPA };
  assert.ok(probCpaAbove(settled, 1.2 * TARGET_CPA) < 0.01);
  assert.ok(probCpaAbove(settled, 0.8 * TARGET_CPA) > 0.99);
});

test('identical posteriors are a coin flip against themselves', () => {
  const p: GammaPosterior = { shape: 40, rate: 1600 };
  assert.ok(Math.abs(probCpaRatioBelow(p, p, 1) - 0.5) < 1e-9);
});

test('expectedExcessCpa is undefined when the posterior mean CPA diverges', () => {
  const noConversions = priorForTargetCpa(TARGET_CPA); // shape exactly 1
  const settled: GammaPosterior = { shape: 100, rate: 400_000 };
  assert.equal(expectedExcessCpa(noConversions, settled), undefined);
  const loss = expectedExcessCpa({ shape: 20, rate: 100_000 }, settled);
  assert.ok(loss !== undefined && loss > 0);
});

test('expectedExcessCpa agrees with Monte Carlo', () => {
  const worse: GammaPosterior = { shape: 30, rate: 150_000 }; // ~5000 CPA
  const better: GammaPosterior = { shape: 200, rate: 800_000 }; // ~4000 CPA
  const rng = createSeededRng(5);
  const draws = 200_000;
  let acc = 0;
  for (let i = 0; i < draws; i++) {
    const d = 1 / sampleGamma(worse.shape, worse.rate, rng) - 1 / sampleGamma(better.shape, better.rate, rng);
    if (d > 0) acc += d;
  }
  const mc = acc / draws;
  const exact = expectedExcessCpa(worse, better);
  assert.ok(exact !== undefined);
  assert.ok(Math.abs(mc - exact) / exact < 0.02, `MC ${mc} vs quadrature ${exact}`);
});

// ---------------------------------------------------------------------------
// The prior
// ---------------------------------------------------------------------------

test('the prior is worth exactly one conversion at the target CPA', () => {
  const p = priorForTargetCpa(TARGET_CPA);
  assert.equal(p.shape, DEFAULT_PRIOR_CONVERSIONS);
  assert.equal(p.rate, TARGET_CPA);
  // A five-conversion prior has the same mean and five times the exposure.
  const strong = priorForTargetCpa(TARGET_CPA, 5);
  assert.equal(strong.rate / strong.shape, p.rate / p.shape);
});

test('priorForBrand refuses to invent a target CPA', () => {
  const base = {
    id: 'acme',
    name: 'Acme',
    pageId: '1',
    adAccountId: 'act_1',
    archetype: 'website_purchase',
    destination: {},
    claims: { substantiated: [], neverSay: [], neverShow: [], likenessRightsConfirmed: false },
    specialAdCategories: [],
    countries: ['GB'],
    proposition: 'things',
  } as unknown as Brand;
  const withTarget: Brand = {
    ...base,
    spend: { dailyBudgetMinor: 10_000, maxDailyBudgetMinor: 50_000, targetCpaMinor: TARGET_CPA },
  };
  assert.equal(priorForBrand(withTarget).rate, TARGET_CPA);

  const withoutTarget: Brand = {
    ...base,
    spend: { dailyBudgetMinor: 10_000, maxDailyBudgetMinor: 50_000 },
  };
  assert.throws(() => priorForBrand(withoutTarget), (e: unknown) => {
    assert.ok(e instanceof DecisionInputError);
    assert.match(e.message, /targetCpaMinor/);
    assert.match(e.message, /acme/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// The completeness correction
// ---------------------------------------------------------------------------

test('fitPosterior deflates the exposure and never inflates the numerator', () => {
  const prior = priorForTargetCpa(TARGET_CPA);
  const rows: DailyStat[] = [{ statDate: addDays(AS_OF, -2), spendMinor: 50_000, conversions: 14 }];
  const fit = fitPosterior(prior, rows, { asOfDate: AS_OF });
  const f = completenessFactor(2);
  // The count is untouched: predicting a final count would fabricate certainty.
  assert.equal(fit.posterior.shape, prior.shape + 14);
  assert.equal(fit.conversions, 14);
  // The exposure is deflated: $500 spent at age 2 is worth $500 × F(2) of evidence.
  assert.ok(Math.abs(fit.posterior.rate - (prior.rate + 50_000 * f)) < 1e-9);
  assert.ok(fit.effectiveSpendMinor < fit.spendMinor);
  assert.ok(Math.abs(fit.meanCompleteness - f) < 1e-12);
});

test('the recency discount is applied AFTER the completeness correction', () => {
  // Discounting raw spend up-weights recent data, which is exactly the data that is
  // under-reported, and leaves the system permanently pessimistic about the present.
  const prior = priorForTargetCpa(TARGET_CPA);
  const age = 3;
  const rows: DailyStat[] = [{ statDate: addDays(AS_OF, -age), spendMinor: 100_000, conversions: 20 }];
  const gamma = 0.9;
  const fit = fitPosterior(prior, rows, { asOfDate: AS_OF, discount: gamma });
  const w = Math.pow(gamma, age);
  assert.ok(Math.abs(fit.posterior.rate - (prior.rate + w * completenessFactor(age) * 100_000)) < 1e-9);
  assert.ok(Math.abs(fit.posterior.shape - (prior.shape + w * 20)) < 1e-9);
  // Both halves carry the same weight, so the CPA the row implies is untouched — only
  // its influence shrinks.
  const implied = (fit.posterior.rate - prior.rate) / (fit.posterior.shape - prior.shape);
  const undiscounted = fitPosterior(prior, rows, { asOfDate: AS_OF });
  const impliedUndiscounted =
    (undiscounted.posterior.rate - prior.rate) / (undiscounted.posterior.shape - prior.shape);
  assert.ok(Math.abs(implied - impliedUndiscounted) < 1e-9);
});

test('a stat date in the future is rejected as the timezone bug it is', () => {
  const prior = priorForTargetCpa(TARGET_CPA);
  assert.throws(
    () =>
      fitPosterior(prior, [{ statDate: addDays(AS_OF, 1), spendMinor: 1000, conversions: 1 }], {
        asOfDate: AS_OF,
      }),
    (e: unknown) => {
      assert.ok(e instanceof DecisionInputError);
      assert.match(e.message, /timezone/i);
      return true;
    },
  );
});

test('the sliding window drops old rows and reports how many', () => {
  const prior = priorForTargetCpa(TARGET_CPA);
  const rows = rowsFor(30, 100_000, TARGET_CPA);
  const fit = fitPosterior(prior, rows, { asOfDate: AS_OF, windowDays: 7 });
  assert.equal(fit.rowsUsed, 6); // ages 1..6 are < 7
  assert.equal(fit.rowsDropped, 24);
});

test('an ad with no rows keeps the prior exactly', () => {
  const prior = priorForTargetCpa(TARGET_CPA);
  const fit = fitPosterior(prior, [], { asOfDate: AS_OF });
  assert.deepEqual(fit.posterior, prior);
  assert.equal(fit.meanCompleteness, 1);
  assert.equal(fit.newestRowAgeDays, undefined);
  // shape = 1 means E[CPA] diverges, and the summary says so instead of inventing a number.
  assert.equal(cpaSummary(fit.posterior).meanMinor, undefined);
});

test('THE COMPLETENESS TEST: age must not change the verdict, and without the correction it does', () => {
  // Two challengers with IDENTICAL true CPA, IDENTICAL total spend and IDENTICAL true
  // conversion counts. The only difference is age: one ran $8,000/day for 3 days, the
  // other $2,000/day for 12 days. Both are judged against the same settled incumbent.
  //
  // This is the failure that reads to a user as "the AI rejects its own work": the bias is
  // monotone in recency, so it fires against exactly the creative the generator just made,
  // and it is invisible in Ads Manager because Ads Manager shows the same under-reported
  // numbers. It is a join bug wearing a model's clothes.
  const incumbent = adFor('incumbent', 30, 200_000, 3800);
  const young = adFor('young', 3, 800_000, TARGET_CPA);
  const older = adFor('older', 12, 200_000, TARGET_CPA);

  const youngTotal = young.rows.reduce((s, r) => s + r.spendMinor, 0);
  const olderTotal = older.rows.reduce((s, r) => s + r.spendMinor, 0);
  assert.equal(youngTotal, olderTotal, 'the two challengers must differ only in age');

  // --- with the correction: the same verdict, and posteriors that agree ----------------
  const youngCorrected = verdictOf([incumbent, young], 'young');
  const olderCorrected = verdictOf([incumbent, older], 'older');
  assert.equal(
    youngCorrected.verdict,
    olderCorrected.verdict,
    `age changed the verdict: young=${youngCorrected.verdict} older=${olderCorrected.verdict}`,
  );
  assert.equal(youngCorrected.verdict, 'EQUIVALENT');
  assert.ok(youngCorrected.meanCpa !== undefined && olderCorrected.meanCpa !== undefined);
  const correctedGap = Math.abs(youngCorrected.meanCpa - olderCorrected.meanCpa) / olderCorrected.meanCpa;
  assert.ok(correctedGap < 0.02, `corrected posteriors differ by ${(100 * correctedGap).toFixed(1)}%`);

  // --- without it: the young ad is killed purely for being young -----------------------
  const youngNaive = verdictOf([incumbent, young], 'young', FLAT_CURVE);
  const olderNaive = verdictOf([incumbent, older], 'older', FLAT_CURVE);
  assert.equal(youngNaive.verdict, 'KILL', youngNaive.reason);
  assert.notEqual(olderNaive.verdict, 'KILL');
  assert.ok(youngNaive.pWorse !== undefined && youngNaive.pWorse > DEFAULT_THRESHOLDS.killAt);
  assert.ok(youngNaive.meanCpa !== undefined && olderNaive.meanCpa !== undefined);
  const naiveGap = (youngNaive.meanCpa - olderNaive.meanCpa) / olderNaive.meanCpa;
  assert.ok(naiveGap > 0.2, `naive read only inflated the young ad by ${(100 * naiveGap).toFixed(1)}%`);
});

test('the correction does not make a genuinely bad young ad unkillable', () => {
  // The correction must not become an excuse. Same age-3 ad, but a true CPA of 2× target.
  const incumbent = adFor('incumbent', 30, 200_000, 3800);
  const bad = adFor('bad', 3, 800_000, 2 * TARGET_CPA);
  const v = verdictOf([incumbent, bad], 'bad');
  assert.equal(v.verdict, 'KILL', v.reason);
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('gatesFor derives the age gate from the attribution window, not a constant', () => {
  assert.equal(gatesFor(TARGET_CPA, 7).minAgeDays, 7);
  assert.equal(gatesFor(TARGET_CPA, 1).minAgeDays, 1);
  assert.equal(gatesFor(TARGET_CPA, 7).minSpendMinor, 1.5 * TARGET_CPA);
  assert.throws(() => gatesFor(TARGET_CPA, 0), DecisionInputError);
});

test('every gate refuses for its own stated reason', () => {
  const prior = priorForTargetCpa(TARGET_CPA);
  const healthy = adFor('a', 12, 200_000, TARGET_CPA);
  const fitOf = (ad: AdEvidence) => fitPosterior(prior, ad.rows, { asOfDate: AS_OF });
  assert.ok(evaluateGates(healthy, fitOf(healthy), GATES).passed);

  const cases: ReadonlyArray<readonly [string, Partial<AdEvidence>]> = [
    ['MIN_AGE', { ageDays: 0 }],
    ['MIN_IMPRESSIONS', { impressions: 10 }],
    ['LEARNING', { learningStatus: 'LEARNING' }],
    ['LEARNING_UNKNOWN', { learningStatus: 'UNKNOWN' }],
    ['RECENT_SIGNIFICANT_EDIT', { daysSinceSignificantEdit: 1 }],
    ['MIXED_ATTRIBUTION', { attributionSettings: ['1d_click', '7d_click'] }],
    ['MIXED_ATTRIBUTION', { attributionSettings: ['UNKNOWN'] }],
    ['NOT_ACTIVE', { effectiveStatus: 'DISAPPROVED' }],
    ['NO_DELIVERY', { impressionsLast24h: 0 }],
  ];
  for (const [code, patch] of cases) {
    const ad = { ...healthy, ...patch };
    const report = evaluateGates(ad, fitOf(ad), GATES);
    assert.ok(!report.passed, `${code} should have failed`);
    assert.ok(
      report.failures.some((f) => f.code === code),
      `${code} missing from ${report.failures.map((f) => f.code).join(',')}`,
    );
  }

  // Zero spend trips both the spend and the conversion gates.
  const empty = { ...healthy, rows: [] };
  const emptyReport = evaluateGates(empty, fitOf(empty), GATES);
  assert.ok(emptyReport.failures.some((f) => f.code === 'MIN_SPEND'));
  assert.ok(emptyReport.failures.some((f) => f.code === 'MIN_CONVERSIONS'));
});

test('a gated ad HOLDs and the reason names the gate', () => {
  const incumbent = adFor('incumbent', 30, 200_000, 3800);
  const learning = adFor('learning', 12, 200_000, 9000, { learningStatus: 'LEARNING' });
  const v = verdictOf([incumbent, learning], 'learning');
  assert.equal(v.verdict, 'HOLD');
  assert.match(v.reason, /LEARNING/);
  // Note what did NOT happen: this ad's true CPA is 2.25× target and it was not killed.
});

test('an ad set still in LEARNING is never judged, even when it looks terrible', () => {
  const incumbent = adFor('incumbent', 30, 200_000, 3800);
  const awful = adFor('awful', 12, 200_000, 20_000, { learningStatus: 'LEARNING' });
  assert.equal(verdictOf([incumbent, awful], 'awful').verdict, 'HOLD');
  // The same ad out of learning is killed, so it is the gate doing the work.
  const settled = { ...awful, learningStatus: 'SUCCESS' as const };
  assert.equal(verdictOf([incumbent, settled], 'awful').verdict, 'KILL');
});

test('with no gate-passing incumbent everything HOLDs, and says why', () => {
  const a = adFor('a', 12, 200_000, TARGET_CPA, { learningStatus: 'LEARNING' });
  const b = adFor('b', 12, 200_000, 9000, { learningStatus: 'LEARNING' });
  const slate = decideSlate({
    asOfDate: AS_OF,
    targetCpaMinor: TARGET_CPA,
    gates: GATES,
    ads: [a, b],
    rng: createSeededRng(3),
    thompsonDraws: 200,
  });
  assert.equal(slate.incumbentAdId, undefined);
  for (const d of slate.decisions) assert.equal(d.verdict, 'HOLD');
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

test('the incumbent is the ad we are most CONFIDENT about, not the best point estimate', () => {
  // `lucky` has a superb observed CPA off three conversions; `settled` has a slightly worse
  // one off hundreds. Ranking on the raw CPA — or even on the shrunk posterior MEAN, which
  // a one-conversion prior barely moves — crowns the lucky one, and then every other ad in
  // the account is judged against three conversions' worth of noise.
  const settled = adFor('settled', 30, 200_000, 4000);
  const lucky: AdEvidence = {
    ...adFor('lucky', 12, 4000, 4000),
    rows: [
      { statDate: addDays(AS_OF, -5), spendMinor: 3000, conversions: 2 },
      { statDate: addDays(AS_OF, -4), spendMinor: 3000, conversions: 1 },
    ],
  };
  const rawLuckyCpa = 6000 / 3;
  assert.ok(rawLuckyCpa < 4000, 'fixture must have a better raw CPA');
  // The posterior MEAN also favours the lucky ad, so this test really does discriminate
  // between ranking on the mean and ranking on the upper bound.
  const prior = priorForTargetCpa(TARGET_CPA);
  const luckyFit = fitPosterior(prior, lucky.rows, { asOfDate: AS_OF });
  const settledFit = fitPosterior(prior, settled.rows, { asOfDate: AS_OF });
  const luckyMean = cpaSummary(luckyFit.posterior).meanMinor;
  const settledMean = cpaSummary(settledFit.posterior).meanMinor;
  assert.ok(luckyMean !== undefined && settledMean !== undefined && luckyMean < settledMean);
  assert.ok(cpaUpperBoundMinor(luckyFit.posterior) > cpaUpperBoundMinor(settledFit.posterior));

  const slate = decideSlate({
    asOfDate: AS_OF,
    targetCpaMinor: TARGET_CPA,
    gates: GATES,
    ads: [settled, lucky],
    rng: createSeededRng(11),
    thompsonDraws: 200,
  });
  assert.equal(slate.incumbentAdId, 'settled');
});

test('EQUIVALENT requires power: two thin arms are unmeasured, not equivalent', () => {
  // Both ads sit at the target CPA with very little data. The prior pulls both posteriors
  // to the same place, the ROPE fills up, and a naive rule declares them equivalent —
  // permanently retiring a comparison it never actually made.
  const thin = (id: string): AdEvidence => ({
    ...adFor(id, 12, 200_000, TARGET_CPA),
    rows: [
      { statDate: addDays(AS_OF, -9), spendMinor: 8000, conversions: 2 },
      { statDate: addDays(AS_OF, -8), spendMinor: 8000, conversions: 2 },
    ],
  });
  const slate = decideSlate({
    asOfDate: AS_OF,
    targetCpaMinor: TARGET_CPA,
    gates: GATES,
    ads: [thin('a'), thin('b')],
    rng: createSeededRng(17),
    thompsonDraws: 200,
  });
  const challenger = slate.decisions.find((d) => !d.isIncumbent);
  assert.ok(challenger);
  assert.ok(challenger.power !== undefined && !challenger.power.powered);
  assert.notEqual(challenger.verdict, 'EQUIVALENT');
  assert.equal(challenger.verdict, 'HOLD');
  assert.match(challenger.reason, /Cannot tell yet|not confidently/);
});

test('HOLD is the modal verdict for a mildly worse ad, not a kill', () => {
  // The dossier's worked example: probably worse, nowhere near confidently worse by enough.
  const incumbent = adFor('incumbent', 30, 200_000, 4000);
  const slightlyWorse = adFor('challenger', 9, 21_000, 4600);
  const v = verdictOf([incumbent, slightlyWorse], 'challenger');
  assert.equal(v.verdict, 'HOLD', v.reason);
  assert.ok(v.pWorse !== undefined && v.pWorse < DEFAULT_THRESHOLDS.killAt);
});

test('a clearly better challenger scales', () => {
  const incumbent = adFor('incumbent', 30, 200_000, 5000);
  const winner = adFor('winner', 20, 200_000, 3000);
  const v = verdictOf([incumbent, winner], 'winner');
  assert.equal(v.verdict, 'SCALE', v.reason);
});

test('the leader of a losing slate is not scaled: "better than" is not "worth more money"', () => {
  // Both ads are far worse than the brand's own target CPA. Every statistic in the
  // comparison is RELATIVE, so the least-bad of them has P(better) = 1.00 against the
  // other — and turning that into a budget increase is the most expensive way to be right.
  const leastBad = adFor('leastBad', 30, 200_000, 3 * TARGET_CPA);
  const worse = adFor('worse', 30, 200_000, 5 * TARGET_CPA);
  const v = verdictOf([leastBad, worse], 'leastBad');
  assert.equal(v.verdict, 'HOLD', v.reason);
  // The comparison still says it is the better of the two; the guard is what stops that
  // from becoming money.
  assert.match(v.reason, /P\(better than worse\) = 100\.0%/);
  assert.match(v.reason, /losing money/);
  assert.equal(verdictOf([leastBad, worse], 'worse').verdict, 'KILL');

  // The same shape of slate, at a CPA the brand actually asked for, does scale.
  const good = adFor('good', 30, 200_000, 3400);
  const meh = adFor('meh', 30, 200_000, 6000);
  assert.equal(verdictOf([good, meh], 'good').verdict, 'SCALE');
});

test('an ad that spends and never converts is killed once silence becomes evidence', () => {
  // A broken pixel, a dead landing page or a checkout that 500s looks exactly like this,
  // and it is the clearest loser an account can produce. A minimum-conversions gate with
  // no escape makes it the one ad that can never be killed — the gate meant to prevent a
  // hasty verdict instead guarantees an unbounded one-way spend.
  const good = adFor('good', 30, 200_000, TARGET_CPA);
  const silent = (days: number, perDayMinor: number): AdEvidence => ({
    ...adFor('silent', days, perDayMinor, TARGET_CPA),
    rows: Array.from({ length: days }, (_, i) => ({
      statDate: addDays(AS_OF, -(i + 1)),
      spendMinor: perDayMinor,
      conversions: 0,
    })),
  });

  const dead = verdictOf([good, silent(14, 200_000)], 'silent');
  assert.equal(dead.verdict, 'KILL', dead.reason);
  assert.match(dead.reason, /0 conversions/);

  // Not before the silence is worth something, though. At ~2 target-CPAs of corrected
  // exposure an ad that is exactly at target still draws nothing 13% of the time, so the
  // gate holds and the verdict names it.
  const early = verdictOf([good, silent(4, 3000)], 'silent');
  assert.equal(early.verdict, 'HOLD');
  assert.match(early.reason, /MIN_CONVERSIONS/);
  assert.match(early.reason, /silence becomes evidence/);
});

test("Meta's fatigue signal escalates to ITERATE but never resurrects a KILL", () => {
  const incumbent = adFor('incumbent', 30, 200_000, 3800);

  const tired = adFor('tired', 20, 200_000, 4000, { fatigue: 'CREATIVE_FATIGUE' });
  const tiredVerdict = verdictOf([incumbent, tired], 'tired');
  assert.equal(tiredVerdict.verdict, 'ITERATE');
  assert.match(tiredVerdict.reason, /CREATIVE_FATIGUE/);

  const badAndTired = adFor('bad', 20, 200_000, 9000, { fatigue: 'CREATIVE_FATIGUE' });
  assert.equal(verdictOf([incumbent, badAndTired], 'bad').verdict, 'KILL');

  // CREATIVE_LIMITED is the weaker of Meta's two published states and does not override SCALE.
  const limitedWinner = adFor('winner', 20, 200_000, 3000, { fatigue: 'CREATIVE_LIMITED' });
  assert.equal(verdictOf([incumbent, limitedWinner], 'winner').verdict, 'SCALE');
  const fatiguedWinner = adFor('winner2', 20, 200_000, 3000, { fatigue: 'CREATIVE_FATIGUE' });
  assert.equal(verdictOf([incumbent, fatiguedWinner], 'winner2').verdict, 'ITERATE');
});

test('fatigue is deferred rather than acted on while the ad set is in LEARNING', () => {
  const incumbent = adFor('incumbent', 30, 200_000, 3800);
  const tired = adFor('tired', 20, 200_000, 4000, {
    fatigue: 'CREATIVE_FATIGUE',
    learningStatus: 'LEARNING',
  });
  const v = verdictOf([incumbent, tired], 'tired');
  assert.equal(v.verdict, 'HOLD');
  assert.match(v.reason, /LEARNING/);
  assert.match(v.reason, /deferred/);
});

test('decideSlate is deterministic: same inputs, same verdicts and same propensities', () => {
  const ads = [
    adFor('incumbent', 30, 200_000, 3800),
    adFor('young', 3, 800_000, TARGET_CPA),
    adFor('bad', 20, 200_000, 9000),
  ];
  const run = () =>
    decideSlate({
      asOfDate: AS_OF,
      targetCpaMinor: TARGET_CPA,
      gates: GATES,
      ads,
      rng: createSeededRng(2026),
      thompsonDraws: 1000,
    });
  const a = run();
  const b = run();
  assert.deepEqual(
    a.decisions.map((d) => [d.adId, d.verdict, d.winProbability]),
    b.decisions.map((d) => [d.adId, d.verdict, d.winProbability]),
  );
});

test('a duplicated ad id is refused rather than silently coalesced', () => {
  const ad = adFor('dup', 12, 200_000, TARGET_CPA);
  assert.throws(
    () =>
      decideSlate({
        asOfDate: AS_OF,
        targetCpaMinor: TARGET_CPA,
        gates: GATES,
        ads: [ad, ad],
        rng: createSeededRng(1),
        thompsonDraws: 10,
      }),
    DecisionInputError,
  );
});

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

test('the sample-size table that determines the whole product', () => {
  // ~470 conversions per arm for a 20% difference, two-sided at 80% power;
  // ~100 under the one-sided Bayesian rule at 90%. That ratio is the product strategy.
  const twoSided = conversionsRequiredPerArm(0.2, 'TWO_SIDED_80');
  const bayes = conversionsRequiredPerArm(0.2, 'BAYES_ONE_SIDED_90');
  assert.ok(Math.abs(twoSided - 470) < 10, `${twoSided}`);
  assert.ok(Math.abs(bayes - 100) < 5, `${bayes}`);
  // Halving the detectable effect roughly quadruples the spend.
  const half = conversionsRequiredPerArm(0.1, 'BAYES_ONE_SIDED_90');
  assert.ok(half / bayes > 3.5 && half / bayes < 4.5);
  // Meta's own 50-event learning threshold is nowhere near a two-sided test.
  assert.ok(detectableEffect(50, 50, 'TWO_SIDED_80') > 0.7);
});

test('powerCheck reports "cannot tell yet" instead of inventing a winner', () => {
  const weak = powerCheck(20, 1000, 0.2, 'BAYES_ONE_SIDED_90');
  assert.equal(weak.powered, false);
  assert.ok(weak.detectableEffect > 0.2);
  const strong = powerCheck(150, 1000, 0.2, 'BAYES_ONE_SIDED_90');
  assert.equal(strong.powered, true);
  assert.ok(strong.detectableEffect < 0.2);
  // A zero-conversion arm can resolve nothing at all, and says so.
  assert.equal(powerCheck(0, 1000).detectableEffect, Number.POSITIVE_INFINITY);
});

// ---------------------------------------------------------------------------
// Thompson sampling
// ---------------------------------------------------------------------------

test('Thompson win probabilities are a distribution and favour the better posterior', () => {
  // Eight conversions per arm: enough to rank them, not enough to be certain, which is
  // where every real slate lives.
  const arms = [
    { id: 'good', posterior: { shape: 8, rate: 24_000 } }, // CPA ~3000
    { id: 'mid', posterior: { shape: 8, rate: 32_000 } }, // CPA ~4000
    { id: 'bad', posterior: { shape: 8, rate: 48_000 } }, // CPA ~6000
  ];
  const wins = thompsonWinProbabilities(arms, createSeededRng(8), { draws: 8000, alphaReshape: 1 });
  const total = [...wins.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  const good = wins.get('good') ?? 0;
  const mid = wins.get('mid') ?? 0;
  const bad = wins.get('bad') ?? 0;
  assert.ok(good > mid && mid > bad, `${good} ${mid} ${bad}`);
  assert.ok(good > 0.5);
  // None of them is written off. A 25% CPA gap on eight conversions is not proof.
  assert.ok(bad > 0);
});

test('a wide posterior still gets explored — that is the point of randomising', () => {
  const arms = [
    { id: 'known', posterior: { shape: 400, rate: 1_500_000 } }, // CPA 3750, tight
    { id: 'new', posterior: { shape: 3, rate: 12_000 } }, // CPA ~4000, very wide
  ];
  const wins = thompsonWinProbabilities(arms, createSeededRng(21), { draws: 4000 });
  const fresh = wins.get('new') ?? 0;
  assert.ok(fresh > 0.05 && fresh < 0.95, `new arm win probability ${fresh}`);
});

test('posterior reshaping narrows the posterior, so smaller alpha explores less', () => {
  const arms = [
    { id: 'leader', posterior: { shape: 60, rate: 200_000 } },
    { id: 'challenger', posterior: { shape: 20, rate: 80_000 } },
  ];
  const wide = thompsonWinProbabilities(arms, createSeededRng(4), { draws: 8000, alphaReshape: 1 });
  const narrow = thompsonWinProbabilities(arms, createSeededRng(4), { draws: 8000, alphaReshape: 0.25 });
  const leaderWide = wide.get('leader') ?? 0;
  const leaderNarrow = narrow.get('leader') ?? 0;
  assert.ok(leaderNarrow > leaderWide, `alpha<1 should exploit more: ${leaderNarrow} vs ${leaderWide}`);
});

test('a single arm wins by definition, and an empty slate does not crash', () => {
  const one = thompsonWinProbabilities([{ id: 'x', posterior: { shape: 2, rate: 8000 } }], createSeededRng(1));
  assert.equal(one.get('x'), 1);
  assert.equal(thompsonWinProbabilities([], createSeededRng(1)).size, 0);
  assert.equal(thompsonPick([], createSeededRng(1)), undefined);
});

test('the same seed replays the same draw', () => {
  const arms = [
    { id: 'a', posterior: { shape: 10, rate: 40_000 } },
    { id: 'b', posterior: { shape: 10, rate: 45_000 } },
  ];
  assert.equal(thompsonPick(arms, createSeededRng(77)), thompsonPick(arms, createSeededRng(77)));
});

test('sampleGamma reproduces the posterior it was given', () => {
  const rng = createSeededRng(31);
  const shape = 40;
  const rate = 160_000;
  let sum = 0;
  const n = 40_000;
  for (let i = 0; i < n; i++) sum += sampleGamma(shape, rate, rng);
  assert.ok(Math.abs(sum / n - shape / rate) / (shape / rate) < 0.02);
  // The shape < 1 boost path must also work; that is a brand-new ad's posterior.
  assert.ok(sampleGamma(0.4, 1, createSeededRng(3)) > 0);
});

// ---------------------------------------------------------------------------
// Budget clamps
// ---------------------------------------------------------------------------

function budgetCtx(overrides: Partial<BudgetContext> = {}): BudgetContext {
  return {
    adSetId: 'as_1',
    currentMinor: 100_000,
    minDailyBudgetMinor: 500,
    maxDailyBudgetMinor: 1_000_000,
    budgetWritesToday: 0,
    budgetChangesLastHour: 0,
    learningStatus: 'SUCCESS',
    daysSinceSignificantEdit: 7,
    hourOfDayAccountTz: 8,
    ...overrides,
  };
}

test('budget steps are clamped to +/-20% in both directions', () => {
  const up = proposeBudget(budgetCtx(), 1_000_000);
  assert.equal(up.action, 'SET');
  assert.equal(up.valueMinor, 100_000 * (1 + BUDGET_STEP_LIMIT));
  assert.ok(up.clampsApplied.some((c) => c.includes('20%/step')));

  const down = proposeBudget(budgetCtx(), 1000);
  assert.equal(down.action, 'SET');
  assert.equal(down.valueMinor, 100_000 * (1 - BUDGET_STEP_LIMIT));
});

test('a budget write is never below the account currency minimum', () => {
  const d = proposeBudget(budgetCtx({ currentMinor: 600, minDailyBudgetMinor: 500 }), 100);
  assert.equal(d.action, 'SET');
  assert.equal(d.valueMinor, 500);
  assert.ok(d.clampsApplied.some((c) => c.includes('minimum')));
});

test('the brand ceiling outranks the step floor on the way down', () => {
  // The brand ceiling was lowered below the live budget. Money we cannot get back beats a
  // learning reset we merely pay for.
  const d = proposeBudget(budgetCtx({ currentMinor: 100_000, maxDailyBudgetMinor: 50_000 }), 100_000);
  assert.equal(d.action, 'SET');
  assert.equal(d.valueMinor, 50_000);
  assert.ok(d.clampsApplied.some((c) => c.includes('brand ceiling')));
});

test('the monotone daily high-water mark blocks a second increase', () => {
  // Meta's 175% daily ceiling anchors to the HIGHEST budget set that day, so an upward
  // write is irreversible for the calendar day and a second one compounds the exposure.
  const d = proposeBudget(
    budgetCtx({ currentMinor: 100_000, highWaterTodayMinor: 100_000, budgetWritesToday: 1 }),
    120_000,
  );
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /noise floor/);

  const bigger = proposeBudget(
    budgetCtx({ currentMinor: 80_000, highWaterTodayMinor: 90_000, budgetWritesToday: 1 }),
    96_000,
  );
  assert.equal(bigger.action, 'SET');
  assert.equal(bigger.valueMinor, 90_000);
  assert.ok(bigger.clampsApplied.some((c) => c.includes('high-water')));
});

test('worst case daily spend is 175% of the highest budget set today, not 100%', () => {
  const d = proposeBudget(budgetCtx({ highWaterTodayMinor: 110_000 }), 110_000);
  assert.equal(d.action, 'SET');
  assert.equal(d.worstCaseDailySpendMinor, 1.75 * 110_000);
  assert.deepEqual(spendCeilings(100_000), { dailyMinor: 175_000, weeklyMinor: 700_000 });
});

test('budget writes are refused for every hard reason', () => {
  const cases: ReadonlyArray<readonly [Partial<BudgetContext>, RegExp]> = [
    [{ learningStatus: 'LEARNING' }, /LEARNING/],
    [{ learningStatus: 'UNKNOWN' }, /learning_stage_info/],
    [{ daysSinceSignificantEdit: 1 }, /significant edit/],
    [{ hourOfDayAccountTz: 15 }, /early part of the day/],
    [{ budgetWritesToday: 2 }, /already today/],
    [{ budgetChangesLastHour: 4 }, /613/],
  ];
  for (const [patch, pattern] of cases) {
    const d = proposeBudget(budgetCtx(patch), 120_000);
    assert.equal(d.action, 'SKIP', JSON.stringify(patch));
    assert.match(d.reason, pattern);
  }
});

test('a change below the noise floor does not burn one of the day/s two writes', () => {
  const d = proposeBudget(budgetCtx(), 102_000);
  assert.equal(d.action, 'SKIP');
  assert.match(d.reason, /noise floor/);
});

test('an impossible budget envelope is a loud error, not a clamped guess', () => {
  assert.throws(
    () => proposeBudget(budgetCtx({ minDailyBudgetMinor: 10_000, maxDailyBudgetMinor: 5000 }), 6000),
    (e: unknown) => {
      assert.ok(e instanceof DecisionInputError);
      assert.match(e.message, /brand ceiling/);
      return true;
    },
  );
});

test('the portfolio scales on MARGINAL CPA, with a dead band around target', () => {
  assert.equal(portfolioBudgetDelta(3000, TARGET_CPA), 0.15); // headroom
  assert.equal(portfolioBudgetDelta(4000, TARGET_CPA), 0); // at target
  assert.equal(portfolioBudgetDelta(4500, TARGET_CPA), 0); // inside the band
  assert.equal(portfolioBudgetDelta(6000, TARGET_CPA), -0.15); // over target
});

// ---------------------------------------------------------------------------
// Test capacity — the honest capability statement
// ---------------------------------------------------------------------------

test('test capacity says zero when zero is the truth', () => {
  const required = conversionsRequiredPerArm(0.2, 'BAYES_ONE_SIDED_90');
  // £2,000/week at a $40 CPA: not one creative can be read properly.
  const small = testCapacity(200_000, TARGET_CPA, required);
  assert.equal(small.slots, 0);
  assert.match(small.claim, /do not claim to rank/);

  // $60,000/week: 20% of it is $12,000, three slots at ~$4,000 each.
  const large = testCapacity(6_000_000, TARGET_CPA, required);
  assert.equal(large.slots, 3);
  assert.ok(Math.abs(large.minTestSpendMinor - 100 * TARGET_CPA) < 5 * TARGET_CPA);

  // The exploration share never collapses to zero, however well things are going.
  assert.ok(testCapacity(6_000_000, TARGET_CPA, required, 0).exploreBudgetMinor >= 0.1 * 6_000_000);
});
