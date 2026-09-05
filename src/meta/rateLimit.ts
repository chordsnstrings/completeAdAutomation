/**
 * Meta runs FOUR independent limiters and you can be throttled by any of them.
 *
 *  1. Business Use Case (BUC) — `x-business-use-case-usage`, per ad account, per
 *     use case. Three separate percentages (call_count, total_cputime, total_time);
 *     whichever trips first throttles you.
 *  2. A per-ad-account point score — `x-ad-account-usage`. Reads cost 1, writes cost 3,
 *     against a ceiling of 60 on the Limited tier and 9000 on Full. That is only TWENTY
 *     writes per five-minute window on Limited, which is the real constraint on
 *     publishing throughput — and reading the tier off the header is what tells the two
 *     ceilings apart.
 *  3. The Insights limiter — `x-fb-ads-insights-throttle`, emitted on `/insights`
 *     responses. It is NOT the `ads_insights` BUC bucket: it is a second, separately
 *     metered gate with its own account-level and app-level percentages, and Meta
 *     refuses insights calls on it while the BUC bucket still looks comfortable.
 *  4. The platform limiter — `x-app-usage`. 200 calls/hour x daily active users, pooled
 *     APP-WIDE across every ad account and every tenant, throttling at 100 on any of its
 *     three percentages. BUC takes precedence when both apply, but this is the one that
 *     takes down every brand at once, so it is not optional to model.
 *
 * All four are reported in response headers, which the official SDKs bury — Airbyte had to
 * subclass FacebookAdsApi just to read them. That is the main reason this client is
 * hand-rolled: the limiter must be driven by observed state, not by a static config
 * guess that is wrong for every account.
 *
 * Header shapes are recorded verbatim in `docs/research/meta-api-foundations.md` §8.2/§8.4
 * and `docs/research/meta-insights-measurement.md` §11.3.
 */

export interface BucUsage {
  callCount: number;
  totalCputime: number;
  totalTime: number;
  /** Milliseconds until access returns; present only once Meta has actually cut you off. */
  estimatedTimeToRegainAccess: number;
  /** e.g. 'development_access' | 'standard_access'. Unknown values are treated as the low tier. */
  adsApiAccessTier: string | undefined;
}

/** `x-ad-account-usage`: the per-ad-account point score, and the account's access tier. */
export interface AdAccountUsage {
  utilPct: number;
  /** SECONDS, not milliseconds. */
  resetTimeDuration: number | undefined;
  /**
   * The SECOND place Meta reports the tier. Dropping it caps a Full-tier account at the
   * 60-point Limited ceiling — 20 writes per five minutes instead of 3000, i.e. 150x
   * slower publishing than the account actually allows.
   */
  adsApiAccessTier: string | undefined;
}

/**
 * `x-fb-ads-insights-throttle`, returned on Insights responses:
 * `{"app_id_util_pct":100,"acc_id_util_pct":10,"ads_api_access_tier":"standard_access"}`.
 *
 * Two percentages with two different blast radii. `acc_id_util_pct` is this ad account;
 * `app_id_util_pct` is the whole app, so at 100 every account's reporting is refused, not
 * just this one's.
 */
export interface InsightsThrottle {
  appIdUtilPct: number;
  accIdUtilPct: number;
  adsApiAccessTier: string | undefined;
}

/**
 * `x-app-usage`: `{"call_count":28,"total_time":25,"total_cputime":25}`. Three
 * percentages 0-100 against an APP-WIDE hourly pool of 200 calls x daily active users.
 * `total_cputime` is the one that bites on Insights-heavy workloads — you can sit at
 * `call_count: 12` and `total_cputime: 98`.
 */
export interface AppUsage {
  callCount: number;
  totalTime: number;
  totalCputime: number;
}

export interface RateLimitState {
  buc: Map<string, BucUsage>;
  adAccount: AdAccountUsage | undefined;
  /** Present only on Insights responses. */
  insights: InsightsThrottle | undefined;
  /** App-wide, and therefore NOT keyed by ad account by whoever stores this. */
  app: AppUsage | undefined;
  /** Meta silently upgraded this call to a newer API version. Never ignore this. */
  versionWarning: string | undefined;
}

const HEADROOM_PCT = 90;

/** The only header value that means the high-quota tier. Anything else is Limited. */
const FULL_TIER_HEADER_VALUE = 'standard_access';

export function parseRateLimitHeaders(headers: Headers): RateLimitState {
  return {
    buc: parseBuc(headers.get('x-business-use-case-usage')),
    adAccount: parseAdAccountUsage(headers.get('x-ad-account-usage')),
    insights: parseInsightsThrottle(headers.get('x-fb-ads-insights-throttle')),
    app: parseAppUsage(headers.get('x-app-usage')),
    versionWarning: headers.get('x-ad-api-version-warning') ?? undefined,
  };
}

function parseBuc(raw: string | null): Map<string, BucUsage> {
  const out = new Map<string, BucUsage>();
  const parsed = jsonObject(raw);
  if (!parsed) return out;
  for (const [objectId, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as Array<Record<string, unknown>>) {
      const useCase = typeof e['type'] === 'string' ? e['type'] : 'unknown';
      out.set(`${objectId}:${useCase}`, {
        callCount: num(e['call_count']),
        totalCputime: num(e['total_cputime']),
        totalTime: num(e['total_time']),
        estimatedTimeToRegainAccess: num(e['estimated_time_to_regain_access']),
        adsApiAccessTier: tier(e['ads_api_access_tier']),
      });
    }
  }
  return out;
}

function parseAdAccountUsage(raw: string | null): AdAccountUsage | undefined {
  const p = jsonObject(raw);
  if (!p) return undefined;
  return {
    utilPct: num(p['acc_id_util_pct']),
    resetTimeDuration:
      p['reset_time_duration'] === undefined ? undefined : num(p['reset_time_duration']),
    adsApiAccessTier: tier(p['ads_api_access_tier']),
  };
}

function parseInsightsThrottle(raw: string | null): InsightsThrottle | undefined {
  const p = jsonObject(raw);
  if (!p) return undefined;
  return {
    appIdUtilPct: num(p['app_id_util_pct']),
    accIdUtilPct: num(p['acc_id_util_pct']),
    adsApiAccessTier: tier(p['ads_api_access_tier']),
  };
}

function parseAppUsage(raw: string | null): AppUsage | undefined {
  const p = jsonObject(raw);
  if (!p) return undefined;
  return {
    callCount: num(p['call_count']),
    totalTime: num(p['total_time']),
    totalCputime: num(p['total_cputime']),
  };
}

/** A JSON object, or undefined for absent/blank/malformed/non-object header values. */
function jsonObject(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tier(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Whichever of the three BUC percentages is highest is the one that will throttle you,
 * so the circuit breaker watches the max rather than call_count alone. CPU time is the
 * one that catches people out: a few heavy Insights queries can exhaust it while
 * call_count still looks comfortable.
 *
 * This is the COARSE, cross-limiter view: it says "something is nearly out of headroom",
 * not which lane to stop. The scheduler does the per-lane gating; this drives logging and
 * the client's spend guard.
 */
export function shouldCircuitBreak(state: RateLimitState): { tripped: boolean; reason?: string } {
  for (const [key, u] of state.buc) {
    const worst = Math.max(u.callCount, u.totalCputime, u.totalTime);
    if (u.estimatedTimeToRegainAccess > 0) {
      return { tripped: true, reason: `${key} is cut off for ${u.estimatedTimeToRegainAccess}ms` };
    }
    if (worst >= HEADROOM_PCT) {
      return {
        tripped: true,
        reason: `${key} at ${worst}% (calls ${u.callCount}, cpu ${u.totalCputime}, time ${u.totalTime})`,
      };
    }
  }
  if (state.adAccount && state.adAccount.utilPct >= HEADROOM_PCT) {
    return { tripped: true, reason: `ad account point score at ${state.adAccount.utilPct}%` };
  }
  const ins = state.insights;
  if (ins) {
    const worst = Math.max(ins.appIdUtilPct, ins.accIdUtilPct);
    if (worst >= HEADROOM_PCT) {
      return {
        tripped: true,
        reason: `insights limiter at ${worst}% (app ${ins.appIdUtilPct}%, account ${ins.accIdUtilPct}%)`,
      };
    }
  }
  const app = state.app;
  if (app) {
    const worst = Math.max(app.callCount, app.totalCputime, app.totalTime);
    if (worst >= HEADROOM_PCT) {
      return {
        tripped: true,
        reason:
          `app-wide platform limiter at ${worst}% (calls ${app.callCount}, cpu ${app.totalCputime}, ` +
          `time ${app.totalTime}) — this one throttles every ad account at once`,
      };
    }
  }
  return { tripped: false };
}

/**
 * Every `ads_api_access_tier` string this response reported, from all three headers that
 * carry it. Empty when the response said nothing about the tier — which is NOT the same
 * as reporting the low tier, and callers that conflate the two flap an account's ceiling
 * between 9000 and 60 on the strength of a missing field.
 */
export function observedAccessTiers(state: RateLimitState): string[] {
  const out: string[] = [];
  for (const u of state.buc.values()) if (u.adsApiAccessTier !== undefined) out.push(u.adsApiAccessTier);
  const acct = state.adAccount?.adsApiAccessTier;
  if (acct !== undefined) out.push(acct);
  const ins = state.insights?.adsApiAccessTier;
  if (ins !== undefined) out.push(ins);
  return out;
}

/**
 * Anything we do not recognise is treated as the low tier — the safe direction to be
 * wrong in. The dossier records `development_access` / `standard_access` as unchanged by
 * the May 2026 Limited/Full rename (re-checked 2026-09-02), but a wrong guess UPWARDS
 * would run a 60-point account at a 9000-point ceiling, so unknown strings stay low.
 */
export function isFullTier(state: RateLimitState): boolean {
  return observedAccessTiers(state).includes(FULL_TIER_HEADER_VALUE);
}
