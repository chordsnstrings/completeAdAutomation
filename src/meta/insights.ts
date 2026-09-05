/**
 * Insights sync and the metric store — the read path the autonomy loop learns from.
 *
 * Two halves, and the split is the point.
 *
 *  1. **Reading.** `GET|POST /{object_id}/insights`, sync and async, with every
 *     parameter Meta silently ignores or silently empties refused at build time rather
 *     than discovered at 3am. A malformed insights query does not just fail — it
 *     *reduces your quota* (`ads_insights = ... - 0.001 * UserErrors`), so validation
 *     here is cheaper than a retry.
 *
 *  2. **Storing.** APPEND-ONLY SNAPSHOTS. This is the central design decision of the
 *     module and it is not negotiable: Meta's own guarantee is *"Insights refresh every
 *     15 minutes and do not change after 28 days of being reported"*, which means a row
 *     you fetched on Tuesday is a DIFFERENT row on Thursday. A store keyed
 *     `(ad_id, date)` and upserted in place answers "what is true now" and destroys the
 *     only question an autonomous system must be auditable on: *what did we believe when
 *     we spent the money?* So the identity is
 *     `(level, object_id, stat_date, attribution_setting, breakdown_key, observed_at)`
 *     and nothing is ever overwritten. `asOf()` replays the world as it looked at any
 *     past instant; `history()` shows the restatement trail for one cell.
 *
 * Sources — docs/research/meta-insights-measurement.md (§1 endpoint, §2 fields and
 * AdsActionStats parsing, §3 breakdowns, §4 attribution, §5 settling, §7 async jobs,
 * §8 ranking diagnostics, §11 rate limits, §12 gotchas), docs/research/00-SYNTHESIS.md
 * (§2.6 what is permanently gone, step 16/17 of the pipeline) and
 * docs/research/autonomous-optimization-science.md §5 (the completion curve).
 *
 * Three conventions run through the file:
 *
 *  - **`attribution_setting` is identity, not decoration.** Rows in one response can be
 *    attributed differently because each ad set carries its own setting. Aggregating
 *    across differing settings produces a number that means nothing, so the store keeps
 *    the setting in the key and `assertHomogeneousAttribution` refuses the aggregation.
 *  - **Absence is `undefined`, never `0` and never `NaN`.** Every accessor here
 *    distinguishes "Meta did not report this" from "Meta reported zero", because the
 *    difference between them is the difference between a paused ad and a bad ad.
 *  - **Where the research says UNVERIFIED, this code says UNVERIFIED** — as a warning
 *    the caller can log, or as a refusal. It never quietly picks a value.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error class, carrying the offending parameter or field.
 *
 * `field` is the Meta parameter name (`breakdowns`, `action_attribution_windows`) rather
 * than our own input name, because the person reading the log is holding Meta's
 * reference page, not this file.
 */
export class InsightsError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(field ? `${field}: ${message}` : message);
    this.name = 'InsightsError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new InsightsError(message, field);
}

// ---------------------------------------------------------------------------
// Levels, presets, windows — the enums Meta actually accepts today
// ---------------------------------------------------------------------------

export const INSIGHTS_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const;
export type InsightsLevel = (typeof INSIGHTS_LEVELS)[number];

/**
 * `level` and the node you call are ORTHOGONAL. `act_X/insights?level=ad` returns one
 * row per ad in the whole account, which is one request instead of N and is the only
 * shape that fits inside the insights quota for a fleet of accounts.
 */
const ID_FIELD_BY_LEVEL: Readonly<Record<InsightsLevel, string>> = {
  account: 'account_id',
  campaign: 'campaign_id',
  adset: 'adset_id',
  ad: 'ad_id',
};

/** v26.0 `date_preset` enum, exhaustive. Note there is no `lifetime` any more. */
export const DATE_PRESETS = [
  'today', 'yesterday', 'this_week_mon_today', 'this_week_sun_today', 'last_week_mon_sun',
  'last_week_sun_sat', 'this_month', 'last_month', 'this_quarter', 'last_quarter',
  'this_year', 'last_year', 'last_3d', 'last_7d', 'last_14d', 'last_28d', 'last_30d',
  'last_90d', 'maximum', 'data_maximum',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

/**
 * Attribution windows that still return data.
 *
 * `7d_view` and `28d_view` were NOT removed from the schema — they parse, they are
 * accepted, and since 2026-01-12 they return nothing. A system that requests them gets
 * no error and a fraction of the truth, so they are refused here instead.
 */
export const LIVE_ATTRIBUTION_WINDOWS = ['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev'] as const;
export type AttributionWindow = (typeof LIVE_ATTRIBUTION_WINDOWS)[number];

/**
 * Accepted by Meta, returns no data since 2026-01-12. Requesting one is a silent lie.
 *
 * The `*_all_conversions` / `*_first_conversion` variants of the same two windows are in
 * here too. The 2025-10-16 announcement removes the 7-day and 28-day view-through
 * *windows*, and a variant of a window with no data cannot have data — but Meta never
 * enumerated the variants, so they are listed explicitly rather than matched by prefix,
 * which would also catch `7d_view` spellings that do not exist.
 */
export const DEAD_ATTRIBUTION_WINDOWS: ReadonlySet<string> = new Set([
  '7d_view',
  '28d_view',
  '7d_view_all_conversions',
  '28d_view_all_conversions',
  '7d_view_first_conversion',
  '28d_view_first_conversion',
]);

/**
 * Parameters Meta disregards since 2025-06-10. Passing them is not an error; it is
 * dead code that makes a reader believe attribution is under their control when it is
 * not. Refused so nobody builds a mental model on top of them.
 */
export const IGNORED_INSIGHTS_PARAMS: ReadonlySet<string> = new Set([
  'use_unified_attribution_setting',
  'action_report_time',
]);

/** Dead since 2026-06-22. Market-level data now comes from `comscore_market`. */
const RETIRED_BREAKDOWNS: ReadonlyMap<string, string> = new Map([
  ['dma', 'comscore_market (breakdowns=dma was retired 2026-06-22; the public breakdowns reference is stale and still documents it)'],
]);

/**
 * Breakdowns that require a manual Ads Manager opt-in for non-sales-supported accounts
 * since 2026-08-06. A sync request from a non-opted-in account returns NO RESULTS, not
 * an error — which reads exactly like "this ad had no delivery". Warned, not refused,
 * because an opted-in account may legitimately use them.
 */
export const OPT_IN_GATED_BREAKDOWNS: ReadonlySet<string> = new Set([
  'impression_device',
  'hourly_stats_aggregated_by_audience_time_zone',
  'frequency_value',
]);

/** Unique/de-duplicated fields. Hourly breakdowns return 0 for these rather than erroring. */
const UNIQUE_FIELDS: ReadonlySet<string> = new Set(['reach', 'frequency', 'cpp']);

const HOURLY_BREAKDOWNS: ReadonlySet<string> = new Set([
  'hourly_stats_aggregated_by_advertiser_time_zone',
  'hourly_stats_aggregated_by_audience_time_zone',
]);

/**
 * The field set a creative decision actually needs.
 *
 * Deliberately not "everything": each extra field widens the query, and error
 * `100 / 1487534` ("data-per-call limit exceeded") has no published row threshold, so
 * the only defence is not asking for what you will not read.
 *
 * `attribution_setting` is in here because it is part of the metric's identity (§4.5)
 * — `buildInsightsRequest` re-adds it even if a caller strips it.
 */
export const CREATIVE_DECISION_FIELDS: readonly string[] = [
  // Delivery.
  'impressions', 'reach', 'frequency', 'spend',
  // Clicks. `ctr` counts ALL clicks; `inline_link_clicks` is the Ads Manager "Link
  // clicks" number. Comparing one to a benchmark quoted on the other is meaningless.
  'clicks', 'inline_link_clicks', 'ctr', 'inline_link_click_ctr', 'cpc', 'cpm',
  // Conversions. Structured list<AdsActionStats> — never summed, always read by name.
  'actions', 'action_values', 'purchase_roas', 'cost_per_action_type',
  // Video: the highest-information signal for generated creative.
  'video_play_actions', 'video_thruplay_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions',
  // Ranking diagnostics. Ad-level only, absent below ~500 impressions, no published enum.
  'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
  // Identity and provenance.
  'attribution_setting', 'date_start', 'date_stop', 'account_currency',
];

/**
 * Filter to objects that could plausibly have delivered. Meta's own rate-limit guidance
 * is *"use filtering to retrieve only objects with data"*, and archived/deleted objects
 * otherwise turn up in daily pulls.
 */
export const DELIVERING_STATUS_FILTER: InsightsFilter = {
  field: 'ad.effective_status',
  operator: 'IN',
  value: ['ACTIVE', 'PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'],
};

export interface InsightsFilter {
  field: string;
  operator: string;
  value: string | number | readonly (string | number)[];
}

// ---------------------------------------------------------------------------
// Attribution regime — the stamp that makes cross-era comparison possible
// ---------------------------------------------------------------------------

export const ATTRIBUTION_REGIMES = {
  /** Before 2026-01-12: 7d_view and 28d_view still returned data. */
  PRE_VIEW_REMOVAL: 'pre-2026-01-12',
  /** 7d_view / 28d_view return nothing. Reported conversions fell 15–40% for view-heavy accounts. */
  VIEW_WINDOWS_REMOVED: '2026-01-12-view-removed',
  /** Click-through narrowed to link clicks; shares/saves/likes moved to `1d_ev`. */
  ENGAGE_THROUGH: '2026-03-engage-through',
} as const;
export type AttributionRegime = (typeof ATTRIBUTION_REGIMES)[keyof typeof ATTRIBUTION_REGIMES];

const VIEW_REMOVAL_DATE = '2026-01-12';

/**
 * UNVERIFIED boundary. Meta announced engage-through "rolling out from March 2026" and
 * said explicitly that rollout timing varies per advertiser; the help-centre pages that
 * would pin it are JS-rendered and could not be read. So this date is a nominal
 * boundary, not a fact: two rows either side of it may or may not be in different
 * regimes. Treat comparisons that straddle it as suspect regardless of the stamp.
 */
export const ENGAGE_THROUGH_ROLLOUT_START = '2026-03-01';

/**
 * Which attribution regime a stat date belongs to.
 *
 * Stamped on every snapshot so that the 2026-01-12 and March-2026 discontinuities are
 * *queryable* rather than mysterious. Without it, a model trained across either date is
 * fitting two different random variables and nobody can tell.
 */
export function attributionRegime(statDate: string): AttributionRegime {
  assertDate('stat_date', statDate);
  if (statDate < VIEW_REMOVAL_DATE) return ATTRIBUTION_REGIMES.PRE_VIEW_REMOVAL;
  if (statDate < ENGAGE_THROUGH_ROLLOUT_START) return ATTRIBUTION_REGIMES.VIEW_WINDOWS_REMOVED;
  return ATTRIBUTION_REGIMES.ENGAGE_THROUGH;
}

// ---------------------------------------------------------------------------
// Naive date helpers
// ---------------------------------------------------------------------------

/**
 * Insights `date_start`/`date_stop` are naive `YYYY-MM-DD` strings in the AD ACCOUNT's
 * timezone, with no zone suffix. Everything here therefore works on the strings and
 * refuses to invent a timezone. Callers that need "today" must resolve it from the
 * account's `timezone_name` themselves — a UTC-based scheduler systematically fetches a
 * shifted "yesterday", which is a subtle permanent error.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(field: string, value: string): void {
  if (!DATE_RE.test(value)) {
    fail(field, `"${value}" is not a naive YYYY-MM-DD date. Insights dates carry no timezone.`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || toDateString(ms) !== value) {
    fail(field, `"${value}" is not a real calendar date.`);
  }
}

function toDateString(msUtc: number): string {
  const iso = new Date(msUtc).toISOString();
  return iso.slice(0, 10);
}

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`, both naive `YYYY-MM-DD`. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  assertDate('from', from);
  assertDate('to', to);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Shifts a naive date by whole days. */
export function addDays(date: string, days: number): string {
  assertDate('date', date);
  return toDateString(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

/**
 * Meta freezes a row 28 days after its stat date: *"Insights ... do not change after 28
 * days of being reported"*. Rows older than that are safe to stop re-fetching, which is
 * also the single biggest quota saving available.
 */
export const SETTLED_AFTER_DAYS = 28;

export function isSettled(statDate: string, asOfDate: string): boolean {
  return daysBetween(statDate, asOfDate) >= SETTLED_AFTER_DAYS;
}

/**
 * The rolling window every sync must re-fetch. A 7-day re-fetch is the commonest
 * under-specification in this whole system and it permanently loses 5–15% of reported
 * conversions, because a click on day D can convert on D+27 and is retro-credited to D.
 */
export function rollingWindow(asOfDate: string, days = SETTLED_AFTER_DAYS): { since: string; until: string } {
  return { since: addDays(asOfDate, -(days - 1)), until: asOfDate };
}

// ---------------------------------------------------------------------------
// Row and action-stat shapes
// ---------------------------------------------------------------------------

/**
 * One entry of a `list<AdsActionStats>` field.
 *
 * Keyed by the active `action_breakdowns` (default `action_type`) plus one key per
 * requested attribution window. Meta OMITS a window key rather than sending zero, so a
 * missing key is ambiguous between "not requested" and "no conversions" — the accessors
 * below return `undefined` for both and let the caller, who knows what it asked for,
 * decide which it is.
 */
export interface ActionStat {
  readonly action_type?: string;
  readonly value?: string;
  readonly [key: string]: unknown;
}

/** One row of the `data` array. Untyped beyond the keys we key decisions off. */
export interface InsightsRow {
  readonly date_start?: string;
  readonly date_stop?: string;
  readonly attribution_setting?: string;
  readonly account_id?: string;
  readonly campaign_id?: string;
  readonly adset_id?: string;
  readonly ad_id?: string;
  readonly spend?: string;
  readonly impressions?: string;
  readonly actions?: readonly ActionStat[];
  readonly [key: string]: unknown;
}

interface PagedResponse {
  data?: unknown;
  paging?: { next?: unknown; cursors?: { after?: unknown } };
}

// ---------------------------------------------------------------------------
// Typed accessors — because callers constantly mis-sum `actions`
// ---------------------------------------------------------------------------

/**
 * Parses a Meta "numeric string" without ever producing NaN.
 *
 * Every scalar metric comes back as a string (`"spend": "5339.5"`). `Number("")` is 0
 * and `Number(undefined)` is NaN, and both of those silently poison an average. This
 * returns `undefined` for anything that is not a finite number.
 */
export function parseNumeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Insights `spend` is a decimal string in MAJOR units (`"5339.5"` is $5,339.50) while
 * budgets are written in the currency's MINOR units. Write cents, read dollars — this
 * asymmetry is the highest-value gotcha in the whole API.
 */
export function spendMajor(row: InsightsRow): number | undefined {
  return parseNumeric(row['spend']);
}

function statsFor(row: InsightsRow, field: string): readonly ActionStat[] {
  const raw = row[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is ActionStat => typeof s === 'object' && s !== null);
}

/** Every distinct `action_type` present on a row. Use it to learn an account's roll-up membership empirically. */
export function actionTypes(row: InsightsRow, field = 'actions'): string[] {
  const seen = new Set<string>();
  for (const s of statsFor(row, field)) {
    if (typeof s.action_type === 'string') seen.add(s.action_type);
  }
  return [...seen].sort();
}

export interface ActionLookup {
  /** Which `list<AdsActionStats>` field to read. Default `actions`. */
  field?: string;
  /**
   * Read a specific attribution window key (`7d_click`) instead of `value`.
   *
   * A specific window is attribution-SETTING independent, which is the only way to
   * aggregate rows whose ad sets disagree — see `assertHomogeneousAttribution`.
   */
  window?: AttributionWindow;
}

/**
 * Reads ONE named action type out of a `list<AdsActionStats>` field.
 *
 * The single biggest parsing mistake in this API is summing `actions[].value`. The array
 * contains overlapping roll-ups — `omni_purchase` spans web, app, offline and shops,
 * and adding it to `offsite_conversion.fb_pixel_purchase` double-counts. There is
 * deliberately no "sum the actions" function in this module. Pick exactly one
 * action_type per KPI and hard-code it.
 *
 * (Which types nest inside which is UNVERIFIED — Meta's AdsActionStats reference does
 * not document the roll-up membership and does not even list a bare `purchase` type.
 * Enumerate `actionTypes()` on a live account before assuming.)
 *
 * Returns `undefined` when the action type is absent or the window key is missing —
 * never 0, never NaN.
 */
export function actionValue(row: InsightsRow, actionType: string, opts: ActionLookup = {}): number | undefined {
  const window = opts.window;
  if (window !== undefined && DEAD_ATTRIBUTION_WINDOWS.has(window)) {
    fail('window', deadWindowMessage(window));
  }
  const key = window ?? 'value';
  for (const stat of statsFor(row, opts.field ?? 'actions')) {
    if (stat.action_type === actionType) return parseNumeric(stat[key]);
  }
  return undefined;
}

/** Attributed conversion VALUE (revenue) for one action type, from `action_values`. */
export function actionValueAmount(row: InsightsRow, actionType: string, opts: ActionLookup = {}): number | undefined {
  return actionValue(row, actionType, { ...opts, field: opts.field ?? 'action_values' });
}

export interface CostPerActionOptions extends ActionLookup {
  /**
   * `reported` (default) reads Meta's own `cost_per_action_type`. `derived` computes
   * `spend / actions[type]`.
   *
   * They legitimately disagree — the numerator dedup rules differ — so this is an
   * explicit choice rather than a fallback. A silent fallback would mean the same
   * dashboard column changed definition depending on what Meta happened to return.
   */
  source?: 'reported' | 'derived';
}

/**
 * Cost per one named action, handling absence rather than returning NaN.
 *
 * `undefined` when the action is absent, when spend is absent, or when the action count
 * is zero (dividing by it would manufacture Infinity, which sorts as "worst" and would
 * get a perfectly good new ad killed).
 */
export function costPerAction(
  row: InsightsRow,
  actionType: string,
  opts: CostPerActionOptions = {},
): number | undefined {
  if ((opts.source ?? 'reported') === 'reported') {
    return actionValue(row, actionType, {
      field: opts.field ?? 'cost_per_action_type',
      ...(opts.window !== undefined ? { window: opts.window } : {}),
    });
  }
  const spend = spendMajor(row);
  const count = actionValue(row, actionType, {
    field: opts.field ?? 'actions',
    ...(opts.window !== undefined ? { window: opts.window } : {}),
  });
  if (spend === undefined || count === undefined || count === 0) return undefined;
  return spend / count;
}

/**
 * ROAS as Meta computes it: attributed conversion value ÷ spend, using the SAME
 * attribution setting as the row.
 *
 * The unit is a RATIO ("3.42" = 3.42x), which is verified-secondary only — the reference
 * never states the unit. Sanity-check it against a live account before trusting the
 * magnitude. Computing ROAS yourself from `action_values / spend` gives a slightly
 * different number; pick one and never mix them in the same decision surface.
 */
export function purchaseRoas(row: InsightsRow, actionType = 'omni_purchase'): number | undefined {
  return actionValue(row, actionType, { field: 'purchase_roas' });
}

export interface VideoRetention {
  plays: number | undefined;
  /** p25 ÷ plays — hook retention. The one number a generative re-cut can act on directly. */
  hookRetention: number | undefined;
  p50Rate: number | undefined;
  p75Rate: number | undefined;
  completionRate: number | undefined;
  thruplays: number | undefined;
}

/**
 * Video retention ratios, all `undefined` rather than NaN when the denominator is
 * missing or zero.
 *
 * `video_play_actions` is the denominator rather than impressions: retention is about
 * what happened to people who actually started the video, and mixing in non-players
 * turns a hook problem into an unreadable blend of hook and placement.
 *
 * UNVERIFIED: the `action_type` key inside the video_* arrays is not documented. Every
 * observed payload uses `video_view`, but confirm with `actionTypes(row,
 * 'video_play_actions')` on a live account before trusting the default — an unmatched
 * type yields `undefined` here, which reads as "no video data" rather than as a bug.
 */
export function videoRetention(row: InsightsRow, actionType = 'video_view'): VideoRetention {
  const plays = actionValue(row, actionType, { field: 'video_play_actions' });
  const ratio = (field: string): number | undefined => {
    const v = actionValue(row, actionType, { field });
    if (v === undefined || plays === undefined || plays === 0) return undefined;
    return v / plays;
  };
  return {
    plays,
    hookRetention: ratio('video_p25_watched_actions'),
    p50Rate: ratio('video_p50_watched_actions'),
    p75Rate: ratio('video_p75_watched_actions'),
    completionRate: ratio('video_p100_watched_actions'),
    thruplays: actionValue(row, actionType, { field: 'video_thruplay_watched_actions' }),
  };
}

function deadWindowMessage(window: string): string {
  return (
    `"${window}" has returned no data since 2026-01-12 but was never removed from the ` +
    `schema — Meta accepts it and answers with zeros, so this would silently report a ` +
    `fraction of the truth. Surviving windows: ${LIVE_ATTRIBUTION_WINDOWS.join(', ')}.`
  );
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export interface InsightsQuery {
  /** `act_<id>`. Always required: it is the rate-limit bucket and the snapshot's tenant. */
  adAccountId: string;
  /**
   * The node to call. Defaults to the ad account, which is the shape that fits inside
   * the quota — one `act_X/insights?level=ad` call replaces N per-ad calls.
   */
  nodeId?: string;
  level: InsightsLevel;
  fields?: readonly string[];
  /** `until` is INCLUSIVE. Mutually exclusive with `datePreset`. */
  timeRange?: { since: string; until: string };
  datePreset?: DatePreset;
  /** `1` for one row per day (what the age-matched comparison needs), `monthly`, `all_days`, or 1–90. */
  timeIncrement?: number | 'monthly' | 'all_days';
  breakdowns?: readonly string[];
  actionBreakdowns?: readonly string[];
  actionAttributionWindows?: readonly AttributionWindow[];
  filtering?: readonly InsightsFilter[];
  limit?: number;
  /** `<field>_ascending` / `<field>_descending`. One element only. */
  sort?: string;
  useAccountAttributionSetting?: boolean;
  /** Escape hatch for parameters this module does not model. Validated, not trusted. */
  extraParams?: Readonly<Record<string, string>>;
}

export interface BuiltRequest {
  path: string;
  params: Record<string, string>;
  /** Non-fatal problems: things Meta will accept and then quietly return nothing for. */
  warnings: readonly string[];
}

/** 37 months is the hard floor; older `since` values fail with error 3018. */
const LOOKBACK_MONTHS = 37;

/**
 * Turns a query into the exact `(path, params)` Meta expects, refusing anything it will
 * reject or — worse — accept and silently empty.
 *
 * `now` is injected rather than read from the clock so the 37-month check is testable and
 * so a backfill can be validated against the date it will actually run on.
 */
export function buildInsightsRequest(query: InsightsQuery, now: Date): BuiltRequest {
  const warnings: string[] = [];

  if (!/^act_\d+$/.test(query.adAccountId)) {
    fail(
      'adAccountId',
      `"${query.adAccountId}" must be "act_<numeric id>". A bare numeric id resolves to a ` +
        `different node type and 404s or, worse, answers about the wrong object.`,
    );
  }
  if (!INSIGHTS_LEVELS.includes(query.level)) {
    fail('level', `"${query.level}" is not one of ${INSIGHTS_LEVELS.join(' | ')}.`);
  }

  const params: Record<string, string> = { level: query.level };

  // --- time -------------------------------------------------------------
  if (query.timeRange && query.datePreset) {
    fail('time_range', 'time_range and date_preset are mutually exclusive; pass exactly one.');
  }
  if (query.timeRange) {
    const { since, until } = query.timeRange;
    assertDate('time_range.since', since);
    assertDate('time_range.until', until);
    if (since > until) {
      fail('time_range', `since (${since}) is after until (${until}). "until" is inclusive.`);
    }
    const floor = monthsBefore(now, LOOKBACK_MONTHS);
    if (since < floor) {
      fail(
        'time_range.since',
        `${since} is beyond Meta's ${LOOKBACK_MONTHS}-month lookback (floor ${floor}). This is ` +
          `error 3018, "Start date cannot exceed 37 months from current date". Data older than ` +
          `that is unrecoverable from the API — it must come from your own archived snapshots.`,
      );
    }
    params['time_range'] = JSON.stringify({ since, until });
  } else if (query.datePreset) {
    if (!DATE_PRESETS.includes(query.datePreset)) {
      const extra =
        (query.datePreset as string) === 'lifetime'
          ? ' `lifetime` was removed; use `maximum` (37-month ceiling) or `data_maximum` (all data on the object).'
          : '';
      fail('date_preset', `"${query.datePreset}" is not a v26.0 date_preset.${extra}`);
    }
    params['date_preset'] = query.datePreset;
  } else {
    fail('time_range', 'one of time_range or date_preset is required; the API default (last_30d) is never what an autonomous sync wants.');
  }

  if (query.timeIncrement !== undefined) {
    const ti = query.timeIncrement;
    if (typeof ti === 'number') {
      if (!Number.isInteger(ti) || ti < 1 || ti > 90) {
        fail('time_increment', `${ti} is out of range. Documented 1–90; connector reports put the practical ceiling at 89.`);
      }
      if (ti === 90) {
        warnings.push('time_increment=90 is documented but reported to be rejected in practice (practical ceiling 89) — verified-secondary.');
      }
      params['time_increment'] = String(ti);
    } else {
      params['time_increment'] = ti;
    }
  }

  // --- fields -----------------------------------------------------------
  const fields = new Set(query.fields ?? CREATIVE_DECISION_FIELDS);
  // Rows in one response can be attributed differently, because each ad set carries its
  // own setting. Without this field a snapshot has no identity and cannot be aggregated
  // safely, so it is re-added even if the caller stripped it.
  fields.add('attribution_setting');
  fields.add('date_start');
  fields.add('date_stop');
  fields.add(ID_FIELD_BY_LEVEL[query.level]);
  params['fields'] = [...fields].join(',');

  // --- breakdowns -------------------------------------------------------
  const breakdowns = query.breakdowns ?? [];
  for (const b of breakdowns) {
    const replacement = RETIRED_BREAKDOWNS.get(b);
    if (replacement !== undefined) fail('breakdowns', `"${b}" no longer exists. Use ${replacement}.`);
    if (OPT_IN_GATED_BREAKDOWNS.has(b)) {
      warnings.push(
        `breakdowns=${b} requires a manual Ads Manager opt-in for non-sales-supported accounts ` +
          `since 2026-08-06. A non-opted-in account returns NO RESULTS rather than an error, which ` +
          `is indistinguishable from "no delivery". Async jobs on these breakdowns are also capped ` +
          `at min(10, ad-set count) per 24h.`,
      );
    }
  }
  const hasHourly = breakdowns.some((b) => HOURLY_BREAKDOWNS.has(b));
  if (hasHourly) {
    const clashing = [...fields].filter((f) => UNIQUE_FIELDS.has(f) || f.startsWith('unique_'));
    if (clashing.length > 0) {
      warnings.push(
        `hourly breakdowns do not support unique fields — ${clashing.join(', ')} will return 0, ` +
          `not an error. Query unique metrics in a separate call.`,
      );
    }
    const video = [...fields].filter((f) => f.startsWith('video_'));
    if (video.length > 0) {
      warnings.push(`video_* fields (${video.join(', ')}) cannot be requested with hourly breakdowns.`);
    }
  }

  // --- the tiered retention caps (2026-01-12) ---------------------------
  // 37 months is only the ceiling for TOTALS. Unique fields and hourly breakdowns are
  // capped at 13 months, `frequency_value` at 6, and `reach` alongside any breakdown is
  // not served by a sync call past 13 months. All four fail the same way the rest of
  // this module exists to catch: the request succeeds and the rows come back empty or
  // zeroed, which reads exactly like "this ad had no delivery". Warned rather than
  // refused, because the request is still legal and the other requested fields do come
  // back — refusing would throw away the part of the query that works.
  for (const w of retentionCapWarnings(query, fields, breakdowns, hasHourly, now)) warnings.push(w);

  if (breakdowns.length > 0) params['breakdowns'] = breakdowns.join(',');

  if (query.actionBreakdowns && query.actionBreakdowns.length > 0) {
    params['action_breakdowns'] = query.actionBreakdowns.join(',');
  }

  // --- attribution ------------------------------------------------------
  if (query.actionAttributionWindows && query.actionAttributionWindows.length > 0) {
    for (const w of query.actionAttributionWindows) {
      if (DEAD_ATTRIBUTION_WINDOWS.has(w)) fail('action_attribution_windows', deadWindowMessage(w));
      // Allow-list, not just the dead-list. An unmodelled enum value (`dda`,
      // `1d_sequenced`, `incrementality*`, `skan_*`) either 4xxs — and our own 4xx
      // errors subtract from the ads_insights quota (`- 0.001 * UserErrors`) — or
      // returns keys this module's accessors cannot read. Neither is worth discovering
      // in production, and the type already says these five.
      if (!LIVE_ATTRIBUTION_WINDOWS.includes(w)) {
        fail(
          'action_attribution_windows',
          `"${w}" is not one of the windows this module models (${LIVE_ATTRIBUTION_WINDOWS.join(', ')}). ` +
            `v26.0 accepts others (dda, 1d_sequenced, incrementality*, skan_*) but their semantics are ` +
            `undocumented and the accessors here cannot read their keys. If you genuinely need one, ` +
            `pass it via extraParams.action_attribution_windows and read the raw payload deliberately.`,
        );
      }
    }
    params['action_attribution_windows'] = query.actionAttributionWindows.join(',');
  }
  if (query.useAccountAttributionSetting !== undefined) {
    // UNVERIFIED whether this still does anything now that ad-set settings are applied
    // by default (2025-06-10). Passed through because the docs still list it, but the
    // caller should not build a mental model on it without probing a live account.
    params['use_account_attribution_setting'] = String(query.useAccountAttributionSetting);
    warnings.push(
      'use_account_attribution_setting is UNVERIFIED post-2025-06-10: ad-set settings are applied ' +
        'by default now, so this may be a no-op. Probe it before relying on it.',
    );
  }

  // --- the rest ---------------------------------------------------------
  if (query.filtering && query.filtering.length > 0) {
    params['filtering'] = JSON.stringify(query.filtering);
  }
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      fail('limit', `${query.limit} must be a positive integer.`);
    }
    params['limit'] = String(query.limit);
  }
  if (query.sort !== undefined) params['sort'] = query.sort;

  for (const [k, v] of Object.entries(query.extraParams ?? {})) {
    if (IGNORED_INSIGHTS_PARAMS.has(k)) {
      fail(
        k,
        `disregarded by Meta since 2025-06-10 — the API always uses the ad set's own attribution ` +
          `setting with action_report_time=mixed. Setting it is dead code that makes a reader ` +
          `believe attribution is under their control.`,
      );
    }
    if (k === 'async') {
      fail('async', 'there is no async parameter. The HTTP verb is the switch: POST /insights is the async job, GET /insights is synchronous.');
    }
    if (k in params) fail(k, `already set by the query builder; remove it from extraParams.`);
    params[k] = v;
  }

  return { path: `${query.nodeId ?? query.adAccountId}/insights`, params, warnings };
}

/**
 * The date `months` calendar months before `now`, clamping the day rather than letting
 * it roll forward.
 *
 * `Date.UTC(2026, -35, 31)` is 2023-03-03, not 2023-02-28, so the naive version pushes
 * the 37-month floor up to three days too late and refuses a `since` Meta would have
 * accepted. Rare, but it fires exactly on a month-end backfill at the edge of the
 * window, and a refusal there looks like data loss.
 */
function monthsBefore(now: Date, months: number): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), lastDayOfTarget)));
  return d.toISOString().slice(0, 10);
}

/**
 * The 2026-01-12 tiered-retention rules, as warnings.
 *
 * Source: docs/research/meta-insights-measurement.md §3.4 (retention table) and the
 * 2025-10-16 metric-availability announcement it cites. Only `time_range.since` and the
 * two unbounded presets can reach past a cap; every other `date_preset` tops out at 90
 * days, well inside all three.
 */
function retentionCapWarnings(
  query: InsightsQuery,
  fields: ReadonlySet<string>,
  breakdowns: readonly string[],
  hasHourly: boolean,
  now: Date,
): string[] {
  const out: string[] = [];
  const since = query.timeRange?.since;
  const unbounded = query.datePreset === 'maximum' || query.datePreset === 'data_maximum';
  const reaches = (floor: string): boolean => unbounded || (since !== undefined && since < floor);

  const floor13 = monthsBefore(now, 13);
  const floor6 = monthsBefore(now, 6);
  const window = unbounded ? `date_preset=${query.datePreset}` : `since=${since}`;

  if (reaches(floor13)) {
    const uniques = [...fields].filter((f) => UNIQUE_FIELDS.has(f) || f.startsWith('unique_'));
    if (uniques.length > 0) {
      out.push(
        `${window} is older than the 13-month retention cap (floor ${floor13}) that has applied to ` +
          `unique/de-duplicated fields since 2026-01-12 — ${uniques.join(', ')} will come back empty ` +
          `or zeroed for the out-of-range days, with no error. Totals keep 37 months; only the ` +
          `unique family is capped.`,
      );
    }
    if (hasHourly) {
      out.push(
        `${window} is older than the 13-month retention cap (floor ${floor13}) on hourly breakdowns ` +
          `since 2026-01-12. The out-of-range days return no rows rather than an error.`,
      );
    }
    if (breakdowns.length > 0 && fields.has('reach')) {
      out.push(
        `reach is not returned by SYNCHRONOUS queries that apply breakdowns with a start date over ` +
          `13 months old (floor ${floor13}, in force since 2025-06-10); ${window} crosses it. An async ` +
          `report job still serves it, limited to 10 requests per ad account per day.`,
      );
    }
  }
  if (reaches(floor6) && breakdowns.includes('frequency_value')) {
    out.push(
      `breakdowns=frequency_value has a 6-month retention cap (floor ${floor6}) since 2026-01-12 and ` +
        `${window} reaches past it; those days return nothing rather than an error.`,
    );
  }
  return out;
}

/**
 * The one call the autonomy loop's reward signal is built on.
 *
 * `level=ad` + `time_increment=1` + a rolling 28-day window at the ACCOUNT node. One
 * request per account per hour, no breakdowns. Rate limit is the architectural
 * constraint here, not API richness — and `time_increment=1` is what gives every ad an
 * age axis (`date_start − created_time`), which is what makes age-matched comparison
 * possible at all.
 */
export function creativeRewardQuery(adAccountId: string, asOfDate: string): InsightsQuery {
  return {
    adAccountId,
    level: 'ad',
    fields: CREATIVE_DECISION_FIELDS,
    timeRange: rollingWindow(asOfDate),
    timeIncrement: 1,
    filtering: [DELIVERING_STATUS_FILTER],
    limit: 500,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The subset of `MetaClient` this module needs. Structural, so `new MetaClient(...)`
 * satisfies it without this file importing the client and without the client knowing
 * about insights.
 */
export interface InsightsTransport {
  get<T>(path: string, params: Record<string, string>, ctx: { adAccountId?: string }): Promise<T>;
  post<T>(path: string, params: Record<string, string>, ctx: { adAccountId?: string }): Promise<T>;
}

export interface InsightsClientOptions {
  transport: InsightsTransport;
  /** Injected clock. Every timestamp on a snapshot comes from here, never from `Date.now`. */
  now: () => Date;
  /** Injected so polling tests do not actually wait an hour. */
  sleep?: (ms: number) => Promise<void>;
  onWarning?: (warning: string) => void;
  /** Refuses to page forever if `paging.next` ever loops. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 500;

/** Polling: insights refresh on a 15-minute cadence, so a fast poll only burns quota. */
const POLL_INITIAL_MS = 5_000;
const POLL_MAX_MS = 60_000;
const POLL_FACTOR = 1.5;

/** *"Asynchronous requests can take up to an hour to complete including retry attempts."* */
const DEFAULT_MAX_WAIT_MS = 75 * 60_000;

/** *"Do not store the report_run_id for long term use, it expires after 30 days."* */
export const REPORT_RUN_ID_TTL_MS = 30 * DAY_MS;

export const ASYNC_STATUSES = [
  'Job Not Started', 'Job Started', 'Job Running', 'Job Completed', 'Job Failed', 'Job Skipped',
] as const;
export type AsyncStatus = (typeof ASYNC_STATUSES)[number];

export interface AsyncReportState {
  reportRunId: string;
  status: AsyncStatus | string;
  percentComplete: number | undefined;
}

export interface AsyncReportResult {
  rows: InsightsRow[];
  reportRunId: string;
  /** How many times `Job Skipped` forced a resubmit. Non-zero is normal, not a failure. */
  resubmits: number;
  polls: number;
  warnings: readonly string[];
}

export class AsyncReportError extends Error {
  readonly status: string;
  readonly reportRunId: string;

  constructor(reportRunId: string, status: string, message: string) {
    super(message);
    this.name = 'AsyncReportError';
    this.status = status;
    this.reportRunId = reportRunId;
  }
}

export class InsightsClient {
  private readonly transport: InsightsTransport;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWarning: (w: string) => void;
  private readonly maxPages: number;

  constructor(opts: InsightsClientOptions) {
    this.transport = opts.transport;
    this.now = opts.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onWarning = opts.onWarning ?? ((w) => console.warn(`[insights] ${w}`));
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Synchronous read, following `paging.next` to exhaustion.
   *
   * Meta's own order of operations is *"try sync calls first and then use async calls in
   * cases where sync calls timeout"* — sync is the default for the hourly reward signal
   * and async is for backfills.
   */
  async fetch(query: InsightsQuery): Promise<InsightsRow[]> {
    const built = buildInsightsRequest(query, this.now());
    for (const w of built.warnings) this.onWarning(w);
    return this.readAllPages(built.path, built.params, query.adAccountId);
  }

  /**
   * Submits an async report job. The switch to async is the HTTP VERB — there is no
   * `async=true` parameter, and sending one on a GET does nothing.
   */
  async submitReport(query: InsightsQuery): Promise<{ reportRunId: string; submittedAt: Date }> {
    const built = buildInsightsRequest(query, this.now());
    for (const w of built.warnings) this.onWarning(w);
    const submittedAt = this.now();
    const res = await this.transport.post<Record<string, unknown>>(built.path, built.params, {
      adAccountId: query.adAccountId,
    });

    // A spend-guarded transport short-circuits POSTs in SIMULATE mode and hands back a
    // fabricated id. Polling that id forever is the worst possible failure, so it is
    // named here instead. An insights report job is a READ that happens to use POST.
    if (res['__simulated'] === true) {
      throw new InsightsError(
        'the transport short-circuited this POST (SIMULATE mode) and returned a fabricated id. ' +
          'An async insights job is a read, not a write — run it through a transport that ' +
          'actually issues the request, or use the synchronous fetch() path.',
        'report_run_id',
      );
    }
    const id = res['report_run_id'];
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new InsightsError(
        `POST /insights did not return a report_run_id. Got: ${JSON.stringify(res).slice(0, 300)}. ` +
          `If the transport is in VALIDATE mode it appends execution_options=["validate_only"] to ` +
          `every POST, which an insights job answers without starting one — an async report is a ` +
          `read, so run it in LIVE mode or use the synchronous fetch() path.`,
        'report_run_id',
      );
    }
    return { reportRunId: String(id), submittedAt };
  }

  /** One poll of the AdReportRun node. */
  async pollReport(reportRunId: string): Promise<AsyncReportState> {
    const res = await this.transport.get<Record<string, unknown>>(reportRunId, {}, {});
    const status = res['async_status'];
    if (typeof status !== 'string') {
      throw new InsightsError(
        `AdReportRun ${reportRunId} returned no async_status. Got: ${JSON.stringify(res).slice(0, 300)}`,
        'async_status',
      );
    }
    return {
      reportRunId,
      status,
      percentComplete: parseNumeric(res['async_percent_completion']),
    };
  }

  /**
   * Submit → poll → read, with the two behaviours everybody gets wrong.
   *
   *  - **`async_percent_completion === 100` does not mean done.** It reaches 100 while
   *    the status is still `Job Running`, and `Job Failed` reports 100 too. Reading the
   *    results then returns a partial `data` array with NO error, which is the classic
   *    one-day-of-debugging bug. Both conditions are required here.
   *  - **`Job Skipped` is not a failure.** It means the job expired and must be
   *    RESUBMITTED. Treating it as terminal makes historical backfills randomly lose
   *    days. `Job Failed`, by contrast, is *"requires query review and resubmission"* —
   *    a human-shaped problem, so it is thrown rather than auto-retried, because a blind
   *    resubmit of a malformed query also eats the insights quota (`- 0.001 * UserErrors`).
   */
  async runAsyncReport(
    query: InsightsQuery,
    opts: { maxResubmits?: number; maxWaitMs?: number } = {},
  ): Promise<AsyncReportResult> {
    const maxResubmits = opts.maxResubmits ?? 2;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const warnings: string[] = [];
    const startedAt = this.now().getTime();

    let resubmits = 0;
    let polls = 0;
    let submitted = await this.submitReport(query);

    for (;;) {
      let delay = POLL_INITIAL_MS;
      let terminal: AsyncReportState | undefined;

      for (;;) {
        if (this.now().getTime() - startedAt > maxWaitMs) {
          throw new AsyncReportError(
            submitted.reportRunId,
            'timeout',
            `Async report ${submitted.reportRunId} did not complete within ${Math.round(maxWaitMs / 60000)} ` +
              `minutes. Meta states jobs can take up to an hour; beyond that the query is almost ` +
              `certainly too wide — narrow the time range or drop a breakdown (error 100/1487534 ` +
              `territory), rather than raising the timeout.`,
          );
        }
        await this.sleep(delay);
        delay = Math.min(Math.round(delay * POLL_FACTOR), POLL_MAX_MS);
        polls++;

        const state = await this.pollReport(submitted.reportRunId);
        if (state.status === 'Job Completed' && state.percentComplete === 100) {
          terminal = state;
          break;
        }
        if (state.status === 'Job Failed' || state.status === 'Job Skipped') {
          terminal = state;
          break;
        }
        if (!ASYNC_STATUSES.includes(state.status as AsyncStatus)) {
          // Status strings are human-readable with spaces and title case. An unknown one
          // is logged and polled through rather than crashing a nightly backfill.
          warnings.push(`unknown async_status "${state.status}" on ${submitted.reportRunId}; continuing to poll.`);
        }
      }

      if (terminal.status === 'Job Completed') {
        const rows = await this.fetchReportResults(submitted.reportRunId, submitted.submittedAt, query.adAccountId);
        return { rows, reportRunId: submitted.reportRunId, resubmits, polls, warnings };
      }

      if (terminal.status === 'Job Failed') {
        throw new AsyncReportError(
          submitted.reportRunId,
          terminal.status,
          `Async report ${submitted.reportRunId} returned "Job Failed", which Meta documents as ` +
            `"requires query review and resubmission". Not auto-retried: a blind resubmit of a ` +
            `malformed query burns insights quota twice over (the quota formula subtracts your own ` +
            `4xx errors). Review the query — level=${query.level}, ` +
            `breakdowns=[${(query.breakdowns ?? []).join(',')}], ` +
            `fields=${(query.fields ?? CREATIVE_DECISION_FIELDS).length} — then resubmit.`,
        );
      }

      // Job Skipped: expired, resubmit required. Normal outcome, not an error.
      if (resubmits >= maxResubmits) {
        throw new AsyncReportError(
          submitted.reportRunId,
          terminal.status,
          `Async report kept returning "Job Skipped" (expired) after ${resubmits} resubmissions. ` +
            `That is no longer transient — the job is being skipped systematically, which usually ` +
            `means the account is over its async job allowance (opt-in-gated breakdowns are capped ` +
            `at min(10, ad-set count) per 24h).`,
        );
      }
      resubmits++;
      warnings.push(`report ${submitted.reportRunId} returned "Job Skipped" (expired); resubmitting (${resubmits}/${maxResubmits}).`);
      submitted = await this.submitReport(query);
    }
  }

  /** Reads a completed job's rows. Refuses an id past its documented 30-day lifetime. */
  async fetchReportResults(reportRunId: string, submittedAt?: Date, adAccountId?: string): Promise<InsightsRow[]> {
    if (submittedAt) {
      const age = this.now().getTime() - submittedAt.getTime();
      if (age > REPORT_RUN_ID_TTL_MS) {
        throw new InsightsError(
          `report_run_id ${reportRunId} was submitted ${Math.round(age / DAY_MS)} days ago and Meta ` +
            `expires them after 30. Resubmit the job rather than reading a stale id.`,
          'report_run_id',
        );
      }
    }
    return this.readAllPages(`${reportRunId}/insights`, {}, adAccountId);
  }

  /**
   * Follows `paging.next` rather than reconstructing a cursor.
   *
   * The `next` URL encodes internal state (error 2642 is "invalid cursor values"), so its
   * query string is carried across verbatim — minus the credentials, which the transport
   * re-attaches. Only the auth params are dropped; every Meta-authored parameter survives.
   */
  private async readAllPages(
    path: string,
    params: Record<string, string>,
    adAccountId: string | undefined,
  ): Promise<InsightsRow[]> {
    const rows: InsightsRow[] = [];
    const ctx = adAccountId !== undefined ? { adAccountId } : {};
    let nextPath = path;
    let nextParams = params;

    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.transport.get<PagedResponse>(nextPath, nextParams, ctx);
      const data = res.data;
      if (Array.isArray(data)) {
        for (const r of data) {
          if (typeof r === 'object' && r !== null) rows.push(r as InsightsRow);
        }
      }
      const next = res.paging?.next;
      if (typeof next !== 'string' || next === '') return rows;
      const parsed = parseNextPage(next);
      nextPath = parsed.path;
      nextParams = parsed.params;
    }

    throw new InsightsError(
      `paging exceeded ${this.maxPages} pages on ${path}. Either the query is far too wide or ` +
        `paging.next is looping; refusing to spin. Narrow the time range or raise limit.`,
      'paging',
    );
  }
}

/** Credentials the transport re-attaches; carrying them through would double them up. */
const AUTH_PARAMS: ReadonlySet<string> = new Set(['access_token', 'appsecret_proof']);

export function parseNextPage(nextUrl: string): { path: string; params: Record<string, string> } {
  let url: URL;
  try {
    url = new URL(nextUrl);
  } catch {
    throw new InsightsError(`paging.next is not a URL: ${nextUrl.slice(0, 200)}`, 'paging.next');
  }
  // Strip the leading /vXX.0/ that graph.facebook.com puts in front of every path; the
  // transport owns the version and pinning it in two places is how a version drift bug
  // becomes invisible.
  const path = url.pathname.replace(/^\/+/, '').replace(/^v\d+\.\d+\//, '');
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (!AUTH_PARAMS.has(k)) params[k] = v;
  }
  return { path, params };
}

// ---------------------------------------------------------------------------
// The metric store — append-only snapshots
// ---------------------------------------------------------------------------

/**
 * Sentinel for a row Meta returned without `attribution_setting`.
 *
 * Not thrown at ingest, deliberately: dropping a whole sync because one campaign-level
 * row omitted a derived field loses data we cannot re-fetch later. Instead the sentinel
 * is stored honestly and `assertHomogeneousAttribution` refuses to aggregate it — the
 * failure lands at the decision, which is the only place it can do harm.
 */
export const MISSING_ATTRIBUTION_SETTING = 'UNKNOWN';

export interface MetricSnapshot {
  /** Identity. Nothing in here is ever mutated; a restatement is a NEW row. */
  readonly level: InsightsLevel;
  readonly objectId: string;
  /** `date_start`, a naive date in the AD ACCOUNT's timezone. */
  readonly statDate: string;
  readonly attributionSetting: string;
  /** `''` when no breakdowns were requested. Without it, breakdown rows collide. */
  readonly breakdownKey: string;
  /** ISO 8601 instant at which WE read this. The provenance axis. */
  readonly observedAt: string;

  readonly adAccountId: string;
  readonly attributionRegime: AttributionRegime;
  readonly source: 'sync' | 'async';
  /** The untouched payload. Fields we do not model today are still recoverable tomorrow. */
  readonly raw: InsightsRow;
}

/** The five fields that identify a metric cell, excluding `observedAt`. */
export interface SnapshotIdentity {
  level: InsightsLevel;
  objectId: string;
  statDate: string;
  attributionSetting: string;
  breakdownKey?: string;
}

export function identityKey(id: SnapshotIdentity): string {
  return [id.level, id.objectId, id.statDate, id.attributionSetting, id.breakdownKey ?? ''].join('\u0000');
}

export function snapshotIdentityKey(s: MetricSnapshot): string {
  return identityKey(s);
}

export interface ToSnapshotsOptions {
  level: InsightsLevel;
  adAccountId: string;
  /** Injected clock reading, so a whole sync shares one `observedAt`. */
  observedAt: Date;
  /** The breakdowns that were requested, in the order requested. */
  breakdowns?: readonly string[];
  source?: 'sync' | 'async';
}

/**
 * Turns raw rows into snapshots. Pure — no clock, no IO.
 *
 * Throws when a row has no `date_start` or no id for its level, because such a row
 * cannot be keyed at all and storing it under a guessed key is worse than losing it.
 */
export function toSnapshots(rows: readonly InsightsRow[], opts: ToSnapshotsOptions): MetricSnapshot[] {
  const observedAt = opts.observedAt.toISOString();
  const idField = ID_FIELD_BY_LEVEL[opts.level];
  const breakdowns = opts.breakdowns ?? [];

  return rows.map((row, i) => {
    const statDate = row['date_start'];
    if (typeof statDate !== 'string') {
      fail('date_start', `row ${i} has no date_start, so it cannot be keyed. Add date_start to fields (buildInsightsRequest does this automatically).`);
    }
    assertDate('date_start', statDate);
    const objectId = row[idField];
    if (typeof objectId !== 'string' && typeof objectId !== 'number') {
      fail(idField, `row ${i} (level=${opts.level}) has no ${idField}, so it cannot be attributed to an object.`);
    }
    const setting = row['attribution_setting'];
    return {
      level: opts.level,
      objectId: String(objectId),
      statDate,
      attributionSetting: typeof setting === 'string' && setting !== '' ? setting : MISSING_ATTRIBUTION_SETTING,
      breakdownKey: breakdownKeyOf(row, breakdowns),
      observedAt,
      adAccountId: opts.adAccountId,
      attributionRegime: attributionRegime(statDate),
      source: opts.source ?? 'sync',
      raw: row,
    };
  });
}

/**
 * A stable key for the breakdown coordinates of a row.
 *
 * Asset breakdowns return an object (`{"body_asset": {"text": "...", "id": "605..."}}`)
 * rather than a scalar, so the id is used when present — the text is not stable.
 */
function breakdownKeyOf(row: InsightsRow, breakdowns: readonly string[]): string {
  if (breakdowns.length === 0) return '';
  return breakdowns
    .map((b) => {
      const v = row[b];
      if (v === undefined || v === null) return `${b}=`;
      if (typeof v === 'object') {
        const id = (v as Record<string, unknown>)['id'];
        return `${b}=${typeof id === 'string' || typeof id === 'number' ? String(id) : JSON.stringify(v)}`;
      }
      return `${b}=${String(v)}`;
    })
    .join('|');
}

/**
 * Refuses to aggregate rows whose ad sets disagree about attribution.
 *
 * Since 2025-06-10 each row is attributed using its OWN ad set's setting, so two rows in
 * one response can mean different things. Summing them produces a number with no
 * definition. The escape hatch is to read an explicit window key (`7d_click`), which is
 * attribution-setting independent — pass `readingExplicitWindow: true` when you do.
 */
export function assertHomogeneousAttribution(
  snapshots: readonly { attributionSetting: string }[],
  opts: { readingExplicitWindow?: boolean } = {},
): void {
  if (opts.readingExplicitWindow === true) return;
  const settings = new Set(snapshots.map((s) => s.attributionSetting));
  if (settings.size <= 1) return;
  fail(
    'attribution_setting',
    `refusing to aggregate ${snapshots.length} rows spanning ${settings.size} attribution settings ` +
      `(${[...settings].sort().join(', ')}). Each ad set carries its own setting and the rows are not ` +
      `commensurable. Either aggregate per setting, or request explicit action_attribution_windows ` +
      `and read one window key (which is setting-independent) with readingExplicitWindow: true.`,
  );
}

export interface SnapshotStoreOptions {
  path: string;
}

/**
 * Append-only JSONL snapshot store.
 *
 * There is no `update`, no `upsert` and no `delete`, and that is the entire point. When
 * Thursday's fetch restates Tuesday's numbers, Thursday's read becomes a NEW line;
 * Tuesday's line stays exactly as it was, so "why did we pause that ad on Tuesday?" has
 * an answer that survives the restatement.
 *
 * JSONL rather than a database because the durability contract is the only thing that
 * matters here: one line per observation, fsynced, and a torn final line (the only kind
 * a crash can produce) is dropped with a warning instead of corrupting the history.
 */
export class MetricSnapshotStore {
  readonly path: string;
  /** Non-fatal problems found while loading. Surface these — do not swallow them. */
  readonly warnings: readonly string[];

  private readonly rows: MetricSnapshot[] = [];

  constructor(opts: SnapshotStoreOptions) {
    this.path = opts.path;
    const warnings: string[] = [];
    this.load(warnings);
    this.warnings = warnings;
  }

  private load(warnings: string[]): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const snap = asSnapshot(parsed);
        if (!snap) throw new Error('not a recognised snapshot');
        this.rows.push(snap);
      } catch (err) {
        // A crash mid-append can only tear the LAST line. Anything earlier means the file
        // was edited or the disk lied, and neither is safe to read past — the store's
        // whole job is to be the record of what we believed.
        if (i === lines.length - 1) {
          warnings.push(
            `dropped torn final line ${i + 1} of ${this.path} (${String(err)}). At worst one ` +
              `observation is lost; the next sync re-reads that window anyway.`,
          );
          continue;
        }
        throw new InsightsError(`${this.path} line ${i + 1} is corrupt: ${String(err)}`, 'snapshot-store');
      }
    }
  }

  /** Appends and fsyncs. Returns the number of lines written. */
  append(snapshots: readonly MetricSnapshot[]): number {
    if (snapshots.length === 0) return 0;
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      let payload = '';
      for (const s of snapshots) payload += `${JSON.stringify(s)}\n`;
      // writeSync is allowed to write fewer bytes than it was given. Unhandled, that
      // leaves a torn line the next load() silently drops — data loss with no crash to
      // explain it. Loop until the buffer is out, and encode once so the byte count and
      // the offsets agree (a multi-byte character split by a short write would otherwise
      // be re-encoded from the wrong string index).
      const buf = Buffer.from(payload, 'utf8');
      let written = 0;
      while (written < buf.length) {
        const n = writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) {
          throw new InsightsError(
            `wrote ${written} of ${buf.length} bytes to ${this.path} and then stalled. The store is ` +
              `the record of what we believed when we spent money — refusing to report success.`,
            'snapshot-store',
          );
        }
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.rows.push(...snapshots);
    return snapshots.length;
  }

  all(): readonly MetricSnapshot[] {
    return this.rows;
  }

  /** Every observation of one metric cell, oldest first. The restatement trail. */
  history(id: SnapshotIdentity): MetricSnapshot[] {
    const key = identityKey(id);
    return this.rows
      .filter((s) => snapshotIdentityKey(s) === key)
      .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
  }

  /**
   * The world as it looked at `observedAt` — the newest observation of each cell that we
   * had actually made by then.
   *
   * This is the function that makes a decision explainable after the fact. Replay a
   * Tuesday decision against `asOf(tuesday)` and you see the numbers the decision was
   * made on, not the ones Meta later restated them to.
   */
  asOf(observedAt: Date | string): MetricSnapshot[] {
    const cutoff = typeof observedAt === 'string' ? observedAt : observedAt.toISOString();
    const best = new Map<string, MetricSnapshot>();
    for (const s of this.rows) {
      if (s.observedAt > cutoff) continue;
      const key = snapshotIdentityKey(s);
      const current = best.get(key);
      if (!current || s.observedAt > current.observedAt) best.set(key, s);
    }
    return [...best.values()];
  }

  /** Convenience: `asOf` the injected present. Still a snapshot view, never a mutable "current" table. */
  latest(now: Date): MetricSnapshot[] {
    return this.asOf(now);
  }
}

function asSnapshot(v: unknown): MetricSnapshot | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const level = o['level'];
  if (typeof level !== 'string' || !INSIGHTS_LEVELS.includes(level as InsightsLevel)) return undefined;
  const required = ['objectId', 'statDate', 'attributionSetting', 'breakdownKey', 'observedAt', 'adAccountId', 'attributionRegime', 'source'];
  for (const k of required) {
    if (typeof o[k] !== 'string') return undefined;
  }
  const raw = o['raw'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  return v as MetricSnapshot;
}

// ---------------------------------------------------------------------------
// Reporting completeness
// ---------------------------------------------------------------------------

export interface CompletenessPoint {
  ageDays: number;
  factor: number;
}
export type CompletenessCurve = readonly CompletenessPoint[];

/**
 * F(a): the fraction of a stat date's conversions that have been REPORTED by age `a`.
 *
 * **Provenance.** These anchors are the illustrative DTC-ecommerce `7d_click` curve in
 * docs/research/autonomous-optimization-science.md §5.3, which the dossier itself marks
 * `SECONDARY / illustrative — you must fit your own`. They are the anchors §5.4's worked
 * example is built on (age 2 → 0.72, age 8 → ~0.97), which is why they are the default
 * here rather than the prose figures in 00-SYNTHESIS.md §6.2 ("~55% at day 2, ~95% at
 * day 7"). Those two readings differ by roughly one day; see
 * `CONSERVATIVE_COMPLETENESS_CURVE`.
 *
 * **This MUST be re-fitted per account** from observed restatements as soon as there is
 * 28-day history — that is what `fitCompletenessCurve` is for, and it is the whole
 * reason the store is append-only. A shipped constant is a placeholder, not a model:
 * the curve differs by vertical, by price point, by attribution setting and by how much
 * of the account's traffic is iOS (AEM conversions can arrive ~72h late).
 */
export const DEFAULT_COMPLETENESS_CURVE: CompletenessCurve = [
  { ageDays: 0, factor: 0.30 },
  { ageDays: 1, factor: 0.55 },
  { ageDays: 2, factor: 0.72 },
  { ageDays: 3, factor: 0.82 },
  { ageDays: 5, factor: 0.93 },
  { ageDays: 7, factor: 0.97 },
  { ageDays: 14, factor: 0.995 },
  { ageDays: 28, factor: 1.0 },
];

/**
 * The same curve read one day later, matching 00-SYNTHESIS.md §6.2's prose
 * ("a 2-day-old ad has ~55% of its conversions reported; a 7-day-old ad ~95%").
 *
 * Offered because the direction of the disagreement is not symmetric. Over-stating F(a)
 * for a young cohort under-deflates its exposure, which narrows the posterior and makes
 * the system MORE willing to kill new creative — precisely the failure this correction
 * exists to prevent. If you must guess before you have fitted a real curve, guess low.
 */
export const CONSERVATIVE_COMPLETENESS_CURVE: CompletenessCurve = [
  { ageDays: 0, factor: 0.30 },
  { ageDays: 2, factor: 0.55 },
  { ageDays: 3, factor: 0.72 },
  { ageDays: 4, factor: 0.82 },
  { ageDays: 6, factor: 0.93 },
  { ageDays: 7, factor: 0.95 },
  { ageDays: 14, factor: 0.99 },
  { ageDays: 28, factor: 1.0 },
];

/**
 * Reporting completeness at a given age, linearly interpolated between anchors.
 *
 * Getting this wrong systematically kills the newest creative: a 2-day-old ad and an
 * 8-day-old ad with identical true CPA show observed CPAs of $57 and $42 respectively,
 * and the naive verdict is "kill the new one, it is 36% worse". The bias is monotone in
 * recency, so it fires against exactly the creative the generator just made, and it is
 * invisible in Ads Manager because Ads Manager shows the same under-reported numbers.
 *
 * Beyond 28 days the value is exactly 1: Meta's own guarantee is that rows do not change
 * after 28 days.
 */
export function completenessFactor(ageDays: number, curve: CompletenessCurve = DEFAULT_COMPLETENESS_CURVE): number {
  if (!Number.isFinite(ageDays)) {
    fail('ageDays', `${ageDays} is not a finite number.`);
  }
  if (ageDays < 0) {
    fail(
      'ageDays',
      `${ageDays} is negative — the stat date is in the future relative to the observation. ` +
        `This is almost always a timezone bug: insights dates are in the AD ACCOUNT's timezone, ` +
        `and a UTC-based scheduler computes a shifted "today".`,
    );
  }
  if (curve.length === 0) fail('curve', 'completeness curve is empty.');

  const first = curve[0];
  if (first === undefined) fail('curve', 'completeness curve is empty.');
  if (ageDays <= first.ageDays) return first.factor;

  for (let i = 1; i < curve.length; i++) {
    const lo = curve[i - 1];
    const hi = curve[i];
    if (lo === undefined || hi === undefined) continue;
    if (ageDays <= hi.ageDays) {
      const span = hi.ageDays - lo.ageDays;
      if (span <= 0) return hi.factor;
      const t = (ageDays - lo.ageDays) / span;
      return lo.factor + t * (hi.factor - lo.factor);
    }
  }
  // Past the last anchor. Meta freezes rows at 28 days, so completeness is 1 by then.
  return 1;
}

/**
 * `s_effective = spend × F(age)` — the delay correction, in the only place it belongs.
 *
 * Deflate the EXPOSURE; never inflate the conversion count. Inflating the numerator
 * fabricates certainty ("we saw 14 and think it will be 19, so treat it as 19"); deflating
 * the exposure correctly says "we have seen less evidence than the spend suggests" and
 * leaves the posterior appropriately wide. $500 spent at age 1 is $275 of evidence.
 *
 * Order of operations is mandatory: completeness-correct FIRST, then apply any recency
 * discount. Discounting raw spend double-penalises new evidence and makes the system
 * permanently pessimistic about the present.
 */
export function effectiveExposure(
  spend: number,
  ageDays: number,
  curve: CompletenessCurve = DEFAULT_COMPLETENESS_CURVE,
): number {
  // `spendMajor` returns `number | undefined` precisely so absence is visible; a caller
  // that erased that with `?? NaN`, or that passed a raw Number(""), would otherwise get
  // a NaN exposure that compares false against every threshold — which reads as "this ad
  // never breaches the guardrail" rather than as the bug it is.
  if (!Number.isFinite(spend)) {
    fail('spend', `${spend} is not a finite number. Absent spend must stay absent, not become NaN.`);
  }
  if (spend < 0) fail('spend', `${spend} is negative; insights spend is never negative.`);
  return spend * completenessFactor(Math.min(ageDays, SETTLED_AFTER_DAYS), curve);
}

export interface CompletenessFitOptions {
  /** The single action type this account's KPI is defined on. Never a sum of several. */
  actionType: string;
  /** Read a specific window key instead of `value`, for setting-independent counting. */
  window?: AttributionWindow;
  /** A cohort counts as final once it is this old. Meta freezes at 28 days. */
  settledAgeDays?: number;
  minCohorts?: number;
  minFinalConversions?: number;
}

export type CompletenessFit =
  | { fitted: true; curve: CompletenessCurve; cohorts: number; finalConversions: number }
  | { fitted: false; reason: string };

/**
 * Fits F(a) from the store's own restatement history.
 *
 * This is the payoff of append-only storage. For every settled cohort (a metric cell
 * whose stat date is ≥28 days behind its newest observation) the final conversion count
 * is KNOWN, so every earlier observation of that same cell is a complete-data sample of
 * "how much had arrived by age a". No censoring machinery, no distributional assumption.
 *
 * Estimated as a ratio of sums (Σ observed ÷ Σ final) per age bucket rather than a mean
 * of per-cohort ratios: at the conversion counts a single ad-day actually produces, a
 * mean of ratios is dominated by cohorts with two conversions.
 *
 * Age is derived from `observedAt` (a UTC instant) against `statDate` (an account-timezone
 * date), so buckets can slip by up to a day. That is inside the noise of this estimate,
 * but it is a real limitation: pass account-timezone-aligned observation times if you
 * need day-exact buckets.
 */
export function fitCompletenessCurve(
  snapshots: readonly MetricSnapshot[],
  opts: CompletenessFitOptions,
): CompletenessFit {
  const settledAge = opts.settledAgeDays ?? SETTLED_AFTER_DAYS;
  const minCohorts = opts.minCohorts ?? 30;
  const minFinal = opts.minFinalConversions ?? 100;
  const lookup: ActionLookup = opts.window !== undefined ? { window: opts.window } : {};

  // Group every observation by the cell it describes.
  const byCell = new Map<string, MetricSnapshot[]>();
  for (const s of snapshots) {
    const key = snapshotIdentityKey(s);
    const bucket = byCell.get(key);
    if (bucket) bucket.push(s);
    else byCell.set(key, [s]);
  }

  const observedByAge = new Map<number, number>();
  const finalByAge = new Map<number, number>();
  let cohorts = 0;
  let finalConversions = 0;

  for (const observations of byCell.values()) {
    // The final count is the NEWEST settled observation, chosen by observedAt rather
    // than by position in the input array. Nothing promises the caller handed us the
    // snapshots in chronological order (`all()` happens to be append-ordered; a filtered
    // or concatenated list is not), and taking the last one positionally would silently
    // anchor the whole curve on an earlier, lower count — which biases every fitted
    // F(a) upwards and re-introduces exactly the young-creative kill this fixes.
    let final: number | undefined;
    let finalObservedAt = '';
    for (const s of observations) {
      if (daysBetween(s.statDate, s.observedAt.slice(0, 10)) < settledAge) continue;
      const v = actionValue(s.raw, opts.actionType, lookup);
      if (v === undefined) continue;
      if (s.observedAt >= finalObservedAt) {
        final = v;
        finalObservedAt = s.observedAt;
      }
    }
    // A cohort with no conversions at all carries no information about the SHAPE of the
    // curve and would divide by zero. Excluded, not treated as F=1.
    if (final === undefined || final <= 0) continue;

    cohorts++;
    finalConversions += final;
    for (const s of observations) {
      const age = daysBetween(s.statDate, s.observedAt.slice(0, 10));
      if (age < 0 || age > settledAge) continue;
      const v = actionValue(s.raw, opts.actionType, lookup);
      if (v === undefined) continue;
      observedByAge.set(age, (observedByAge.get(age) ?? 0) + v);
      finalByAge.set(age, (finalByAge.get(age) ?? 0) + final);
    }
  }

  if (cohorts < minCohorts || finalConversions < minFinal) {
    return {
      fitted: false,
      reason:
        `not enough settled history to fit a completeness curve: ${cohorts} cohorts / ` +
        `${finalConversions} final conversions, need ${minCohorts} / ${minFinal}. Keep using the ` +
        `documented default curve (which is illustrative, not measured) and re-run this once the ` +
        `account has ${settledAge}+ days of append-only snapshots.`,
    };
  }

  const ages = [...observedByAge.keys()].sort((a, b) => a - b);
  const points: CompletenessPoint[] = [];
  let running = 0;
  for (const age of ages) {
    const obs = observedByAge.get(age) ?? 0;
    const fin = finalByAge.get(age) ?? 0;
    if (fin <= 0) continue;
    // Monotone non-decreasing by construction: reporting only ever adds conversions, so a
    // dip is sampling noise and would otherwise make F(a) non-invertible.
    running = Math.min(1, Math.max(running, obs / fin));
    points.push({ ageDays: age, factor: running });
  }
  if (points.length === 0) return { fitted: false, reason: 'no usable age buckets after filtering.' };
  const last = points[points.length - 1];
  if (last !== undefined && last.ageDays < settledAge) points.push({ ageDays: settledAge, factor: 1 });

  return { fitted: true, curve: points, cohorts, finalConversions };
}
