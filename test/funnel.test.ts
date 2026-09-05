import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConversionArchetype } from '../src/meta/objectives.ts';
import { validateSpec } from '../src/meta/objectives.ts';
import {
  AUDIENCE_POOLS,
  CONVERSION_LADDER,
  FUNNEL_TEMPLATES,
  FUNNEL_TEMPLATE_IDS,
  FunnelPlanError,
  LEAD_LADDER,
  LEARNING_DAILY_MULTIPLE,
  LEARNING_PHASE_EVENTS_PER_WEEK,
  PROSPECTING_ROLES,
  PURCHASER_POOLS,
  RETARGETING_ROLES,
  TRAFFIC_LADDER,
  WARM_POOLS,
  assessFunnelBudget,
  effectiveMinimumRung,
  exclusionsFor,
  forecastVideoPool,
  ladderFor,
  primaryRungFor,
  recommendFunnel,
  resolveEasyOptions,
  resolveStageSpec,
  splitMinor,
  validateTemplate,
  type FunnelStageTemplate,
  type FunnelTemplate,
  type FunnelTemplateId,
} from '../src/funnel/templates.ts';
import {
  AUDIENCE_DELIVERY_FLOOR,
  AudienceBuildError,
  LOOKALIKE_HARD_MIN_SEED,
  LOOKALIKE_QUALITY_MIN_SEED,
  MAX_VIDEOS_PER_VIDEO_AUDIENCE,
  RETENTION_MAX_DAYS,
  awaitAudienceReady,
  buildIgEngagementAudienceRequest,
  buildLookalikeAudienceRequest,
  buildLookalikeTierRequests,
  buildPageEngagementAudienceRequest,
  buildVideoViewAudienceRequests,
  checkLookalikeSeed,
  checkRetention,
  classifyAudienceReadiness,
  readTosStatus,
  retentionDrift,
  sanitiseAudienceName,
  type AudienceSourceKind,
} from '../src/funnel/audiences.ts';

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

const ACCOUNT = 'act_1234567890';
const PAGE = '111222333';

function everyStage(): Array<{ template: FunnelTemplate; stage: FunnelStageTemplate }> {
  return FUNNEL_TEMPLATE_IDS.flatMap((id) =>
    FUNNEL_TEMPLATES[id].stages.map((stage) => ({ template: FUNNEL_TEMPLATES[id], stage })),
  );
}

// ---------------------------------------------------------------------------
// Template data — the structural invariants
// ---------------------------------------------------------------------------

test('every shipped template satisfies its own structural rules', () => {
  for (const id of FUNNEL_TEMPLATE_IDS) {
    assert.deepEqual(validateTemplate(FUNNEL_TEMPLATES[id]), [], `${id} has structural problems`);
  }
});

test('validateTemplate is not vacuous — it catches each structural mistake it claims to', () => {
  const base = FUNNEL_TEMPLATES.broad_plus_recapture;
  const stage = (i: number): FunnelStageTemplate => {
    const s = base.stages[i];
    assert.ok(s !== undefined);
    return s;
  };

  const sharedCampaign: FunnelTemplate = {
    ...base,
    stages: [stage(0), { ...stage(1), campaign: 'A' }],
  };
  assert.match(validateTemplate(sharedCampaign).join(' '), /shares campaign/);

  // Excluding the warm pool from prospecting: the commonest self-inflicted wound.
  const excludesWarm: FunnelTemplate = {
    ...base,
    stages: [{ ...stage(0), exclude: ['purchasers_180d', 'warm_union_30d'] }, stage(1)],
  };
  assert.match(validateTemplate(excludesWarm).join(' '), /excludes warm pool/);

  // A hard inclusion under Advantage+ audience is a boundary that does not exist.
  const softInclusion: FunnelTemplate = {
    ...base,
    stages: [stage(0), { ...stage(1), advantageAudience: 1 }],
  };
  assert.match(validateTemplate(softInclusion).join(' '), /advantageAudience=1/);

  const noPurchaserExclusion: FunnelTemplate = {
    ...base,
    stages: [stage(0), { ...stage(1), exclude: ['site_visitors_1d'] }],
  };
  assert.match(validateTemplate(noPurchaserExclusion).join(' '), /does not exclude purchasers/);

  const undeclaredPool: FunnelTemplate = {
    ...base,
    stages: [{ ...stage(0), suggest: ['lookalike_value_3pct'] }, stage(1)],
  };
  assert.match(validateTemplate(undeclaredPool).join(' '), /does not declare/);

  const badShares: FunnelTemplate = {
    ...base,
    stages: [{ ...stage(0), budgetShare: 0.5 }, stage(1)],
  };
  assert.match(validateTemplate(badShares).join(' '), /budget shares sum/);

  const mofWithoutVisitorExclusion: FunnelTemplate = {
    ...FUNNEL_TEMPLATES.full_three_stage,
    stages: FUNNEL_TEMPLATES.full_three_stage.stages.map((s) =>
      s.role === 'mof' ? { ...s, exclude: ['purchasers_180d'] } : s,
    ),
  };
  assert.match(validateTemplate(mofWithoutVisitorExclusion).join(' '), /must exclude site visitors/);
});

test('exclusions are correct between funnel stages', () => {
  for (const { template, stage } of everyStage()) {
    const where = `${template.id}/${stage.id}`;

    if (PROSPECTING_ROLES.has(stage.role)) {
      // A broad ad set already spends 25-45% of its budget on warm people.
      for (const pool of stage.exclude) {
        assert.ok(!WARM_POOLS.has(pool), `${where} excludes warm pool ${pool}`);
      }
    }
    if (RETARGETING_ROLES.has(stage.role)) {
      assert.ok(
        stage.exclude.some((p) => PURCHASER_POOLS.has(p)),
        `${where} retargets without excluding purchasers`,
      );
    }
    for (const pool of stage.target) {
      assert.ok(!stage.exclude.includes(pool), `${where} both targets and excludes ${pool}`);
    }
  }

  // The two exclusions that make the stage names mean anything.
  const mof = exclusionsFor(FUNNEL_TEMPLATES.full_three_stage, 'mof').map((p) => p.id);
  assert.deepEqual(mof, ['purchasers_180d', 'site_visitors_30d']);
  const bof = exclusionsFor(FUNNEL_TEMPLATES.full_three_stage, 'bof').map((p) => p.id);
  assert.deepEqual(bof, ['purchasers_180d', 'site_visitors_1d']);

  // MOF and BOF must not both be able to claim the same person.
  const bofTargets = FUNNEL_TEMPLATES.full_three_stage.stages.find((s) => s.id === 'bof')?.target ?? [];
  assert.ok(bofTargets.includes('site_visitors_30d'));
  assert.ok(mof.includes('site_visitors_30d'), 'MOF must exclude what BOF targets');

  // The one stage whose whole point is to reach people who have already bought.
  const repeat = exclusionsFor(FUNNEL_TEMPLATES.value_ladder, 'existing_customer').map((p) => p.id);
  assert.deepEqual(repeat, ['purchasers_30d']);
  assert.ok(!repeat.includes('purchasers_180d'));

  assert.throws(() => exclusionsFor(FUNNEL_TEMPLATES.single_engine, 'nope'), FunnelPlanError);
});

test('no two stages of a template ever share one campaign budget', () => {
  // "Ad sets with the largest audiences will likely receive the most budget" — so a stage whose
  // budget lives on the campaign must be the only stage in that campaign, or every smaller stage
  // sharing it is starved silently.
  for (const id of FUNNEL_TEMPLATE_IDS) {
    const t = FUNNEL_TEMPLATES[id];
    const campaigns = t.stages.map((s) => s.campaign);
    assert.equal(new Set(campaigns).size, campaigns.length, `${id} reuses a campaign`);
    for (const s of t.stages) {
      if (s.budgetLevel !== 'campaign') continue;
      const sharers = t.stages.filter((o) => o.campaign === s.campaign);
      assert.equal(sharers.length, 1, `${id}/${s.id} puts a campaign budget over ${sharers.length} stages`);
    }
  }
});

test('every template resolves to legal archetype tuples via specFor()', () => {
  for (const archetype of ALL_ARCHETYPES) {
    for (const { template, stage } of everyStage()) {
      const spec = resolveStageSpec(stage, archetype);
      // Re-validate independently of resolveStageSpec's own call.
      validateSpec(spec);
      assert.ok(spec.objective.startsWith('OUTCOME_'), `${template.id}/${stage.id}`);
      if (stage.optimisation !== undefined) {
        assert.equal(spec.objective, stage.optimisation.objective);
        assert.equal(spec.optimizationGoal, stage.optimisation.optimizationGoal);
        assert.equal(spec.billingEvent, stage.optimisation.billingEvent);
        // The whole reason the override exists: an inherited destination_type is legal for the
        // base objective and frequently illegal for OUTCOME_AWARENESS.
        assert.equal(spec.destinationType, undefined, `${template.id}/${stage.id} inherited a destination`);
      }
    }
  }
});

test('the awareness override would be caught if it were illegal', () => {
  const seed = FUNNEL_TEMPLATES.seed_and_harvest.stages[0];
  assert.ok(seed !== undefined);
  const illegal: FunnelStageTemplate = {
    ...seed,
    optimisation: {
      objective: 'OUTCOME_AWARENESS',
      optimizationGoal: 'THRUPLAY',
      // TWO_SECOND_CONTINUOUS_VIDEO_VIEWS is not a legal billing event for THRUPLAY.
      billingEvent: 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS',
      promotedObject: 'none',
      note: 'deliberately illegal',
    },
  };
  assert.throws(() => resolveStageSpec(illegal, 'website_purchase'), /billing_event/);
});

test('audience pool retention windows are within the per-source ceilings', () => {
  const kindOf: Record<string, AudienceSourceKind | undefined> = {
    website: 'website',
    video: 'video',
    engagement: 'lead_form',
  };
  for (const pool of Object.values(AUDIENCE_POOLS)) {
    const kind = kindOf[pool.kind];
    if (kind === undefined) continue;
    assert.doesNotThrow(
      () => checkRetention(kind, pool.retentionDays),
      `${pool.id} asks for ${pool.retentionDays} days, above the ${RETENTION_MAX_DAYS[kind]}-day ceiling`,
    );
  }
});

// ---------------------------------------------------------------------------
// THE budget-adequacy decision
// ---------------------------------------------------------------------------

test('a realistically small budget refuses a multi-stage funnel and shows the arithmetic', () => {
  const a = assessFunnelBudget('broad_plus_recapture', {
    dailyBudgetMajor: 40,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
  });

  assert.equal(a.verdict, 'refuse');
  assert.deepEqual(a.failingStageIds, ['recapture']);
  assert.equal(a.bindingStageId, 'recapture');

  const recapture = a.stages.find((s) => s.stageId === 'recapture');
  assert.ok(recapture !== undefined);
  // 15% of $40 = $6/day, which buys 6*7/2 = 21 ViewContent events a week against the 50 needed.
  assert.equal(recapture.stageDailyMajor, 6);
  assert.equal(recapture.rung, 'view_content');
  assert.equal(recapture.eventsNeededPerWeek, LEARNING_PHASE_EVENTS_PER_WEEK);
  assert.equal(recapture.eventsAffordablePerWeek, 21);
  assert.equal(recapture.stageFloorDailyMajor, 14.29); // 50/7 x $2
  assert.equal(recapture.exitsLearning, false);
  assert.match(recapture.problem ?? '', /50 it needs/);

  // The arithmetic is stated per stage, in a form a non-expert can read.
  assert.match(recapture.arithmetic, /\$6\.00\/day x 7 \/ \$2\.00 per View content = 21 events\/week vs 50/);

  // And the refusal names a total, derived from the arithmetic rather than quoted.
  assert.equal(a.requiredDailyMajor, 95.27); // $14.29 floor / 15% share
  assert.equal(a.shortfallDailyMajor, 55.27);
  assert.equal(a.fallbackTemplateId, 'single_engine');
  assert.match(a.explanation.join(' '), /needs about \$95\.27\/day/);
  assert.match(a.explanation.join(' '), /Recommendation: Single Engine/);
  assert.match(a.explanation[0] ?? '', /50 optimisation events per ad set per week/);
});

test('a refused template always needs MORE than the budget it was refused at', () => {
  // The regression this exists for: implied totals were computed at the rung the stage was about
  // to be degraded to, so a $60/day funnel could be refused while reporting that it needed $38/day.
  for (const id of FUNNEL_TEMPLATE_IDS) {
    for (const budget of [5, 12, 25, 40, 60, 100, 250, 500, 900, 2000]) {
      for (const cpa of [6, 30, 80]) {
        const a = assessFunnelBudget(id, {
          dailyBudgetMajor: budget,
          archetype: 'website_purchase',
          targetCpaMajor: cpa,
        });
        if (a.verdict === 'refuse') {
          assert.ok(
            a.requiredDailyMajor > a.dailyBudgetMajor,
            `${id} @ $${budget}/cpa${cpa}: refused but claims it only needs $${a.requiredDailyMajor}`,
          );
          assert.ok(a.shortfallDailyMajor > 0);
          assert.ok(a.failingStageIds.length > 0);
        } else {
          assert.deepEqual(a.failingStageIds, []);
          for (const s of a.stages) assert.equal(s.exitsLearning, true, `${id}/${s.stageId} @ $${budget}`);
        }
      }
    }
  }
});

test('recommendFunnel sends a small budget to one broad campaign, with the reasoning attached', () => {
  const r = recommendFunnel({
    dailyBudgetMajor: 40,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
    purchasesLast180d: 400,
    warmPoolSize: 20_000,
    hasCustomerList: false,
  });

  assert.equal(r.templateId, 'single_engine');
  assert.equal(r.template.stages.length, 1);
  assert.equal(r.assessment.verdict, 'build');
  assert.match(r.notes.join(' '), /a second ad set takes budget away from the one that converts/);
});

test('a budget that clears the template ladder is still refused when a stage cannot be fed', () => {
  const r = recommendFunnel({
    dailyBudgetMajor: 60, // over the $50 playbook floor for Broad + Recapture
    archetype: 'website_purchase',
    targetCpaMajor: 30,
    purchasesLast180d: 400,
    warmPoolSize: 20_000,
    hasCustomerList: false,
  });

  assert.equal(r.templateId, 'single_engine');
  const refused = r.considered.find((c) => c.templateId === 'broad_plus_recapture');
  assert.ok(refused !== undefined);
  assert.equal(refused.verdict, 'refuse');
  assert.match(refused.why, /short/);
  assert.match(refused.why, /Recommendation: Single Engine/);
});

test('the three-stage funnel is refused until the bottom stage can afford its own learning phase', () => {
  const at500 = assessFunnelBudget('full_three_stage', {
    dailyBudgetMajor: 500,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
  });
  assert.equal(at500.verdict, 'refuse');
  assert.equal(at500.bindingStageId, 'bof');
  assert.deepEqual(at500.failingStageIds, ['bof']);
  // $30 CPA x 50/7 = $214.29/day for the BOF ad set alone; it holds 25% of the budget.
  assert.equal(at500.requiredDailyMajor, 857.16);
  assert.equal(at500.declaredMinViableDailyMajor, 500);
  assert.equal(at500.fallbackTemplateId, 'broad_plus_recapture');
  assert.match(at500.explanation.join(' '), /the playbook figure for Full Three-Stage/);

  const at900 = assessFunnelBudget('full_three_stage', {
    dailyBudgetMajor: 900,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
  });
  assert.equal(at900.verdict, 'build');
  const tof = at900.stages.find((s) => s.stageId === 'tof');
  assert.ok(tof !== undefined);
  // Reach is not event-limited, so no learning floor applies to it at all.
  assert.equal(tof.eventLimited, false);
  assert.equal(tof.stageFloorDailyMajor, undefined);
  assert.equal(tof.exitsLearning, true);
  assert.match(tof.arithmetic, /not event-limited/);
});

test('the three-stage funnel is not even offered above the CPA it was specified for', () => {
  const cheap = recommendFunnel({
    dailyBudgetMajor: 900,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
    purchasesLast180d: 400,
    warmPoolSize: 20_000,
    hasCustomerList: false,
  });
  assert.equal(cheap.templateId, 'full_three_stage');

  const dear = recommendFunnel({
    dailyBudgetMajor: 900,
    archetype: 'website_purchase',
    targetCpaMajor: 60,
    purchasesLast180d: 400,
    warmPoolSize: 20_000,
    hasCustomerList: false,
  });
  assert.equal(dear.templateId, 'broad_plus_recapture');
  assert.match(dear.notes.join(' '), /only offered under \$40\.00/);
});

test('at a budget no ad set can work at, the module says so instead of recommending something', () => {
  const a = assessFunnelBudget('single_engine', {
    dailyBudgetMajor: 4,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
  });
  assert.equal(a.verdict, 'refuse');
  assert.equal(a.fallbackTemplateId, undefined);
  assert.match(a.explanation.join(' '), /no simpler structure to fall back to/);
  // It laddered all the way to the bottom and still could not get there.
  assert.equal(a.stages[0]?.rung, 'landing_page_view');
});

test('the single engine ladders down to the dearest event its budget can actually buy', () => {
  const rungAt = (budget: number): string | undefined =>
    assessFunnelBudget('single_engine', {
      dailyBudgetMajor: budget,
      archetype: 'website_purchase',
      targetCpaMajor: 30,
    }).stages[0]?.rung;

  assert.equal(rungAt(10), 'landing_page_view'); // floor $5.71
  assert.equal(rungAt(20), 'view_content'); // floor $14.29
  assert.equal(rungAt(100), 'add_to_cart'); // floor $57.14
  assert.equal(rungAt(300), 'purchase'); // floor $214.29
});

test('a stage is never delivered below the rung at which it stops doing its job', () => {
  // The regression: `minimumRung` is written as an absolute rung, but a lead brand's ladder has no
  // `view_content` on it. Before the fix, indexOf returned -1, the guard never fired, and a lead
  // brand was sold a "Recapture" ad set optimising for landing page views.
  assert.equal(effectiveMinimumRung('view_content', LEAD_LADDER), 'lead');
  assert.equal(effectiveMinimumRung('purchase', LEAD_LADDER), 'lead');
  assert.equal(effectiveMinimumRung('landing_page_view', LEAD_LADDER), 'landing_page_view');
  assert.equal(effectiveMinimumRung('view_content', CONVERSION_LADDER), 'view_content');
  assert.equal(effectiveMinimumRung('view_content', TRAFFIC_LADDER), 'landing_page_view');

  const a = assessFunnelBudget('broad_plus_recapture', {
    dailyBudgetMajor: 60,
    archetype: 'website_lead',
    targetCpaMajor: 20,
  });
  const recapture = a.stages.find((s) => s.stageId === 'recapture');
  assert.ok(recapture !== undefined);
  assert.equal(recapture.declaredMinimumRung, 'view_content');
  assert.equal(recapture.minimumRung, 'lead');
  assert.equal(recapture.rung, 'lead', 'a recapture stage must not be reported as a traffic ad set');
  assert.equal(recapture.belowMinimum, true);
  assert.equal(recapture.exitsLearning, false);
  assert.equal(a.verdict, 'refuse');
  assert.match(recapture.problem ?? '', /stops doing its job below Lead/);
  assert.ok(a.requiredDailyMajor > 60);
});

test('holding a stage at its minimum is not a refusal when the minimum is affordable', () => {
  // Instant-form leads at the $6 benchmark: one rung cheaper would be a landing page view, which
  // is below the minimum, so the stage is held at Lead — and 15% of $300/day can pay for that.
  const a = assessFunnelBudget('broad_plus_recapture', {
    dailyBudgetMajor: 300,
    archetype: 'instant_form_lead',
  });
  const recapture = a.stages.find((s) => s.stageId === 'recapture');
  assert.ok(recapture !== undefined);
  assert.equal(recapture.belowMinimum, true);
  assert.equal(recapture.rung, 'lead');
  assert.equal(recapture.exitsLearning, true);
  assert.equal(recapture.problem, undefined);
  assert.equal(a.verdict, 'build');
});

test('a "one rung cheaper" stage keeps laddering when its own share cannot pay for that rung', () => {
  // At an $8 purchase CPA the add-to-cart benchmark is as dear as a purchase, so a recapture stage
  // pinned to "one rung cheaper" was declared unaffordable at $300/day — while ViewContent, the
  // rung at which it still does its job, costs $14.29/day of the $45 it holds.
  const a = assessFunnelBudget('broad_plus_recapture', {
    dailyBudgetMajor: 300,
    archetype: 'website_purchase',
    targetCpaMajor: 8,
  });
  const recapture = a.stages.find((s) => s.stageId === 'recapture');
  assert.ok(recapture !== undefined);
  assert.equal(recapture.preferredRung, 'add_to_cart');
  assert.equal(recapture.rung, 'view_content');
  assert.equal(recapture.laddered, true);
  assert.equal(recapture.belowMinimum, false);
  assert.equal(a.verdict, 'build');

  // It still stops at the minimum rather than falling through to landing page views.
  const thin = assessFunnelBudget('broad_plus_recapture', {
    dailyBudgetMajor: 60,
    archetype: 'website_purchase',
    targetCpaMajor: 8,
  });
  const thinRecapture = thin.stages.find((s) => s.stageId === 'recapture');
  assert.equal(thinRecapture?.rung, 'view_content');
  assert.equal(thinRecapture?.belowMinimum, true);
  assert.equal(thin.verdict, 'refuse');
});

test('the learning-phase constants are the ones the research states', () => {
  assert.equal(LEARNING_PHASE_EVENTS_PER_WEEK, 50);
  assert.equal(Math.round(LEARNING_DAILY_MULTIPLE * 100) / 100, 7.14);
  // The table the whole product is built on: $30 CPA -> $214.29/day for one ad set.
  const a = assessFunnelBudget('single_engine', {
    dailyBudgetMajor: 214.29,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
  });
  assert.equal(a.stages[0]?.rung, 'purchase');
  assert.equal(a.stages[0]?.stageFloorDailyMajor, 214.29);
  assert.equal(a.verdict, 'build');
});

test('a cold-start account with no history is offered Seed & Harvest, and both stages are fed', () => {
  const r = recommendFunnel({
    dailyBudgetMajor: 30,
    archetype: 'website_purchase',
    targetCpaMajor: 30,
    purchasesLast180d: 0,
    warmPoolSize: 0,
    hasCustomerList: false,
  });
  assert.equal(r.templateId, 'seed_and_harvest');
  assert.equal(r.assessment.verdict, 'build');
  const seed = r.assessment.stages.find((s) => s.stageId === 'seed');
  assert.equal(seed?.rung, 'thruplay');
  assert.equal(seed?.stageFloorDailyMajor, 0.36); // essentially free, per the research
  assert.equal(r.assessment.stages.find((s) => s.stageId === 'harvest')?.exitsLearning, true);

  // Below the seed floor there is no pool to build, so there is no point paying for one.
  const tiny = recommendFunnel({
    dailyBudgetMajor: 12,
    archetype: 'website_purchase',
    purchasesLast180d: 0,
    warmPoolSize: 0,
    hasCustomerList: false,
  });
  assert.equal(tiny.templateId, 'single_engine');
});

test('a warm pool under the delivery floor removes the recapture stage', () => {
  const r = recommendFunnel({
    dailyBudgetMajor: 300,
    archetype: 'website_purchase',
    targetCpaMajor: 8,
    purchasesLast180d: 400,
    warmPoolSize: 400,
    hasCustomerList: false,
  });
  assert.equal(r.templateId, 'single_engine');
  assert.match(r.notes.join(' '), /A recapture stage would have nobody in it/);
});

test('assessFunnelBudget rejects a nonsense budget rather than dividing by it', () => {
  assert.throws(
    () => assessFunnelBudget('single_engine', { dailyBudgetMajor: 0, archetype: 'website_purchase' }),
    FunnelPlanError,
  );
});

test('non-USD budgets are flagged as approximate rather than silently benchmarked', () => {
  const a = assessFunnelBudget('single_engine', {
    dailyBudgetMajor: 100,
    archetype: 'website_purchase',
    currency: 'gbp',
  });
  assert.equal(a.currency, 'GBP');
  assert.equal(a.benchmarksApproximate, true);
});

test('ladders and primary rungs are defined for every archetype', () => {
  for (const archetype of ALL_ARCHETYPES) {
    const ladder = ladderFor(archetype);
    assert.ok(ladder.length > 0);
    assert.equal(ladder[0], primaryRungFor(archetype));
  }
});

// ---------------------------------------------------------------------------
// The easy-options surface
// ---------------------------------------------------------------------------

test('resolveEasyOptions splits the budget exactly and never loses a minor unit', () => {
  const plan = resolveEasyOptions({
    goal: 'sales',
    dailyBudgetMinor: 30_000, // $300/day
    currency: 'USD',
    targetCpaMinor: 800,
    assets: 'website_traffic',
    warmPoolSize: 20_000,
    purchasesLast180d: 400,
  });

  assert.equal(plan.templateId, 'broad_plus_recapture');
  assert.equal(plan.refusal, undefined);
  const total = plan.stages.reduce((acc, s) => acc + s.dailyBudgetMinor, 0);
  assert.equal(total, 30_000);
  assert.deepEqual(
    plan.stages.map((s) => s.dailyBudgetMinor),
    [25_500, 4_500],
  );
  for (const s of plan.stages) {
    assert.equal(s.arithmetic.stageId, s.stage.id);
    assert.equal(s.excludePools.length, s.stage.exclude.length);
  }
  assert.deepEqual(
    plan.audiencesToBuild.map((p) => p.id),
    [...FUNNEL_TEMPLATES.broad_plus_recapture.audiences],
  );
});

test('resolveEasyOptions carries the refusal instead of publishing something that cannot work', () => {
  const plan = resolveEasyOptions({
    goal: 'sales',
    dailyBudgetMinor: 500, // $5/day
    currency: 'USD',
    targetCpaMinor: 3000,
    assets: 'nothing',
  });
  assert.equal(plan.templateId, 'single_engine');
  assert.ok(plan.refusal !== undefined);
  assert.match(plan.refusal, /learning phase/);
  // Unmeasured inputs are assumptions, and they are named as assumptions.
  assert.match(plan.warnings.join(' '), /warmPoolSize was not supplied/);
  assert.match(plan.warnings.join(' '), /purchasesLast180d was not supplied/);
});

test('resolveEasyOptions warns when a template depends on the undocumented video rule', () => {
  const plan = resolveEasyOptions({
    goal: 'sales',
    dailyBudgetMinor: 3000,
    currency: 'USD',
    assets: 'nothing',
    warmPoolSize: 0,
    purchasesLast180d: 0,
  });
  assert.equal(plan.templateId, 'seed_and_harvest');
  assert.match(plan.warnings.join(' '), /video-engagement rule Meta no longer documents/);
});

test('splitMinor is exact and gives the remainder to the largest share', () => {
  assert.deepEqual(splitMinor(1000, [0.85, 0.15]), [850, 150]);
  assert.deepEqual(splitMinor(1001, [0.85, 0.15]), [851, 150]);
  assert.deepEqual(splitMinor(100, [0.15, 0.6, 0.25]), [15, 60, 25]);
  assert.deepEqual(splitMinor(7, [0.5, 0.5]), [4, 3]);
  for (const total of [1, 7, 99, 1234, 100_000]) {
    for (const shares of [[1], [0.85, 0.15], [0.15, 0.6, 0.25], [0.9, 0.1]]) {
      const parts = splitMinor(total, shares);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} / ${shares.join(',')}`);
    }
  }
});

test('forecastVideoPool reproduces the operational threshold from the research', () => {
  // ~$300 of cumulative video spend before a 50% pool crosses 1,000 people in a tier-1 market.
  const f = forecastVideoPool({ dailyBudgetMajor: 10, days: 30 });
  assert.equal(f.impressions, 25_000);
  assert.equal(f.uniquePeople, 1923);
  assert.equal(f.meetsFloor, true);

  const thin = forecastVideoPool({ dailyBudgetMajor: 5, days: 30 });
  assert.equal(thin.uniquePeople, 962);
  assert.equal(thin.meetsFloor, false);
  assert.equal(thin.floor, AUDIENCE_DELIVERY_FLOOR);
  assert.match(thin.arithmetic.join(' '), /Retention window is the cheaper lever/);

  // Double it for a 75% pool — which is the pool the templates actually seed from.
  const p75 = forecastVideoPool({ dailyBudgetMajor: 10, days: 30, threshold: 'p75' });
  assert.equal(p75.uniquePeople, 962);
  assert.equal(p75.daysToFloor, 32);
});

// ---------------------------------------------------------------------------
// Audiences — the lookalike refusal
// ---------------------------------------------------------------------------

test('a lookalike is refused for an undersized source audience', () => {
  const tooSmall = checkLookalikeSeed(60, { country: 'us' });
  assert.equal(tooSmall.verdict, 'too_small');
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.shortfallToHardMinimum, LOOKALIKE_HARD_MIN_SEED - 60);
  assert.match(tooSmall.message, /IN THE TARGET COUNTRY/);

  const warming = checkLookalikeSeed(300);
  assert.equal(warming.verdict, 'warming');
  assert.equal(warming.ok, false);
  assert.equal(warming.shortfallToHardMinimum, 0);
  assert.equal(warming.shortfallToQualityFloor, LOOKALIKE_QUALITY_MIN_SEED - 300);

  assert.equal(checkLookalikeSeed(LOOKALIKE_QUALITY_MIN_SEED).verdict, 'ok');

  const input = {
    adAccountId: ACCOUNT,
    name: 'LAL 3% US - purchasers 180d',
    seedAudienceId: '900100',
    country: 'US',
    ratio: 0.03,
  };

  // Below Meta's hard floor: the create would be rejected outright.
  assert.throws(
    () => buildLookalikeAudienceRequest({ ...input, seedSize: 60 }),
    (e: unknown) => e instanceof AudienceBuildError && e.field === 'origin_audience_id',
  );
  // Above the hard floor, below the quality floor: buildable, and still refused, because the seed
  // snapshot at build time is what gets modelled and the lookalike can never improve.
  assert.throws(() => buildLookalikeAudienceRequest({ ...input, seedSize: 300 }), /quality floor/);
  // Building blind is the easiest way to spend money on noise.
  assert.throws(() => buildLookalikeAudienceRequest(input), /seedSize is required/);

  // The cold-start escape hatch is explicit, and it warns.
  const forced = buildLookalikeAudienceRequest({
    ...input,
    seedSize: 300,
    seedOptions: { allowUndersized: true },
  });
  assert.match(forced.warnings.join(' '), /700 short/);

  const ok = buildLookalikeAudienceRequest({ ...input, seedSize: 5000 });
  assert.equal(ok.path, `${ACCOUNT}/customaudiences`);
  assert.equal(ok.params['subtype'], 'LOOKALIKE');
  assert.equal(ok.params['origin_audience_id'], '900100');
  assert.deepEqual(JSON.parse(ok.params['lookalike_spec'] ?? '{}'), { ratio: 0.03, country: 'US' });
  // Lookalikes take no rule and no prefill.
  assert.equal(ok.params['rule'], undefined);
  assert.equal(ok.params['prefill'], undefined);
  assert.match(ok.warnings.join(' '), /Do NOT also exclude the seed/);
});

test('lookalike ratios and tiers are refused where Meta would refuse them', () => {
  const base = {
    adAccountId: ACCOUNT,
    name: 'LAL',
    seedAudienceId: '900100',
    country: 'US',
    seedSize: 5000,
  };
  assert.throws(() => buildLookalikeAudienceRequest({ ...base, ratio: 0.005 }), /outside the documented range/);
  assert.throws(() => buildLookalikeAudienceRequest({ ...base, ratio: 0.25 }), /outside the documented range/);
  assert.throws(() => buildLookalikeAudienceRequest({ ...base, ratio: 0.035 }), /not a multiple/);
  assert.throws(
    () => buildLookalikeAudienceRequest({ ...base, ratio: 0.03, startingRatio: 0.03 }),
    /strictly less than/,
  );
  assert.throws(() => buildLookalikeAudienceRequest({ ...base, ratio: 0.03, country: 'USA' }), /ISO-2/);

  // ratio is cumulative, so overlapping tiers bid against each other.
  assert.throws(
    () =>
      buildLookalikeTierRequests(base, [
        { startingRatio: 0, ratio: 0.03 },
        { startingRatio: 0.01, ratio: 0.05 },
      ]),
    /tiers overlap/,
  );
  const tiers = buildLookalikeTierRequests(base, [
    { startingRatio: 0.01, ratio: 0.03 },
    { startingRatio: 0, ratio: 0.01 },
  ]);
  assert.deepEqual(
    tiers.map((t) => JSON.parse(t.params['lookalike_spec'] ?? '{}')),
    [
      { ratio: 0.01, country: 'US' },
      { ratio: 0.03, country: 'US', starting_ratio: 0.01 },
    ],
  );
  assert.match(tiers[0]?.warnings.join(' ') ?? '', /largely notional/);
});

// ---------------------------------------------------------------------------
// Audiences — request shapes
// ---------------------------------------------------------------------------

test('a video-view audience uses the legacy bare-array rule and chunks by construction', () => {
  const videoIds = Array.from({ length: 201 }, (_, i) => String(70_000 + i));
  const reqs = buildVideoViewAudienceRequests({
    adAccountId: ACCOUNT,
    name: 'VV75 acme 90d',
    pageId: PAGE,
    videoIds,
    threshold: 'p75',
    retentionDays: 90,
  });

  assert.equal(reqs.length, 2);
  assert.equal(reqs[0]?.name, 'VV75 acme 90d (1 of 2)');
  const first = reqs[0];
  assert.ok(first !== undefined);
  assert.equal(first.params['subtype'], 'ENGAGEMENT');
  assert.equal(first.params['retention_days'], '90');
  assert.equal(first.params['prefill'], '1');
  const rule = JSON.parse(first.params['rule'] ?? '[]') as Array<Record<string, string>>;
  assert.ok(Array.isArray(rule), 'the video rule is a bare array, not an {inclusions} object');
  assert.equal(rule.length, MAX_VIDEOS_PER_VIDEO_AUDIENCE);
  assert.deepEqual(rule[0], {
    event_name: 'video_view_75_percent',
    object_id: '70000',
    context_id: PAGE, // the PAGE that published the video, not the ad account
  });
  assert.equal(first.unverified.length > 0, true);

  // p95 reads back from Meta as video_completed, not video_view_95_percent.
  const p95 = buildVideoViewAudienceRequests({
    adAccountId: ACCOUNT,
    name: 'VV95',
    pageId: PAGE,
    videoIds: ['70000'],
    threshold: 'p95',
    retentionDays: 30,
  });
  const p95Rule = JSON.parse(p95[0]?.params['rule'] ?? '[]') as Array<Record<string, string>>;
  assert.equal(p95Rule[0]?.event_name, 'video_completed');
  assert.equal(p95[0]?.name, 'VV95', 'a single chunk must not be suffixed');

  // Shallow thresholds encode "scrolls slowly" and are flagged as poor seeds.
  const p25 = buildVideoViewAudienceRequests({
    adAccountId: ACCOUNT,
    name: 'VV25',
    pageId: PAGE,
    videoIds: ['70000'],
    threshold: 'p25',
    retentionDays: 30,
  });
  assert.match(p25[0]?.warnings.join(' ') ?? '', /POOR lookalike seed/);

  assert.throws(
    () =>
      buildVideoViewAudienceRequests({
        adAccountId: ACCOUNT,
        name: 'VV75',
        pageId: ACCOUNT, // the classic mistake
        videoIds: ['70000'],
        threshold: 'p75',
        retentionDays: 30,
      }),
    /context_id is the PAGE/,
  );
  assert.throws(
    () =>
      buildVideoViewAudienceRequests({
        adAccountId: '1234567890',
        name: 'VV75',
        pageId: PAGE,
        videoIds: ['70000'],
        threshold: 'p75',
        retentionDays: 30,
      }),
    /act_ prefix/,
  );
});

test('page and IG engagement audiences omit subtype and use the event_sources grammar', () => {
  const page = buildPageEngagementAudienceRequest({
    adAccountId: ACCOUNT,
    name: 'Page engagers 30d',
    sourceIds: [PAGE],
    retentionDays: 30,
    events: ['page_engaged', 'page_visited'],
  });
  assert.equal(page.params['subtype'], undefined, 'subtype is deprecated for non-video engagement');
  const rule = JSON.parse(page.params['rule'] ?? '{}') as {
    inclusions: { rules: Array<{ event_sources: Array<{ id: string; type: string }>; retention_seconds: number }> };
  };
  const inner = rule.inclusions.rules[0];
  assert.ok(inner !== undefined);
  assert.deepEqual(inner.event_sources, [{ id: PAGE, type: 'page' }]);
  assert.equal(inner.retention_seconds, 30 * 86_400);

  // Followers have no rolling window and cannot be mixed with windowed events.
  assert.throws(
    () =>
      buildPageEngagementAudienceRequest({
        adAccountId: ACCOUNT,
        name: 'Followers',
        sourceIds: [PAGE],
        retentionDays: 30,
        events: ['page_liked'],
      }),
    /must send 0/,
  );
  assert.throws(
    () =>
      buildPageEngagementAudienceRequest({
        adAccountId: ACCOUNT,
        name: 'Followers',
        sourceIds: [PAGE],
        retentionDays: 0,
        events: ['page_liked', 'page_visited'],
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      buildPageEngagementAudienceRequest({
        adAccountId: ACCOUNT,
        name: 'Too many pages',
        sourceIds: ['1', '2', '3', '4', '5', '6'],
        retentionDays: 30,
        events: ['page_engaged'],
      }),
    /1713153/,
  );

  const ig = buildIgEngagementAudienceRequest({
    adAccountId: ACCOUNT,
    name: 'IG followers',
    sourceIds: [PAGE],
    retentionDays: 365,
    events: ['INSTAGRAM_PROFILE_FOLLOW'],
  });
  const igRule = JSON.parse(ig.params['rule'] ?? '{}') as {
    inclusions: { rules: Array<{ event_sources: Array<{ type: string }>; filter: { filters: Array<{ value: string }> } }> };
  };
  assert.equal(igRule.inclusions.rules[0]?.event_sources[0]?.type, 'ig_business');
  // Uppercase, uniquely among these constants.
  assert.equal(igRule.inclusions.rules[0]?.filter.filters[0]?.value, 'INSTAGRAM_PROFILE_FOLLOW');
  assert.match(ig.unverified.join(' '), /IG_BUSINESS/);
});

test('retention windows are refused above the documented ceiling and warned below it', () => {
  assert.throws(() => checkRetention('lead_form', 91), /90 days/);
  assert.equal(checkRetention('lead_form', 90).ok, true);
  assert.throws(() => checkRetention('video', 366), /365/);
  assert.throws(() => checkRetention('website', 181), /180/);
  assert.throws(() => checkRetention('video', 30.5), /whole number/);
  // A video window rides in the top-level retention_days field, which the node reference caps at
  // 180 even though the Ads Manager flow offers 365. Buildable, but it must not pass silently.
  assert.equal(checkRetention('video', 365).warnings.length, 1);
  assert.equal(checkRetention('video', 90).warnings.length, 0);
  assert.equal(checkRetention('page', 730).warnings.length, 1);
  assert.equal(checkRetention('page_likes', 0).ok, true);
});

test('audience names are flagged, not silently rewritten, when they risk the integrity filter', () => {
  const clean = sanitiseAudienceName('  Purchasers   180d  ');
  assert.equal(clean.name, 'Purchasers 180d');
  assert.deepEqual(clean.warnings, []);
  const risky = sanitiseAudienceName('High income buyers');
  assert.equal(risky.name, 'High income buyers');
  assert.match(risky.warnings.join(' '), /1713232/);
  assert.throws(() => sanitiseAudienceName('   '), /audience name is required/);
});

// ---------------------------------------------------------------------------
// Audiences — the readiness gate
// ---------------------------------------------------------------------------

test('an audience that is too small to deliver is never reported as ready', () => {
  const tooSmall = classifyAudienceReadiness({
    id: '1',
    operation_status: { code: 200 },
    delivery_status: { code: 300, description: 'Too small' },
    approximate_count_lower_bound: 400,
  });
  assert.equal(tooSmall.verdict, 'wait');
  assert.equal(tooSmall.shortfall, 600);
  assert.match(tooSmall.reason, /too small/);

  const thin = classifyAudienceReadiness({
    id: '1',
    operation_status: { code: 200 },
    delivery_status: { code: 200 },
    approximate_count_lower_bound: 900,
  });
  assert.equal(thin.verdict, 'wait');
  assert.equal(thin.shortfall, 100);

  // An exclusion-only audience is a hard constraint at any size, so it has no floor.
  const exclusion = classifyAudienceReadiness(
    { id: '1', operation_status: { code: 200 }, delivery_status: { code: 200 }, approximate_count_lower_bound: 12 },
    { qualityFloor: 0 },
  );
  assert.equal(exclusion.verdict, 'ready');

  assert.equal(
    classifyAudienceReadiness({
      id: '1',
      operation_status: { code: 200 },
      delivery_status: { code: 200 },
      approximate_count_lower_bound: 4000,
    }).verdict,
    'ready',
  );
  // Building is the normal populating state; a failed lookalike build never becomes ready.
  assert.equal(classifyAudienceReadiness({ id: '1', operation_status: { code: 441 } }).verdict, 'wait');
  assert.equal(classifyAudienceReadiness({ id: '1', operation_status: { code: 432 } }).verdict, 'fail');
  assert.equal(classifyAudienceReadiness({ id: '1', operation_status: { code: 471 } }).verdict, 'fail');
  // Usable, but logged.
  const warned = classifyAudienceReadiness({
    id: '1',
    operation_status: { code: 442 },
    delivery_status: { code: 200 },
    approximate_count_lower_bound: 4000,
  });
  assert.equal(warned.verdict, 'ready');
  assert.equal(warned.warnings.length, 1);
  // An undocumented status must not default to "proceed".
  const unknown = classifyAudienceReadiness({
    id: '1',
    operation_status: { code: 999 },
    delivery_status: { code: 200 },
    approximate_count_lower_bound: 4000,
  });
  assert.equal(unknown.verdict, 'wait');
  assert.match(unknown.reason, /not a code this module recognises/);
});

test('awaitAudienceReady polls a read-only port and gives up with an explicit warning', async () => {
  const paths: string[] = [];
  let calls = 0;
  const ready = await awaitAudienceReady(
    async (path, params) => {
      paths.push(path);
      assert.match(params['fields'] ?? '', /approximate_count_lower_bound/);
      calls += 1;
      return {
        id: '900100',
        operation_status: { code: calls < 3 ? 441 : 200 },
        delivery_status: { code: 200 },
        approximate_count_lower_bound: 4200,
      };
    },
    '900100',
    { maxAttempts: 5, intervalMs: 0, sleep: async () => {} },
  );
  assert.equal(ready.verdict, 'ready');
  assert.equal(ready.attempts, 3);
  assert.deepEqual(paths, ['900100', '900100', '900100']);

  const never = await awaitAudienceReady(
    async () => ({ id: '900100', operation_status: { code: 441 } }),
    '900100',
    { maxAttempts: 2, intervalMs: 0, sleep: async () => {} },
  );
  assert.equal(never.verdict, 'wait');
  assert.equal(never.attempts, 2);
  assert.match(never.reason, /Do not publish an ad set against it/);

  // A garbage response must not read as a populated audience.
  const garbage = await awaitAudienceReady(async () => 'not an object', '900100', {
    maxAttempts: 1,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(garbage.verdict, 'wait');
});

test('a silently truncated retention window is detected on read-back', () => {
  assert.equal(retentionDrift(90, 90), undefined);
  assert.match(retentionDrift(365, 180) ?? '', /Meta truncates silently/);
  assert.match(retentionDrift(90, undefined) ?? '', /unverified/);
});

test('the Custom Audience ToS gate reads as a named blocker', () => {
  const yes = readTosStatus({ tos_accepted: { custom_audience_tos: 1 } }, ACCOUNT);
  assert.equal(yes.accepted, true);
  const no = readTosStatus({ tos_accepted: { custom_audience_tos: 0 } }, ACCOUNT);
  assert.equal(no.accepted, false);
  assert.match(no.reason, /UI-only/);
  assert.match(no.acceptanceUrl, /customaudiences\/tos\/\?act=1234567890/);
  assert.equal(readTosStatus(null, ACCOUNT).accepted, false);
  assert.equal(readTosStatus({}, ACCOUNT).accepted, false);
});
