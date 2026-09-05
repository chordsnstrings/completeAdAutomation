import type { MetaClient } from '../meta/client.ts';
import { MetaApiError } from '../meta/errors.ts';
import { GRAPH_BASE_URL } from '../meta/version.ts';

export type Severity = 'PASS' | 'WARN' | 'BLOCK';

export interface CheckResult {
  name: string;
  severity: Severity;
  detail: string;
  /** What a human must do. Empty when nothing is required. */
  remedy?: string;
}

/** Scopes the pipeline cannot function without. */
const REQUIRED_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
] as const;

/** Missing these narrows what the system can do, but it can still run. */
const OPTIONAL_SCOPES = [
  'pages_manage_ads',
  'instagram_basic',
  'read_insights',
  'leads_retrieval',
] as const;

interface DebugTokenData {
  is_valid?: boolean;
  app_id?: string;
  application?: string;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
  type?: string;
  user_id?: string;
}

/**
 * Inspects the token WITHOUT appsecret_proof.
 *
 * Deliberate: if the app secret does not belong to the token's app, every proofed call
 * fails with "Invalid appsecret_proof", which says nothing about the actual cause. A
 * token can always self-inspect unproofed, so this read-only call is what turns an
 * opaque failure into "your secret is for app X, your token is from app Y".
 */
async function inspectTokenUnproofed(token: string): Promise<DebugTokenData> {
  const url = new URL(`${GRAPH_BASE_URL}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const body = (await res.json()) as { data?: DebugTokenData; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.data ?? {};
}

/**
 * Verifies the token is valid, belongs to this app, never expires, and carries the
 * scopes the pipeline needs.
 *
 * The check that matters most in practice is the last one: a token can hold
 * `ads_management` while being assigned to zero ad accounts. Permissions are granted on
 * the app; assets are granted separately in Business Settings, and nothing warns you
 * that the second half was never done. It surfaces later as a #200 at publish time with
 * a message that never mentions asset assignment.
 */
export async function checkToken(
  client: MetaClient,
  appId: string,
  token: string,
): Promise<{ results: CheckResult[]; ok: boolean; systemUserId?: string }> {
  const results: CheckResult[] = [];
  let data: DebugTokenData;

  try {
    data = await inspectTokenUnproofed(token);
  } catch (e) {
    return {
      ok: false,
      results: [
        {
          name: 'Token validity',
          severity: 'BLOCK',
          detail: e instanceof Error ? e.message : String(e),
          remedy:
            'Re-mint a system user token: Business Settings > Users > System Users > Generate New Token.',
        },
      ],
    };
  }

  if (!data.is_valid) {
    return {
      ok: false,
      results: [
        {
          name: 'Token validity',
          severity: 'BLOCK',
          detail: 'Meta reports this token as invalid',
          remedy: 'Re-mint the system user token.',
        },
      ],
    };
  }

  results.push({
    name: 'Token validity',
    severity: 'PASS',
    detail: `valid, type ${data.type ?? 'unknown'}${data.user_id ? `, system user ${data.user_id}` : ''}`,
  });

  // The app-identity check has to come before anything proofed, or every later failure
  // is reported as a proof error rather than as the mismatch it actually is.
  if (data.app_id && data.app_id !== appId) {
    results.push({
      name: 'Token/app match',
      severity: 'BLOCK',
      detail:
        `this token was issued by app ${data.app_id}` +
        (data.application ? ` ("${data.application}")` : '') +
        `, but META_APP_ID is ${appId}`,
      remedy:
        `appsecret_proof is HMAC(token, app_secret) and Meta validates it against the app that ` +
        `issued the token, so a mismatched pair fails every call. Either set META_APP_ID=${data.app_id} ` +
        `and supply that app's secret, or mint a fresh system user token from app ${appId}.`,
    });
    return { ok: false, results };
  }

  results.push({ name: 'Token/app match', severity: 'PASS', detail: `app ${appId}` });

  if (data.expires_at === 0) {
    results.push({ name: 'Token expiry', severity: 'PASS', detail: 'never expires' });
  } else if (typeof data.expires_at === 'number') {
    const when = new Date(data.expires_at * 1000).toISOString().slice(0, 10);
    results.push({
      name: 'Token expiry',
      severity: 'WARN',
      detail: `expires ${when}`,
      remedy:
        'Re-mint without set_token_expires_in_60_days, or the loop stops on that date with no warning.',
    });
  }

  const held = new Set(data.scopes ?? []);
  for (const g of data.granular_scopes ?? []) held.add(g.scope);

  const missing = REQUIRED_SCOPES.filter((s) => !held.has(s));
  results.push(
    missing.length === 0
      ? { name: 'Required scopes', severity: 'PASS', detail: `all ${REQUIRED_SCOPES.length} present` }
      : {
          name: 'Required scopes',
          severity: 'BLOCK',
          detail: `missing ${missing.join(', ')}`,
          remedy: 'Scopes cannot be added to an existing token — re-mint with the full list.',
        },
  );

  const missingOptional = OPTIONAL_SCOPES.filter((s) => !held.has(s));
  if (missingOptional.length > 0) {
    results.push({
      name: 'Optional scopes',
      severity: 'WARN',
      detail: `missing ${missingOptional.join(', ')}`,
      remedy:
        'leads_retrieval cannot be added later without re-minting, and lead ads are impossible without it.',
    });
  }

  // Prove the secret actually matches by making one proofed call.
  try {
    await client.get('me', { fields: 'id' });
    results.push({ name: 'App secret', severity: 'PASS', detail: 'appsecret_proof accepted' });
  } catch (e) {
    results.push({
      name: 'App secret',
      severity: 'BLOCK',
      detail: e instanceof MetaApiError ? e.message : String(e),
      remedy: `META_APP_SECRET does not match app ${appId}. Copy it from App Dashboard > Settings > Basic.`,
    });
    return { ok: false, results };
  }

  return { ok: true, results, ...(data.user_id ? { systemUserId: data.user_id } : {}) };
}

/**
 * Permissions are granted on the app; ASSETS are granted separately in Business
 * Settings. A system user with every scope and no assigned assets is the single most
 * common misconfiguration, and Meta gives no warning for it.
 */
export async function checkAssignedAssets(
  client: MetaClient,
  systemUserId?: string,
): Promise<{ results: CheckResult[]; adAccountIds: string[] }> {
  // The owning business is not discoverable from a system user token — /me/businesses
  // returns empty and the app node exposes no business field — so the remedy names the
  // system user id instead, which is what identifies the row in Business Settings.
  const who = systemUserId ? `system user ${systemUserId} ("Admin")` : 'the system user';
  const results: CheckResult[] = [];

  let adAccounts: Array<{ id: string; name?: string }> = [];
  try {
    const res = await client.get<{ data?: Array<{ id: string; name?: string }> }>('me/adaccounts', {
      fields: 'id,name',
      limit: '100',
    });
    adAccounts = res.data ?? [];
  } catch (e) {
    results.push({
      name: 'Ad account access',
      severity: 'BLOCK',
      detail: e instanceof MetaApiError ? e.message : String(e),
    });
    return { results, adAccountIds: [] };
  }

  results.push(
    adAccounts.length > 0
      ? {
          name: 'Ad accounts assigned',
          severity: 'PASS',
          detail: `${adAccounts.length}: ${adAccounts.map((a) => a.name ?? a.id).join(', ')}`,
        }
      : {
          name: 'Ad accounts assigned',
          severity: 'BLOCK',
          detail: 'the token holds ads_management but is assigned to ZERO ad accounts',
          remedy:
            `Business Settings > Users > System Users > ${who} > Add Assets > Ad Accounts, ` +
            'with the "Manage campaigns" permission. Granting the scope is not the same as granting the asset.',
        },
  );

  let pages: PageNode[] = [];
  try {
    const res = await client.get<{ data?: PageNode[] }>('me/assigned_pages', {
      fields: 'id,name,instagram_business_account{id,username}',
      limit: '100',
    });
    pages = res.data ?? [];
  } catch {
    // edge unavailable for this token type; the zero case below still reports correctly
  }

  results.push(
    pages.length > 0
      ? {
          name: 'Pages assigned',
          severity: 'PASS',
          detail: `${pages.length}: ${pages.map((p) => p.name ?? p.id).join(', ')}`,
        }
      : {
          name: 'Pages assigned',
          severity: 'BLOCK',
          detail: 'no Pages assigned to this system user',
          remedy:
            `Business Settings > Users > System Users > ${who} > Add Assets > Pages, with the ` +
            '"Manage Page" or ads task. Every ad creative requires object_story_spec.page_id, so no Page means no ad.',
        },
  );

  const withoutIg = pages.filter((p) => !p.instagram_business_account);
  if (withoutIg.length > 0) {
    results.push({
      name: 'Instagram accounts',
      severity: 'WARN',
      detail: `${withoutIg.length} Page(s) without a connected Instagram account: ${withoutIg
        .map((p) => p.name ?? p.id)
        .join(', ')}`,
      remedy:
        'A Page-Backed Instagram Account works via API, but renders the handle in black and non-clickable.',
    });
  }

  return { results, adAccountIds: adAccounts.map((a) => a.id) };
}

interface PageNode {
  id: string;
  name?: string;
  instagram_business_account?: { id: string; username?: string };
}

interface AdAccountFields {
  id?: string;
  name?: string;
  account_status?: number;
  disable_reason?: number;
  currency?: string;
  timezone_name?: string;
  spend_cap?: string;
  amount_spent?: string;
  funding_source_details?: { id?: string; type?: number; display_string?: string };
  capabilities?: string[];
}

/** account_status values that are not 1 mean the account cannot transact. */
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
};

/**
 * The single most important check in the system.
 *
 * An ad account with no funding source accepts every write with HTTP 200 and delivers
 * nothing. An optimiser reading zero impressions concludes the creative failed and
 * pays to regenerate video — burning real money to fix a billing problem. This runs
 * before generation, not before publish.
 */
export async function checkAdAccount(
  client: MetaClient,
  adAccountId: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const id = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;

  let acct: AdAccountFields;
  try {
    acct = await client.get<AdAccountFields>(id, {
      fields:
        'id,name,account_status,disable_reason,currency,timezone_name,spend_cap,amount_spent,funding_source_details,capabilities',
    });
  } catch (e) {
    const detail = e instanceof MetaApiError ? e.message : String(e);
    return [
      {
        name: `${id} reachable`,
        severity: 'BLOCK',
        detail,
        remedy: 'Assign this ad account to the system user with "Manage campaigns" permission.',
      },
    ];
  }

  const label = acct.name ? `${id} (${acct.name})` : id;
  const status = acct.account_status ?? -1;
  results.push(
    status === 1
      ? { name: `${label} status`, severity: 'PASS', detail: 'ACTIVE' }
      : {
          name: `${label} status`,
          severity: 'BLOCK',
          detail: `${ACCOUNT_STATUS[status] ?? `unknown (${status})`}${
            acct.disable_reason ? `, disable_reason ${acct.disable_reason}` : ''
          }`,
          remedy:
            'Every write against a non-active account fails and burns rate-limit quota. Resolve in Ads Manager before arming.',
        },
  );

  const funding = acct.funding_source_details;
  results.push(
    funding?.id
      ? {
          name: `${label} funding`,
          severity: 'PASS',
          detail: funding.display_string ?? `funding source ${funding.id}`,
        }
      : {
          name: `${label} funding`,
          severity: 'BLOCK',
          detail: 'no payment method attached — ads will be created successfully and deliver nothing',
          remedy:
            'Add a payment method in Ads Manager. There is no API for this; it is permanently a human step.',
        },
  );

  const cap = acct.spend_cap ? Number(acct.spend_cap) : 0;
  results.push(
    cap > 0
      ? {
          name: `${label} spend cap`,
          severity: 'PASS',
          detail: `${minor(cap, acct.currency)} cap, ${minor(Number(acct.amount_spent ?? 0), acct.currency)} spent`,
        }
      : {
          name: `${label} spend cap`,
          severity: 'WARN',
          detail: 'no account-level spend cap set',
          remedy:
            'Set one in Ads Manager. It is the only spend limit Meta enforces on your behalf rather than on trust — the backstop if this system misbehaves.',
        },
  );

  if (acct.currency) {
    results.push({
      name: `${label} currency`,
      severity: 'PASS',
      detail: `${acct.currency}${ZERO_DECIMAL.has(acct.currency) ? ' (zero-decimal — budgets are whole units, not cents)' : ''}, tz ${acct.timezone_name ?? 'unknown'}`,
    });
  }

  return results;
}

/**
 * Eleven zero-decimal currencies. Dividing a budget by 100 on one of these misstates it
 * by 100x — a live money bug. CRC is the one commonly omitted from published lists.
 */
export const ZERO_DECIMAL = new Set([
  'CLP', 'COP', 'CRC', 'HUF', 'IDR', 'ISK', 'JPY', 'KRW', 'PYG', 'TWD', 'VND',
]);

function minor(amount: number, currency: string | undefined): string {
  const divisor = currency && ZERO_DECIMAL.has(currency) ? 1 : 100;
  return `${(amount / divisor).toLocaleString()} ${currency ?? ''}`.trim();
}

interface PageNode {
  id: string;
  name?: string;
  instagram_business_account?: { id: string; username?: string };
  tasks?: string[];
}
