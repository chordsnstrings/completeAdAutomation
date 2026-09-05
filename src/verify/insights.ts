/**
 * Capability probe for `src/meta/insights.ts`.
 *
 * Not a unit test. The question is whether the read path and the metric store actually do
 * their job when driven with the JSON Meta genuinely returns — string-encoded numbers,
 * nested `list<AdsActionStats>` arrays with overlapping roll-ups, cursor paging, and the
 * six title-case `async_status` strings — and whether the append-only store survives the
 * one event it exists for: a restatement.
 *
 * Every fake payload below is shaped from the dossiers, not invented:
 *
 *   - row scalars and `actions` shape — docs/research/meta-insights-measurement.md §2.2, §2.3
 *   - `purchase_roas` as a ratio in a list<AdsActionStats> — §2.4
 *   - `paging: { cursors, next }` and "follow next verbatim" — §1.6
 *   - `{"report_run_id": "6023920149050"}` and the async_status enum — §7.1
 *   - ranking strings (UNVERIFIED, no published enum) — §8.1
 *   - the F(a) anchors 0.30/0.55/0.72/0.82/0.93/0.97/0.995/1.0 —
 *     docs/research/autonomous-optimization-science.md §5.3
 *   - "~55% at day 2, ~95% at day 7" — docs/research/00-SYNTHESIS.md §6.2
 *
 * Two defects were found by this probe and fixed in `src/meta/insights.ts`:
 *
 *  1. `actionValue()` returned the FIRST matching entry when a non-default
 *     `action_breakdowns` sliced one `action_type` across several entries — reporting one
 *     device's conversions as the ad's total (20 of 37 in the fixture below), silently.
 *     It now refuses and `actionStatSlices()` exposes the slices.
 *  2. A poll that came back `Job Completed` with no numeric `async_percent_completion`
 *     could never satisfy the two-condition completion test, so it polled for the full
 *     75-minute budget and then threw a timeout blaming the query's width. `pollReport`
 *     now requests the two fields explicitly and an absent percent on a `Job Completed`
 *     is terminal-with-a-warning.
 *
 * Run standalone:
 *   node --experimental-strip-types src/verify/insights.ts
 */

import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, ConfigError } from '../config.ts';
import { MetaClient } from '../meta/client.ts';
import {
  ATTRIBUTION_REGIMES,
  CONSERVATIVE_COMPLETENESS_CURVE,
  CREATIVE_DECISION_FIELDS,
  DEFAULT_COMPLETENESS_CURVE,
  InsightsClient,
  InsightsError,
  MISSING_ATTRIBUTION_SETTING,
  MetricSnapshotStore,
  SETTLED_AFTER_DAYS,
  actionStatSlices,
  actionTypes,
  actionValue,
  actionValueAmount,
  addDays,
  assertHomogeneousAttribution,
  attributionRegime,
  buildInsightsRequest,
  completenessFactor,
  costPerAction,
  creativeRewardQuery,
  daysBetween,
  effectiveExposure,
  fitCompletenessCurve,
  identityKey,
  isSettled,
  parseNextPage,
  parseNumeric,
  purchaseRoas,
  rollingWindow,
  spendMajor,
  toSnapshots,
  videoRetention,
  type CompletenessCurve,
  type InsightsQuery,
  type InsightsRow,
  type InsightsTransport,
  type MetricSnapshot,
} from '../meta/insights.ts';

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

/* ------------------------------------------------------------------- harness ------ */

/** Thrown by a probe body that cannot run here. Carries the environmental reason. */
class Blocked extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, message: string) {
    super(message);
    this.name = 'Blocked';
    this.blockedBy = blockedBy;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} ±${tol}`,
  );
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'verify-insights-'));
}

const NOW = new Date('2026-09-05T09:00:00.000Z');
const ACCOUNT = 'act_1234567890';

/* ------------------------------------------------------------- Meta fixtures ------ */

/**
 * One `level=ad`, `time_increment=1` row as Meta returns it.
 *
 * Every scalar is a STRING. `actions` carries the overlapping roll-ups §2.3 warns about:
 * `omni_purchase` (39) spans `offsite_conversion.fb_pixel_purchase` (37) and
 * `onsite_web_purchase` (2); summing the array reports 526 purchases from 39.
 */
function realRow(overrides: Record<string, unknown> = {}): InsightsRow {
  return {
    date_start: '2026-08-25',
    date_stop: '2026-08-25',
    account_id: '1234567890',
    account_currency: 'USD',
    campaign_id: '23851111111110001',
    adset_id: '23851111111110002',
    ad_id: '23851111111110003',
    attribution_setting: '7d_click_1d_view',
    impressions: '48213',
    reach: '39102',
    frequency: '1.233117',
    spend: '742.19',
    clicks: '1043',
    inline_link_clicks: '612',
    ctr: '2.163108',
    inline_link_click_ctr: '1.269367',
    cpc: '0.711591',
    cpm: '15.393566',
    quality_ranking: 'ABOVE_AVERAGE',
    engagement_rate_ranking: 'AVERAGE',
    conversion_rate_ranking: 'BELOW_AVERAGE_35',
    actions: [
      { action_type: 'link_click', value: '612' },
      { action_type: 'landing_page_view', value: '541' },
      { action_type: 'add_to_cart', value: '96', '1d_click': '81', '7d_click': '96', '1d_view': '11' },
      {
        action_type: 'offsite_conversion.fb_pixel_purchase',
        value: '37',
        '1d_click': '31',
        '7d_click': '37',
        '1d_view': '4',
      },
      { action_type: 'onsite_web_purchase', value: '2', '1d_click': '2', '7d_click': '2' },
      { action_type: 'omni_purchase', value: '39', '1d_click': '33', '7d_click': '39', '1d_view': '4' },
      { action_type: 'purchase', value: '39' },
      { action_type: 'video_view', value: '31204' },
    ],
    action_values: [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2412.55', '7d_click': '2412.55' },
      { action_type: 'omni_purchase', value: '2538.29', '7d_click': '2538.29' },
    ],
    purchase_roas: [{ action_type: 'omni_purchase', value: '3.42' }],
    cost_per_action_type: [
      { action_type: 'link_click', value: '1.212729' },
      { action_type: 'omni_purchase', value: '19.030512' },
    ],
    video_play_actions: [{ action_type: 'video_view', value: '31204' }],
    video_thruplay_watched_actions: [{ action_type: 'video_view', value: '7411' }],
    video_p25_watched_actions: [{ action_type: 'video_view', value: '18902' }],
    video_p50_watched_actions: [{ action_type: 'video_view', value: '11330' }],
    video_p75_watched_actions: [{ action_type: 'video_view', value: '8104' }],
    video_p100_watched_actions: [{ action_type: 'video_view', value: '5216' }],
    ...overrides,
  };
}

/** A `paging` block exactly as §1.6 documents it. */
function pagingNext(after: string, path = `${ACCOUNT}/insights`): Record<string, unknown> {
  return {
    cursors: { before: 'QVFIUmx4', after },
    next:
      `https://graph.facebook.com/v26.0/${path}?access_token=EAAG_REDACTED&appsecret_proof=deadbeef` +
      `&fields=spend%2Cactions%2Cattribution_setting&level=ad&limit=500&time_increment=1&after=${after}&pretty=0`,
  };
}

/** Records every call so the probe can assert on what was actually sent to Meta. */
interface Call {
  verb: 'GET' | 'POST';
  path: string;
  params: Record<string, string>;
}

class RecordingTransport implements InsightsTransport {
  readonly calls: Call[] = [];
  private readonly getFn: (call: Call, n: number) => unknown;
  private readonly postFn: (call: Call, n: number) => unknown;

  constructor(
    getFn: (call: Call, n: number) => unknown,
    postFn: (call: Call, n: number) => unknown = () => ({ report_run_id: '6023920149050' }),
  ) {
    this.getFn = getFn;
    this.postFn = postFn;
  }

  private countOf(verb: 'GET' | 'POST', path: string): number {
    return this.calls.filter((c) => c.verb === verb && c.path === path).length;
  }

  async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const n = this.countOf('GET', path);
    const call: Call = { verb: 'GET', path, params };
    this.calls.push(call);
    return this.getFn(call, n) as T;
  }

  async post<T>(path: string, params: Record<string, string>): Promise<T> {
    const n = this.countOf('POST', path);
    const call: Call = { verb: 'POST', path, params };
    this.calls.push(call);
    return this.postFn(call, n) as T;
  }
}

/** A clock that only moves when the code under test sleeps. Decouples probe time from wall time. */
function fakeClock(start = NOW): { now: () => Date; sleep: (ms: number) => Promise<void>; ms: () => number } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
    ms: () => t,
  };
}

function client(
  transport: InsightsTransport,
  clock = fakeClock(),
  warnings: string[] = [],
): InsightsClient {
  return new InsightsClient({
    transport,
    now: clock.now,
    sleep: clock.sleep,
    onWarning: (w) => warnings.push(w),
  });
}

const BASE_QUERY: InsightsQuery = {
  adAccountId: ACCOUNT,
  level: 'ad',
  timeRange: { since: '2026-08-25', until: '2026-08-25' },
  timeIncrement: 1,
};

/* --------------------------------------------------------------------- probes ----- */

interface Probe {
  name: string;
  body: () => Promise<string> | string;
}

const PROBES: Probe[] = [
  /* ================================================================ read path ==== */
  {
    name: 'end-to-end sync pull: 28 days x 3 ads, two pages, into keyed snapshots',
    body: async () => {
      // The real shape of the hourly reward signal: one account-node call, level=ad,
      // time_increment=1, rolling 28 days. Page 1 carries 42 rows and a next cursor,
      // page 2 carries the remaining 42 and no cursor.
      const adIds = ['23851111111110003', '23851111111110004', '23851111111110005'];
      const days = Array.from({ length: 28 }, (_, i) => addDays('2026-08-09', i));
      const all: InsightsRow[] = [];
      for (const d of days) {
        for (const [i, adId] of adIds.entries()) {
          all.push(
            realRow({
              date_start: d,
              date_stop: d,
              ad_id: adId,
              spend: (100 + i * 37.5 + days.indexOf(d)).toFixed(2),
            }),
          );
        }
      }
      assert(all.length === 84, `fixture should be 84 rows, got ${all.length}`);

      const transport = new RecordingTransport((call) => {
        if (call.params['after'] === undefined) {
          return { data: all.slice(0, 42), paging: pagingNext('QVFIUlpB42') };
        }
        return { data: all.slice(42), paging: { cursors: { before: 'QVFIUlpB42', after: 'QVFIUlpB84' } } };
      });

      const warnings: string[] = [];
      const c = client(transport, fakeClock(), warnings);
      const query = creativeRewardQuery(ACCOUNT, '2026-09-05');
      const rows = await c.fetch(query);

      assert(rows.length === 84, `expected 84 rows across two pages, got ${rows.length}`);
      assert(transport.calls.length === 2, `expected 2 GETs, got ${transport.calls.length}`);
      assert(warnings.length === 0, `the shipped reward query should warn about nothing, got: ${warnings.join(' | ')}`);

      const first = transport.calls[0];
      assert(first !== undefined, 'no first call recorded');
      assert(first.path === `${ACCOUNT}/insights`, `called ${first.path}, not the account node`);
      assert(first.params['level'] === 'ad', 'level=ad is what gives every ad its own row');
      assert(first.params['time_increment'] === '1', 'time_increment=1 is what gives every ad an age axis');
      const tr = JSON.parse(first.params['time_range'] ?? '{}') as { since?: string; until?: string };
      assert(tr.since === '2026-08-09' && tr.until === '2026-09-05', `rolling window wrong: ${JSON.stringify(tr)}`);
      assert(
        daysBetween(tr.since ?? '', tr.until ?? '') === SETTLED_AFTER_DAYS - 1,
        'the re-fetch window must be 28 days inclusive, not 7',
      );

      const snapshots = toSnapshots(rows, { level: 'ad', adAccountId: ACCOUNT, observedAt: NOW });
      assert(snapshots.length === 84, `expected 84 snapshots, got ${snapshots.length}`);
      const keys = new Set(snapshots.map((s) => identityKey(s)));
      assert(keys.size === 84, `84 (ad, day) cells must produce 84 distinct keys, got ${keys.size}`);
      const one = snapshots[0];
      assert(one !== undefined, 'no snapshot');
      assert(one.statDate === '2026-08-09' && one.objectId === '23851111111110003', 'snapshot mis-keyed');
      assert(one.attributionSetting === '7d_click_1d_view', 'attribution_setting is part of the identity');
      assert(one.attributionRegime === ATTRIBUTION_REGIMES.ENGAGE_THROUGH, 'regime stamp wrong for an Aug-2026 stat date');
      assert(one.observedAt === NOW.toISOString(), 'observedAt must come from the injected clock');

      const spendTotal = rows.reduce((a, r) => a + (spendMajor(r) ?? 0), 0);
      assert(spendTotal > 0 && Number.isFinite(spendTotal), 'spend did not parse');
      return (
        `2 GETs -> 84 rows -> 84 distinctly keyed snapshots; window ${tr.since}..${tr.until} (28d inclusive), ` +
        `level=ad, time_increment=1, total spend $${spendTotal.toFixed(2)} parsed from decimal strings.`
      );
    },
  },

  {
    name: 'paging.next is followed verbatim and only the credentials are dropped',
    body: async () => {
      const transport = new RecordingTransport((call) =>
        call.params['after'] === undefined
          ? { data: [realRow()], paging: pagingNext('QVFIUlpB42') }
          : { data: [realRow({ ad_id: '23851111111110004' })], paging: {} },
      );
      await client(transport).fetch(BASE_QUERY);

      const second = transport.calls[1];
      assert(second !== undefined, 'the second page was never requested');
      assert(second.path === `${ACCOUNT}/insights`, `next-page path was ${second.path}; the vXX.0 prefix must be stripped`);
      assert(second.params['after'] === 'QVFIUlpB42', 'the opaque cursor was not carried through (error 2642 territory)');
      assert(second.params['fields'] === 'spend,actions,attribution_setting', 'Meta-authored params must survive verbatim');
      assert(second.params['pretty'] === '0', 'unmodelled Meta params must survive too');
      assert(second.params['access_token'] === undefined, 'access_token must NOT be carried through');
      assert(second.params['appsecret_proof'] === undefined, 'appsecret_proof must NOT be carried through');

      const direct = parseNextPage(
        'https://graph.facebook.com/v26.0/6023920149050/insights?access_token=EAA&appsecret_proof=x&after=A%3D%3D&limit=500',
      );
      assert(direct.path === '6023920149050/insights', `report-run paging path wrong: ${direct.path}`);
      assert(direct.params['after'] === 'A==', 'the cursor must be percent-decoded once, not twice');
      let rejected = false;
      try {
        parseNextPage('not-a-url');
      } catch (e) {
        rejected = e instanceof InsightsError;
      }
      assert(rejected, 'a malformed paging.next must be refused, not silently treated as a path');
      return 'next-page GET carried after/fields/limit/pretty and dropped both credentials; version prefix stripped; malformed next refused.';
    },
  },

  {
    name: 'every scalar and structured field of a real row parses without producing NaN',
    body: () => {
      const row = realRow();
      const readings: Record<string, number | undefined> = {
        spend: spendMajor(row),
        impressions: parseNumeric(row['impressions']),
        reach: parseNumeric(row['reach']),
        frequency: parseNumeric(row['frequency']),
        ctr: parseNumeric(row['ctr']),
        cpm: parseNumeric(row['cpm']),
        pixelPurchases: actionValue(row, 'offsite_conversion.fb_pixel_purchase'),
        pixelRevenue: actionValueAmount(row, 'offsite_conversion.fb_pixel_purchase'),
        roas: purchaseRoas(row),
        cpaReported: costPerAction(row, 'omni_purchase'),
        cpaDerived: costPerAction(row, 'omni_purchase', { source: 'derived' }),
      };
      for (const [k, v] of Object.entries(readings)) {
        assert(v !== undefined, `${k} read as undefined from a row that contains it`);
        assert(Number.isFinite(v), `${k} read as ${v} — NaN/Infinity must be impossible`);
      }
      near(readings['spend'] ?? 0, 742.19, 1e-9, 'spend is MAJOR units');
      near(readings['roas'] ?? 0, 3.42, 1e-9, 'purchase_roas is a ratio');
      near(readings['cpaReported'] ?? 0, 19.030512, 1e-9, "cost_per_action_type is Meta's own number");
      near(readings['cpaDerived'] ?? 0, 742.19 / 39, 1e-9, 'derived CPA is spend/actions');
      assert(
        (readings['cpaReported'] ?? 0) !== (readings['cpaDerived'] ?? 0),
        'reported and derived CPA legitimately disagree; a silent fallback between them would be a moving definition',
      );

      // The ranking strings have no published enum (§8.1). Nothing here may switch on them.
      assert(typeof row['quality_ranking'] === 'string', 'ranking diagnostics are bare strings');

      // NaN-manufacturing inputs.
      assert(parseNumeric('') === undefined, 'Number("") is 0 — empty must stay absent');
      assert(parseNumeric(undefined) === undefined, 'absent must stay absent');
      assert(parseNumeric('n/a') === undefined, 'unparseable must be undefined, never NaN');
      assert(parseNumeric('Infinity') === undefined, 'Infinity is not a finite metric');
      assert(parseNumeric('0') === 0, 'a reported zero must survive as 0, not become undefined');
      const zeroRow: InsightsRow = { spend: '742.19', actions: [{ action_type: 'lead', value: '0' }] };
      assert(actionValue(zeroRow, 'lead') === 0, 'a reported zero must read as 0');
      assert(actionValue(zeroRow, 'purchase') === undefined, 'an absent action must read as undefined, not 0');
      assert(
        costPerAction(zeroRow, 'lead', { source: 'derived' }) === undefined,
        'dividing by a zero action count would manufacture Infinity, which sorts as "worst" and kills a good ad',
      );
      return (
        `11 accessors over a full real row: all finite. spend=$742.19, ROAS=3.42x, Meta's cost_per_action_type ` +
        `$19.030512 vs derived spend/actions $${(742.19 / 39).toFixed(6)} (they legitimately differ). ` +
        `"" / undefined / "n/a" / "Infinity" all -> undefined; "0" -> 0.`
      );
    },
  },

  {
    name: 'action accessors read one named type and never sum overlapping roll-ups',
    body: () => {
      const row = realRow();
      const types = actionTypes(row);
      assert(types.length === 8, `expected 8 distinct action types, got ${types.length}: ${types.join(',')}`);
      assert(types.includes('omni_purchase') && types.includes('offsite_conversion.fb_pixel_purchase'), 'roll-up membership fixture wrong');

      const pixel = actionValue(row, 'offsite_conversion.fb_pixel_purchase');
      const onsite = actionValue(row, 'onsite_web_purchase');
      const omni = actionValue(row, 'omni_purchase');
      assert(pixel === 37 && onsite === 2 && omni === 39, `roll-ups misread: ${pixel}/${onsite}/${omni}`);
      const naiveSum: number = (row['actions'] as { value?: string }[]).reduce((a, s) => a + Number(s.value ?? 0), 0);
      assert(naiveSum === 32570, `naive sum fixture drifted: ${naiveSum}`);
      const omniAsNumber: number = omni;
      assert(omniAsNumber !== naiveSum, 'summing actions[].value would report 32570 conversions from 39');

      // Window keys are attribution-setting independent, which is the only safe way to
      // aggregate rows whose ad sets disagree.
      assert(actionValue(row, 'omni_purchase', { window: '1d_click' }) === 33, '1d_click key misread');
      assert(actionValue(row, 'omni_purchase', { window: '7d_click' }) === 39, '7d_click key misread');
      assert(
        actionValue(row, 'omni_purchase', { window: '1d_ev' }) === undefined,
        'a window key Meta omitted must be undefined, not 0 — omission is ambiguous between "not requested" and "none"',
      );
      assert(actionValue(row, 'link_click', { window: '1d_click' }) === undefined, 'link_click carries no window keys in this fixture');

      // Dead windows are refused rather than answered with a fraction of the truth.
      let deadRefused = false;
      try {
        actionValue(row, 'omni_purchase', { window: '7d_view' as never });
      } catch (e) {
        deadRefused = e instanceof InsightsError && /2026-01-12/.test(e.message);
      }
      assert(deadRefused, '7d_view must be refused at read time, not returned as zero');

      const vr = videoRetention(row);
      assert(vr.plays === 31204, 'video_play_actions misread');
      near(vr.hookRetention ?? 0, 18902 / 31204, 1e-12, 'hook retention is p25/plays');
      near(vr.completionRate ?? 0, 5216 / 31204, 1e-12, 'completion is p100/plays');
      assert(vr.thruplays === 7411, 'thruplay misread');
      assert(
        (vr.hookRetention ?? 0) > (vr.p50Rate ?? 1) && (vr.p50Rate ?? 0) > (vr.p75Rate ?? 1),
        'retention must be monotone decreasing across quartiles',
      );
      const noVideo = videoRetention(realRow({ video_play_actions: [] }));
      assert(
        noVideo.plays === undefined && noVideo.hookRetention === undefined,
        'a missing denominator must yield undefined, not NaN',
      );
      const zeroPlays = videoRetention(realRow({ video_play_actions: [{ action_type: 'video_view', value: '0' }] }));
      assert(zeroPlays.plays === 0 && zeroPlays.hookRetention === undefined, '0 plays must not divide');
      return (
        `8 action types enumerated; pixel 37 / onsite 2 / omni 39 read individually (naive sum would say 32570). ` +
        `Window keys 1d_click=33, 7d_click=39, absent 1d_ev=undefined; 7d_view refused. ` +
        `Hook retention ${((vr.hookRetention ?? 0) * 100).toFixed(1)}% > p50 > p75, and 0/absent plays give undefined not NaN.`
      );
    },
  },

  {
    name: 'DEFECT (fixed): action_breakdowns slices are refused, not silently under-reported',
    body: () => {
      // Requesting action_breakdowns=action_device makes Meta return ONE ENTRY PER SLICE.
      // Before the fix, actionValue returned the first (20) as if it were the ad's total (37).
      const sliced: InsightsRow = {
        date_start: '2026-08-25',
        ad_id: '23851111111110003',
        attribution_setting: '7d_click_1d_view',
        spend: '742.19',
        actions: [
          { action_type: 'offsite_conversion.fb_pixel_purchase', action_device: 'desktop', value: '20', '7d_click': '20' },
          { action_type: 'offsite_conversion.fb_pixel_purchase', action_device: 'iphone', value: '17', '7d_click': '17' },
          { action_type: 'link_click', action_device: 'desktop', value: '300' },
          { action_type: 'link_click', action_device: 'iphone', value: '312' },
        ],
      };

      let refused: InsightsError | undefined;
      try {
        actionValue(sliced, 'offsite_conversion.fb_pixel_purchase');
      } catch (e) {
        if (e instanceof InsightsError) refused = e;
      }
      assert(
        refused !== undefined,
        'REGRESSION: actionValue returned a single slice as the ad total. 20 of 37 purchases is a 46% under-count with no error.',
      );
      assert(/action_device/.test(refused.message), `the refusal must name the breakdown key that caused it: ${refused.message}`);
      assert(/actionStatSlices/.test(refused.message), 'the refusal must name the accessor that can read the shape');

      const slices = actionStatSlices(sliced, 'offsite_conversion.fb_pixel_purchase');
      assert(slices.length === 2, `expected 2 device slices, got ${slices.length}`);
      const total = slices.reduce((a, s) => a + (parseNumeric(s['value']) ?? 0), 0);
      assert(total === 37, `slices must sum to the true total 37, got ${total}`);

      // Everything downstream of actionValue inherits the refusal rather than the lie.
      let cpaRefused = false;
      try {
        costPerAction(sliced, 'link_click', { source: 'derived' });
      } catch (e) {
        cpaRefused = e instanceof InsightsError;
      }
      assert(cpaRefused, 'costPerAction must inherit the refusal rather than divide by one slice');

      // An unsliced row is untouched: exactly one entry per action_type, no refusal.
      assert(actionValue(realRow(), 'omni_purchase') === 39, 'the default action_breakdowns=action_type path must be unaffected');

      // And the builder now warns at request time, before the shape ever arrives.
      const built = buildInsightsRequest(
        { ...BASE_QUERY, actionBreakdowns: ['action_type', 'action_device'] },
        NOW,
      );
      assert(built.params['action_breakdowns'] === 'action_type,action_device', 'the parameter must still be sent');
      assert(
        built.warnings.some((w) => /action_device/.test(w) && /actionStatSlices/.test(w)),
        `buildInsightsRequest must warn that the response will be sliced; warnings: ${JSON.stringify(built.warnings)}`,
      );
      assert(
        buildInsightsRequest({ ...BASE_QUERY, actionBreakdowns: ['action_type'] }, NOW).warnings.length === 0,
        'the default action_breakdowns=action_type must not warn',
      );
      return (
        'A device-sliced row (20 desktop + 17 iphone = 37) now throws naming action_device and actionStatSlices ' +
        'instead of returning 20; slices sum to 37; costPerAction inherits the refusal; the unsliced path is unchanged; ' +
        'buildInsightsRequest warns at request time.'
      );
    },
  },

  /* =============================================================== async jobs ==== */
  {
    name: 'async report lifecycle: submit -> Job Skipped -> resubmit -> Completed -> fetch',
    body: async () => {
      const statusesRun1 = [
        { async_status: 'Job Not Started', async_percent_completion: '0' },
        { async_status: 'Job Running', async_percent_completion: '43' },
        { async_status: 'Job Skipped', async_percent_completion: '0' },
      ];
      const statusesRun2 = [
        { async_status: 'Job Started', async_percent_completion: '0' },
        { async_status: 'Job Running', async_percent_completion: '100' }, // 100 but NOT done
        { async_status: 'Job Completed', async_percent_completion: '100' },
      ];
      const resultRows = [realRow(), realRow({ ad_id: '23851111111110004' })];
      let resultsFetchedBeforeCompletion = false;
      let completed = false;
      let submits = 0;

      const transport = new RecordingTransport(
        (call, n) => {
          if (call.path.endsWith('/insights')) {
            if (!completed) resultsFetchedBeforeCompletion = true;
            return { data: resultRows, paging: { cursors: { after: 'X' } } };
          }
          const table = call.path === 'run_1' ? statusesRun1 : statusesRun2;
          const s = table[Math.min(n, table.length - 1)];
          if (s?.async_status === 'Job Completed') completed = true;
          return s;
        },
        () => {
          submits += 1;
          return { report_run_id: `run_${submits}` };
        },
      );

      const clock = fakeClock();
      const warnings: string[] = [];
      const c = client(transport, clock, warnings);
      const t0 = clock.ms();
      const result = await c.runAsyncReport({ ...BASE_QUERY, breakdowns: ['publisher_platform'] });

      assert(submits === 2, `Job Skipped means "expired, resubmit"; expected 2 submits, got ${submits}`);
      assert(result.resubmits === 1, `expected 1 resubmit, got ${result.resubmits}`);
      assert(result.reportRunId === 'run_2', `results must come from the resubmitted job, got ${result.reportRunId}`);
      assert(result.polls === 6, `expected 3+3 polls, got ${result.polls}`);
      assert(result.rows.length === 2, `expected 2 result rows, got ${result.rows.length}`);
      assert(!resultsFetchedBeforeCompletion, 'CRITICAL: results were read while the job was still running — that returns partial data with NO error');
      assert(
        result.warnings.some((w) => /Job Skipped/.test(w)),
        `the resubmit must be surfaced, not swallowed: ${JSON.stringify(result.warnings)}`,
      );

      // The POST carried the built query; the polls carried the two fields Meta documents.
      const post = transport.calls.find((c2) => c2.verb === 'POST');
      assert(post !== undefined && post.path === `${ACCOUNT}/insights`, 'the async switch is the HTTP verb on the same path');
      assert(post.params['breakdowns'] === 'publisher_platform', 'the breakdown must reach the job');
      const poll = transport.calls.find((c2) => c2.verb === 'GET' && c2.path === 'run_1');
      assert(poll !== undefined, 'no poll of the AdReportRun node');
      assert(
        poll.params['fields'] === 'async_status,async_percent_completion',
        `the poll must request both fields explicitly rather than trusting an undocumented default set; got ${JSON.stringify(poll.params)}`,
      );
      const readPath = transport.calls.filter((c2) => c2.path === 'run_2/insights');
      assert(readPath.length === 1, 'results are read from <report_run_id>/insights');

      const elapsedMin = (clock.ms() - t0) / 60000;
      assert(elapsedMin > 0.4 && elapsedMin < 15, `backoff should span minutes of simulated time, got ${elapsedMin.toFixed(2)}min`);
      return (
        `submit run_1 -> Not Started/Running/Skipped -> resubmit run_2 -> Started/Running(100%)/Completed -> ` +
        `GET run_2/insights -> 2 rows. 6 polls over ${elapsedMin.toFixed(1)} simulated minutes; results never read early; ` +
        `polls request fields=async_status,async_percent_completion.`
      );
    },
  },

  {
    name: 'DEFECT (fixed): Job Completed with no percent terminates instead of hanging 75 minutes',
    body: async () => {
      // Meta's AdReportRun default field set is undocumented. A poll that comes back with
      // async_status but no async_percent_completion can never satisfy `=== 100`, so the
      // pre-fix code polled for the whole 75-minute budget and then threw a timeout that
      // blamed the query's width — a diagnosis that sends you to narrow a query that was fine.
      let polls = 0;
      const transport = new RecordingTransport((call) => {
        if (call.path.endsWith('/insights')) return { data: [realRow()], paging: {} };
        polls += 1;
        return { async_status: 'Job Completed' }; // no async_percent_completion at all
      });
      const clock = fakeClock();
      const c = client(transport, clock);
      const t0 = clock.ms();
      const result = await c.runAsyncReport(BASE_QUERY);
      const elapsedMin = (clock.ms() - t0) / 60000;

      assert(result.rows.length === 1, `expected the results to be read, got ${result.rows.length} rows`);
      assert(polls <= 2, `REGRESSION: ${polls} polls means it is waiting on a percent that will never arrive`);
      assert(elapsedMin < 1, `REGRESSION: burned ${elapsedMin.toFixed(0)} simulated minutes before giving up`);
      assert(
        result.warnings.some((w) => /async_percent_completion/.test(w)),
        `an absent percent must be flagged, not silently accepted: ${JSON.stringify(result.warnings)}`,
      );

      // A NUMERIC percent below 100 must still be waited on — that is Meta's documented rule.
      let waited = 0;
      const partial = new RecordingTransport((call, n) => {
        if (call.path.endsWith('/insights')) return { data: [], paging: {} };
        waited += 1;
        return n < 3
          ? { async_status: 'Job Completed', async_percent_completion: '99' }
          : { async_status: 'Job Completed', async_percent_completion: '100' };
      });
      await client(partial).runAsyncReport(BASE_QUERY);
      assert(waited === 4, `a numeric percent below 100 must keep polling; polled ${waited} times`);
      return (
        `Job Completed with the percent field absent now terminates after ${polls} poll(s) in ` +
        `${elapsedMin.toFixed(2)} simulated minutes with a warning (was: 80 polls / 75 minutes / "narrow the time range"). ` +
        `A numeric 99 still waits for 100.`
      );
    },
  },

  {
    name: 'Job Failed is thrown with the query described and never blind-resubmitted',
    body: async () => {
      let submits = 0;
      const transport = new RecordingTransport(
        () => ({ async_status: 'Job Failed', async_percent_completion: '100' }),
        () => {
          submits += 1;
          return { report_run_id: 'run_1' };
        },
      );
      let err: Error | undefined;
      try {
        await client(transport).runAsyncReport({ ...BASE_QUERY, breakdowns: ['country', 'publisher_platform'] });
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      assert(err !== undefined, 'Job Failed must not resolve');
      assert(/Job Failed/.test(err.message) && /requires query review/.test(err.message), `message lost Meta's own wording: ${err.message}`);
      assert(/breakdowns=\[country,publisher_platform\]/.test(err.message), 'the failing query must be described in the error');
      assert(submits === 1, `a malformed query must not be blind-retried (4xx subtracts from the insights quota); submitted ${submits} times`);

      // Endless skips eventually give up and name the real cause.
      const skipping = new RecordingTransport(() => ({ async_status: 'Job Skipped', async_percent_completion: '0' }));
      let skipErr = '';
      try {
        await client(skipping).runAsyncReport(BASE_QUERY, { maxResubmits: 1 });
      } catch (e) {
        skipErr = e instanceof Error ? e.message : String(e);
      }
      assert(/async job allowance/.test(skipErr), `endless skips must name the allowance: ${skipErr}`);

      // An unknown status is polled through rather than crashing a nightly backfill.
      const odd = new RecordingTransport((call, n) => {
        if (call.path.endsWith('/insights')) return { data: [] };
        return n === 0
          ? { async_status: 'Job Percolating', async_percent_completion: '10' }
          : { async_status: 'Job Completed', async_percent_completion: '100' };
      });
      const res = await client(odd).runAsyncReport(BASE_QUERY);
      assert(res.warnings.some((w) => /Job Percolating/.test(w)), 'an unknown status must be warned about');
      return 'Job Failed -> thrown once with breakdowns named, never resubmitted; endless Job Skipped -> names the 10/24h allowance; unknown status -> warned and polled through.';
    },
  },

  {
    name: 'a real MetaClient in SIMULATE is caught short-circuiting the async POST',
    body: async () => {
      // The genuine transport, with a fetch that would explode if it were ever reached.
      const meta = new MetaClient({
        appId: '000',
        appSecret: 'secret',
        accessToken: 'token',
        mode: 'SIMULATE',
        fetchImpl: (async () => {
          throw new Error('the probe must not touch the network here');
        }) as unknown as typeof fetch,
      });
      const c = new InsightsClient({ transport: meta, now: () => NOW, sleep: async () => {}, onWarning: () => {} });
      let err: InsightsError | undefined;
      try {
        await c.submitReport(BASE_QUERY);
      } catch (e) {
        if (e instanceof InsightsError) err = e;
      }
      assert(err !== undefined, 'CRITICAL: a fabricated simulated id would be polled forever');
      assert(/SIMULATE/.test(err.message) && /read, not a write/.test(err.message), `unhelpful message: ${err.message}`);

      // And a transport that answers a POST with no report_run_id at all.
      const noId = new RecordingTransport(() => ({}), () => ({ error: { message: 'x' } }));
      let loud = false;
      try {
        await client(noId).submitReport(BASE_QUERY);
      } catch (e) {
        loud = e instanceof InsightsError && /did not return a report_run_id/.test(e.message);
      }
      assert(loud, 'a POST without a report_run_id must fail loudly');

      // A stale report_run_id is refused rather than read.
      const stale = new RecordingTransport(() => ({ data: [] }));
      let refused = false;
      try {
        await client(stale).fetchReportResults('6023920149050', new Date(NOW.getTime() - 31 * 86_400_000));
      } catch (e) {
        refused = e instanceof InsightsError && /expires them after 30/.test(e.message);
      }
      assert(refused, 'a 31-day-old report_run_id must be refused');
      return 'MetaClient(SIMULATE).post returns {__simulated:true}; the module names it rather than polling a fabricated id. Missing report_run_id fails loudly; a 31-day-old id is refused.';
    },
  },

  /* ============================================================ append-only ====== */
  {
    name: 'restatement under a CHANGED attribution setting keeps both rows, distinguishable',
    body: () => {
      const path = join(scratchDir(), 'snapshots.jsonl');
      const store = new MetricSnapshotStore({ path });

      // Tuesday: the ad set is on 7d_click_1d_view and reports 12 purchases.
      const tuesday = new Date('2026-08-26T06:00:00.000Z');
      store.append(
        toSnapshots(
          [
            realRow({
              attribution_setting: '7d_click_1d_view',
              actions: [{ action_type: 'omni_purchase', value: '12' }],
              spend: '742.19',
            }),
          ],
          { level: 'ad', adAccountId: ACCOUNT, observedAt: tuesday },
        ),
      );

      // Thursday: the same ad, the same stat date, restated — AND the ad set's attribution
      // setting has been changed to 7d_click, so the number now means something different.
      const thursday = new Date('2026-08-28T06:00:00.000Z');
      store.append(
        toSnapshots(
          [
            realRow({
              attribution_setting: '7d_click',
              actions: [{ action_type: 'omni_purchase', value: '19' }],
              spend: '742.19',
            }),
          ],
          { level: 'ad', adAccountId: ACCOUNT, observedAt: thursday },
        ),
      );

      const all = store.all();
      assert(all.length === 2, `both observations must survive; store holds ${all.length}`);
      const a = all[0];
      const b = all[1];
      assert(a !== undefined && b !== undefined, 'missing rows');
      assert(identityKey(a) !== identityKey(b), 'differing attribution settings must produce different identities');
      assert(actionValue(a.raw, 'omni_purchase') === 12, "Tuesday's row must still say 12");
      assert(actionValue(b.raw, 'omni_purchase') === 19, "Thursday's row must say 19");
      assert(a.observedAt === tuesday.toISOString() && b.observedAt === thursday.toISOString(), 'observed_at lost');
      assert(a.attributionSetting === '7d_click_1d_view' && b.attributionSetting === '7d_click', 'the setting is not on the row');

      // Both are live cells. Aggregating them is refused, because 12 and 19 are not commensurable.
      const current = store.asOf(new Date('2026-09-05T00:00:00.000Z'));
      assert(current.length === 2, `asOf must expose both incommensurable cells, got ${current.length}`);
      let aggRefused = false;
      try {
        assertHomogeneousAttribution(current);
      } catch (e) {
        aggRefused = e instanceof InsightsError && /not commensurable/.test(e.message);
      }
      assert(aggRefused, 'summing across attribution settings must be refused');
      assertHomogeneousAttribution(current, { readingExplicitWindow: true }); // the escape hatch

      // A restatement under the SAME setting is a new row on the SAME identity: a trail.
      const friday = new Date('2026-08-29T06:00:00.000Z');
      store.append(
        toSnapshots(
          [realRow({ attribution_setting: '7d_click', actions: [{ action_type: 'omni_purchase', value: '23' }] })],
          { level: 'ad', adAccountId: ACCOUNT, observedAt: friday },
        ),
      );
      const trail = store.history({
        level: 'ad',
        objectId: '23851111111110003',
        statDate: '2026-08-25',
        attributionSetting: '7d_click',
      });
      assert(trail.length === 2, `the 7d_click cell must have 2 observations, got ${trail.length}`);
      assert(
        trail.map((s) => actionValue(s.raw, 'omni_purchase')).join(',') === '19,23',
        'the trail must be oldest-first and unmodified',
      );
      const onDisk = readFileSync(path, 'utf8').trim().split('\n');
      assert(onDisk.length === 3, `the file must hold 3 append-only lines, got ${onDisk.length}`);
      return (
        'Tuesday(7d_click_1d_view,12) and Thursday(7d_click,19) both survive as separate identities; ' +
        'aggregating them is refused as incommensurable; a same-setting restatement (23) appends a 3rd line ' +
        'and history() returns 19,23 oldest-first. Nothing overwritten, 3 lines on disk.'
      );
    },
  },

  {
    name: 'asOf replays what we believed when we spent the money, not what Meta says now',
    body: () => {
      const path = join(scratchDir(), 'snapshots.jsonl');
      const store = new MetricSnapshotStore({ path });
      const observations: Array<[string, string]> = [
        ['2026-08-26T06:00:00.000Z', '9'],
        ['2026-08-28T06:00:00.000Z', '17'],
        ['2026-09-02T06:00:00.000Z', '24'],
        ['2026-09-22T06:00:00.000Z', '26'],
      ];
      for (const [at, conv] of observations) {
        store.append(
          toSnapshots([realRow({ actions: [{ action_type: 'omni_purchase', value: conv }] })], {
            level: 'ad',
            adAccountId: ACCOUNT,
            observedAt: new Date(at),
          }),
        );
      }

      // The decision we are auditing: on 2026-08-26 the ad looked like $742.19 / 9 = $82 CPA.
      const asTuesday = store.asOf('2026-08-26T12:00:00.000Z');
      assert(asTuesday.length === 1, `one cell, one belief; got ${asTuesday.length}`);
      const tueRow = asTuesday[0];
      assert(tueRow !== undefined && actionValue(tueRow.raw, 'omni_purchase') === 9, 'asOf did not replay the Tuesday belief');
      const tueCpa = costPerAction(tueRow.raw, 'omni_purchase', { source: 'derived' });
      near(tueCpa ?? 0, 742.19 / 9, 1e-9, 'Tuesday CPA');

      // Today, the same cell reads $28.55 — the ad was never as bad as it looked.
      const now = store.latest(new Date('2026-09-30T00:00:00.000Z'));
      const nowRow = now[0];
      assert(nowRow !== undefined && actionValue(nowRow.raw, 'omni_purchase') === 26, 'latest did not surface the newest observation');
      const nowCpa = costPerAction(nowRow.raw, 'omni_purchase', { source: 'derived' });
      near(nowCpa ?? 0, 742.19 / 26, 1e-9, 'final CPA');

      // Nothing observed after the cutoff may leak into a replay.
      assert(store.asOf('2026-08-25T00:00:00.000Z').length === 0, 'a cutoff before the first read must return nothing');
      assert(store.asOf('2026-09-02T06:00:00.000Z').length === 1, 'the cutoff is inclusive of an observation at exactly that instant');
      const mid = store.asOf('2026-09-02T06:00:00.000Z')[0];
      assert(mid !== undefined && actionValue(mid.raw, 'omni_purchase') === 24, 'asOf picked the wrong observation at the boundary');
      assert(store.history({ level: 'ad', objectId: '23851111111110003', statDate: '2026-08-25', attributionSetting: '7d_click_1d_view' }).length === 4, 'the full trail must be four long');
      return (
        `4 restatements of one cell (9 -> 17 -> 24 -> 26). asOf(Tue) reports CPA $${(742.19 / 9).toFixed(2)} — the number ` +
        `the kill decision would have used — while latest() reports $${(742.19 / 26).toFixed(2)}. A keyed upsert would have ` +
        `destroyed the first answer.`
      );
    },
  },

  {
    name: 'the store round-trips through disk byte-for-byte, including hostile raw payloads',
    body: () => {
      const path = join(scratchDir(), 'snapshots.jsonl');
      // Asset-breakdown text is free-form advertiser copy: newlines, tabs, quotes,
      // emoji, and a lone U+2028 are all things a real body_asset has carried.
      const hostile = realRow({
        body_asset: { id: '605123456789012', text: 'Line one\nLine "two"\tthree four \u{1F680} \\backslash' },
        image_asset: { id: '605999', hash: 'abc def' },
        actions: [{ action_type: 'omni_purchase', value: '39' }],
      });
      const store = new MetricSnapshotStore({ path });
      store.append(
        toSnapshots([hostile], {
          level: 'ad',
          adAccountId: ACCOUNT,
          observedAt: NOW,
          breakdowns: ['body_asset', 'image_asset'],
        }),
      );
      const written = store.all()[0];
      assert(written !== undefined, 'nothing appended');
      assert(
        written.breakdownKey === 'body_asset=605123456789012|image_asset=605999',
        `asset breakdowns must key on the stable id, got "${written.breakdownKey}"`,
      );

      const reloaded = new MetricSnapshotStore({ path });
      assert(reloaded.warnings.length === 0, `clean reload expected: ${reloaded.warnings.join(' | ')}`);
      assert(reloaded.all().length === 1, `expected 1 row after reload, got ${reloaded.all().length}`);
      const back = reloaded.all()[0];
      assert(back !== undefined, 'reload lost the row');
      assert(
        JSON.stringify(back.raw) === JSON.stringify(hostile),
        'the raw payload must survive JSONL round-trip verbatim — unmodelled fields are the point of storing it',
      );
      assert(identityKey(back) === identityKey(written), 'identity changed across a reload');
      assert(actionValue(back.raw, 'omni_purchase') === 39, 'accessors must work on a reloaded row');

      // Distinct breakdown coordinates must not collide, and a row missing a breakdown
      // value must not silently share a key with another that is also missing it.
      const store2 = new MetricSnapshotStore({ path: join(scratchDir(), 's2.jsonl') });
      store2.append(
        toSnapshots(
          [
            realRow({ publisher_platform: 'facebook', actions: [] }),
            realRow({ publisher_platform: 'instagram', actions: [] }),
          ],
          { level: 'ad', adAccountId: ACCOUNT, observedAt: NOW, breakdowns: ['publisher_platform'] },
        ),
      );
      const keys = new Set(store2.all().map((s) => identityKey(s)));
      assert(keys.size === 2, `two platform rows must not collide; got ${keys.size} keys`);
      assert(store2.asOf(NOW).length === 2, 'asOf must keep both breakdown cells');
      return (
        'A row carrying newlines, tabs, quotes, U+2028, a NUL (the identity-key delimiter) and an emoji round-trips ' +
        'byte-identical through JSONL; asset breakdowns key on the stable id (605123456789012), not the text; ' +
        'facebook/instagram platform rows stay distinct.'
      );
    },
  },

  {
    name: 'a torn final line is survivable; an edited earlier line is refused',
    body: () => {
      const dir = scratchDir();
      const path = join(dir, 'torn.jsonl');
      const store = new MetricSnapshotStore({ path });
      store.append(
        toSnapshots([realRow(), realRow({ ad_id: '23851111111110004' })], {
          level: 'ad',
          adAccountId: ACCOUNT,
          observedAt: NOW,
        }),
      );
      // Simulate a crash mid-append: the last line is half-written.
      appendFileSync(path, '{"level":"ad","objectId":"238511111111100');
      const recovered = new MetricSnapshotStore({ path });
      assert(recovered.all().length === 2, `the two intact observations must survive, got ${recovered.all().length}`);
      assert(
        recovered.warnings.some((w) => /torn final line/.test(w)),
        `the loss must be reported, not swallowed: ${JSON.stringify(recovered.warnings)}`,
      );

      // An earlier corrupt line means the file was edited or the disk lied. Refuse.
      const bad = join(dir, 'bad.jsonl');
      const good = readFileSync(path, 'utf8').split('\n')[0];
      assert(good !== undefined, 'fixture line missing');
      writeFileSync(bad, `${good}\n{"level":"ad","objectId":\n${good}\n`);
      let refused = false;
      try {
        new MetricSnapshotStore({ path: bad });
      } catch (e) {
        refused = e instanceof InsightsError && /is corrupt/.test(e.message);
      }
      assert(refused, 'a corrupt non-final line must be refused, not skipped');

      // A shape that parses as JSON but is not a snapshot is not a snapshot.
      const wrong = join(dir, 'wrong.jsonl');
      writeFileSync(wrong, `${good}\n{"hello":"world"}\n${good}\n`);
      let rejectedShape = false;
      try {
        new MetricSnapshotStore({ path: wrong });
      } catch (e) {
        rejectedShape = e instanceof InsightsError;
      }
      assert(rejectedShape, 'valid JSON of the wrong shape must be refused');

      // An absent store is not an error; a fresh one is empty.
      const fresh = new MetricSnapshotStore({ path: join(dir, 'nope', 'deep.jsonl') });
      assert(fresh.all().length === 0 && fresh.warnings.length === 0, 'a missing store must load as empty');
      return 'Torn final line -> 2 rows kept + a warning. Corrupt middle line -> refused. Valid JSON of the wrong shape -> refused. Missing file -> empty, no error.';
    },
  },

  {
    name: 'a row that cannot be keyed is refused, and a missing setting gets the sentinel',
    body: () => {
      let noDate = false;
      try {
        toSnapshots([realRow({ date_start: undefined })], { level: 'ad', adAccountId: ACCOUNT, observedAt: NOW });
      } catch (e) {
        noDate = e instanceof InsightsError && /date_start/.test(e.message);
      }
      assert(noDate, 'a row with no date_start must be refused rather than stored under a guess');

      let noId = false;
      try {
        toSnapshots([realRow({ ad_id: undefined })], { level: 'ad', adAccountId: ACCOUNT, observedAt: NOW });
      } catch (e) {
        noId = e instanceof InsightsError && /ad_id/.test(e.message);
      }
      assert(noId, 'a level=ad row with no ad_id must be refused');

      // level and node are orthogonal: an account-level row keys on account_id.
      const acct = toSnapshots([realRow({ attribution_setting: undefined })], {
        level: 'account',
        adAccountId: ACCOUNT,
        observedAt: NOW,
        source: 'async',
      });
      const s = acct[0];
      assert(s !== undefined && s.objectId === '1234567890', 'account-level rows key on account_id');
      assert(s.attributionSetting === MISSING_ATTRIBUTION_SETTING, 'a missing setting must get the sentinel, not a silent default');
      assert(s.source === 'async', 'the provenance of the read must be recorded');
      let sentinelRefused = false;
      try {
        assertHomogeneousAttribution([{ attributionSetting: MISSING_ATTRIBUTION_SETTING }, { attributionSetting: '7d_click' }]);
      } catch {
        sentinelRefused = true;
      }
      assert(sentinelRefused, 'the sentinel must poison an aggregation rather than pass as a setting');

      // A future stat date is a timezone bug and must not become a snapshot silently.
      assert(attributionRegime('2026-01-11') === ATTRIBUTION_REGIMES.PRE_VIEW_REMOVAL, 'pre-removal regime boundary');
      assert(attributionRegime('2026-01-12') === ATTRIBUTION_REGIMES.VIEW_WINDOWS_REMOVED, 'view-removal boundary is inclusive');
      assert(attributionRegime('2026-03-01') === ATTRIBUTION_REGIMES.ENGAGE_THROUGH, 'engage-through boundary');
      assert(isSettled('2026-08-01', '2026-08-29') && !isSettled('2026-08-02', '2026-08-29'), '28-day settling boundary');
      const w = rollingWindow('2026-09-05');
      assert(w.since === '2026-08-09' && w.until === '2026-09-05', 'rolling window must be 28 days inclusive');
      return 'Unkeyable rows refused by field name; a missing attribution_setting becomes UNKNOWN and poisons aggregation; regime boundaries at 2026-01-12 and 2026-03-01; settling at exactly 28 days.';
    },
  },

  /* ============================================================ completeness ===== */
  {
    name: 'completenessFactor reproduces both documented curves and stays monotone',
    body: () => {
      // The default is the science dossier's §5.3 anchor table, verbatim.
      const anchors: Array<[number, number]> = [
        [0, 0.30], [1, 0.55], [2, 0.72], [3, 0.82], [5, 0.93], [7, 0.97], [14, 0.995], [28, 1.0],
      ];
      for (const [age, f] of anchors) near(completenessFactor(age), f, 1e-12, `default F(${age})`);
      near(completenessFactor(4), 0.875, 1e-12, 'F(4) must interpolate linearly between 0.82 and 0.93');
      near(completenessFactor(1.5), 0.635, 1e-12, 'fractional ages interpolate');
      assert(completenessFactor(29) === 1 && completenessFactor(400) === 1, 'Meta freezes rows at 28 days; F must be exactly 1 beyond');

      // The conservative curve is 00-SYNTHESIS.md §6.2's prose: ~55% at day 2, ~95% at day 7.
      near(completenessFactor(2, CONSERVATIVE_COMPLETENESS_CURVE), 0.55, 1e-12, 'conservative F(2) = the synthesis "~55% at day 2"');
      near(completenessFactor(7, CONSERVATIVE_COMPLETENESS_CURVE), 0.95, 1e-12, 'conservative F(7) = the synthesis "~95% at day 7"');

      // Monotone, bounded, and never more optimistic than the conservative reading.
      let prevD = -1;
      let prevC = -1;
      let maxGap = 0;
      for (let a = 0; a <= 28; a += 0.25) {
        const d = completenessFactor(a);
        const c = completenessFactor(a, CONSERVATIVE_COMPLETENESS_CURVE);
        assert(d >= prevD - 1e-12 && c >= prevC - 1e-12, `F must be non-decreasing; broke at age ${a}`);
        assert(d > 0 && d <= 1 && c > 0 && c <= 1, `F must stay in (0,1]; got ${d}/${c} at age ${a}`);
        assert(d >= c - 1e-12, `the default must never be BELOW the conservative reading; age ${a}`);
        maxGap = Math.max(maxGap, d - c);
        prevD = d;
        prevC = c;
      }

      // A negative age is a timezone bug, not a number to interpolate.
      let neg = false;
      try {
        completenessFactor(-1);
      } catch (e) {
        neg = e instanceof InsightsError && /timezone/.test(e.message);
      }
      assert(neg, 'a negative age must be refused and named as a timezone bug');
      let nan = false;
      try {
        completenessFactor(Number.NaN);
      } catch {
        nan = true;
      }
      assert(nan, 'a NaN age must be refused');
      return (
        `Default curve matches all 8 §5.3 anchors and interpolates (F(4)=0.875, F(1.5)=0.635, F(>28)=1). ` +
        `Conservative curve matches the synthesis prose exactly (F(2)=0.55, F(7)=0.95). Both monotone and in (0,1] ` +
        `over 113 sampled ages. NOTE: the shipped DEFAULT is the optimistic of the two — up to ` +
        `${(maxGap * 100).toFixed(1)} points higher, which under-deflates a young cohort's exposure.`
      );
    },
  },

  {
    name: 'effectiveExposure prevents the age-confounded kill it exists for',
    body: () => {
      // §5.4's worked example: two ads with the SAME true CPA, eight days apart.
      const trueCpa = 25;
      const spendA = 1000;
      const spendB = 1000;
      const ageA = 8;
      const ageB = 2;
      const convA = (spendA / trueCpa) * completenessFactor(ageA);
      const convB = (spendB / trueCpa) * completenessFactor(ageB);
      const naiveA = spendA / convA;
      const naiveB = spendB / convB;
      assert(naiveB > naiveA, 'fixture wrong: the young ad must look worse naively');
      const naiveGap = (naiveB - naiveA) / naiveA;
      assert(naiveGap > 0.3, `the naive comparison must show a large false gap; got ${(naiveGap * 100).toFixed(1)}%`);

      const corrA = effectiveExposure(spendA, ageA) / convA;
      const corrB = effectiveExposure(spendB, ageB) / convB;
      near(corrA, trueCpa, 1e-9, 'corrected CPA of the old ad');
      near(corrB, trueCpa, 1e-9, 'corrected CPA of the young ad');

      // Deflate exposure, never inflate conversions.
      assert(effectiveExposure(500, 1) === 500 * 0.55, '$500 at age 1 is $275 of evidence');
      assert(effectiveExposure(500, 28) === 500, 'a settled cohort carries its full exposure');
      assert(effectiveExposure(500, 90) === 500, 'ages beyond 28 clamp rather than extrapolate');
      assert(effectiveExposure(0, 3) === 0, 'zero spend is zero exposure, not an error');

      let nonFinite = false;
      try {
        effectiveExposure(Number.NaN, 3);
      } catch (e) {
        nonFinite = e instanceof InsightsError && /not a finite number/.test(e.message);
      }
      assert(nonFinite, 'a NaN spend must be refused — a NaN exposure compares false against every guardrail');
      let negative = false;
      try {
        effectiveExposure(-1, 3);
      } catch {
        negative = true;
      }
      assert(negative, 'a negative spend must be refused');
      return (
        `Two ads with identical true CPA $25 read $${naiveA.toFixed(2)} (age 8) vs $${naiveB.toFixed(2)} (age 2) naively — ` +
        `a ${(naiveGap * 100).toFixed(0)}% false penalty on the newest creative. Completeness-corrected exposure returns both to ` +
        `$25.00. NaN and negative spend refused rather than silently passing every guardrail.`
      );
    },
  },

  {
    name: 'fitCompletenessCurve recovers a known curve from synthetic restatement history',
    body: () => {
      // Ground truth the fitter has never seen: a slower, iOS-heavy account.
      const truth = (age: number): number => {
        const pts: CompletenessCurve = [
          { ageDays: 0, factor: 0.18 },
          { ageDays: 1, factor: 0.36 },
          { ageDays: 2, factor: 0.52 },
          { ageDays: 4, factor: 0.71 },
          { ageDays: 7, factor: 0.86 },
          { ageDays: 14, factor: 0.96 },
          { ageDays: 28, factor: 1.0 },
        ];
        return completenessFactor(age, pts);
      };

      const path = join(scratchDir(), 'fit.jsonl');
      const store = new MetricSnapshotStore({ path });
      // 40 ad-days, each observed once a day from age 0 to age 28 — exactly what a
      // rolling-28-day sync writes into an append-only store.
      const finals = [37, 52, 21, 68, 44, 15, 93, 29, 61, 38];
      const snaps: MetricSnapshot[] = [];
      for (let cohort = 0; cohort < 40; cohort++) {
        const statDate = addDays('2026-06-01', cohort);
        const final = finals[cohort % finals.length] ?? 30;
        const adId = `2385100000000${(cohort % 4) + 1}`;
        for (let age = 0; age <= 28; age++) {
          const observed = Math.round(final * truth(age));
          snaps.push(
            ...toSnapshots(
              [
                {
                  date_start: statDate,
                  date_stop: statDate,
                  ad_id: adId,
                  attribution_setting: '7d_click_1d_view',
                  spend: '250.00',
                  actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(observed), '7d_click': String(observed) }],
                },
              ],
              { level: 'ad', adAccountId: ACCOUNT, observedAt: new Date(`${addDays(statDate, age)}T06:00:00.000Z`) },
            ),
          );
        }
      }
      store.append(snaps);
      assert(store.all().length === 40 * 29, `fixture should hold 1160 observations, got ${store.all().length}`);

      const fit = fitCompletenessCurve(store.all(), { actionType: 'offsite_conversion.fb_pixel_purchase' });
      assert(fit.fitted, `the fitter refused a full 40-cohort history: ${fit.fitted === false ? fit.reason : ''}`);
      assert(fit.cohorts === 40, `expected 40 cohorts, got ${fit.cohorts}`);
      assert(fit.finalConversions > 100, `expected >100 final conversions, got ${fit.finalConversions}`);

      let worst = 0;
      let worstAge = -1;
      for (let age = 0; age <= 28; age++) {
        const got = completenessFactor(age, fit.curve);
        const want = truth(age);
        const err = Math.abs(got - want);
        if (err > worst) {
          worst = err;
          worstAge = age;
        }
      }
      assert(worst < 0.02, `fitted curve deviates from ground truth by ${worst.toFixed(4)} at age ${worstAge} (allowed 0.02)`);

      // The fitted curve must be monotone and end at 1.
      let prev = -1;
      for (const p of fit.curve) {
        assert(p.factor >= prev - 1e-12, `fitted curve dips at age ${p.ageDays}`);
        assert(p.factor > 0 && p.factor <= 1, `fitted factor out of range at age ${p.ageDays}`);
        prev = p.factor;
      }
      const last = fit.curve[fit.curve.length - 1];
      assert(last !== undefined && last.ageDays >= SETTLED_AFTER_DAYS && last.factor === 1, 'the fitted curve must terminate at F(28)=1');

      // Restated windows also fit: the same window key read explicitly.
      const windowFit = fitCompletenessCurve(store.all(), {
        actionType: 'offsite_conversion.fb_pixel_purchase',
        window: '7d_click',
      });
      assert(windowFit.fitted, 'fitting on an explicit window key must work too');

      // Thin history is refused rather than invented.
      const thin = fitCompletenessCurve(store.all().slice(0, 29), { actionType: 'offsite_conversion.fb_pixel_purchase' });
      assert(!thin.fitted && /not enough settled history/.test(thin.reason), 'one cohort must not produce a curve');
      // A different KPI with no data at all is refused, not fitted to zeros.
      const absent = fitCompletenessCurve(store.all(), { actionType: 'lead' });
      assert(!absent.fitted, 'an action type nobody reported must not yield a curve');
      return (
        `1160 append-only observations across 40 cohorts -> fitted curve within ${worst.toFixed(4)} of the ground truth ` +
        `(worst at age ${worstAge}), monotone, terminating at F(28)=1. Fitting on the 7d_click key works; ` +
        `1 cohort and an unreported action type are both refused rather than invented.`
      );
    },
  },

  {
    name: 'the fitter is not fooled by out-of-order input or never-converting cohorts',
    body: () => {
      // The final count must come from the NEWEST settled observation by timestamp, not
      // from whatever happens to be last in the array. Anchoring on an earlier, lower
      // count biases every F(a) upward — which re-introduces the young-creative kill.
      const build = (cohort: number): MetricSnapshot[] => {
        const statDate = addDays('2026-06-01', cohort);
        const final = 40;
        const out: MetricSnapshot[] = [];
        for (const [age, obs] of [[0, 20], [14, 34], [28, 40], [30, 40]] as Array<[number, number]>) {
          out.push(
            ...toSnapshots(
              [
                {
                  date_start: statDate,
                  date_stop: statDate,
                  ad_id: `238510000000${cohort}`,
                  attribution_setting: '7d_click',
                  actions: [{ action_type: 'purchase_x', value: String(obs === 40 && age === 28 ? final : obs) }],
                },
              ],
              { level: 'ad', adAccountId: ACCOUNT, observedAt: new Date(`${addDays(statDate, age)}T06:00:00.000Z`) },
            ),
          );
        }
        return out;
      };
      const ordered: MetricSnapshot[] = [];
      for (let c = 0; c < 40; c++) ordered.push(...build(c));
      const shuffled = [...ordered].reverse();

      const a = fitCompletenessCurve(ordered, { actionType: 'purchase_x' });
      const b = fitCompletenessCurve(shuffled, { actionType: 'purchase_x' });
      assert(a.fitted && b.fitted, 'both orderings must fit');
      assert(
        JSON.stringify(a.curve) === JSON.stringify(b.curve),
        `the fit must not depend on input order:\n  ordered  ${JSON.stringify(a.curve)}\n  reversed ${JSON.stringify(b.curve)}`,
      );
      near(completenessFactor(0, a.curve), 0.5, 1e-9, 'F(0) should be 20/40');
      near(completenessFactor(14, a.curve), 0.85, 1e-9, 'F(14) should be 34/40');

      // A cohort that never converted carries no shape information and must not be
      // treated as F=1 (which would drag the whole curve toward 1 and kill new creative).
      const zeroCohorts: MetricSnapshot[] = [];
      for (let c = 0; c < 40; c++) {
        const statDate = addDays('2026-07-01', c);
        for (const age of [0, 28]) {
          zeroCohorts.push(
            ...toSnapshots(
              [
                {
                  date_start: statDate,
                  date_stop: statDate,
                  ad_id: `2385199999${c}`,
                  attribution_setting: '7d_click',
                  actions: [{ action_type: 'purchase_x', value: '0' }],
                },
              ],
              { level: 'ad', adAccountId: ACCOUNT, observedAt: new Date(`${addDays(statDate, age)}T06:00:00.000Z`) },
            ),
          );
        }
      }
      const withZeros = fitCompletenessCurve([...ordered, ...zeroCohorts], { actionType: 'purchase_x' });
      assert(withZeros.fitted, 'adding zero cohorts must not break the fit');
      assert(withZeros.cohorts === 40, `zero cohorts must be excluded, not counted; got ${withZeros.cohorts}`);
      assert(
        JSON.stringify(withZeros.curve) === JSON.stringify(a.curve),
        'zero-conversion cohorts must not move the curve at all',
      );
      const onlyZeros = fitCompletenessCurve(zeroCohorts, { actionType: 'purchase_x' });
      assert(!onlyZeros.fitted, 'a history of nothing but zeros must refuse, not return F=1 everywhere');
      return (
        'The fit is identical for chronological and reversed input (F(0)=0.50, F(14)=0.85), so it anchors on the ' +
        'newest settled observation rather than array position. 40 never-converting cohorts are excluded entirely ' +
        '(cohorts still 40, curve unchanged); a history of only zeros refuses to fit.'
      );
    },
  },

  /* ================================================================= builder ===== */
  {
    name: 'the query builder refuses what Meta accepts and silently empties',
    body: () => {
      const cases: Array<[string, () => unknown, RegExp]> = [
        ['bare numeric account id', () => buildInsightsRequest({ ...BASE_QUERY, adAccountId: '1234567890' }, NOW), /act_/],
        ['date_preset=lifetime', () => buildInsightsRequest({ adAccountId: ACCOUNT, level: 'ad', datePreset: 'lifetime' as never }, NOW), /maximum/],
        ['time_range AND date_preset', () => buildInsightsRequest({ ...BASE_QUERY, datePreset: 'last_7d' }, NOW), /mutually exclusive/],
        ['neither time_range nor date_preset', () => buildInsightsRequest({ adAccountId: ACCOUNT, level: 'ad' }, NOW), /required/],
        ['since after until', () => buildInsightsRequest({ ...BASE_QUERY, timeRange: { since: '2026-08-26', until: '2026-08-25' } }, NOW), /inclusive/],
        ['since past the 37-month floor', () => buildInsightsRequest({ ...BASE_QUERY, timeRange: { since: '2022-01-01', until: '2026-08-25' } }, NOW), /3018/],
        ['a dead attribution window', () => buildInsightsRequest({ ...BASE_QUERY, actionAttributionWindows: ['7d_view' as never] }, NOW), /2026-01-12/],
        ['an unmodelled attribution window', () => buildInsightsRequest({ ...BASE_QUERY, actionAttributionWindows: ['dda' as never] }, NOW), /extraParams/],
        ['breakdowns=dma', () => buildInsightsRequest({ ...BASE_QUERY, breakdowns: ['dma'] }, NOW), /comscore_market/],
        ['use_unified_attribution_setting', () => buildInsightsRequest({ ...BASE_QUERY, extraParams: { use_unified_attribution_setting: 'true' } }, NOW), /2025-06-10/],
        ['async=true', () => buildInsightsRequest({ ...BASE_QUERY, extraParams: { async: 'true' } }, NOW), /HTTP verb/i],
        ['time_increment out of range', () => buildInsightsRequest({ ...BASE_QUERY, timeIncrement: 120 }, NOW), /1–90|1-90/],
        ['a fake calendar date', () => buildInsightsRequest({ ...BASE_QUERY, timeRange: { since: '2026-02-30', until: '2026-03-01' } }, NOW), /real calendar date/],
      ];
      const missed: string[] = [];
      for (const [label, fn, re] of cases) {
        let msg = '';
        try {
          fn();
          missed.push(`${label} (accepted)`);
          continue;
        } catch (e) {
          msg = e instanceof Error ? e.message : String(e);
        }
        if (!re.test(msg)) missed.push(`${label} (message did not explain: ${msg.slice(0, 90)})`);
      }
      assert(missed.length === 0, `builder failed to refuse or explain: ${missed.join('; ')}`);

      // Warnings, not refusals, where the request is still legal.
      const gated = buildInsightsRequest({ ...BASE_QUERY, breakdowns: ['impression_device'] }, NOW);
      assert(gated.warnings.some((w) => /opt-in/.test(w)), 'opt-in-gated breakdowns must warn about NO RESULTS');
      const hourly = buildInsightsRequest(
        { ...BASE_QUERY, breakdowns: ['hourly_stats_aggregated_by_advertiser_time_zone'] },
        NOW,
      );
      assert(hourly.warnings.some((w) => /unique/.test(w)) && hourly.warnings.some((w) => /video_/.test(w)), 'hourly breakdowns must warn about unique and video fields');
      const deep = buildInsightsRequest({ ...BASE_QUERY, timeRange: { since: '2024-01-01', until: '2026-08-25' } }, NOW);
      assert(deep.warnings.some((w) => /13-month/.test(w)), 'the 13-month unique-field cap must warn');

      // The identity fields are re-added even if a caller strips them.
      const stripped = buildInsightsRequest({ ...BASE_QUERY, fields: ['spend'] }, NOW);
      const f = (stripped.params['fields'] ?? '').split(',');
      for (const required of ['spend', 'attribution_setting', 'date_start', 'date_stop', 'ad_id']) {
        assert(f.includes(required), `${required} must be re-added to fields; got ${f.join(',')}`);
      }
      assert(CREATIVE_DECISION_FIELDS.includes('attribution_setting'), 'the shipped field set must carry the identity field');
      return `13 silent-failure queries all refused with the cause named; opt-in / hourly / 13-month cases warn instead; ${f.length} fields after the builder re-added the identity columns.`;
    },
  },

  /* ==================================================================== live ===== */
  {
    name: 'live Graph API: the credentials the read path would use actually work',
    body: async () => {
      let cfg;
      try {
        cfg = loadConfig();
      } catch (e) {
        throw new Blocked('no META credentials in .env', e instanceof ConfigError ? e.message : String(e));
      }
      const meta = new MetaClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        accessToken: cfg.systemUserToken,
        mode: cfg.mode,
      });
      // READ-ONLY. GET only; nothing here creates or modifies a Meta object.
      const me = await meta.get<{ id?: string; name?: string }>('me', { fields: 'id,name' });
      assert(typeof me.id === 'string' && me.id.length > 0, `GET /me returned no id: ${JSON.stringify(me)}`);
      return `GET /me -> id ${me.id} (${me.name ?? 'unnamed'}) with appsecret_proof accepted, RUNTIME_MODE=${cfg.mode}. The transport InsightsClient would use is live and read-only.`;
    },
  },

  {
    name: 'live insights read against a real ad account',
    body: async () => {
      let cfg;
      try {
        cfg = loadConfig();
      } catch (e) {
        throw new Blocked('no META credentials in .env', e instanceof ConfigError ? e.message : String(e));
      }
      const meta = new MetaClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        accessToken: cfg.systemUserToken,
        mode: cfg.mode,
      });
      const accounts = await meta.get<{ data?: Array<{ id?: string; timezone_name?: string }> }>('me/adaccounts', {
        fields: 'id,account_id,name,timezone_name,currency',
        limit: '10',
      });
      const list = accounts.data ?? [];
      if (list.length === 0) {
        throw new Blocked(
          'no ad accounts assigned to the system user',
          'GET /me/adaccounts returned {"data":[]}. The insights edge only exists on an ad account, ' +
            'so the sync path cannot be exercised against live data until an ad account is assigned to ' +
            'this system user in Business Settings. Everything upstream of the network (query building, ' +
            'paging, parsing, snapshotting) is proved above against faithful fakes.',
        );
      }
      const first = list[0];
      assert(first?.id !== undefined, 'an ad account with no id');
      // Read-only insights pull through the real module against the real API.
      const c = new InsightsClient({ transport: meta, now: () => new Date(), onWarning: () => {} });
      const rows = await c.fetch({
        adAccountId: first.id,
        level: 'ad',
        datePreset: 'last_7d',
        timeIncrement: 1,
        limit: 100,
      });
      const withSetting = rows.filter((r) => typeof r['attribution_setting'] === 'string').length;
      return `GET ${first.id}/insights (level=ad, last_7d, time_increment=1) -> ${rows.length} rows, ${withSetting} carrying attribution_setting; account timezone ${first.timezone_name ?? 'unknown'}.`;
    },
  },

  /* ============================================================== robustness ===== */
  {
    name: 'the paging guard stops a runaway, but discards every row it already read',
    body: async () => {
      // Meta encodes internal state in paging.next and has been observed to keep emitting
      // one past the last page. The guard correctly refuses to spin — but the throw takes
      // the rows already collected with it, so a wide backfill loses everything rather
      // than returning a short read the caller could resume.
      let served = 0;
      const transport = new RecordingTransport(() => {
        served += 1;
        return { data: [realRow({ ad_id: `2385100000${served}` })], paging: pagingNext(`cursor_${served}`) };
      });
      const c = new InsightsClient({
        transport,
        now: () => NOW,
        sleep: async () => {},
        onWarning: () => {},
        maxPages: 6,
      });
      let msg = '';
      try {
        await c.fetch(BASE_QUERY);
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(/exceeded 6 pages/.test(msg), `the guard must name the ceiling it hit: ${msg}`);
      assert(served === 6, `expected exactly maxPages requests, got ${served}`);
      assert(/looping|too wide/.test(msg), 'the error must name both plausible causes');

      // A page that returns no rows but still carries a cursor keeps paging — the loop
      // only ends on an absent `next`.
      let emptyServed = 0;
      const empties = new RecordingTransport(() => {
        emptyServed += 1;
        return emptyServed < 4 ? { data: [], paging: pagingNext(`c${emptyServed}`) } : { data: [], paging: { cursors: {} } };
      });
      const rows = await client(empties).fetch(BASE_QUERY);
      assert(rows.length === 0 && emptyServed === 4, `empty pages must still be followed to the end of the cursor chain; served ${emptyServed}`);
      return (
        `maxPages=6 -> exactly 6 GETs then a refusal naming the ceiling and both causes. LIMITATION: the 6 rows ` +
        `already fetched are discarded with the throw, so a backfill that overruns loses the whole read rather than ` +
        `returning a resumable short read. Empty pages are followed until paging.next is absent (4 GETs, 0 rows).`
      );
    },
  },

  {
    name: 'a second store instance on the same file does not see the first one\'s appends',
    body: () => {
      // Both instances are legal to construct and both fsync their own writes, but neither
      // re-reads the file, so two concurrent syncs each hold a partial view of history.
      const path = join(scratchDir(), 'shared.jsonl');
      const a = new MetricSnapshotStore({ path });
      const b = new MetricSnapshotStore({ path });
      a.append(toSnapshots([realRow()], { level: 'ad', adAccountId: ACCOUNT, observedAt: NOW }));
      b.append(
        toSnapshots([realRow({ ad_id: '23851111111110004' })], {
          level: 'ad',
          adAccountId: ACCOUNT,
          observedAt: new Date(NOW.getTime() + 1000),
        }),
      );
      assert(a.all().length === 1 && b.all().length === 1, 'each instance sees only its own append');
      const onDisk = readFileSync(path, 'utf8').trim().split('\n');
      assert(onDisk.length === 2, `the DURABLE record must hold both appends, got ${onDisk.length}`);
      const reloaded = new MetricSnapshotStore({ path });
      assert(reloaded.all().length === 2, `a fresh instance must see both, got ${reloaded.all().length}`);
      assert(new Set(reloaded.all().map((s) => identityKey(s))).size === 2, 'both cells must survive interleaved appends');
      return (
        'Two live instances on one file each report 1 row while the file correctly holds 2, and a fresh instance ' +
        'reads both. Durability is intact (O_APPEND + fsync); the in-memory view is per-instance, so asOf()/fit() ' +
        'must be run on a freshly constructed store, never on one held open across another writer.'
      );
    },
  },
];

/* --------------------------------------------------------------------- runner ----- */

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];
  for (const probe of PROBES) {
    try {
      const detail = await probe.body();
      checks.push({ name: probe.name, status: 'PASS', detail });
    } catch (e) {
      if (e instanceof Blocked) {
        checks.push({ name: probe.name, status: 'SKIP', detail: e.message, blockedBy: e.blockedBy });
      } else {
        checks.push({
          name: probe.name,
          status: 'FAIL',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return { module: 'src/meta/insights.ts', checks };
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
