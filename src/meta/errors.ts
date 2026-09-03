/**
 * Meta error classification.
 *
 * The Graph API returns HTTP 200 with an error body in several situations (notably
 * inside batch sub-responses), so status codes alone are not a usable signal. What
 * matters is the (code, error_subcode) pair.
 */

export interface GraphErrorBody {
  message: string;
  type?: string;
  code: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export type Disposition =
  /** Transient. Retry with backoff. */
  | 'RETRY'
  /** Rate limited. Back off for the interval the headers indicate, then retry. */
  | 'THROTTLED'
  /** Credentials are dead. Stop, mark the brand unhealthy, escalate to a human. */
  | 'AUTH_FAILED'
  /** The account cannot transact — unfunded, disabled, restricted. Escalate. */
  | 'ACCOUNT_BLOCKED'
  /** Our request is wrong. Retrying is pointless; fix the caller. */
  | 'PERMANENT'
  /**
   * Ambiguous: the write may or may not have landed. NEVER blind-retry these —
   * reconcile against the intent ledger and AdLabels first, or risk creating a
   * duplicate campaign that spends real money. The Graph API has no idempotency keys.
   */
  | 'AMBIGUOUS';

export class MetaApiError extends Error {
  readonly code: number;
  readonly subcode: number | undefined;
  readonly disposition: Disposition;
  readonly httpStatus: number;
  readonly fbtraceId: string | undefined;
  readonly body: GraphErrorBody;

  constructor(body: GraphErrorBody, httpStatus: number) {
    const subcode = body.error_subcode;
    const disposition = classify(body.code, subcode);
    super(
      `Meta ${body.code}${subcode ? `/${subcode}` : ''} [${disposition}]: ${body.message}` +
        (body.error_user_msg ? ` — ${body.error_user_msg}` : ''),
    );
    this.name = 'MetaApiError';
    this.code = body.code;
    this.subcode = subcode;
    this.disposition = disposition;
    this.httpStatus = httpStatus;
    this.fbtraceId = body.fbtrace_id;
    this.body = body;
  }

  get retryable(): boolean {
    return this.disposition === 'RETRY' || this.disposition === 'THROTTLED';
  }
}

/**
 * Codes worth special-casing. Everything unlisted falls through to PERMANENT, which is
 * the safe default: a system that spends money should refuse to retry what it does not
 * understand.
 */
export function classify(code: number, subcode?: number): Disposition {
  // Budget edits are capped at 4/hour per ad set. This is not transient within the
  // hour, but it is not a bug either — the scheduler must queue and re-attempt later.
  if (code === 613 && subcode === 1487632) return 'THROTTLED';

  switch (code) {
    case 1: // unknown / transient
    case 2: // temporary service issue
      return 'AMBIGUOUS'; // a write may have landed before the failure
    case 4: // app-level rate limit
    case 17: // user-level rate limit
    case 32: // page-level rate limit
    case 613: // custom-level (BUC) rate limit
    case 80000:
    case 80001:
    case 80002:
    case 80003:
    case 80004: // ads-management BUC throttling
    case 80005:
    case 80006:
    case 80008:
    case 80009:
    case 80014:
      return 'THROTTLED';
    case 102: // session invalid
    case 190: // access token expired / revoked / invalid
    case 463:
    case 467:
      return 'AUTH_FAILED';
    case 200: // permission denied — usually a missing scope or unassigned asset
    case 294:
      return subcode === 1870090 ? 'ACCOUNT_BLOCKED' : 'AUTH_FAILED';
    case 2635: // deprecated / disallowed for this account
    case 1487390: // ad account has been disabled
      return 'ACCOUNT_BLOCKED';
    case 368: // temporarily blocked for policy violations — a human must intervene
      return 'ACCOUNT_BLOCKED';
    case 100:
      // Housing/employment/credit certification the account has not accepted.
      // No API can clear it; a business admin must accept it in Business Manager.
      if (subcode === 2859024) return 'ACCOUNT_BLOCKED';
      return 'PERMANENT';
    default:
      return 'PERMANENT';
  }
}

export function isGraphErrorBody(v: unknown): v is GraphErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    typeof (v as { code: unknown }).code === 'number' &&
    'message' in v
  );
}
