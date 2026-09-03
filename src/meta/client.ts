import { createHmac } from 'node:crypto';
import { GRAPH_BASE_URL } from './version.ts';
import { MetaApiError, isGraphErrorBody, type GraphErrorBody } from './errors.ts';
import { parseRateLimitHeaders, shouldCircuitBreak, type RateLimitState } from './rateLimit.ts';

/**
 * Runtime modes, enforced HERE rather than in workflow code.
 *
 * The point of putting the guard in the transport is that no future call site can
 * forget it. A workflow author cannot accidentally spend money, because the only path
 * to Meta refuses to carry an activation unless the whole process is in LIVE.
 */
export type RuntimeMode = 'SIMULATE' | 'VALIDATE' | 'STAGE' | 'LIVE';

export interface ClientOptions {
  appId: string;
  appSecret: string;
  accessToken: string;
  mode: RuntimeMode;
  /** Records every intended write. In SIMULATE this is the only thing that happens. */
  onIntent?: (intent: WriteIntent) => void;
  fetchImpl?: typeof fetch;
}

export interface WriteIntent {
  method: 'POST' | 'DELETE';
  path: string;
  params: Record<string, string>;
  mode: RuntimeMode;
  /** Deterministic key: the same logical write always produces the same value. */
  idempotencyKey: string | undefined;
}

export class SpendGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendGuardError';
  }
}

/** Fields whose value would start or increase delivery. */
const ACTIVATING_VALUES = new Set(['ACTIVE']);
const STATUS_FIELDS = new Set(['status', 'configured_status', 'effective_status']);

export class MetaClient {
  readonly mode: RuntimeMode;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly accessToken: string;
  private readonly onIntent: ((intent: WriteIntent) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  /** Last observed limiter state, per ad account. Drives backoff from reality, not guesswork. */
  readonly rateLimits = new Map<string, RateLimitState>();

  constructor(opts: ClientOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.accessToken = opts.accessToken;
    this.mode = opts.mode;
    this.onIntent = opts.onIntent;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * HMAC-SHA256 of the access token, keyed by the app secret. Mandatory on the system
   * user token endpoints regardless of the "Require App Secret" toggle, and free
   * everywhere else, so it is sent unconditionally.
   */
  private appsecretProof(): string {
    return createHmac('sha256', this.appSecret).update(this.accessToken).digest('hex');
  }

  async get<T = unknown>(
    path: string,
    params: Record<string, string> = {},
    ctx: { adAccountId?: string } = {},
  ): Promise<T> {
    const url = new URL(`${GRAPH_BASE_URL}/${stripLeadingSlash(path)}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', this.accessToken);
    url.searchParams.set('appsecret_proof', this.appsecretProof());
    return this.send<T>(url, { method: 'GET' }, ctx);
  }

  /**
   * All writes funnel through here so the spend guard cannot be bypassed.
   *
   * `idempotencyKey` is not sent to Meta — the Graph API has no such concept. It is
   * recorded in the intent ledger so that an ambiguous failure can be reconciled by
   * searching for the object rather than blindly retrying and creating a duplicate
   * that spends real money.
   */
  async post<T = unknown>(
    path: string,
    params: Record<string, string>,
    ctx: { adAccountId?: string; idempotencyKey?: string } = {},
  ): Promise<T> {
    this.assertWriteAllowed(path, params);

    const intent: WriteIntent = {
      method: 'POST',
      path,
      params,
      mode: this.mode,
      idempotencyKey: ctx.idempotencyKey,
    };
    this.onIntent?.(intent);

    if (this.mode === 'SIMULATE') {
      return { id: `simulated_${hash(JSON.stringify(intent))}`, __simulated: true } as T;
    }

    const body = new URLSearchParams(params);
    if (this.mode === 'VALIDATE') body.set('execution_options', JSON.stringify(['validate_only']));
    body.set('access_token', this.accessToken);
    body.set('appsecret_proof', this.appsecretProof());

    const url = new URL(`${GRAPH_BASE_URL}/${stripLeadingSlash(path)}`);
    return this.send<T>(url, { method: 'POST', body }, ctx);
  }

  /**
   * The single choke point between this system and delivery.
   *
   * STAGE deliberately permits real object creation — it exercises real video
   * encoding, real ad review and real object ids — and blocks only the transition to
   * ACTIVE. That is what makes it useful: everything is real except the spending.
   */
  private assertWriteAllowed(path: string, params: Record<string, string>): void {
    if (this.mode === 'LIVE') return;

    for (const field of STATUS_FIELDS) {
      const value = params[field];
      if (value !== undefined && ACTIVATING_VALUES.has(value.toUpperCase())) {
        throw new SpendGuardError(
          `Refusing to set ${field}=${value} on ${path} in ${this.mode} mode. ` +
            `Activation requires RUNTIME_MODE=LIVE. This guard is in the transport ` +
            `layer precisely so it cannot be forgotten at a call site.`,
        );
      }
    }
  }

  private async send<T>(
    url: URL,
    init: RequestInit,
    ctx: { adAccountId?: string },
  ): Promise<T> {
    const res = await this.fetchImpl(url, init);

    const limits = parseRateLimitHeaders(res.headers);
    if (ctx.adAccountId) this.rateLimits.set(ctx.adAccountId, limits);

    if (limits.versionWarning) {
      // Meta auto-upgraded this call to a newer API version. Behaviour may have
      // changed underneath a running campaign; this must never be swallowed.
      console.warn(`[meta] API VERSION WARNING: ${limits.versionWarning}`);
    }
    const breaker = shouldCircuitBreak(limits);
    if (breaker.tripped) {
      console.warn(`[meta] rate-limit headroom exhausted: ${breaker.reason}`);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? parseBigIntSafe(text) : {};
    } catch {
      throw new Error(`Non-JSON response from Meta (HTTP ${res.status}): ${text.slice(0, 400)}`);
    }

    // The Graph API returns errors under HTTP 200 in several cases, so the body is
    // checked before the status code.
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (isGraphErrorBody(err)) throw new MetaApiError(err, res.status);
      throw new Error(`Unrecognised Meta error shape: ${JSON.stringify(err).slice(0, 400)}`);
    }
    if (!res.ok) {
      throw new MetaApiError(
        { message: text.slice(0, 400), code: -1 } satisfies GraphErrorBody,
        res.status,
      );
    }
    return parsed as T;
  }
}

/**
 * Meta object ids exceed 2^53 and JSON.parse silently mangles them into a different
 * number. A campaign id that is off by one is a write against someone else's object,
 * so every numeric field wide enough to be an id is preserved as a string.
 */
export function parseBigIntSafe(text: string): unknown {
  return JSON.parse(text.replace(/:\s*(\d{16,})(?=\s*[,}\]])/g, ': "$1"'));
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function hash(s: string): string {
  return createHmac('sha256', 'simulate').update(s).digest('hex').slice(0, 16);
}
