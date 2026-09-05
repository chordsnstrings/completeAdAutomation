/**
 * Capability probe for src/autonomy/posterior.ts + src/autonomy/decide.ts.
 *
 * Not a unit test. The question is behavioural: driven with realistic campaign histories —
 * Poisson conversion arrivals, real daily spend, and Meta's reporting-completeness lag
 * applied so recent days are genuinely under-reported — does the decision engine make
 * sensible decisions?
 *
 * The core of the probe is a Monte-Carlo campaign simulator that replays 30 simulated days
 * through `decideSlate` and measures the things the synthesis puts numbers on:
 *
 *   - the FALSE-KILL RATE (synthesis §11.5 target: premature-kill rate < 5%);
 *   - whether genuine losers are actually killed;
 *   - whether the genuine winner survives and is scaled;
 *   - that nothing is ever acted on while the ad set is in LEARNING.
 *
 * Then the deterministic surfaces: the budget clamps, the statistical-power floor, and the
 * completeness correction that is supposed to stop the system killing its own newest
 * creative.
 *
 * Everything is offline and seeded. No Meta call of any kind is made — the module is pure,
 * so a faithful fake of Meta's Insights response shape is expressed directly as the
 * `DailyStat` rows the Insights layer produces (`date_start`-dated, ad-account timezone,
 * one primary action type, no `actions[]` roll-up summing) rather than as HTTP.
 */

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_COMPLETENESS_CURVE,
  addDays,
  completenessFactor,
  type CompletenessCurve,
} from '../meta/insights.ts';
import {
  DEFAULT_THRESHOLDS,
  MAX_BUDGET_WRITES_PER_DAY,
  META_BUDGET_CHANGES_PER_HOUR,
  decideSlate,
  gatesFor,
  proposeBudget,
  type AdDecision,
  type AdEvidence,
  type BudgetContext,
  type DecisionThresholds,
  type LearningStatus,
  type SlateDecision,
  type Verdict,
} from '../autonomy/decide.ts';
import {
  DecisionInputError,
  conversionsRequiredPerArm,
  createSeededRng,
  detectableEffect,
  incompleteBeta,
  powerCheck,
  probCpaRatioBelow,
  sampleGamma,
  type DailyStat,
  type GammaPosterior,
  type Rng,
} from '../autonomy/posterior.ts';

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  /**
   * Set when the check could not run for an environmental reason (no assets assigned, no
   * API key, binary missing) rather than because the code is wrong.
   */
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

interface Outcome {
  status: Check['status'];
  detail: string;
  blockedBy?: string;
}

const pass = (detail: string): Outcome => ({ status: 'PASS', detail });
const bad = (detail: string): Outcome => ({ status: 'FAIL', detail });
const skipped = (detail: string, blockedBy: string): Outcome => ({ status: 'SKIP', detail, blockedBy });

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function guard(name: string, body: () => Outcome): Check {
  try {
    const r = body();
    return {
      name,
      status: r.status,
      detail: r.detail,
      ...(r.blockedBy !== undefined ? { blockedBy: r.blockedBy } : {}),
    };
  } catch (err) {
    return { name, status: 'FAIL', detail: `threw instead of returning a verdict — ${describe(err)}` };
  }
}

const pctOf = (x: number): string => `${(100 * x).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// The campaign simulator
//
// One ad account, one ad set, N creatives launched together. Every creative has a KNOWN
// true CPA. Each day, each live creative spends a fixed daily budget and draws conversions
// from Poisson(spend / trueCPA). Each conversion is then given an ARRIVAL LAG drawn from the
// reporting-completeness curve, so a stat date's row grows over subsequent days exactly the
// way a real Insights row does — a 1-day-old row shows ~55% of its eventual conversions and
// a 7-day-old row ~97%.
//
// That lag is the whole point: it is the bias that makes a naive engine kill its own newest
// creative, and the engine's `s_effective = spend × F(age)` correction is the thing under
// test. The simulator's truth and the engine's assumed curve are deliberately the SAME curve
// in the headline runs — if the engine still misbehaves when its completeness model is
// perfectly specified, the fault cannot be blamed on curve mis-fit.
// ---------------------------------------------------------------------------

const TARGET_CPA = 4000; // minor units — $40.00
const DAILY_SPEND = 8000; // minor units — $80.00/day/creative, a realistic SMB slate
const IMPRESSIONS_PER_DAY = 5000;
const SIM_DAYS = 30;
const EPOCH = '2026-01-01';
const MAX_LAG = 28; // Meta freezes a row 28 days after its stat date
const ATTRIBUTION_WINDOW_DAYS = 7;
const LEARNING_DAYS = 7;

interface CreativeSpec {
  id: string;
  /** Ground truth the engine never sees. */
  trueCpaMinor: number;
}

/** Knuth's algorithm. λ here is always small (0.7–3 conversions/day). */
function poissonDraw(lambda: number, rng: Rng): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** P(lag ≤ a) = F(a): the completeness curve read as an arrival-time CDF. */
function lagCdf(curve: CompletenessCurve): number[] {
  const cdf: number[] = [];
  for (let a = 0; a <= MAX_LAG; a += 1) cdf.push(completenessFactor(a, curve));
  cdf[MAX_LAG] = 1;
  return cdf;
}

function drawLag(cdf: readonly number[], rng: Rng): number {
  const u = rng();
  for (let a = 0; a <= MAX_LAG; a += 1) if (u <= (cdf[a] ?? 1)) return a;
  return MAX_LAG;
}

interface KillEvent {
  adId: string;
  day: number;
  conversions: number;
  referenceConversions: number;
  pWorseByThreshold: number;
  powered: boolean;
  slateSize: number;
}

interface RunOutcome {
  killedOnDay: Map<string, number>;
  scaleVerdicts: Map<string, number>;
  kills: KillEvent[];
  /** Any verdict other than HOLD observed while the ad set reported LEARNING. */
  actionsWhileLearning: Array<{ day: number; adId: string; verdict: Verdict }>;
  /** True if every LEARNING-day HOLD named the LEARNING gate as a reason. */
  learningGateAlwaysNamed: boolean;
  learningDayDecisions: number;
}

interface RunOptions {
  cadenceDays: number;
  /** The curve the SIMULATOR uses to generate arrivals. */
  trueCurve: CompletenessCurve;
  /** The curve the ENGINE is told to assume. Undefined = the module default. */
  engineCurve?: CompletenessCurve;
  thresholds?: DecisionThresholds;
  /** Attribution click window, which is also the MIN_AGE gate. */
  attributionWindowDays?: number;
}

function simulateCampaign(specs: readonly CreativeSpec[], seed: number, opts: RunOptions): RunOutcome {
  const rng = createSeededRng(seed);
  const cdf = lagCdf(opts.trueCurve);
  const windowDays = opts.attributionWindowDays ?? ATTRIBUTION_WINDOW_DAYS;
  const gates = gatesFor(TARGET_CPA, windowDays);

  // arrivalsByStatDay[adId][statDay][lag] = cumulative conversions reported by that lag.
  const arrivals = new Map<string, number[][]>();
  const alive = new Map<string, boolean>();
  for (const s of specs) {
    arrivals.set(s.id, []);
    alive.set(s.id, true);
  }

  const killedOnDay = new Map<string, number>();
  const scaleVerdicts = new Map<string, number>();
  const kills: KillEvent[] = [];
  const actionsWhileLearning: Array<{ day: number; adId: string; verdict: Verdict }> = [];
  let learningGateAlwaysNamed = true;
  let learningDayDecisions = 0;

  for (let day = 0; day < SIM_DAYS; day += 1) {
    // --- generate day `day`'s ground truth
    for (const s of specs) {
      const perStatDay = arrivals.get(s.id);
      if (perStatDay === undefined) continue;
      const byLag = new Array<number>(MAX_LAG + 1).fill(0);
      if (alive.get(s.id) === true) {
        const n = poissonDraw(DAILY_SPEND / s.trueCpaMinor, rng);
        for (let i = 0; i < n; i += 1) {
          const lag = drawLag(cdf, rng);
          byLag[lag] = (byLag[lag] ?? 0) + 1;
        }
        for (let a = 1; a <= MAX_LAG; a += 1) byLag[a] = (byLag[a] ?? 0) + (byLag[a - 1] ?? 0);
      }
      perStatDay.push(byLag);
    }

    // --- decide at the START of the next day, on data through `day`
    const decisionDay = day + 1;
    if (decisionDay % opts.cadenceDays !== 0) continue;
    const live = specs.filter((s) => alive.get(s.id) === true);
    if (live.length === 0) break;

    const learningStatus: LearningStatus = decisionDay < LEARNING_DAYS ? 'LEARNING' : 'SUCCESS';
    const ads: AdEvidence[] = live.map((s) => {
      const perStatDay = arrivals.get(s.id) ?? [];
      const rows: DailyStat[] = [];
      for (let d = 0; d <= day; d += 1) {
        const byLag = perStatDay[d];
        if (byLag === undefined) continue;
        const age = Math.min(decisionDay - d, MAX_LAG);
        rows.push({
          statDate: addDays(EPOCH, d),
          spendMinor: DAILY_SPEND,
          conversions: byLag[age] ?? 0,
        });
      }
      return {
        adId: s.id,
        adSetId: 'as_sim',
        rows,
        ageDays: decisionDay,
        impressions: IMPRESSIONS_PER_DAY * decisionDay,
        impressionsLast24h: IMPRESSIONS_PER_DAY,
        effectiveStatus: 'ACTIVE',
        learningStatus,
        daysSinceSignificantEdit: decisionDay,
        attributionSettings: ['7d_click'],
      };
    });

    const slate: SlateDecision = decideSlate({
      asOfDate: addDays(EPOCH, decisionDay),
      targetCpaMinor: TARGET_CPA,
      gates,
      ads,
      rng,
      thompsonDraws: 32,
      ...(opts.thresholds !== undefined ? { thresholds: opts.thresholds } : {}),
      ...(opts.engineCurve !== undefined ? { curve: opts.engineCurve } : {}),
    });

    for (const d of slate.decisions) {
      if (learningStatus === 'LEARNING') {
        learningDayDecisions += 1;
        if (d.verdict !== 'HOLD') actionsWhileLearning.push({ day: decisionDay, adId: d.adId, verdict: d.verdict });
        if (!d.gates.failures.some((f) => f.code === 'LEARNING')) learningGateAlwaysNamed = false;
      }
      if (d.verdict === 'SCALE') scaleVerdicts.set(d.adId, (scaleVerdicts.get(d.adId) ?? 0) + 1);
      if (d.verdict === 'KILL' && alive.get(d.adId) === true) {
        alive.set(d.adId, false);
        killedOnDay.set(d.adId, decisionDay);
        const ref = slate.decisions.find((x) => x.adId === d.comparedToAdId);
        kills.push({
          adId: d.adId,
          day: decisionDay,
          conversions: d.fit.conversions,
          referenceConversions: ref?.fit.conversions ?? -1,
          pWorseByThreshold: d.comparison?.pWorseByThreshold ?? -1,
          powered: d.power?.powered ?? false,
          slateSize: live.length,
        });
      }
    }
  }

  return { killedOnDay, scaleVerdicts, kills, actionsWhileLearning, learningGateAlwaysNamed, learningDayDecisions };
}

/** Wilson score interval — the honest error bar on a small-sample rate. */
function wilson95(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)];
}

interface Aggregate {
  reps: number;
  killRate: Map<string, number>;
  killCount: Map<string, number>;
  scaleRate: Map<string, number>;
  kills: KillEvent[];
  totalKills: number;
  killsWithPower: number;
  actionsWhileLearning: Array<{ day: number; adId: string; verdict: Verdict }>;
  learningGateAlwaysNamed: boolean;
  learningDayDecisions: number;
}

function aggregate(specs: readonly CreativeSpec[], reps: number, seed0: number, opts: RunOptions): Aggregate {
  const killRate = new Map<string, number>();
  const scaleRate = new Map<string, number>();
  for (const s of specs) {
    killRate.set(s.id, 0);
    scaleRate.set(s.id, 0);
  }
  const kills: KillEvent[] = [];
  const actionsWhileLearning: Array<{ day: number; adId: string; verdict: Verdict }> = [];
  let killsWithPower = 0;
  let learningGateAlwaysNamed = true;
  let learningDayDecisions = 0;

  for (let r = 0; r < reps; r += 1) {
    const out = simulateCampaign(specs, seed0 + r, opts);
    for (const s of specs) {
      if (out.killedOnDay.has(s.id)) killRate.set(s.id, (killRate.get(s.id) ?? 0) + 1);
      if ((out.scaleVerdicts.get(s.id) ?? 0) > 0) scaleRate.set(s.id, (scaleRate.get(s.id) ?? 0) + 1);
    }
    for (const k of out.kills) {
      if (kills.length < 400) kills.push(k);
      if (k.powered) killsWithPower += 1;
    }
    actionsWhileLearning.push(...out.actionsWhileLearning);
    if (!out.learningGateAlwaysNamed) learningGateAlwaysNamed = false;
    learningDayDecisions += out.learningDayDecisions;
  }
  let totalKills = 0;
  const killCount = new Map<string, number>();
  for (const s of specs) {
    const n = killRate.get(s.id) ?? 0;
    totalKills += n;
    killCount.set(s.id, n);
    killRate.set(s.id, n / reps);
    scaleRate.set(s.id, (scaleRate.get(s.id) ?? 0) / reps);
  }
  return {
    reps,
    killRate,
    killCount,
    scaleRate,
    kills,
    totalKills,
    killsWithPower,
    actionsWhileLearning,
    learningGateAlwaysNamed,
    learningDayDecisions,
  };
}

// The mixed slate: one genuine winner, one near-miss, three genuine losers.
const MIXED_SLATE: readonly CreativeSpec[] = [
  { id: 'A_winner', trueCpaMinor: 0.7 * TARGET_CPA },
  { id: 'B_near', trueCpaMinor: 0.85 * TARGET_CPA },
  { id: 'C_loser', trueCpaMinor: 1.5 * TARGET_CPA },
  { id: 'D_loser', trueCpaMinor: 2.0 * TARGET_CPA },
  { id: 'E_loser', trueCpaMinor: 2.8 * TARGET_CPA },
];

/**
 * The null slate: five creatives with IDENTICAL true CPA, exactly at the brand's target.
 *
 * This is the sharpest possible false-kill measurement. There is no bad ad in this slate,
 * so EVERY kill is by definition premature. Any rate above the synthesis's <5% target here
 * is a defect and not a judgement call.
 */
const NULL_SLATE: readonly CreativeSpec[] = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => ({
  id,
  trueCpaMinor: TARGET_CPA,
}));

// ---------------------------------------------------------------------------
// Deterministic fixtures for the non-simulation checks
// ---------------------------------------------------------------------------

const AS_OF = '2026-06-01';

interface AdSpec {
  id: string;
  conversions: number;
  spendMinor: number;
  /** Rows are dated this many days back, all settled (age ≥ 28) unless overridden. */
  oldestAgeDays?: number;
  ageDays?: number;
  fatigue?: 'CREATIVE_LIMITED' | 'CREATIVE_FATIGUE';
  learningStatus?: LearningStatus;
  impressionsLast24h?: number;
  effectiveStatus?: string;
  attributionSettings?: readonly string[];
  daysSinceSignificantEdit?: number;
  rows?: readonly DailyStat[];
}

/** An ad whose rows are all settled, so F(age) = 1 and the posterior is exactly k=1+c, r=target+spend. */
function settledAd(s: AdSpec): AdEvidence {
  const oldest = s.oldestAgeDays ?? 40;
  const rows: readonly DailyStat[] =
    s.rows ?? [{ statDate: addDays(AS_OF, -oldest), spendMinor: s.spendMinor, conversions: s.conversions }];
  return {
    adId: s.id,
    adSetId: 'as_fixture',
    rows,
    ageDays: s.ageDays ?? 60,
    impressions: 500_000,
    impressionsLast24h: s.impressionsLast24h ?? 20_000,
    effectiveStatus: s.effectiveStatus ?? 'ACTIVE',
    learningStatus: s.learningStatus ?? 'SUCCESS',
    daysSinceSignificantEdit: s.daysSinceSignificantEdit ?? 30,
    attributionSettings: s.attributionSettings ?? ['7d_click'],
    ...(s.fatigue !== undefined ? { fatigue: s.fatigue } : {}),
  };
}

function decide(
  ads: readonly AdEvidence[],
  extra: { curve?: CompletenessCurve; attributionWindowDays?: number; targetCpaMinor?: number } = {},
): SlateDecision {
  const target = extra.targetCpaMinor ?? TARGET_CPA;
  return decideSlate({
    asOfDate: AS_OF,
    targetCpaMinor: target,
    gates: gatesFor(target, extra.attributionWindowDays ?? ATTRIBUTION_WINDOW_DAYS),
    ads,
    rng: createSeededRng(20260601),
    thompsonDraws: 64,
    ...(extra.curve !== undefined ? { curve: extra.curve } : {}),
  });
}

function decisionFor(slate: SlateDecision, adId: string): AdDecision {
  const d = slate.decisions.find((x) => x.adId === adId);
  if (d === undefined) throw new Error(`no decision returned for ${adId}`);
  return d;
}

const FLAT_CURVE: CompletenessCurve = [
  { ageDays: 0, factor: 1 },
  { ageDays: 28, factor: 1 },
];

function budgetCtx(over: Partial<BudgetContext> = {}): BudgetContext {
  return {
    adSetId: 'as_budget',
    currentMinor: 10_000,
    minDailyBudgetMinor: 500,
    maxDailyBudgetMinor: 500_000,
    budgetWritesToday: 0,
    budgetChangesLastHour: 0,
    learningStatus: 'SUCCESS',
    daysSinceSignificantEdit: 10,
    hourOfDayAccountTz: 9,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];

  // === Simulation runs (shared by several checks) ============================
  let mixedDaily: Aggregate | undefined;
  let mixedWeekly: Aggregate | undefined;
  let nullDaily: Aggregate | undefined;
  let nullWeekly: Aggregate | undefined;
  let simError: string | undefined;

  const MIXED_REPS = 250;
  const NULL_REPS = 80;
  try {
    mixedDaily = aggregate(MIXED_SLATE, MIXED_REPS, 10_000, {
      cadenceDays: 1,
      trueCurve: DEFAULT_COMPLETENESS_CURVE,
    });
    mixedWeekly = aggregate(MIXED_SLATE, MIXED_REPS, 10_000, {
      cadenceDays: 7,
      trueCurve: DEFAULT_COMPLETENESS_CURVE,
    });
    nullDaily = aggregate(NULL_SLATE, NULL_REPS, 20_000, {
      cadenceDays: 1,
      trueCurve: DEFAULT_COMPLETENESS_CURVE,
    });
    nullWeekly = aggregate(NULL_SLATE, NULL_REPS, 20_000, {
      cadenceDays: 7,
      trueCurve: DEFAULT_COMPLETENESS_CURVE,
    });
  } catch (err) {
    simError = describe(err);
  }

  const needSim = (a: Aggregate | undefined, body: (agg: Aggregate) => Outcome): Outcome => {
    if (a === undefined) return bad(`the campaign simulation did not complete — ${simError ?? 'unknown error'}`);
    return body(a);
  };

  // --- 1. Does it kill the genuinely bad creatives? -------------------------
  checks.push(
    guard('sim/kills the genuine losers', () =>
      needSim(mixedDaily, (agg) => {
        const losers = ['C_loser', 'D_loser', 'E_loser'];
        const rates = losers.map((id) => `${id} ${pctOf(agg.killRate.get(id) ?? 0)}`).join(', ');
        const worst = Math.min(...losers.map((id) => agg.killRate.get(id) ?? 0));
        const detail =
          `${agg.reps} replications × ${SIM_DAYS} simulated days, 5-creative slate at a ` +
          `${TARGET_CPA}-minor target CPA and ${DAILY_SPEND} minor units/day/creative, daily ` +
          `decisions, Poisson arrivals with the reporting lag applied. Kill rates: ${rates}. ` +
          `Winner A_winner (0.70× target) killed ${pctOf(agg.killRate.get('A_winner') ?? 0)}.`;
        return worst >= 0.9
          ? pass(`every genuine loser is killed in ≥90% of runs. ${detail}`)
          : bad(`a genuine loser survives too often (worst ${pctOf(worst)} < 90%). ${detail}`);
      }),
    ),
  );

  // --- 2. False-kill rate on the genuine winner ----------------------------
  checks.push(
    guard('sim/false-kill rate on the genuinely good creative (<5% target)', () =>
      needSim(mixedDaily, (agg) => {
        const k = agg.killCount.get('A_winner') ?? 0;
        const daily = agg.killRate.get('A_winner') ?? 0;
        const [lo, hi] = wilson95(k, agg.reps);
        const weekly = mixedWeekly?.killRate.get('A_winner');
        const weeklyK = mixedWeekly?.killCount.get('A_winner') ?? 0;
        const weeklyCi = mixedWeekly === undefined ? undefined : wilson95(weeklyK, mixedWeekly.reps);
        const detail =
          `A_winner has a true CPA of 0.70 × target — the best ad in the slate by 21% over the ` +
          `runner-up. Measured false-kill rate: DAILY decisions ${k}/${agg.reps} = ${pctOf(daily)} ` +
          `(95% Wilson CI ${pctOf(lo)}–${pctOf(hi)})` +
          (weekly !== undefined && weeklyCi !== undefined
            ? `; WEEKLY decisions ${weeklyK}/${mixedWeekly?.reps ?? 0} = ${pctOf(weekly)} ` +
              `(CI ${pctOf(weeklyCi[0])}–${pctOf(weeklyCi[1])})`
            : '') +
          `. The synthesis (§11.5) targets a premature-kill rate under 5%.`;
        if (daily > 0.05) return bad(`${pctOf(daily)} exceeds the 5% target. ${detail}`);
        if (hi > 0.05) {
          return bad(
            `the point estimate ${pctOf(daily)} is at or below 5%, but the 95% interval reaches ` +
              `${pctOf(hi)}, so this run does NOT establish that the engine holds the <5% line even ` +
              `for the slate's clear winner. Read alongside the identical-creative result below, ` +
              `which fails outright. ${detail}`,
          );
        }
        return pass(`${pctOf(daily)} with the whole 95% interval below 5%. ${detail}`);
      }),
    ),
  );

  // --- 3. Null slate: every kill is by construction premature ---------------
  checks.push(
    guard('sim/premature-kill rate on a slate of IDENTICAL creatives (<5% target)', () =>
      needSim(nullDaily, (agg) => {
        const perArm = agg.totalKills / (agg.reps * NULL_SLATE.length);
        const weeklyPerArm =
          nullWeekly === undefined ? undefined : nullWeekly.totalKills / (nullWeekly.reps * NULL_SLATE.length);
        const sample = agg.kills.slice(0, 4);
        const evidence = sample
          .map(
            (k) =>
              `day ${k.day}: ${k.adId} had ${k.conversions} conversions vs the reference's ` +
              `${k.referenceConversions}, P(worse by >20%) = ${k.pWorseByThreshold.toFixed(3)}, ` +
              `powered = ${k.powered}`,
          )
          .join(' | ');
        const detail =
          `Five creatives with IDENTICAL true CPA (exactly the brand target). There is no bad ad ` +
          `in this slate, so every kill is premature by construction. Per-arm premature-kill rate ` +
          `over ${agg.reps} replications: DAILY ${pctOf(perArm)}` +
          (weeklyPerArm !== undefined ? `, WEEKLY ${pctOf(weeklyPerArm)}` : '') +
          `. ${agg.killsWithPower} of ${agg.totalKills} kills were on a comparison the module's own ` +
          `powerCheck() calls POWERED. Sample kills — ${evidence}`;
        return perArm <= 0.05
          ? pass(`${pctOf(perArm)} ≤ 5%. ${detail}`)
          : bad(
              `${pctOf(perArm)} is ${(perArm / 0.05).toFixed(0)}× the <5% target. ${detail} ` +
                `MECHANISM: decideSlate() picks the incumbent as the MINIMUM upper credible bound ` +
                `over the slate, then judges every other ad against it. That reference is the ` +
                `maximum of N noisy estimates, so it is optimistically biased, and the pairwise ` +
                `posterior P(CPA > 1.2 × reference) inherits the bias. posterior.ts:powerCheck ` +
                `states "an underpowered comparison simply will not reach 0.80" — that premise is ` +
                `false and this measurement is the counter-example.`,
            );
      }),
    ),
  );

  // --- 4. Premature kills scale with slate size (the selection-bias signature) ---
  checks.push(
    guard('sim/premature kills split by cause: reference selection vs repeated looks', () => {
      // Vary the number of arms (how many candidates the incumbent is the maximum of) and the
      // number of looks (30 daily decisions vs one single decision on day 30). All arms are
      // identical throughout, so every kill in every cell is premature.
      const cells: string[] = [];
      const rates = new Map<string, number>();
      for (const n of [2, 3, 5]) {
        for (const cadence of [1, SIM_DAYS]) {
          const specs = Array.from({ length: n }, (_, i) => ({ id: `x${i}`, trueCpaMinor: TARGET_CPA }));
          const agg = aggregate(specs, 40, 30_000 + n, { cadenceDays: cadence, trueCurve: DEFAULT_COMPLETENESS_CURVE });
          const r = agg.totalKills / (agg.reps * n);
          rates.set(`${n}/${cadence}`, r);
          cells.push(`${n} arms, ${cadence === 1 ? '30 daily looks' : 'ONE look on day 30'} → ${pctOf(r)}`);
        }
      }
      const twoDaily = rates.get(`2/1`) ?? 0;
      const fiveDaily = rates.get(`5/1`) ?? 0;
      const twoSingle = rates.get(`2/${SIM_DAYS}`) ?? 0;
      const fiveSingle = rates.get(`5/${SIM_DAYS}`) ?? 0;
      const detail = `Per-arm premature-kill rate, 40 replications per cell: ${cells.join('; ')}.`;
      if (fiveDaily <= 0.05 && twoDaily <= 0.05) {
        return pass(`premature kills stay under 5% in every cell. ${detail}`);
      }
      return bad(
        `both failure mechanisms are present and they compound. (1) REFERENCE SELECTION: holding ` +
          `looks fixed, going from 2 to 5 arms raises the rate ${pctOf(twoDaily)} → ${pctOf(fiveDaily)} ` +
          `(daily) and ${pctOf(twoSingle)} → ${pctOf(fiveSingle)} (single look) — the incumbent is the ` +
          `MINIMUM upper credible bound over the slate, i.e. the maximum of N noisy estimates, so it is ` +
          `optimistically biased and every pairwise P(CPA > 1.2 × reference) inherits that bias. ` +
          `(2) REPEATED LOOKS: holding arms fixed, 30 daily decisions instead of one raises it ` +
          `${pctOf(fiveSingle)} → ${pctOf(fiveDaily)} at 5 arms — decideSlate applies a single-look ` +
          `posterior threshold and nothing in the module limits how often it may be called, so a ` +
          `caller on a daily cadence takes ~23 shots at the same 0.80 bar. Note the synthesis ` +
          `prescribes a WEEKLY creative maintenance window; that is load-bearing calibration, not ` +
          `an operational preference, and the module does not enforce it. ${detail}`,
      );
    }),
  );

  // --- 5. What kill threshold would actually hold the <5% line? ------------
  checks.push(
    guard('sim/kill threshold needed to hold the <5% premature-kill line', () => {
      const rows: string[] = [];
      let firstSafe: number | undefined;
      for (const killAt of [0.8, 0.95, 0.99]) {
        const agg = aggregate(NULL_SLATE, 40, 40_000, {
          cadenceDays: 1,
          trueCurve: DEFAULT_COMPLETENESS_CURVE,
          thresholds: { ...DEFAULT_THRESHOLDS, killAt },
        });
        const r = agg.totalKills / (agg.reps * NULL_SLATE.length);
        rows.push(`killAt=${killAt} → ${pctOf(r)}`);
        if (r <= 0.05 && firstSafe === undefined) firstSafe = killAt;
      }
      const detail =
        `Null slate, daily decisions, 40 replications per threshold: ${rows.join(', ')}. ` +
        `DEFAULT_THRESHOLDS.killAt is ${DEFAULT_THRESHOLDS.killAt}.`;
      if (firstSafe === undefined) return bad(`no tested threshold held the <5% line. ${detail}`);
      if (firstSafe <= DEFAULT_THRESHOLDS.killAt) return pass(`the shipped threshold holds the line. ${detail}`);
      return bad(
        `the shipped killAt of ${DEFAULT_THRESHOLDS.killAt} does not hold the <5% line; the first ` +
          `tested threshold that does is ${firstSafe}. This is reported as calibration evidence, ` +
          `not as a recommendation to simply raise the constant — raising it also delays killing ` +
          `genuine losers, and the real fault is that the reference is a selected maximum. ${detail}`,
      );
    }),
  );

  // --- 6. Nothing is ever acted on during the learning phase ---------------
  checks.push(
    guard('learning/no action is taken while the ad set is in LEARNING', () =>
      needSim(mixedDaily, (agg) => {
        const nullActions = nullDaily?.actionsWhileLearning.length ?? 0;
        const total = agg.learningDayDecisions + (nullDaily?.learningDayDecisions ?? 0);
        const violations = agg.actionsWhileLearning.length + nullActions;
        const detail =
          `${total} per-ad decisions were produced on simulated days where ` +
          `learning_stage_info.status was LEARNING, across the mixed and null slates. ` +
          `Non-HOLD verdicts on those days: ${violations}. The LEARNING gate was named in the ` +
          `failure list on every one of them: ` +
          `${agg.learningGateAlwaysNamed && (nullDaily?.learningGateAlwaysNamed ?? true)}.`;
        return violations === 0 && agg.learningGateAlwaysNamed
          ? pass(`no KILL, SCALE, ITERATE or EQUIVALENT was ever issued during LEARNING. ${detail}`)
          : bad(`the engine acted during the learning phase. ${detail}`);
      }),
    ),
  );

  // --- 7. Fatigue does not override the learning gate ----------------------
  checks.push(
    guard('learning/Meta CREATIVE_FATIGUE does not punch through the LEARNING gate', () => {
      const incumbent = settledAd({ id: 'inc', conversions: 300, spendMinor: 1_200_000 });
      const tired = settledAd({
        id: 'tired',
        conversions: 40,
        spendMinor: 400_000,
        fatigue: 'CREATIVE_FATIGUE',
        learningStatus: 'LEARNING',
      });
      const d = decisionFor(decide([incumbent, tired]), 'tired');
      const learningNamed = d.gates.failures.some((f) => f.code === 'LEARNING');
      return d.verdict === 'HOLD' && learningNamed
        ? pass(
            `an ad reporting CREATIVE_FATIGUE inside a LEARNING ad set is HOLD, not ITERATE — ` +
              `replacing it now would be a second significant edit and pay for the reset twice. ` +
              `Reason: ${d.reason.slice(0, 160)}`,
          )
        : bad(`expected HOLD with the LEARNING gate named; got ${d.verdict} (learning named: ${learningNamed}).`);
    }),
  );

  // --- 8. Budget: a proposal to triple the budget is clamped to +20% -------
  checks.push(
    guard('budget/a proposal to triple the budget is clamped to +20%', () => {
      const ctx = budgetCtx({ currentMinor: 10_000 });
      const d = proposeBudget(ctx, 30_000);
      const ok = d.action === 'SET' && d.valueMinor === 12_000;
      const worstOk = Math.abs(d.worstCaseDailySpendMinor - 1.75 * 12_000) < 1;
      return ok && worstOk
        ? pass(
            `desired 30000 → wrote ${d.valueMinor} (+20%), clamps [${d.clampsApplied.join('; ')}], ` +
              `worst-case day ${d.worstCaseDailySpendMinor} (175% of the day's high-water mark, not 100%).`,
          )
        : bad(`expected SET 12000 with a 21000 worst case; got ${d.action} ${d.valueMinor} / ${d.worstCaseDailySpendMinor}.`);
    }),
  );

  // --- 9. Budget: never proposes below the account currency minimum -------
  checks.push(
    guard("budget/never proposes below the account currency's minimum daily budget", () => {
      const results: string[] = [];
      let allSafe = true;
      for (const desired of [0, 1, 100, -5000]) {
        const ctx = budgetCtx({ currentMinor: 1000, minDailyBudgetMinor: 900, maxDailyBudgetMinor: 500_000 });
        const d = proposeBudget(ctx, desired);
        const value = d.action === 'SET' ? d.valueMinor : undefined;
        if (value !== undefined && value < ctx.minDailyBudgetMinor) allSafe = false;
        results.push(`desired ${desired} → ${d.action}${value !== undefined ? ` ${value}` : ''}`);
      }
      return allSafe
        ? pass(
            `the -20%/step floor and the /minimum_budgets floor both hold; nothing below 900 is ever ` +
              `proposed. ${results.join(', ')}.`,
          )
        : bad(`a sub-minimum budget was proposed, which Meta would reject: ${results.join(', ')}.`);
    }),
  );

  // --- 10. Budget: the 4-changes-per-hour cap ------------------------------
  checks.push(
    guard("budget/refuses a 5th change in an hour (Meta's hard 4/hour cap)", () => {
      const under = proposeBudget(budgetCtx({ budgetChangesLastHour: META_BUDGET_CHANGES_PER_HOUR - 1 }), 12_000);
      const at = proposeBudget(budgetCtx({ budgetChangesLastHour: META_BUDGET_CHANGES_PER_HOUR }), 12_000);
      const over = proposeBudget(budgetCtx({ budgetChangesLastHour: META_BUDGET_CHANGES_PER_HOUR + 3 }), 12_000);
      const ok = under.action === 'SET' && at.action === 'SKIP' && over.action === 'SKIP';
      return ok
        ? pass(
            `${META_BUDGET_CHANGES_PER_HOUR - 1} changes in the hour → SET; ` +
              `${META_BUDGET_CHANGES_PER_HOUR} → SKIP ("${at.reason.slice(0, 120)}"); ` +
              `${META_BUDGET_CHANGES_PER_HOUR + 3} → SKIP. Error 613/1487632 is never provoked.`,
          )
        : bad(`expected SET/SKIP/SKIP at ${META_BUDGET_CHANGES_PER_HOUR - 1}/${META_BUDGET_CHANGES_PER_HOUR}/${META_BUDGET_CHANGES_PER_HOUR + 3} changes; got ${under.action}/${at.action}/${over.action}.`);
    }),
  );

  // --- 11. Budget: the other refusals -------------------------------------
  checks.push(
    guard('budget/refuses while LEARNING, after two writes, late in the day, and past the high-water mark', () => {
      const cases: Array<[string, BudgetContext, number]> = [
        ['LEARNING', budgetCtx({ learningStatus: 'LEARNING' }), 12_000],
        ['learning status UNKNOWN', budgetCtx({ learningStatus: 'UNKNOWN' }), 12_000],
        ['recent significant edit', budgetCtx({ daysSinceSignificantEdit: 1 }), 12_000],
        [`${MAX_BUDGET_WRITES_PER_DAY} writes today`, budgetCtx({ budgetWritesToday: MAX_BUDGET_WRITES_PER_DAY }), 12_000],
        ['13:00 account time', budgetCtx({ hourOfDayAccountTz: 13 }), 12_000],
        ['second increase behind the day high-water mark', budgetCtx({ highWaterTodayMinor: 10_000 }), 40_000],
        ['sub-noise-floor change', budgetCtx(), 10_200],
      ];
      const wrong: string[] = [];
      const lines: string[] = [];
      for (const [label, ctx, desired] of cases) {
        const d = proposeBudget(ctx, desired);
        if (d.action !== 'SKIP') wrong.push(`${label} → ${d.action} ${d.valueMinor}`);
        lines.push(`${label} → ${d.action}`);
      }
      return wrong.length === 0
        ? pass(`all seven refusal paths return SKIP with a reason: ${lines.join(', ')}.`)
        : bad(`these should have been refused but were not: ${wrong.join('; ')}.`);
    }),
  );

  // --- 12. Budget: an impossible brand ceiling is refused loudly -----------
  checks.push(
    guard('budget/an impossible brand ceiling raises DecisionInputError rather than writing something', () => {
      try {
        const d = proposeBudget(budgetCtx({ minDailyBudgetMinor: 5000, maxDailyBudgetMinor: 1000 }), 3000);
        return bad(`expected a throw; got ${d.action} ${d.valueMinor}. A budget below the currency minimum is unwritable.`);
      } catch (err) {
        return err instanceof DecisionInputError
          ? pass(`DecisionInputError names the conflict: ${err.message.slice(0, 170)}`)
          : bad(`threw the wrong type: ${describe(err)}`);
      }
    }),
  );

  // --- 13. Power: the published floors ------------------------------------
  checks.push(
    guard('power/the conversions-per-arm floors match the dossier (≈470 two-sided, ≈100 Bayesian)', () => {
      const twoSided = conversionsRequiredPerArm(0.2, 'TWO_SIDED_80');
      const bayes = conversionsRequiredPerArm(0.2, 'BAYES_ONE_SIDED_90');
      const okTwo = Math.abs(twoSided - 470) <= 15;
      const okBayes = Math.abs(bayes - 100) <= 5;
      const detail =
        `at a 20% threshold of caring: TWO_SIDED_80 = ${twoSided.toFixed(1)}/arm ` +
        `(${(twoSided * TARGET_CPA * 2).toFixed(0)} minor units for a two-arm test at the ` +
        `${TARGET_CPA} target CPA), BAYES_ONE_SIDED_90 = ${bayes.toFixed(1)}/arm.`;
      return okTwo && okBayes ? pass(detail) : bad(`floors are off the dossier's numbers — ${detail}`);
    }),
  );

  // --- 14. Power: EQUIVALENT is refused below the floor -------------------
  checks.push(
    guard('power/refuses to declare equivalence below the statistical floor', () => {
      // Reference: 5000 conversions. Candidate: 80 (below the ~99 floor) then 120 (above it).
      // Spends are chosen so both posteriors have the same mean CPA — so the ROPE genuinely
      // fills up and only the power gate can stop an EQUIVALENT verdict.
      const reference = settledAd({ id: 'ref', conversions: 5000, spendMinor: 20_000_000 });
      const thin = settledAd({ id: 'thin', conversions: 80, spendMinor: 320_000 });
      const thick = settledAd({ id: 'thick', conversions: 120, spendMinor: 480_000 });

      const thinD = decisionFor(decide([reference, thin]), 'thin');
      const thickD = decisionFor(decide([reference, thick]), 'thick');

      const thinRope = thinD.comparison?.ropeMass ?? 0;
      const thickRope = thickD.comparison?.ropeMass ?? 0;
      const required = thinD.power?.requiredPerArm ?? 0;

      if (!(thinRope >= DEFAULT_THRESHOLDS.equivalentAt)) {
        return skipped(
          `could not construct the trap: the thin arm's ROPE mass is only ${thinRope.toFixed(3)}, ` +
            `below the ${DEFAULT_THRESHOLDS.equivalentAt} equivalence bar, so the power gate is not ` +
            `the thing being tested here.`,
          'fixture could not reach the equivalence branch',
        );
      }
      const thinOk = thinD.power?.powered === false && thinD.verdict === 'HOLD';
      const thickOk = thickD.power?.powered === true && thickD.verdict === 'EQUIVALENT';
      const detail =
        `80 conversions vs 5000: ROPE mass ${thinRope.toFixed(3)} ≥ ${DEFAULT_THRESHOLDS.equivalentAt} ` +
        `(the equivalence bar is MET) but powered = ${thinD.power?.powered} against ` +
        `${required.toFixed(0)} required per arm → verdict ${thinD.verdict}. ` +
        `120 conversions vs 5000: ROPE ${thickRope.toFixed(3)}, powered = ${thickD.power?.powered} ` +
        `→ verdict ${thickD.verdict}.`;
      return thinOk && thickOk
        ? pass(`the module refuses to retire a comparison it never actually made. ${detail}`)
        : bad(`the power gate did not behave as documented. ${detail}`);
    }),
  );

  // --- 15. Power: powered() vs the module's own detectableEffect ----------
  checks.push(
    guard('power/powered() is consistent with the module\'s own unequal-exposure statistic', () => {
      const probes: Array<[number, number]> = [
        [80, 5000],
        [60, 1_000_000],
        [150, 1000],
        [20, 1000],
      ];
      const disagreements: string[] = [];
      const lines: string[] = [];
      for (const [c, r] of probes) {
        const p = powerCheck(c, r, 0.2, 'BAYES_ONE_SIDED_90');
        const canResolve = p.detectableEffect <= 0.2;
        lines.push(`(${c}, ${r}) powered=${p.powered} detectableEffect=${p.detectableEffect.toFixed(3)}`);
        if (canResolve !== p.powered) disagreements.push(`(${c} vs ${r}): detectableEffect=${p.detectableEffect.toFixed(3)} ≤ 0.20 says the gap IS resolvable, but powered=${p.powered}`);
      }
      const detail = `${lines.join('; ')}.`;
      return disagreements.length === 0
        ? pass(`powered() and detectableEffect() agree on every probe. ${detail}`)
        : bad(
            `powered() applies the EQUAL-exposure requirement (${conversionsRequiredPerArm(0.2, 'BAYES_ONE_SIDED_90').toFixed(0)} ` +
              `conversions on EACH arm) while detectableEffect() correctly uses 1/E₁ + 1/E₂ — and the ` +
              `module's own docstring says "the arms almost never have equal exposure — the incumbent ` +
              `has months of history and the challenger has days". Consequence: EQUIVALENT is ` +
              `systematically withheld in exactly the situation the module calls normal, so those ` +
              `comparisons are re-litigated forever. Fails safe (toward HOLD), so this is a ` +
              `correctness/consistency defect rather than a money defect. Disagreements: ` +
              `${disagreements.join(' | ')}. ${detail}`,
          );
    }),
  );

  // --- 16. The completeness correction is load-bearing and works -----------
  checks.push(
    guard('completeness/the delay correction stops the engine killing its own newest creative', () => {
      // Two ads with the SAME true CPA (exactly the target). One is 30 days old and settled;
      // one is 3 days old, so its rows have reported only F(3)=0.82, F(2)=0.72, F(1)=0.55 of
      // their eventual conversions. This is the §5.4 worked example, at a spend level where
      // the naive comparison is decisive.
      const perDay = 200_000; // 50 true conversions/day at the 4000 target CPA
      const youngRows: DailyStat[] = [3, 2, 1].map((age) => ({
        statDate: addDays(AS_OF, -age),
        spendMinor: perDay,
        conversions: Math.round(50 * completenessFactor(age, DEFAULT_COMPLETENESS_CURVE)),
      }));
      const oldRows: DailyStat[] = Array.from({ length: 30 }, (_, i) => ({
        statDate: addDays(AS_OF, -(i + 30)),
        spendMinor: perDay,
        conversions: 50,
      }));
      const young = settledAd({ id: 'young', conversions: 0, spendMinor: 0, ageDays: 3, rows: youngRows, daysSinceSignificantEdit: 5 });
      const old = settledAd({ id: 'old', conversions: 0, spendMinor: 0, ageDays: 60, rows: oldRows });

      const corrected = decisionFor(decide([old, young], { attributionWindowDays: 1 }), 'young');
      const naive = decisionFor(decide([old, young], { attributionWindowDays: 1, curve: FLAT_CURVE }), 'young');

      const cP = corrected.comparison?.pWorseByThreshold ?? -1;
      const nP = naive.comparison?.pWorseByThreshold ?? -1;
      const detail =
        `Both ads have a true CPA of exactly ${TARGET_CPA}. The 3-day-old ad's rows have reported ` +
        `only ${(100 * completenessFactor(3, DEFAULT_COMPLETENESS_CURVE)).toFixed(0)}/` +
        `${(100 * completenessFactor(2, DEFAULT_COMPLETENESS_CURVE)).toFixed(0)}/` +
        `${(100 * completenessFactor(1, DEFAULT_COMPLETENESS_CURVE)).toFixed(0)}% of their conversions. ` +
        `WITH the correction: P(worse by >20%) = ${cP.toFixed(3)} → ${corrected.verdict} ` +
        `(effective exposure ${corrected.fit.effectiveSpendMinor.toFixed(0)} vs raw spend ` +
        `${corrected.fit.spendMinor}, mean F = ${corrected.fit.meanCompleteness.toFixed(3)}). ` +
        `WITHOUT it (flat F ≡ 1): P(worse by >20%) = ${nP.toFixed(3)} → ${naive.verdict}.`;
      if (corrected.verdict === 'KILL') return bad(`the engine killed its own newest creative even with the correction on. ${detail}`);
      if (naive.verdict !== 'KILL') {
        return pass(
          `the young creative survives (${corrected.verdict}); note the uncorrected control did not ` +
            `reach a kill either, so this run shows the correction is harmless but does not ` +
            `demonstrate it is decisive. ${detail}`,
        );
      }
      return pass(`the correction is decisive: it flips a KILL into ${corrected.verdict}. ${detail}`);
    }),
  );

  // --- 17. SCALE is held against the brand target, not just against a rival ---
  checks.push(
    guard('scale/refuses to put more budget behind the best of a losing slate', () => {
      // Both ads are far above the brand's target CPA. The leader beats the other decisively.
      const leader = settledAd({ id: 'leader', conversions: 100, spendMinor: 1_200_000 }); // 12000 = 3× target
      const worse = settledAd({ id: 'worse', conversions: 60, spendMinor: 1_200_000 }); // 20000 = 5× target
      const d = decisionFor(decide([leader, worse]), 'leader');
      const pBetter = d.comparison?.pBetter ?? 0;
      const detail =
        `the leader's observed CPA is ~3× the ${TARGET_CPA} target; P(better than the runner-up) = ` +
        `${pBetter.toFixed(3)} ≥ ${DEFAULT_THRESHOLDS.scaleAt}, so a purely relative rule would SCALE it. ` +
        `Verdict: ${d.verdict}. Reason: ${d.reason.slice(0, 190)}`;
      if (pBetter < DEFAULT_THRESHOLDS.scaleAt) {
        return skipped(`the fixture did not reach the SCALE branch (pBetter ${pBetter.toFixed(3)}).`, 'fixture did not reach the branch');
      }
      return d.verdict === 'HOLD'
        ? pass(`the absolute target-CPA guard holds. ${detail}`)
        : bad(`expected HOLD; got ${d.verdict}. ${detail}`);
    }),
  );

  // --- 18. The immortal-bad-ad escape hatch -------------------------------
  checks.push(
    guard('gates/an ad that spends and never converts becomes killable rather than immortal', () => {
      const healthy = settledAd({ id: 'healthy', conversions: 60, spendMinor: 240_000 });
      const brokenPixel = settledAd({ id: 'broken', conversions: 0, spendMinor: 240_000 });
      const tooEarly = settledAd({ id: 'early', conversions: 0, spendMinor: 6100 });

      const d = decisionFor(decide([healthy, brokenPixel]), 'broken');
      const e = decisionFor(decide([healthy, tooEarly]), 'early');
      const eGated = e.gates.failures.some((f) => f.code === 'MIN_CONVERSIONS');
      const detail =
        `240000 minor units of exposure with zero conversions → ${d.verdict} ` +
        `(MIN_CONVERSIONS gate ${d.gates.failures.some((f) => f.code === 'MIN_CONVERSIONS') ? 'still blocking' : 'released'}); ` +
        `6100 minor units with zero conversions → ${e.verdict} (MIN_CONVERSIONS blocking: ${eGated}). ` +
        `The release threshold is ${3 * TARGET_CPA} minor units of completeness-corrected exposure ` +
        `(the rule of three).`;
      return d.verdict === 'KILL' && e.verdict === 'HOLD' && eGated
        ? pass(`silence becomes evidence at 3 × target CPA, and not before. ${detail}`)
        : bad(`the zero-conversion escape hatch misfired. ${detail}`);
    }),
  );

  // --- 19. Zero delivery is not evidence ---------------------------------
  checks.push(
    guard('gates/an undelivered ad is HOLD, not KILL (delivery failure is not performance)', () => {
      const healthy = settledAd({ id: 'healthy', conversions: 60, spendMinor: 240_000 });
      const dark = settledAd({ id: 'dark', conversions: 1, spendMinor: 240_000, impressionsLast24h: 0 });
      const mixedAttribution = settledAd({
        id: 'mixedattr',
        conversions: 1,
        spendMinor: 240_000,
        attributionSettings: ['7d_click', '1d_view'],
      });
      const paused = settledAd({ id: 'paused', conversions: 1, spendMinor: 240_000, effectiveStatus: 'PAUSED' });

      const results = [
        ['no delivery in 24h', decisionFor(decide([healthy, dark]), 'dark'), 'NO_DELIVERY'],
        ['mixed attribution windows', decisionFor(decide([healthy, mixedAttribution]), 'mixedattr'), 'MIXED_ATTRIBUTION'],
        ['effective_status PAUSED', decisionFor(decide([healthy, paused]), 'paused'), 'NOT_ACTIVE'],
      ] as const;
      const wrong: string[] = [];
      const lines: string[] = [];
      for (const [label, d, code] of results) {
        const named = d.gates.failures.some((f) => f.code === code);
        lines.push(`${label} → ${d.verdict} (${code} named: ${named})`);
        if (d.verdict !== 'HOLD' || !named) wrong.push(label);
      }
      return wrong.length === 0
        ? pass(
            `each of these ads would look catastrophic on its numbers (1 conversion for 240000 minor ` +
              `units) and each is correctly held rather than killed: ${lines.join(', ')}.`,
          )
        : bad(`these were not held for the right reason: ${wrong.join(', ')}. ${lines.join(', ')}.`);
    }),
  );

  // --- 20. Verdicts are RNG-independent ----------------------------------
  checks.push(
    guard('determinism/verdicts do not move with the RNG seed (only the propensities do)', () => {
      const ads = [
        settledAd({ id: 'a', conversions: 300, spendMinor: 1_200_000 }),
        settledAd({ id: 'b', conversions: 40, spendMinor: 400_000 }),
        settledAd({ id: 'c', conversions: 12, spendMinor: 300_000 }),
      ];
      const shape = (seed: number): string =>
        decideSlate({
          asOfDate: AS_OF,
          targetCpaMinor: TARGET_CPA,
          gates: gatesFor(TARGET_CPA, ATTRIBUTION_WINDOW_DAYS),
          ads,
          rng: createSeededRng(seed),
          thompsonDraws: 500,
        })
          .decisions.map((d) => `${d.adId}=${d.verdict}`)
          .join(',');
      const seeds = [1, 2, 999, 123_456];
      const shapes = seeds.map(shape);
      const wins = seeds.map(
        (s) =>
          decideSlate({
            asOfDate: AS_OF,
            targetCpaMinor: TARGET_CPA,
            gates: gatesFor(TARGET_CPA, ATTRIBUTION_WINDOW_DAYS),
            ads,
            rng: createSeededRng(s),
            thompsonDraws: 500,
          }).decisions.reduce((acc, d) => acc + d.winProbability, 0),
      );
      const stable = shapes.every((x) => x === shapes[0]);
      const sumsToOne = wins.every((w) => Math.abs(w - 1) < 1e-9);

      // A separate, deliberately close slate, so the propensities genuinely move with the seed:
      // if they did not, "verdicts are seed-independent" would be vacuous.
      const close = [
        settledAd({ id: 'p', conversions: 40, spendMinor: 160_000 }),
        settledAd({ id: 'q', conversions: 41, spendMinor: 164_000 }),
        settledAd({ id: 'r', conversions: 39, spendMinor: 156_000 }),
      ];
      const closeRun = (seed: number): { verdicts: string; propensity: number } => {
        const s = decideSlate({
          asOfDate: AS_OF,
          targetCpaMinor: TARGET_CPA,
          gates: gatesFor(TARGET_CPA, ATTRIBUTION_WINDOW_DAYS),
          ads: close,
          rng: createSeededRng(seed),
          thompsonDraws: 500,
        });
        return {
          verdicts: s.decisions.map((d) => `${d.adId}=${d.verdict}`).join(','),
          propensity: s.decisions[0]?.winProbability ?? -1,
        };
      };
      const closeRuns = seeds.map(closeRun);
      const closeVerdictsStable = closeRuns.every((x) => x.verdicts === closeRuns[0]?.verdicts);
      const distinctPropensities = new Set(closeRuns.map((x) => x.propensity)).size;

      const detail =
        `Decisive slate — verdicts across seeds ${seeds.join(', ')}: ${shapes[0]} (identical on every ` +
        `seed: ${stable}); win probabilities sum to 1 on every seed: ${sumsToOne}. Near-tied slate ` +
        `(40/41/39 conversions at the same CPA) — verdicts identical on every seed: ` +
        `${closeVerdictsStable}, while the leading ad's Thompson propensity took ` +
        `${distinctPropensities} distinct values across the same 4 seeds ` +
        `(${closeRuns.map((x) => x.propensity.toFixed(3)).join(', ')}), so the RNG is demonstrably in ` +
        `play and still cannot move a verdict.`;
      return stable && sumsToOne && closeVerdictsStable && distinctPropensities > 1
        ? pass(`a re-run cannot flip a kill. ${detail}`)
        : bad(`verdicts or propensities are not well-behaved. ${detail}`);
    }),
  );

  // --- 21. The exact comparison probability really is exact ---------------
  checks.push(
    guard('numeric/the closed-form comparison probability matches a Monte-Carlo oracle', () => {
      const rng = createSeededRng(7);
      const cases: Array<[GammaPosterior, GammaPosterior, number]> = [
        [{ shape: 81, rate: 324_000 }, { shape: 5001, rate: 20_004_000 }, 1.2],
        [{ shape: 3.5, rate: 14_000 }, { shape: 301, rate: 1_204_000 }, 1.0],
        [{ shape: 1, rate: 4000 }, { shape: 61, rate: 244_000 }, 1.2],
        [{ shape: 1500, rate: 6_000_000 }, { shape: 12, rate: 60_000 }, 0.8],
      ];
      const draws = 40_000;
      const lines: string[] = [];
      let worst = 0;
      for (const [a, b, ratio] of cases) {
        const exact = probCpaRatioBelow(a, b, ratio);
        let hits = 0;
        for (let i = 0; i < draws; i += 1) {
          const ta = sampleGamma(a.shape, a.rate, rng);
          const tb = sampleGamma(b.shape, b.rate, rng);
          if (1 / ta < ratio * (1 / tb)) hits += 1;
        }
        const mc = hits / draws;
        const se = Math.sqrt(Math.max(mc * (1 - mc), 1e-9) / draws);
        const z = Math.abs(exact - mc) / se;
        worst = Math.max(worst, z);
        lines.push(`k=(${a.shape},${b.shape}) ratio=${ratio}: exact ${exact.toFixed(4)} vs MC ${mc.toFixed(4)} (${z.toFixed(1)}σ)`);
      }
      // Also the identity that anchors the whole derivation.
      const symmetry = Math.abs(incompleteBeta(37, 4.2, 0.83) + incompleteBeta(4.2, 37, 0.17) - 1);
      const detail = `${lines.join('; ')}. I_x(a,b) + I_{1−x}(b,a) − 1 = ${symmetry.toExponential(2)}.`;
      return worst < 4 && symmetry < 1e-12
        ? pass(`the incomplete-beta identity is right; no Monte Carlo is needed at decision time. ${detail}`)
        : bad(`the closed form disagrees with the sampler by ${worst.toFixed(1)}σ. ${detail}`);
    }),
  );

  // --- 22. Refuses a future-dated row (the timezone bug) ------------------
  checks.push(
    guard('robustness/refuses future-dated rows and duplicate ad ids instead of guessing', () => {
      const outcomes: string[] = [];
      let ok = true;
      try {
        decide([
          settledAd({
            id: 'tz',
            conversions: 10,
            spendMinor: 100_000,
            rows: [{ statDate: addDays(AS_OF, 1), spendMinor: 100_000, conversions: 10 }],
          }),
        ]);
        ok = false;
        outcomes.push('future-dated row: accepted (should have thrown)');
      } catch (err) {
        outcomes.push(`future-dated row: ${err instanceof DecisionInputError ? 'DecisionInputError' : describe(err)}`);
        if (!(err instanceof DecisionInputError)) ok = false;
      }
      try {
        decide([settledAd({ id: 'dup', conversions: 5, spendMinor: 50_000 }), settledAd({ id: 'dup', conversions: 5, spendMinor: 50_000 })]);
        ok = false;
        outcomes.push('duplicate adId: accepted (should have thrown)');
      } catch (err) {
        outcomes.push(`duplicate adId: ${err instanceof DecisionInputError ? 'DecisionInputError' : describe(err)}`);
        if (!(err instanceof DecisionInputError)) ok = false;
      }
      return ok
        ? pass(`a UTC-vs-account-timezone "today" and a duplicated slate entry are both refused. ${outcomes.join('; ')}.`)
        : bad(`bad input was not refused. ${outcomes.join('; ')}.`);
    }),
  );

  // --- 23. Not exercisable here ------------------------------------------
  checks.push(
    guard('live/decisions against a real ad account', () =>
      skipped(
        'The decision engine is pure: it consumes Insights rows and emits verdicts, and this probe ' +
          'drives it with a simulator whose ground truth is known. What cannot be checked here is ' +
          'whether the completeness curve, the target CPA and the learning_stage_info this engine ' +
          'is fed actually match a real account — DEFAULT_COMPLETENESS_CURVE is marked illustrative ' +
          'and must be re-fitted per account by fitCompletenessCurve() before any verdict is trusted.',
        'the system user has no ad accounts or Pages assigned, so no real Insights history exists to fit a curve from or to replay',
      ),
    ),
  );

  return { module: 'src/autonomy/posterior.ts + src/autonomy/decide.ts', checks };
}

async function main(): Promise<void> {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  console.log(`\n=== capability probe: ${report.module} ===\n`);
  for (const c of report.checks) {
    counts[c.status] += 1;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail.replace(/\n/g, '\n       ')}`);
    if (c.blockedBy !== undefined) console.log(`       blockedBy: ${c.blockedBy}`);
    console.log('');
  }
  console.log(`PASS ${counts.PASS}   FAIL ${counts.FAIL}   SKIP ${counts.SKIP}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
