/**
 * Posteriors over cost-per-action, and the delay correction that keeps the system from
 * killing its own newest creative.
 *
 * The model is Gamma–Poisson in the **shape–rate** parameterisation, over conversions
 * per unit of spend:
 *
 * ```
 *   c_a  ~ Poisson(θ_a · s_a)          c = conversions, s = spend (minor units)
 *   θ_a  ~ Gamma(shape = k₀, rate = r₀)                 θ = conversions per minor unit
 *   θ_a | data ~ Gamma(k₀ + c_a, r₀ + s_a)              CPA_a = 1/θ_a ~ InverseGamma
 * ```
 *
 * Four things about this file are load-bearing and none of them are obvious.
 *
 *  1. **shape–RATE, never shape–scale.** Passing a rate where a library wants a scale
 *     inverts the strength of the prior and the posterior still looks plausible, so the
 *     bug survives review and shows up as money. `GammaPosterior.rate` carries units of
 *     MINOR CURRENCY UNITS; `shape` is a dimensionless conversion count.
 *
 *  2. **The exposure is deflated, never the numerator inflated.** `s_effective =
 *     spend × F(age)`. Inflating observed conversions to a predicted final count
 *     fabricates certainty ("we saw 14, we think it'll be 19, treat it as 19"); deflating
 *     the exposure says the true thing — we have seen less evidence than the spend
 *     suggests — and leaves the posterior appropriately wide. See §5.3 of
 *     docs/research/autonomous-optimization-science.md.
 *
 *  3. **The comparison probabilities are exact, not Monte Carlo.** The dossier (§6.2)
 *     says to Monte-Carlo the CPA comparison because there is "no equally tidy closed
 *     form". There is one: for independent θ₁ ~ Gamma(k₁,r₁), θ₂ ~ Gamma(k₂,r₂),
 *     `r₁θ₁ / (r₁θ₁ + r₂θ₂) ~ Beta(k₁, k₂)`, so every "P(CPA_a < ratio × CPA_b)" reduces
 *     to a regularised incomplete beta. We use it because a verdict that moves between
 *     two runs on identical data is unexplainable to a customer and invites re-running
 *     until you like the answer. Monte Carlo is retained only as a test oracle.
 *
 *  4. **Money is in minor units throughout.** This module never learns the currency's
 *     decimal offset — eleven currencies have offset 1 — so it neither formats nor
 *     converts. `4187 minor units` in an error string is deliberate, not lazy.
 *
 * Everything here is pure: no clock, no IO, no `Math.random`. The RNG used for Thompson
 * sampling is injected by the caller so a decision can be replayed from its seed.
 */

import {
  DEFAULT_COMPLETENESS_CURVE,
  SETTLED_AFTER_DAYS,
  completenessFactor,
  daysBetween,
  type CompletenessCurve,
} from '../meta/insights.ts';
import type { Brand } from '../domain/brand.ts';

export class DecisionInputError extends Error {}

function fail(what: string, why: string): never {
  throw new DecisionInputError(`${what}: ${why}`);
}

function requireFinite(name: string, v: number): number {
  if (!Number.isFinite(v)) fail(name, `${v} is not a finite number.`);
  return v;
}

function requirePositive(name: string, v: number): number {
  requireFinite(name, v);
  if (v <= 0) fail(name, `${v} must be > 0.`);
  return v;
}

// ---------------------------------------------------------------------------
// Special functions
//
// Node has no gamma or beta. These are the standard Numerical Recipes algorithms,
// written out rather than approximated, because every decision threshold in the system
// is read off one of them and a 1% error in the tail is a wrong kill.
// ---------------------------------------------------------------------------

const LANCZOS_G0 = 0.99999999999980993;
const LANCZOS_TAIL: readonly number[] = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x), Lanczos g=7. Exact enough that the tails of the beta below are trustworthy. */
export function logGamma(x: number): number {
  requireFinite('x', x);
  if (x <= 0 && Number.isInteger(x)) fail('x', `Γ(${x}) is a pole.`);
  // Reflection: shape − 1 lands below 0.5 whenever a posterior has fewer than 1.5
  // effective conversions, which is the normal state of a brand-new ad.
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);

  const z = x - 1;
  let a = LANCZOS_G0;
  let i = 1;
  for (const coef of LANCZOS_TAIL) {
    a += coef / (z + i);
    i += 1;
  }
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const SERIES_EPS = 1e-15;
const SERIES_MAX = 500;
const TINY = 1e-300;

/**
 * P(a, x) — the regularised LOWER incomplete gamma, i.e. the CDF of Gamma(shape=a, rate=1).
 *
 * Series below the mean, continued fraction above it. Using one branch everywhere is the
 * classic way to lose four digits exactly where the kill threshold lives.
 */
export function gammaP(a: number, x: number): number {
  requirePositive('a', a);
  requireFinite('x', x);
  if (x < 0) fail('x', `${x} is negative; Gamma has support on [0, ∞).`);
  if (x === 0) return 0;
  if (!Number.isFinite(x)) return 1;

  const logPrefix = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    // Series representation.
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < SERIES_MAX; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * SERIES_EPS) break;
    }
    return sum * Math.exp(logPrefix);
  }

  // Continued fraction (modified Lentz) for Q(a,x) = 1 − P(a,x).
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= SERIES_MAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < SERIES_EPS) break;
  }
  return 1 - Math.exp(logPrefix) * h;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= SERIES_MAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < SERIES_EPS) break;
  }
  return h;
}

/** I_x(a, b) — the regularised incomplete beta, i.e. the CDF of Beta(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  requirePositive('a', a);
  requirePositive('b', b);
  requireFinite('x', x);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  const front = Math.exp(logFront);
  // Continue on whichever side converges; the symmetry relation covers the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * The p-quantile of Gamma(shape, rate).
 *
 * Bisection rather than Newton: it cannot diverge, it needs no derivative, and at ~60
 * iterations it has exhausted double precision. This runs a few hundred times per
 * decision, not a few million, so robustness beats speed.
 */
export function gammaQuantile(shape: number, rate: number, p: number): number {
  requirePositive('shape', shape);
  requirePositive('rate', rate);
  requireFinite('p', p);
  if (p <= 0) return 0;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  let lo = 0;
  let hi = shape + 10 * Math.sqrt(shape) + 10;
  for (let guard = 0; gammaP(shape, hi) < p; guard++) {
    hi *= 2;
    if (guard > 200) fail('gammaQuantile', `could not bracket p=${p} for shape=${shape}.`);
  }
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (gammaP(shape, mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-13 * Math.max(1, hi)) break;
  }
  return (0.5 * (lo + hi)) / rate;
}

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** A uniform draw on [0, 1). Injected everywhere; this module never calls `Math.random`. */
export type Rng = () => number;

/**
 * mulberry32. Deterministic, fast, and adequate for randomised probability matching.
 *
 * NOT cryptographic and not meant to be. What matters is that a decision can be replayed:
 * store the seed alongside the propensities or the decision is not auditable, and
 * off-policy evaluation of our own policy becomes impossible after the fact.
 */
export function createSeededRng(seed: number): Rng {
  requireFinite('seed', seed);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: Rng): number {
  // Box–Muller. The second variate is discarded rather than cached: caching would make
  // the function stateful, and two callers sharing an RNG would then get results that
  // depend on call order rather than on the seed.
  let u = rng();
  if (!(u > 0)) u = Number.EPSILON;
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** One draw from Gamma(shape, rate). Marsaglia–Tsang, with the standard shape<1 boost. */
export function sampleGamma(shape: number, rate: number, rng: Rng): number {
  requirePositive('shape', shape);
  requirePositive('rate', rate);
  if (shape < 1) return sampleGamma(shape + 1, rate, rng) * Math.pow(rng(), 1 / shape);

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return (d * v) / rate;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
  }
}

// ---------------------------------------------------------------------------
// The posterior
// ---------------------------------------------------------------------------

export interface GammaPosterior {
  /** k — prior conversions plus observed conversions. A dimensionless count. */
  readonly shape: number;
  /** r — prior exposure plus effective spend, in the account currency's MINOR units. */
  readonly rate: number;
}

/**
 * Prior centred on the brand's target CPA and worth `priorConversions` conversions of
 * spend: `k₀ = n`, `r₀ = n × target_CPA`, so the prior mean of θ is exactly `1/CPA`.
 *
 * The default `n = 1` is deliberately weak — one conversion's worth of evidence. It is
 * not there to steer the answer; it is there to stop an ad with one conversion and $40
 * of spend claiming a $40 CPA with the confidence of a settled campaign.
 */
export const DEFAULT_PRIOR_CONVERSIONS = 1;

export function priorForTargetCpa(
  targetCpaMinor: number,
  priorConversions = DEFAULT_PRIOR_CONVERSIONS,
): GammaPosterior {
  requirePositive('targetCpaMinor', targetCpaMinor);
  requirePositive('priorConversions', priorConversions);
  return { shape: priorConversions, rate: priorConversions * targetCpaMinor };
}

/**
 * The same, read off a brand.
 *
 * `spend.targetCpaMinor` is optional on the brand because value-optimised brands set
 * `targetRoas` instead. There is no defensible default for it here — a guessed prior
 * centres every posterior in the system on a number nobody chose — so this refuses.
 */
export function priorForBrand(brand: Brand, priorConversions = DEFAULT_PRIOR_CONVERSIONS): GammaPosterior {
  const target = brand.spend.targetCpaMinor;
  if (target === undefined) {
    fail(
      `brand ${brand.id}`,
      'spend.targetCpaMinor is not set. The Gamma prior is centred on the target CPA and ' +
        'there is no defensible default: set it in the brand file, or use a value-based ' +
        'model for this brand. Refusing to invent a target.',
    );
  }
  return priorForTargetCpa(target, priorConversions);
}

/** One day of one ad, dated in the AD ACCOUNT's timezone. Exactly one action type. */
export interface DailyStat {
  /** `date_start`, `YYYY-MM-DD`, ad-account timezone. */
  readonly statDate: string;
  readonly spendMinor: number;
  /**
   * Conversions of the single primary action type. NEVER a sum over `actions[]` — that
   * array contains overlapping roll-ups (`purchase` ⊃ `offsite_conversion.fb_pixel_purchase`)
   * and summing it double- or triple-counts.
   */
  readonly conversions: number;
}

/**
 * γ for the exponential recency discount. Effective memory is `1/(1−γ)` days, so 0.95 is
 * ≈21 days — the dossier's default for creative-level posteriors.
 *
 * Order of operations is mandatory and enforced by construction below: completeness-correct
 * FIRST, discount SECOND. Discounting raw spend up-weights recent data, which is exactly
 * the data that is systematically under-reported, and leaves the system permanently
 * pessimistic about the present.
 */
export const DEFAULT_CREATIVE_DISCOUNT = 0.95;

export interface PosteriorOptions {
  /** Decision date, `YYYY-MM-DD`, ad-account timezone. Row age is measured against this. */
  asOfDate: string;
  /** F(a). Refit per account from settled cohorts; the shipped default is illustrative. */
  curve?: CompletenessCurve;
  /** γ ∈ (0, 1]. 1 (the default) means no discount — a sliding window is easier to debug. */
  discount?: number;
  /** Sliding window: drop rows older than this many days. Applied before the discount. */
  windowDays?: number;
}

export interface PosteriorFit {
  posterior: GammaPosterior;
  /** Σ spend. What Meta actually billed. */
  spendMinor: number;
  /** Σ spend × F(age) × γ^age. What that spend is worth as EVIDENCE. Always ≤ spendMinor. */
  effectiveSpendMinor: number;
  /** Σ conversions, as reported. */
  conversions: number;
  /** Σ γ^age × conversions. Equal to `conversions` when γ = 1. */
  effectiveConversions: number;
  rowsUsed: number;
  rowsDropped: number;
  /** Spend-weighted mean F(age) across the rows used: the size of the delay bias, visible. */
  meanCompleteness: number;
  newestRowAgeDays?: number;
  oldestRowAgeDays?: number;
}

/**
 * Fold daily rows into the posterior, applying the completeness correction.
 *
 * This is the single most expensive line in the system to get wrong. A 2-day-old ad has
 * reported ~55–72% of its eventual conversions and a 7-day-old one ~95–97%; comparing
 * their raw CPAs kills the younger one every time, and the younger one is always the
 * creative the generator just made. The observable symptom is "the AI rejects its own
 * work", and it is a join bug wearing a model's clothes.
 */
export function fitPosterior(
  prior: GammaPosterior,
  rows: readonly DailyStat[],
  opts: PosteriorOptions,
): PosteriorFit {
  requirePositive('prior.shape', prior.shape);
  requirePositive('prior.rate', prior.rate);
  const curve = opts.curve ?? DEFAULT_COMPLETENESS_CURVE;
  const discount = opts.discount ?? 1;
  if (!(discount > 0) || discount > 1) {
    fail('discount', `${discount} must be in (0, 1]. γ>1 up-weights the past; γ≤0 is meaningless.`);
  }
  if (opts.windowDays !== undefined) requirePositive('windowDays', opts.windowDays);

  let shape = prior.shape;
  let rate = prior.rate;
  let spendMinor = 0;
  let effectiveSpendMinor = 0;
  let completenessWeightedSpend = 0;
  let conversions = 0;
  let effectiveConversions = 0;
  let rowsUsed = 0;
  let rowsDropped = 0;
  let newest: number | undefined;
  let oldest: number | undefined;

  for (const row of rows) {
    const age = daysBetween(row.statDate, opts.asOfDate);
    if (age < 0) {
      fail(
        `row ${row.statDate}`,
        `is dated after the decision date ${opts.asOfDate}. Insights dates are in the AD ` +
          `ACCOUNT's timezone; a UTC-based scheduler computes a "today" that is up to a day ` +
          `off and produces exactly this. Refusing to correct a negative age.`,
      );
    }
    requireFinite(`row ${row.statDate} spendMinor`, row.spendMinor);
    if (row.spendMinor < 0) fail(`row ${row.statDate} spendMinor`, `${row.spendMinor} is negative.`);
    requireFinite(`row ${row.statDate} conversions`, row.conversions);
    if (row.conversions < 0) fail(`row ${row.statDate} conversions`, `${row.conversions} is negative.`);

    if (opts.windowDays !== undefined && age >= opts.windowDays) {
      rowsDropped += 1;
      continue;
    }

    // Step 1: completeness. Beyond Meta's 28-day freeze the row cannot change again.
    const f = completenessFactor(Math.min(age, SETTLED_AFTER_DAYS), curve);
    // Step 2: and only then the recency discount. Both halves of the row carry the same
    // weight, so the CPA the row implies is untouched — only its influence shrinks.
    const w = discount === 1 ? 1 : Math.pow(discount, age);

    shape += w * row.conversions;
    rate += w * f * row.spendMinor;

    spendMinor += row.spendMinor;
    effectiveSpendMinor += w * f * row.spendMinor;
    completenessWeightedSpend += f * row.spendMinor;
    conversions += row.conversions;
    effectiveConversions += w * row.conversions;
    rowsUsed += 1;
    newest = newest === undefined ? age : Math.min(newest, age);
    oldest = oldest === undefined ? age : Math.max(oldest, age);
  }

  return {
    posterior: { shape, rate },
    spendMinor,
    effectiveSpendMinor,
    conversions,
    effectiveConversions,
    rowsUsed,
    rowsDropped,
    meanCompleteness: spendMinor > 0 ? completenessWeightedSpend / spendMinor : 1,
    ...(newest !== undefined ? { newestRowAgeDays: newest } : {}),
    ...(oldest !== undefined ? { oldestRowAgeDays: oldest } : {}),
  };
}

// ---------------------------------------------------------------------------
// Summarising a posterior
// ---------------------------------------------------------------------------

export const DEFAULT_CREDIBLE_LEVEL = 0.9;

export interface CpaSummary {
  /** Posterior median CPA, minor units. The point estimate to show, if you must show one. */
  medianMinor: number;
  loMinor: number;
  hiMinor: number;
  /** Mass inside [loMinor, hiMinor]. */
  level: number;
  /**
   * Posterior MEAN CPA, minor units. ABSENT when `shape ≤ 1`: E[1/θ] = r/(k−1) diverges
   * at k = 1, which is precisely the state of an ad with zero conversions under the
   * default prior. Returning a number there would be an invention.
   */
  meanMinor?: number;
}

/**
 * A one-sided upper credible bound on CPA: the value the true CPA is below with
 * probability `1 − tail`.
 *
 * This is the number to RANK on when picking a reference. A posterior mean rewards the ad
 * that got lucky with three conversions; the upper bound rewards the ad we are confident
 * about, which is what a reference has to be. It is also the one statistic in this module
 * a media buyer will accept without argument — intervals are explainable, a random draw
 * is not.
 */
export function cpaUpperBoundMinor(post: GammaPosterior, tail = 0.1): number {
  requirePositive('shape', post.shape);
  requirePositive('rate', post.rate);
  if (!(tail > 0 && tail < 1)) fail('tail', `${tail} must be in (0, 1).`);
  return 1 / gammaQuantile(post.shape, post.rate, tail);
}

/** Posterior over CPA = 1/θ. Quantiles invert: the p-th of CPA is the (1−p)-th of θ. */
export function cpaSummary(post: GammaPosterior, level = DEFAULT_CREDIBLE_LEVEL): CpaSummary {
  requirePositive('shape', post.shape);
  requirePositive('rate', post.rate);
  if (!(level > 0 && level < 1)) fail('level', `${level} must be in (0, 1).`);
  const tail = (1 - level) / 2;
  return {
    medianMinor: 1 / gammaQuantile(post.shape, post.rate, 0.5),
    loMinor: 1 / gammaQuantile(post.shape, post.rate, 1 - tail),
    hiMinor: 1 / gammaQuantile(post.shape, post.rate, tail),
    level,
    ...(post.shape > 1 ? { meanMinor: post.rate / (post.shape - 1) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Comparing two posteriors
// ---------------------------------------------------------------------------

/**
 * P(CPA_a < ratio × CPA_b), exactly.
 *
 * CPA_a < ratio·CPA_b ⟺ θ_b < ratio·θ_a. With A = r_b θ_b ~ Gamma(k_b, 1) and
 * B = r_a θ_a ~ Gamma(k_a, 1) independent, that is A < m·B for m = ratio·r_b/r_a, and
 * A/(A+B) ~ Beta(k_b, k_a), so the probability is I_{m/(1+m)}(k_b, k_a).
 *
 * Sanity anchor: identical posteriors and ratio = 1 give m = 1, x = ½, I_½(k,k) = ½.
 */
export function probCpaRatioBelow(a: GammaPosterior, b: GammaPosterior, ratio: number): number {
  requirePositive('a.shape', a.shape);
  requirePositive('a.rate', a.rate);
  requirePositive('b.shape', b.shape);
  requirePositive('b.rate', b.rate);
  requireFinite('ratio', ratio);
  if (ratio <= 0) return 0;
  const m = (ratio * b.rate) / a.rate;
  if (!Number.isFinite(m)) return 1;
  return incompleteBeta(b.shape, a.shape, m / (1 + m));
}

/**
 * E[(CPA_a − CPA_b)⁺] in minor units — the money you give up per conversion by keeping A
 * when B was better.
 *
 * Deterministic. The inner expectation has a closed form,
 * `E[(1/θ_a − t)⁺] = r_a/(k_a−1)·P(k_a−1, r_a/t) − t·P(k_a, r_a/t)`,
 * and the outer expectation over θ_b is taken by inverse-CDF stratification (evaluate at
 * the (i+½)/N quantiles). That is Monte Carlo with the variance removed, so the same
 * inputs always give the same loss.
 *
 * Returns `undefined` when `k_a ≤ 1`, because E[CPA_a] itself is then infinite. An ad with
 * no conversions has no finite expected loss and pretending otherwise is the sort of
 * quiet default this system cannot afford.
 */
export function expectedExcessCpa(
  a: GammaPosterior,
  b: GammaPosterior,
  nodes = 128,
): number | undefined {
  if (a.shape <= 1) return undefined;
  requirePositive('nodes', nodes);
  let acc = 0;
  for (let i = 0; i < nodes; i++) {
    const thetaB = gammaQuantile(b.shape, b.rate, (i + 0.5) / nodes);
    if (!(thetaB > 0) || !Number.isFinite(thetaB)) continue;
    const z = a.rate * thetaB;
    const inner = (a.rate / (a.shape - 1)) * gammaP(a.shape - 1, z) - gammaP(a.shape, z) / thetaB;
    acc += Math.max(0, inner);
  }
  return acc / nodes;
}

/**
 * P(CPA > `cpaMinor`) under this posterior, exactly.
 *
 * CPA = 1/θ, so `CPA > c ⟺ θ < 1/c` and the Gamma CDF answers it in one call.
 *
 * This is the statistic that holds a posterior against a FIXED number — the brand's target
 * CPA — rather than against another ad. Every other comparison in this file is relative,
 * and a slate of uniformly unprofitable ads still has a leader. Without this, "better than
 * the other ad" and "worth more money" are the same sentence, and they are not.
 */
export function probCpaAbove(post: GammaPosterior, cpaMinor: number): number {
  requirePositive('shape', post.shape);
  requirePositive('rate', post.rate);
  requirePositive('cpaMinor', cpaMinor);
  return gammaP(post.shape, post.rate / cpaMinor);
}

/** X — the threshold of caring. Differences smaller than this are not worth acting on. */
export const DEFAULT_THRESHOLD_OF_CARING = 0.2;

export interface Comparison {
  thresholdOfCaring: number;
  /** P(CPA_candidate < CPA_incumbent). */
  pBetter: number;
  /** P(CPA_candidate > (1+X) × CPA_incumbent) — the kill statistic, and the one to show. */
  pWorseByThreshold: number;
  /** P(|CPA ratio − 1| < X): the region of practical equivalence. */
  ropeMass: number;
  /** E[(CPA_cand − CPA_inc)⁺], minor units per conversion. Absent when k_cand ≤ 1. */
  expectedLossKeepMinor?: number;
  /** E[(CPA_inc − CPA_cand)⁺], minor units per conversion. Absent when k_inc ≤ 1. */
  expectedLossKillMinor?: number;
}

/**
 * The full Bayesian comparison of a candidate against the incumbent.
 *
 * `pWorseByThreshold` is the number the decision rule turns on and the only one that
 * survives translation into English: "there is an 87% chance this ad is more than 20%
 * more expensive than the one it is competing with".
 */
export function compareCpa(
  candidate: GammaPosterior,
  incumbent: GammaPosterior,
  thresholdOfCaring = DEFAULT_THRESHOLD_OF_CARING,
  nodes = 128,
): Comparison {
  if (!(thresholdOfCaring > 0 && thresholdOfCaring < 1)) {
    fail('thresholdOfCaring', `${thresholdOfCaring} must be in (0, 1); it is a relative CPA gap.`);
  }
  const upper = probCpaRatioBelow(candidate, incumbent, 1 + thresholdOfCaring);
  const lower = probCpaRatioBelow(candidate, incumbent, 1 - thresholdOfCaring);
  const keep = expectedExcessCpa(candidate, incumbent, nodes);
  const kill = expectedExcessCpa(incumbent, candidate, nodes);
  return {
    thresholdOfCaring,
    pBetter: probCpaRatioBelow(candidate, incumbent, 1),
    pWorseByThreshold: 1 - upper,
    ropeMass: Math.max(0, upper - lower),
    ...(keep !== undefined ? { expectedLossKeepMinor: keep } : {}),
    ...(kill !== undefined ? { expectedLossKillMinor: kill } : {}),
  };
}

// ---------------------------------------------------------------------------
// Statistical power — the "we cannot tell yet" surface
// ---------------------------------------------------------------------------

/**
 * z-multipliers for the two rules this product can honestly offer.
 *
 * `TWO_SIDED_80` is 1.960 + 0.842: a conventional two-sided test at α = 0.05 with 80%
 * power. `BAYES_ONE_SIDED_90` is the one-sided posterior bar at P ≥ 0.90 — the rule we
 * actually run, and about a fifth of the data.
 */
export const POWER_RULES = {
  TWO_SIDED_80: 2.802,
  BAYES_ONE_SIDED_90: 1.282,
} as const;
export type PowerRule = keyof typeof POWER_RULES;

/**
 * Conversions needed PER ARM, at equal exposure, to resolve a relative CPA gap of `effect`.
 *
 * For rare events Var(log RR) ≈ 1/E₁ + 1/E₂ = 2/E, so E = 2·(z / ln(1+X))².
 * At X = 20%: 470 per arm two-sided-80 (≈$37,600 for two arms at a $40 CPA — a year's
 * budget for most advertisers), 99 per arm under the one-sided Bayesian rule. That
 * ratio is the product strategy, not a footnote.
 */
export function conversionsRequiredPerArm(effect: number, rule: PowerRule): number {
  if (!(effect > 0)) fail('effect', `${effect} must be > 0; it is a relative CPA gap.`);
  const z = POWER_RULES[rule];
  return 2 * Math.pow(z / Math.log1p(effect), 2);
}

/**
 * The smallest relative CPA gap two arms can actually resolve, given what they have.
 *
 * Uses 1/E₁ + 1/E₂ rather than 2/E, because in this system the arms almost never have
 * equal exposure — the incumbent has months of history and the challenger has days.
 */
export function detectableEffect(
  conversionsA: number,
  conversionsB: number,
  rule: PowerRule,
): number {
  if (!(conversionsA > 0) || !(conversionsB > 0)) return Number.POSITIVE_INFINITY;
  const z = POWER_RULES[rule];
  return Math.exp(z * Math.sqrt(1 / conversionsA + 1 / conversionsB)) - 1;
}

export interface PowerCheck {
  /** Whether the comparison can resolve a gap of `thresholdOfCaring` at all. */
  powered: boolean;
  rule: PowerRule;
  thresholdOfCaring: number;
  requiredPerArm: number;
  candidateConversions: number;
  referenceConversions: number;
  /** The gap these two arms CAN resolve today. Infinite when either arm has no conversions. */
  detectableEffect: number;
}

/**
 * Can this comparison tell the difference we care about? Report it; do not silently
 * invent a winner.
 *
 * Deliberately does not gate KILL or SCALE: the posterior probabilities already account
 * for sample size, and an underpowered comparison simply will not reach 0.80. It DOES
 * gate EQUIVALENT (see decide.ts) — declaring equivalence is what stops a comparison
 * being re-litigated, and two ads that are indistinguishable only because neither has any
 * data are not equivalent, they are unmeasured.
 */
export function powerCheck(
  candidateConversions: number,
  referenceConversions: number,
  thresholdOfCaring = DEFAULT_THRESHOLD_OF_CARING,
  rule: PowerRule = 'BAYES_ONE_SIDED_90',
): PowerCheck {
  const requiredPerArm = conversionsRequiredPerArm(thresholdOfCaring, rule);
  return {
    powered: candidateConversions >= requiredPerArm && referenceConversions >= requiredPerArm,
    rule,
    thresholdOfCaring,
    requiredPerArm,
    candidateConversions,
    referenceConversions,
    detectableEffect: detectableEffect(candidateConversions, referenceConversions, rule),
  };
}

// ---------------------------------------------------------------------------
// Thompson sampling
// ---------------------------------------------------------------------------

/**
 * Posterior reshaping: divide both parameters by α. The mean k/r is unchanged and the
 * variance k/r² is multiplied by exactly α (Chapelle & Li state "close to α²" for a Beta;
 * for a Gamma it is α), so α < 1 narrows the posterior and explores LESS.
 *
 * α = 0.5 was their best setting on real display-advertising data (3.72% regret vs 3.81%
 * at α = 1). It matters more for us than for them: an account runs 20–200 creatives ever,
 * never 10⁷ pulls, and every unit of exploration is paid at full CPA. Their warning
 * travels with it — smaller α means fatter tails on the regret distribution, so pair it
 * with a hard exploration budget floor rather than trusting the sampler alone.
 */
export const DEFAULT_ALPHA_RESHAPE = 0.5;
export const DEFAULT_THOMPSON_DRAWS = 4000;

export interface ThompsonArm {
  id: string;
  posterior: GammaPosterior;
}

export interface ThompsonOptions {
  draws?: number;
  alphaReshape?: number;
}

/**
 * P(arm is the best) for every arm, by randomised probability matching.
 *
 * **Thompson sampling, not UCB, and the reason is delay — not fashion.** Chapelle & Li's
 * delayed-feedback table: as the gap between feedback batches goes 1 → 1000 steps, UCB's
 * regret grows 9.4× while TS's grows 6.5×, and the UCB/TS ratio widens from 2.65 to 3.82.
 * Their delays were minutes. Ours are 1–7 days, far off the right edge of that table. A
 * deterministic index policy re-picks the same arm for an entire settling window because
 * nothing in its input has changed; TS's randomisation is the only thing keeping
 * exploration alive across a multi-day observation lag.
 *
 * **And note what this output is for.** Meta's delivery system is already a per-impression
 * contextual bandit inside every ad set, with information we will never have. If our
 * bandit also allocated impressions the two would cancel, amplify or confound each other.
 * So these probabilities decide WHICH CREATIVES EXIST and what the campaign budget is —
 * never who sees what. They are also the propensity to log against the decision: without
 * it, nothing about our own policy is evaluable after the fact.
 */
export function thompsonWinProbabilities(
  arms: readonly ThompsonArm[],
  rng: Rng,
  opts: ThompsonOptions = {},
): Map<string, number> {
  const draws = opts.draws ?? DEFAULT_THOMPSON_DRAWS;
  const alpha = opts.alphaReshape ?? DEFAULT_ALPHA_RESHAPE;
  requirePositive('draws', draws);
  requirePositive('alphaReshape', alpha);

  const wins = new Map<string, number>();
  for (const arm of arms) {
    if (wins.has(arm.id)) fail('arms', `duplicate arm id ${arm.id}; win probabilities would collide.`);
    wins.set(arm.id, 0);
  }
  if (arms.length === 0) return wins;
  if (arms.length === 1) {
    const only = arms[0];
    if (only !== undefined) wins.set(only.id, 1);
    return wins;
  }

  for (let d = 0; d < draws; d++) {
    let bestId: string | undefined;
    let bestTheta = Number.NEGATIVE_INFINITY;
    for (const arm of arms) {
      // Higher θ is more conversions per unit spend, i.e. lower CPA. Best = max θ.
      const theta = sampleGamma(arm.posterior.shape / alpha, arm.posterior.rate / alpha, rng);
      if (theta > bestTheta) {
        bestTheta = theta;
        bestId = arm.id;
      }
    }
    if (bestId !== undefined) wins.set(bestId, (wins.get(bestId) ?? 0) + 1);
  }
  for (const [id, n] of wins) wins.set(id, n / draws);
  return wins;
}

/** One Thompson draw: the arm to act on now. Use for a single choice, not for reporting. */
export function thompsonPick(
  arms: readonly ThompsonArm[],
  rng: Rng,
  alphaReshape = DEFAULT_ALPHA_RESHAPE,
): string | undefined {
  let bestId: string | undefined;
  let bestTheta = Number.NEGATIVE_INFINITY;
  for (const arm of arms) {
    const theta = sampleGamma(arm.posterior.shape / alphaReshape, arm.posterior.rate / alphaReshape, rng);
    if (theta > bestTheta) {
      bestTheta = theta;
      bestId = arm.id;
    }
  }
  return bestId;
}
