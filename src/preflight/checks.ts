import type { MetaClient } from '../meta/client.ts';
import { MetaApiError } from '../meta/errors.ts';

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
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
  type?: string;
}

/**
 * Verifies the token is valid, belongs to this app, never expires, and carries the
 * scopes the pipeline needs.
 *
 * `granular_scopes` is the field that matters most in practice: a token can hold
 * `ads_management` in general while being granted it on zero ad accounts. That
 * produces a #200 at publish time with a message that does not mention the real cause.
 */
export async function checkToken(
  client: MetaClient,
  appId: string,
): Promise<{ results: CheckResult[]; grantedAdAccounts: string[]; grantedPages: string[] }> {
  const results: CheckResult[] = [];
  let data: DebugTokenData;

  try {
    const res = await client.get<{ data: DebugTokenData }>('debug_token', {
      input_token: process.env['META_SYSTEM_USER_TOKEN'] ?? '',
    });
    data = res.data ?? {};
  } catch (e) {
    return {
      results: [
        {
          name: 'Token validity',
          severity: 'BLOCK',
          detail: e instanceof Error ? e.message : String(e),
          remedy:
            'Re-mint a system user token: Business Settings > Users > System Users > Generate New Token.',
        },
      ],
      grantedAdAccounts: [],
      grantedPages: [],
    };
  }

  results.push(
    data.is_valid
      ? { name: 'Token validity', severity: 'PASS', detail: `valid, type ${data.type ?? 'unknown'}` }
      : {
          name: 'Token validity',
          severity: 'BLOCK',
          detail: 'Meta reports this token as invalid',
          remedy: 'Re-mint the system user token.',
        },
  );

  if (data.app_id && data.app_id !== appId) {
    results.push({
      name: 'Token/app match',
      severity: 'BLOCK',
      detail: `token belongs to app ${data.app_id}, but META_APP_ID is ${appId}`,
      remedy: 'appsecret_proof is computed from the app secret; a mismatched pair fails every call.',
    });
  }

  // expires_at of 0 means "never" — which is what a system user token should be.
  if (data.expires_at === 0) {
    results.push({ name: 'Token expiry', severity: 'PASS', detail: 'never expires' });
  } else if (typeof data.expires_at === 'number') {
    const when = new Date(data.expires_at * 1000).toISOString().slice(0, 10);
    results.push({
      name: 'Token expiry',
      severity: 'WARN',
      detail: `expires ${when}`,
      remedy:
        'Re-mint without set_token_expires_in_60_days so it never expires, or the loop stops on that date with no warning.',
    });
  }

  const flat = new Set(data.scopes ?? []);
  const granular = data.granular_scopes ?? [];
  for (const g of granular) flat.add(g.scope);

  const missing = REQUIRED_SCOPES.filter((s) => !flat.has(s));
  results.push(
    missing.length === 0
      ? { name: 'Required scopes', severity: 'PASS', detail: REQUIRED_SCOPES.join(', ') }
      : {
          name: 'Required scopes',
          severity: 'BLOCK',
          detail: `missing ${missing.join(', ')}`,
          remedy: 'Re-mint the token with the full scope list — scopes cannot be added to an existing token.',
        },
  );

  const missingOptional = OPTIONAL_SCOPES.filter((s) => !flat.has(s));
  if (missingOptional.length > 0) {
    results.push({
      name: 'Optional scopes',
      severity: 'WARN',
      detail: `missing ${missingOptional.join(', ')}`,
      remedy:
        'leads_retrieval in particular cannot be added later without re-minting, and lead ads are impossible without it.',
    });
  }

  // The granular grant is the one that bites: scope held, but on nothing.
  const adAccounts = granular.find((g) => g.scope === 'ads_management')?.target_ids ?? [];
  const pages = granular.find((g) => g.scope === 'pages_show_list')?.target_ids ?? [];

  if (granular.length > 0 && adAccounts.length === 0) {
    results.push({
      name: 'Granular ads_management grant',
      severity: 'BLOCK',
      detail: 'the token holds ads_management but is granted it on zero ad accounts',
      remedy:
        'Business Settings > System Users > Assign Assets > Ad Accounts, with "Manage campaigns" permission.',
    });
  }

  return { results, grantedAdAccounts: adAccounts, grantedPages: pages };
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

/** Every ad creative requires a page_id. No Page, no ad. */
export async function checkPages(client: MetaClient, businessId: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const pages: PageNode[] = [];

  for (const edge of ['owned_pages', 'client_pages']) {
    try {
      const res = await client.get<{ data?: PageNode[] }>(`${businessId}/${edge}`, {
        fields: 'id,name,instagram_business_account{id,username}',
        limit: '100',
      });
      pages.push(...(res.data ?? []));
    } catch {
      // A business with no client pages 404s on that edge; not an error worth surfacing.
    }
  }

  if (pages.length === 0) {
    return [
      {
        name: 'Pages',
        severity: 'BLOCK',
        detail: 'no Pages visible to this token',
        remedy:
          'Assign Pages to the system user in Business Settings. object_story_spec.page_id is required on every ad creative.',
      },
    ];
  }

  results.push({
    name: 'Pages',
    severity: 'PASS',
    detail: `${pages.length} visible: ${pages.map((p) => p.name ?? p.id).join(', ')}`,
  });

  const withoutIg = pages.filter((p) => !p.instagram_business_account);
  if (withoutIg.length > 0) {
    results.push({
      name: 'Instagram accounts',
      severity: 'WARN',
      detail: `${withoutIg.length} Page(s) without a connected Instagram account: ${withoutIg
        .map((p) => p.name ?? p.id)
        .join(', ')}`,
      remedy:
        'A Page-Backed Instagram Account can be created via API, but renders the handle in black and non-clickable on Instagram placements.',
    });
  }

  return results;
}
