import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetaClient } from '../src/meta/client.ts';
import {
  ATTRIBUTION_REGIMES,
  CONSERVATIVE_COMPLETENESS_CURVE,
  CREATIVE_DECISION_FIELDS,
  DEFAULT_COMPLETENESS_CURVE,
  DELIVERING_STATUS_FILTER,
  InsightsClient,
  InsightsError,
  MISSING_ATTRIBUTION_SETTING,
  MetricSnapshotStore,
  REPORT_RUN_ID_TTL_MS,
  SETTLED_AFTER_DAYS,
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
  type InsightsQuery,
  type InsightsRow,
  type InsightsTransport,
  type MetricSnapshot,
} from '../src/meta/insights.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'insights-store-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const ACCOUNT = 'act_1234567890';
const NOW = new Date('2026-09-05T09:00:00.000Z');
const clock = (): Date => NOW;

function baseQuery(overrides: Partial<InsightsQuery> = {}): InsightsQuery {
  return {
    adAccountId: ACCOUNT,
    level: 'ad',
    timeRange: { since: '2026-08-09', until: '2026-09-05' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

test('the reward-signal query is one account-level level=ad daily call over 28 days', () => {
  const q = creativeRewardQuery(ACCOUNT, '2026-09-05');
  assert.deepEqual(q.timeRange, { since: '2026-08-09', until: '2026-09-05' });
  assert.equal(q.timeIncrement, 1);
  assert.deepEqual(q.filtering, [DELIVERING_STATUS_FILTER]);

  const built = buildInsightsRequest(q, NOW);
  assert.equal(built.path, `${ACCOUNT}/insights`);
  assert.equal(built.params['level'], 'ad');
  assert.equal(built.params['time_increment'], '1');
  assert.equal(built.params['time_range'], '{"since":"2026-08-09","until":"2026-09-05"}');
  assert.match(built.params['filtering'] ?? '', /ad\.effective_status/);
  assert.deepEqual(built.warnings, []);
});

test('attribution_setting and the level id field are re-added even if a caller strips them', () => {
  const built = buildInsightsRequest(baseQuery({ fields: ['spend'] }), NOW);
  const fields = (built.params['fields'] ?? '').split(',');
  assert.ok(fields.includes('attribution_setting'), 'attribution_setting is part of metric identity');
  assert.ok(fields.includes('ad_id'), 'level=ad rows must carry ad_id or they cannot be keyed');
  assert.ok(fields.includes('date_start'));
});

test('the shipped field set covers the metrics a creative decision keys off', () => {
  for (const f of [
    'impressions', 'reach', 'frequency', 'spend', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm',
    'actions', 'action_values', 'purchase_roas', 'cost_per_action_type',
    'video_play_actions', 'video_thruplay_watched_actions',
    'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
    'video_p100_watched_actions',
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
  ]) {
    assert.ok(CREATIVE_DECISION_FIELDS.includes(f), `${f} missing from CREATIVE_DECISION_FIELDS`);
  }
});

test('date_preset=lifetime is refused with the replacement named', () => {
  assert.throws(
    () => buildInsightsRequest({ adAccountId: ACCOUNT, level: 'ad', datePreset: 'lifetime' as never }, NOW),
    (err: unknown) => err instanceof InsightsError && /lifetime` was removed/.test(err.message) && /data_maximum/.test(err.message),
  );
});

test('time_range and date_preset are mutually exclusive, and until is inclusive', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ datePreset: 'last_7d' }), NOW),
    /mutually exclusive/,
  );
  assert.throws(
    () => buildInsightsRequest(baseQuery({ timeRange: { since: '2026-09-05', until: '2026-08-09' } }), NOW),
    /is after until.*inclusive/s,
  );
});

test('a since beyond the 37-month lookback is refused by name (error 3018)', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ timeRange: { since: '2023-01-01', until: '2023-01-31' } }), NOW),
    (err: unknown) => err instanceof InsightsError && /37-month/.test(err.message) && /3018/.test(err.message),
  );
  // Just inside the window is fine.
  assert.doesNotThrow(() =>
    buildInsightsRequest(baseQuery({ timeRange: { since: '2023-09-01', until: '2023-09-30' } }), NOW),
  );
});

test('7d_view / 28d_view are refused rather than silently returning zeros', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ actionAttributionWindows: ['7d_view' as never] }), NOW),
    (err: unknown) => err instanceof InsightsError && /2026-01-12/.test(err.message),
  );
  const ok = buildInsightsRequest(baseQuery({ actionAttributionWindows: ['7d_click', '1d_ev'] }), NOW);
  assert.equal(ok.params['action_attribution_windows'], '7d_click,1d_ev');
});

test('breakdowns=dma is refused and points at comscore_market', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ breakdowns: ['dma'] }), NOW),
    /comscore_market/,
  );
});

test('opt-in-gated breakdowns warn, because a non-opted-in account returns no rows rather than an error', () => {
  const built = buildInsightsRequest(baseQuery({ breakdowns: ['impression_device'] }), NOW);
  assert.equal(built.params['breakdowns'], 'impression_device');
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0] ?? '', /opt-in/);
  assert.match(built.warnings[0] ?? '', /NO RESULTS/);
});

test('hourly breakdowns warn about unique and video fields returning 0', () => {
  const built = buildInsightsRequest(
    baseQuery({
      breakdowns: ['hourly_stats_aggregated_by_advertiser_time_zone'],
      fields: ['spend', 'reach', 'video_play_actions'],
    }),
    NOW,
  );
  assert.equal(built.warnings.length, 2);
  assert.ok(built.warnings.some((w) => /reach/.test(w) && /return 0/.test(w)));
  assert.ok(built.warnings.some((w) => /video_play_actions/.test(w)));
});

test('parameters Meta disregards since 2025-06-10 are refused, not passed through', () => {
  for (const dead of ['use_unified_attribution_setting', 'action_report_time']) {
    assert.throws(
      () => buildInsightsRequest(baseQuery({ extraParams: { [dead]: 'true' } }), NOW),
      (err: unknown) => err instanceof InsightsError && /disregarded by Meta since 2025-06-10/.test(err.message),
    );
  }
});

test('async=true is refused with the actual mechanism named (the verb is the switch)', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ extraParams: { async: 'true' } }), NOW),
    /POST \/insights is the async job/,
  );
});

test('a bare numeric ad account id is refused', () => {
  assert.throws(
    () => buildInsightsRequest(baseQuery({ adAccountId: '1234567890' }), NOW),
    /act_<numeric id>/,
  );
});

test('time_increment is range-checked and 90 is flagged as practically rejected', () => {
  assert.throws(() => buildInsightsRequest(baseQuery({ timeIncrement: 0 }), NOW), /out of range/);
  assert.throws(() => buildInsightsRequest(baseQuery({ timeIncrement: 91 }), NOW), /out of range/);
  const built = buildInsightsRequest(baseQuery({ timeIncrement: 90 }), NOW);
  assert.match(built.warnings.join(' '), /practical ceiling 89/);
});

test('use_account_attribution_setting is passed through but flagged UNVERIFIED', () => {
  const built = buildInsightsRequest(baseQuery({ useAccountAttributionSetting: true }), NOW);
  assert.equal(built.params['use_account_attribution_setting'], 'true');
  assert.match(built.warnings.join(' '), /UNVERIFIED/);
});

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

const ROW: InsightsRow = {
  date_start: '2026-09-01',
  date_stop: '2026-09-01',
  ad_id: '23851234567890123',
  attribution_setting: '7d_click_1d_view',
  spend: '5339.5',
  impressions: '361324',
  actions: [
    { action_type: 'link_click', value: '412' },
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '37', '1d_click': '31', '7d_click': '37', '1d_view': '4' },
    { action_type: 'omni_purchase', value: '39' },
    { action_type: 'video_view', value: '9000' },
  ],
  action_values: [{ action_type: 'omni_purchase', value: '18269.4' }],
  cost_per_action_type: [{ action_type: 'omni_purchase', value: '136.91' }],
  purchase_roas: [{ action_type: 'omni_purchase', value: '3.42' }],
  video_play_actions: [{ action_type: 'video_view', value: '9000' }],
  video_p25_watched_actions: [{ action_type: 'video_view', value: '4500' }],
  video_p100_watched_actions: [{ action_type: 'video_view', value: '900' }],
  video_thruplay_watched_actions: [{ action_type: 'video_view', value: '2700' }],
};

test('parseNumeric never returns NaN and distinguishes absent from zero', () => {
  assert.equal(parseNumeric('5339.5'), 5339.5);
  assert.equal(parseNumeric('0'), 0);
  assert.equal(parseNumeric(12), 12);
  assert.equal(parseNumeric(''), undefined);
  assert.equal(parseNumeric('   '), undefined);
  assert.equal(parseNumeric('abc'), undefined);
  assert.equal(parseNumeric(undefined), undefined);
  assert.equal(parseNumeric(null), undefined);
  assert.equal(parseNumeric(Number.NaN), undefined);
  assert.equal(parseNumeric(Number.POSITIVE_INFINITY), undefined);
});

test('spend is read as MAJOR units, the opposite of how budgets are written', () => {
  // $5,339.50 against 361,324 impressions is a ~$14.78 CPM. Minor units would make it $0.15.
  assert.equal(spendMajor(ROW), 5339.5);
});

test('actionValue pulls one named action type and never sums overlapping roll-ups', () => {
  assert.equal(actionValue(ROW, 'offsite_conversion.fb_pixel_purchase'), 37);
  assert.equal(actionValue(ROW, 'omni_purchase'), 39);
  assert.equal(actionValue(ROW, 'link_click'), 412);
  // The overlap is real: summing these three would report 488 purchases from 37.
  assert.notEqual(
    (actionValue(ROW, 'offsite_conversion.fb_pixel_purchase') ?? 0) + (actionValue(ROW, 'omni_purchase') ?? 0),
    37,
  );
});

test('a missing action type or window key is undefined, not zero', () => {
  assert.equal(actionValue(ROW, 'lead'), undefined);
  assert.equal(actionValue(ROW, 'omni_purchase', { window: '7d_click' }), undefined);
  assert.equal(actionValue({}, 'omni_purchase'), undefined);
  assert.equal(actionValue({ actions: 'not-an-array' } as unknown as InsightsRow, 'omni_purchase'), undefined);
});

test('an explicit attribution window key is read when present', () => {
  assert.equal(actionValue(ROW, 'offsite_conversion.fb_pixel_purchase', { window: '1d_click' }), 31);
  assert.equal(actionValue(ROW, 'offsite_conversion.fb_pixel_purchase', { window: '1d_view' }), 4);
});

test('reading a dead attribution window throws instead of reporting a fraction of the truth', () => {
  assert.throws(
    () => actionValue(ROW, 'omni_purchase', { window: '7d_view' as never }),
    /2026-01-12/,
  );
});

test('actionValueAmount reads revenue out of action_values', () => {
  assert.equal(actionValueAmount(ROW, 'omni_purchase'), 18269.4);
  assert.equal(actionValueAmount(ROW, 'lead'), undefined);
});

test('costPerAction: reported by default, derived only on explicit request', () => {
  assert.equal(costPerAction(ROW, 'omni_purchase'), 136.91);
  const derived = costPerAction(ROW, 'omni_purchase', { source: 'derived' });
  assert.ok(derived !== undefined && Math.abs(derived - 5339.5 / 39) < 1e-9);
  // They legitimately disagree; the caller chooses, there is no silent fallback.
  assert.notEqual(derived, 136.91);
});

test('costPerAction returns undefined rather than Infinity when the action count is zero', () => {
  const zeroRow: InsightsRow = { spend: '100', actions: [{ action_type: 'omni_purchase', value: '0' }] };
  assert.equal(costPerAction(zeroRow, 'omni_purchase', { source: 'derived' }), undefined);
  assert.equal(costPerAction({ spend: '100' }, 'omni_purchase', { source: 'derived' }), undefined);
  assert.equal(costPerAction({ actions: [{ action_type: 'omni_purchase', value: '3' }] }, 'omni_purchase', { source: 'derived' }), undefined);
});

test('purchase_roas is a ratio pulled by action type', () => {
  assert.equal(purchaseRoas(ROW), 3.42);
  assert.equal(purchaseRoas(ROW, 'offsite_conversion.fb_pixel_purchase'), undefined);
});

test('actionTypes enumerates what an account actually reports', () => {
  assert.deepEqual(actionTypes(ROW), [
    'link_click',
    'offsite_conversion.fb_pixel_purchase',
    'omni_purchase',
    'video_view',
  ]);
});

test('video retention ratios are over plays, and undefined when the denominator is missing', () => {
  const v = videoRetention(ROW);
  assert.equal(v.plays, 9000);
  assert.equal(v.hookRetention, 0.5);
  assert.equal(v.completionRate, 0.1);
  assert.equal(v.thruplays, 2700);
  assert.equal(v.p50Rate, undefined);

  const noPlays = videoRetention({ video_p25_watched_actions: [{ action_type: 'video_view', value: '5' }] });
  assert.equal(noPlays.hookRetention, undefined);

  const zeroPlays = videoRetention({
    video_play_actions: [{ action_type: 'video_view', value: '0' }],
    video_p25_watched_actions: [{ action_type: 'video_view', value: '0' }],
  });
  assert.equal(zeroPlays.hookRetention, undefined);
});

// ---------------------------------------------------------------------------
// Dates and settling
// ---------------------------------------------------------------------------

test('date helpers work on naive account-timezone dates', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-05'), 4);
  assert.equal(daysBetween('2026-09-05', '2026-09-01'), -4);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.deepEqual(rollingWindow('2026-09-05'), { since: '2026-08-09', until: '2026-09-05' });
  assert.equal(isSettled('2026-08-08', '2026-09-05'), true);
  assert.equal(isSettled('2026-08-09', '2026-09-05'), false);
  assert.equal(SETTLED_AFTER_DAYS, 28);
  assert.throws(() => daysBetween('2026-13-01', '2026-09-05'), /not a real calendar date/);
  assert.throws(() => daysBetween('05/09/2026', '2026-09-05'), /naive YYYY-MM-DD/);
});

test('attribution regimes are stamped from the stat date', () => {
  assert.equal(attributionRegime('2025-12-31'), ATTRIBUTION_REGIMES.PRE_VIEW_REMOVAL);
  assert.equal(attributionRegime('2026-01-12'), ATTRIBUTION_REGIMES.VIEW_WINDOWS_REMOVED);
  assert.equal(attributionRegime('2026-02-28'), ATTRIBUTION_REGIMES.VIEW_WINDOWS_REMOVED);
  assert.equal(attributionRegime('2026-09-01'), ATTRIBUTION_REGIMES.ENGAGE_THROUGH);
});

// ---------------------------------------------------------------------------
// Transport plumbing
// ---------------------------------------------------------------------------

interface Call {
  verb: 'GET' | 'POST';
  path: string;
  params: Record<string, string>;
}

type Handler = (path: string, params: Record<string, string>, n: number) => unknown;

class FakeTransport implements InsightsTransport {
  readonly calls: Call[] = [];
  private readonly onGet: Handler;
  private readonly onPost: Handler;

  constructor(onGet: Handler, onPost: Handler = () => ({ report_run_id: '6023920149050' })) {
    this.onGet = onGet;
    this.onPost = onPost;
  }

  get<T>(path: string, params: Record<string, string>): Promise<T> {
    const n = this.calls.filter((c) => c.verb === 'GET').length;
    this.calls.push({ verb: 'GET', path, params });
    return Promise.resolve(this.onGet(path, params, n) as T);
  }

  post<T>(path: string, params: Record<string, string>): Promise<T> {
    const n = this.calls.filter((c) => c.verb === 'POST').length;
    this.calls.push({ verb: 'POST', path, params });
    return Promise.resolve(this.onPost(path, params, n) as T);
  }
}

const noSleep = (): Promise<void> => Promise.resolve();

function makeClient(transport: InsightsTransport, now: () => Date = clock): InsightsClient {
  return new InsightsClient({ transport, now, sleep: noSleep, onWarning: () => {} });
}

test('MetaClient structurally satisfies InsightsTransport, and fetch is injectable end to end', async () => {
  const requested: string[] = [];
  const fakeFetch: typeof fetch = (input) => {
    requested.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ data: [ROW] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  const meta = new MetaClient({
    appId: 'app',
    appSecret: 'secret',
    accessToken: 'token',
    mode: 'LIVE',
    fetchImpl: fakeFetch,
  });
  const transport: InsightsTransport = meta; // compile-time proof of compatibility
  const rows = await makeClient(transport).fetch(creativeRewardQuery(ACCOUNT, '2026-09-05'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ad_id, '23851234567890123');
  assert.equal(requested.length, 1);
  assert.match(requested[0] ?? '', /act_1234567890\/insights/);
  assert.match(requested[0] ?? '', /level=ad/);
});

test('sync fetch follows paging.next and drops only the credentials from it', async () => {
  const transport = new FakeTransport((path, _params, n) => {
    if (n === 0) {
      return {
        data: [{ ...ROW, ad_id: 'a1' }],
        paging: {
          next: 'https://graph.facebook.com/v26.0/act_1234567890/insights?level=ad&after=CURSOR_2&access_token=SECRET&appsecret_proof=PROOF',
        },
      };
    }
    assert.equal(path, 'act_1234567890/insights');
    return { data: [{ ...ROW, ad_id: 'a2' }] };
  });
  const rows = await makeClient(transport).fetch(creativeRewardQuery(ACCOUNT, '2026-09-05'));
  assert.deepEqual(rows.map((r) => r.ad_id), ['a1', 'a2']);

  const second = transport.calls[1];
  assert.equal(second?.params['after'], 'CURSOR_2');
  assert.equal(second?.params['access_token'], undefined);
  assert.equal(second?.params['appsecret_proof'], undefined);
});

test('parseNextPage strips the version prefix so the version stays pinned in one place', () => {
  const parsed = parseNextPage('https://graph.facebook.com/v26.0/6023920149050/insights?after=X&limit=25');
  assert.equal(parsed.path, '6023920149050/insights');
  assert.deepEqual(parsed.params, { after: 'X', limit: '25' });
  assert.throws(() => parseNextPage('not a url'), /paging\.next is not a URL/);
});

test('paging refuses to spin forever', async () => {
  const transport = new FakeTransport(() => ({
    data: [ROW],
    paging: { next: 'https://graph.facebook.com/v26.0/act_1234567890/insights?after=SAME' },
  }));
  const client = new InsightsClient({ transport, now: clock, sleep: noSleep, onWarning: () => {}, maxPages: 3 });
  await assert.rejects(client.fetch(creativeRewardQuery(ACCOUNT, '2026-09-05')), /exceeded 3 pages/);
});

// ---------------------------------------------------------------------------
// Async report jobs
// ---------------------------------------------------------------------------

test('100 percent complete does not mean done — polling waits for Job Completed too', async () => {
  const statuses = [
    { async_status: 'Job Running', async_percent_completion: 100 },
    { async_status: 'Job Running', async_percent_completion: 100 },
    { async_status: 'Job Completed', async_percent_completion: 100 },
  ];
  const transport = new FakeTransport((path, _p, n) => {
    if (path.endsWith('/insights')) return { data: [ROW] };
    return statuses[Math.min(n, statuses.length - 1)];
  });
  const result = await makeClient(transport).runAsyncReport(baseQuery());
  assert.equal(result.polls, 3);
  assert.equal(result.resubmits, 0);
  assert.equal(result.rows.length, 1);
});

test('Job Skipped is resubmitted, not treated as a failure', async () => {
  let submits = 0;
  const transport = new FakeTransport(
    (path, _p, n) => {
      if (path.endsWith('/insights')) return { data: [ROW, ROW] };
      // First job expires; the second completes.
      if (n === 0) return { async_status: 'Job Skipped', async_percent_completion: 0 };
      return { async_status: 'Job Completed', async_percent_completion: 100 };
    },
    () => {
      submits++;
      return { report_run_id: `run_${submits}` };
    },
  );
  const result = await makeClient(transport).runAsyncReport(baseQuery());
  assert.equal(submits, 2, 'a skipped job must be resubmitted');
  assert.equal(result.resubmits, 1);
  assert.equal(result.reportRunId, 'run_2');
  assert.equal(result.rows.length, 2);
  assert.match(result.warnings.join(' '), /Job Skipped/);
});

test('Job Failed is thrown with the query described, and never auto-resubmitted', async () => {
  let submits = 0;
  const transport = new FakeTransport(
    () => ({ async_status: 'Job Failed', async_percent_completion: 100 }),
    () => {
      submits++;
      return { report_run_id: 'run_1' };
    },
  );
  await assert.rejects(
    makeClient(transport).runAsyncReport(baseQuery({ breakdowns: ['country'] })),
    (err: unknown) =>
      err instanceof Error &&
      /Job Failed/.test(err.message) &&
      /requires query review/.test(err.message) &&
      /breakdowns=\[country\]/.test(err.message),
  );
  assert.equal(submits, 1, 'a failed query must not be blind-retried — 4xx errors reduce the insights quota');
});

test('endless Job Skipped eventually gives up and names the async job allowance', async () => {
  const transport = new FakeTransport(() => ({ async_status: 'Job Skipped', async_percent_completion: 0 }));
  await assert.rejects(
    makeClient(transport).runAsyncReport(baseQuery(), { maxResubmits: 1 }),
    /async job allowance/,
  );
});

test('an unknown async_status is warned about and polled through', async () => {
  const transport = new FakeTransport((_path, _p, n) => {
    if (_path.endsWith('/insights')) return { data: [] };
    return n === 0
      ? { async_status: 'Job Percolating', async_percent_completion: 10 }
      : { async_status: 'Job Completed', async_percent_completion: 100 };
  });
  const result = await makeClient(transport).runAsyncReport(baseQuery());
  assert.match(result.warnings.join(' '), /unknown async_status "Job Percolating"/);
});

test('a spend-guarded transport short-circuiting the POST is named, not polled', async () => {
  const transport = new FakeTransport(
    () => ({ async_status: 'Job Completed', async_percent_completion: 100 }),
    () => ({ id: 'simulated_abc', __simulated: true }),
  );
  await assert.rejects(
    makeClient(transport).submitReport(baseQuery()),
    (err: unknown) => err instanceof InsightsError && /SIMULATE/.test(err.message) && /read, not a write/.test(err.message),
  );
});

test('a POST with no report_run_id fails loudly', async () => {
  const transport = new FakeTransport(() => ({}), () => ({ something_else: 1 }));
  await assert.rejects(makeClient(transport).submitReport(baseQuery()), /did not return a report_run_id/);
});

test('a report_run_id past its 30-day life is refused rather than read stale', async () => {
  const transport = new FakeTransport(() => ({ data: [] }));
  const client = makeClient(transport);
  const submittedAt = new Date(NOW.getTime() - REPORT_RUN_ID_TTL_MS - 1000);
  await assert.rejects(
    client.fetchReportResults('6023920149050', submittedAt),
    /expires them after 30/,
  );
});

test('a job that never finishes times out with the real remedy named', async () => {
  let t = NOW.getTime();
  const transport = new FakeTransport(() => {
    t += 10 * 60_000; // ten minutes per poll
    return { async_status: 'Job Running', async_percent_completion: 40 };
  });
  const client = new InsightsClient({
    transport,
    now: () => new Date(t),
    sleep: noSleep,
    onWarning: () => {},
  });
  await assert.rejects(client.runAsyncReport(baseQuery()), /narrow the time range or drop a breakdown/);
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const OBSERVED_1 = new Date('2026-09-02T06:00:00.000Z');
const OBSERVED_2 = new Date('2026-09-09T06:00:00.000Z');

test('toSnapshots keys on level, object, stat date, attribution setting and observation', () => {
  const [snap] = toSnapshots([ROW], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 });
  assert.ok(snap);
  assert.equal(snap.level, 'ad');
  assert.equal(snap.objectId, '23851234567890123');
  assert.equal(snap.statDate, '2026-09-01');
  assert.equal(snap.attributionSetting, '7d_click_1d_view');
  assert.equal(snap.breakdownKey, '');
  assert.equal(snap.observedAt, OBSERVED_1.toISOString());
  assert.equal(snap.attributionRegime, ATTRIBUTION_REGIMES.ENGAGE_THROUGH);
  assert.equal(snap.adAccountId, ACCOUNT);
  assert.equal(snap.source, 'sync');
  assert.deepEqual(snap.raw, ROW, 'the raw payload is kept verbatim');
});

test('a row without attribution_setting gets the sentinel, not a silent default', () => {
  const row: InsightsRow = { date_start: '2026-09-01', ad_id: 'a1' };
  const [snap] = toSnapshots([row], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 });
  assert.equal(snap?.attributionSetting, MISSING_ATTRIBUTION_SETTING);
});

test('a row that cannot be keyed is refused rather than stored under a guess', () => {
  assert.throws(
    () => toSnapshots([{ ad_id: 'a1' }], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }),
    /has no date_start/,
  );
  assert.throws(
    () => toSnapshots([{ date_start: '2026-09-01' }], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }),
    /has no ad_id/,
  );
  assert.throws(
    () => toSnapshots([{ date_start: '2026-09-01', ad_id: 'a1' }], { level: 'campaign', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }),
    /has no campaign_id/,
  );
});

test('breakdown rows do not collide, and asset breakdowns key on the stable id', () => {
  const rows: InsightsRow[] = [
    { date_start: '2026-09-01', ad_id: 'a1', publisher_platform: 'facebook', platform_position: 'feed' },
    { date_start: '2026-09-01', ad_id: 'a1', publisher_platform: 'instagram', platform_position: 'reels' },
  ];
  const snaps = toSnapshots(rows, {
    level: 'ad',
    adAccountId: ACCOUNT,
    observedAt: OBSERVED_1,
    breakdowns: ['publisher_platform', 'platform_position'],
  });
  assert.equal(snaps[0]?.breakdownKey, 'publisher_platform=facebook|platform_position=feed');
  assert.notEqual(identityKey(snaps[0]!), identityKey(snaps[1]!));

  const [asset] = toSnapshots(
    [{ date_start: '2026-09-01', ad_id: 'a1', body_asset: { text: 'Test text', id: '6051732675652' } }],
    { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1, breakdowns: ['body_asset'] },
  );
  assert.equal(asset?.breakdownKey, 'body_asset=6051732675652');
});

test('aggregating across differing attribution settings is refused unless reading an explicit window', () => {
  const mixed = [{ attributionSetting: '7d_click' }, { attributionSetting: '7d_click_1d_view' }];
  assert.throws(
    () => assertHomogeneousAttribution(mixed),
    (err: unknown) => err instanceof InsightsError && /not commensurable/.test(err.message),
  );
  assert.doesNotThrow(() => assertHomogeneousAttribution(mixed, { readingExplicitWindow: true }));
  assert.doesNotThrow(() => assertHomogeneousAttribution([{ attributionSetting: '7d_click' }]));
  assert.doesNotThrow(() => assertHomogeneousAttribution([]));
});

// ---------------------------------------------------------------------------
// The store — append-only, and the provenance it buys
// ---------------------------------------------------------------------------

function restatedRow(purchases: string): InsightsRow {
  return {
    date_start: '2026-09-01',
    ad_id: 'a1',
    attribution_setting: '7d_click_1d_view',
    spend: '800',
    actions: [{ action_type: 'omni_purchase', value: purchases }],
  };
}

test('a restatement is a new line; Tuesday still says what Tuesday said', () => {
  const path = join(ROOT, 'restatement.jsonl');
  const store = new MetricSnapshotStore({ path });
  store.append(toSnapshots([restatedRow('14')], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }));
  store.append(toSnapshots([restatedRow('20')], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_2 }));

  assert.equal(store.all().length, 2, 'nothing is ever overwritten');

  const id = { level: 'ad' as const, objectId: 'a1', statDate: '2026-09-01', attributionSetting: '7d_click_1d_view' };
  const history = store.history(id);
  assert.deepEqual(history.map((s) => actionValue(s.raw, 'omni_purchase')), [14, 20]);

  // The decision made on the 2nd is still explainable after the 9th's restatement.
  const asOfDecision = store.asOf(new Date('2026-09-02T12:00:00.000Z'));
  assert.equal(asOfDecision.length, 1);
  assert.equal(actionValue(asOfDecision[0]!.raw, 'omni_purchase'), 14);

  assert.equal(actionValue(store.latest(OBSERVED_2)[0]!.raw, 'omni_purchase'), 20);
});

test('the store round-trips through disk and reloads what was appended', () => {
  const path = join(ROOT, 'roundtrip.jsonl');
  const a = new MetricSnapshotStore({ path });
  a.append(toSnapshots([restatedRow('14')], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }));
  a.append(toSnapshots([restatedRow('20')], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_2, source: 'async' }));

  const reloaded = new MetricSnapshotStore({ path });
  assert.equal(reloaded.all().length, 2);
  assert.deepEqual(reloaded.warnings, []);
  assert.equal(reloaded.all()[1]?.source, 'async');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
});

test('a torn final line is dropped with a warning; a corrupt earlier line is refused', () => {
  const good = join(ROOT, 'torn.jsonl');
  const seed = new MetricSnapshotStore({ path: good });
  seed.append(toSnapshots([restatedRow('14')], { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 }));
  writeFileSync(good, `${readFileSync(good, 'utf8')}{"level":"ad","objectI`);
  const torn = new MetricSnapshotStore({ path: good });
  assert.equal(torn.all().length, 1);
  assert.equal(torn.warnings.length, 1);
  assert.match(torn.warnings[0] ?? '', /torn final line/);

  const bad = join(ROOT, 'corrupt.jsonl');
  writeFileSync(bad, `{"nope":true}\n${readFileSync(good, 'utf8').split('\n')[0]}\n`);
  assert.throws(() => new MetricSnapshotStore({ path: bad }), /line 1 is corrupt/);
});

test('an empty store is not an error', () => {
  const store = new MetricSnapshotStore({ path: join(ROOT, 'missing.jsonl') });
  assert.deepEqual(store.all(), []);
  assert.equal(store.append([]), 0);
});

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

test('completenessFactor matches its documented anchors and interpolates between them', () => {
  assert.equal(completenessFactor(0), 0.30);
  assert.equal(completenessFactor(1), 0.55);
  assert.equal(completenessFactor(2), 0.72);
  assert.equal(completenessFactor(3), 0.82);
  assert.equal(completenessFactor(7), 0.97);
  assert.equal(completenessFactor(28), 1);
  // 4 sits halfway between the 3 and 5 anchors.
  assert.ok(Math.abs(completenessFactor(4) - 0.875) < 1e-9);
  // Meta freezes rows at 28 days, so everything beyond is complete.
  assert.equal(completenessFactor(60), 1);
});

test('the conservative curve is never more optimistic than the default about young cohorts', () => {
  for (const age of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(
      completenessFactor(age, CONSERVATIVE_COMPLETENESS_CURVE) <= completenessFactor(age, DEFAULT_COMPLETENESS_CURVE) + 1e-9,
      `age ${age}: the conservative curve must not over-state completeness`,
    );
  }
  assert.equal(completenessFactor(2, CONSERVATIVE_COMPLETENESS_CURVE), 0.55);
  assert.equal(completenessFactor(7, CONSERVATIVE_COMPLETENESS_CURVE), 0.95);
});

test('a negative age is a timezone bug and says so', () => {
  assert.throws(() => completenessFactor(-1), /timezone bug/);
  assert.throws(() => completenessFactor(Number.NaN), /not a finite number/);
});

test('the correction deflates exposure rather than inflating conversions', () => {
  // $500 spent at age 1 is $275 of evidence, not $500 — the posterior stays wide.
  assert.ok(Math.abs(effectiveExposure(500, 1) - 275) < 1e-9);
  assert.equal(effectiveExposure(500, 40), 500, 'past 28 days the row is frozen and fully reported');
});

test('the age-confounded kill this correction exists to prevent', () => {
  // Two ads, identical true CPA of $40, $800 spent each. The young one LOOKS 36% worse.
  const observedYoung = 20 * completenessFactor(2); // 14.4
  const observedOld = 20 * completenessFactor(8); // ~19.4
  assert.ok(800 / observedYoung > 1.3 * (800 / observedOld), 'the naive comparison is badly biased');

  // Completeness-corrected exposure puts them back on equal terms.
  const cpaYoung = effectiveExposure(800, 2) / observedYoung;
  const cpaOld = effectiveExposure(800, 8) / observedOld;
  assert.ok(Math.abs(cpaYoung - cpaOld) < 1e-9, 'corrected, the two ads are indistinguishable');
});

// ---------------------------------------------------------------------------
// Fitting the curve from the store's own restatements
// ---------------------------------------------------------------------------

function syntheticCohorts(trueCurve: readonly number[], cohortCount: number, finalPerCohort: number): MetricSnapshot[] {
  const out: MetricSnapshot[] = [];
  for (let c = 0; c < cohortCount; c++) {
    const statDate = addDays('2026-04-01', c);
    for (let age = 0; age < trueCurve.length; age++) {
      const factor = trueCurve[age] ?? 1;
      const row: InsightsRow = {
        date_start: statDate,
        ad_id: `ad_${c}`,
        attribution_setting: '7d_click',
        actions: [{ action_type: 'omni_purchase', value: String(Math.round(finalPerCohort * factor)) }],
      };
      const [snap] = toSnapshots([row], {
        level: 'ad',
        adAccountId: ACCOUNT,
        observedAt: new Date(`${addDays(statDate, age)}T06:00:00.000Z`),
      });
      if (snap) out.push(snap);
    }
  }
  return out;
}

test('the fitter refuses to invent a curve from thin history', () => {
  const fit = fitCompletenessCurve(syntheticCohorts([0.5, 1], 2, 10), { actionType: 'omni_purchase' });
  assert.equal(fit.fitted, false);
  if (!fit.fitted) {
    assert.match(fit.reason, /not enough settled history/);
    assert.match(fit.reason, /illustrative, not measured/);
  }
});

test('the fitter recovers a known curve from settled append-only history', () => {
  const trueCurve = [0.4, 0.6, 0.75, 0.85, 0.9, 0.93, 0.96, 0.98, 0.99, 1];
  // Ages 0..9 observed, then a settled observation at 28 to establish C_final.
  const snaps = syntheticCohorts([...trueCurve, ...Array<number>(19).fill(1)], 40, 50);
  const fit = fitCompletenessCurve(snaps, { actionType: 'omni_purchase' });
  assert.equal(fit.fitted, true);
  if (fit.fitted) {
    assert.equal(fit.cohorts, 40);
    assert.equal(fit.finalConversions, 40 * 50);
    for (let age = 0; age < trueCurve.length; age++) {
      const point = fit.curve.find((p) => p.ageDays === age);
      assert.ok(point, `age ${age} missing from the fitted curve`);
      assert.ok(Math.abs(point.factor - (trueCurve[age] ?? 1)) < 0.02, `age ${age}: got ${point.factor}`);
    }
    // Monotone non-decreasing: reporting only ever adds conversions.
    for (let i = 1; i < fit.curve.length; i++) {
      assert.ok((fit.curve[i]?.factor ?? 0) >= (fit.curve[i - 1]?.factor ?? 0));
    }
    // And usable directly by completenessFactor.
    assert.ok(Math.abs(completenessFactor(2, fit.curve) - 0.75) < 0.02);
  }
});

test('cohorts that never converted are excluded rather than counted as fully reported', () => {
  const zeroCohorts = syntheticCohorts(Array<number>(29).fill(0), 40, 0);
  const fit = fitCompletenessCurve(zeroCohorts, { actionType: 'omni_purchase' });
  assert.equal(fit.fitted, false);
  if (!fit.fitted) assert.match(fit.reason, /0 cohorts/);
});

// ---------------------------------------------------------------------------
// Regressions found in adversarial review
// ---------------------------------------------------------------------------

test('the identity key cannot be forged by a value that contains the delimiter', () => {
  // A space-joined key makes these two DIFFERENT cells collide, which silently merges
  // two ads' restatement histories in asOf() and history().
  const a = { level: 'ad' as const, objectId: 'a1', statDate: '2026-09-01', attributionSetting: '7d_click', breakdownKey: 'region=New York' };
  const b = { level: 'ad' as const, objectId: 'a1', statDate: '2026-09-01', attributionSetting: '7d_click region=New', breakdownKey: 'York' };
  assert.notEqual(identityKey(a), identityKey(b));
});

test('the module source carries no raw control characters', () => {
  // A literal NUL in the file makes grep, diff and git treat the module as binary, so
  // the key delimiter is written as an escape.
  const src = readFileSync(new URL('../src/meta/insights.ts', import.meta.url), 'utf8');
  assert.equal(src.includes(String.fromCharCode(0)), false, 'write control chars as escapes');
});

test('view-derived attribution windows are refused too, and unmodelled ones by name', () => {
  for (const dead of ['7d_view_all_conversions', '28d_view_first_conversion']) {
    assert.throws(
      () => buildInsightsRequest(baseQuery({ actionAttributionWindows: [dead as never] }), NOW),
      (err: unknown) => err instanceof InsightsError && /2026-01-12/.test(err.message),
      `${dead} must be refused: a variant of a dead window has no data either`,
    );
  }
  assert.throws(
    () => buildInsightsRequest(baseQuery({ actionAttributionWindows: ['dda' as never] }), NOW),
    (err: unknown) => err instanceof InsightsError && /not one of the windows this module models/.test(err.message),
  );
});

test('the 13-month and 6-month retention caps are warned about, not discovered as empty rows', () => {
  // Unique fields: capped at 13 months since 2026-01-12 while totals keep 37.
  const unique = buildInsightsRequest(
    baseQuery({ timeRange: { since: '2024-01-01', until: '2024-01-31' }, fields: ['spend', 'reach'] }),
    NOW,
  );
  assert.ok(unique.warnings.some((w) => /13-month retention cap/.test(w) && /reach/.test(w)));

  // Hourly breakdowns: same 13-month cap.
  const hourly = buildInsightsRequest(
    baseQuery({
      timeRange: { since: '2024-01-01', until: '2024-01-31' },
      fields: ['spend'],
      breakdowns: ['hourly_stats_aggregated_by_advertiser_time_zone'],
    }),
    NOW,
  );
  assert.ok(hourly.warnings.some((w) => /hourly breakdowns/.test(w) && /13-month/.test(w)));

  // reach + any breakdown past 13 months: sync returns nothing, async serves it 10/day.
  const reach = buildInsightsRequest(
    baseQuery({ timeRange: { since: '2024-01-01', until: '2024-01-31' }, fields: ['reach'], breakdowns: ['country'] }),
    NOW,
  );
  assert.ok(reach.warnings.some((w) => /SYNCHRONOUS/.test(w) && /10 requests per ad account per day/.test(w)));

  // frequency_value: 6 months, not 13.
  const freq = buildInsightsRequest(
    baseQuery({ timeRange: { since: '2026-01-01', until: '2026-01-31' }, fields: ['spend'], breakdowns: ['frequency_value'] }),
    NOW,
  );
  assert.ok(freq.warnings.some((w) => /6-month retention cap/.test(w)));

  // date_preset=maximum reaches 37 months, so it crosses every cap.
  const preset = buildInsightsRequest(
    { adAccountId: ACCOUNT, level: 'ad', datePreset: 'maximum', fields: ['spend', 'reach'] },
    NOW,
  );
  assert.ok(preset.warnings.some((w) => /date_preset=maximum/.test(w)));

  // The everyday rolling-28-day reward query crosses nothing.
  assert.deepEqual(buildInsightsRequest(creativeRewardQuery(ACCOUNT, '2026-09-05'), NOW).warnings, []);
});

test('the 37-month floor clamps the day instead of rolling into the next month', () => {
  // On the 31st, naive month arithmetic lands 37 months back on 2023-03-03 and refuses
  // three days that Meta would have served.
  const monthEnd = new Date('2026-03-31T09:00:00.000Z');
  assert.doesNotThrow(() =>
    buildInsightsRequest(
      { adAccountId: ACCOUNT, level: 'ad', fields: ['spend'], timeRange: { since: '2023-03-01', until: '2023-03-31' } },
      monthEnd,
    ),
  );
  assert.throws(
    () =>
      buildInsightsRequest(
        { adAccountId: ACCOUNT, level: 'ad', fields: ['spend'], timeRange: { since: '2023-02-27', until: '2023-03-31' } },
        monthEnd,
      ),
    /37-month/,
  );
});

test('the fitter takes the NEWEST settled observation, not the last one in the array', () => {
  const cell = (statDate: string, ageDays: number, value: string): MetricSnapshot => {
    const [snap] = toSnapshots(
      [{ date_start: statDate, ad_id: 'a1', attribution_setting: '7d_click', actions: [{ action_type: 'omni_purchase', value }] }],
      { level: 'ad', adAccountId: ACCOUNT, observedAt: new Date(`${addDays(statDate, ageDays)}T06:00:00.000Z`) },
    );
    assert.ok(snap);
    return snap;
  };
  // One cell: half the conversions in at age 0, 9 by day 28, the last one landing at 29.
  const chronological = [cell('2026-04-01', 0, '5'), cell('2026-04-01', 28, '9'), cell('2026-04-01', 29, '10')];
  // Reversed, the last settled row in array order is the OLDER, lower one.
  for (const snaps of [chronological, [...chronological].reverse()]) {
    const fit = fitCompletenessCurve(snaps, { actionType: 'omni_purchase', minCohorts: 1, minFinalConversions: 1 });
    assert.equal(fit.fitted, true);
    if (fit.fitted) {
      assert.equal(fit.finalConversions, 10, 'the final count is the newest settled observation');
      const zero = fit.curve.find((p) => p.ageDays === 0);
      assert.ok(zero && Math.abs(zero.factor - 0.5) < 1e-9, `F(0) should be 5/10, got ${zero?.factor}`);
    }
  }
});

test('effectiveExposure refuses a non-finite or negative spend rather than returning NaN', () => {
  assert.throws(() => effectiveExposure(Number.NaN, 2), /not a finite number/);
  assert.throws(() => effectiveExposure(-1, 2), /negative/);
  assert.equal(effectiveExposure(0, 2), 0, 'zero spend is a real value, not absence');
});

test('a large append survives a short write and reloads line for line', () => {
  const path = join(ROOT, 'bulk.jsonl');
  const rows: InsightsRow[] = [];
  for (let i = 0; i < 400; i++) {
    rows.push({ ...ROW, ad_id: `ad_${i}`, date_start: '2026-09-01', date_stop: '2026-09-01' });
  }
  const store = new MetricSnapshotStore({ path });
  assert.equal(store.append(toSnapshots(rows, { level: 'ad', adAccountId: ACCOUNT, observedAt: OBSERVED_1 })), 400);
  const reloaded = new MetricSnapshotStore({ path });
  assert.equal(reloaded.all().length, 400);
  assert.deepEqual(reloaded.warnings, [], 'a torn line here would mean bytes were dropped');
});
