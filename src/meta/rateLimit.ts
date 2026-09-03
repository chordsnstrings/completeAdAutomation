/**
 * Meta runs TWO independent limiters and you can be throttled by either.
 *
 *  1. Business Use Case (BUC) — `x-business-use-case-usage`, per ad account, per
 *     use case. Three separate percentages (call_count, total_cputime, total_time);
 *     whichever trips first throttles you.
 *  2. A per-ad-account point score — `x-ad-account-usage`. Reads cost 1, writes cost 3,
 *     against a ceiling of 60 on the Limited tier. That is only TWENTY writes per
 *     five-minute window, which is the real constraint on publishing throughput.
 *
 * Both are reported in response headers, which the official SDKs bury — Airbyte had to
 * subclass FacebookAdsApi just to read them. That is the main reason this client is
 * hand-rolled: the limiter must be driven by observed state, not by a static config
 * guess that is wrong for every account.
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

export interface RateLimitState {
  buc: Map<string, BucUsage>;
  adAccount: { utilPct: number; resetTimeDuration: number | undefined } | undefined;
  /** Meta silently upgraded this call to a newer API version. Never ignore this. */
  versionWarning: string | undefined;
}

const HEADROOM_PCT = 90;

export function parseRateLimitHeaders(headers: Headers): RateLimitState {
  return {
    buc: parseBuc(headers.get('x-business-use-case-usage')),
    adAccount: parseAdAccountUsage(headers.get('x-ad-account-usage')),
    versionWarning: headers.get('x-ad-api-version-warning') ?? undefined,
  };
}

function parseBuc(raw: string | null): Map<string, BucUsage> {
  const out = new Map<string, BucUsage>();
  if (!raw) return out;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return out;
  }
  for (const [objectId, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries as Array<Record<string, unknown>>) {
      const useCase = typeof e['type'] === 'string' ? e['type'] : 'unknown';
      out.set(`${objectId}:${useCase}`, {
        callCount: num(e['call_count']),
        totalCputime: num(e['total_cputime']),
        totalTime: num(e['total_time']),
        estimatedTimeToRegainAccess: num(e['estimated_time_to_regain_access']),
        adsApiAccessTier:
          typeof e['ads_api_access_tier'] === 'string' ? e['ads_api_access_tier'] : undefined,
      });
    }
  }
  return out;
}

function parseAdAccountUsage(
  raw: string | null,
): { utilPct: number; resetTimeDuration: number | undefined } | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      utilPct: num(p['acc_id_util_pct']),
      resetTimeDuration:
        p['reset_time_duration'] === undefined ? undefined : num(p['reset_time_duration']),
    };
  } catch {
    return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Whichever of the three BUC percentages is highest is the one that will throttle you,
 * so the circuit breaker watches the max rather than call_count alone. CPU time is the
 * one that catches people out: a few heavy Insights queries can exhaust it while
 * call_count still looks comfortable.
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
  return { tripped: false };
}

/** Anything we do not recognise is treated as the low tier — the safe direction to be wrong in. */
export function isFullTier(state: RateLimitState): boolean {
  for (const u of state.buc.values()) {
    if (u.adsApiAccessTier === 'standard_access') return true;
  }
  return false;
}
