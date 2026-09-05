/**
 * The decision layer: gates, verdicts and budget clamps.
 *
 * `posterior.ts` says what we believe. This file says what we are allowed to DO about it,
 * and almost all of it is refusal. Three ideas run through the whole module.
 *
 *  1. **HOLD is the modal verdict, not a fall-through.** "Probably worse, but nowhere near
 *     confidently worse by enough" is where most creative lives most of the time. A system
 *     that cannot represent that state churns creative pointlessly, and every churn costs
 *     a learning-phase reset on the whole ad set. `EQUIVALENT` exists for the same reason:
 *     "indistinguishable from the incumbent" is a real answer, and treating it as a loss
 *     is how you end up regenerating a perfectly good ad every week.
 *
 *  2. **Gates come before statistics, always.** Minimum age, minimum spend, minimum
 *     conversions, minimum impressions, and — the one people forget — never judge an ad
 *     set that is still in LEARNING. Below the gates, the verdict is HOLD and the reason
 *     names which gate stopped it. There is no "best guess" path.
 *
 *  3. **Budget clamps are code, not advice.** ±20% per step, never below the account
 *     currency's minimum, at most two writes a day against Meta's hard cap of four an
 *     hour, a monotone daily high-water mark because an upward write is irreversible for
 *     the calendar day, and no writes at all while LEARNING.
 *
 * Everything is pure and deterministic. The verdicts do not use the RNG at all — only the
 * Thompson propensities do, and those are reporting, not allocation.
 */

import { MISSING_ATTRIBUTION_SETTING, type CompletenessCurve } from '../meta/insights.ts';
import { CHANGE_CAPS } from '../meta/scheduler.ts';
import {
  DEFAULT_THRESHOLD_OF_CARING,
  DecisionInputError,
  compareCpa,
  cpaSummary,
  cpaUpperBoundMinor,
  fitPosterior,
  powerCheck,
  priorForTargetCpa,
  probCpaAbove,
  thompsonWinProbabilities,
  type Comparison,
  type CpaSummary,
  type DailyStat,
  type GammaPosterior,
  type PosteriorFit,
  type PowerCheck,
  type PowerRule,
  type Rng,
  type ThompsonArm,
} from './posterior.ts';

function fail(what: string, why: string): never {
  throw new DecisionInputError(`${what}: ${why}`);
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export const VERDICTS = ['SCALE', 'HOLD', 'KILL', 'ITERATE', 'EQUIVALENT'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * `learning_stage_info.status` from the ad set node. `FAIL` means "Learning limited" — it
 * is a delivery state, not an error. `UNKNOWN` means we did not fetch it, and that is
 * treated as a gate failure rather than as permission: deciding without knowing whether
 * the ad set is in learning is how a system pauses an ad three days into its learning
 * phase and pays for the reset twice.
 */
export const LEARNING_STATUSES = ['LEARNING', 'SUCCESS', 'FAIL', 'UNKNOWN'] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];

/**
 * Meta's two published fatigue states, with its own numbers:
 * `CREATIVE_LIMITED` = cost per result is above past ads but below twice;
 * `CREATIVE_FATIGUE` = cost per result is at least twice as much.
 * They arrive as recommendation types on `GET /act_{id}/recommendations` and are free,
 * high-precision triggers for the generation pipeline — Meta is comparing against a
 * historical benchmark we do not have.
 */
export const FATIGUE_SIGNALS = ['CREATIVE_LIMITED', 'CREATIVE_FATIGUE'] as const;
export type FatigueSignal = (typeof FATIGUE_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const GATE_CODES = [
  'MIN_AGE',
  'MIN_SPEND',
  'MIN_CONVERSIONS',
  'MIN_IMPRESSIONS',
  'LEARNING',
  'LEARNING_UNKNOWN',
  'RECENT_SIGNIFICANT_EDIT',
  'MIXED_ATTRIBUTION',
  'NOT_ACTIVE',
  'NO_DELIVERY',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export interface GateFailure {
  code: GateCode;
  /** Names the actual numbers. Nobody is awake at 3am to reconstruct them. */
  detail: string;
}

export interface GateReport {
  passed: boolean;
  failures: readonly GateFailure[];
}

export interface DecisionGates {
  /**
   * No verdict before the ad is at least this old. Set it to the ad set's
   * `attribution_click_window_days` (7 on a `7d_click` account, 1 on a `1d_click` one).
   * There is no safe default: on a 1-day account a 7-day gate stalls every decision, and
   * on a 7-day account a 1-day gate judges ads on a third of their conversions.
   */
  minAgeDays: number;
  /** Below roughly 1.5 × target CPA, an observed CPA is barely a number. */
  minSpendMinor: number;
  /**
   * Conversions, not clicks. Below this there is no observed CPA to compare — but see
   * `zeroConversionExposureMinor`, which is the escape hatch that stops this gate from
   * protecting the worst ad in the account.
   */
  minConversions: number;
  /**
   * Completeness-corrected exposure above which TOO FEW CONVERSIONS IS ITSELF THE FINDING
   * and `minConversions` stops applying.
   *
   * Without this, an ad with a broken pixel or a dead landing page — spending every day and
   * converting never — fails `minConversions` on every run, is gated out of every
   * comparison, and is therefore the one ad in the account that can never be killed. The
   * gate meant to prevent a hasty verdict instead guarantees an unbounded one-way spend.
   *
   * The threshold is the rule of three: zero events in `n` events' worth of exposure puts
   * the 95% upper bound on the event rate at `3/n`, so at three target-CPAs of *effective*
   * exposure we are ~95% confident the true CPA is worse than target, and the posterior
   * (which already contains that exposure) can be trusted to say so. Below it, an at-target
   * ad still draws zero conversions often enough that a kill would be noise: e^-1.5 = 22%
   * of the time at 1.5 target-CPAs, e^-3 = 5% at three.
   */
  zeroConversionExposureMinor: number;
  /** 1000 — Meta's own floor for populating the ranking diagnostics. */
  minImpressions: number;
  /** Days since `last_sig_edit_ts`. An ad set re-entering learning is not comparable. */
  minDaysSinceSignificantEdit: number;
}

export const DEFAULT_MIN_IMPRESSIONS = 1000;
export const DEFAULT_MIN_CONVERSIONS = 1;
/** Rule of three: 3 target-CPAs of effective exposure with nothing to show is evidence. */
export const ZERO_CONVERSION_EXPOSURE_MULTIPLE = 3;
export const DEFAULT_MIN_DAYS_SINCE_SIGNIFICANT_EDIT = 3;
/** min_spend = 1.5 × target CPA. */
export const MIN_SPEND_MULTIPLE_OF_TARGET_CPA = 1.5;

/**
 * The standard gate set for an account.
 *
 * `attributionClickWindowDays` is required and not defaulted on purpose — it is the one
 * number here that must come from the ad set's actual `attribution_setting`.
 */
export function gatesFor(targetCpaMinor: number, attributionClickWindowDays: number): DecisionGates {
  if (!(targetCpaMinor > 0)) fail('targetCpaMinor', `${targetCpaMinor} must be > 0.`);
  if (!(attributionClickWindowDays > 0)) {
    fail('attributionClickWindowDays', `${attributionClickWindowDays} must be > 0.`);
  }
  return {
    minAgeDays: attributionClickWindowDays,
    minSpendMinor: MIN_SPEND_MULTIPLE_OF_TARGET_CPA * targetCpaMinor,
    minConversions: DEFAULT_MIN_CONVERSIONS,
    zeroConversionExposureMinor: ZERO_CONVERSION_EXPOSURE_MULTIPLE * targetCpaMinor,
    minImpressions: DEFAULT_MIN_IMPRESSIONS,
    minDaysSinceSignificantEdit: DEFAULT_MIN_DAYS_SINCE_SIGNIFICANT_EDIT,
  };
}

/** Everything the decision needs about one ad, already joined and already de-duplicated. */
export interface AdEvidence {
  adId: string;
  adSetId: string;
  /** Daily rows, ad-account-timezone dated, one primary action type only. */
  rows: readonly DailyStat[];
  /** Age of the AD, in days since it started delivering — not the age of its oldest row. */
  ageDays: number;
  impressions: number;
  /**
   * Impressions in the last 24h. Zero is a DISTINCT STATE, not bad performance: an ad that
   * is not being shown has no evidence about its quality, and letting a zero-impression
   * cohort update a creative prior teaches the system that its own creative is worthless.
   */
  impressionsLast24h: number;
  /** `effective_status` from the ad node. */
  effectiveStatus: string;
  learningStatus: LearningStatus;
  /** Days since `learning_stage_info.last_sig_edit_ts`. */
  daysSinceSignificantEdit: number;
  /**
   * The distinct `attribution_setting` values across `rows`. More than one — or the
   * `UNKNOWN` sentinel — and the rows are not the same random variable, so they must not
   * be aggregated. Attribution is taken from each ad set's own setting, so one Insights
   * response really can mix them.
   */
  attributionSettings: readonly string[];
  fatigue?: FatigueSignal;
}

export function evaluateGates(ad: AdEvidence, fit: PosteriorFit, gates: DecisionGates): GateReport {
  const failures: GateFailure[] = [];

  if (ad.ageDays < gates.minAgeDays) {
    failures.push({
      code: 'MIN_AGE',
      detail:
        `age ${ad.ageDays}d < ${gates.minAgeDays}d (the attribution click window). Its ` +
        `conversions have not finished arriving, so any CPA comparison is biased against it.`,
    });
  }
  if (fit.spendMinor < gates.minSpendMinor) {
    failures.push({
      code: 'MIN_SPEND',
      detail: `spend ${fit.spendMinor} < ${gates.minSpendMinor} minor units (1.5 × target CPA).`,
    });
  }
  // The escape is deliberately on EFFECTIVE exposure, not raw spend: a young ad's spend has
  // not finished reporting, and killing it for silence is the exact bias §5.4 is about.
  if (
    fit.conversions < gates.minConversions &&
    fit.effectiveSpendMinor < gates.zeroConversionExposureMinor
  ) {
    failures.push({
      code: 'MIN_CONVERSIONS',
      detail:
        `${fit.conversions} conversions < ${gates.minConversions}, and only ` +
        `${fit.effectiveSpendMinor.toFixed(0)} minor units of completeness-corrected exposure ` +
        `(raw spend ${fit.spendMinor}) against the ${gates.zeroConversionExposureMinor} at which ` +
        `silence becomes evidence. There is no CPA to compare yet.`,
    });
  }
  if (ad.impressions < gates.minImpressions) {
    failures.push({
      code: 'MIN_IMPRESSIONS',
      detail:
        `${ad.impressions} impressions < ${gates.minImpressions}. Below this Meta does not ` +
        `populate quality/engagement/conversion ranking either — nothing about the ad is stable yet.`,
    });
  }
  if (ad.learningStatus === 'LEARNING') {
    failures.push({
      code: 'LEARNING',
      detail:
        `ad set ${ad.adSetId} is in LEARNING. Delivery is deliberately unstable there and the ` +
        `cost data is not representative; judging it now both misreads the ad and pays for a ` +
        `second learning reset when we act.`,
    });
  }
  if (ad.learningStatus === 'UNKNOWN') {
    failures.push({
      code: 'LEARNING_UNKNOWN',
      detail:
        `learning_stage_info was not read for ad set ${ad.adSetId}. Request ` +
        `learning_stage_info{status,last_sig_edit_ts} on the ad set node; refusing to decide blind.`,
    });
  }
  if (ad.daysSinceSignificantEdit < gates.minDaysSinceSignificantEdit) {
    failures.push({
      code: 'RECENT_SIGNIFICANT_EDIT',
      detail:
        `${ad.daysSinceSignificantEdit}d since the last significant edit < ` +
        `${gates.minDaysSinceSignificantEdit}d. The post-edit data describes the edit, not the creative.`,
    });
  }
  const settings = [...new Set(ad.attributionSettings)];
  if (settings.length === 0) {
    failures.push({
      code: 'MIXED_ATTRIBUTION',
      detail:
        `no attribution_setting was carried through with these rows. Request it as a field on ` +
        `the Insights call — attribution is taken from each ad set's own setting, so it cannot ` +
        `be assumed from the account.`,
    });
  } else if (settings.length !== 1 || settings.includes(MISSING_ATTRIBUTION_SETTING)) {
    failures.push({
      code: 'MIXED_ATTRIBUTION',
      detail:
        `rows carry attribution_setting [${settings.join(', ')}]. Rows attributed differently ` +
        `are different random variables and must not be aggregated.`,
    });
  }
  if (ad.effectiveStatus !== 'ACTIVE') {
    failures.push({
      code: 'NOT_ACTIVE',
      detail: `effective_status is ${ad.effectiveStatus}, not ACTIVE.`,
    });
  } else if (ad.impressionsLast24h <= 0) {
    failures.push({
      code: 'NO_DELIVERY',
      detail:
        `zero impressions in the last 24h while ACTIVE. That is a delivery problem — an ` +
        `unfunded account, a rejected creative, a starved ad set — and NOT evidence about the ad.`,
    });
  }

  return { passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface DecisionThresholds {
  /** X: relative CPA gap below which we do not care which ad we keep. */
  thresholdOfCaring: number;
  /** κ_kill — P(worse by more than X) at or above this pauses the ad. */
  killAt: number;
  /** κ_scale — P(better) at or above this scales it. */
  scaleAt: number;
  /** ROPE mass at or above this declares equivalence and stops re-litigating. */
  equivalentAt: number;
  /** Which power rule gates EQUIVALENT. */
  powerRule: PowerRule;
}

/**
 * Defaults from the dossier.
 *
 * Note that `killAt` (0.80) is not symmetric with `scaleAt` (0.85) by accident. Killing an
 * ad forfeits its future value AND pays the learning-phase reset cost of whatever replaces
 * it, so the loss function is asymmetric and the system should be biased toward keeping —
 * which is the opposite of what a naive rule engine does.
 */
export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  thresholdOfCaring: DEFAULT_THRESHOLD_OF_CARING,
  killAt: 0.8,
  scaleAt: 0.85,
  equivalentAt: 0.9,
  powerRule: 'BAYES_ONE_SIDED_90',
};

// ---------------------------------------------------------------------------
// The slate decision
// ---------------------------------------------------------------------------

export interface AdDecision {
  adId: string;
  verdict: Verdict;
  /** Human-readable, with the numbers in it. This is the audit trail. */
  reason: string;
  gates: GateReport;
  fit: PosteriorFit;
  cpa: CpaSummary;
  isIncumbent: boolean;
  /**
   * Which ad this one was judged against. Challengers are judged against the incumbent;
   * the incumbent is judged against the runner-up, because comparing it with itself
   * produces a guaranteed tie and no information.
   */
  comparedToAdId?: string;
  /** Absent when the slate had nothing to compare this ad against. */
  comparison?: Comparison;
  power?: PowerCheck;
  /** P(this ad is the best in the slate) under Thompson sampling. Log it as the propensity. */
  winProbability: number;
}

export interface SlateInput {
  /** Decision date, `YYYY-MM-DD`, ad-account timezone. */
  asOfDate: string;
  /** Centres the prior. Minor units. */
  targetCpaMinor: number;
  gates: DecisionGates;
  ads: readonly AdEvidence[];
  /**
   * Seeded. Record the seed next to the decision: without it the propensities cannot be
   * reproduced and the policy cannot be evaluated off-policy later.
   */
  rng: Rng;
  thresholds?: DecisionThresholds;
  priorConversions?: number;
  curve?: CompletenessCurve;
  discount?: number;
  windowDays?: number;
  thompsonDraws?: number;
  alphaReshape?: number;
}

export interface SlateDecision {
  asOfDate: string;
  /** Absent when no ad cleared the gates: then everything HOLDs, which is correct. */
  incumbentAdId?: string;
  decisions: readonly AdDecision[];
}

/**
 * How the incumbent is chosen: the lowest UPPER credible bound on CPA.
 *
 * The incumbent is a POSTERIOR, not "the ad with the lowest observed CPA" — but it is also
 * not the lowest posterior MEAN. A prior worth one conversion is deliberately weak, so an
 * ad with three lucky conversions at a $20 CPA still has the best posterior mean in the
 * slate, and crowning it makes every other ad look terrible against a reference that is
 * mostly noise. Ranking on the upper bound asks the right question — which ad are we most
 * confident is good — and a small lucky ad cannot win it.
 */
export const INCUMBENT_TAIL = 0.1;

function rankKey(fit: PosteriorFit): number {
  return cpaUpperBoundMinor(fit.posterior, INCUMBENT_TAIL);
}

/**
 * The weekly creative decision for one slate of ads.
 *
 * Deterministic given the same inputs and the same seeded RNG. The RNG affects ONLY
 * `winProbability`; every verdict is computed from closed-form posterior probabilities, so
 * re-running the loop cannot flip a kill.
 */
export function decideSlate(input: SlateInput): SlateDecision {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const prior = priorForTargetCpa(input.targetCpaMinor, input.priorConversions);

  const seen = new Set<string>();
  const fits = new Map<string, PosteriorFit>();
  for (const ad of input.ads) {
    if (seen.has(ad.adId)) fail('ads', `duplicate adId ${ad.adId} in the slate.`);
    seen.add(ad.adId);
    fits.set(
      ad.adId,
      fitPosterior(prior, ad.rows, {
        asOfDate: input.asOfDate,
        ...(input.curve !== undefined ? { curve: input.curve } : {}),
        ...(input.discount !== undefined ? { discount: input.discount } : {}),
        ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
      }),
    );
  }

  const gateReports = new Map<string, GateReport>();
  for (const ad of input.ads) {
    const fit = fits.get(ad.adId);
    if (fit === undefined) continue;
    gateReports.set(ad.adId, evaluateGates(ad, fit, input.gates));
  }

  // Only a gate-passing ad may be a reference. Judging challengers against an ad set that
  // is still in learning propagates that instability into every verdict at once.
  //
  // The runner-up is kept as well, because the incumbent needs something to be judged
  // against: comparing it with itself is a guaranteed tie and tells us nothing, and it is
  // the incumbent — the leader — that most often deserves the SCALE verdict.
  const ranked: Array<{ adId: string; fit: PosteriorFit }> = [];
  for (const ad of input.ads) {
    const fit = fits.get(ad.adId);
    const gates = gateReports.get(ad.adId);
    if (fit === undefined || gates === undefined || !gates.passed) continue;
    ranked.push({ adId: ad.adId, fit });
  }
  ranked.sort((a, b) => {
    const d = rankKey(a.fit) - rankKey(b.fit);
    if (d !== 0) return d;
    // Deterministic tie-breaks, so the reference does not wander between runs.
    const c = b.fit.conversions - a.fit.conversions;
    if (c !== 0) return c;
    return a.adId < b.adId ? -1 : a.adId > b.adId ? 1 : 0;
  });
  const incumbentId = ranked[0]?.adId;
  const runnerUpId = ranked[1]?.adId;

  const arms: ThompsonArm[] = [];
  for (const ad of input.ads) {
    const fit = fits.get(ad.adId);
    if (fit !== undefined) arms.push({ id: ad.adId, posterior: fit.posterior });
  }
  const wins = thompsonWinProbabilities(arms, input.rng, {
    ...(input.thompsonDraws !== undefined ? { draws: input.thompsonDraws } : {}),
    ...(input.alphaReshape !== undefined ? { alphaReshape: input.alphaReshape } : {}),
  });

  const decisions: AdDecision[] = [];
  for (const ad of input.ads) {
    const fit = fits.get(ad.adId);
    const gates = gateReports.get(ad.adId);
    if (fit === undefined || gates === undefined) continue;
    const isIncumbent = ad.adId === incumbentId;
    const cpa = cpaSummary(fit.posterior);
    const winProbability = wins.get(ad.adId) ?? 0;

    // A challenger is judged against the incumbent; the incumbent against the runner-up.
    const referenceId = isIncumbent ? runnerUpId : incumbentId;
    const referenceFit = referenceId === undefined ? undefined : fits.get(referenceId);

    let comparison: Comparison | undefined;
    let power: PowerCheck | undefined;
    if (referenceFit !== undefined) {
      comparison = compareCpa(fit.posterior, referenceFit.posterior, thresholds.thresholdOfCaring);
      power = powerCheck(
        fit.conversions,
        referenceFit.conversions,
        thresholds.thresholdOfCaring,
        thresholds.powerRule,
      );
    }

    const { verdict, reason } = verdictFor({
      ad,
      fit,
      gates,
      cpa,
      isIncumbent,
      thresholds,
      targetCpaMinor: input.targetCpaMinor,
      ...(referenceId !== undefined ? { referenceId } : {}),
      ...(comparison !== undefined ? { comparison } : {}),
      ...(power !== undefined ? { power } : {}),
    });

    decisions.push({
      adId: ad.adId,
      verdict,
      reason,
      gates,
      fit,
      cpa,
      isIncumbent,
      winProbability,
      ...(referenceId !== undefined ? { comparedToAdId: referenceId } : {}),
      ...(comparison !== undefined ? { comparison } : {}),
      ...(power !== undefined ? { power } : {}),
    });
  }

  return {
    asOfDate: input.asOfDate,
    ...(incumbentId !== undefined ? { incumbentAdId: incumbentId } : {}),
    decisions,
  };
}

interface VerdictInput {
  ad: AdEvidence;
  fit: PosteriorFit;
  gates: GateReport;
  cpa: CpaSummary;
  isIncumbent: boolean;
  thresholds: DecisionThresholds;
  /** The brand's target CPA, minor units. SCALE is held against it, not only against a rival. */
  targetCpaMinor: number;
  /** The ad this one is judged against, when the slate had one. */
  referenceId?: string;
  comparison?: Comparison;
  power?: PowerCheck;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function verdictFor(v: VerdictInput): { verdict: Verdict; reason: string } {
  const { ad, fit, gates, thresholds, comparison, power } = v;

  // 1. Gates. Below them the answer is HOLD and the reason is which gate stopped it.
  if (!gates.passed) {
    const learningBlocked = gates.failures.some((f) => f.code === 'LEARNING');
    if (ad.fatigue !== undefined && learningBlocked) {
      return {
        verdict: 'HOLD',
        reason:
          `Meta reports ${ad.fatigue}, but ad set ${ad.adSetId} is still in LEARNING. ` +
          `Replacing the creative now is a second significant edit and pays for the reset ` +
          `twice; deferred to the next creative window.`,
      };
    }
    return {
      verdict: 'HOLD',
      reason: `gated: ${gates.failures.map((f) => `${f.code} — ${f.detail}`).join(' | ')}`,
    };
  }

  // 2. Statistics, when there is something to compare against.
  let verdict: Verdict = 'HOLD';
  let reason: string;
  const against = v.referenceId ?? '(none)';
  if (comparison === undefined || power === undefined) {
    verdict = 'HOLD';
    reason = v.isIncumbent
      ? `the only ad in this slate that cleared the gates (posterior median CPA ` +
        `${v.cpa.medianMinor.toFixed(0)} minor units over ${fit.conversions} conversions). ` +
        `Nothing to compare it against, so no verdict is available — that is not a judgement ` +
        `about the ad.`
      : `no gate-passing ad was available to compare against. Not a judgement about this ad.`;
  } else if (comparison.pWorseByThreshold >= thresholds.killAt) {
    verdict = 'KILL';
    reason =
      `P(CPA > ${(1 + comparison.thresholdOfCaring).toFixed(2)} × ${against}) = ` +
      `${pct(comparison.pWorseByThreshold)} ≥ ${pct(thresholds.killAt)}` +
      (comparison.expectedLossKeepMinor !== undefined
        ? `; keeping it costs ~${comparison.expectedLossKeepMinor.toFixed(0)} minor units per conversion`
        : '') +
      `. Posterior over ${fit.conversions} conversions and ${fit.effectiveSpendMinor.toFixed(0)} ` +
      `minor units of completeness-corrected exposure (raw spend ${fit.spendMinor}).`;
  } else if (comparison.pBetter >= thresholds.scaleAt) {
    // SCALE is the one verdict that spends MORE money, and every statistic above it is
    // RELATIVE: a slate in which every ad loses money still has a leader, and "better than
    // the other one" is not "worth more budget". So the leader is also held against the
    // number the advertiser actually chose. Without this the engine reads an account at 3×
    // its target CPA and proposes an increase, which is the most expensive way to be right.
    const scaleCeilingMinor = (1 + thresholds.thresholdOfCaring) * v.targetCpaMinor;
    const pWorseThanTarget = probCpaAbove(fit.posterior, scaleCeilingMinor);
    if (pWorseThanTarget >= thresholds.killAt) {
      verdict = 'HOLD';
      reason =
        `P(better than ${against}) = ${pct(comparison.pBetter)} ≥ ${pct(thresholds.scaleAt)}, ` +
        `but P(CPA > ${scaleCeilingMinor.toFixed(0)} minor units — ` +
        `${(1 + thresholds.thresholdOfCaring).toFixed(2)} × the brand's target of ` +
        `${v.targetCpaMinor}) = ${pct(pWorseThanTarget)} ≥ ${pct(thresholds.killAt)}. It leads a ` +
        `slate that is losing money; refusing to put more budget behind the best of a bad set. ` +
        `The fix is the offer, the creative or the target — not the budget.`;
    } else {
      verdict = 'SCALE';
      reason =
        `P(better than ${against}) = ${pct(comparison.pBetter)} ≥ ${pct(thresholds.scaleAt)} ` +
        `over ${fit.conversions} conversions, and it is not confidently worse than the brand's ` +
        `target CPA of ${v.targetCpaMinor} (P(CPA > ${scaleCeilingMinor.toFixed(0)}) = ` +
        `${pct(pWorseThanTarget)}).`;
    }
  } else if (comparison.ropeMass >= thresholds.equivalentAt && power.powered) {
    verdict = 'EQUIVALENT';
    reason =
      `${pct(comparison.ropeMass)} of the posterior lies within ±${pct(comparison.thresholdOfCaring)} ` +
      `of ${against}'s CPA, and the comparison is powered ` +
      `(${power.candidateConversions} and ${power.referenceConversions} conversions vs ` +
      `${power.requiredPerArm.toFixed(0)} required per arm). Not distinguishable from ` +
      `${against} — stop re-litigating it.`;
  } else if (comparison.ropeMass >= thresholds.equivalentAt) {
    // The trap this branch exists to block: with a weak prior and little data, two ads
    // both sit near the target CPA, the ROPE fills up, and the system declares them
    // equivalent — permanently retiring a comparison it never actually made.
    verdict = 'HOLD';
    reason =
      `${pct(comparison.ropeMass)} of the posterior is inside the equivalence region, but the ` +
      `comparison is NOT powered: ${power.candidateConversions} and ` +
      `${power.referenceConversions} conversions against ${power.requiredPerArm.toFixed(0)} ` +
      `required per arm to resolve ±${pct(comparison.thresholdOfCaring)}. The smallest gap ` +
      `these arms can resolve today is ${pct(power.detectableEffect)}. Cannot tell yet.`;
  } else {
    verdict = 'HOLD';
    reason =
      `P(worse by >${pct(comparison.thresholdOfCaring)}) = ${pct(comparison.pWorseByThreshold)} ` +
      `(kill at ${pct(thresholds.killAt)}), P(better) = ${pct(comparison.pBetter)} ` +
      `(scale at ${pct(thresholds.scaleAt)}) against ${against}. Probably ` +
      `${comparison.pBetter < 0.5 ? 'worse' : 'better'}, not confidently so by enough.`;
  }

  // 3. Meta's own fatigue signal, applied last.
  //
  // Meta compares against a historical cost-per-result benchmark we do not have, so it is
  // allowed to override our verdict — but only upward, into "make a variant of this". It
  // deliberately does NOT override KILL: an ad we are confident is much worse should not
  // become the parent of the next generation just because it is also worn out.
  if (ad.fatigue !== undefined && verdict !== 'KILL') {
    const overridable: readonly Verdict[] =
      ad.fatigue === 'CREATIVE_FATIGUE' ? ['HOLD', 'EQUIVALENT', 'SCALE'] : ['HOLD', 'EQUIVALENT'];
    if (overridable.includes(verdict)) {
      return {
        verdict: 'ITERATE',
        reason:
          `Meta reports ${ad.fatigue} (` +
          (ad.fatigue === 'CREATIVE_FATIGUE'
            ? 'cost per result at least twice past ads'
            : 'cost per result above past ads but below twice') +
          `), overriding ${verdict}: ${reason}`,
      };
    }
  }

  return { verdict, reason };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * ±20% per step. Meta publishes no percentage threshold for "significant edit"; the only
 * quantitative guidance it gives is that $100 → $101 is unlikely to restart learning while
 * $100 → $1000 may. 20% is chosen to sit far from the second example, and a 20%/day ladder
 * still reaches 10× in ln(10)/ln(1.2) ≈ 13 days, which is fast enough for any real need.
 * It is a convention, not a documented threshold — measure `last_sig_edit_ts` before and
 * after a write if you want to know what Meta actually considered significant.
 */
export const BUDGET_STEP_LIMIT = 0.2;
/** Meta's own advice is "2-3 times a day and only the early part of the day". */
export const MAX_BUDGET_WRITES_PER_DAY = 2;
/** Below this the change is noise and not worth burning one of the day's writes on. */
export const MIN_MEANINGFUL_BUDGET_CHANGE = 0.05;
/** No budget writes after this hour, ad-account timezone. */
export const LATEST_BUDGET_WRITE_HOUR = 12;
/** Meta may spend up to 75% over the daily budget on a given day. */
export const DAILY_SPEND_CEILING_MULTIPLE = 1.75;
/** "For every week ending Saturday at midnight, spending won't be more than 7× the daily budget." */
export const WEEKLY_SPEND_CEILING_MULTIPLE = 7;
/** Meta's hard per-ad-set cap: 4 budget changes per hour (error 613 / 1487632). */
export const META_BUDGET_CHANGES_PER_HOUR = CHANGE_CAPS.ADSET_BUDGET.max;

export interface BudgetContext {
  adSetId: string;
  /** Current `daily_budget`, minor units. */
  currentMinor: number;
  /**
   * The account currency's minimum daily budget, from `GET /act_{id}/minimum_budgets`.
   * Currency-dependent, must be fetched, never hardcoded — and the caller must have picked
   * the right one of the four (`min_daily_budget_high_freq`, `_imp`, `_low_freq`,
   * `_video_views`) for this ad set's optimisation goal.
   */
  minDailyBudgetMinor: number;
  /** The brand's hard ceiling. The system may never propose above it. */
  maxDailyBudgetMinor: number;
  /**
   * The highest budget already WRITTEN to this ad set today, if any.
   *
   * Meta's 175% daily ceiling anchors to the highest budget set that day, so raising
   * $100 → $400 at 10:00 and rolling back at 11:00 can still spend $700. An upward write is
   * irreversible for the calendar day, which is why the mark is monotone and why a second
   * increase on the same day is refused rather than clamped down to "only" +20%.
   */
  highWaterTodayMinor?: number;
  budgetWritesToday: number;
  budgetChangesLastHour: number;
  learningStatus: LearningStatus;
  daysSinceSignificantEdit: number;
  /** Hour of day, 0-23, in the AD ACCOUNT's timezone. */
  hourOfDayAccountTz: number;
}

export interface BudgetDecision {
  action: 'SET' | 'SKIP';
  /** Present only when `action === 'SET'`. Integer minor units. */
  valueMinor?: number;
  reason: string;
  /** Which clamps moved the number, in the order applied. */
  clampsApplied: readonly string[];
  /**
   * What the day can actually cost if this is written: 175% of the highest budget set
   * today. This is the number that is really at risk, not the budget.
   */
  worstCaseDailySpendMinor: number;
}

/**
 * Turn a desired budget into a write, or into a refusal with a reason.
 *
 * Every branch that returns SKIP is a place where a naive optimiser spends money it cannot
 * get back. This function is deliberately boring and deliberately paranoid.
 *
 * It does not call Meta. Proposals go into the scheduler's `BudgetChangeQueue`, which is
 * the single choke point for writes and enforces the 4/hour cap at execution time; this
 * function enforces the policy that keeps us from ever getting near it.
 */
export function proposeBudget(ctx: BudgetContext, desiredMinor: number): BudgetDecision {
  if (!(ctx.currentMinor > 0)) fail(`ad set ${ctx.adSetId} currentMinor`, `${ctx.currentMinor} must be > 0.`);
  if (!(ctx.minDailyBudgetMinor > 0)) {
    fail(`ad set ${ctx.adSetId} minDailyBudgetMinor`, `${ctx.minDailyBudgetMinor} must be > 0 (fetch /minimum_budgets).`);
  }
  if (ctx.maxDailyBudgetMinor < ctx.minDailyBudgetMinor) {
    fail(
      `ad set ${ctx.adSetId}`,
      `the brand ceiling ${ctx.maxDailyBudgetMinor} is below the account currency minimum ` +
        `${ctx.minDailyBudgetMinor}. No legal budget exists; this ad set cannot run and the ` +
        `brand file must be fixed.`,
    );
  }
  if (!Number.isFinite(desiredMinor)) fail('desiredMinor', `${desiredMinor} is not a finite number.`);

  const highWater = ctx.highWaterTodayMinor;
  const worstCase = (v: number): number =>
    DAILY_SPEND_CEILING_MULTIPLE * Math.max(ctx.currentMinor, v, highWater ?? 0);

  const skip = (reason: string, clamps: readonly string[] = []): BudgetDecision => ({
    action: 'SKIP',
    reason,
    clampsApplied: clamps,
    worstCaseDailySpendMinor: worstCase(ctx.currentMinor),
  });

  if (ctx.learningStatus === 'LEARNING') {
    return skip(
      `ad set ${ctx.adSetId} is in LEARNING. A budget edit here may restart the phase, and the ` +
        `cost data driving the change is not representative anyway.`,
    );
  }
  if (ctx.learningStatus === 'UNKNOWN') {
    return skip(
      `learning_stage_info was not read for ad set ${ctx.adSetId}. Refusing to write a budget ` +
        `without knowing whether the ad set is in learning.`,
    );
  }
  if (ctx.daysSinceSignificantEdit < DEFAULT_MIN_DAYS_SINCE_SIGNIFICANT_EDIT) {
    return skip(
      `only ${ctx.daysSinceSignificantEdit}d since the last significant edit on ${ctx.adSetId} ` +
        `(need ${DEFAULT_MIN_DAYS_SINCE_SIGNIFICANT_EDIT}d); the current data still describes the edit.`,
    );
  }
  if (ctx.hourOfDayAccountTz >= LATEST_BUDGET_WRITE_HOUR) {
    return skip(
      `it is ${ctx.hourOfDayAccountTz}:00 in the ad account timezone. Meta's guidance is to change ` +
        `budgets "only the early part of the day"; a late change compresses the remaining pacing window.`,
    );
  }
  if (ctx.budgetWritesToday >= MAX_BUDGET_WRITES_PER_DAY) {
    return skip(
      `${ctx.budgetWritesToday} budget writes already today on ${ctx.adSetId} (cap ` +
        `${MAX_BUDGET_WRITES_PER_DAY}). Each write is a candidate significant edit.`,
    );
  }
  if (ctx.budgetChangesLastHour >= META_BUDGET_CHANGES_PER_HOUR) {
    return skip(
      `${ctx.budgetChangesLastHour} budget changes on ${ctx.adSetId} in the last hour; Meta's hard ` +
        `cap is ${META_BUDGET_CHANGES_PER_HOUR}/hour (error ${CHANGE_CAPS.ADSET_BUDGET.errorCode}/` +
        `${CHANGE_CAPS.ADSET_BUDGET.errorSubcode}). The next write would be rejected.`,
    );
  }

  const clamps: string[] = [];
  let target = desiredMinor;

  if (target > ctx.maxDailyBudgetMinor) {
    target = ctx.maxDailyBudgetMinor;
    clamps.push(`brand ceiling ${ctx.maxDailyBudgetMinor}`);
  }

  const stepLo = ctx.currentMinor * (1 - BUDGET_STEP_LIMIT);
  const stepHi = ctx.currentMinor * (1 + BUDGET_STEP_LIMIT);
  if (target < stepLo) {
    target = stepLo;
    clamps.push(`-${100 * BUDGET_STEP_LIMIT}%/step floor ${stepLo.toFixed(0)}`);
  } else if (target > stepHi) {
    target = stepHi;
    clamps.push(`+${100 * BUDGET_STEP_LIMIT}%/step ceiling ${stepHi.toFixed(0)}`);
  }

  // The brand ceiling outranks the -20% step floor, and only on the way down. Money is the
  // thing we cannot get back; a learning reset caused by a large cut is merely expensive.
  if (target > ctx.maxDailyBudgetMinor) {
    target = ctx.maxDailyBudgetMinor;
    clamps.push(`brand ceiling ${ctx.maxDailyBudgetMinor} overrides the step floor`);
  }

  if (target < ctx.minDailyBudgetMinor) {
    target = ctx.minDailyBudgetMinor;
    clamps.push(`account currency minimum ${ctx.minDailyBudgetMinor}`);
  }

  if (highWater !== undefined && target > highWater) {
    target = highWater;
    clamps.push(`daily high-water mark ${highWater}`);
  }

  target = Math.round(target);

  if (target < ctx.minDailyBudgetMinor) {
    return skip(
      `the clamped target ${target} is below the account currency minimum ` +
        `${ctx.minDailyBudgetMinor}; Meta would reject the write.`,
      clamps,
    );
  }
  if (target > ctx.maxDailyBudgetMinor) {
    return skip(
      `the clamped target ${target} is above the brand ceiling ${ctx.maxDailyBudgetMinor}; ` +
        `refusing to propose a budget the brand has not authorised.`,
      clamps,
    );
  }

  const delta = Math.abs(target - ctx.currentMinor) / ctx.currentMinor;
  if (delta < MIN_MEANINGFUL_BUDGET_CHANGE) {
    return skip(
      `the clamped change is ${pct(delta)} of ${ctx.currentMinor}, below the ` +
        `${pct(MIN_MEANINGFUL_BUDGET_CHANGE)} noise floor. Not worth one of today's ` +
        `${MAX_BUDGET_WRITES_PER_DAY} writes, and every write risks a learning reset.`,
      clamps,
    );
  }

  return {
    action: 'SET',
    valueMinor: target,
    reason:
      `${ctx.currentMinor} → ${target} minor units (${target > ctx.currentMinor ? '+' : ''}` +
      `${pct((target - ctx.currentMinor) / ctx.currentMinor)})` +
      (clamps.length > 0 ? ` after clamps: ${clamps.join('; ')}` : '') +
      `. Worst case spend today is ${worstCase(target).toFixed(0)} minor units — an upward ` +
      `write is irreversible for the calendar day.`,
    clampsApplied: clamps,
    worstCaseDailySpendMinor: worstCase(target),
  };
}

/**
 * Should the portfolio's TOTAL budget grow, hold or shrink?
 *
 * Takes the portfolio's MARGINAL CPA — the shadow price λ from the equal-marginal-CPA
 * condition — not its average CPA. Passing average CPA here is the single most common
 * defect in automated budget tools: an ad set with a $30 average CPA that is steeply
 * saturating can have an $80 marginal CPA, and the correct action is to move money AWAY
 * from it toward a "worse" ad set with a $50 marginal CPA. Ranking on averages does the
 * opposite, and the resulting portfolio CPA degrades slowly enough that nobody notices.
 *
 * Marginal CPA can only be estimated honestly from deliberately randomised budget
 * perturbations. Observational (budget, CPA) pairs recover your own past decision rule.
 */
export const PORTFOLIO_SCALE_UP_BELOW = 0.85;
export const PORTFOLIO_SCALE_DOWN_ABOVE = 1.15;
export const PORTFOLIO_STEP = 0.15;

export function portfolioBudgetDelta(marginalCpaMinor: number, targetCpaMinor: number): number {
  if (!(marginalCpaMinor > 0)) fail('marginalCpaMinor', `${marginalCpaMinor} must be > 0.`);
  if (!(targetCpaMinor > 0)) fail('targetCpaMinor', `${targetCpaMinor} must be > 0.`);
  const ratio = marginalCpaMinor / targetCpaMinor;
  if (ratio < PORTFOLIO_SCALE_UP_BELOW) return PORTFOLIO_STEP;
  if (ratio > PORTFOLIO_SCALE_DOWN_ABOVE) return -PORTFOLIO_STEP;
  return 0;
}

/**
 * Money that could be spent today at this daily budget, and this week.
 *
 * The daily figure is 175% of the budget, not 100%. A guardrail written against 100% fires
 * a day late and roughly $0.75 on the dollar too late.
 */
export function spendCeilings(dailyBudgetMinor: number): { dailyMinor: number; weeklyMinor: number } {
  if (!(dailyBudgetMinor > 0)) fail('dailyBudgetMinor', `${dailyBudgetMinor} must be > 0.`);
  return {
    dailyMinor: DAILY_SPEND_CEILING_MULTIPLE * dailyBudgetMinor,
    weeklyMinor: WEEKLY_SPEND_CEILING_MULTIPLE * dailyBudgetMinor,
  };
}

// ---------------------------------------------------------------------------
// Exploration capacity
// ---------------------------------------------------------------------------

/** ρ — the share of budget reserved for testing new creative. */
export const DEFAULT_EXPLORE_SHARE = 0.2;
/** Never let exploration go to zero: today's winner decays and you need a challenger ready. */
export const MIN_EXPLORE_SHARE = 0.1;
export const MAX_EXPLORE_SHARE = 0.35;

export interface TestCapacity {
  exploreBudgetMinor: number;
  /** Spend needed to give ONE new creative a fair read at the threshold of caring. */
  minTestSpendMinor: number;
  /** How many creatives can be tested properly. Frequently 0, and saying so is the point. */
  slots: number;
  /** The honest sentence to put in front of the user. */
  claim: string;
}

/**
 * How many new creatives can this budget actually test?
 *
 * `min_test_spend = conversions_required_per_arm × target_CPA`, ~100 conversions at the
 * one-sided Bayesian 90% rule for a 20% gap, i.e. $4,000 at a $40 CPA. An account under
 * roughly $20k/week cannot test two creatives properly per week however you slice it, and
 * a product that promises otherwise is promising arithmetic that does not exist.
 *
 * Returning 0 slots is a correct answer, not a failure.
 */
export function testCapacity(
  weeklyBudgetMinor: number,
  targetCpaMinor: number,
  conversionsRequiredPerArm: number,
  exploreShare = DEFAULT_EXPLORE_SHARE,
): TestCapacity {
  if (!(weeklyBudgetMinor > 0)) fail('weeklyBudgetMinor', `${weeklyBudgetMinor} must be > 0.`);
  if (!(targetCpaMinor > 0)) fail('targetCpaMinor', `${targetCpaMinor} must be > 0.`);
  if (!(conversionsRequiredPerArm > 0)) {
    fail('conversionsRequiredPerArm', `${conversionsRequiredPerArm} must be > 0.`);
  }
  const share = Math.min(MAX_EXPLORE_SHARE, Math.max(MIN_EXPLORE_SHARE, exploreShare));
  const exploreBudgetMinor = share * weeklyBudgetMinor;
  const minTestSpendMinor = conversionsRequiredPerArm * targetCpaMinor;
  const slots = Math.floor(exploreBudgetMinor / minTestSpendMinor);
  return {
    exploreBudgetMinor,
    minTestSpendMinor,
    slots,
    claim:
      slots === 0
        ? 'No creative can be tested to a defensible confidence at this budget. We refresh ' +
          'creative on a schedule and stop obvious losers; we do not claim to rank them.'
        : `${slots} creative${slots === 1 ? '' : 's'} can be given a fair read this week at ` +
          `${minTestSpendMinor.toFixed(0)} minor units each.`,
  };
}
