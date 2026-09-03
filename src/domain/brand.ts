import type { ConversionArchetype, ArchetypeSpec } from '../meta/objectives.ts';
import { specFor } from '../meta/objectives.ts';

/**
 * Config resolves at three levels: platform defaults -> brand -> ad.
 *
 * A multi-brand, multi-objective operation is the normal case here, not an edge case,
 * so nothing about the conversion archetype is global. The pipeline shape stays the
 * same; only this config differs. An individual ad can override its brand — a brand
 * that normally drives website purchases can still run one instant-form ad — because
 * the archetype is data, not a code path.
 *
 * The rule for what may be overridden per-ad: creative and destination decisions, yes;
 * SAFETY decisions, no. Spend envelope, special ad category and the claim set are
 * brand-level and an ad cannot widen them. That asymmetry is the whole reason autonomy
 * is safe to grant — the system can vary anything that does not change how much money
 * is at risk or what the ad is legally allowed to say.
 */

export interface SpendEnvelope {
  /** Minor units, in the ad account's currency. Never inferred; the only spend authority. */
  dailyBudgetMinor: number;
  /** Hard ceiling. The system may never propose a daily budget above this. */
  maxDailyBudgetMinor: number;
  /** Target cost per action, minor units. Sets the prior and the kill threshold. */
  targetCpaMinor?: number;
  /** Target return on ad spend, for value-optimised brands. */
  targetRoas?: number;
  /**
   * Contribution margin per conversion, minor units. Optional but the highest-leverage
   * value in the file: sent as the CAPI event value, it makes Meta optimise the
   * advertiser's profit instead of its own revenue. Meta is structurally disqualified
   * from doing this, which makes it the most defensible lever available.
   */
  contributionMarginMinor?: number;
}

/** What the system is allowed to say. The legal edge of an autonomous copywriter. */
export interface ClaimSet {
  /** Claims a human has confirmed are substantiable. Nothing outside this may be asserted. */
  substantiated: string[];
  /** Phrases that must never appear, in copy or on screen. */
  neverSay: string[];
  /** Things that must never be depicted. */
  neverShow: string[];
  /**
   * Confirms rights are held to any spokesperson likeness or voice used. Without it the
   * pipeline refuses to generate a human presenter — a synthetic likeness of a real
   * person is a right-of-publicity claim and an EU AI Act Art. 50(4) obligation.
   */
  likenessRightsConfirmed: boolean;
}

export type SpecialAdCategory =
  | 'NONE' | 'EMPLOYMENT' | 'HOUSING' | 'CREDIT'
  | 'ISSUES_ELECTIONS_POLITICS' | 'ONLINE_GAMBLING_AND_GAMING'
  | 'FINANCIAL_PRODUCTS_SERVICES';

export interface Destination {
  /** Required for website archetypes. Meta reviews it and enforces an ad/page match rule. */
  url?: string;
  /** Required for instant_form_lead. Forms cannot be deleted, only archived — name deterministically. */
  leadFormId?: string;
  /** pixel/dataset id, for pixel_event archetypes. */
  pixelId?: string;
  /** e.g. PURCHASE, LEAD, COMPLETE_REGISTRATION. */
  customEventType?: string;
  productSetId?: string;
  applicationId?: string;
  objectStoreUrl?: string;
  phoneNumber?: string;
}

export interface Brand {
  /** Stable slug. Used in deterministic object names, so it must never change. */
  id: string;
  name: string;
  pageId: string;
  adAccountId: string;
  instagramUserId?: string;

  archetype: ConversionArchetype;
  destination: Destination;
  spend: SpendEnvelope;
  claims: ClaimSet;

  /**
   * Mandatory on campaign creation and it silently rewrites targeting: HOUSING,
   * EMPLOYMENT, CREDIT and FINANCIAL_PRODUCTS_SERVICES force age 18-65+, block gender
   * selection, forbid location exclusion, impose a 15-mile minimum radius and disable
   * lookalikes. Declaring it wrong is a disapproval you cannot explain.
   */
  specialAdCategories: SpecialAdCategory[];
  /** Required whenever a special ad category is set, and for EU DSA fields. */
  countries: string[];

  /** Free-text grounding: what this brand sells, in its own words. */
  proposition: string;
}

/** A single ad may narrow its brand, never widen it. */
export interface AdOverrides {
  archetype?: ConversionArchetype;
  destination?: Partial<Destination>;
  /** May only ever be LOWER than the brand's daily budget. */
  dailyBudgetMinor?: number;
}

export interface ResolvedAdConfig {
  brand: Brand;
  spec: ArchetypeSpec;
  destination: Destination;
  dailyBudgetMinor: number;
}

export class ConfigConflictError extends Error {}

/**
 * Resolves brand + ad overrides into the config one ad is published with.
 *
 * Rejects any override that would increase spend or escape the brand's safety envelope.
 * This is enforced here rather than trusted to callers, because the whole point of
 * unattended operation is that no caller is reviewed by a human before it runs.
 */
export function resolveAdConfig(brand: Brand, overrides: AdOverrides = {}): ResolvedAdConfig {
  const archetype = overrides.archetype ?? brand.archetype;
  const spec = specFor(archetype);

  const destination: Destination = { ...brand.destination, ...overrides.destination };

  let dailyBudgetMinor = brand.spend.dailyBudgetMinor;
  if (overrides.dailyBudgetMinor !== undefined) {
    if (overrides.dailyBudgetMinor > brand.spend.dailyBudgetMinor) {
      throw new ConfigConflictError(
        `Ad-level daily budget ${overrides.dailyBudgetMinor} exceeds brand "${brand.id}" budget ` +
          `${brand.spend.dailyBudgetMinor}. An ad may narrow its brand's envelope, never widen it.`,
      );
    }
    dailyBudgetMinor = overrides.dailyBudgetMinor;
  }

  requireDestinationFor(spec, destination, brand.id);
  return { brand, spec, destination, dailyBudgetMinor };
}

/** Each archetype needs a different promoted_object, and a missing one fails opaquely at Meta. */
function requireDestinationFor(spec: ArchetypeSpec, dest: Destination, brandId: string): void {
  const missing: string[] = [];
  switch (spec.promotedObject) {
    case 'pixel_event':
      if (!dest.pixelId) missing.push('pixelId');
      if (!dest.customEventType) missing.push('customEventType');
      if (!dest.url) missing.push('url');
      break;
    case 'product_set':
      if (!dest.productSetId) missing.push('productSetId');
      break;
    case 'app':
      if (!dest.applicationId) missing.push('applicationId');
      if (!dest.objectStoreUrl) missing.push('objectStoreUrl');
      break;
    case 'page':
      if (spec.archetype === 'instant_form_lead' && !dest.leadFormId) missing.push('leadFormId');
      if (spec.archetype === 'phone_call' && !dest.phoneNumber) missing.push('phoneNumber');
      break;
    case 'none':
      if (!dest.url) missing.push('url');
      break;
  }
  if (missing.length > 0) {
    throw new ConfigConflictError(
      `Brand "${brandId}" archetype ${spec.archetype} requires ${missing.join(', ')}. ${spec.note}`,
    );
  }
}

/** Category restrictions that silently rewrite targeting, surfaced as warnings at load time. */
const RESTRICTED: ReadonlySet<SpecialAdCategory> = new Set([
  'HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES',
]);

export function validateBrand(brand: Brand): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9][a-z0-9-]*$/.test(brand.id)) {
    problems.push(`id "${brand.id}" must be a lowercase slug — it appears in deterministic object names`);
  }
  if (!brand.adAccountId.startsWith('act_')) {
    problems.push(`adAccountId "${brand.adAccountId}" must start with act_`);
  }
  if (brand.spend.maxDailyBudgetMinor < brand.spend.dailyBudgetMinor) {
    problems.push('maxDailyBudgetMinor is below dailyBudgetMinor — the ceiling is under the floor');
  }
  if (brand.spend.targetCpaMinor === undefined && brand.spend.targetRoas === undefined) {
    problems.push('needs targetCpaMinor or targetRoas — without one there is no kill threshold');
  }
  if (brand.specialAdCategories.length === 0) {
    problems.push('specialAdCategories is required — send ["NONE"] for ordinary commercial advertising');
  }
  const restricted = brand.specialAdCategories.filter((c) => RESTRICTED.has(c));
  if (restricted.length > 0 && brand.countries.length === 0) {
    problems.push(`${restricted.join(', ')} requires countries for special_ad_category_country`);
  }
  if (brand.claims.substantiated.length === 0) {
    problems.push('claims.substantiated is empty — the generator would have no approved claim to make');
  }

  try {
    resolveAdConfig(brand);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }

  return problems;
}
