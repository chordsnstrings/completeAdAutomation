import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRateLimitHeaders } from '../src/meta/rateLimit.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import {
  BudgetChangeQueue,
  CHANGE_CAPS,
  MetaScheduler,
  POINT_CEILING,
  POINT_DECAY_MS,
  RateLimited,
  capBreach,
  isRateLimited,
  type BudgetProposal,
} from '../src/meta/scheduler.ts';

/** A clock the test moves by hand. Nothing in the scheduler may sleep. */
function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function headers(init: Record<string, string>): ReturnType<typeof parseRateLimitHeaders> {
  return parseRateLimitHeaders(new Headers(init));
}

function bucHeader(entries: Array<Record<string, unknown>>, objectId = '1234'): string {
  return JSON.stringify({ [objectId]: entries });
}

const NEVER_CALLED = async (): Promise<never> => {
  throw new Error('the scheduler must not invoke the call when it is throttled');
};

/** `assert.throws` returns void, so the refusal itself has to be captured to inspect it. */
function refusal(fn: () => void): RateLimited {
  try {
    fn();
  } catch (e) {
    assert.ok(isRateLimited(e), `expected a RateLimited signal, got ${String(e)}`);
    return e;
  }
  throw new Error('expected the scheduler to refuse this call');
}

/* ------------------------------------------------------------------ point score ---- */

test('Limited tier allows exactly 20 writes per five-minute window per ad account', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });

  // 60 points / 3 points per write = 20. This, not the BUC hourly quota, is the real
  // publishing ceiling on the Limited tier.
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });

  const err = refusal(() => s.acquire({ lane: 'WRITE', adAccountId: 'act_1' }));
  assert.equal(err.scope, 'act_1/points');
  assert.match(err.message, /point score exhausted/);
  // One write costs 3 of 60 points, which is a twentieth of the 300 s decay window.
  assert.equal(err.retryAfterMs, POINT_DECAY_MS / 20);
});

test('the bucket refills linearly across the decay window, and never past capacity', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });

  clock.advance(14_999);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
  clock.advance(1);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);

  clock.advance(POINT_DECAY_MS * 10);
  assert.equal(s.snapshot('act_1').tokens, POINT_CEILING.LIMITED);
});

test('writes to different ad accounts do not share a point bucket', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_2' }).allowed, true);
});

/* --------------------------------------------------------------- header seeding ---- */

test('the bucket is seeded from the last observed header, not from static config', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });

  s.observe(
    'act_1',
    headers({ 'x-ad-account-usage': '{"acc_id_util_pct":90,"reset_time_duration":100}' }),
  );
  // 90% used leaves 6 of 60 points: two writes, not twenty.
  assert.equal(s.snapshot('act_1').tokens, 6);
  s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
});

test('observe is pessimistic-only: a rosy header never hands back points we just spent', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });

  // Meta's snapshot predates our burst; trusting it would let us double-spend the window.
  s.observe('act_1', headers({ 'x-ad-account-usage': '{"acc_id_util_pct":0}' }));
  assert.equal(s.snapshot('act_1').tokens, 0);
});

test('a point score at 100% blocks the account for at least the tier block time', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({ 'x-ad-account-usage': '{"acc_id_util_pct":100,"reset_time_duration":100}' }),
  );

  const verdict = s.check({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(verdict.allowed, false);
  // reset_time_duration is 100 SECONDS; the 300 s Limited-tier block is the floor.
  assert.equal(verdict.retryAfterMs, 300_000);
  assert.match(verdict.reason, /point score exhausted at 100%/);

  // A cut-off account earns nothing back while it is blocked.
  clock.advance(299_999);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
  clock.advance(1);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false, 'blocked, then empty');
  clock.advance(POINT_DECAY_MS);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
});

test('the Full tier is read off the header and raises the ceiling to 9000', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 1, ads_api_access_tier: 'standard_access' },
      ]),
    }),
  );
  const snap = s.snapshot('act_1');
  assert.equal(snap.fullTier, true);
  assert.equal(snap.capacity, POINT_CEILING.FULL);
});

test('an unrecognised access tier is treated as the low tier', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // Meta renamed the dashboard labels in May 2026; whether the header strings changed is
  // UNVERIFIED, so anything unknown must land on the 60-point ceiling.
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 1, ads_api_access_tier: 'full_access' },
      ]),
    }),
  );
  assert.equal(s.snapshot('act_1').capacity, POINT_CEILING.LIMITED);
});

/* ------------------------------------------------------------------ BUC governor ---- */

test('the BUC governor backs off at 85% and harder at 95%', () => {
  const clock = fakeClock();
  const warn = new MetaScheduler({ now: clock.now });
  warn.observe(
    'act_1',
    headers({ 'x-business-use-case-usage': bucHeader([{ type: 'ads_insights', call_count: 86 }]) }),
  );
  assert.equal(warn.check({ lane: 'READ', adAccountId: 'act_1' }).retryAfterMs, 120_000);

  const crit = new MetaScheduler({ now: clock.now });
  crit.observe(
    'act_1',
    headers({ 'x-business-use-case-usage': bucHeader([{ type: 'ads_insights', total_cputime: 96 }]) }),
  );
  const v = crit.check({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(v.retryAfterMs, 600_000);
  // total_cputime is the field that bites on breakdown-heavy insights queries, so the
  // reason must name which of the three percentages actually tripped.
  assert.match(v.reason, /total_cputime 96/);
});

test('estimated_time_to_regain_access is MINUTES and is converted, not used raw', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 30 },
      ]),
    }),
  );
  // 30 minutes = 1,800,000 ms. Treating it as ms would retry 30 ms later, in a hot loop
  // against a throttled endpoint; treating minutes as seconds would sleep 30 s.
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).retryAfterMs, 1_800_000);
});

test('a cut-off reported below the governor thresholds is still honoured', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 3, estimated_time_to_regain_access: 5 },
      ]),
    }),
  );
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).retryAfterMs, 300_000);
});

test('BUC buckets are per use case: an insights storm cannot block publishing', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_insights', call_count: 99 },
        { type: 'ads_management', call_count: 4 },
      ]),
    }),
  );
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_1' }).allowed, false);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
  // An object read draws on ads_management, not ads_insights — the caller must say so.
  assert.equal(
    s.check({ lane: 'READ', adAccountId: 'act_1', useCase: 'ads_management' }).allowed,
    true,
  );
});

/* ------------------------------------------------------------------------ lanes ---- */

test('the write reserve stops a reporting storm from starving publishing', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });

  // The point score does NOT separate reads from writes, so the reserve is ours to keep.
  for (let i = 0; i < 30; i += 1) s.acquire({ lane: 'READ', adAccountId: 'act_1' });

  assert.match(refusal(() => s.acquire({ lane: 'READ', adAccountId: 'act_1' })).message, /write reserve/);

  // Publishing still has its full reserved slice: ten writes.
  for (let i = 0; i < 10; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
});

test('a zero reserve is allowed; a full reserve is refused at construction', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now, writeReserveFraction: 0 });
  for (let i = 0; i < 60; i += 1) s.acquire({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_1' }).allowed, false);
  assert.throws(() => new MetaScheduler({ now: clock.now, writeReserveFraction: 1 }), /never run/);
});

test('writes are serialised per ad account and parallel across accounts', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  const order: string[] = [];
  let releaseA: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    releaseA = r;
  });

  const a = s.run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
    order.push('a-start');
    await blocked;
    order.push('a-end');
  });
  const b = s.run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
    order.push('b-start');
  });
  const c = s.run({ lane: 'WRITE', adAccountId: 'act_2' }, async () => {
    order.push('c-start');
  });

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['a-start', 'c-start'], 'act_2 must not wait behind act_1');
  releaseA();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['a-start', 'c-start', 'a-end', 'b-start']);
  assert.equal(s.snapshot('act_1').inFlightWrites, 0);
});

test('a failed write releases the per-account write lock', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  await assert.rejects(
    s.run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  await s.run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => 'ok');
  assert.equal(s.snapshot('act_1').inFlightWrites, 0);
});

/* --------------------------------------------------------- reacting to rejections ---- */

test('run() refuses to call out when the limiter is already blocked', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({ 'x-business-use-case-usage': bucHeader([{ type: 'ads_management', call_count: 99 }]) }),
  );
  await assert.rejects(s.run({ lane: 'WRITE', adAccountId: 'act_1' }, NEVER_CALLED), RateLimited);
});

test('an account throttle from Meta drains the bucket and surfaces a retry interval', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  const thrown = new MetaApiError(
    { message: 'User request limit reached', code: 80004, error_subcode: 2446079 },
    400,
  );

  const err = await s
    .run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
      throw thrown;
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );

  assert.ok(isRateLimited(err), 'a throttle must arrive as a RateLimited signal, not a raw error');
  assert.equal(err.retryAfterMs, 300_000);
  assert.match(err.message, /Meta 80004\/2446079/);
  assert.equal(err.cause, thrown, 'the original error must survive for the audit trail');
  assert.equal(s.snapshot('act_1').tokens, 0, 'our local estimate was optimistic; drain it');
});

test('a per-ad-set budget cap breach must NOT stall the whole ad account', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // errors.ts classifies 613/1487632 as THROTTLED, and it is — but it is a per-ad-set
  // policy cap. Draining the account bucket would stop every publish on the account
  // because one ad set changed its budget four times.
  const thrown = new MetaApiError(
    { message: 'You can only change your ad set budget 4 times per hour.', code: 613, error_subcode: 1487632 },
    400,
  );
  await assert.rejects(
    s.run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
      throw thrown;
    }),
    MetaApiError,
  );
  assert.equal(s.snapshot('act_1').tokens, POINT_CEILING.LIMITED - 3, 'only the call itself is charged');
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
});

test('headers are observed after a failure, because Meta sets them on throttled responses', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  const state = headers({ 'x-ad-account-usage': '{"acc_id_util_pct":95}' });

  await assert.rejects(
    s.run({ lane: 'WRITE', adAccountId: 'act_1', headers: () => state }, async () => {
      throw new Error('network reset');
    }),
    /network reset/,
  );
  assert.equal(s.snapshot('act_1').tokens, 3);
});

/* ---------------------------------------------------------------- budget queue ---- */

const PROPOSAL: BudgetProposal = {
  kind: 'ADSET_BUDGET',
  adAccountId: 'act_1',
  targetId: 'adset_1',
  valueMinorUnits: 5000,
  value: 10,
  reason: 'CPA below target',
};

test('the queue keeps the highest-value proposal per target, not the oldest', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });

  assert.equal(q.propose(PROPOSAL).status, 'QUEUED');
  clock.advance(60_000);

  const better = q.propose({ ...PROPOSAL, value: 25, valueMinorUnits: 8000 });
  assert.equal(better.status, 'SUPERSEDED');
  assert.equal(q.stats().pending, 1);

  const worse = q.propose({ ...PROPOSAL, value: 5, valueMinorUnits: 2000 });
  assert.equal(worse.status, 'DISCARDED');
  assert.match(worse.status === 'DISCARDED' ? worse.reason : '', /worth more/);

  const lease = q.take();
  assert.ok(lease);
  assert.equal(lease.valueMinorUnits, 8000, 'the superseded proposal was worthless');
  assert.equal(lease.supersededCount, 1);
});

test('an equal-value proposal wins, because its inputs are fresher', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });
  q.propose(PROPOSAL);
  clock.advance(60_000);
  const tie = q.propose({ ...PROPOSAL, valueMinorUnits: 7777 });
  assert.equal(tie.status, 'SUPERSEDED');
  assert.equal(q.take()?.valueMinorUnits, 7777);
});

test('take() returns the best eligible change across targets, skipping capped ones', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });

  for (let i = 0; i < CHANGE_CAPS.ADSET_BUDGET.max; i += 1) {
    q.propose({ ...PROPOSAL, targetId: 'adset_hot', value: 100 + i });
    const lease = q.take();
    assert.ok(lease);
    q.settle(lease.leaseId, 'APPLIED');
    clock.advance(1000);
  }

  q.propose({ ...PROPOSAL, targetId: 'adset_hot', value: 999 });
  q.propose({ ...PROPOSAL, targetId: 'adset_cold', value: 3 });

  const next = q.take();
  assert.equal(next?.targetId, 'adset_cold', 'the capped target is skipped despite the higher value');
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_hot'), 0);
});

test('ad-set budget changes are capped at 4 per rolling hour', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now, staleAfterMs: Infinity });

  for (let i = 0; i < 4; i += 1) {
    q.propose({ ...PROPOSAL, value: i });
    const lease = q.take();
    assert.ok(lease, `change ${i + 1} of 4 must be allowed`);
    q.settle(lease.leaseId, 'APPLIED');
    clock.advance(600_000);
  }
  q.propose({ ...PROPOSAL, value: 50 });
  assert.equal(q.take(), undefined, 'the fifth change inside the hour must wait');

  const eligibleAt = q.nextEligibleAt('ADSET_BUDGET', 'adset_1');
  assert.equal(eligibleAt, clock.now() + 3_600_000 - 4 * 600_000);
  clock.advance(eligibleAt - clock.now());
  assert.equal(q.take()?.value, 50, 'the best pending change takes the freed slot');
});

test('account spend-limit changes are capped at 10 per day, on their own window', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now, staleAfterMs: Infinity });
  const spend: BudgetProposal = {
    kind: 'ACCOUNT_SPEND_LIMIT',
    adAccountId: 'act_1',
    targetId: 'act_1',
    valueMinorUnits: 100_000,
    value: 1,
    reason: 'raise the account ceiling',
  };

  for (let i = 0; i < CHANGE_CAPS.ACCOUNT_SPEND_LIMIT.max; i += 1) {
    q.propose({ ...spend, value: i });
    const lease = q.take();
    assert.ok(lease, `spend-limit change ${i + 1} must be allowed`);
    q.settle(lease.leaseId, 'APPLIED');
    clock.advance(60_000);
  }
  q.propose({ ...spend, value: 99 });
  assert.equal(q.take(), undefined);

  // The ad-set hour window must not be confused with the account day window.
  clock.advance(3_600_000);
  assert.equal(q.take(), undefined, 'an hour is not enough for the 24 h spend-limit window');
  clock.advance(86_400_000);
  assert.ok(q.take());
});

test('a slot is consumed at take(), and only a proven non-send returns it', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });

  q.propose(PROPOSAL);
  const a = q.take();
  assert.ok(a);
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 3);

  // The caller knows the request never left the process.
  q.settle(a.leaseId, 'NOT_SENT');
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 4);

  q.propose(PROPOSAL);
  const b = q.take();
  assert.ok(b);
  // Ambiguous: the write may have landed. Refuse to guess — there are no idempotency keys.
  q.settle(b.leaseId, 'UNKNOWN');
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 3);
  assert.throws(() => q.settle(b.leaseId, 'APPLIED'), /Unknown budget-change lease/);
});

test('an unsettled lease keeps its slot, which is the safe direction', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });
  q.propose(PROPOSAL);
  assert.ok(q.take());
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 3);
  assert.equal(q.stats().leased, 1);
});

test('a cap rejection from Meta stands the target down for a full window', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now, staleAfterMs: Infinity });

  // Our window said there was headroom, so another actor edited this ad set.
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 4);
  const waitMs = q.recordCapRejection('ADSET_BUDGET', 'adset_1');
  assert.equal(waitMs, 3_600_000);
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 0);

  q.propose(PROPOSAL);
  assert.equal(q.take(), undefined);
  clock.advance(waitMs);
  assert.ok(q.take());
});

test('capBreach names the cap and branches on both error families', () => {
  assert.equal(
    capBreach(new MetaApiError({ message: 'x', code: 613, error_subcode: 1487632 }, 400)),
    'ADSET_BUDGET',
  );
  assert.equal(
    capBreach(new MetaApiError({ message: 'x', code: 17, error_subcode: 1885172 }, 400)),
    'ACCOUNT_SPEND_LIMIT',
  );
  // 613/1487742 is "too many calls from this ad account" — a throttle, not a budget cap.
  assert.equal(capBreach(new MetaApiError({ message: 'x', code: 613, error_subcode: 1487742 }, 400)), undefined);
  assert.equal(capBreach(new MetaApiError({ message: 'x', code: 17 }, 400)), undefined);
});

test('the high-water mark records what a budget write actually exposed', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now, staleAfterMs: Infinity });

  q.propose({ ...PROPOSAL, valueMinorUnits: 40_000, value: 9 });
  const up = q.take();
  assert.ok(up);
  assert.equal(up.todayHighWaterMinorUnits, undefined);
  q.settle(up.leaseId, 'APPLIED');

  clock.advance(3_600_000);
  q.propose({ ...PROPOSAL, valueMinorUnits: 10_000, value: 9 });
  const down = q.take();
  assert.ok(down);
  // Rolling back the budget does not undo the day's exposure: Meta's 175% ceiling anchors
  // to the highest budget set that day.
  assert.equal(down.todayHighWaterMinorUnits, 40_000);
  q.settle(down.leaseId, 'APPLIED');

  clock.advance(86_400_001);
  assert.equal(q.highWaterMark('adset_1'), undefined);
});

test('stale proposals are dropped loudly rather than acted on with old numbers', () => {
  const clock = fakeClock();
  const dropped: string[] = [];
  const q = new BudgetChangeQueue({
    now: clock.now,
    onDropped: (c, why) => dropped.push(`${why}:${c.targetId}`),
  });

  q.propose(PROPOSAL);
  clock.advance(CHANGE_CAPS.ADSET_BUDGET.windowMs);
  assert.equal(q.take(), undefined);
  assert.deepEqual(dropped, ['STALE:adset_1']);
  assert.equal(q.stats().droppedStale, 1);
});

test('takeAll drains one eligible change per target, best first', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });
  q.propose({ ...PROPOSAL, targetId: 'a', value: 1 });
  q.propose({ ...PROPOSAL, targetId: 'b', value: 7 });
  q.propose({ ...PROPOSAL, targetId: 'c', value: 4 });

  assert.deepEqual(
    q.takeAll().map((l) => l.targetId),
    ['b', 'c', 'a'],
  );
  assert.equal(q.stats().pending, 0);
});

test('peek does not consume, and orders by value', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });
  q.propose({ ...PROPOSAL, targetId: 'a', value: 1 });
  q.propose({ ...PROPOSAL, targetId: 'b', value: 7 });
  assert.deepEqual(
    q.peek().map((p) => p.targetId),
    ['b', 'a'],
  );
  assert.equal(q.stats().pending, 2);
});

/* ------------------------------------------------- regressions found in review ---- */

test('a response with no tier field must not downgrade a Full-tier account', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 1, ads_api_access_tier: 'standard_access' },
      ]),
    }),
  );
  assert.equal(s.snapshot('act_1').capacity, POINT_CEILING.FULL);

  // Three headers CAN carry `ads_api_access_tier`, but this response carries it in none
  // of them, so it says NOTHING about the tier. Reading silence as "Limited"
  // clamps a 9000-point bucket to 60 and then makes the read reserve unreachable for
  // minutes — a stall invented out of a missing header.
  s.observe('act_1', headers({ 'x-ad-account-usage': '{"acc_id_util_pct":10}' }));
  const snap = s.snapshot('act_1');
  assert.equal(snap.fullTier, true);
  assert.equal(snap.capacity, POINT_CEILING.FULL);
});

test('a reserve that no full bucket could satisfy fails loudly instead of looping', () => {
  const clock = fakeClock();
  // 0.99 of 60 points reserves 59.4, leaving 0.6 — less than the 1 point a read costs.
  // Refusing with a retry interval would send a durable workflow to sleep for ever.
  const s = new MetaScheduler({ now: clock.now, writeReserveFraction: 0.99 });
  assert.throws(
    () => s.check({ lane: 'READ', adAccountId: 'act_1' }),
    (e: unknown) => e instanceof Error && !isRateLimited(e) && /Lower writeReserveFraction/.test(e.message),
  );
  // Writes are unaffected: the reserve exists for them.
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
});

test('a throwing headers thunk must not replace the error the caller needs to see', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  const boom = new MetaApiError({ message: 'Invalid parameter', code: 100 }, 400);
  await assert.rejects(
    s.run(
      {
        lane: 'WRITE',
        adAccountId: 'act_1',
        headers: () => {
          throw new TypeError('rateLimits map is not what you think');
        },
      },
      async () => {
        throw boom;
      },
    ),
    (e: unknown) => e === boom,
  );
});

test('a throwing onThrottle hook must not turn a refusal into an unknown failure', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({
    now: clock.now,
    onThrottle: () => {
      throw new Error('metrics backend down');
    },
  });
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  // A caller that saw 'metrics backend down' would classify a rate limit as unknown, and
  // an unknown outcome on a write is the one thing this system must never guess at.
  assert.equal(refusal(() => s.acquire({ lane: 'WRITE', adAccountId: 'act_1' })).retryAfterMs, 15_000);
});

test('attempted distinguishes a pre-flight refusal from a throttle Meta itself returned', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  for (let i = 0; i < 20; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_2' });
  assert.equal(refusal(() => s.acquire({ lane: 'WRITE', adAccountId: 'act_2' })).attempted, false);

  const err = await s
    .run({ lane: 'WRITE', adAccountId: 'act_1' }, async () => {
      throw new MetaApiError({ message: 'limit reached', code: 80004 }, 400);
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  assert.ok(isRateLimited(err));
  assert.equal(err.attempted, true, 'this call did reach Meta and must be recorded as attempted');
});

test('a throttle on the read lane must not eat the write reserve', async () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // 80000 is the ads_insights BUC throttle. Reads and writes share one point bucket, so
  // draining it outright would let a reporting storm delay publishing — precisely what
  // the reserve exists to stop.
  await assert.rejects(
    s.run({ lane: 'READ', adAccountId: 'act_1' }, async () => {
      throw new MetaApiError({ message: 'insights throttled', code: 80000, error_subcode: 2446079 }, 400);
    }),
    RateLimited,
  );
  assert.equal(s.snapshot('act_1').tokens, POINT_CEILING.LIMITED * 0.5);
  for (let i = 0; i < 10; i += 1) s.acquire({ lane: 'WRITE', adAccountId: 'act_1' });
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
});

test('a cap rejection cancels the refund an open lease would otherwise claim', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now, staleAfterMs: Infinity });
  q.propose(PROPOSAL);
  const lease = q.take();
  assert.ok(lease);

  // Meta says the window is full — another actor edited this ad set. The open lease's
  // slot is already absorbed by that saturation; refunding it would hand back a slot we
  // have just been told does not exist, and the next take() would write into a rejection.
  q.recordCapRejection('ADSET_BUDGET', 'adset_1');
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 0);
  q.settle(lease.leaseId, 'NOT_SENT');
  assert.equal(q.remaining('ADSET_BUDGET', 'adset_1'), 0);

  q.propose(PROPOSAL);
  assert.equal(q.take(), undefined);
});

test('the queue refuses a budget it could not honestly write', () => {
  const clock = fakeClock();
  const q = new BudgetChangeQueue({ now: clock.now });
  // NaN loses no comparison, so it would never be superseded and would eventually be
  // POSTed as daily_budget=NaN.
  assert.throws(() => q.propose({ ...PROPOSAL, value: Number.NaN }), /finite priority/);
  assert.throws(() => q.propose({ ...PROPOSAL, valueMinorUnits: Number.NaN }), /minor units/);
  assert.throws(() => q.propose({ ...PROPOSAL, valueMinorUnits: 12.5 }), /minor units/);
  assert.throws(() => q.propose({ ...PROPOSAL, valueMinorUnits: -5000 }), /minor units/);
  assert.throws(() => q.propose({ ...PROPOSAL, targetId: '' }), /targetId is required/);
  assert.equal(q.stats().pending, 0, 'nothing invalid may reach the queue');
});

/* ------------------------------------------------- the three unmodelled limiters ---- */

test('the Insights limiter gates the read lane, and it is not the ads_insights BUC bucket', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // `x-fb-ads-insights-throttle` is a SECOND gate on insights calls. At 100% Meta is
  // already refusing them while the BUC percentages still read comfortable, so a
  // scheduler that watches only BUC dials out into a closed door.
  s.observe(
    'act_1',
    headers({
      'x-fb-ads-insights-throttle': '{"app_id_util_pct":2,"acc_id_util_pct":100}',
      'x-business-use-case-usage': bucHeader([{ type: 'ads_insights', call_count: 3, total_cputime: 2 }]),
    }),
  );

  const v = s.check({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(v.allowed, false, 'the insights limiter at 100% must stop reporting');
  assert.equal(v.scope, 'act_1/insights');
  assert.equal(v.retryAfterMs, 600_000);
  assert.match(v.reason, /acc_id_util_pct 100%/);

  // It governs insights traffic only: publishing and object reads draw on ads_management.
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_1', useCase: 'ads_management' }).allowed, true);

  // acc_id_util_pct is per account.
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_2' }).allowed, true);

  clock.advance(599_999);
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_1' }).allowed, false, 'released 1 ms early');
  clock.advance(1);
  assert.equal(s.check({ lane: 'READ', adAccountId: 'act_1' }).allowed, true, 'never released');
});

test('90% is the insights stop signal, and a rosy reading does not release the stand-off early', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // The dossier is explicit that waiting for 100 is too late: throttling is in effect
  // before Meta reports it.
  s.observe('act_1', headers({ 'x-fb-ads-insights-throttle': '{"app_id_util_pct":0,"acc_id_util_pct":90}' }));
  const v = s.check({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(v.allowed, false);
  assert.equal(v.retryAfterMs, 120_000);

  clock.advance(30_000);
  s.observe('act_1', headers({ 'x-fb-ads-insights-throttle': '{"app_id_util_pct":0,"acc_id_util_pct":1}' }));
  const after = s.check({ lane: 'READ', adAccountId: 'act_1' });
  assert.equal(after.allowed, false, 'a rosy header released the insights governor early');
  assert.equal(after.retryAfterMs, 90_000);
  // The reported percentage still tracks reality, so the dashboard is not frozen at 90.
  assert.equal(s.snapshot('act_1').insightsPct, 1);

  // 89 is under the threshold and must not stand anyone down.
  const s2 = new MetaScheduler({ now: fakeClock().now });
  s2.observe('act_1', headers({ 'x-fb-ads-insights-throttle': '{"app_id_util_pct":89,"acc_id_util_pct":89}' }));
  assert.equal(s2.check({ lane: 'READ', adAccountId: 'act_1' }).allowed, true);
});

test('app_id_util_pct is app-wide: one account observing it stands every account down', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe('act_1', headers({ 'x-fb-ads-insights-throttle': '{"app_id_util_pct":100,"acc_id_util_pct":3}' }));

  // act_2 has never been seen. Holding this pool per account would make every brand
  // rediscover the exhaustion by being refused by Meta, one response at a time.
  const v = s.check({ lane: 'READ', adAccountId: 'act_2' });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /app_id_util_pct 100% app-wide/);
  assert.equal(s.snapshot('act_2').insightsAppBlockedForMs, 600_000);
  // Still only insights traffic, though: it is the Insights limiter, not the platform one.
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_2' }).allowed, true);
});

test('ads_api_access_tier is read from x-ad-account-usage, not just from the BUC header', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  // The dossier records the field in all three headers. Reading only the BUC one caps a
  // Full-tier account at 60 points — 20 writes per five minutes instead of 3000.
  s.observe(
    'act_1',
    headers({ 'x-ad-account-usage': '{"acc_id_util_pct":9.67,"reset_time_duration":100,"ads_api_access_tier":"standard_access"}' }),
  );
  const snap = s.snapshot('act_1');
  assert.equal(snap.fullTier, true);
  assert.equal(snap.capacity, POINT_CEILING.FULL);
  // The Full-tier block floor is 60 s, not 300 s, and it follows the tier.
  const s2 = new MetaScheduler({ now: fakeClock().now });
  s2.observe(
    'act_1',
    headers({ 'x-ad-account-usage': '{"acc_id_util_pct":100,"ads_api_access_tier":"standard_access"}' }),
  );
  assert.equal(s2.check({ lane: 'WRITE', adAccountId: 'act_1' }).retryAfterMs, 60_000);
});

test('an unknown tier string in x-ad-account-usage still lands on the low tier', () => {
  const s = new MetaScheduler({ now: fakeClock().now });
  // Whether the May 2026 rename changed the header strings is UNVERIFIED, and a wrong
  // guess UPWARDS runs a 60-point account at a 9000-point ceiling.
  s.observe('act_1', headers({ 'x-ad-account-usage': '{"acc_id_util_pct":1,"ads_api_access_tier":"full_access"}' }));
  assert.equal(s.snapshot('act_1').capacity, POINT_CEILING.LIMITED);
  assert.equal(s.snapshot('act_1').fullTier, false);
});

test('a Limited reading in one header is not overruled by a stale Full reading in another', () => {
  const s = new MetaScheduler({ now: fakeClock().now });
  // Both headers on one response disagreeing is not something Meta is documented to do,
  // but the safe direction is fixed: the low tier only ever comes from the absence of
  // `standard_access`, so a single Full claim wins and a single Limited claim does not
  // downgrade a response that also claims Full. What must NOT happen is silence being
  // read as Limited — that flaps the ceiling between 9000 and 60 on no evidence.
  s.observe(
    'act_1',
    headers({
      'x-business-use-case-usage': bucHeader([
        { type: 'ads_management', call_count: 1, ads_api_access_tier: 'development_access' },
      ]),
      'x-ad-account-usage': '{"acc_id_util_pct":1,"ads_api_access_tier":"standard_access"}',
    }),
  );
  assert.equal(s.snapshot('act_1').capacity, POINT_CEILING.FULL);
});

test('x-app-usage stands every account and both lanes down, because the pool is app-wide', () => {
  const clock = fakeClock();
  const s = new MetaScheduler({ now: clock.now });
  s.observe('act_1', headers({ 'x-app-usage': '{"call_count":100,"total_time":100,"total_cputime":100}' }));

  for (const adAccountId of ['act_1', 'act_2']) {
    for (const lane of ['READ', 'WRITE'] as const) {
      const v = s.check({ lane, adAccountId });
      assert.equal(v.allowed, false, `${lane} on ${adAccountId} survived an exhausted app pool`);
      assert.equal(v.scope, 'app/platform');
      assert.equal(v.retryAfterMs, 600_000);
      assert.match(v.reason, /x-app-usage/);
    }
  }
  assert.equal(s.snapshot('act_2').appBlockedForMs, 600_000);

  clock.advance(600_000);
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true, 'the platform gate never released');
});

test('x-app-usage trips on total_cputime alone, and leaves a healthy pool alone', () => {
  const s = new MetaScheduler({ now: fakeClock().now });
  // You can sit at call_count 12 and total_cputime 98 on an Insights-heavy workload.
  s.observe('act_1', headers({ 'x-app-usage': '{"call_count":12,"total_time":9,"total_cputime":98}' }));
  const v = s.check({ lane: 'WRITE', adAccountId: 'act_1' });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /total_cputime 98/);

  const s2 = new MetaScheduler({ now: fakeClock().now });
  s2.observe('act_1', headers({ 'x-app-usage': '{"call_count":28,"total_time":25,"total_cputime":25}' }));
  assert.equal(s2.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, true);
  assert.equal(s2.snapshot('act_1').appUsagePct, 28);
});

test('a malformed or absent limiter header is ignored rather than trusted as zero', () => {
  const s = new MetaScheduler({ now: fakeClock().now });
  // A blocked app pool must not be released by the next response failing to mention it.
  s.observe('act_1', headers({ 'x-app-usage': '{"call_count":100,"total_time":100,"total_cputime":100}' }));
  s.observe('act_1', headers({ 'x-app-usage': 'not json at all' }));
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);
  s.observe('act_1', headers({ 'x-business-use-case-usage': bucHeader([{ type: 'ads_management' }]) }));
  assert.equal(s.check({ lane: 'WRITE', adAccountId: 'act_1' }).allowed, false);

  const parsed = parseRateLimitHeaders(new Headers({ 'x-app-usage': '[1,2,3]', 'x-fb-ads-insights-throttle': '' }));
  assert.equal(parsed.app, undefined);
  assert.equal(parsed.insights, undefined);
});
