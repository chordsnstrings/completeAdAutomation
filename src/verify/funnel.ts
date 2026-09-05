/**
 * Capability probe for `src/funnel/templates.ts` and `src/funnel/audiences.ts`.
 *
 * Not a unit test. The unit tests check the pieces; this drives the module the way the
 * product will — a corpus of realistic advertisers swept across the whole budget range —
 * and asks the one question the module exists to answer:
 *
 *     does it REFUSE to sell a funnel the advertiser's budget cannot populate,
 *     and can it show the arithmetic for the refusal?
 *
 * The arithmetic, from Meta's own pages: an ad set exits the learning phase after about 50
 * optimisation events in a week, so it needs 50/7 x its own cost per event, per day. A
 * ThruPlay ad set at $0.05 needs $0.36/day; a purchase-optimised ad set at a $30 CPA needs
 * $214.29/day on its own. A three-stage funnel that gives the bottom stage 25% of the
 * budget therefore needs $857/day before that stage is a real thing — which is why a
 * $40/day advertiser must be told to run one broad campaign rather than sold a funnel.
 *
 * THREE DEFECTS WERE FOUND BY THIS PROBE AND FIXED. Two of them made the module sell a
 * funnel it should have refused, and one made a refusal incoherent:
 *
 *  1. `minimumRung` never bound for a non-purchase brand. A stage's minimum is written as
 *     an absolute rung ('view_content') because a template is written once and runs for
 *     every archetype — but a lead brand's ladder is ['lead', 'landing_page_view'], where
 *     `indexOf('view_content')` is -1, so the "is this stage below the rung at which it
 *     still does its job?" test quietly answered no at every budget. A $60/day lead brand
 *     was told to build a "Recapture" ad set optimising for landing page views: the exact
 *     structure the module's own documentation calls "not a recapture ad set, it is a
 *     second traffic ad set competing with the prospecting one for the same auctions".
 *     `effectiveMinimumRung` now maps the declared minimum onto the brand's own ladder
 *     (the templates' doc comment already named this function; it had never been written).
 *
 *  2. `impliedTotalDailyMajor` was computed from the too-cheap rung a stage was about to
 *     be degraded to rather than from the rung at which it still does its job. Broad +
 *     Recapture refused a $60/day budget while reporting that it needed $38.07/day — a
 *     refusal a UI cannot render and a user cannot act on. A stage is now held AT its
 *     minimum rung and every figure is stated there, so `requiredDailyMajor` is now
 *     provably greater than the budget on every refusal (checked below across ~450 cases).
 *
 *  3. A `one_cheaper` stage was pinned to exactly one rung below the main campaign and
 *     never allowed to ladder further, though stepping down is Meta's own documented
 *     remedy for a learning-limited ad set. Because the mid-funnel benchmarks are absolute
 *     ($8 add-to-cart) while the top rung is the brand's own CPA, a brand with an $8
 *     purchase CPA had a recapture stage declared unaffordable at $300/day when the rung
 *     at which it still does its job costs $14.29/day of the $45 that stage holds.
 *
 * Sources: docs/research/funnel-strategy.md (§5.1 the learning floor and the CPE table,
 * §5.2 the pool-size floor, §5.3 the two floors together, §6.3 the exclusion table, §10
 * the five templates, §10.1 the selection function) and docs/research/funnel-video-lookalike.md
 * (§2-§4 audience rule grammar, §6 lookalike_spec, §7 seed minima and status polling).
 *
 * Run standalone:
 *   node --experimental-strip-types src/verify/funnel.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConversionArchetype } from '../meta/objectives.ts';
import { validateSpec } from '../meta/objectives.ts';
import {
  AUDIENCE_POOLS,
  FUNNEL_TEMPLATES,
  FUNNEL_TEMPLATE_IDS,
  LEARNING_DAILY_MULTIPLE,
  LEARNING_PHASE_EVENTS_PER_WEEK,
  PROSPECTING_ROLES,
  PURCHASER_POOLS,
  RETARGETING_ROLES,
  WARM_POOLS,
  assessFunnelBudget,
  costPerEventMajor,
  effectiveMinimumRung,
  forecastVideoPool,
  ladderFor,
  learningFloorDailyMajor,
  recommendFunnel,
  resolveEasyOptions,
  resolveStageSpec,
  validateTemplate,
  type FunnelBudgetAssessment,
  type FunnelInputs,
  type FunnelTemplateId,
} from '../funnel/templates.ts';
import {
  AUDIENCE_DELIVERY_FLOOR,
  LOOKALIKE_HARD_MIN_SEED,
  LOOKALIKE_QUALITY_MIN_SEED,
  MAX_VIDEOS_PER_VIDEO_AUDIENCE,
  buildLookalikeAudienceRequest,
  buildPageEngagementAudienceRequest,
  buildVideoViewAudienceRequests,
  checkLookalikeSeed,
  classifyAudienceReadiness,
} from '../funnel/audiences.ts';

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  /** Set when the check could not run for an environmental reason rather than a code fault. */
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

class SkipSignal extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, detail: string) {
    super(detail);
    this.name = 'SkipSignal';
    this.blockedBy = blockedBy;
  }
}

function skip(blockedBy: string, detail: string): never {
  throw new SkipSignal(blockedBy, detail);
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function money(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// The corpus — advertisers a human would recognise, not fixtures
// ---------------------------------------------------------------------------

interface Advertiser {
  id: string;
  what: string;
  archetype: ConversionArchetype;
  targetCpaMajor: number;
  purchasesLast180d: number;
  warmPoolSize: number;
  hasCustomerList: boolean;
  valueSpreadMaterial?: boolean;
}

const ADVERTISERS: readonly Advertiser[] = [
  {
    id: 'first-timer',
    what: 'a new Shopify skincare brand, no pixel history at all',
    archetype: 'website_purchase',
    targetCpaMajor: 25,
    purchasesLast180d: 0,
    warmPoolSize: 0,
    hasCustomerList: false,
  },
  {
    id: 'small-dtc',
    what: 'an established candle shop, $30 CPA, a real warm pool',
    archetype: 'website_purchase',
    targetCpaMajor: 30,
    purchasesLast180d: 400,
    warmPoolSize: 22_000,
    hasCustomerList: false,
  },
  {
    id: 'cheap-conversion',
    what: 'a low-ticket digital product, $8 CPA',
    archetype: 'website_purchase',
    targetCpaMajor: 8,
    purchasesLast180d: 2_000,
    warmPoolSize: 40_000,
    hasCustomerList: false,
  },
  {
    id: 'high-ticket',
    what: 'a $2,400 sofa, $120 CPA — the case where the arithmetic is brutal',
    archetype: 'website_purchase',
    targetCpaMajor: 120,
    purchasesLast180d: 300,
    warmPoolSize: 18_000,
    hasCustomerList: true,
    valueSpreadMaterial: true,
  },
  {
    id: 'local-installer',
    what: 'a window fitter buying website-form leads at $20',
    archetype: 'website_lead',
    targetCpaMajor: 20,
    purchasesLast180d: 150,
    warmPoolSize: 6_000,
    hasCustomerList: false,
  },
  {
    id: 'instant-form',
    what: 'a driving school buying instant-form leads at $6',
    archetype: 'instant_form_lead',
    targetCpaMajor: 6,
    purchasesLast180d: 900,
    warmPoolSize: 12_000,
    hasCustomerList: false,
  },
  {
    id: 'app',
    what: 'a meditation app buying installs at $3',
    archetype: 'app_install',
    targetCpaMajor: 3,
    purchasesLast180d: 5_000,
    warmPoolSize: 30_000,
    hasCustomerList: false,
  },
  {
    id: 'publisher',
    what: 'a media site buying landing page views',
    archetype: 'traffic',
    targetCpaMajor: 0.8,
    purchasesLast180d: 0,
    warmPoolSize: 90_000,
    hasCustomerList: true,
  },
];

const BUDGETS: readonly number[] = [5, 10, 20, 30, 40, 60, 100, 150, 250, 400, 600, 900, 1500, 3000];

const ALL_ARCHETYPES: readonly ConversionArchetype[] = [
  'website_purchase',
  'website_lead',
  'instant_form_lead',
  'messenger_lead',
  'whatsapp_conversation',
  'phone_call',
  'catalog_sales',
  'traffic',
  'app_install',
];

function inputsFor(a: Advertiser, budget: number): FunnelInputs {
  return {
    dailyBudgetMajor: budget,
    archetype: a.archetype,
    targetCpaMajor: a.targetCpaMajor,
    purchasesLast180d: a.purchasesLast180d,
    warmPoolSize: a.warmPoolSize,
    hasCustomerList: a.hasCustomerList,
    ...(a.valueSpreadMaterial !== undefined ? { valueSpreadMaterial: a.valueSpreadMaterial } : {}),
  };
}

/** Every (template, advertiser, budget) assessment. ~560 of them. */
function sweep(): Array<{ id: FunnelTemplateId; advertiser: Advertiser; budget: number; a: FunnelBudgetAssessment }> {
  const out: Array<{ id: FunnelTemplateId; advertiser: Advertiser; budget: number; a: FunnelBudgetAssessment }> = [];
  for (const id of FUNNEL_TEMPLATE_IDS) {
    for (const advertiser of ADVERTISERS) {
      for (const budget of BUDGETS) {
        out.push({
          id,
          advertiser,
          budget,
          a: assessFunnelBudget(id, {
            dailyBudgetMajor: budget,
            archetype: advertiser.archetype,
            targetCpaMajor: advertiser.targetCpaMajor,
          }),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];

  const check = async (name: string, fn: () => string | Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS', detail });
    } catch (e) {
      if (e instanceof SkipSignal) {
        checks.push({ name, status: 'SKIP', detail: e.message, blockedBy: e.blockedBy });
        return;
      }
      checks.push({ name, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  // -------------------------------------------------------------------------
  // 1. THE behaviour: a small budget gets one broad campaign, with the arithmetic
  // -------------------------------------------------------------------------

  await check('a $40/day advertiser is refused a funnel and shown the arithmetic', () => {
    const small = ADVERTISERS.find((x) => x.id === 'small-dtc');
    must(small !== undefined, 'corpus is missing small-dtc');
    const r = recommendFunnel(inputsFor(small, 40));

    must(
      r.templateId === 'single_engine',
      `a $40/day advertiser was recommended ${r.templateId}, not one broad campaign`,
    );
    must(r.template.stages.length === 1, 'the recommendation must be a single ad set');
    must(r.assessment.verdict === 'build', 'the recommended structure must itself be buildable');

    // The refusal that got it here has to carry the working, not just a verdict.
    const refused = assessFunnelBudget('broad_plus_recapture', {
      dailyBudgetMajor: 40,
      archetype: small.archetype,
      targetCpaMajor: small.targetCpaMajor,
    });
    must(refused.verdict === 'refuse', 'Broad + Recapture should be refused at $40/day');
    const stage = refused.stages.find((s) => s.stageId === refused.bindingStageId);
    must(stage !== undefined, 'a refusal must name its binding stage');
    must(stage.eventsNeededPerWeek === LEARNING_PHASE_EVENTS_PER_WEEK, 'events needed must be the 50 Meta states');
    must(stage.eventsAffordablePerWeek !== undefined, 'events affordable must be computed');
    must(
      stage.eventsAffordablePerWeek < LEARNING_PHASE_EVENTS_PER_WEEK,
      'the binding stage must be the one that cannot buy 50 events',
    );
    must(refused.requiredDailyMajor > 40, 'a refusal must state a total that exceeds the budget');
    must(refused.fallbackTemplateId === 'single_engine', 'the fallback must be the single broad campaign');
    must(
      refused.explanation.some((l) => l.includes('Recommendation: Single Engine')),
      'the explanation must end in a recommendation a non-expert can act on',
    );

    return (
      `$40/day, $30 CPA -> ${r.templateId}. ` +
      `Broad + Recapture refused: "${stage.label}" holds ${money(stage.stageDailyMajor)}/day, which buys ` +
      `${stage.eventsAffordablePerWeek} ${stage.rungLabel} events a week against the ` +
      `${LEARNING_PHASE_EVENTS_PER_WEEK} it needs; that stage needs ${money(stage.stageFloorDailyMajor ?? 0)}/day ` +
      `of its own, so the template needs ${money(refused.requiredDailyMajor)}/day in total — ` +
      `${money(refused.shortfallDailyMajor)}/day short.`
    );
  });

  await check('every advertiser in the corpus is told the truth at every budget', () => {
    const lines: string[] = [];
    for (const a of ADVERTISERS) {
      const picks = BUDGETS.map((b) => {
        const r = recommendFunnel(inputsFor(a, b));
        must(
          r.assessment.verdict === 'build' || r.assessment.fallbackTemplateId === undefined,
          `${a.id} @ ${money(b)}: refused ${r.templateId} but a simpler structure existed and was not taken`,
        );
        return { b, id: r.templateId, stages: r.template.stages.length, verdict: r.assessment.verdict };
      });

      // Complexity must never fall as the budget rises: a user whose budget goes up must not
      // be moved to a simpler structure, and a user whose budget goes down must be.
      for (let i = 1; i < picks.length; i += 1) {
        const prev = picks[i - 1];
        const cur = picks[i];
        must(prev !== undefined && cur !== undefined, 'sweep bookkeeping');
        must(
          cur.stages >= prev.stages,
          `${a.id}: ${money(prev.b)}/day gets ${prev.stages} stage(s) but ${money(cur.b)}/day gets ${cur.stages}`,
        );
      }
      const first = picks.find((p) => p.stages > 1);
      lines.push(
        `${a.id} (${a.what}): one campaign until ` +
          (first === undefined ? 'every budget tested' : `${money(first.b)}/day, then ${first.id}`),
      );
    }
    return lines.join('\n');
  });

  await check('no refusal is incoherent: a refused template always needs more than the budget', () => {
    const cases = sweep();
    const bad: string[] = [];
    for (const { id, advertiser, budget, a } of cases) {
      if (a.verdict === 'refuse') {
        if (!(a.requiredDailyMajor > a.dailyBudgetMajor)) {
          bad.push(
            `${id}/${advertiser.id} @ ${money(budget)}: refused but reports it needs ` +
              `${money(a.requiredDailyMajor)}/day`,
          );
        }
        if (a.failingStageIds.length === 0) bad.push(`${id}/${advertiser.id} @ ${money(budget)}: refused, no stage named`);
      } else {
        for (const s of a.stages) {
          if (!s.exitsLearning) bad.push(`${id}/${advertiser.id} @ ${money(budget)}: built with ${s.stageId} learning-limited`);
        }
      }
    }
    must(bad.length === 0, `${bad.length} incoherent verdicts, e.g.\n  ${bad.slice(0, 4).join('\n  ')}`);
    const refusals = cases.filter((c) => c.a.verdict === 'refuse').length;
    return (
      `${cases.length} (template x advertiser x budget) assessments: ${refusals} refusals, ` +
      `${cases.length - refusals} builds. Every refusal names a failing stage and a total above the budget; ` +
      `every build has all stages clear of the learning floor.`
    );
  });

  await check('no stage is ever delivered below the rung at which it stops doing its job', () => {
    const bad: string[] = [];
    for (const { id, advertiser, budget, a } of sweep()) {
      for (const s of a.stages) {
        const ladder = ladderFor(advertiser.archetype);
        const expected = effectiveMinimumRung(s.declaredMinimumRung, ladder);
        if (s.minimumRung !== expected) {
          bad.push(`${id}/${s.stageId} (${advertiser.archetype}): minimum resolved to ${s.minimumRung}, not ${expected}`);
          continue;
        }
        const rungIndex = ladder.indexOf(s.rung);
        const minIndex = ladder.indexOf(s.minimumRung);
        if (rungIndex >= 0 && minIndex >= 0 && rungIndex > minIndex) {
          bad.push(
            `${id}/${s.stageId} (${advertiser.id} @ ${money(budget)}): reported at ${s.rung}, below its ` +
              `minimum of ${s.minimumRung}`,
          );
        }
        // Held at its minimum and still short of the floor => it must be a refusal, not a build.
        if (s.belowMinimum && !s.exitsLearning) {
          must(a.verdict === 'refuse', `${id}/${s.stageId} @ ${money(budget)}: degraded and unfunded, yet built`);
          must(s.problem !== undefined, `${id}/${s.stageId}: degraded and unfunded with no explanation`);
        }
      }
    }
    must(bad.length === 0, `${bad.length} stages below their minimum, e.g.\n  ${bad.slice(0, 4).join('\n  ')}`);

    // The case that used to slip through entirely.
    const lead = assessFunnelBudget('broad_plus_recapture', {
      dailyBudgetMajor: 60,
      archetype: 'website_lead',
      targetCpaMajor: 20,
    });
    const recapture = lead.stages.find((s) => s.stageId === 'recapture');
    must(recapture !== undefined, 'no recapture stage');
    must(recapture.minimumRung === 'lead', `a lead brand's recapture minimum resolved to ${recapture.minimumRung}`);
    must(lead.verdict === 'refuse', 'a $60/day lead brand must not be sold a recapture stage');
    return (
      `all stages across the sweep sit at or above their minimum rung. A website-lead brand at $60/day is ` +
      `refused Broad + Recapture (needs ${money(lead.requiredDailyMajor)}/day) rather than being given a ` +
      `"Recapture" ad set optimising for landing page views.`
    );
  });

  await check('a refusal is never avoidable: no stage is refused at a rung it was allowed to leave', () => {
    // The other direction of the same honesty. Refusing a funnel that WOULD have worked is a
    // failure too — it sends the advertiser to a simpler structure for no reason. Stepping down
    // the ladder is Meta's own remedy for a learning-limited ad set, so a stage may only be
    // refused once every rung between the one it prefers and the one below which it stops being
    // that stage has been tried and none of them fits its share of the budget.
    const bad: string[] = [];
    let refusedStages = 0;
    for (const { id, advertiser, budget, a } of sweep()) {
      const input = {
        dailyBudgetMajor: budget,
        archetype: advertiser.archetype,
        targetCpaMajor: advertiser.targetCpaMajor,
      };
      const ladder = ladderFor(advertiser.archetype);
      for (const s of a.stages) {
        if (s.problem === undefined) continue;
        refusedStages += 1;
        const from = Math.max(0, ladder.indexOf(s.preferredRung));
        const to = ladder.indexOf(s.minimumRung);
        if (to < 0) continue;
        for (let i = from; i <= to; i += 1) {
          const rung = ladder[i];
          if (rung === undefined) continue;
          const floor = learningFloorDailyMajor(rung, input);
          if (floor !== undefined && s.stageDailyMajor >= floor) {
            bad.push(
              `${id}/${s.stageId} (${advertiser.id} @ ${money(budget)}) was refused at ${s.rung}, but ` +
                `${rung} costs ${money(costPerEventMajor(rung, input) ?? 0)} and needs ${money(floor)}/day — ` +
                `the stage holds ${money(s.stageDailyMajor)}/day and ${rung} is at or above its minimum ` +
                `(${s.minimumRung})`,
            );
          }
        }
      }
    }
    must(bad.length === 0, `${bad.length} avoidable refusals, e.g.\n  ${bad.slice(0, 4).join('\n  ')}`);
    return (
      `${refusedStages} refused stages across the sweep, and for every one of them no rung between its ` +
      `preferred rung and its minimum could be paid for out of its share of the budget. The refusals are ` +
      `forced, not lazy.`
    );
  });

  await check('the three-stage funnel is gated by the stage that makes the money', () => {
    const rows: string[] = [];
    for (const cpa of [10, 20, 30, 40]) {
      const floor = LEARNING_DAILY_MULTIPLE * cpa;
      const bofShare = 0.25;
      const expected = Math.round((floor / bofShare) * 100) / 100;
      const at = (b: number): FunnelBudgetAssessment =>
        assessFunnelBudget('full_three_stage', { dailyBudgetMajor: b, archetype: 'website_purchase', targetCpaMajor: cpa });

      const below = at(Math.floor(expected) - 1);
      const above = at(Math.ceil(expected) + 1);
      must(below.verdict === 'refuse', `$${cpa} CPA: three-stage built at ${money(expected)}/day - 1`);
      must(below.bindingStageId === 'bof', `$${cpa} CPA: the binding stage should be the bottom one`);
      must(above.verdict === 'build', `$${cpa} CPA: three-stage still refused at ${money(expected)}/day + 1`);
      must(
        Math.abs(below.requiredDailyMajor - expected) < 0.05,
        `$${cpa} CPA: required ${money(below.requiredDailyMajor)} != 50/7 x ${cpa} / 0.25 = ${money(expected)}`,
      );
      rows.push(`$${cpa} CPA -> bottom stage needs ${money(floor)}/day at 25% share = ${money(expected)}/day total`);
    }
    // The declared playbook figure is $500/day; the arithmetic disagrees for every CPA above ~$17.5.
    const at500 = assessFunnelBudget('full_three_stage', {
      dailyBudgetMajor: 500,
      archetype: 'website_purchase',
      targetCpaMajor: 30,
    });
    must(at500.verdict === 'refuse', 'the $500 playbook figure should not override the arithmetic');
    must(
      at500.explanation.some((l) => l.includes('playbook figure')),
      'a disagreement with the playbook figure must be surfaced, not hidden',
    );
    return rows.join('\n');
  });

  await check('the easy-options surface produces a publishable plan or a refusal, never a silent bad plan', () => {
    const rows: string[] = [];
    for (const budgetMinor of [500, 4_000, 15_000, 30_000, 90_000]) {
      const plan = resolveEasyOptions({
        goal: 'sales',
        dailyBudgetMinor: budgetMinor,
        currency: 'USD',
        targetCpaMinor: 3_000,
        assets: 'website_traffic',
        warmPoolSize: 22_000,
        purchasesLast180d: 400,
      });
      const total = plan.stages.reduce((acc, s) => acc + s.dailyBudgetMinor, 0);
      must(total === budgetMinor, `budget split lost money: ${total} != ${budgetMinor}`);
      for (const s of plan.stages) {
        validateSpec(s.spec);
        must(s.dailyBudgetMinor > 0, `${plan.templateId}/${s.stage.id} was allocated nothing`);
        if (s.stage.target.length > 0) {
          must(
            s.stage.advantageAudience === 0,
            `${plan.templateId}/${s.stage.id}: a hard inclusion under Advantage+ audience is not a boundary`,
          );
        }
      }
      must(
        (plan.refusal === undefined) === (plan.assessment.verdict === 'build'),
        'refusal and verdict disagree',
      );
      rows.push(
        `${money(budgetMinor / 100)}/day -> ${plan.templateId} ` +
          `(${plan.stages.map((s) => `${s.stage.id} ${money(s.dailyBudgetMinor / 100)}`).join(', ')})` +
          (plan.refusal !== undefined ? ' REFUSED' : ''),
      );
    }
    return rows.join('\n');
  });

  // -------------------------------------------------------------------------
  // 2. Structure: the templates themselves
  // -------------------------------------------------------------------------

  await check('every template is structurally sound and resolves to legal ODAX tuples', () => {
    const problems: string[] = [];
    for (const id of FUNNEL_TEMPLATE_IDS) problems.push(...validateTemplate(FUNNEL_TEMPLATES[id]));
    must(problems.length === 0, `structural problems:\n  ${problems.join('\n  ')}`);

    let tuples = 0;
    for (const archetype of ALL_ARCHETYPES) {
      for (const id of FUNNEL_TEMPLATE_IDS) {
        for (const stage of FUNNEL_TEMPLATES[id].stages) {
          const spec = resolveStageSpec(stage, archetype);
          validateSpec(spec);
          if (stage.optimisation !== undefined) {
            must(
              spec.destinationType === undefined,
              `${id}/${stage.id} (${archetype}) inherited destination_type ${String(spec.destinationType)} into ` +
                `${spec.objective}, which Meta rejects as a generic code 100`,
            );
          }
          tuples += 1;
        }
      }
    }
    return `${FUNNEL_TEMPLATE_IDS.length} templates pass every structural rule; ${tuples} (stage x archetype) tuples are legal.`;
  });

  await check('exclusions are what the research says they must be, in every template', () => {
    const notes: string[] = [];
    for (const id of FUNNEL_TEMPLATE_IDS) {
      for (const stage of FUNNEL_TEMPLATES[id].stages) {
        const where = `${id}/${stage.id}`;
        if (PROSPECTING_ROLES.has(stage.role)) {
          const warm = stage.exclude.filter((p) => WARM_POOLS.has(p));
          must(warm.length === 0, `${where} excludes warm pool(s) ${warm.join(', ')} from prospecting`);
        }
        if (RETARGETING_ROLES.has(stage.role)) {
          must(stage.exclude.some((p) => PURCHASER_POOLS.has(p)), `${where} retargets without excluding purchasers`);
        }
        if (stage.role === 'mof') {
          must(stage.exclude.includes('site_visitors_30d'), `${where} would double-count with the bottom stage`);
        }
        for (const pool of stage.target) {
          must(!stage.exclude.includes(pool), `${where} both targets and excludes ${pool}`);
        }
      }
      notes.push(
        `${id}: ${FUNNEL_TEMPLATES[id].stages
          .map((s) => `${s.id}[-${s.exclude.length > 0 ? s.exclude.join(',-') : 'nothing'}]`)
          .join(' ')}`,
      );
    }
    // MOF must exclude exactly what BOF targets, or both stages claim the same conversions.
    const three = FUNNEL_TEMPLATES.full_three_stage;
    const bofTargets = three.stages.find((s) => s.id === 'bof')?.target ?? [];
    const mofExcludes = three.stages.find((s) => s.id === 'mof')?.exclude ?? [];
    must(
      bofTargets.some((p) => mofExcludes.includes(p)),
      'the middle stage does not exclude what the bottom stage targets',
    );
    return notes.join('\n');
  });

  // -------------------------------------------------------------------------
  // 3. Audiences: the other floor, and the refusals
  // -------------------------------------------------------------------------

  await check('a lookalike is refused for an undersized seed, at both floors', () => {
    const seeds = [0, 60, 99, 100, 300, 999, 1000, 5000];
    const graded = seeds.map((n) => `${n}:${checkLookalikeSeed(n, { country: 'US' }).verdict}`);
    must(checkLookalikeSeed(99).verdict === 'too_small', '99 is below Meta\'s hard floor');
    must(checkLookalikeSeed(100).verdict === 'warming', '100 clears the hard floor but not the quality floor');
    must(checkLookalikeSeed(LOOKALIKE_QUALITY_MIN_SEED).verdict === 'ok', 'the quality floor should be inclusive');

    const base = {
      adAccountId: 'act_1234567890',
      name: 'LAL 3% US - purchasers 180d',
      seedAudienceId: '900100',
      country: 'US',
      ratio: 0.03,
    };
    let refusals = 0;
    for (const seedSize of [0, 60, 300, 999]) {
      try {
        buildLookalikeAudienceRequest({ ...base, seedSize });
        must(false, `a ${seedSize}-person seed built a lookalike`);
      } catch (e) {
        must(e instanceof Error && /origin_audience_id/.test(e.message), `unexpected error for seed ${seedSize}`);
        refusals += 1;
      }
    }
    try {
      buildLookalikeAudienceRequest(base);
      must(false, 'a lookalike built with no seed size at all');
    } catch (e) {
      must(e instanceof Error && /seedSize is required/.test(e.message), 'building blind must be refused by name');
    }
    const ok = buildLookalikeAudienceRequest({ ...base, seedSize: 5_000 });
    const spec = JSON.parse(ok.params['lookalike_spec'] ?? '{}') as Record<string, unknown>;
    must(ok.params['subtype'] === 'LOOKALIKE', 'subtype=LOOKALIKE is required for a lookalike');
    must(ok.params['origin_audience_id'] === '900100', 'the seed goes in origin_audience_id');
    must(spec['ratio'] === 0.03 && spec['country'] === 'US', 'lookalike_spec must carry ratio and country');
    must(ok.params['rule'] === undefined && ok.params['prefill'] === undefined, 'lookalikes take no rule and no prefill');

    return (
      `seed grading ${graded.join(' ')} (hard floor ${LOOKALIKE_HARD_MIN_SEED} per target country, quality ` +
      `floor ${LOOKALIKE_QUALITY_MIN_SEED}); ${refusals} undersized seeds refused, and a blind build refused ` +
      `by name. A 5,000-person seed builds ${JSON.stringify(ok.params['lookalike_spec'])}.`
    );
  });

  await check('the pool forecast agrees with the budget at which a warm stage is offered', () => {
    // A recapture stage needs ~1,000 people. The forecast says how long a given video budget
    // takes to get there, so the system can decline the stage before spending, not after.
    const rows: string[] = [];
    for (const daily of [5, 10, 20, 50]) {
      const f = forecastVideoPool({ dailyBudgetMajor: daily, days: 30, threshold: 'p75' });
      rows.push(
        `${money(daily)}/day of video for 30 days -> ~${f.uniquePeople} people at 75% watched ` +
          `(${f.meetsFloor ? 'clears' : `${f.floor - f.uniquePeople} short of`} the ${f.floor} floor; ` +
          `${f.daysToFloor} days needed)`,
      );
    }
    const thin = forecastVideoPool({ dailyBudgetMajor: 5, days: 30, threshold: 'p50' });
    must(!thin.meetsFloor, '$5/day for 30 days should NOT reach a 1,000-person 50% pool');
    const ten = forecastVideoPool({ dailyBudgetMajor: 10, days: 30, threshold: 'p50' });
    must(ten.meetsFloor, '$10/day for 30 days should reach it — this is the research\'s operational threshold');

    // And the selection function must not offer a recapture stage to an account without the pool.
    const noPool = recommendFunnel({
      dailyBudgetMajor: 400,
      archetype: 'website_purchase',
      targetCpaMajor: 8,
      purchasesLast180d: 900,
      warmPoolSize: AUDIENCE_DELIVERY_FLOOR - 1,
      hasCustomerList: false,
    });
    must(noPool.template.stages.length === 1, `a 999-person warm pool still bought ${noPool.templateId}`);
    return `${rows.join('\n')}\nA ${AUDIENCE_DELIVERY_FLOOR - 1}-person warm pool at $400/day still gets one campaign.`;
  });

  await check('audience requests carry the documented field names, not invented ones', () => {
    const video = buildVideoViewAudienceRequests({
      adAccountId: 'act_1234567890',
      name: 'VV75 acme 90d',
      pageId: '111222333',
      videoIds: Array.from({ length: 250 }, (_, i) => String(70_000 + i)),
      threshold: 'p75',
      retentionDays: 90,
    });
    must(video.length === 2, `250 videos should chunk into 2 audiences, got ${video.length}`);
    const first = video[0];
    must(first !== undefined, 'no video request built');
    must(first.params['subtype'] === 'ENGAGEMENT', 'video is the documented exception that keeps subtype');
    must(first.params['retention_days'] === '90', 'video retention rides at the top level, not in the rule');
    const rule = JSON.parse(first.params['rule'] ?? 'null') as unknown;
    must(Array.isArray(rule), 'the video rule is a bare array, not an {inclusions} object');
    must(rule.length === MAX_VIDEOS_PER_VIDEO_AUDIENCE, 'chunks must fill to the cap');
    const entry = rule[0] as Record<string, string>;
    must(entry['event_name'] === 'video_view_75_percent', `event_name was ${String(entry['event_name'])}`);
    must(entry['context_id'] === '111222333', 'context_id is the PAGE that published the video');
    must(first.unverified.length >= 3, 'the video shape is reconstructed and must say so');

    const page = buildPageEngagementAudienceRequest({
      adAccountId: 'act_1234567890',
      name: 'Page engagers 30d',
      sourceIds: ['111222333'],
      retentionDays: 30,
      events: ['page_engaged'],
    });
    must(page.params['subtype'] === undefined, 'subtype is deprecated for non-video engagement audiences');
    const pageRule = JSON.parse(page.params['rule'] ?? '{}') as {
      inclusions?: { rules?: Array<{ retention_seconds?: number; event_sources?: Array<{ type?: string }> }> };
    };
    const inner = pageRule.inclusions?.rules?.[0];
    must(inner?.retention_seconds === 30 * 86_400, 'page audiences carry retention in the rule, in seconds');
    must(inner?.event_sources?.[0]?.type === 'page', 'event_sources[].type must be "page"');

    return (
      `video: bare-array rule, subtype=ENGAGEMENT, top-level retention_days, context_id=<page>, chunked at ` +
      `${MAX_VIDEOS_PER_VIDEO_AUDIENCE}. page: event_sources grammar, retention_seconds, no subtype. Every ` +
      `video request carries ${first.unverified.length} explicit unverified claims for read-back.`
    );
  });

  await check('an audience that cannot deliver is never reported ready', () => {
    const cases: Array<[string, ReturnType<typeof classifyAudienceReadiness>]> = [
      ['too small (delivery 300)', classifyAudienceReadiness({ id: '1', operation_status: { code: 200 }, delivery_status: { code: 300 }, approximate_count_lower_bound: 420 })],
      ['under the floor', classifyAudienceReadiness({ id: '1', operation_status: { code: 200 }, delivery_status: { code: 200 }, approximate_count_lower_bound: 700 })],
      ['still building (441)', classifyAudienceReadiness({ id: '1', operation_status: { code: 441 } })],
      ['lookalike build failed (432)', classifyAudienceReadiness({ id: '1', operation_status: { code: 432 } })],
      ['integrity flag (471)', classifyAudienceReadiness({ id: '1', operation_status: { code: 471 } })],
      ['count absent', classifyAudienceReadiness({ id: '1', operation_status: { code: 200 }, delivery_status: { code: 200 } })],
      ['undocumented status', classifyAudienceReadiness({ id: '1', operation_status: { code: 999 }, delivery_status: { code: 200 }, approximate_count_lower_bound: 9000 })],
    ];
    for (const [label, r] of cases) {
      must(r.verdict !== 'ready', `${label} was reported ready`);
    }
    const ready = classifyAudienceReadiness({
      id: '1',
      operation_status: { code: 200 },
      delivery_status: { code: 200 },
      approximate_count_lower_bound: 4_200,
    });
    must(ready.verdict === 'ready', 'a healthy audience must be usable');
    const exclusionOnly = classifyAudienceReadiness(
      { id: '1', operation_status: { code: 200 }, delivery_status: { code: 200 }, approximate_count_lower_bound: 12 },
      { qualityFloor: 0 },
    );
    must(exclusionOnly.verdict === 'ready', 'an exclusion has no size floor and must not be blocked');
    return `${cases.length} unusable states all withheld (${cases.map(([l, r]) => `${l}=${r.verdict}`).join(', ')}); healthy=ready; exclusion-only at 12 people=ready.`;
  });

  await check('every pool a template asks for is one the audience layer can actually build', () => {
    const rows: string[] = [];
    for (const id of FUNNEL_TEMPLATE_IDS) {
      for (const poolId of FUNNEL_TEMPLATES[id].audiences) {
        const pool = AUDIENCE_POOLS[poolId];
        must(pool !== undefined, `${id} declares unknown pool ${poolId}`);
        if (pool.kind === 'video') {
          must(pool.retentionDays <= 365, `${poolId}: ${pool.retentionDays} days exceeds the video ceiling`);
          must(pool.undocumentedRule, `${poolId} is a video pool and must be flagged as undocumented`);
        }
        if (pool.kind === 'website') {
          must(pool.retentionDays <= 180, `${poolId}: ${pool.retentionDays} days exceeds the website ceiling`);
        }
        if (pool.kind === 'engagement') {
          must(pool.retentionDays <= 90, `${poolId}: lead-ads engagement is capped at 90 days`);
        }
      }
      const undocumented = FUNNEL_TEMPLATES[id].audiences.filter((p) => AUDIENCE_POOLS[p].undocumentedRule);
      rows.push(
        `${id}: ${FUNNEL_TEMPLATES[id].audiences.length} pool(s)` +
          (undocumented.length > 0 ? `, ${undocumented.length} depending on the undocumented video rule` : ''),
      );
    }
    const dependent = FUNNEL_TEMPLATE_IDS.filter((id) =>
      FUNNEL_TEMPLATES[id].audiences.some((p) => AUDIENCE_POOLS[p].undocumentedRule),
    );
    must(
      dependent.length <= 2,
      `${dependent.length} templates depend on the undocumented video rule; the research requires that ` +
        `failure to be contained to as few as possible`,
    );
    return `${rows.join('\n')}\nOnly ${dependent.join(', ')} depend on the undocumented rule; every other template survives its failure.`;
  });

  // -------------------------------------------------------------------------
  // 4. What cannot be settled from here
  // -------------------------------------------------------------------------

  await check('the reconstructed video-audience rule is confirmed by read-back', () => {
    skip(
      'no ad account or Page assigned to the system user, and read-back needs an audience that exists',
      'Meta has REMOVED the video engagement audience documentation, so the bare-array rule shape, the ' +
        'top-level retention_days and subtype=ENGAGEMENT are reconstructed from legacy snippets and ' +
        'third-party read-back. Settling it needs GET /<custom_audience_id>?fields=id,name,subtype,rule,' +
        'retention_days on an audience created by hand in Ads Manager — which needs an ad account this ' +
        'system user does not have. Creating one here would be a POST, which is forbidden. The event_name ' +
        'for the top tier (video_completed vs video_view_95_percent) is settled by the same read-back. ' +
        'Every video request already carries these as explicit `unverified` claims.',
    );
  });

  await check('the tier-1 cost-per-event benchmarks are replaced with this account\'s observed costs', () => {
    skip(
      'no ad account assigned to the system user, so Insights returns nothing to calibrate with',
      'Every floor in this module scales linearly with cost per optimisation event, and the defaults are ' +
        'tier-1 USD benchmarks ($30 purchase, $8 add-to-cart, $2 view content, $0.80 landing page view, ' +
        '$0.05 ThruPlay). They are inputs, not truths: assessFunnelBudget takes cpeOverridesMajor for ' +
        'exactly this, and a non-USD account is already flagged benchmarksApproximate. Until Insights can ' +
        'be read for a real account, the arithmetic is right and the constants are estimates.',
    );
  });

  return { module: 'src/funnel/templates.ts + src/funnel/audiences.ts', checks };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const c of report.checks) {
    counts[c.status] += 1;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail.replace(/\n/gu, '\n       ')}`);
    if (c.blockedBy !== undefined) console.log(`       blocked by: ${c.blockedBy}`);
    console.log('');
  }
  console.log(`${report.module}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}
