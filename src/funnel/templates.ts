/**
 * Named funnel templates, as data — and the function that refuses to build one.
 *
 * The centre of this module is `assessFunnelBudget`. Everything else exists to feed it.
 * The research reaches an uncomfortable conclusion that the product has to be built
 * around rather than argued with: **for most small advertisers a multi-stage funnel is
 * strictly worse than one broad campaign**, and the failure is not evenly distributed
 * across the stages — it is concentrated in the one stage that makes the money.
 *
 * The arithmetic, from Meta's own primary sources:
 *
 *   an ad set exits the learning phase after ~50 optimisation events in a week
 *   => daily budget needed  =  50/7 x cost per optimisation event  =  7.14 x CPE
 *
 * A ThruPlay ad set at $0.05/ThruPlay needs $0.36/day. A purchase-optimised ad set at a
 * $30 CPA needs $214/day — on its own, before any other stage exists. So the received
 * wisdom that "a funnel fragments spend so nothing exits learning" is only half right.
 * The top and middle stages are nearly free; the bottom stage cannot afford itself, and
 * it could not afford itself in a single-campaign account either. What a funnel actually
 * costs at a small budget is the money diverted AWAY from the stage that converts.
 *
 * So this module does not just pick a template. It shows its working: for every stage it
 * reports events needed per ad set per week (50) against events the budget can buy at
 * that stage's cost per event, and it names the binding stage. That output is designed to
 * be rendered to a non-expert as a sentence, because the product's job here is to tell a
 * $40/day advertiser that they do not need a funnel — not to sell them one that cannot work.
 *
 * Three structural findings shape the templates themselves:
 *
 *  - **Inclusions are suggestions; exclusions are controls.** Under Advantage+ audience a
 *    custom-audience inclusion is a hint the delivery system may ignore, while an
 *    exclusion is honoured and does not even turn Advantage+ off. Every template here is
 *    therefore built out of exclusions and creative routing. A stage that declares a HARD
 *    inclusion must also declare `advantageAudience: 0` — otherwise the system would be
 *    reasoning about a boundary that does not exist.
 *  - **Never put funnel stages in one campaign budget.** Meta: "ad sets with the largest
 *    audiences will likely receive the most budget". A 1,500-person recapture ad set
 *    sharing a CBO budget with a broad prospecting ad set is starved, silently. Hence
 *    every multi-stage template is separate campaigns with per-ad-set budgets, which is
 *    the opposite of the usual "always use CBO" advice and follows directly from Meta's
 *    own guidance.
 *  - **Do not exclude warm audiences from prospecting.** A broad ad set already spends
 *    25–45% of its budget on people you would have retargeted. Excluding them removes the
 *    cheapest third of the campaign's conversions and Meta does not tell you that is what
 *    happened. `mustNotExclude` encodes this as a checked invariant, not a comment.
 *
 * Sources: docs/research/funnel-strategy.md (§5 budgets, §6 exclusions, §7 retention,
 * §9 learning mechanics, §10 the five templates and the selection function) and
 * docs/research/funnel-video-lookalike.md (§10 what Advantage+ leaves for a funnel to do).
 */

import type {
  ArchetypeSpec,
  BillingEvent,
  ConversionArchetype,
  DestinationType,
  Objective,
  OptimizationGoal,
  PromotedObjectKind,
} from '../meta/objectives.ts';
import { specFor, validateSpec } from '../meta/objectives.ts';
import { currencyOffset } from '../meta/publish.ts';
import { AUDIENCE_DELIVERY_FLOOR } from './audiences.ts';

export class FunnelPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunnelPlanError';
  }
}

// ---------------------------------------------------------------------------
// Learning-phase constants
// ---------------------------------------------------------------------------

/** "about 50 results in the week after the ad set's last significant edit". Per AD SET, not per ad. */
export const LEARNING_PHASE_EVENTS_PER_WEEK = 50;

/** 50/7. Multiply by the cost per optimisation event to get the daily budget an ad set needs. */
export const LEARNING_DAILY_MULTIPLE = LEARNING_PHASE_EVENTS_PER_WEEK / 7;

/** Shops ads have their own documented threshold over 7 days. */
export const SHOPS_ADS_LEARNING = { website: 17, meta: 5 } as const;

/** With a cost-per-result goal bid strategy, daily budget must be >= 5x the goal. */
export const COST_GOAL_BUDGET_MULTIPLE = 5;

/**
 * Cost per primary conversion above which the three-stage template is not offered at all.
 *
 * From the selection function in the research: `if b >= 500 and cpa <= 40: FULL_THREE_STAGE`. It is
 * a separate gate from the budget arithmetic and it fires earlier: at a $60 CPA the bottom stage
 * needs $428/day of its own, so a $500/day account would be offered a template the arithmetic then
 * refuses. Checking the CPA first means the account is never shown the three-stage structure at all.
 */
export const FULL_THREE_STAGE_MAX_CPA_MAJOR = 40;

// ---------------------------------------------------------------------------
// The optimisation-event ladder
// ---------------------------------------------------------------------------

export type OptimisationRung =
  | 'purchase'
  | 'add_to_cart'
  | 'view_content'
  | 'landing_page_view'
  | 'lead'
  | 'app_install'
  | 'thruplay'
  | 'reach';

export interface RungSpec {
  id: OptimisationRung;
  label: string;
  /**
   * `brand_cpa` — the cost of this event IS the brand's target CPA (the benchmark is only
   * a fallback). `benchmark` — a tier-1 market figure. `none` — the ad set is not
   * event-limited at all, so the learning-phase floor does not apply to it.
   */
  costBasis: 'brand_cpa' | 'benchmark' | 'none';
  /** Tier-1 (US/UK/DE) benchmark cost per event, in USD major units. */
  benchmarkCpeMajor: number | undefined;
  /** The pixel event this rung corresponds to, where there is one. */
  pixelEvent: string | undefined;
  note: string;
}

export const RUNGS: Record<OptimisationRung, RungSpec> = {
  purchase: {
    id: 'purchase',
    label: 'Purchase',
    costBasis: 'brand_cpa',
    benchmarkCpeMajor: 30,
    pixelEvent: 'PURCHASE',
    note: 'The stage that cannot afford its own learning phase. At a $30 CPA it needs $214/day alone.',
  },
  add_to_cart: {
    id: 'add_to_cart',
    label: 'Add to cart',
    costBasis: 'benchmark',
    benchmarkCpeMajor: 8,
    pixelEvent: 'ADD_TO_CART',
    note:
      "Meta's own remedy for a learning-limited ad set is to move down to a cheaper event, and for brands " +
      'under 5,000 purchases/week the measured efficiency penalty of mid-funnel optimisation is ~5%.',
  },
  view_content: {
    id: 'view_content',
    label: 'View content',
    costBasis: 'benchmark',
    benchmarkCpeMajor: 2,
    pixelEvent: 'VIEW_CONTENT',
    note: 'The cheapest event still tied to a specific product rather than to traffic in general.',
  },
  landing_page_view: {
    id: 'landing_page_view',
    label: 'Landing page view',
    costBasis: 'benchmark',
    benchmarkCpeMajor: 0.8,
    pixelEvent: undefined,
    note:
      'The bottom of the ladder. Optimisation is literal: an ad set told to buy landing page views finds ' +
      'the people most willing to click, who are not the people most willing to buy.',
  },
  lead: {
    id: 'lead',
    label: 'Lead',
    costBasis: 'brand_cpa',
    benchmarkCpeMajor: 6,
    pixelEvent: 'LEAD',
    note: 'Instant-form leads run ~$6 in tier-1 markets; website-form leads ~$20, i.e. $143/day to exit learning.',
  },
  app_install: {
    id: 'app_install',
    label: 'App install',
    costBasis: 'brand_cpa',
    benchmarkCpeMajor: 3,
    pixelEvent: undefined,
    note: 'Cost varies enormously by vertical; the brand CPA is the only honest input.',
  },
  thruplay: {
    id: 'thruplay',
    label: 'ThruPlay',
    costBasis: 'benchmark',
    benchmarkCpeMajor: 0.05,
    pixelEvent: undefined,
    note:
      'Essentially free from a learning-phase standpoint ($0.36/day). Its cost is not budget, it is the ' +
      'selection error you inherit if you then retarget the pool it builds.',
  },
  reach: {
    id: 'reach',
    label: 'Reach',
    costBasis: 'none',
    benchmarkCpeMajor: undefined,
    pixelEvent: undefined,
    note:
      'Not event-limited, so no learning floor applies. The one upper-funnel finding that survives scrutiny: ' +
      'reach-optimised spend measures at a 6.0x incrementality factor versus lower funnel.',
  },
};

/** Cheapest-last. Stepping DOWN this ladder is Meta's own documented remedy for learning-limited. */
export const CONVERSION_LADDER: readonly OptimisationRung[] = [
  'purchase',
  'add_to_cart',
  'view_content',
  'landing_page_view',
];

export const LEAD_LADDER: readonly OptimisationRung[] = ['lead', 'landing_page_view'];
export const TRAFFIC_LADDER: readonly OptimisationRung[] = ['landing_page_view'];
export const APP_LADDER: readonly OptimisationRung[] = ['app_install'];

/** The rung a brand's own archetype sits on before any laddering. */
export function primaryRungFor(archetype: ConversionArchetype): OptimisationRung {
  switch (archetype) {
    case 'website_purchase':
    case 'catalog_sales':
      return 'purchase';
    case 'website_lead':
    case 'instant_form_lead':
    case 'messenger_lead':
    case 'whatsapp_conversation':
    case 'phone_call':
      return 'lead';
    case 'app_install':
      return 'app_install';
    case 'traffic':
      return 'landing_page_view';
  }
}

export function ladderFor(archetype: ConversionArchetype): readonly OptimisationRung[] {
  const primary = primaryRungFor(archetype);
  if (primary === 'purchase') return CONVERSION_LADDER;
  if (primary === 'lead') return LEAD_LADDER;
  if (primary === 'app_install') return APP_LADDER;
  return TRAFFIC_LADDER;
}

/** One rung cheaper, or the same rung when already at the bottom. */
export function oneRungCheaper(
  rung: OptimisationRung,
  ladder: readonly OptimisationRung[],
): OptimisationRung {
  const i = ladder.indexOf(rung);
  if (i < 0 || i + 1 >= ladder.length) return rung;
  return ladder[i + 1] ?? rung;
}

/**
 * All rungs ordered dearest/highest-intent first, ACROSS ladders.
 *
 * The per-archetype ladders are subsets of this order. It exists so a stage's
 * `minimumRung` — which is written as an absolute rung, because a template is written once
 * and runs for every archetype — can be compared with rungs that live on a different ladder.
 */
export const RUNG_ORDER: readonly OptimisationRung[] = [
  'purchase',
  'lead',
  'app_install',
  'add_to_cart',
  'view_content',
  'landing_page_view',
  'thruplay',
  'reach',
];

/**
 * A stage's `minimumRung` expressed in the ladder the brand's archetype actually uses.
 *
 * Without this the guard silently evaporates for every non-purchase brand. `broad_plus_recapture`
 * declares `minimumRung: 'view_content'` for its recapture stage, but a lead brand's ladder is
 * `['lead', 'landing_page_view']` — `view_content` is not on it, `indexOf` returns -1, and the
 * "is this stage below the rung at which it still does its job?" comparison quietly answers no
 * for every budget. A $60/day lead brand then gets told to build a "Recapture" ad set optimising
 * for landing page views, which is the exact structure this module's own documentation calls
 * "not a recapture ad set, it is a second traffic ad set competing for the same auctions".
 *
 * The mapping is: the CHEAPEST rung on the brand's ladder that is still no cheaper than the
 * declared minimum, falling back to the ladder's dearest rung when every rung on it is cheaper.
 * So "no cheaper than view_content" becomes "no cheaper than a lead" on the lead ladder, which
 * is the same intent, and becomes "landing page view" on the traffic ladder, where there is
 * nothing dearer to ask for.
 */
export function effectiveMinimumRung(
  minimum: OptimisationRung,
  ladder: readonly OptimisationRung[],
): OptimisationRung {
  if (ladder.includes(minimum)) return minimum;
  const minRank = RUNG_ORDER.indexOf(minimum);
  let best: OptimisationRung | undefined;
  let bestRank = -1;
  if (minRank >= 0) {
    for (const rung of ladder) {
      const rank = RUNG_ORDER.indexOf(rung);
      if (rank < 0 || rank > minRank) continue;
      if (rank > bestRank) {
        best = rung;
        bestRank = rank;
      }
    }
  }
  return best ?? ladder[0] ?? minimum;
}

// ---------------------------------------------------------------------------
// Audience pools
// ---------------------------------------------------------------------------

export type AudiencePoolId =
  | 'purchasers_180d'
  | 'purchasers_30d'
  | 'site_visitors_30d'
  | 'site_visitors_1d'
  | 'atc_30d'
  | 'video_75_30d'
  | 'video_75_90d'
  | 'warm_union_30d'
  | 'lead_submitters_90d'
  | 'customer_list_value'
  | 'lookalike_campaign_conversions_3pct'
  | 'lookalike_value_3pct';

export type PoolKind = 'website' | 'video' | 'engagement' | 'lookalike' | 'customer_list' | 'union';
export type PoolUse = 'inclusion' | 'exclusion' | 'suggestion' | 'seed';

export interface AudiencePoolSpec {
  id: AudiencePoolId;
  label: string;
  kind: PoolKind;
  retentionDays: number;
  usableAs: readonly PoolUse[];
  /**
   * True when building this pool depends on the video-engagement rule Meta no longer
   * documents. Exactly one template depends on it, and even that one has a documented
   * alternative — so if the live probe of that rule fails, only one template loses a
   * feature rather than the whole funnel layer collapsing.
   */
  undocumentedRule: boolean;
  /** Whether the pool needs to clear the ~1,000-person delivery floor before it is targetable. */
  sizeGated: boolean;
  note: string;
}

export const AUDIENCE_POOLS: Record<AudiencePoolId, AudiencePoolSpec> = {
  purchasers_180d: {
    id: 'purchasers_180d',
    label: 'Purchasers, 180 days',
    kind: 'website',
    retentionDays: 180,
    usableAs: ['exclusion', 'seed'],
    undocumentedRule: false,
    sizeGated: false,
    note:
      'Exclusion windows should be as long as the platform permits — there is no downside to excluding a ' +
      'purchaser for longer, and every day you do not is waste plus attribution pollution. 730 days became ' +
      'available in the UI on 2026-05-18 but the API still documents 1–180; probe before raising it.',
  },
  purchasers_30d: {
    id: 'purchasers_30d',
    label: 'Purchasers, 30 days',
    kind: 'website',
    retentionDays: 30,
    usableAs: ['exclusion'],
    undocumentedRule: false,
    sizeGated: false,
    note: 'Used only to keep a repeat-purchase campaign off people who just bought.',
  },
  site_visitors_30d: {
    id: 'site_visitors_30d',
    label: 'Website visitors, 30 days',
    kind: 'website',
    retentionDays: 30,
    usableAs: ['inclusion', 'exclusion', 'suggestion'],
    undocumentedRule: false,
    sizeGated: true,
    note: 'Purchase-intent half-life. Inclusion windows short, exclusion windows long.',
  },
  site_visitors_1d: {
    id: 'site_visitors_1d',
    label: 'Website visitors, last 1 day',
    kind: 'website',
    retentionDays: 1,
    usableAs: ['exclusion'],
    undocumentedRule: false,
    sizeGated: false,
    note: 'Excluded from bottom-of-funnel because they are mid-session — the ad is buying a conversion in flight.',
  },
  atc_30d: {
    id: 'atc_30d',
    label: 'Add to cart, 30 days',
    kind: 'website',
    retentionDays: 30,
    usableAs: ['inclusion', 'suggestion', 'seed'],
    undocumentedRule: false,
    sizeGated: true,
    note: 'Often the better lookalike seed when the purchase seed is under ~1,000: volume beats purity.',
  },
  video_75_30d: {
    id: 'video_75_30d',
    label: '75% video viewers, 30 days',
    kind: 'video',
    retentionDays: 30,
    usableAs: ['inclusion', 'suggestion', 'seed'],
    undocumentedRule: true,
    sizeGated: true,
    note:
      'Never 25% or 3-second: those encode "scrolls slowly". Even at 75% this is a weak seed — it encodes ' +
      '"watches videos", not "buys" — and its real value is as an exclusion and a cold-start hint.',
  },
  video_75_90d: {
    id: 'video_75_90d',
    label: '75% video viewers, 90 days',
    kind: 'video',
    retentionDays: 90,
    usableAs: ['suggestion', 'seed'],
    undocumentedRule: true,
    sizeGated: true,
    note:
      'The long window exists because the pool is small at cold-start budgets. Retention is the size lever: ' +
      'lengthen the window before raising the budget.',
  },
  warm_union_30d: {
    id: 'warm_union_30d',
    label: 'Warm: site visitors OR add-to-cart OR 75% viewers, 30 days',
    kind: 'union',
    retentionDays: 30,
    usableAs: ['inclusion', 'suggestion'],
    undocumentedRule: false,
    sizeGated: true,
    note:
      'ONE audience, not three ad sets. Multiple entries in custom_audiences are OR-ed at targeting time ' +
      'anyway, and three small ad sets fragment the budget for no gain.',
  },
  lead_submitters_90d: {
    id: 'lead_submitters_90d',
    label: 'Lead form submitters, 90 days',
    kind: 'engagement',
    retentionDays: 90,
    usableAs: ['exclusion', 'seed'],
    undocumentedRule: false,
    sizeGated: false,
    note: '90 days is a HARD cap for lead-ads engagement, much shorter than every other source.',
  },
  customer_list_value: {
    id: 'customer_list_value',
    label: 'Customer list with a value column',
    kind: 'customer_list',
    retentionDays: 0,
    usableAs: ['inclusion', 'seed'],
    undocumentedRule: false,
    sizeGated: false,
    note: 'Requires is_value_based=1 at create and a LOOKALIKE_VALUE column in the upload schema.',
  },
  lookalike_campaign_conversions_3pct: {
    id: 'lookalike_campaign_conversions_3pct',
    label: 'Lookalike 3%, seeded from campaign conversions',
    kind: 'lookalike',
    retentionDays: 0,
    usableAs: ['suggestion'],
    undocumentedRule: false,
    sizeGated: false,
    note:
      'The DOCUMENTED route from "I ran a video-views campaign" to "people like the ones who watched it": ' +
      'lookalike_spec with conversion_type=campaign_conversions and origin_ids=<campaign id>. It needs no ' +
      'video engagement custom audience, so it sidesteps the undocumented rule entirely, and Meta keeps ' +
      'updating the underlying model as the campaign accumulates conversions.',
  },
  lookalike_value_3pct: {
    id: 'lookalike_value_3pct',
    label: 'Value-based lookalike 3%',
    kind: 'lookalike',
    retentionDays: 0,
    usableAs: ['suggestion'],
    undocumentedRule: false,
    sizeGated: false,
    note:
      'One lookalike at ratio 0.03, attached as a suggestion. Not a tier lattice: Advantage+ lookalike is ' +
      'on by default and cannot be disabled when optimising for conversions, so tiers are notional.',
  },
};

/** Pools a prospecting stage must never exclude. Excluding them costs 25–45% of its cheap conversions. */
export const WARM_POOLS: ReadonlySet<AudiencePoolId> = new Set([
  'site_visitors_30d',
  'site_visitors_1d',
  'atc_30d',
  'video_75_30d',
  'video_75_90d',
  'warm_union_30d',
  'lead_submitters_90d',
]);

export const PURCHASER_POOLS: ReadonlySet<AudiencePoolId> = new Set(['purchasers_180d', 'purchasers_30d']);

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export type StageRole =
  | 'prospecting'
  | 'seed'
  | 'harvest'
  | 'recapture'
  | 'tof'
  | 'mof'
  | 'bof'
  | 'existing_customer';

/** Roles whose job is to reach people who have not engaged yet. */
export const PROSPECTING_ROLES: ReadonlySet<StageRole> = new Set(['prospecting', 'seed', 'harvest', 'tof']);
/** Roles whose job is to re-reach warm people. */
export const RETARGETING_ROLES: ReadonlySet<StageRole> = new Set(['recapture', 'mof', 'bof']);

/**
 * An upper-funnel override of the brand's archetype tuple.
 *
 * `destination_type` is deliberately omitted by default rather than inherited. The base
 * archetype's value is legal for its own objective and frequently illegal for
 * `OUTCOME_AWARENESS` — `instant_form_lead` carries `ON_AD`, which awareness does not
 * accept — and Meta rejects the mismatch as a generic code 100 that names nothing.
 */
export interface StageOptimisation {
  objective: Objective;
  optimizationGoal: OptimizationGoal;
  billingEvent: BillingEvent;
  promotedObject: PromotedObjectKind;
  destinationType?: DestinationType;
  note: string;
}

export type RungMode = 'primary' | 'ladder' | 'one_cheaper' | 'fixed';

export interface FunnelStageTemplate {
  id: string;
  role: StageRole;
  label: string;
  /**
   * Campaign grouping key. Two stages NEVER share one in this file, and
   * `validateTemplate` enforces it: under a shared campaign budget the ad set with the
   * largest audience takes the money, which starves every retargeting stage silently.
   */
  campaign: string;
  budgetLevel: 'campaign' | 'adset';
  /** Fraction of total daily budget. Shares across a template sum to 1. */
  budgetShare: number;
  /** `'brand'` = whatever the brand sells. Anything else pins the stage to a fixed archetype. */
  archetype: ConversionArchetype | 'brand';
  optimisation?: StageOptimisation;
  rungMode: RungMode;
  fixedRung?: OptimisationRung;
  /**
   * The cheapest rung at which this stage still does its job.
   *
   * This is the field that turns "the numbers technically work" into an honest answer.
   * Stepping DOWN the ladder is Meta's own remedy for a learning-limited ad set, so every
   * stage is allowed to do it — but only to here. A recapture ad set that can only clear
   * the learning floor by optimising for landing page views is not a recapture ad set; it
   * is a second traffic ad set competing with the prospecting one for the same auctions,
   * and the funnel it belongs to has stopped being a funnel.
   *
   * Expressed as an absolute rung and mapped onto whichever ladder the brand's archetype
   * uses (`effectiveMinimumRung`), because a lead brand has no `view_content` rung and
   * "no cheaper than a lead" is the same intent expressed in its ladder.
   */
  minimumRung: OptimisationRung;
  advantageAudience: 0 | 1;
  /** HARD inclusions. Only meaningful with advantageAudience 0 — enforced by validateTemplate. */
  target: readonly AudiencePoolId[];
  /** Audience suggestions inside Advantage+ audience. Hints, not boundaries. */
  suggest: readonly AudiencePoolId[];
  exclude: readonly AudiencePoolId[];
  /** Pools it would be a mistake to exclude here, checked rather than commented. */
  mustNotExclude: readonly AudiencePoolId[];
  /** Hard stop, in days. Only Seed & Harvest has one, and it is what stops it degenerating. */
  maxDurationDays?: number;
  purpose: string;
}

export type FunnelTemplateId =
  | 'single_engine'
  | 'seed_and_harvest'
  | 'broad_plus_recapture'
  | 'full_three_stage'
  | 'value_ladder';

export interface FunnelTemplate {
  id: FunnelTemplateId;
  name: string;
  who: string;
  /** The figure the research states. Compare it with the arithmetic-derived requirement. */
  declaredMinViableDailyMajor: number;
  stages: readonly FunnelStageTemplate[];
  audiences: readonly AudiencePoolId[];
  /** Warm-pool size below which this template has nobody to talk to. 0 = not applicable. */
  requiresWarmPool: number;
  /** Purchases in the last 180 days this template assumes. */
  requiresPurchaseHistory: number;
  failureMode: string;
  killCriteria: readonly string[];
}

const AWARENESS_THRUPLAY: StageOptimisation = {
  objective: 'OUTCOME_AWARENESS',
  optimizationGoal: 'THRUPLAY',
  billingEvent: 'THRUPLAY',
  promotedObject: 'none',
  note:
    'THRUPLAY is now the ONLY video optimisation goal — TWO_SECOND_CONTINUOUS_VIDEO_VIEWS survives as a ' +
    'billing event only, and billing on it buys volume rather than attention and builds a worthless pool.',
};

const AWARENESS_REACH: StageOptimisation = {
  objective: 'OUTCOME_AWARENESS',
  optimizationGoal: 'REACH',
  billingEvent: 'IMPRESSIONS',
  promotedObject: 'none',
  note:
    'Reach, not ThruPlay. The measured upper-funnel value is in impressions delivered to NEW people ' +
    '(6.0x incrementality factor, 81% new-customer share), not in the retargeting pool that falls out as ' +
    'a by-product. The folk model mistakes the by-product for the point.',
};

export const FUNNEL_TEMPLATES: Record<FunnelTemplateId, FunnelTemplate> = {
  // -------------------------------------------------------------------------
  single_engine: {
    id: 'single_engine',
    name: 'Single Engine',
    who: 'Anyone under ~$50/day. Any brand with no pixel history. Any account in its first 30 days.',
    declaredMinViableDailyMajor: 10,
    requiresWarmPool: 0,
    requiresPurchaseHistory: 0,
    audiences: ['purchasers_180d'],
    stages: [
      {
        id: 'engine',
        role: 'prospecting',
        label: 'Broad conversion campaign',
        campaign: 'A',
        budgetLevel: 'campaign',
        budgetShare: 1,
        archetype: 'brand',
        rungMode: 'ladder',
        minimumRung: 'landing_page_view',
        advantageAudience: 1,
        target: [],
        suggest: [],
        exclude: ['purchasers_180d'],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'video_75_30d', 'atc_30d'],
        purpose:
          'One ad set, 3–6 ads. 100% of the budget lands in one place, so the learning floor is met at the ' +
          'lowest possible total spend, the algorithm does the retargeting internally, and there are no ' +
          'exclusion mistakes to make because there is only one exclusion.',
      },
    ],
    failureMode:
      'The account never generates enough conversion signal to climb back up the ladder and sits on a cheap ' +
      'event forever, buying low-intent traffic. Detect it as a falling conversion rate from the optimisation ' +
      'event through to purchase, week over week.',
    killCriteria: [
      'None. This is the floor state. If it fails, the problem is the offer or the creative, and no funnel ' +
        'was ever going to fix that.',
    ],
  },

  // -------------------------------------------------------------------------
  seed_and_harvest: {
    id: 'seed_and_harvest',
    name: 'Seed & Harvest',
    who: 'A brand-new ad account: no pixel history, no customer list, nothing for Meta to learn from.',
    declaredMinViableDailyMajor: 20,
    requiresWarmPool: 0,
    requiresPurchaseHistory: 0,
    audiences: ['video_75_90d', 'lookalike_campaign_conversions_3pct', 'purchasers_180d'],
    stages: [
      {
        id: 'seed',
        role: 'seed',
        label: 'Seed — video views',
        campaign: 'A',
        budgetLevel: 'adset',
        budgetShare: 0.5,
        archetype: 'brand',
        optimisation: AWARENESS_THRUPLAY,
        rungMode: 'fixed',
        fixedRung: 'thruplay',
        minimumRung: 'thruplay',
        advantageAudience: 1,
        target: [],
        suggest: [],
        exclude: [],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'video_75_90d'],
        maxDurationDays: 45,
        purpose:
          'Buys first-party signal where none exists. The 45-day stop is not a nicety: once the harvest ' +
          'campaign has real conversions, continuing to buy video views is paying for a worse proxy of a ' +
          'thing you now measure directly, and without the stop this template degenerates into the folk funnel.',
      },
      {
        id: 'harvest',
        role: 'harvest',
        label: 'Harvest — conversions',
        campaign: 'B',
        budgetLevel: 'adset',
        budgetShare: 0.5,
        archetype: 'brand',
        rungMode: 'ladder',
        minimumRung: 'landing_page_view',
        advantageAudience: 1,
        target: [],
        suggest: ['lookalike_campaign_conversions_3pct'],
        exclude: ['purchasers_180d'],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'video_75_90d'],
        purpose:
          'Runs indefinitely. The lookalike goes in HERE as a suggestion inside the existing ad set — never ' +
          'as a new ad set, and never as an ad set that targets the video pool directly.',
      },
    ],
    failureMode:
      'Soft remarketing. You optimise for ThruPlays, which finds the people most willing to watch videos, ' +
      'build an audience out of them, and then optimise toward that audience — compounding the selection ' +
      'error. Mitigated by using 75%+ only, by never creating an ad set that targets the pool, and by the ' +
      'hard 45-day stop.',
    killCriteria: [
      'Automatic at day 45.',
      'Earlier if the 75% pool is under 1,000 at day 30 — the seed campaign is not working, stop paying for it.',
      'Earlier if the harvest campaign has accumulated 100+ conversions — real signal exists, the proxy is obsolete.',
    ],
  },

  // -------------------------------------------------------------------------
  broad_plus_recapture: {
    id: 'broad_plus_recapture',
    name: 'Broad + Recapture',
    who: 'An established pixel, 1,000+ people in a 30-day warm pool, and enough budget to feed two ad sets.',
    declaredMinViableDailyMajor: 50,
    requiresWarmPool: AUDIENCE_DELIVERY_FLOOR,
    requiresPurchaseHistory: 0,
    audiences: ['warm_union_30d', 'purchasers_180d', 'site_visitors_1d'],
    stages: [
      {
        id: 'prospecting',
        role: 'prospecting',
        label: 'Prospecting',
        campaign: 'A',
        budgetLevel: 'campaign',
        budgetShare: 0.85,
        archetype: 'brand',
        rungMode: 'ladder',
        minimumRung: 'landing_page_view',
        advantageAudience: 1,
        target: [],
        suggest: [],
        exclude: ['purchasers_180d'],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'video_75_30d', 'atc_30d'],
        purpose: 'The engine. Gets the hook creative.',
      },
      {
        id: 'recapture',
        role: 'recapture',
        label: 'Recapture',
        campaign: 'B',
        budgetLevel: 'adset',
        budgetShare: 0.15,
        archetype: 'brand',
        rungMode: 'one_cheaper',
        minimumRung: 'view_content',
        // Advantage+ audience OFF: this is the one campaign type Meta itself declines to
        // take — "Meta recommends A/B testing with Advantage+ audience for almost all
        // campaign types, except retargeting campaigns."
        advantageAudience: 0,
        target: ['warm_union_30d'],
        suggest: [],
        exclude: ['purchasers_180d', 'site_visitors_1d'],
        mustNotExclude: [],
        purpose:
          'Gets objection-handling, social proof or the offer — different videos, not the same video. Saying ' +
          'a different thing to a different population is the only honest reason to build a second ad set at all.',
      },
    ],
    failureMode:
      'Recapture reports a spectacular ROAS and everyone concludes retargeting is the business. Much of it is ' +
      'demand that would have converted anyway. Diagnose by breaking its results down by attribution setting ' +
      'and looking for a disproportionate 1-day-view concentration.',
    killCriteria: [
      'Warm pool falls below 1,000.',
      'Recapture frequency exceeds ~4/week — you are re-showing to the same people.',
      "Recapture's share of first-touch conversions is under 5% while its last-touch share is high.",
    ],
  },

  // -------------------------------------------------------------------------
  full_three_stage: {
    id: 'full_three_stage',
    name: 'Full Three-Stage Video Funnel',
    who: 'Established account, purchase CPA comfortably under $40, enough creative volume for three distinct messages.',
    declaredMinViableDailyMajor: 500,
    requiresWarmPool: AUDIENCE_DELIVERY_FLOOR,
    requiresPurchaseHistory: 100,
    audiences: [
      'video_75_30d',
      'site_visitors_30d',
      'site_visitors_1d',
      'atc_30d',
      'purchasers_180d',
      'warm_union_30d',
      'lookalike_value_3pct',
    ],
    stages: [
      {
        id: 'tof',
        role: 'tof',
        label: 'Top — reach',
        campaign: 'A',
        budgetLevel: 'adset',
        budgetShare: 0.15,
        archetype: 'brand',
        optimisation: AWARENESS_REACH,
        rungMode: 'fixed',
        fixedRung: 'reach',
        minimumRung: 'reach',
        advantageAudience: 1,
        target: [],
        suggest: [],
        exclude: ['purchasers_180d'],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'video_75_30d', 'atc_30d'],
        purpose: 'Justified by incrementality, not by pool-building. Reach-optimised, never ThruPlay-optimised.',
      },
      {
        id: 'mof',
        role: 'mof',
        label: 'Middle — engaged but has not landed',
        campaign: 'B',
        budgetLevel: 'adset',
        budgetShare: 0.6,
        archetype: 'brand',
        rungMode: 'one_cheaper',
        minimumRung: 'view_content',
        advantageAudience: 1,
        target: [],
        suggest: ['warm_union_30d', 'lookalike_value_3pct'],
        // The site-visitor exclusion is what makes "middle of funnel" mean anything. Without
        // it, MOF and BOF both claim the same conversions and neither can be evaluated.
        exclude: ['purchasers_180d', 'site_visitors_30d'],
        mustNotExclude: [],
        purpose: 'Warm audience as a SUGGESTION, so Advantage+ stays on and the stage is not caged.',
      },
      {
        id: 'bof',
        role: 'bof',
        label: 'Bottom — close',
        campaign: 'C',
        budgetLevel: 'adset',
        budgetShare: 0.25,
        archetype: 'brand',
        rungMode: 'primary',
        minimumRung: 'purchase',
        advantageAudience: 0,
        target: ['site_visitors_30d', 'atc_30d'],
        exclude: ['purchasers_180d', 'site_visitors_1d'],
        suggest: [],
        mustNotExclude: [],
        purpose:
          'The stage that makes the money and the stage that cannot afford its own learning phase. It is why ' +
          'this template has a budget floor at all.',
      },
    ],
    failureMode:
      'Three at once: the bottom stage starves if anyone puts these in one campaign budget; exclusion drift as ' +
      'windows change and the stages start overlapping; and the account looks better than it is because all ' +
      'three stages claim the same conversions.',
    killCriteria: [
      'Collapse to Broad + Recapture if the bottom stage is Learning Limited for 14 consecutive days at full budget.',
      'Collapse if total daily spend falls below 70% of the floor for 7 days.',
      "Collapse if the top stage's contribution cannot be distinguished from zero in a Conversion Lift test — " +
        'and schedule that test as part of the build, because observational analysis of upper funnel is off ' +
        'by roughly 100%.',
    ],
  },

  // -------------------------------------------------------------------------
  value_ladder: {
    id: 'value_ladder',
    name: 'Value Ladder',
    who: '100+ purchasers (ideally 1,000+), a real spread in order value, and an exportable customer list.',
    declaredMinViableDailyMajor: 150,
    requiresWarmPool: 0,
    requiresPurchaseHistory: 100,
    audiences: ['customer_list_value', 'lookalike_value_3pct', 'purchasers_180d', 'purchasers_30d'],
    stages: [
      {
        id: 'value_prospecting',
        role: 'prospecting',
        label: 'Value prospecting',
        campaign: 'A',
        budgetLevel: 'campaign',
        budgetShare: 0.9,
        archetype: 'brand',
        rungMode: 'primary',
        minimumRung: 'purchase',
        advantageAudience: 1,
        target: [],
        suggest: ['lookalike_value_3pct'],
        exclude: ['purchasers_180d'],
        mustNotExclude: ['warm_union_30d', 'site_visitors_30d', 'atc_30d'],
        purpose:
          'A funnel in the VALUE sense rather than the stage sense. The value-based lookalike is the only seed ' +
          'whose encoded behaviour ("buys, and buys a lot") is the behaviour you actually want.',
      },
      {
        id: 'existing_customer',
        role: 'existing_customer',
        label: 'Existing customers — repeat purchase',
        campaign: 'B',
        budgetLevel: 'adset',
        budgetShare: 0.1,
        archetype: 'brand',
        rungMode: 'one_cheaper',
        minimumRung: 'view_content',
        advantageAudience: 0,
        target: ['customer_list_value'],
        suggest: [],
        // Deliberately excludes only RECENT purchasers: this is the one stage whose whole
        // point is to reach people who have already bought.
        exclude: ['purchasers_30d'],
        mustNotExclude: ['purchasers_180d'],
        purpose: 'Upsell and repeat purchase. Capped low because the pool is finite by construction.',
      },
    ],
    failureMode:
      'The value-based lookalike underperforms plain broad — which is the EXPECTED outcome on a mature ' +
      'account — and the seed is doing nothing. Also: value-based seeds are exactly the shape that trips the ' +
      'audience integrity filter if named carelessly.',
    killCriteria: [
      'Drop the lookalike suggestion if prospecting CPA does not improve versus a 14-day pre-period without it.',
      'Removing a suggestion is a targeting edit and WILL reset the learning phase, so test it deliberately.',
    ],
  },
};

export const FUNNEL_TEMPLATE_IDS: readonly FunnelTemplateId[] = [
  'single_engine',
  'seed_and_harvest',
  'broad_plus_recapture',
  'full_three_stage',
  'value_ladder',
];

/** Where a refused template falls back to. Every path terminates at Single Engine. */
export const DOWNGRADE_PATH: Record<FunnelTemplateId, FunnelTemplateId | undefined> = {
  single_engine: undefined,
  seed_and_harvest: 'single_engine',
  broad_plus_recapture: 'single_engine',
  full_three_stage: 'broad_plus_recapture',
  value_ladder: 'broad_plus_recapture',
};

// ---------------------------------------------------------------------------
// Structural validation of the templates themselves
// ---------------------------------------------------------------------------

/**
 * Checks a template against the structural rules the research establishes.
 *
 * These are invariants of the DATA above, so they run in the test suite rather than at
 * runtime. Their value is that the next person to add a template cannot quietly reintroduce
 * the two commonest structural mistakes — excluding warm audiences from prospecting, and
 * putting funnel stages under one campaign budget.
 */
export function validateTemplate(t: FunnelTemplate): string[] {
  const problems: string[] = [];
  const declared = new Set<AudiencePoolId>(t.audiences);

  const shareSum = t.stages.reduce((acc, s) => acc + s.budgetShare, 0);
  if (Math.abs(shareSum - 1) > 1e-9) {
    problems.push(`${t.id}: budget shares sum to ${shareSum}, not 1.`);
  }

  const campaigns = new Set<string>();
  for (const s of t.stages) {
    if (campaigns.has(s.campaign)) {
      problems.push(
        `${t.id}/${s.id}: shares campaign "${s.campaign}" with another stage. Under one campaign budget the ` +
          `ad set with the largest audience takes the money, so a retargeting stage sharing a campaign with a ` +
          `prospecting stage is starved silently. Give every stage its own campaign and put budgets on ad sets.`,
      );
    }
    campaigns.add(s.campaign);

    for (const pool of [...s.target, ...s.suggest, ...s.exclude]) {
      if (!declared.has(pool)) {
        problems.push(`${t.id}/${s.id}: references pool "${pool}" which the template does not declare.`);
      }
    }

    for (const pool of s.target) {
      if (s.exclude.includes(pool)) {
        problems.push(`${t.id}/${s.id}: both targets and excludes "${pool}".`);
      }
    }
    for (const pool of s.mustNotExclude) {
      if (s.exclude.includes(pool)) {
        problems.push(`${t.id}/${s.id}: excludes "${pool}", which it declares it must not exclude.`);
      }
    }

    if (s.target.length > 0 && s.advantageAudience !== 0) {
      problems.push(
        `${t.id}/${s.id}: declares hard inclusions ${s.target.join(', ')} with advantageAudience=1. Under ` +
          `Advantage+ audience an inclusion is a SUGGESTION the delivery system may ignore, so this stage ` +
          `would not have the boundary the plan assumes. Either set advantageAudience=0 or move them to suggest.`,
      );
    }

    if (PROSPECTING_ROLES.has(s.role)) {
      const warm = s.exclude.filter((p) => WARM_POOLS.has(p));
      if (warm.length > 0) {
        problems.push(
          `${t.id}/${s.id}: a ${s.role} stage excludes warm pool(s) ${warm.join(', ')}. A broad ad set already ` +
            `spends 25–45% of its budget on warm people; excluding them removes the cheapest third of its ` +
            `conversions and Meta does not report that it happened.`,
        );
      }
    }

    if (RETARGETING_ROLES.has(s.role)) {
      if (!s.exclude.some((p) => PURCHASER_POOLS.has(p))) {
        problems.push(
          `${t.id}/${s.id}: a ${s.role} stage does not exclude purchasers. Retargeting a converter is pure ` +
            `waste and it pollutes ROAS.`,
        );
      }
    }

    if (s.role === 'mof' && !s.exclude.includes('site_visitors_30d')) {
      problems.push(
        `${t.id}/${s.id}: a middle-of-funnel stage must exclude site visitors, or it re-shows to people who ` +
          `already clicked through and both stages then claim the same conversions.`,
      );
    }

    if (s.role === 'bof' && !s.exclude.includes('site_visitors_1d')) {
      problems.push(
        `${t.id}/${s.id}: a bottom-of-funnel stage should exclude last-1-day visitors — they are mid-session.`,
      );
    }

    if (s.rungMode === 'fixed' && s.fixedRung === undefined) {
      problems.push(`${t.id}/${s.id}: rungMode "fixed" needs a fixedRung.`);
    }
    if (s.budgetShare <= 0 || s.budgetShare > 1) {
      problems.push(`${t.id}/${s.id}: budgetShare ${s.budgetShare} is out of range.`);
    }
  }

  return problems;
}

/** Every exclusion that applies to a stage, resolved to pool specs. */
export function exclusionsFor(template: FunnelTemplate, stageId: string): AudiencePoolSpec[] {
  const stage = template.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new FunnelPlanError(`${template.id} has no stage "${stageId}".`);
  return stage.exclude.map((p) => AUDIENCE_POOLS[p]);
}

// ---------------------------------------------------------------------------
// Archetype resolution
// ---------------------------------------------------------------------------

/**
 * The concrete ODAX tuple a stage publishes with.
 *
 * A funnel stage is an `ArchetypeSpec` plus an audience spec plus a budget share, so this
 * reuses the existing legality matrix rather than re-encoding ODAX rules. Every derived
 * tuple is pushed back through `validateSpec`, which means an upper-funnel override cannot
 * smuggle an illegal objective/destination_type/billing_event combination onto the wire.
 */
export function resolveStageSpec(
  stage: FunnelStageTemplate,
  brandArchetype: ConversionArchetype,
): ArchetypeSpec {
  const base = specFor(stage.archetype === 'brand' ? brandArchetype : stage.archetype);
  const o = stage.optimisation;
  if (o === undefined) return base;

  const derived: ArchetypeSpec = {
    archetype: base.archetype,
    objective: o.objective,
    optimizationGoal: o.optimizationGoal,
    billingEvent: o.billingEvent,
    promotedObject: o.promotedObject,
    confidence: 'inferred',
    note:
      `Funnel stage "${stage.id}" overrides the ${base.archetype} tuple with ${o.objective}/` +
      `${o.optimizationGoal}/${o.billingEvent} and omits destination_type. ${o.note}`,
    ...(o.destinationType !== undefined ? { destinationType: o.destinationType } : {}),
  };
  validateSpec(derived);
  return derived;
}

// ---------------------------------------------------------------------------
// THE budget-adequacy decision
// ---------------------------------------------------------------------------

export interface FunnelBudgetInput {
  /** Total daily budget, major units. */
  dailyBudgetMajor: number;
  /** The brand's archetype, which sets the primary rung and the ladder. */
  archetype: ConversionArchetype;
  /** Target cost per action, major units. Without it the rung benchmark is used and flagged. */
  targetCpaMajor?: number;
  /** Observed costs per event, major units — from Insights, overriding the tier-1 benchmarks. */
  cpeOverridesMajor?: Partial<Record<OptimisationRung, number>>;
  /** For the currency caveat only. Benchmarks are tier-1 USD figures. */
  currency?: string;
}

export interface StageArithmetic {
  stageId: string;
  label: string;
  role: StageRole;
  budgetShare: number;
  stageDailyMajor: number;
  /** The rung this stage ended up on after laddering. */
  rung: OptimisationRung;
  rungLabel: string;
  /** The rung it would have used with unlimited budget. */
  preferredRung: OptimisationRung;
  /** The cheapest rung at which the stage still does its job, ON THIS BRAND'S LADDER. */
  minimumRung: OptimisationRung;
  /** What the template declares, before it is mapped onto this brand's ladder. */
  declaredMinimumRung: OptimisationRung;
  /**
   * True when the budget would have pushed this stage below `minimumRung`. The stage is then
   * held AT its minimum and reported as failing, rather than silently delivered as something
   * that is no longer the stage the plan asked for.
   */
  belowMinimum: boolean;
  laddered: boolean;
  eventLimited: boolean;
  costPerEventMajor: number | undefined;
  eventsNeededPerWeek: number;
  eventsAffordablePerWeek: number | undefined;
  /** 7.14 x CPE — what this ad set needs on its own. */
  stageFloorDailyMajor: number | undefined;
  shortfallDailyMajor: number;
  exitsLearning: boolean;
  /** Total daily budget this one stage implies, given its share. */
  impliedTotalDailyMajor: number | undefined;
  /** The arithmetic, in one line, ready to render. */
  arithmetic: string;
  problem: string | undefined;
}

export interface FunnelBudgetAssessment {
  templateId: FunnelTemplateId;
  templateName: string;
  verdict: 'build' | 'refuse';
  dailyBudgetMajor: number;
  currency: string;
  /** True when benchmarks (tier-1 USD) are being applied to another currency. */
  benchmarksApproximate: boolean;
  stages: StageArithmetic[];
  failingStageIds: string[];
  /** The stage that sets the floor for the whole template. */
  bindingStageId: string | undefined;
  /** What this template actually needs, derived from the arithmetic rather than quoted. */
  requiredDailyMajor: number;
  shortfallDailyMajor: number;
  /** What the research states. Reported alongside so a disagreement is visible, not hidden. */
  declaredMinViableDailyMajor: number;
  /** Ad sets this budget can support without any of them being learning-limited. */
  maxSupportableAdSets: number;
  /** Present when the template is refused. */
  fallbackTemplateId: FunnelTemplateId | undefined;
  /** Sentences a UI can show verbatim. */
  explanation: string[];
}

function cpeFor(rung: OptimisationRung, input: FunnelBudgetInput): number | undefined {
  const spec = RUNGS[rung];
  const override = input.cpeOverridesMajor?.[rung];
  if (override !== undefined) return override;
  if (spec.costBasis === 'none') return undefined;
  if (spec.costBasis === 'brand_cpa') return input.targetCpaMajor ?? spec.benchmarkCpeMajor;
  return spec.benchmarkCpeMajor;
}

function floorDailyFor(cpe: number | undefined): number | undefined {
  return cpe === undefined ? undefined : round2(LEARNING_DAILY_MULTIPLE * cpe);
}

/**
 * The cost per optimisation event this module will use for a rung — the brand's own CPA, an
 * observed override, or the tier-1 benchmark, in that order. `undefined` means the rung is not
 * event-limited at all (Reach), so no learning-phase floor applies to it.
 */
export function costPerEventMajor(
  rung: OptimisationRung,
  input: FunnelBudgetInput,
): number | undefined {
  return cpeFor(rung, input);
}

/** 50/7 x the cost per event: the daily budget ONE ad set needs to exit the learning phase. */
export function learningFloorDailyMajor(
  rung: OptimisationRung,
  input: FunnelBudgetInput,
): number | undefined {
  return floorDailyFor(cpeFor(rung, input));
}

/**
 * Decides whether a multi-stage funnel is appropriate AT ALL, and shows the arithmetic.
 *
 * For every stage: events needed per ad set per week (50) versus events the stage's share
 * of the budget can buy at that stage's cost per event. A stage that can only survive by
 * being pushed below `minimumRung` is refused rather than silently degraded — a "recapture"
 * ad set optimising for landing page views is not a recapture ad set, it is a second
 * traffic ad set competing with the prospecting one for the same auctions.
 */
export function assessFunnelBudget(
  templateId: FunnelTemplateId,
  input: FunnelBudgetInput,
): FunnelBudgetAssessment {
  const template = FUNNEL_TEMPLATES[templateId];
  const total = input.dailyBudgetMajor;
  if (!(total > 0)) throw new FunnelPlanError(`dailyBudgetMajor must be positive, got ${total}.`);

  const currency = (input.currency ?? 'USD').toUpperCase();
  const ladder = ladderFor(input.archetype);
  const primary = primaryRungFor(input.archetype);

  // The anchor is what "one rung cheaper" is measured from. It is resolved first, from the
  // first stage that is allowed to ladder, because a template's lower stages are defined
  // relative to what its main stage actually ended up optimising for.
  let anchor = primary;
  const ladderStage = template.stages.find((s) => s.rungMode === 'ladder');
  if (ladderStage !== undefined) {
    const chosen = chooseRungByLadder(primary, ladder, total * ladderStage.budgetShare, input);
    // Clamped, so the anchor is the rung that stage will actually run at rather than the one
    // the budget alone would have picked. Otherwise a stage held at its minimum still drags
    // every `one_cheaper` stage below it down with it.
    anchor = dearerOf(chosen, effectiveMinimumRung(ladderStage.minimumRung, ladder), ladder);
  }

  const stages: StageArithmetic[] = template.stages.map((s) =>
    assessStage(s, { total, input, ladder, primary, anchor }),
  );

  const failing = stages.filter((s) => s.problem !== undefined);
  const eventLimited = stages.filter((s) => s.eventLimited && s.impliedTotalDailyMajor !== undefined);
  const required =
    eventLimited.length === 0
      ? 0
      : round2(Math.max(...eventLimited.map((s) => s.impliedTotalDailyMajor ?? 0)));
  const binding = eventLimited
    .slice()
    .sort((a, b) => (b.impliedTotalDailyMajor ?? 0) - (a.impliedTotalDailyMajor ?? 0))[0];

  const maxCpe = Math.max(
    0,
    ...stages.map((s) => (s.eventLimited ? (s.costPerEventMajor ?? 0) : 0)),
  );
  const maxSupportableAdSets =
    maxCpe > 0 ? Math.floor(total / (LEARNING_DAILY_MULTIPLE * maxCpe)) : template.stages.length;

  const verdict: 'build' | 'refuse' = failing.length === 0 ? 'build' : 'refuse';
  const fallback = verdict === 'refuse' ? DOWNGRADE_PATH[templateId] : undefined;

  const explanation = buildExplanation({
    template,
    stages,
    failing,
    total,
    required,
    verdict,
    fallback,
    maxSupportableAdSets,
    input,
  });

  return {
    templateId,
    templateName: template.name,
    verdict,
    dailyBudgetMajor: total,
    currency,
    benchmarksApproximate: currency !== 'USD',
    stages,
    failingStageIds: failing.map((s) => s.stageId),
    bindingStageId: binding?.stageId,
    requiredDailyMajor: required,
    shortfallDailyMajor: round2(Math.max(0, required - total)),
    declaredMinViableDailyMajor: template.declaredMinViableDailyMajor,
    maxSupportableAdSets,
    fallbackTemplateId: fallback,
    explanation,
  };
}

interface StageContext {
  total: number;
  input: FunnelBudgetInput;
  ladder: readonly OptimisationRung[];
  primary: OptimisationRung;
  anchor: OptimisationRung;
}

function chooseRungByLadder(
  from: OptimisationRung,
  ladder: readonly OptimisationRung[],
  stageDaily: number,
  input: FunnelBudgetInput,
): OptimisationRung {
  const start = Math.max(0, ladder.indexOf(from));
  let last = from;
  for (let i = start; i < ladder.length; i += 1) {
    const rung = ladder[i];
    if (rung === undefined) continue;
    last = rung;
    const floor = floorDailyFor(cpeFor(rung, input));
    if (floor === undefined || stageDaily >= floor) return rung;
  }
  return last;
}

function assessStage(s: FunnelStageTemplate, ctx: StageContext): StageArithmetic {
  const stageDaily = round2(ctx.total * s.budgetShare);

  let preferred: OptimisationRung;
  let chosen: OptimisationRung;
  switch (s.rungMode) {
    case 'fixed':
      preferred = s.fixedRung ?? ctx.primary;
      chosen = preferred;
      break;
    case 'primary':
      preferred = ctx.primary;
      chosen = preferred;
      break;
    case 'one_cheaper':
      preferred = oneRungCheaper(ctx.anchor, ctx.ladder);
      // "One rung cheaper than the main campaign" is where this stage STARTS, not where it is
      // pinned. Stepping further down is Meta's own remedy for a learning-limited ad set, and
      // the floor below which it stops being this stage is `minimumRung`, enforced below. Pinning
      // it would refuse funnels that work: a brand with a $10 purchase CPA has an add-to-cart
      // benchmark almost as dear as its purchases, so its recapture stage would be declared
      // unaffordable at a budget that pays for ViewContent several times over.
      chosen = chooseRungByLadder(preferred, ctx.ladder, stageDaily, ctx.input);
      break;
    case 'ladder':
      preferred = ctx.primary;
      chosen = chooseRungByLadder(ctx.primary, ctx.ladder, stageDaily, ctx.input);
      break;
  }

  // The minimum, mapped onto this brand's ladder. A rung that is not on the ladder at all
  // (ThruPlay, Reach) is off the scale rather than below it, so it is never "degraded".
  const effectiveMin = effectiveMinimumRung(s.minimumRung, ctx.ladder);
  const chosenIndex = ctx.ladder.indexOf(chosen);
  const minIndex = ctx.ladder.indexOf(effectiveMin);
  const belowMinimum = chosenIndex >= 0 && minIndex >= 0 && chosenIndex > minIndex;

  // A stage is NEVER reported at a rung below the one at which it still does its job. It is
  // held at its minimum and the arithmetic is stated there — which is also the only way
  // `impliedTotalDailyMajor` can be right, because the budget this stage implies is the budget
  // its MINIMUM rung needs, not the budget the too-cheap rung it was about to fall to needs.
  const rung = belowMinimum ? effectiveMin : chosen;

  const cpe = cpeFor(rung, ctx.input);
  const floor = floorDailyFor(cpe);
  const eventLimited = cpe !== undefined;
  const affordable = cpe === undefined ? undefined : round1((stageDaily * 7) / cpe);
  const exits = floor === undefined || stageDaily >= floor;
  const implied = floor === undefined ? undefined : round2(floor / s.budgetShare);

  let problem: string | undefined;
  if (belowMinimum && !exits) {
    problem =
      `"${s.label}" would have to drop to ${RUNGS[chosen].label} to clear the learning phase, but it stops ` +
      `doing its job below ${RUNGS[effectiveMin].label}. At ${RUNGS[effectiveMin].label} ` +
      `(${money(cpe)} each) it needs ${money(floor)}/day of its own; ${pct(s.budgetShare)} of ` +
      `${money(ctx.total)}/day gives it ${money(stageDaily)}/day, which buys ${affordable ?? '?'} events ` +
      `a week against the ${LEARNING_PHASE_EVENTS_PER_WEEK} it needs — ` +
      `${round1(Math.max(0, LEARNING_PHASE_EVENTS_PER_WEEK - (affordable ?? 0)))} short.`;
  } else if (!exits) {
    problem =
      `"${s.label}" cannot exit the learning phase. Optimising for ${RUNGS[rung].label} at ${money(cpe)} ` +
      `each, it needs ${money(floor)}/day; ${pct(s.budgetShare)} of ${money(ctx.total)}/day gives it ` +
      `${money(stageDaily)}/day, which buys ${affordable ?? '?'} events a week against the ` +
      `${LEARNING_PHASE_EVENTS_PER_WEEK} it needs — ` +
      `${round1(Math.max(0, LEARNING_PHASE_EVENTS_PER_WEEK - (affordable ?? 0)))} short.`;
  }

  const arithmetic = eventLimited
    ? `${money(stageDaily)}/day x 7 / ${money(cpe)} per ${RUNGS[rung].label} = ${affordable ?? '?'} events/week ` +
      `vs ${LEARNING_PHASE_EVENTS_PER_WEEK} needed (floor ${money(floor)}/day = ${LEARNING_PHASE_EVENTS_PER_WEEK}/7 x ${money(cpe)})`
    : `${money(stageDaily)}/day, ${RUNGS[rung].label} — not event-limited, so no learning-phase floor applies.`;

  return {
    stageId: s.id,
    label: s.label,
    role: s.role,
    budgetShare: s.budgetShare,
    stageDailyMajor: stageDaily,
    rung,
    rungLabel: RUNGS[rung].label,
    preferredRung: preferred,
    minimumRung: effectiveMin,
    declaredMinimumRung: s.minimumRung,
    belowMinimum,
    laddered: rung !== preferred,
    eventLimited,
    costPerEventMajor: cpe,
    eventsNeededPerWeek: LEARNING_PHASE_EVENTS_PER_WEEK,
    eventsAffordablePerWeek: affordable,
    stageFloorDailyMajor: floor,
    shortfallDailyMajor: floor === undefined ? 0 : round2(Math.max(0, floor - stageDaily)),
    exitsLearning: exits,
    impliedTotalDailyMajor: implied,
    arithmetic,
    problem,
  };
}

interface ExplanationInput {
  template: FunnelTemplate;
  stages: StageArithmetic[];
  failing: StageArithmetic[];
  total: number;
  required: number;
  verdict: 'build' | 'refuse';
  fallback: FunnelTemplateId | undefined;
  maxSupportableAdSets: number;
  input: FunnelBudgetInput;
}

function buildExplanation(e: ExplanationInput): string[] {
  const lines: string[] = [];

  lines.push(
    `Meta's delivery system needs about ${LEARNING_PHASE_EVENTS_PER_WEEK} optimisation events per ad set ` +
      `per week before it stops experimenting, so each ad set needs roughly ` +
      `${round2(LEARNING_DAILY_MULTIPLE)} x its own cost per event, per day.`,
  );

  for (const s of e.stages) lines.push(`${s.label}: ${s.arithmetic}`);

  if (e.verdict === 'refuse') {
    for (const s of e.failing) if (s.problem !== undefined) lines.push(s.problem);
    if (e.required > e.total) {
      lines.push(
        `${e.template.name} needs about ${money(e.required)}/day in total for every stage to clear its own ` +
          `floor. You have ${money(e.total)}/day — ${money(e.required - e.total)}/day short.`,
      );
    }
    if (e.required > e.template.declaredMinViableDailyMajor) {
      lines.push(
        `Note: the playbook figure for ${e.template.name} is ${money(e.template.declaredMinViableDailyMajor)}/day, ` +
          `but at this brand's cost per conversion the arithmetic gives ${money(e.required)}/day. The playbook ` +
          `figure assumes a cheaper conversion than this brand has.`,
      );
    }
    if (e.fallback !== undefined) {
      lines.push(
        `Recommendation: ${FUNNEL_TEMPLATES[e.fallback].name}. ` +
          (e.fallback === 'single_engine'
            ? `One campaign, one ad set, all ${money(e.total)}/day in one place — which is also the structure ` +
              `where the algorithm does the retargeting internally, measured at 25–45% of a broad ad set's budget.`
            : `Fewer stages, each with enough budget to be a real ad set.`),
      );
    } else {
      lines.push(
        `There is no simpler structure to fall back to — this is already one campaign with one ad set. At ` +
          `${money(e.total)}/day the honest answer is that no Meta ad set will exit the learning phase for ` +
          `this conversion. Either raise the budget to ${money(e.required)}/day or accept that delivery will ` +
          `stay unstable.`,
      );
    }
  } else {
    const laddered = e.stages.filter((s) => s.laddered);
    for (const s of laddered) {
      lines.push(
        `${s.label} will optimise for ${s.rungLabel}, not ${RUNGS[s.preferredRung].label}: at ` +
          `${money(s.stageDailyMajor)}/day a ${RUNGS[s.preferredRung].label}-optimised ad set would need ` +
          `${money(floorDailyFor(cpeFor(s.preferredRung, e.input)))}/day. Step it up a rung whenever the ` +
          `current one clears ${LEARNING_PHASE_EVENTS_PER_WEEK}/week for two consecutive weeks.`,
      );
    }
    lines.push(
      `At ${money(e.total)}/day this account can support about ${e.maxSupportableAdSets} ad set(s) at its ` +
        `most expensive optimisation event without any of them being learning-limited.`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Pool forecasting — the OTHER floor, and the one that actually binds at small budgets
// ---------------------------------------------------------------------------

/**
 * Tier-1 assumptions. Every one of these is measurable from Insights and should become a
 * per-brand learned quantity — `p50` above all, since the whole forecast scales linearly
 * with it and it is directly computable as video_p50_watched_actions / impressions.
 */
export const POOL_FORECAST_DEFAULTS = {
  cpmMajor: 12,
  /** Share of impressions reaching 50% completion for a competent 15–30s vertical video. */
  p50: 0.1,
  /** A 75% pool is roughly half a 50% pool. */
  p75Fraction: 0.5,
  frequency: 1.3,
} as const;

export interface PoolForecastInput {
  dailyBudgetMajor: number;
  days: number;
  threshold?: 'p50' | 'p75';
  cpmMajor?: number;
  p50?: number;
  frequency?: number;
  floor?: number;
}

export interface PoolForecast {
  spendMajor: number;
  impressions: number;
  uniquePeople: number;
  floor: number;
  meetsFloor: boolean;
  /** Days at this daily budget before the pool crosses the floor. */
  daysToFloor: number;
  arithmetic: string[];
}

/**
 * Forecasts a video-view pool, so the system can decline to offer a retargeting stage that
 * would contain 400 people instead of discovering it after 30 days of spend.
 *
 * The operational number this produces: roughly $300 of cumulative video spend — about
 * $10/day for 30 days — before a 50% pool crosses 1,000 people in a tier-1 market. Double
 * it for a 75% pool. Below that, a middle-of-funnel stage has nobody in it.
 */
export function forecastVideoPool(input: PoolForecastInput): PoolForecast {
  const cpm = input.cpmMajor ?? POOL_FORECAST_DEFAULTS.cpmMajor;
  const p50 = input.p50 ?? POOL_FORECAST_DEFAULTS.p50;
  const frequency = input.frequency ?? POOL_FORECAST_DEFAULTS.frequency;
  const floor = input.floor ?? AUDIENCE_DELIVERY_FLOOR;
  const threshold = input.threshold ?? 'p50';
  const rate = threshold === 'p50' ? p50 : p50 * POOL_FORECAST_DEFAULTS.p75Fraction;

  const spend = input.dailyBudgetMajor * input.days;
  const impressions = Math.round((spend / cpm) * 1000);
  const unique = Math.round((impressions * rate) / frequency);

  const perDay = (input.dailyBudgetMajor / cpm) * 1000 * (rate / frequency);
  const daysToFloor = perDay > 0 ? Math.ceil(floor / perDay) : Number.POSITIVE_INFINITY;

  return {
    spendMajor: round2(spend),
    impressions,
    uniquePeople: unique,
    floor,
    meetsFloor: unique >= floor,
    daysToFloor,
    arithmetic: [
      `${money(input.dailyBudgetMajor)}/day x ${input.days} days = ${money(spend)} spend`,
      `${money(spend)} / ${money(cpm)} CPM x 1000 = ${impressions.toLocaleString('en-US')} impressions`,
      `${impressions.toLocaleString('en-US')} x ${round2(rate * 100)}% reaching ${threshold} / ${frequency} ` +
        `frequency = ~${unique.toLocaleString('en-US')} people`,
      unique >= floor
        ? `That clears the ${floor}-person floor for reliable delivery.`
        : `That is ${floor - unique} short of the ${floor}-person floor; it needs about ${daysToFloor} days ` +
          `at this budget. Retention window is the cheaper lever than budget: a 90-day window on the same ` +
          `spend holds roughly three times as many people as a 30-day one.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

export interface FunnelInputs {
  dailyBudgetMajor: number;
  archetype: ConversionArchetype;
  targetCpaMajor?: number;
  /** Conversions in the last 180 days. 0 means Meta has nothing to learn from. */
  purchasesLast180d: number;
  /** People in the 30-day warm pool: site visitors OR add-to-cart OR 75% viewers. */
  warmPoolSize: number;
  hasCustomerList: boolean;
  valueSpreadMaterial?: boolean;
  cpeOverridesMajor?: Partial<Record<OptimisationRung, number>>;
  currency?: string;
}

export interface ConsideredTemplate {
  templateId: FunnelTemplateId;
  verdict: 'build' | 'refuse' | 'not_applicable';
  why: string;
}

export interface FunnelRecommendation {
  templateId: FunnelTemplateId;
  template: FunnelTemplate;
  assessment: FunnelBudgetAssessment;
  considered: ConsideredTemplate[];
  /** Non-budget reasons a richer template was skipped — missing pool, missing history. */
  notes: string[];
}

/**
 * Picks a template from measured quantities, then lets the arithmetic veto it.
 *
 * Two properties are deliberate. `single_engine` is reachable from every branch, because
 * the product must be willing to say "you do not need a funnel" and must be able to
 * downgrade an account back into it. And every branch is a function of something measured
 * — budget, history, pool size — never of a user's self-description, because a non-expert
 * cannot answer "are you top-of-funnel focused?" but can answer "what is your budget?".
 */
export function recommendFunnel(inputs: FunnelInputs): FunnelRecommendation {
  const considered: ConsideredTemplate[] = [];
  const notes: string[] = [];
  const budget = inputs.dailyBudgetMajor;

  const budgetInput: FunnelBudgetInput = {
    dailyBudgetMajor: budget,
    archetype: inputs.archetype,
    ...(inputs.targetCpaMajor !== undefined ? { targetCpaMajor: inputs.targetCpaMajor } : {}),
    ...(inputs.cpeOverridesMajor !== undefined ? { cpeOverridesMajor: inputs.cpeOverridesMajor } : {}),
    ...(inputs.currency !== undefined ? { currency: inputs.currency } : {}),
  };

  const primaryCpe = cpeFor(primaryRungFor(inputs.archetype), budgetInput);

  let candidate: FunnelTemplateId;

  if (inputs.purchasesLast180d === 0 && !inputs.hasCustomerList) {
    candidate = budget >= FUNNEL_TEMPLATES.seed_and_harvest.declaredMinViableDailyMajor
      ? 'seed_and_harvest'
      : 'single_engine';
    notes.push(
      candidate === 'seed_and_harvest'
        ? 'No conversion history and no customer list: Meta has nothing to learn from, which is the one ' +
          'situation where buying first-party signal is worth its own campaign.'
        : `No conversion history, and under ${money(FUNNEL_TEMPLATES.seed_and_harvest.declaredMinViableDailyMajor)}` +
          `/day the seed pool never reaches 1,000 people, so the seed campaign would be paying for nothing.`,
    );
  } else if (budget < FUNNEL_TEMPLATES.broad_plus_recapture.declaredMinViableDailyMajor) {
    candidate = 'single_engine';
    notes.push(
      `Under ${money(FUNNEL_TEMPLATES.broad_plus_recapture.declaredMinViableDailyMajor)}/day a second ad ` +
        `set takes budget away from the one that converts without being able to ` +
        `reach its own floor. Meta's own consolidation guidance says the same thing from the other direction: ` +
        `"when you run too many ad sets at the same time, each one gets fewer opportunities to learn".`,
    );
  } else if (inputs.warmPoolSize < AUDIENCE_DELIVERY_FLOOR) {
    candidate = 'single_engine';
    notes.push(
      `The 30-day warm pool holds ${inputs.warmPoolSize} people, ` +
        `${AUDIENCE_DELIVERY_FLOOR - inputs.warmPoolSize} short of the ${AUDIENCE_DELIVERY_FLOOR} at which ` +
        `Meta delivers reliably. A recapture stage would have nobody in it. It will be added automatically ` +
        `once the pool gets there.`,
    );
  } else if (
    inputs.purchasesLast180d >= FUNNEL_TEMPLATES.value_ladder.requiresPurchaseHistory &&
    inputs.hasCustomerList &&
    inputs.valueSpreadMaterial === true &&
    budget >= FUNNEL_TEMPLATES.value_ladder.declaredMinViableDailyMajor
  ) {
    candidate = 'value_ladder';
    notes.push('Real purchase history plus a value spread: the only seed whose behaviour is the behaviour you want.');
  } else if (
    budget >= FUNNEL_TEMPLATES.full_three_stage.declaredMinViableDailyMajor &&
    primaryCpe !== undefined &&
    primaryCpe <= FULL_THREE_STAGE_MAX_CPA_MAJOR
  ) {
    candidate = 'full_three_stage';
  } else {
    candidate = 'broad_plus_recapture';
    if (
      budget >= FUNNEL_TEMPLATES.full_three_stage.declaredMinViableDailyMajor &&
      primaryCpe !== undefined
    ) {
      notes.push(
        `The budget would reach the three-stage template, but at ${money(primaryCpe)} per ` +
          `${RUNGS[primaryRungFor(inputs.archetype)].label} the bottom stage needs ` +
          `${money(floorDailyFor(primaryCpe))}/day of its own — the template is only offered under ` +
          `${money(FULL_THREE_STAGE_MAX_CPA_MAJOR)}. The extra stage would be paid for out of the stage ` +
          `that converts.`,
      );
    }
  }

  // Now let the arithmetic veto it, walking down the fallback chain until something holds.
  let current: FunnelTemplateId = candidate;
  let assessment = assessFunnelBudget(current, budgetInput);
  const guard = new Set<FunnelTemplateId>();

  while (assessment.verdict === 'refuse' && !guard.has(current)) {
    guard.add(current);
    considered.push({
      templateId: current,
      verdict: 'refuse',
      why: assessment.explanation.filter((l) => l.includes('short') || l.startsWith('Recommendation')).join(' '),
    });
    const next = DOWNGRADE_PATH[current];
    if (next === undefined) break;
    current = next;
    assessment = assessFunnelBudget(current, budgetInput);
  }

  considered.push({
    templateId: current,
    verdict: assessment.verdict,
    why:
      assessment.verdict === 'build'
        ? `Every stage clears its own learning-phase floor at ${money(budget)}/day.`
        : `Even this structure cannot clear the floor at ${money(budget)}/day.`,
  });

  return {
    templateId: current,
    template: FUNNEL_TEMPLATES[current],
    assessment,
    considered,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The easy-options surface
// ---------------------------------------------------------------------------

/**
 * The user's whole decision surface. Four questions, three of which have obvious answers.
 *
 * Deliberately no "which funnel do you want?". A non-expert cannot answer that, the answer
 * is derivable from things the system can measure, and offering the choice would mean
 * offering structures the arithmetic says cannot work.
 */
export type EasyGoal = 'sales' | 'leads' | 'form_leads' | 'messages' | 'calls' | 'traffic' | 'app';

/** What the brand already has. The one genuinely unmeasurable input at cold start. */
export type EasyAssets = 'nothing' | 'video_views' | 'website_traffic' | 'customers';

export const EASY_GOAL_ARCHETYPE: Record<EasyGoal, ConversionArchetype> = {
  sales: 'website_purchase',
  leads: 'website_lead',
  form_leads: 'instant_form_lead',
  messages: 'messenger_lead',
  calls: 'phone_call',
  traffic: 'traffic',
  app: 'app_install',
};

export const EASY_GOAL_LABEL: Record<EasyGoal, string> = {
  sales: 'Sell something on my website',
  leads: 'Get enquiries through my website',
  form_leads: 'Collect enquiries without a website',
  messages: 'Start conversations in Messenger',
  calls: 'Get phone calls',
  traffic: 'Get visits to my site',
  app: 'Get app installs',
};

export const EASY_ASSETS_LABEL: Record<EasyAssets, string> = {
  nothing: "I'm starting from scratch",
  video_views: "I've run video ads before",
  website_traffic: 'I get website traffic already',
  customers: 'I have a customer list',
};

export interface EasyOptions {
  goal: EasyGoal;
  /** Minor units, in the ad account's currency — the same unit the brand's spend envelope uses. */
  dailyBudgetMinor: number;
  currency: string;
  /** Required for any currency where Meta's offset table and ISO 4217 disagree. */
  currencyOffset?: number;
  targetCpaMinor?: number;
  assets: EasyAssets;
  /** Measured. Defaults are derived from `assets` when absent, and flagged as assumptions. */
  warmPoolSize?: number;
  purchasesLast180d?: number;
  valueSpreadMaterial?: boolean;
}

export interface ResolvedStage {
  stage: FunnelStageTemplate;
  /** The validated ODAX tuple this stage publishes with. */
  spec: ArchetypeSpec;
  dailyBudgetMinor: number;
  arithmetic: StageArithmetic;
  targetPools: AudiencePoolSpec[];
  suggestPools: AudiencePoolSpec[];
  excludePools: AudiencePoolSpec[];
}

export interface FunnelPlan {
  templateId: FunnelTemplateId;
  template: FunnelTemplate;
  archetype: ConversionArchetype;
  stages: ResolvedStage[];
  assessment: FunnelBudgetAssessment;
  recommendation: FunnelRecommendation;
  /** Pools that must exist and be ready before any of these ad sets is published. */
  audiencesToBuild: AudiencePoolSpec[];
  /** Present when even the recommended structure cannot clear its floor. */
  refusal: string | undefined;
  warnings: string[];
}

/**
 * Resolves the user's few choices into a concrete, publishable plan — or into a refusal
 * with the reasoning attached.
 */
export function resolveEasyOptions(o: EasyOptions): FunnelPlan {
  const offset = o.currencyOffset ?? currencyOffset(o.currency);
  const budgetMajor = o.dailyBudgetMinor / offset;
  if (!(budgetMajor > 0)) {
    throw new FunnelPlanError(`dailyBudgetMinor ${o.dailyBudgetMinor} must be positive.`);
  }

  const archetype = EASY_GOAL_ARCHETYPE[o.goal];
  const warnings: string[] = [];

  const purchases = o.purchasesLast180d ?? (o.assets === 'customers' ? 100 : 0);
  if (o.purchasesLast180d === undefined) {
    warnings.push(
      `purchasesLast180d was not supplied; assumed ${purchases} from "${EASY_ASSETS_LABEL[o.assets]}". Read it ` +
        `from Insights before publishing — the template choice turns on it.`,
    );
  }

  const warmDefaults: Record<EasyAssets, number> = {
    nothing: 0,
    video_views: 0,
    website_traffic: AUDIENCE_DELIVERY_FLOOR,
    customers: AUDIENCE_DELIVERY_FLOOR,
  };
  const warmPool = o.warmPoolSize ?? warmDefaults[o.assets];
  if (o.warmPoolSize === undefined) {
    warnings.push(
      `warmPoolSize was not supplied; assumed ${warmPool} from "${EASY_ASSETS_LABEL[o.assets]}". This is the ` +
        `number that decides whether a recapture stage has anybody in it — measure it, do not assume it.`,
    );
  }

  const recommendation = recommendFunnel({
    dailyBudgetMajor: budgetMajor,
    archetype,
    purchasesLast180d: purchases,
    warmPoolSize: warmPool,
    hasCustomerList: o.assets === 'customers',
    currency: o.currency,
    ...(o.targetCpaMinor !== undefined ? { targetCpaMajor: o.targetCpaMinor / offset } : {}),
    ...(o.valueSpreadMaterial !== undefined ? { valueSpreadMaterial: o.valueSpreadMaterial } : {}),
  });

  const template = recommendation.template;
  const assessment = recommendation.assessment;

  const shares = template.stages.map((s) => s.budgetShare);
  const minorBudgets = splitMinor(o.dailyBudgetMinor, shares);

  const stages: ResolvedStage[] = template.stages.map((s, i) => {
    const arithmetic = assessment.stages.find((a) => a.stageId === s.id);
    if (arithmetic === undefined) throw new FunnelPlanError(`no arithmetic for stage ${s.id}`);
    return {
      stage: s,
      spec: resolveStageSpec(s, archetype),
      dailyBudgetMinor: minorBudgets[i] ?? 0,
      arithmetic,
      targetPools: s.target.map((p) => AUDIENCE_POOLS[p]),
      suggestPools: s.suggest.map((p) => AUDIENCE_POOLS[p]),
      excludePools: s.exclude.map((p) => AUDIENCE_POOLS[p]),
    };
  });

  const audiencesToBuild = template.audiences.map((p) => AUDIENCE_POOLS[p]);
  for (const pool of audiencesToBuild) {
    if (pool.undocumentedRule) {
      warnings.push(
        `"${pool.label}" is built with the video-engagement rule Meta no longer documents. Probe it against a ` +
          `hand-created audience before relying on it; the lookalike route via campaign conversions is the ` +
          `documented alternative.`,
      );
    }
  }

  if (assessment.benchmarksApproximate) {
    warnings.push(
      `Cost-per-event benchmarks are tier-1 US figures applied to a ${o.currency} account. Replace them with ` +
        `observed costs from Insights (cpeOverridesMajor) before treating the floors as exact.`,
    );
  }

  return {
    templateId: recommendation.templateId,
    template,
    archetype,
    stages,
    assessment,
    recommendation,
    audiencesToBuild,
    refusal: assessment.verdict === 'refuse' ? assessment.explanation.join(' ') : undefined,
    warnings,
  };
}

/** Splits a minor-unit total by share, giving the rounding remainder to the largest stage. */
export function splitMinor(totalMinor: number, shares: readonly number[]): number[] {
  const raw = shares.map((s) => Math.floor(totalMinor * s));
  const used = raw.reduce((a, b) => a + b, 0);
  let remainder = totalMinor - used;
  if (remainder === 0 || raw.length === 0) return raw;

  const order = shares
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
  let k = 0;
  while (remainder > 0) {
    const idx = order[k % order.length] ?? 0;
    raw[idx] = (raw[idx] ?? 0) + 1;
    remainder -= 1;
    k += 1;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Whichever of two on-ladder rungs is dearer (earlier on the ladder). */
function dearerOf(
  a: OptimisationRung,
  b: OptimisationRung,
  ladder: readonly OptimisationRung[],
): OptimisationRung {
  const ia = ladder.indexOf(a);
  const ib = ladder.indexOf(b);
  if (ia < 0) return b;
  if (ib < 0) return a;
  return ia <= ib ? a : b;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function money(n: number | undefined): string {
  if (n === undefined) return 'n/a';
  return `$${round2(n).toFixed(2)}`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
