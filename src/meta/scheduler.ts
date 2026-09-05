/**
 * Rate-limit-aware scheduler and budget-change queue.
 *
 * `rateLimit.ts` PARSES Meta's headers. This module ACTS on them: it decides whether a
 * call may go out now, and if not, for how long the caller must wait.
 *
 * Two things shape every decision here.
 *
 *  1. **Meta runs two independent limiters and either can stop you.** The BUC buckets are
 *     per (business object, use case) and reported as three percentages; the ad-account
 *     point score is per ad account and costs 1 for a read and 3 for a write against a
 *     ceiling of 60 on the Limited tier. Sixty points over a 300 s decay window is
 *     **twenty writes per five minutes per ad account** — four a minute. That number, not
 *     the BUC hourly quota, is what actually throttles publishing.
 *
 *  2. **Nothing in here sleeps.** Every refusal is a thrown `RateLimited` carrying
 *     `retryAfterMs`. A durable workflow can then sleep on a timer that survives a process
 *     restart instead of parking a thread inside an HTTP call. The clock is injected so
 *     the whole module is deterministic under test.
 *
 * Wiring, for the avoidance of doubt:
 *
 * ```ts
 * const sched = new MetaScheduler({ now: Date.now });
 * const res = await sched.run(
 *   { lane: 'WRITE', adAccountId, headers: () => client.rateLimits.get(adAccountId) },
 *   () => client.post(path, params, { adAccountId }),
 * );
 * ```
 *
 * The `headers` thunk is pulled after every attempt, success or failure, because
 * `MetaClient.send` records the response headers before it throws — a throttled response
 * is the single most informative header set you will ever get.
 */

import { MetaApiError } from './errors.ts';
import { isFullTier, shouldCircuitBreak, type RateLimitState } from './rateLimit.ts';

/** Epoch milliseconds. Injected so tests are deterministic and never sleep. */
export type Clock = () => number;

/**
 * `estimated_time_to_regain_access` is in MINUTES; `reset_time_duration` is in SECONDS;
 * every other number in those headers is a percent. Mixing the units gives you either a
 * 100x too-long sleep or a hot loop against a throttled endpoint.
 *
 * NOTE: `BucUsage.estimatedTimeToRegainAccess` in `rateLimit.ts` is documented as
 * milliseconds but is in fact the raw header value, i.e. minutes. That file is owned by
 * another module, so the conversion is done here rather than there.
 */
const ETA_MINUTES_TO_MS = 60_000;

/** Sanity clamp on a malformed header. The BUC window is one hour, so a day is absurd. */
const MAX_BACKOFF_MS = 24 * 60 * 60_000;

/** Read = 1 point, write = 3. `[OFFICIAL]` Marketing API rate-limiting page. */
export const POINT_COST = { READ: 1, WRITE: 3 } as const;

/** Point-score ceiling by access tier. Limited = 60, Full = 9000. */
export const POINT_CEILING = { LIMITED: 60, FULL: 9000 } as const;

/** The score decays over 300 s on both tiers. */
export const POINT_DECAY_MS = 300_000;

/** How long Meta blocks you once the score is exhausted: 300 s Limited, 60 s Full. */
export const POINT_BLOCK_MS = { LIMITED: 300_000, FULL: 60_000 } as const;

/**
 * Governor thresholds copied verbatim from Airbyte's production Meta connector: back off
 * at usage >= 85 for max(2 min, cut-off) and at usage >= 95 for max(10 min, cut-off),
 * where usage is the worst of the three BUC percentages.
 */
const GOVERNOR = {
  WARN_PCT: 85,
  WARN_MS: 120_000,
  CRIT_PCT: 95,
  CRIT_MS: 600_000,
} as const;

/**
 * The complete `type` enum for `x-business-use-case-usage`. Unknown values are still
 * tracked — Meta may add buckets — but callers should name one of these.
 */
export type BucUseCase =
  | 'ads_management'
  | 'ads_insights'
  | 'custom_audience'
  | 'instagram'
  | 'leadgen'
  | 'messenger'
  | 'pages';

/**
 * Reads and writes are separate fleets. They are separate for two different reasons and
 * both matter:
 *
 *  - At the BUC layer Meta already separates them (`ads_insights` vs `ads_management`),
 *    so an insights bucket at 96% cannot block publishing.
 *  - At the point-score layer Meta does NOT separate them — a reporting storm and a
 *    publish run draw on one 60-point bucket. So the write lane gets a reserved slice
 *    that reads may never consume. That reservation is the entire anti-starvation
 *    guarantee; without it a nightly backfill silently stops the money-making path.
 */
export type Lane = 'READ' | 'WRITE';

/**
 * A refusal, not a failure. The caller — ideally a durable workflow — waits
 * `retryAfterMs` and re-attempts.
 *
 * It is raised from two places and the caller must be able to tell them apart, which is
 * what `attempted` is for. A pre-flight refusal means no request left this process. A
 * post-response throttle means Meta itself rejected the call: still safe to re-attempt
 * (a throttle is a refusal at Meta's gate, so no write landed), but the call was counted
 * against the quota and the attempt belongs in the audit trail.
 */
export class RateLimited extends Error {
  readonly retryAfterMs: number;
  /** e.g. `act_123/ads_insights` or `act_123/points`. Names the limiter, not the call. */
  readonly scope: string;
  readonly detail: string;
  /** True when the request reached Meta and Meta answered with a throttle. */
  readonly attempted: boolean;

  constructor(
    scope: string,
    retryAfterMs: number,
    detail: string,
    options?: ErrorOptions & { attempted?: boolean },
  ) {
    const ms = Math.max(0, Math.ceil(retryAfterMs));
    super(`Rate limited on ${scope}: ${detail}. Retry after ${ms}ms (${Math.ceil(ms / 1000)}s).`, options);
    this.name = 'RateLimited';
    this.retryAfterMs = ms;
    this.scope = scope;
    this.detail = detail;
    this.attempted = options?.attempted ?? false;
  }
}

export function isRateLimited(e: unknown): e is RateLimited {
  return e instanceof RateLimited;
}

export interface LaneRequest {
  lane: Lane;
  adAccountId: string;
  /**
   * Which BUC bucket this call draws on. Defaults to `ads_management` for writes and
   * `ads_insights` for reads — but a GET of campaigns/ad sets/ads is an `ads_management`
   * read, so pass it explicitly for object reads or the wrong bucket is consulted.
   */
  useCase?: BucUseCase;
}

export interface RunRequest extends LaneRequest {
  /**
   * Pulled after every attempt, success or failure. Meta records the rate-limit headers
   * on throttled responses too, and those are the ones worth having.
   */
  headers?: () => RateLimitState | undefined;
}

export interface LaneVerdict {
  allowed: boolean;
  retryAfterMs: number;
  reason: string;
  scope: string;
}

export interface AccountSnapshot {
  tokens: number;
  capacity: number;
  fullTier: boolean;
  pointsBlockedForMs: number;
  inFlightWrites: number;
  buc: Array<{ useCase: string; worstPct: number; blockedForMs: number }>;
  /** Coarse cross-bucket breaker from `rateLimit.ts`, kept for observability only. */
  breakerReason: string | undefined;
}

export interface SchedulerOptions {
  now: Clock;
  /**
   * Fraction of the ad-account point budget that reads may never touch, so that a
   * reporting storm cannot starve publishing. 0.5 of a 60-point bucket leaves the write
   * lane ten writes of guaranteed headroom at all times.
   */
  writeReserveFraction?: number;
  /** Observability hook. Called on every refusal; must not throw. */
  onThrottle?: (r: RateLimited) => void;
}

interface BucGate {
  worstPct: number;
  blockedUntil: number;
  detail: string;
}

interface AccountState {
  tokens: number;
  capacity: number;
  lastRefill: number;
  fullTier: boolean;
  /** The point score does not distinguish lanes, so a cut-off here blocks both. */
  pointsBlockedUntil: number;
  pointsBlockReason: string;
  buc: Map<string, BucGate>;
  breakerReason: string | undefined;
  /** Entrants to the per-account write lock that have not yet released. */
  writeDepth: number;
  writeChain: Promise<void> | undefined;
}

export class MetaScheduler {
  private readonly now: Clock;
  private readonly writeReserveFraction: number;
  private readonly onThrottle: ((r: RateLimited) => void) | undefined;
  private readonly accounts = new Map<string, AccountState>();

  constructor(opts: SchedulerOptions) {
    this.now = opts.now;
    const reserve = opts.writeReserveFraction ?? 0.5;
    if (!(reserve >= 0 && reserve < 1)) {
      throw new Error(
        `writeReserveFraction must be in [0, 1); got ${reserve}. At 1 the read lane can never run.`,
      );
    }
    this.writeReserveFraction = reserve;
    this.onThrottle = opts.onThrottle;
  }

  /**
   * Feed the last observed headers back in. This is what makes the bucket seeded from
   * reality rather than from a static config guess that is wrong for every account.
   */
  observe(adAccountId: string, state: RateLimitState | undefined): void {
    if (!state) return;
    const now = this.now();
    const st = this.account(adAccountId, now);
    this.refill(st, now);

    // Only re-decide the tier when this response actually carried the field. Meta stamps
    // `ads_api_access_tier` inside `x-business-use-case-usage`, so a response that only
    // carries `x-ad-account-usage` says nothing about the tier — and treating silence as
    // "Limited" would flap a Full-tier account's ceiling between 9000 and 60. Each
    // downgrade clamps the bucket to 60, and the following upgrade leaves it 60 of 9000
    // with a read reserve of 4500, i.e. reads stalled for minutes on no evidence at all.
    const observedTier = tierOf(state);
    if (observedTier !== undefined) st.fullTier = observedTier === 'FULL';
    const capacity = st.fullTier ? POINT_CEILING.FULL : POINT_CEILING.LIMITED;
    if (capacity !== st.capacity) {
      st.capacity = capacity;
      // On a downgrade, clamp. On an upgrade, let the normal refill earn the new headroom
      // rather than granting 9000 points on the strength of one header.
      st.tokens = Math.min(st.tokens, capacity);
    }

    const acct = state.adAccount;
    if (acct) {
      const pct = clamp(acct.utilPct, 0, 100);
      const headerTokens = (capacity * (100 - pct)) / 100;
      // Pessimistic-only. Meta's percentage counts every actor on the account — other
      // workers, Ads Manager, native rules — so it is better information than our local
      // count, but it is a snapshot from before any request we have issued since. Taking
      // the minimum can only make us slower, and the local refill heals the pessimism
      // within one decay window, so it cannot wedge.
      st.tokens = Math.min(st.tokens, headerTokens);

      if (pct >= 100) {
        // INFERRED: `reset_time_duration` is documented as seconds but not explicitly as
        // "time until unblocked". The tier block time is used as a floor so a small or
        // absent value cannot produce a hot loop.
        const blockMs = Math.max(
          (acct.resetTimeDuration ?? 0) * 1000,
          st.fullTier ? POINT_BLOCK_MS.FULL : POINT_BLOCK_MS.LIMITED,
        );
        st.pointsBlockedUntil = Math.max(st.pointsBlockedUntil, now + clampBackoff(blockMs));
        st.pointsBlockReason = `ad-account point score exhausted at ${pct}% (reset_time_duration ${acct.resetTimeDuration ?? 'absent'}s)`;
        st.tokens = 0;
      }
    }

    for (const [key, usage] of state.buc) {
      // Keys are `${businessObjectId}:${useCase}`; the bucket is per use case.
      const useCase = key.slice(key.lastIndexOf(':') + 1);
      const gate = this.bucGate(st, useCase);
      const worst = Math.max(usage.callCount, usage.totalCputime, usage.totalTime);
      gate.worstPct = worst;

      const etaMs = clampBackoff(Math.max(0, usage.estimatedTimeToRegainAccess) * ETA_MINUTES_TO_MS);
      let backoff = 0;
      if (worst >= GOVERNOR.CRIT_PCT) backoff = Math.max(GOVERNOR.CRIT_MS, etaMs);
      else if (worst >= GOVERNOR.WARN_PCT) backoff = Math.max(GOVERNOR.WARN_MS, etaMs);
      else if (etaMs > 0) backoff = etaMs;

      if (backoff > 0) {
        gate.blockedUntil = Math.max(gate.blockedUntil, now + backoff);
        gate.detail =
          `BUC ${key} at ${worst}% (call_count ${usage.callCount}, total_cputime ${usage.totalCputime}, ` +
          `total_time ${usage.totalTime})` +
          (usage.estimatedTimeToRegainAccess > 0
            ? `; Meta reports a cut-off of ${usage.estimatedTimeToRegainAccess} minutes`
            : '');
      }
    }

    // Kept for operators only. The breaker aggregates across every use case and returns
    // no interval, so gating on it would let an insights bucket at 96% stop publishing —
    // exactly the starvation the lane split exists to prevent.
    const breaker = shouldCircuitBreak(state);
    st.breakerReason = breaker.tripped ? breaker.reason : undefined;
  }

  /**
   * Ask whether a call could go out now, and if not, when. Charges nothing — it does
   * advance the refill clock, which is time-derived and therefore not a state decision.
   */
  check(req: LaneRequest): LaneVerdict {
    const now = this.now();
    const st = this.account(req.adAccountId, now);
    this.refill(st, now);
    return this.evaluate(st, req, now);
  }

  /**
   * Charge the limiter for one call. Throws `RateLimited` instead of blocking.
   * Points are charged up front because Meta counts the request, not the outcome.
   */
  acquire(req: LaneRequest): void {
    const now = this.now();
    const st = this.account(req.adAccountId, now);
    this.refill(st, now);
    const verdict = this.evaluate(st, req, now);
    if (!verdict.allowed) {
      const err = new RateLimited(verdict.scope, verdict.retryAfterMs, verdict.reason);
      this.notifyThrottle(err);
      throw err;
    }
    st.tokens -= POINT_COST[req.lane];
  }

  /**
   * Run one call through the scheduler.
   *
   * Writes are serialised per ad account and parallel across accounts, because the point
   * score is per account: two concurrent writes to one account race each other into a
   * throttle, while writes to different accounts are genuinely independent. Reads are not
   * serialised — they are cheap and latency-sensitive, and the write reserve already
   * protects publishing from them.
   */
  async run<T>(req: RunRequest, fn: () => Promise<T>): Promise<T> {
    if (req.lane !== 'WRITE') return this.execute(req, fn);

    const st = this.account(req.adAccountId, this.now());
    const previous = st.writeChain ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `previous` is by construction a promise that never rejects, so the chain cannot
    // poison itself when one write fails.
    st.writeChain = previous.then(() => mine);
    st.writeDepth += 1;

    await previous;
    try {
      return await this.execute(req, fn);
    } finally {
      release();
      st.writeDepth -= 1;
      // Only drop the chain when nobody is queued behind it; dropping it while a waiter
      // still holds a reference would let the next arrival start a concurrent write.
      if (st.writeDepth === 0) st.writeChain = undefined;
    }
  }

  snapshot(adAccountId: string): AccountSnapshot {
    const now = this.now();
    const st = this.account(adAccountId, now);
    this.refill(st, now);
    return {
      tokens: st.tokens,
      capacity: st.capacity,
      fullTier: st.fullTier,
      pointsBlockedForMs: Math.max(0, st.pointsBlockedUntil - now),
      inFlightWrites: st.writeDepth,
      buc: [...st.buc.entries()].map(([useCase, g]) => ({
        useCase,
        worstPct: g.worstPct,
        blockedForMs: Math.max(0, g.blockedUntil - now),
      })),
      breakerReason: st.breakerReason,
    };
  }

  private async execute<T>(req: RunRequest, fn: () => Promise<T>): Promise<T> {
    this.acquire(req);
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MetaApiError) throw this.onMetaError(req, err);
      throw err;
    } finally {
      // A `finally` that throws REPLACES the error on its way out. If the headers thunk
      // blows up, the caller would be handed a TypeError instead of the Meta rejection
      // that actually happened — at 3am, with nobody to reconstruct it. Bookkeeping is
      // never allowed to destroy the diagnosis.
      try {
        this.observe(req.adAccountId, req.headers?.());
      } catch {
        /* headers are an optimisation; losing them must not lose the real outcome */
      }
    }
  }

  /** The hook is documented as non-throwing; a hook bug must not become the caller's error. */
  private notifyThrottle(err: RateLimited): void {
    if (!this.onThrottle) return;
    try {
      this.onThrottle(err);
    } catch {
      /* observability only */
    }
  }

  /**
   * Translate a Meta rejection into the right local state change.
   *
   * The trap: `errors.ts` classifies `613/1487632` (ad-set budget changed 4 times this
   * hour) as THROTTLED, and it is — but it is a per-AD-SET policy cap, not an account
   * rate limit. Draining the account point bucket for it would stall every publish on the
   * account because one ad set hit its budget cap. Per-object caps belong to
   * `BudgetChangeQueue`; only genuine account throttles touch the bucket.
   */
  private onMetaError(req: RunRequest, err: MetaApiError): Error {
    if (capBreach(err) !== undefined) return err;
    if (err.disposition !== 'THROTTLED') return err;

    const now = this.now();
    const st = this.account(req.adAccountId, now);
    const useCase = defaultUseCase(req);
    const gate = this.bucGate(st, useCase);

    // We were cut off despite the local estimate saying otherwise, so the estimate was
    // optimistic. Drain the bucket and hold off for at least a full tier block.
    const observed = Math.max(0, gate.blockedUntil - now);
    const floor = st.fullTier ? POINT_BLOCK_MS.FULL : POINT_BLOCK_MS.LIMITED;
    const backoff = clampBackoff(Math.max(observed, floor));
    // A throttle raised by the read lane must not eat the write reserve. Reads and writes
    // share one point bucket, so draining it outright would let a reporting throttle
    // delay publishing — the exact starvation the reserve exists to prevent. Drain to the
    // reserve line instead: reads are refused, the guaranteed publish slice survives.
    st.tokens =
      req.lane === 'WRITE' ? 0 : Math.min(st.tokens, st.capacity * this.writeReserveFraction);
    gate.blockedUntil = Math.max(gate.blockedUntil, now + backoff);
    if (!gate.detail) gate.detail = `Meta ${err.code}${err.subcode ? `/${err.subcode}` : ''}: ${err.message}`;

    const limited = new RateLimited(
      `${req.adAccountId}/${useCase}`,
      backoff,
      `Meta returned ${err.code}${err.subcode ? `/${err.subcode}` : ''} — ${err.message}`,
      { cause: err, attempted: true },
    );
    this.notifyThrottle(limited);
    return limited;
  }

  private evaluate(st: AccountState, req: LaneRequest, now: number): LaneVerdict {
    const useCase = defaultUseCase(req);
    const bucScope = `${req.adAccountId}/${useCase}`;
    const pointScope = `${req.adAccountId}/points`;

    const gate = st.buc.get(useCase);
    if (gate && gate.blockedUntil > now) {
      return { allowed: false, retryAfterMs: gate.blockedUntil - now, reason: gate.detail, scope: bucScope };
    }
    if (st.pointsBlockedUntil > now) {
      return {
        allowed: false,
        retryAfterMs: st.pointsBlockedUntil - now,
        reason: st.pointsBlockReason,
        scope: pointScope,
      };
    }

    const cost = POINT_COST[req.lane];
    const reserve = req.lane === 'READ' ? st.capacity * this.writeReserveFraction : 0;
    if (st.capacity - reserve < cost) {
      // Refusing with a finite `retryAfterMs` here would be a lie: no amount of waiting
      // makes a full bucket satisfy this call, so a durable workflow would sleep and
      // re-attempt for ever. A misconfiguration must be loud, not a silent hot loop.
      throw new Error(
        `writeReserveFraction ${this.writeReserveFraction} reserves ${reserve} of ${st.capacity} ` +
          `points on ${req.adAccountId}, leaving less than the ${cost} points a ${req.lane.toLowerCase()} ` +
          `costs. The read lane could never run. Lower writeReserveFraction.`,
      );
    }
    const available = st.tokens - reserve;
    if (available < cost) {
      // Refill is linear at capacity per decay window, so the wait is exact.
      const retryAfterMs = Math.ceil(((cost - available) * POINT_DECAY_MS) / st.capacity);
      const reason =
        req.lane === 'READ' && st.tokens >= cost
          ? `read would breach the write reserve (${st.tokens.toFixed(1)} of ${st.capacity} points left, ` +
            `${reserve} reserved for publishing)`
          : `ad-account point score exhausted (${st.tokens.toFixed(1)} of ${st.capacity} points left, ` +
            `this ${req.lane.toLowerCase()} costs ${cost})`;
      return { allowed: false, retryAfterMs, reason, scope: pointScope };
    }
    return { allowed: true, retryAfterMs: 0, reason: '', scope: bucScope };
  }

  private account(adAccountId: string, now: number): AccountState {
    const existing = this.accounts.get(adAccountId);
    if (existing) return existing;
    // A brand-new account is seeded full: we have no header yet, and seeding empty would
    // deadlock the very first call. The first response corrects us downwards.
    const st: AccountState = {
      tokens: POINT_CEILING.LIMITED,
      capacity: POINT_CEILING.LIMITED,
      lastRefill: now,
      fullTier: false,
      pointsBlockedUntil: 0,
      pointsBlockReason: '',
      buc: new Map(),
      breakerReason: undefined,
      writeDepth: 0,
      writeChain: undefined,
    };
    this.accounts.set(adAccountId, st);
    return st;
  }

  private bucGate(st: AccountState, useCase: string): BucGate {
    const existing = st.buc.get(useCase);
    if (existing) return existing;
    const gate: BucGate = { worstPct: 0, blockedUntil: 0, detail: '' };
    st.buc.set(useCase, gate);
    return gate;
  }

  private refill(st: AccountState, now: number): void {
    const elapsed = Math.max(0, now - st.lastRefill);
    st.lastRefill = now;
    if (elapsed === 0) return;
    if (st.pointsBlockedUntil > now) return; // a cut-off account earns nothing back
    st.tokens = Math.min(st.capacity, st.tokens + (elapsed * st.capacity) / POINT_DECAY_MS);
  }
}

function defaultUseCase(req: LaneRequest): BucUseCase {
  return req.useCase ?? (req.lane === 'WRITE' ? 'ads_management' : 'ads_insights');
}

/**
 * The tier this response reports, or undefined when it reports nothing.
 *
 * `isFullTier` collapses "Limited" and "no information" into the same `false`, which is
 * the right default for a first decision and the wrong one for an update. Anything that
 * is not the literal `standard_access` is still Limited — the dossier records the header
 * strings as unchanged by the May 2026 Limited/Full rename, but defensive parsing costs
 * nothing and a wrong guess upwards would run a 60-point account at a 9000-point ceiling.
 */
function tierOf(state: RateLimitState): 'FULL' | 'LIMITED' | undefined {
  if (isFullTier(state)) return 'FULL';
  for (const u of state.buc.values()) if (u.adsApiAccessTier !== undefined) return 'LIMITED';
  return undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampBackoff(ms: number): number {
  return clamp(Number.isFinite(ms) ? ms : 0, 0, MAX_BACKOFF_MS);
}

/* ------------------------------------------------------------------------------------ */
/*  Budget-change queue                                                                   */
/* ------------------------------------------------------------------------------------ */

/**
 * The two per-object change caps Meta enforces. Neither is a rate limit in the header
 * sense — they are policy, they are not reported anywhere, and you only learn you have
 * breached one by being rejected.
 *
 * They are in DIFFERENT ERROR FAMILIES. A handler that branches only on `613` will
 * misclassify the spend-limit breach as an unknown permanent failure.
 */
export type ChangeKind = 'ADSET_BUDGET' | 'ACCOUNT_SPEND_LIMIT';

export interface ChangeCap {
  readonly max: number;
  readonly windowMs: number;
  readonly errorCode: number;
  readonly errorSubcode: number;
}

export const CHANGE_CAPS: Readonly<Record<ChangeKind, ChangeCap>> = {
  /** "You can only change your ad set budget 4 times per hour." */
  ADSET_BUDGET: { max: 4, windowMs: 3_600_000, errorCode: 613, errorSubcode: 1487632 },
  /** Ad account spend limit: 10 changes per day. Note the different code family. */
  ACCOUNT_SPEND_LIMIT: { max: 10, windowMs: 86_400_000, errorCode: 17, errorSubcode: 1885172 },
};

/** Which per-object cap this error reports, or undefined if it is not a cap breach. */
export function capBreach(err: MetaApiError): ChangeKind | undefined {
  for (const kind of Object.keys(CHANGE_CAPS) as ChangeKind[]) {
    const cap = CHANGE_CAPS[kind];
    if (err.code === cap.errorCode && err.subcode === cap.errorSubcode) return kind;
  }
  return undefined;
}

export interface BudgetProposal {
  kind: ChangeKind;
  adAccountId: string;
  /** Ad set id for ADSET_BUDGET; the ad account id for ACCOUNT_SPEND_LIMIT. */
  targetId: string;
  /**
   * The value to write, in the ad account currency's MINOR units. Eleven currencies have
   * offset 1 (JPY, KRW, CLP, COP, CRC, HUF, IDR, ISK, PYG, TWD, VND), so the caller must
   * have resolved the offset from the account already — the queue cannot check it.
   */
  valueMinorUnits: number;
  /**
   * Priority. Higher wins. This is the optimiser's expected value of making the change —
   * not its age. When a cap is hit the newest best proposal must win, because a
   * superseded budget proposal is worthless: it was computed against numbers that have
   * since moved.
   */
  value: number;
  /** Human-readable cause, carried through to the audit trail. */
  reason: string;
}

export interface PendingChange extends BudgetProposal {
  proposedAt: number;
  /** How many rival proposals for this target this one has out-competed. */
  supersededCount: number;
}

export interface ChangeLease extends PendingChange {
  leaseId: string;
  takenAt: number;
  /**
   * The highest budget already written to this ad set in the last 24 h, if any.
   *
   * Meta's 175% daily ceiling anchors to the HIGHEST budget set that day, so writing
   * $400 and rolling back to $100 an hour later does not undo the exposure — the day can
   * still spend $700. A budget write is therefore irreversible for the day, and the
   * executor needs this number to know what it is really risking.
   *
   * A rolling 24 h window is used rather than the ad account's calendar day because the
   * queue does not know the account timezone. A rolling window can only over-state
   * today's exposure, which is the safe direction to be wrong in.
   */
  todayHighWaterMinorUnits: number | undefined;
}

export type ProposalOutcome =
  | { status: 'QUEUED'; pending: PendingChange }
  /** A rival for the same target was displaced because this proposal is worth more. */
  | { status: 'SUPERSEDED'; pending: PendingChange; dropped: PendingChange }
  /** This proposal is worth less than what is already queued for the target. */
  | { status: 'DISCARDED'; kept: PendingChange; reason: string };

/** What actually happened to a leased change. `UNKNOWN` refuses to guess. */
export type SettleOutcome = 'APPLIED' | 'NOT_SENT' | 'UNKNOWN';

export interface QueueOptions {
  now: Clock;
  /**
   * A proposal that has failed to win a slot for this long is stale by construction — it
   * was computed from data at least one full cap window old. Defaults to the ad-set cap
   * window (1 h). Set `Infinity` to keep proposals forever.
   */
  staleAfterMs?: number;
  /** Observability hook for silent drops. Must not throw. */
  onDropped?: (change: PendingChange, why: 'SUPERSEDED' | 'STALE') => void;
}

export interface QueueStats {
  pending: number;
  leased: number;
  droppedStale: number;
  droppedSuperseded: number;
}

interface AppliedWrite {
  at: number;
  valueMinorUnits: number;
}

interface LeaseRecord {
  lease: ChangeLease;
  /**
   * Whether a `NOT_SENT` settle may hand the slot back. Cleared by `recordCapRejection`:
   * once Meta has told us the target's window is full, returning a slot would let the
   * next `take()` issue a write we already know will be rejected.
   */
  refundable: boolean;
}

/**
 * The choke point for every budget change in the system.
 *
 * The optimiser proposes into this queue and NEVER calls the Marketing API directly.
 * That is not a style preference: at 4 changes per hour per ad set, a loop that nudges
 * budgets every five minutes is throttled inside twenty minutes and is then unable to
 * make the one change that mattered.
 *
 * Slots are consumed at `take()`, not at `settle()`. Given the Marketing API has no
 * idempotency keys, an unconfirmed write may or may not have landed; spending a slot on a
 * write that failed costs a delayed budget change, whereas assuming it failed and
 * re-issuing costs a duplicate budget write — and Meta's daily ceiling anchors to the
 * highest budget written, so duplicate upward writes are the expensive direction.
 *
 * **All of this state is in memory.** A restart forgets the cap windows, the high-water
 * marks and any open lease, so the queue alone is not a sufficient defence against a
 * duplicate write across a crash — the caller must reconcile against a durable record of
 * what it actually sent before re-proposing. Within a process it is authoritative; across
 * one it is an optimisation, and `recordCapRejection` is what makes the cold-start case
 * merely slow rather than wrong.
 */
export class BudgetChangeQueue {
  private readonly now: Clock;
  private readonly staleAfterMs: number;
  private readonly onDropped: ((c: PendingChange, why: 'SUPERSEDED' | 'STALE') => void) | undefined;

  /** One pending proposal per target — that is the coalescing rule, not an optimisation. */
  private readonly pending = new Map<string, PendingChange>();
  /** Timestamps of changes counted against each target's cap window. */
  private readonly capWindow = new Map<string, number[]>();
  /** Applied ad-set budget writes, for the 24 h high-water mark. */
  private readonly writeLog = new Map<string, AppliedWrite[]>();
  private readonly leases = new Map<string, LeaseRecord>();
  private leaseSeq = 0;
  private droppedStale = 0;
  private droppedSuperseded = 0;

  constructor(opts: QueueOptions) {
    this.now = opts.now;
    this.staleAfterMs = opts.staleAfterMs ?? CHANGE_CAPS.ADSET_BUDGET.windowMs;
    this.onDropped = opts.onDropped;
  }

  propose(proposal: BudgetProposal): ProposalOutcome {
    validateProposal(proposal);
    const now = this.now();
    this.expire(now);
    const key = targetKey(proposal.kind, proposal.targetId);
    const incoming: PendingChange = { ...proposal, proposedAt: now, supersededCount: 0 };
    const existing = this.pending.get(key);

    if (!existing) {
      this.pending.set(key, incoming);
      return { status: 'QUEUED', pending: incoming };
    }

    // Ties go to the newer proposal: same expected value, fresher inputs.
    if (incoming.value < existing.value) {
      return {
        status: 'DISCARDED',
        kept: existing,
        reason:
          `a pending ${proposal.kind} for ${proposal.targetId} is worth more ` +
          `(${existing.value} >= ${incoming.value}); the cap is ${CHANGE_CAPS[proposal.kind].max} per ` +
          `${CHANGE_CAPS[proposal.kind].windowMs / 60_000} minutes, so only the best change may hold the slot`,
      };
    }

    incoming.supersededCount = existing.supersededCount + 1;
    this.pending.set(key, incoming);
    this.droppedSuperseded += 1;
    this.onDropped?.(existing, 'SUPERSEDED');
    return { status: 'SUPERSEDED', pending: incoming, dropped: existing };
  }

  /**
   * Take the highest-value change whose target still has cap headroom, consuming a slot.
   * Returns undefined when nothing is eligible — that is the normal steady state, not an
   * error.
   */
  take(): ChangeLease | undefined {
    const now = this.now();
    this.expire(now);

    let best: PendingChange | undefined;
    let bestKey: string | undefined;
    for (const [key, candidate] of this.pending) {
      if (this.remaining(candidate.kind, candidate.targetId, now) <= 0) continue;
      // Highest value first; ties broken by age so a stalemate cannot starve anyone.
      if (
        !best ||
        candidate.value > best.value ||
        (candidate.value === best.value && candidate.proposedAt < best.proposedAt)
      ) {
        best = candidate;
        bestKey = key;
      }
    }
    if (!best || bestKey === undefined) return undefined;

    this.pending.delete(bestKey);
    this.window(bestKey).push(now);

    this.leaseSeq += 1;
    const lease: ChangeLease = {
      ...best,
      leaseId: `lease_${this.leaseSeq}`,
      takenAt: now,
      todayHighWaterMinorUnits: this.highWaterMark(best.targetId),
    };
    this.leases.set(lease.leaseId, { lease, refundable: true });
    return lease;
  }

  /** Every currently eligible change, best first, at most one per target. */
  takeAll(): ChangeLease[] {
    const out: ChangeLease[] = [];
    for (;;) {
      const next = this.take();
      if (!next) return out;
      out.push(next);
    }
  }

  /**
   * Close out a lease.
   *
   *  - `APPLIED`  — the write landed. The slot stays consumed and the high-water mark moves.
   *  - `NOT_SENT` — the caller KNOWS no request reached Meta (a spend-guard refusal, a
   *                 local validation failure). The slot is returned.
   *  - `UNKNOWN`  — anything ambiguous. The slot stays consumed, because guessing wrong
   *                 here writes a budget twice.
   *
   * A lease that is never settled keeps its slot, which is the safe direction.
   */
  settle(leaseId: string, outcome: SettleOutcome): void {
    const record = this.leases.get(leaseId);
    if (!record) {
      throw new Error(
        `Unknown budget-change lease ${leaseId}. Settling a lease twice, or settling one this queue ` +
          `never issued, means the cap accounting is not what the caller thinks it is.`,
      );
    }
    const lease = record.lease;
    this.leases.delete(leaseId);
    const key = targetKey(lease.kind, lease.targetId);

    if (outcome === 'NOT_SENT') {
      if (!record.refundable) return; // Meta has since told us the window is full
      const window = this.window(key);
      const idx = window.lastIndexOf(lease.takenAt);
      if (idx >= 0) window.splice(idx, 1);
      return;
    }
    if (outcome === 'APPLIED' && lease.kind === 'ADSET_BUDGET') {
      const log = this.writeLog.get(lease.targetId) ?? [];
      log.push({ at: this.now(), valueMinorUnits: lease.valueMinorUnits });
      this.writeLog.set(lease.targetId, log);
    }
  }

  /**
   * Meta says the cap is already spent — so our window model was wrong, which happens
   * whenever another actor (Ads Manager, a native ad rule, a second worker) edited the
   * same object. Saturate the window conservatively: we do not know when those changes
   * happened, so assume the oldest was just now and stand off for a full window.
   *
   * Returns the milliseconds to wait before proposing this target again.
   */
  recordCapRejection(kind: ChangeKind, targetId: string): number {
    const now = this.now();
    const cap = CHANGE_CAPS[kind];
    const key = targetKey(kind, targetId);
    const window = this.window(key);
    window.length = 0;
    for (let i = 0; i < cap.max; i += 1) window.push(now);
    // Any lease still open on this target has had its slot absorbed by the saturation
    // above. Letting it be refunded later would re-open a slot Meta has just refused.
    for (const record of this.leases.values()) {
      if (targetKey(record.lease.kind, record.lease.targetId) === key) record.refundable = false;
    }
    return cap.windowMs;
  }

  /** Changes still available for this target inside its cap window. */
  remaining(kind: ChangeKind, targetId: string, now = this.now()): number {
    const cap = CHANGE_CAPS[kind];
    const window = this.prunedWindow(targetKey(kind, targetId), cap.windowMs, now);
    return Math.max(0, cap.max - window.length);
  }

  /** Epoch ms at which this target next has cap headroom. Now, if it has some already. */
  nextEligibleAt(kind: ChangeKind, targetId: string): number {
    const now = this.now();
    const cap = CHANGE_CAPS[kind];
    const window = this.prunedWindow(targetKey(kind, targetId), cap.windowMs, now);
    if (window.length < cap.max) return now;
    const oldest = window[0];
    return oldest === undefined ? now : oldest + cap.windowMs;
  }

  /** Highest ad-set budget written in the trailing 24 h. See `todayHighWaterMinorUnits`. */
  highWaterMark(targetId: string): number | undefined {
    const now = this.now();
    const log = this.writeLog.get(targetId);
    if (!log) return undefined;
    const cutoff = now - 86_400_000;
    const live = log.filter((w) => w.at > cutoff);
    if (live.length === 0) {
      this.writeLog.delete(targetId);
      return undefined;
    }
    this.writeLog.set(targetId, live);
    return live.reduce((max, w) => Math.max(max, w.valueMinorUnits), Number.NEGATIVE_INFINITY);
  }

  peek(): readonly PendingChange[] {
    this.expire(this.now());
    return [...this.pending.values()].sort((a, b) => b.value - a.value || a.proposedAt - b.proposedAt);
  }

  stats(): QueueStats {
    this.expire(this.now());
    return {
      pending: this.pending.size,
      leased: this.leases.size,
      droppedStale: this.droppedStale,
      droppedSuperseded: this.droppedSuperseded,
    };
  }

  private expire(now: number): void {
    if (!Number.isFinite(this.staleAfterMs)) return;
    for (const [key, change] of this.pending) {
      if (now - change.proposedAt >= this.staleAfterMs) {
        this.pending.delete(key);
        this.droppedStale += 1;
        this.onDropped?.(change, 'STALE');
      }
    }
  }

  private window(key: string): number[] {
    const existing = this.capWindow.get(key);
    if (existing) return existing;
    const fresh: number[] = [];
    this.capWindow.set(key, fresh);
    return fresh;
  }

  private prunedWindow(key: string, windowMs: number, now: number): number[] {
    const window = this.window(key);
    const cutoff = now - windowMs;
    while (window.length > 0 && (window[0] ?? 0) <= cutoff) window.shift();
    return window;
  }
}

function targetKey(kind: ChangeKind, targetId: string): string {
  return `${kind}:${targetId}`;
}

/**
 * This is the last place a nonsense budget can be stopped before it becomes a lease that
 * something else will faithfully write to Meta. A `NaN` value is the dangerous one: every
 * comparison against it is false, so it would silently out-rank nothing, never be
 * superseded, and eventually be POSTed as `daily_budget=NaN`. Money moves through here —
 * refuse loudly and name the field.
 */
function validateProposal(p: BudgetProposal): void {
  const where = `${p.kind} proposal for ${p.targetId || '(no target)'}`;
  if (!CHANGE_CAPS[p.kind]) throw new Error(`${where}: unknown change kind ${String(p.kind)}.`);
  if (!p.targetId) throw new Error(`${where}: targetId is required — it is the cap-window key.`);
  if (!p.adAccountId) throw new Error(`${where}: adAccountId is required.`);
  if (!Number.isFinite(p.value)) {
    throw new Error(`${where}: value must be a finite priority, got ${p.value}. NaN never loses a comparison.`);
  }
  if (!Number.isInteger(p.valueMinorUnits) || p.valueMinorUnits < 0) {
    throw new Error(
      `${where}: valueMinorUnits must be a non-negative integer in the account currency's minor units, ` +
        `got ${p.valueMinorUnits}. Meta rejects fractional minor units, and the caller must already have ` +
        `resolved the currency offset (eleven currencies have offset 1).`,
    );
  }
}
