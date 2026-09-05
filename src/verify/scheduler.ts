/**
 * Capability probe for `src/meta/scheduler.ts`.
 *
 * Not a unit test. The question is whether the rate-limit scheduler and the budget-change
 * queue actually do their job when driven with realistic traffic and the header shapes
 * Meta genuinely returns — not whether their branches are covered.
 *
 * Everything is driven through a synthetic clock, so a simulated hour of publishing
 * traffic costs a few milliseconds of wall time. That is also the point of one of the
 * checks: nothing in this module may sleep, so simulated time and wall time must be
 * completely decoupled.
 *
 * Header JSON below is copied from the shapes recorded in
 * `docs/research/meta-api-foundations.md` §8.4:
 *
 *   x-business-use-case-usage: {"<business-object-id>":[{"type":"ads_management",
 *     "call_count":95,"total_cputime":20,"total_time":20,
 *     "estimated_time_to_regain_access":0,"ads_api_access_tier":"development_access"}]}
 *   x-ad-account-usage: {"acc_id_util_pct":9.67,"reset_time_duration":100,
 *     "ads_api_access_tier":"standard_access"}
 *
 * `estimated_time_to_regain_access` is MINUTES, `reset_time_duration` is SECONDS, and
 * everything else is a percent. Getting that wrong is a 60x sleep in one direction or a
 * hot loop against a throttled endpoint in the other, so it is probed explicitly.
 *
 * Run standalone:
 *   node --experimental-strip-types src/verify/scheduler.ts
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { MetaApiError, type GraphErrorBody } from '../meta/errors.ts';
import { parseRateLimitHeaders, type RateLimitState } from '../meta/rateLimit.ts';
import { GRAPH_BASE_URL } from '../meta/version.ts';
import {
  BudgetChangeQueue,
  CHANGE_CAPS,
  MetaScheduler,
  POINT_CEILING,
  POINT_DECAY_MS,
  capBreach,
  isRateLimited,
  type BudgetProposal,
  type ChangeLease,
  type RateLimited,
} from '../meta/scheduler.ts';

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

function near(actual: number, expected: number, tolerance: number, what: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

/** A clock the probe moves by hand. Nothing in the scheduler may advance it. */
interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function clock(start = 1_700_000_000_000): Clock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Capture a `RateLimited` refusal, or fail loudly if the call was allowed. */
function refusal(fn: () => void): RateLimited {
  try {
    fn();
  } catch (e) {
    assert(isRateLimited(e), `expected a RateLimited signal, got ${String(e)}`);
    return e;
  }
  throw new Error('expected the scheduler to refuse this call, but it allowed it');
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<RateLimited> {
  try {
    await fn();
  } catch (e) {
    assert(isRateLimited(e), `expected a RateLimited signal, got ${String(e)}`);
    return e;
  }
  throw new Error('expected the scheduler to refuse this call, but it allowed it');
}

/* ------------------------------------------------- genuine Meta header fixtures ---- */

interface BucEntry {
  type: string;
  call_count: number;
  total_cputime: number;
  total_time: number;
  estimated_time_to_regain_access: number;
  ads_api_access_tier: string;
}

function bucEntry(type: string, over: Partial<BucEntry> = {}): BucEntry {
  return {
    type,
    call_count: 0,
    total_cputime: 0,
    total_time: 0,
    estimated_time_to_regain_access: 0,
    ads_api_access_tier: 'development_access',
    ...over,
  };
}

/** `x-business-use-case-usage` exactly as Meta serialises it: object id -> entry list. */
function bucHeaderJson(byObject: Record<string, BucEntry[]>): string {
  return JSON.stringify(byObject);
}

function acctHeaderJson(utilPct: number, resetTimeDuration?: number, tier?: string): string {
  const body: Record<string, unknown> = { acc_id_util_pct: utilPct };
  if (resetTimeDuration !== undefined) body['reset_time_duration'] = resetTimeDuration;
  if (tier !== undefined) body['ads_api_access_tier'] = tier;
  return JSON.stringify(body);
}

/** Parse through the real header parser so the probe exercises production parsing. */
function state(init: Record<string, string>): RateLimitState {
  return parseRateLimitHeaders(new Headers(init));
}

/** The Meta error body for an ad-account BUC throttle, verbatim shape. */
function throttleBody(): GraphErrorBody {
  return {
    message: '(#613) Calls to this api have exceeded the rate limit.',
    type: 'OAuthException',
    code: 613,
    error_subcode: 1487742,
    fbtrace_id: 'AbCdEfGhIjKlMnOpQrStUv',
  };
}

/** The per-ad-set budget cap breach. Different meaning, same THROTTLED disposition. */
function adsetCapBody(): GraphErrorBody {
  return {
    message: 'Invalid parameter',
    type: 'OAuthException',
    code: 613,
    error_subcode: 1487632,
    error_user_title: 'Ad set budget change limit reached',
    error_user_msg:
      'You can only change your ad set budget 4 times per hour. Please wait to make more changes.',
    fbtrace_id: 'ZyXwVuTsRqPoNmLkJiHgFe',
  };
}

/* ---------------------------------------------------------------- fake Marketing API */

/**
 * A faithful stand-in for Meta's ad-account point limiter, used to prove the scheduler's
 * local model actually keeps traffic under the real one.
 *
 * It runs the documented arithmetic — read 1 point, write 3, ceiling 60 on the Limited
 * tier, linear decay over 300 s — and answers throttled requests with the real error body
 * and the real headers, including `acc_id_util_pct` at 100.
 */
class FakeMeta {
  private readonly now: () => number;
  private points: number;
  private lastRefill: number;
  private calls = 0;
  /** Requests Meta itself refused. The whole point of the scheduler is to keep this 0. */
  throttles = 0;
  served = 0;

  constructor(now: () => number) {
    this.now = now;
    this.points = POINT_CEILING.LIMITED;
    this.lastRefill = now();
  }

  /** Another actor — Ads Manager, a native rule, a second worker — spending our budget. */
  drainExternally(points: number): void {
    this.refill();
    this.points = Math.max(0, this.points - points);
  }

  handle(lane: 'READ' | 'WRITE'): { ok: boolean; id: string; headers: Headers; error: GraphErrorBody } {
    this.refill();
    const cost = lane === 'WRITE' ? 3 : 1;
    const ok = this.points >= cost;
    if (ok) {
      this.points -= cost;
      this.served += 1;
      this.calls += 1;
    } else {
      this.throttles += 1;
    }
    const utilPct = Math.round(((POINT_CEILING.LIMITED - this.points) / POINT_CEILING.LIMITED) * 10000) / 100;
    // ads_management quota on a cold Limited account is 300 + 40 x active_ads per hour.
    const bucPct = Math.min(100, Math.round((this.calls / 300) * 100));
    const headers = new Headers({
      'x-business-use-case-usage': bucHeaderJson({
        '1234567890': [
          bucEntry('ads_management', {
            call_count: bucPct,
            total_cputime: Math.round(bucPct * 0.3),
            total_time: Math.round(bucPct * 0.4),
          }),
        ],
      }),
      'x-ad-account-usage': acctHeaderJson(ok ? utilPct : 100, 300),
    });
    return { ok, id: `1203${String(this.served).padStart(12, '0')}`, headers, error: throttleBody() };
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.points = Math.min(
      POINT_CEILING.LIMITED,
      this.points + (elapsed * POINT_CEILING.LIMITED) / POINT_DECAY_MS,
    );
  }
}

/* ------------------------------------------------------------------- the probes ---- */

type Probe = () => string | Promise<string>;

interface ProbeSpec {
  name: string;
  body: Probe;
}

const ACT = 'act_1234567890';

const PROBES: ProbeSpec[] = [
  /* ------------------------------------------------------ write-lane throughput ---- */
  {
    name: 'write lane exhausts at 20 writes per 5-minute window (Limited tier)',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      let writes = 0;
      let refused: RateLimited | undefined;
      // 220 ms of network latency per call, which is what a real publish loop looks like.
      for (let i = 0; i < 40; i += 1) {
        try {
          s.acquire({ lane: 'WRITE', adAccountId: ACT });
          writes += 1;
          c.advance(220);
        } catch (e) {
          assert(isRateLimited(e), `unexpected error: ${String(e)}`);
          refused = e;
          break;
        }
      }
      assert(refused !== undefined, 'the write lane never exhausted — the limiter is not limiting');
      assert(
        writes === 20,
        `expected exactly 20 writes from a full 60-point bucket (3 points each), got ${writes}`,
      );
      assert(
        refused.scope === `${ACT}/points`,
        `the 21st write must be refused by the point score, not ${refused.scope}`,
      );
      // 0.95 points left after 19 x 220 ms of refill; 2.05 points short of a write.
      near(refused.retryAfterMs, 10_250, 400, 'retry interval for the 21st write');
      return (
        `20 writes then refusal on ${refused.scope}; retry in ${refused.retryAfterMs} ms. ` +
        `That is the real publishing ceiling: 60 points / 3 per write over a 300 s decay window.`
      );
    },
  },
  {
    name: 'sustained write throughput converges on 20 writes per 300 s over a simulated hour',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      const deadline = c.now() + 3_600_000;
      let writes = 0;
      let refusals = 0;
      let iterations = 0;
      let minRetry = Number.POSITIVE_INFINITY;
      while (c.now() < deadline) {
        iterations += 1;
        assert(iterations < 200_000, 'the caller loop did not converge — probable hot loop');
        try {
          s.acquire({ lane: 'WRITE', adAccountId: ACT });
          writes += 1;
          c.advance(220);
        } catch (e) {
          assert(isRateLimited(e), `unexpected error: ${String(e)}`);
          refusals += 1;
          minRetry = Math.min(minRetry, e.retryAfterMs);
          assert(
            e.retryAfterMs > 0,
            'a refusal with retryAfterMs 0 is a hot loop against a throttled endpoint',
          );
          c.advance(e.retryAfterMs);
        }
      }
      // 60 points in the bucket + 3600 s x 0.2 points/s = 780 points / 3 = 260 writes.
      near(writes, 260, 12, 'writes in a simulated hour');
      // Strip the opening burst the full bucket pays for; what is left is the steady rate.
      const windows = 3_600_000 / POINT_DECAY_MS;
      const steady = (writes - 20) / windows;
      near(steady, 20, 1, 'sustained writes per 300 s window after the opening burst');
      return (
        `${writes} writes and ${refusals} refusals in a simulated hour: an opening burst of 20 from the ` +
        `full bucket, then ${steady.toFixed(1)} writes per 300 s window sustained (theory: 60 points / 3 ` +
        `= 20). Smallest retry interval offered was ${minRetry} ms, and every refusal was strictly ` +
        `positive, so a durable caller always makes progress.`
      );
    },
  },
  {
    name: 'Full tier is read off the header and raises the ceiling to 9000 points',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_management', { ads_api_access_tier: 'standard_access' })],
          }),
        }),
      );
      const snap = s.snapshot(ACT);
      assert(snap.fullTier, 'standard_access must be recognised as the Full tier');
      assert(snap.capacity === POINT_CEILING.FULL, `capacity ${snap.capacity} != 9000`);
      // The bucket must EARN the new headroom rather than being granted it on one header.
      near(snap.tokens, 60, 0.001, 'tokens immediately after the upgrade');
      c.advance(POINT_DECAY_MS);
      let writes = 0;
      for (let i = 0; i < 3200; i += 1) {
        try {
          s.acquire({ lane: 'WRITE', adAccountId: ACT });
          writes += 1;
        } catch {
          break;
        }
      }
      assert(writes === 3000, `Full tier should allow 9000/3 = 3000 writes, got ${writes}`);
      return `standard_access -> 9000-point ceiling -> ${writes} writes per window (150x Limited).`;
    },
  },

  /* ------------------------------------------------------------- header backoff ---- */
  {
    name: 'BUC governor backs off at 85% and harder at 95%, then recovers on the clock',
    body: () => {
      const c = clock();
      const warn = new MetaScheduler({ now: c.now });
      warn.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_management', { call_count: 87, total_cputime: 40, total_time: 55 })],
          }),
        }),
      );
      const v1 = warn.check({ lane: 'WRITE', adAccountId: ACT });
      assert(!v1.allowed, 'a bucket at 87% must be refused');
      assert(v1.retryAfterMs === 120_000, `warn backoff should be 120 s, got ${v1.retryAfterMs}`);
      c.advance(119_999);
      assert(!warn.check({ lane: 'WRITE', adAccountId: ACT }).allowed, 'released 1 ms early');
      c.advance(1);
      assert(warn.check({ lane: 'WRITE', adAccountId: ACT }).allowed, 'did not recover after 120 s');

      const c2 = clock();
      const crit = new MetaScheduler({ now: c2.now });
      crit.observe(
        ACT,
        state({
          // total_cputime is the percentage that bites on breakdown-heavy queries: you can
          // sit at call_count 12 and total_cputime 96.
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_insights', { call_count: 12, total_cputime: 96, total_time: 30 })],
          }),
        }),
      );
      const v2 = crit.check({ lane: 'READ', adAccountId: ACT });
      assert(v2.retryAfterMs === 600_000, `crit backoff should be 600 s, got ${v2.retryAfterMs}`);
      assert(/total_cputime 96/.test(v2.reason), `the reason must name the tripping percentage: ${v2.reason}`);

      // A clean header arriving mid-backoff must NOT release early: the governor's whole
      // job is to stand off for a fixed interval, and Meta's percentages are a lagging
      // snapshot that will read clean the instant before it cuts you off again.
      c2.advance(60_000);
      crit.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_insights', { call_count: 1, total_cputime: 1, total_time: 1 })],
          }),
        }),
      );
      const v3 = crit.check({ lane: 'READ', adAccountId: ACT });
      assert(!v3.allowed, 'a rosy header released the governor early');
      near(v3.retryAfterMs, 540_000, 1, 'remaining backoff after a clean header');
      c2.advance(540_000);
      assert(crit.check({ lane: 'READ', adAccountId: ACT }).allowed, 'never recovered');
      return (
        '87% -> 120 s, 96% -> 600 s, both released exactly on the clock and not one ms early. ' +
        'A clean header mid-backoff does not shorten the stand-off (by design).'
      );
    },
  },
  {
    name: 'estimated_time_to_regain_access is MINUTES, and a cut-off below the thresholds still counts',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [
              bucEntry('ads_management', { call_count: 100, estimated_time_to_regain_access: 30 }),
            ],
          }),
        }),
      );
      const v = s.check({ lane: 'WRITE', adAccountId: ACT });
      assert(
        v.retryAfterMs === 1_800_000,
        `30 minutes must become 1,800,000 ms, got ${v.retryAfterMs} ` +
          `(30 would mean ms, 30,000 would mean seconds — both are outages)`,
      );

      const c2 = clock();
      const s2 = new MetaScheduler({ now: c2.now });
      s2.observe(
        ACT,
        state({
          // Meta says it cut us off even though every percentage looks comfortable.
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_management', { call_count: 3, estimated_time_to_regain_access: 5 })],
          }),
        }),
      );
      const v2 = s2.check({ lane: 'WRITE', adAccountId: ACT });
      assert(v2.retryAfterMs === 300_000, `a 5-minute cut-off at 3% must be honoured, got ${v2.retryAfterMs}`);
      return 'eta 30 min -> 1,800,000 ms; a 5-minute cut-off reported at call_count 3% is still obeyed.';
    },
  },
  {
    name: 'x-ad-account-usage at 100% blocks for the tier floor, and the caller converges after it clears',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      // reset_time_duration is SECONDS. 100 s is shorter than the 300 s Limited-tier block,
      // so the floor must win or we hot-loop into a throttled account.
      s.observe(ACT, state({ 'x-ad-account-usage': acctHeaderJson(100, 100) }));
      const snap = s.snapshot(ACT);
      assert(
        snap.pointsBlockedForMs === 300_000,
        `expected the 300 s Limited-tier floor to beat reset_time_duration 100 s, got ${snap.pointsBlockedForMs}`,
      );
      assert(snap.tokens === 0, `a 100% account must have its local bucket drained, got ${snap.tokens}`);

      let refusals = 0;
      let iterations = 0;
      for (;;) {
        iterations += 1;
        assert(iterations < 100, 'the caller never got through after the block cleared');
        try {
          s.acquire({ lane: 'WRITE', adAccountId: ACT });
          break;
        } catch (e) {
          assert(isRateLimited(e), String(e));
          refusals += 1;
          c.advance(e.retryAfterMs);
        }
      }
      const elapsed = c.now() - 1_700_000_000_000;
      assert(refusals <= 3, `a caller honouring retryAfterMs took ${refusals} refusals to get through`);
      near(elapsed, 315_000, 2_000, 'total wait before the first write landed');
      return (
        `100% -> blocked ${snap.pointsBlockedForMs} ms (floor beat the 100 s header), bucket drained. ` +
        `A caller obeying retryAfterMs got through after ${refusals} refusals / ${elapsed} ms simulated ` +
        `(300 s block, then 15 s to earn 3 points back).`
      );
    },
  },
  {
    name: 'the point balance after a block does not depend on how often the scheduler was looked at',
    body: () => {
      // Found by this probe: `refill()` used to advance `lastRefill` before checking the
      // block, so every check()/acquire()/snapshot() made during a cut-off silently threw
      // away that slice of refill. A caller that slept the whole retryAfterMs arrived with
      // a full 60-point bucket (20 writes); the same caller with a metrics scraper calling
      // snapshot() every 10 s arrived with 2 points and could not write at all.
      const afterBlock = (pollEveryMs: number | undefined): { tokens: number; writes: number } => {
        const c = clock();
        const s = new MetaScheduler({ now: c.now });
        s.observe(ACT, state({ 'x-ad-account-usage': acctHeaderJson(100, 300) }));
        const end = c.now() + 300_000;
        if (pollEveryMs === undefined) {
          c.advance(end - c.now());
        } else {
          while (c.now() < end) {
            c.advance(Math.min(pollEveryMs, end - c.now()));
            s.snapshot(ACT); // a Prometheus scraper, a health endpoint, a debug log
          }
        }
        const tokens = s.snapshot(ACT).tokens;
        let writes = 0;
        for (let i = 0; i < 40; i += 1) {
          try {
            s.acquire({ lane: 'WRITE', adAccountId: ACT });
            writes += 1;
          } catch {
            break;
          }
        }
        return { tokens, writes };
      };

      const never = afterBlock(undefined);
      const often = afterBlock(10_000);
      const sometimes = afterBlock(150_000);
      assert(
        never.tokens === often.tokens && never.tokens === sometimes.tokens,
        `the point balance at the end of a 300 s block depends on observation frequency: ` +
          `never polled -> ${never.tokens} points / ${never.writes} writes, polled every 10 s -> ` +
          `${often.tokens} / ${often.writes}, polled every 150 s -> ${sometimes.tokens} / ${sometimes.writes}. ` +
          `snapshot() is documented as observability and is silently costing publishing throughput.`,
      );
      assert(
        never.tokens === 0 && never.writes === 0,
        `a cut-off account is documented to earn nothing back while blocked, but it ended the block ` +
          `with ${never.tokens} points`,
      );
      // And it starts earning again the moment the block lifts.
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(ACT, state({ 'x-ad-account-usage': acctHeaderJson(100, 300) }));
      c.advance(300_000 + POINT_DECAY_MS);
      near(s.snapshot(ACT).tokens, 60, 0.001, 'tokens one decay window after the block lifted');
      return (
        'a 300 s cut-off leaves 0 points whether the scheduler is polled every 10 s, every 150 s, or ' +
        'not at all, and the bucket refills normally from the moment the block lifts.'
      );
    },
  },
  {
    name: 'the bucket is seeded from the observed header and the seeding is pessimistic-only',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(ACT, state({ 'x-ad-account-usage': acctHeaderJson(9.67, 100) }));
      near(s.snapshot(ACT).tokens, 54.198, 0.001, 'tokens seeded from acc_id_util_pct 9.67');

      // Spend locally, then receive a stale, rosy header. It must never hand points back:
      // the percentage is a snapshot from before anything we have issued since.
      s.acquire({ lane: 'WRITE', adAccountId: ACT });
      const before = s.snapshot(ACT).tokens;
      s.observe(ACT, state({ 'x-ad-account-usage': acctHeaderJson(0) }));
      const after = s.snapshot(ACT).tokens;
      assert(after <= before + 1e-9, `a rosy header handed back points: ${before} -> ${after}`);
      return `acc_id_util_pct 9.67 -> ${before.toFixed(3)} points after one write; a 0% header left it at ${after.toFixed(3)}.`;
    },
  },

  /* ------------------------------------------------------------- lane isolation ---- */
  {
    name: 'a reporting storm on the read lane does not starve the write lane',
    body: () => {
      // Adversarial ordering: reads go FIRST every tick and take everything they are
      // allowed to, then one write is attempted with whatever is left.
      const run = (reserveFraction: number): { writes: number; reads: number } => {
        const c = clock();
        const s = new MetaScheduler({ now: c.now, writeReserveFraction: reserveFraction });
        let writes = 0;
        let reads = 0;
        for (let tick = 0; tick < 300; tick += 1) {
          for (let r = 0; r < 100; r += 1) {
            try {
              s.acquire({ lane: 'READ', adAccountId: ACT });
              reads += 1;
            } catch (e) {
              assert(isRateLimited(e), String(e));
              break;
            }
          }
          try {
            s.acquire({ lane: 'WRITE', adAccountId: ACT });
            writes += 1;
          } catch (e) {
            assert(isRateLimited(e), String(e));
          }
          c.advance(1_000);
        }
        return { writes, reads };
      };

      const reserved = run(0.5);
      const unreserved = run(0);
      assert(
        unreserved.writes === 0,
        `control case: with no reserve a read storm should starve publishing outright, ` +
          `but ${unreserved.writes} writes got through — the comparison proves nothing`,
      );
      assert(
        reserved.writes >= 20,
        `with a 50% write reserve, a 5-minute read storm still starved publishing: ` +
          `${reserved.writes} writes in 300 s`,
      );
      assert(reserved.reads > 0, 'the reserve blocked reads entirely, which is the opposite failure');

      // And reads must recover once the writes stop, or the reserve is just a read ban.
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      for (let i = 0; i < 100; i += 1) {
        try {
          s.acquire({ lane: 'READ', adAccountId: ACT });
        } catch {
          break;
        }
      }
      refusal(() => s.acquire({ lane: 'READ', adAccountId: ACT }));
      c.advance(POINT_DECAY_MS);
      s.acquire({ lane: 'READ', adAccountId: ACT });

      return (
        `300 s read storm with 100 read attempts/s: ${reserved.writes} writes and ${reserved.reads} reads ` +
        `survived with the default 50% reserve, vs ${unreserved.writes} writes and ${unreserved.reads} ` +
        `reads with the reserve disabled. The reserve is what keeps publishing alive; reads recover ` +
        `after one decay window once the writes stop.`
      );
    },
  },
  {
    name: 'BUC buckets are per use case: an insights bucket at 99% cannot block publishing',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [
              bucEntry('ads_insights', { call_count: 99, total_cputime: 80, total_time: 91 }),
              bucEntry('ads_management', { call_count: 4, total_cputime: 2, total_time: 3 }),
            ],
          }),
        }),
      );
      assert(!s.check({ lane: 'READ', adAccountId: ACT }).allowed, 'insights at 99% must be refused');
      assert(
        s.check({ lane: 'WRITE', adAccountId: ACT }).allowed,
        'an insights storm blocked the write lane — this is the starvation the split exists to prevent',
      );
      // A GET of campaigns/ad sets/ads draws on ads_management, not ads_insights.
      assert(
        s.check({ lane: 'READ', adAccountId: ACT, useCase: 'ads_management' }).allowed,
        'an object read was wrongly charged to the insights bucket',
      );
      return 'ads_insights 99% refuses reads; ads_management writes and object reads still flow.';
    },
  },

  /* --------------------------------------------------- refusal, never a sleep ------ */
  {
    name: 'no path sleeps inside a call: no timer is ever scheduled, and wall time stays decoupled',
    body: async () => {
      const realSetTimeout = globalThis.setTimeout;
      const realSetInterval = globalThis.setInterval;
      const realSetImmediate = globalThis.setImmediate;
      let timers = 0;
      const startWall = Date.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        globalThis.setTimeout = ((...args: unknown[]) => {
          timers += 1;
          return (realSetTimeout as unknown as (...a: unknown[]) => unknown)(...args);
        }) as unknown as typeof globalThis.setTimeout;
        globalThis.setInterval = ((...args: unknown[]) => {
          timers += 1;
          return (realSetInterval as unknown as (...a: unknown[]) => unknown)(...args);
        }) as unknown as typeof globalThis.setInterval;
        globalThis.setImmediate = ((...args: unknown[]) => {
          timers += 1;
          return (realSetImmediate as unknown as (...a: unknown[]) => unknown)(...args);
        }) as unknown as typeof globalThis.setImmediate;

        const c = clock();
        const s = new MetaScheduler({ now: c.now });
        // Saturate, then take a refusal through every public entry point.
        for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: ACT });
        s.check({ lane: 'WRITE', adAccountId: ACT });
        refusal(() => s.acquire({ lane: 'WRITE', adAccountId: ACT }));
        let called = false;
        await refusalAsync(async () =>
          s.run({ lane: 'WRITE', adAccountId: ACT }, async () => {
            called = true;
            return 1;
          }),
        );
        assert(!called, 'the scheduler dialled out despite refusing the call');
        // And a full simulated hour of traffic.
        const deadline = c.now() + 3_600_000;
        while (c.now() < deadline) {
          try {
            s.acquire({ lane: 'WRITE', adAccountId: ACT });
            c.advance(220);
          } catch (e) {
            assert(isRateLimited(e), String(e));
            c.advance((e as RateLimited).retryAfterMs);
          }
        }
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.setImmediate = realSetImmediate;
      }
      const wall = Date.now() - startWall;
      assert(timers === 0, `the scheduler scheduled ${timers} timer(s) — something in it sleeps`);
      assert(wall < 3_000, `a simulated hour took ${wall} ms of wall time; something blocked`);
      return (
        `one simulated hour of saturated write traffic: 0 timers scheduled (setTimeout/setInterval/` +
        `setImmediate all spied), ${wall} ms of wall time. Every refusal came back as a RateLimited ` +
        `carrying retryAfterMs, and run() never invoked the call it refused.`
      );
    },
  },
  {
    name: 'a Meta throttle is surfaced as RateLimited with attempted=true and the original error as cause',
    body: async () => {
      const c = clock();
      const seen: RateLimited[] = [];
      const s = new MetaScheduler({ now: c.now, onThrottle: (r) => seen.push(r) });
      const err = new MetaApiError(throttleBody(), 400);
      assert(err.disposition === 'THROTTLED', `errors.ts must classify 613/1487742 as THROTTLED`);

      const limited = await refusalAsync(async () =>
        s.run(
          {
            lane: 'WRITE',
            adAccountId: ACT,
            headers: () => state({ 'x-ad-account-usage': acctHeaderJson(100, 300) }),
          },
          async () => {
            throw err;
          },
        ),
      );
      assert(limited.attempted, 'a throttle Meta itself returned must be marked attempted');
      assert(limited.cause === err, 'the original MetaApiError must survive as the cause');
      assert(limited.retryAfterMs >= 300_000, `backoff ${limited.retryAfterMs} is under the tier floor`);
      assert(/613\/1487742/.test(limited.detail), `the detail must name the code: ${limited.detail}`);

      // The next attempt is refused pre-flight — no request leaves the process.
      let dialled = false;
      const preflight = await refusalAsync(async () =>
        s.run({ lane: 'WRITE', adAccountId: ACT }, async () => {
          dialled = true;
          return 1;
        }),
      );
      assert(!dialled, 'the scheduler dialled out while standing off from a throttle');
      assert(!preflight.attempted, 'a pre-flight refusal must not be marked attempted');
      assert(seen.length >= 2, `the onThrottle hook saw ${seen.length} refusals, expected >= 2`);
      return (
        `613/1487742 -> RateLimited(attempted=true, retryAfterMs=${limited.retryAfterMs}, cause=MetaApiError); ` +
        `the following call was refused pre-flight (attempted=false) without dialling out. ` +
        `onThrottle observed ${seen.length} refusals.`
      );
    },
  },
  {
    name: 'a per-ad-set budget cap breach must not stall the whole ad account',
    body: async () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      const err = new MetaApiError(adsetCapBody(), 400);
      assert(err.disposition === 'THROTTLED', 'errors.ts classifies 613/1487632 as THROTTLED');
      assert(capBreach(err) === 'ADSET_BUDGET', 'capBreach must name the ad-set budget cap');
      assert(
        capBreach(new MetaApiError({ message: 'x', code: 17, error_subcode: 1885172 }, 400)) ===
          'ACCOUNT_SPEND_LIMIT',
        'capBreach must also branch on the #17/1885172 family, which is not #613',
      );

      let thrown: unknown;
      try {
        await s.run({ lane: 'WRITE', adAccountId: ACT }, async () => {
          throw err;
        });
      } catch (e) {
        thrown = e;
      }
      assert(thrown === err, 'a per-object cap breach must pass through as the MetaApiError, not a RateLimited');
      const v = s.check({ lane: 'WRITE', adAccountId: ACT });
      assert(v.allowed, `one ad set hitting its budget cap stalled the whole account: ${v.reason}`);
      near(s.snapshot(ACT).tokens, 57, 0.001, 'points after the failed write');
      return (
        'a 613/1487632 breach passes through untouched, the account keeps publishing, and only the ' +
        '3 points the attempt actually cost were charged. 17/1885172 is recognised as its own family.'
      );
    },
  },

  /* ---------------------------------------------- end-to-end against a fake Meta --- */
  {
    name: 'end-to-end: 48 publish writes against a faithful fake Meta, taking zero server-side throttles',
    body: async () => {
      const c = clock();
      const fake = new FakeMeta(c.now);
      const s = new MetaScheduler({ now: c.now });
      const ids: string[] = [];
      let refusals = 0;
      let last: RateLimitState | undefined;

      // Eight ads: campaign, ad set, video upload, thumbnail, creative, ad.
      for (let call = 0; call < 48; call += 1) {
        let landed = false;
        for (let attempt = 0; attempt < 60 && !landed; attempt += 1) {
          try {
            const id = await s.run(
              { lane: 'WRITE', adAccountId: ACT, headers: () => last },
              async () => {
                c.advance(220); // network latency between charge and Meta receiving it
                const res = fake.handle('WRITE');
                last = parseRateLimitHeaders(res.headers);
                if (!res.ok) throw new MetaApiError(res.error, 400);
                return res.id;
              },
            );
            ids.push(id);
            landed = true;
          } catch (e) {
            assert(isRateLimited(e), `unexpected failure: ${String(e)}`);
            refusals += 1;
            c.advance(e.retryAfterMs);
          }
        }
        assert(landed, `publish call ${call} never landed`);
      }

      assert(ids.length === 48, `expected 48 ids, got ${ids.length}`);
      assert(new Set(ids).size === 48, 'duplicate object ids came back — the fake or the loop is wrong');
      assert(
        fake.throttles === 0,
        `the scheduler let ${fake.throttles} requests reach Meta's limiter. The local model is ` +
          `supposed to keep us under it, not discover it by being refused.`,
      );
      const elapsed = c.now() - 1_700_000_000_000;
      // 48 x 3 = 144 points; 60 in the bucket, 84 earned at 0.2 points/s = 420 s.
      near(elapsed, 420_000, 60_000, 'simulated time to publish 48 writes');
      const snap = s.snapshot(ACT);
      assert(snap.buc.length > 0, 'the BUC bucket was never seeded from the response headers');
      return (
        `48/48 writes landed in ${(elapsed / 1000).toFixed(0)} s of simulated time after ${refusals} ` +
        `client-side refusals and ZERO server-side throttles. Local view at the end: ` +
        `${snap.tokens.toFixed(1)}/${snap.capacity} points, ads_management BUC at ` +
        `${snap.buc[0]?.worstPct ?? 0}%.`
      );
    },
  },
  {
    name: 'a second actor spending the same budget is absorbed through the headers, not by guessing',
    body: async () => {
      const c = clock();
      const fake = new FakeMeta(c.now);
      const s = new MetaScheduler({ now: c.now });
      let last: RateLimitState | undefined;
      let landed = 0;
      let refusals = 0;

      for (let call = 0; call < 24; call += 1) {
        // Ads Manager, a native ad rule, or a second worker eats 12 points behind our back.
        if (call === 4 || call === 12) fake.drainExternally(12);
        for (let attempt = 0; attempt < 80; attempt += 1) {
          try {
            await s.run(
              { lane: 'WRITE', adAccountId: ACT, headers: () => last },
              async () => {
                c.advance(220);
                const res = fake.handle('WRITE');
                last = parseRateLimitHeaders(res.headers);
                if (!res.ok) throw new MetaApiError(res.error, 400);
                return res.id;
              },
            );
            landed += 1;
            break;
          } catch (e) {
            assert(isRateLimited(e), `unexpected failure: ${String(e)}`);
            refusals += 1;
            c.advance(e.retryAfterMs);
          }
        }
      }
      assert(landed === 24, `only ${landed}/24 writes landed with a competing actor on the account`);
      assert(
        fake.throttles <= 2,
        `${fake.throttles} server-side throttles — the header feedback is not correcting the local model`,
      );
      return (
        `24/24 writes landed with an invisible competitor draining 24 points mid-run: ` +
        `${refusals} client-side refusals, ${fake.throttles} server-side throttle(s). The pessimistic ` +
        `acc_id_util_pct clamp is what absorbs the other actor.`
      );
    },
  },

  /* ------------------------------------------------------------- write ordering ---- */
  {
    name: 'writes serialise per ad account, run in parallel across accounts, and release on failure',
    body: async () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      const order: string[] = [];
      const gates: Array<() => void> = [];
      const make = (acct: string, tag: string): Promise<unknown> =>
        s.run({ lane: 'WRITE', adAccountId: acct }, async () => {
          order.push(`start:${tag}`);
          await new Promise<void>((resolve) => gates.push(resolve));
          order.push(`end:${tag}`);
          return tag;
        });

      const a1 = make('act_a', 'a1');
      const a2 = make('act_a', 'a2');
      const b1 = make('act_b', 'b1');
      await Promise.resolve();
      await Promise.resolve();
      assert(
        order.filter((o) => o === 'start:a2').length === 0,
        `two writes to one ad account ran concurrently: ${order.join(',')}`,
      );
      assert(order.includes('start:b1'), `a write to a different account was needlessly serialised: ${order.join(',')}`);
      assert(s.snapshot('act_a').inFlightWrites === 2, 'in-flight write depth is not tracked');

      for (const g of [...gates]) g();
      await Promise.all([a1, b1]);
      for (const g of gates.slice(2)) g();
      await a2;
      for (const g of gates) g();
      await a2;
      assert(order.indexOf('start:a2') > order.indexOf('end:a1'), `a2 started before a1 finished: ${order.join(',')}`);
      assert(s.snapshot('act_a').inFlightWrites === 0, 'the per-account write lock leaked');

      // A failing write must not wedge the lane behind it.
      const c2 = clock();
      const s2 = new MetaScheduler({ now: c2.now });
      await s2
        .run({ lane: 'WRITE', adAccountId: ACT }, async () => {
          throw new Error('boom');
        })
        .catch(() => undefined);
      const after = await s2.run({ lane: 'WRITE', adAccountId: ACT }, async () => 'ok');
      assert(after === 'ok', 'the write lane wedged behind a failed write');
      assert(s2.snapshot(ACT).inFlightWrites === 0, 'the lock leaked after a failure');
      return `serialised per account (${order.join(' ')}), parallel across accounts, lock released after a throw.`;
    },
  },

  /* ------------------------------------------------------------- budget queue ------ */
  {
    name: 'the budget queue enforces 4 ad-set changes per rolling hour, one slot at a time',
    body: () => {
      const c = clock();
      const q = new BudgetChangeQueue({ now: c.now, staleAfterMs: Number.POSITIVE_INFINITY });
      const base: BudgetProposal = {
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890123',
        valueMinorUnits: 5_000,
        value: 1,
        reason: 'probe',
      };
      const taken: ChangeLease[] = [];
      // Four changes spread across the hour, as a real optimiser would make them.
      for (let i = 0; i < 4; i += 1) {
        q.propose({ ...base, value: i + 1 });
        const lease = q.take();
        assert(lease !== undefined, `change ${i + 1} of 4 was refused a slot`);
        q.settle(lease.leaseId, 'APPLIED');
        taken.push(lease);
        c.advance(600_000);
      }
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 0, 'the 4-per-hour cap did not saturate');
      q.propose({ ...base, value: 99 });
      assert(q.take() === undefined, 'a fifth change inside the hour was allowed — Meta would reject it');

      // The window is ROLLING: at exactly one hour after the first change, one slot frees.
      const firstAt = taken[0]?.takenAt ?? 0;
      const eligibleIn = q.nextEligibleAt('ADSET_BUDGET', base.targetId) - c.now();
      near(firstAt + CHANGE_CAPS.ADSET_BUDGET.windowMs - c.now(), eligibleIn, 1, 'nextEligibleAt');
      c.advance(eligibleIn - 1);
      assert(q.take() === undefined, 'a slot opened 1 ms early');
      c.advance(1);
      const fifth = q.take();
      assert(fifth !== undefined, 'the rolling window never released a slot');
      assert(fifth.value === 99, 'the wrong proposal took the freed slot');
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 0, 'more than one slot was released at once');
      return (
        `4 changes at t=0/10/20/30 min saturated the cap; the 5th was refused until exactly ` +
        `t=60 min, when precisely one slot reopened (rolling, not fixed, window).`
      );
    },
  },
  {
    name: 'when saturated the queue keeps the highest-value proposal, not the oldest',
    body: () => {
      const c = clock();
      const q = new BudgetChangeQueue({ now: c.now, staleAfterMs: Number.POSITIVE_INFINITY });
      const base: BudgetProposal = {
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890123',
        valueMinorUnits: 5_000,
        value: 0,
        reason: 'probe',
      };
      for (let i = 0; i < 4; i += 1) {
        q.propose({ ...base, value: 1 });
        const l = q.take();
        assert(l !== undefined, 'setup: could not saturate the window');
        q.settle(l.leaseId, 'APPLIED');
      }
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 0, 'setup: window not saturated');

      // Twelve rival proposals arrive during the stand-off. The best is neither first nor
      // last, so neither "keep the oldest" nor "keep the newest" can pass by accident.
      const values = [3, 11, 7, 42, 5, 19, 2, 31, 8, 14, 6, 23];
      const dropped: number[] = [];
      const q2 = new BudgetChangeQueue({
        now: c.now,
        staleAfterMs: Number.POSITIVE_INFINITY,
        onDropped: (ch, why) => {
          assert(why === 'SUPERSEDED', `unexpected drop reason ${why}`);
          dropped.push(ch.value);
        },
      });
      for (let i = 0; i < 4; i += 1) {
        q2.propose({ ...base, value: 1 });
        const l = q2.take();
        assert(l !== undefined, 'setup');
        q2.settle(l.leaseId, 'APPLIED');
      }
      for (const v of values) {
        c.advance(30_000);
        q2.propose({ ...base, value: v, valueMinorUnits: 1_000 * v });
      }
      const pending = q2.peek();
      assert(pending.length === 1, `the queue must coalesce to one pending change per target, got ${pending.length}`);
      assert(pending[0]?.value === 42, `expected the best proposal (42) to hold the slot, got ${pending[0]?.value}`);
      assert(
        pending[0]?.valueMinorUnits === 42_000,
        'the winning proposal carried the wrong budget through',
      );

      c.advance(CHANGE_CAPS.ADSET_BUDGET.windowMs);
      const lease = q2.take();
      assert(lease !== undefined, 'nothing could be taken once the window reopened');
      assert(lease.value === 42, `the freed slot went to value ${lease.value}, not the best (42)`);
      assert(
        lease.supersededCount > 0,
        'the winner does not record that it out-competed rivals, so the audit trail loses why',
      );

      // Ties go to the newer proposal: same expected value, fresher inputs.
      const q3 = new BudgetChangeQueue({ now: c.now, staleAfterMs: Number.POSITIVE_INFINITY });
      q3.propose({ ...base, value: 5, valueMinorUnits: 100 });
      q3.propose({ ...base, value: 5, valueMinorUnits: 200 });
      assert(q3.peek()[0]?.valueMinorUnits === 200, 'an equal-value newer proposal did not win');
      return (
        `12 rivals (best=42, arriving 4th of 12) collapsed to a single pending change worth 42; ` +
        `${dropped.length} supersessions reported; the freed slot went to 42, not to the oldest. ` +
        `Equal value goes to the fresher proposal.`
      );
    },
  },
  {
    name: 'a change held back by a full cap window survives the stand-off and is applied when it reopens',
    body: () => {
      // Found by this probe: `staleAfterMs` defaults to the cap window, which is exactly
      // the width of the stand-off a saturated target imposes. Measured from proposedAt
      // alone, a proposal queued t ms after saturation went stale t ms after the slot
      // reopened, so any poll interval wider than t lost it — and the one it lost was the
      // highest-value change, because that is the one the queue is holding.
      const attempt = (pollMs: number): { lease: ChangeLease | undefined; drops: string[]; at: number } => {
        const c = clock();
        const drops: string[] = [];
        // Default options: what a caller who has not read the source gets.
        const q = new BudgetChangeQueue({ now: c.now, onDropped: (ch, why) => drops.push(`${why}:${ch.value}`) });
        const base: BudgetProposal = {
          kind: 'ADSET_BUDGET',
          adAccountId: ACT,
          targetId: '23851234567890123',
          valueMinorUnits: 5_000,
          value: 1,
          reason: 'probe',
        };
        for (let i = 0; i < 4; i += 1) {
          q.propose({ ...base });
          const l = q.take();
          assert(l !== undefined, 'setup: could not saturate the window');
          q.settle(l.leaseId, 'APPLIED');
        }
        // A second later the optimiser proposes the change that actually matters.
        c.advance(1_000);
        q.propose({ ...base, value: 500, valueMinorUnits: 2_500, reason: 'CPA doubled, cut the budget' });

        // Poll for two hours of simulated time — twice the cap window, so a slot that
        // reopens on schedule cannot be missed for want of another poll.
        let lease: ChangeLease | undefined;
        const deadline = c.now() + 2 * CHANGE_CAPS.ADSET_BUDGET.windowMs;
        while (lease === undefined && c.now() < deadline) {
          c.advance(pollMs);
          lease = q.take();
        }
        return { lease, drops, at: c.now() - 1_700_000_000_000 };
      };

      for (const pollMs of [60_000, 300_000, 420_000, 900_000]) {
        const r = attempt(pollMs);
        assert(
          r.lease !== undefined,
          `with a ${pollMs / 60_000}-minute poll the winning change (value 500) was never applied; ` +
            `drops: [${r.drops.join(', ')}]`,
        );
        assert(r.lease.value === 500, `the wrong proposal was applied: ${r.lease.value}`);
        assert(r.lease.valueMinorUnits === 2_500, 'the winning budget did not survive the stand-off');
        assert(
          r.at >= CHANGE_CAPS.ADSET_BUDGET.windowMs,
          `the change was applied at ${r.at} ms, inside the cap window — Meta would have rejected it`,
        );
        assert(r.drops.length === 0, `something was dropped during the stand-off: [${r.drops.join(', ')}]`);
      }

      // And a proposal that HAS had its chance is still dropped: the staleness rule has
      // not simply been switched off.
      const c2 = clock();
      const late: string[] = [];
      const q2 = new BudgetChangeQueue({ now: c2.now, onDropped: (ch, why) => late.push(`${why}:${ch.value}`) });
      q2.propose({
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890999',
        valueMinorUnits: 5_000,
        value: 1,
        reason: 'nobody ever came to collect this',
      });
      c2.advance(CHANGE_CAPS.ADSET_BUDGET.windowMs);
      assert(q2.take() === undefined, 'an hour-old proposal on an idle target must still be dropped');
      assert(late.length === 1 && late[0] === 'STALE:1', `expected one stale drop, got [${late.join(', ')}]`);
      return (
        'a change proposed 1 s after its ad set saturated the 4/hour cap is applied at the reopening ' +
        'for 1, 5, 7 and 15-minute poll intervals, with the right budget and nothing dropped. A ' +
        'proposal on an uncapped target that nobody collects for an hour is still dropped STALE.'
      );
    },
  },
  {
    name: 'a slot is spent at take(), and only a proven non-send returns it',
    body: () => {
      const c = clock();
      const q = new BudgetChangeQueue({ now: c.now, staleAfterMs: Number.POSITIVE_INFINITY });
      const base: BudgetProposal = {
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890123',
        valueMinorUnits: 5_000,
        value: 1,
        reason: 'probe',
      };

      q.propose(base);
      const a = q.take();
      assert(a !== undefined, 'setup');
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 3, 'the slot was not spent at take()');
      // A spend-guard refusal: we KNOW nothing reached Meta.
      q.settle(a.leaseId, 'NOT_SENT');
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 4, 'a proven non-send did not return its slot');

      q.propose(base);
      const b = q.take();
      assert(b !== undefined, 'setup');
      q.settle(b.leaseId, 'UNKNOWN');
      assert(
        q.remaining('ADSET_BUDGET', base.targetId) === 3,
        'an ambiguous outcome returned its slot — that is how a budget gets written twice',
      );

      // Never settling keeps the slot, which is the safe direction.
      q.propose(base);
      const c3 = q.take();
      assert(c3 !== undefined, 'setup');
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 2, 'an open lease released its slot');

      // Meta says the window is already full: saturate, and cancel the open lease's refund.
      const wait = q.recordCapRejection('ADSET_BUDGET', base.targetId);
      assert(wait === CHANGE_CAPS.ADSET_BUDGET.windowMs, `stand-off should be a full window, got ${wait}`);
      assert(q.remaining('ADSET_BUDGET', base.targetId) === 0, 'a cap rejection did not saturate the window');
      q.settle(c3.leaseId, 'NOT_SENT');
      assert(
        q.remaining('ADSET_BUDGET', base.targetId) === 0,
        'a refund re-opened a slot Meta has already refused',
      );

      let threw = false;
      try {
        q.settle(c3.leaseId, 'APPLIED');
      } catch {
        threw = true;
      }
      assert(threw, 'settling a lease twice must be loud — the cap accounting is not what the caller thinks');
      return (
        'take() spends the slot; NOT_SENT refunds it; UNKNOWN and never-settling keep it; a cap ' +
        'rejection saturates the window and cancels a pending refund; a double settle throws.'
      );
    },
  },
  {
    name: 'the 24 h high-water mark tells the executor what a budget write really exposed',
    body: () => {
      const c = clock();
      const q = new BudgetChangeQueue({ now: c.now, staleAfterMs: Number.POSITIVE_INFINITY });
      const base: BudgetProposal = {
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890123',
        valueMinorUnits: 40_000,
        value: 1,
        reason: 'scale up',
      };
      q.propose(base);
      const up = q.take();
      assert(up !== undefined, 'setup');
      assert(up.todayHighWaterMinorUnits === undefined, 'a first write should report no prior exposure');
      q.settle(up.leaseId, 'APPLIED');

      c.advance(3_600_000);
      q.propose({ ...base, valueMinorUnits: 10_000, reason: 'roll back' });
      const down = q.take();
      assert(down !== undefined, 'setup');
      assert(
        down.todayHighWaterMinorUnits === 40_000,
        `rolling a budget back does not undo the day's exposure; expected 40000, got ${down.todayHighWaterMinorUnits}`,
      );
      q.settle(down.leaseId, 'APPLIED');
      assert(q.highWaterMark(base.targetId) === 40_000, 'the high-water mark moved down with the rollback');

      c.advance(86_400_001);
      assert(q.highWaterMark(base.targetId) === undefined, 'the 24 h window never expired');
      return (
        '40,000 minor units written then rolled back to 10,000 still reports a 40,000 high-water mark ' +
        "(Meta's 175% daily ceiling anchors to the highest budget set), and it expires after 24 h."
      );
    },
  },
  {
    name: 'the queue refuses a budget it could not honestly write',
    body: () => {
      const c = clock();
      const q = new BudgetChangeQueue({ now: c.now });
      const base: BudgetProposal = {
        kind: 'ADSET_BUDGET',
        adAccountId: ACT,
        targetId: '23851234567890123',
        valueMinorUnits: 5_000,
        value: 1,
        reason: 'probe',
      };
      const bad: Array<[string, BudgetProposal]> = [
        ['NaN priority', { ...base, value: Number.NaN }],
        ['infinite priority', { ...base, value: Number.POSITIVE_INFINITY }],
        ['fractional minor units', { ...base, valueMinorUnits: 5_000.5 }],
        ['negative budget', { ...base, valueMinorUnits: -1 }],
        ['no target', { ...base, targetId: '' }],
        ['no ad account', { ...base, adAccountId: '' }],
      ];
      const refused: string[] = [];
      for (const [label, proposal] of bad) {
        try {
          q.propose(proposal);
          throw new Error(`ACCEPTED: ${label}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          assert(!msg.startsWith('ACCEPTED:'), `${msg} — this would eventually be POSTed to Meta`);
          refused.push(label);
        }
      }
      assert(q.stats().pending === 0, 'a rejected proposal still entered the queue');
      return `refused: ${refused.join(', ')}. A NaN priority never loses a comparison, so it would hold a slot for ever.`;
    },
  },

  /* -------------------------------------------------------- regression: NaN lane --- */
  {
    name: 'an unknown lane is refused loudly instead of silently switching the limiter off',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      // Found by this probe: `POINT_COST['read']` is undefined, undefined loses every
      // comparison in evaluate(), the call is allowed, and `tokens -= undefined` leaves
      // the balance NaN — after which the limiter allows everything for ever.
      let threw = false;
      try {
        s.acquire({ lane: 'read' as unknown as 'READ', adAccountId: ACT });
      } catch (e) {
        threw = true;
        assert(!isRateLimited(e), 'a bad lane is a programming error, not a rate-limit refusal');
        assert(/Unknown lane/.test(String(e)), `the error must name the problem: ${String(e)}`);
      }
      assert(threw, 'an unknown lane was accepted — the point balance is now NaN and the limiter is off');
      const snap = s.snapshot(ACT);
      assert(Number.isFinite(snap.tokens), `the point balance was poisoned: ${snap.tokens}`);
      assert(snap.tokens === POINT_CEILING.LIMITED, `the refused call still charged the bucket: ${snap.tokens}`);

      let writes = 0;
      for (let i = 0; i < 40; i += 1) {
        try {
          s.acquire({ lane: 'WRITE', adAccountId: ACT });
          writes += 1;
        } catch {
          break;
        }
      }
      assert(writes === 20, `the limiter is still off after a bad lane: ${writes} writes allowed`);
      // check() and run() must reject it too, not just acquire().
      let checkThrew = false;
      try {
        s.check({ lane: 'WRITE ' as unknown as 'WRITE', adAccountId: 'act_other' });
      } catch {
        checkThrew = true;
      }
      assert(checkThrew, 'check() still accepts an unknown lane');
      return (
        "lane 'read' is refused with a named error, the bucket is untouched, and the account still " +
        'exhausts at exactly 20 writes. Before the fix this call was ALLOWED and left tokens = NaN, ' +
        'after which 100/100 writes were permitted on an exhausted 60-point account.'
      );
    },
  },
  {
    name: 'BUC percentages are folded across business objects, so the snapshot names the real worst case',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      // Meta reports one entry per business object. Two objects, same use case: the mild
      // one is listed last, which used to overwrite the severe one in the snapshot.
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '11111111': [bucEntry('ads_management', { call_count: 96, total_cputime: 30, total_time: 40 })],
            '22222222': [bucEntry('ads_management', { call_count: 12, total_cputime: 5, total_time: 5 })],
          }),
        }),
      );
      const snap = s.snapshot(ACT);
      const gate = snap.buc.find((b) => b.useCase === 'ads_management');
      assert(gate !== undefined, 'the ads_management gate is missing');
      assert(gate.blockedForMs === 600_000, `the 96% object must trigger the 95% governor, got ${gate.blockedForMs}`);
      assert(
        gate.worstPct === 96,
        `snapshot reports ${gate.worstPct}% next to a 10-minute block; an operator would be looking ` +
          `for a cause that the dashboard says is not there`,
      );
      const v = s.check({ lane: 'WRITE', adAccountId: ACT });
      assert(/at 96%/.test(v.reason), `the refusal reason must name the bucket that actually blocked: ${v.reason}`);

      // The figure must still fall when the account recovers, not ratchet upwards for ever.
      c.advance(600_001);
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '11111111': [bucEntry('ads_management', { call_count: 7 })],
          }),
        }),
      );
      const after = s.snapshot(ACT).buc.find((b) => b.useCase === 'ads_management');
      assert(after?.worstPct === 7, `worstPct ratcheted instead of decaying: ${after?.worstPct}`);
      return 'two business objects at 96% and 12% report worstPct 96 with a 600 s block, and decay to 7% on the next clean response.';
    },
  },

  /* ------------------------------------------------------------------- gaps -------- */
  {
    name: 'GAP: x-fb-ads-insights-throttle at 100% is invisible to the read lane',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      const parsed = parseRateLimitHeaders(
        new Headers({
          'x-fb-ads-insights-throttle': JSON.stringify({
            app_id_util_pct: 100,
            acc_id_util_pct: 100,
            ads_api_access_tier: 'standard_access',
          }),
        }),
      );
      s.observe(ACT, parsed);
      const v = s.check({ lane: 'READ', adAccountId: ACT });
      assert(!v.allowed, `Meta reports the insights limiter at 100% and the scheduler still says: ${JSON.stringify(v)}`);
      assert(v.retryAfterMs > 0, 'a refusal with retryAfterMs 0 is a hot loop against a throttled endpoint');
      assert(
        /insights limiter/.test(v.reason),
        `the refusal must name the limiter that caused it, not a knock-on effect: ${v.reason}`,
      );
      // The Insights limiter is NOT the ads_insights BUC bucket, and it must not leak into
      // the lanes it does not govern: an object read and a publish both draw on
      // ads_management and are none of its business. Probed on a tier-free header, so the
      // separately-documented read stall on a Limited -> Full upgrade cannot be mistaken
      // for a leak here.
      const cIso = clock();
      const iso = new MetaScheduler({ now: cIso.now });
      iso.observe(
        ACT,
        parseRateLimitHeaders(
          new Headers({
            'x-fb-ads-insights-throttle': JSON.stringify({ app_id_util_pct: 100, acc_id_util_pct: 100 }),
          }),
        ),
      );
      assert(!iso.check({ lane: 'READ', adAccountId: ACT }).allowed, 'setup: insights reads must be refused');
      assert(
        iso.check({ lane: 'READ', adAccountId: ACT, useCase: 'ads_management' }).allowed,
        'the insights throttle blocked an object read, which draws on ads_management',
      );
      assert(iso.check({ lane: 'WRITE', adAccountId: ACT }).allowed, 'the insights throttle blocked publishing');

      // acc_id_util_pct is per account; app_id_util_pct is the whole app. A second account
      // that has never been observed must still be stood down by the app-level component.
      assert(
        !s.check({ lane: 'READ', adAccountId: 'act_9999999999' }).allowed,
        'app_id_util_pct at 100% is app-wide, but a sibling ad account was still allowed to report',
      );

      // And it recovers on the clock rather than latching.
      c.advance(v.retryAfterMs);
      assert(s.check({ lane: 'READ', adAccountId: ACT }).allowed, 'the insights gate never released');

      // 90 is the documented stop signal, and it is a stop signal on the account component
      // alone — waiting for 100 is already too late.
      const c2 = clock();
      const s2 = new MetaScheduler({ now: c2.now });
      s2.observe(
        ACT,
        parseRateLimitHeaders(
          new Headers({
            'x-fb-ads-insights-throttle': JSON.stringify({ app_id_util_pct: 4, acc_id_util_pct: 91 }),
          }),
        ),
      );
      const v2 = s2.check({ lane: 'READ', adAccountId: ACT });
      assert(!v2.allowed, 'acc_id_util_pct 91% must already be a stop signal');
      assert(
        s2.check({ lane: 'READ', adAccountId: 'act_9999999999' }).allowed,
        'an ACCOUNT-level insights throttle was wrongly applied app-wide',
      );
      return (
        `x-fb-ads-insights-throttle at 100/100 refuses the read lane for ${v.retryAfterMs} ms naming the ` +
        `insights limiter, leaves ads_management reads and writes flowing, stands a sibling account down ` +
        `on the app component, and releases on the clock. acc_id_util_pct 91 alone stops only its own ` +
        `account. Before the fix the header was not parsed at all and check() said allowed:true.`
      );
    },
  },
  {
    name: 'GAP: ads_api_access_tier in x-ad-account-usage is dropped, capping a Full-tier account at 60 points',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      // This is the header exactly as the dossier records it — the tier is in it.
      const parsed = parseRateLimitHeaders(
        new Headers({ 'x-ad-account-usage': acctHeaderJson(9.67, 100, 'standard_access') }),
      );
      assert(parsed.adAccount !== undefined, 'the ad-account usage header did not parse at all');
      s.observe(ACT, parsed);
      const snap = s.snapshot(ACT);
      assert(
        snap.fullTier && snap.capacity === POINT_CEILING.FULL,
        `a Full-tier account reporting standard_access in x-ad-account-usage is being run at ` +
          `${snap.capacity} points instead of ${POINT_CEILING.FULL} — 20 writes per 5 minutes instead of 3000. ` +
          `parseRateLimitHeaders() in src/meta/rateLimit.ts drops ads_api_access_tier from that header, so ` +
          `RateLimitState.adAccount cannot carry it and tierOf() in scheduler.ts has nothing to read.`,
      );
      // The safe-direction default must survive: an unknown string is still the low tier,
      // because guessing upwards runs a 60-point account at a 9000-point ceiling.
      const s2 = new MetaScheduler({ now: clock().now });
      s2.observe(
        ACT,
        parseRateLimitHeaders(new Headers({ 'x-ad-account-usage': acctHeaderJson(1, 100, 'full_access') })),
      );
      assert(
        s2.snapshot(ACT).capacity === POINT_CEILING.LIMITED,
        'an unrecognised tier string must land on the 60-point ceiling, not the 9000-point one',
      );
      // And the third header that carries the field is read too.
      const s3 = new MetaScheduler({ now: clock().now });
      s3.observe(
        ACT,
        parseRateLimitHeaders(
          new Headers({
            'x-fb-ads-insights-throttle': JSON.stringify({
              app_id_util_pct: 1,
              acc_id_util_pct: 1,
              ads_api_access_tier: 'standard_access',
            }),
          }),
        ),
      );
      assert(
        s3.snapshot(ACT).capacity === POINT_CEILING.FULL,
        'x-fb-ads-insights-throttle also carries ads_api_access_tier and is also dropped',
      );
      return (
        `standard_access in x-ad-account-usage now raises the ceiling to ${snap.capacity} points ` +
        `(3000 writes per window, not 20); x-fb-ads-insights-throttle is read for the tier too; an ` +
        `unknown string still lands on the 60-point Limited ceiling.`
      );
    },
  },
  {
    // NOTE (fix): this check previously asserted `parsed.buc.size > 0 || parsed.adAccount
    // !== undefined` — i.e. that x-app-usage must land in one of the two PRE-EXISTING
    // fields. That assertion could only be satisfied dishonestly: `buc` is keyed
    // `${businessObjectId}:${useCase}` and feeds the per-use-case BUC governor, and
    // `adAccount` drives the per-account POINT bucket with its 60/9000 ceiling. Filing an
    // app-wide percentage into either would make the scheduler drain the wrong bucket for
    // the wrong account. The defect the check was pointing at is real and is fixed; the
    // assertion below is the same defect stated in terms of behaviour, and is strictly
    // stronger: parsed into its own field, AND gating both lanes on EVERY account.
    name: 'GAP: x-app-usage is not parsed, so the platform-level limiter is unmodelled',
    body: () => {
      const parsed = parseRateLimitHeaders(
        new Headers({ 'x-app-usage': JSON.stringify({ call_count: 100, total_time: 100, total_cputime: 100 }) }),
      );
      assert(
        parsed.app !== undefined,
        'x-app-usage (200 calls/hour x daily active users, app-wide, throttling at 100 on any of the three ' +
          'percentages) is not parsed by src/meta/rateLimit.ts and has no representation in RateLimitState, so ' +
          'the scheduler cannot back off on it. Impact is bounded: the dossier records that BUC limits take ' +
          'precedence when both apply, and Marketing API calls on a system-user token go through BUC — but ' +
          'x-app-usage is the only rate-limit header this app currently receives (verified live against ' +
          '/me and /me/adaccounts), so today it is the only limiter signal available and it is discarded.',
      );
      assert(
        parsed.app.callCount === 100 && parsed.app.totalTime === 100 && parsed.app.totalCputime === 100,
        `all three percentages must survive parsing, got ${JSON.stringify(parsed.app)}`,
      );

      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe(ACT, parsed);
      // This limiter is a POOL, not a per-account bucket: one observation on one account
      // has to stand down every brand, or each tenant rediscovers the same exhaustion by
      // being refused by Meta while the others keep draining the pool.
      for (const acct of [ACT, 'act_other_brand', 'act_never_seen_before']) {
        for (const lane of ['READ', 'WRITE'] as const) {
          const v = s.check({ lane, adAccountId: acct });
          assert(
            !v.allowed,
            `x-app-usage at 100% is app-wide, but ${lane} on ${acct} was allowed: ${JSON.stringify(v)}`,
          );
          assert(v.retryAfterMs > 0, 'a refusal with retryAfterMs 0 is a hot loop against a throttled app');
          assert(
            /x-app-usage/.test(v.reason),
            `the refusal must name the app-wide limiter, not a per-account symptom: ${v.reason}`,
          );
        }
      }
      const held = s.check({ lane: 'WRITE', adAccountId: ACT }).retryAfterMs;
      c.advance(held);
      assert(s.check({ lane: 'WRITE', adAccountId: ACT }).allowed, 'the platform gate never released');

      // total_cputime alone is enough — you can sit at call_count 12 and total_cputime 98.
      const c2 = clock();
      const s2 = new MetaScheduler({ now: c2.now });
      s2.observe(
        ACT,
        parseRateLimitHeaders(
          new Headers({ 'x-app-usage': JSON.stringify({ call_count: 12, total_time: 9, total_cputime: 98 }) }),
        ),
      );
      const cpu = s2.check({ lane: 'WRITE', adAccountId: ACT });
      assert(!cpu.allowed, 'total_cputime 98% was ignored because call_count looked comfortable');
      assert(/total_cputime 98/.test(cpu.reason), `the reason must name the tripping percentage: ${cpu.reason}`);

      // A healthy app must not be gated at all, or the limiter is just an outage.
      const s3 = new MetaScheduler({ now: clock().now });
      s3.observe(
        ACT,
        parseRateLimitHeaders(
          new Headers({ 'x-app-usage': JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }) }),
        ),
      );
      assert(s3.check({ lane: 'WRITE', adAccountId: ACT }).allowed, 'a 28% app pool blocked publishing');
      const snap = s3.snapshot(ACT);
      assert(snap.appUsagePct === 28, `the snapshot must report the app pool for operators, got ${snap.appUsagePct}`);
      return (
        `x-app-usage parses into RateLimitState.app; at 100/100/100 both lanes are refused for ${held} ms ` +
        `on every ad account including ones never observed, the refusal names the header, and it releases ` +
        `on the clock. total_cputime 98 with call_count 12 still stops publishing; a 28% pool does not.`
      );
    },
  },
  {
    name: 'a tier upgrade stalls the read lane for ~148 s while the bucket earns the new reserve',
    body: () => {
      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.acquire({ lane: 'READ', adAccountId: ACT });
      s.observe(
        ACT,
        state({
          'x-business-use-case-usage': bucHeaderJson({
            '1234567890': [bucEntry('ads_management', { call_count: 5, ads_api_access_tier: 'standard_access' })],
          }),
          'x-ad-account-usage': acctHeaderJson(9.67, 100),
        }),
      );
      const v = s.check({ lane: 'READ', adAccountId: ACT });
      const w = s.check({ lane: 'WRITE', adAccountId: ACT });
      assert(w.allowed, 'writes must survive a tier upgrade');
      assert(!v.allowed, 'the read stall this check documents no longer reproduces — re-verify');
      near(v.retryAfterMs, 148_067, 2_000, 'read stall after the upgrade');
      // It does clear on its own, and the caller is told exactly how long to wait.
      c.advance(v.retryAfterMs);
      assert(s.check({ lane: 'READ', adAccountId: ACT }).allowed, 'reads never recovered after the upgrade');
      return (
        `on the Limited -> Full upgrade the ceiling jumps 60 -> 9000 and the read reserve jumps 30 -> 4500, ` +
        `but the bucket still holds 59 points, so reads are refused for ${v.retryAfterMs} ms while writes ` +
        `continue. Self-healing and correctly signalled, but a one-off ~2.5 min reporting stall on every ` +
        `tier promotion. Seeding tokens to the reserve line on an upgrade would remove it.`
      );
    },
  },

  /* --------------------------------------------------------------- live traffic ---- */
  {
    name: 'live: a real Meta response is parsed and fed to the scheduler without incident',
    body: async () => {
      const token = process.env['META_SYSTEM_USER_TOKEN'] ?? readEnvFile('META_SYSTEM_USER_TOKEN');
      const secret = process.env['META_APP_SECRET'] ?? readEnvFile('META_APP_SECRET');
      if (!token || !secret) {
        throw new Blocked('no META_SYSTEM_USER_TOKEN / META_APP_SECRET', 'live credentials are not present');
      }
      const proof = createHmac('sha256', secret).update(token).digest('hex');
      // READ-ONLY. GET only; this probe never writes to Meta.
      const url = `${GRAPH_BASE_URL}/me/adaccounts?fields=id,name&limit=1&appsecret_proof=${proof}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new Blocked('no outbound access to graph.facebook.com', String(e));
      }
      const bodyText = await res.text();
      if (res.status !== 200) {
        throw new Blocked(`Graph API returned HTTP ${res.status}`, bodyText.slice(0, 200));
      }
      const seen = [...res.headers.keys()].filter((k) => /usage|throttle|warning/i.test(k));
      const parsed = parseRateLimitHeaders(res.headers);

      const c = clock();
      const s = new MetaScheduler({ now: c.now });
      s.observe('act_live', parsed);
      const snap = s.snapshot('act_live');
      assert(Number.isFinite(snap.tokens), `a real response poisoned the point balance: ${snap.tokens}`);
      assert(s.check({ lane: 'READ', adAccountId: 'act_live' }).allowed, 'a healthy live response blocked the read lane');

      const accounts = JSON.parse(bodyText) as { data?: unknown[] };
      const detail =
        `GET /me/adaccounts -> 200. Rate-limit headers present: ${seen.length > 0 ? seen.join(', ') : 'none'}. ` +
        `parseRateLimitHeaders extracted ${parsed.buc.size} BUC bucket(s) and ` +
        `${parsed.adAccount ? 'an' : 'no'} ad-account usage entry; the scheduler accepted it and reports ` +
        `${snap.tokens}/${snap.capacity} points.`;
      if ((accounts.data ?? []).length === 0) {
        throw new Blocked(
          'no ad account assigned to the system user',
          detail +
            ' The account returns an empty list, so the BUC and ad-account point headers that actually ' +
            'drive the scheduler are never emitted — only x-app-usage came back. The header-driven paths ' +
            'therefore cannot be exercised against live traffic until an ad account is assigned in ' +
            'Business Settings.',
        );
      }
      return detail;
    },
  },
];

/** Minimal .env reader, so the probe runs standalone without importing the CLI config. */
function readEnvFile(key: string): string {
  try {
    const raw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== key) continue;
      return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env here; the caller treats an empty string as absent */
  }
  return '';
}

/* --------------------------------------------------------------------- runner ------ */

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
  return { module: 'src/meta/scheduler.ts', checks };
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
