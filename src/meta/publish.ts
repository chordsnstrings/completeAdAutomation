/**
 * Request-shape builders for the four publish endpoints.
 *
 * Everything here is a PURE function from a ResolvedAdConfig to a `Record<string,string>`
 * param map. No network, no clock, no randomness — the client does the talking and the
 * idempotency ledger does the remembering. That split is deliberate: a builder that
 * cannot perform a write can be run a thousand times in a test, and the params it emits
 * can be content-hashed into a stable intent key (see idempotency.ts, which rejects
 * attempt-scoped keys precisely so this stays true).
 *
 * The job of this module is to make an illegal request impossible to construct. Meta
 * rejects almost every structural mistake with an undifferentiated `code 100 "Invalid
 * parameter"` whose `error_user_msg` says nothing useful. Nobody is awake at 3am to
 * interpret that, so every constraint the research corpus documents is checked here and
 * thrown with the offending field named.
 *
 * Sources — docs/research/meta-campaign-publishing.md (§3 campaign, §5 special ad
 * categories, §6 ad set, §8 creative, §9 ad, §10 publish state machine, §14 gotchas),
 * docs/research/meta-video-creative.md (§4 object_story_spec, §8 degrees_of_freedom_spec,
 * §9 copy limits, §10 CTA enum) and docs/research/00-SYNTHESIS.md §3 step 14.
 *
 * Two conventions run through the whole file:
 *
 *  - **Everything is created PAUSED.** A duplicated PAUSED tree costs nothing and is
 *    garbage-collectable; a duplicated ACTIVE tree spends real money. All spend risk
 *    collapses into one status flip on an object whose id is already known, which is
 *    what makes the total absence of idempotency keys in the Marketing API survivable.
 *  - **Where the research says UNVERIFIED, this code says UNVERIFIED** — as a warning
 *    string the caller can log, or as a refusal. It never quietly picks a value and
 *    hopes.
 */

import { IllegalTupleError, validateSpec } from './objectives.ts';
import type { ArchetypeSpec, ConversionArchetype, Objective } from './objectives.ts';
import type { ResolvedAdConfig, SpecialAdCategory } from '../domain/brand.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error class, carrying the parameter that is wrong.
 *
 * `field` is the Meta parameter path (`targeting.genders`, `object_story_spec.video_data.
 * image_hash`) rather than our own input name, because the person reading the log at 3am
 * is holding Meta's reference page, not this file.
 */
export class PublishBuildError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'PublishBuildError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new PublishBuildError(field, message);
}

// ---------------------------------------------------------------------------
// Currency — minor units, and the eleven that are not hundredths
// ---------------------------------------------------------------------------

/**
 * Currencies whose Meta `offset` is 1, i.e. `daily_budget` is in WHOLE units.
 *
 * `daily_budget: 5000` is $50.00 on a USD account and ¥5,000 on a JPY one. A blanket
 * `/100` misstates a CRC budget by 100x, and CRC is the entry most published lists of
 * "zero-decimal currencies" omit — it is on Meta's list and not on ISO's.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'CLP', 'COP', 'CRC', 'HUF', 'IDR', 'ISK', 'JPY', 'KRW', 'PYG', 'TWD', 'VND',
]);

/**
 * Currencies where guessing the offset is a 10x-100x money bug, so we refuse instead.
 *
 * Meta's offset table and ISO 4217 disagree in BOTH directions: Meta calls COP, CRC,
 * HUF, IDR and TWD offset-1 where ISO gives them two decimals, and ISO calls these
 * zero- or three-decimal where Meta's published eleven does not list them at all. For
 * anything in this set the caller must supply `AccountContext.currencyOffset`, read from
 * Meta rather than assumed.
 */
export const AMBIGUOUS_MINOR_UNIT_CURRENCIES: ReadonlySet<string> = new Set([
  // ISO zero-decimal, absent from Meta's eleven.
  'BIF', 'DJF', 'GNF', 'KMF', 'RWF', 'UGX', 'UYI', 'VUV', 'XAF', 'XOF', 'XPF',
  // ISO three-decimal.
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);

/**
 * Minor units per major unit. 1 for the documented eleven, 100 for the ordinary case.
 *
 * Throws rather than guessing for the currencies above. Read `currency` off
 * `GET /act_{id}` and pass it here; never hard-code either the currency or the divisor.
 */
export function currencyOffset(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    fail('currency', `"${currency}" is not an ISO 4217 alpha-3 code. Read it from GET /act_{id}?fields=currency.`);
  }
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  if (AMBIGUOUS_MINOR_UNIT_CURRENCIES.has(code)) {
    fail(
      'currency',
      `${code} has no offset this system is willing to assume — Meta's offset table and ISO 4217 ` +
        `disagree for it. Read the account's offset from Meta and pass it as ` +
        `AccountContext.currencyOffset. Guessing 100 here would misstate every budget by up to 1000x.`,
    );
  }
  return 100;
}

/** Renders a minor-unit amount for an error message. Never used to build a request. */
export function formatMinor(minor: number, currency: string, offset?: number): string {
  const code = currency.trim().toUpperCase();
  const o = offset ?? currencyOffset(code);
  return o === 1 ? `${minor} ${code}` : `${(minor / o).toFixed(2)} ${code}`;
}

/** Major units -> minor units, for callers holding a human-entered figure. */
export function majorToMinor(major: number, currency: string, offset?: number): number {
  const o = offset ?? currencyOffset(currency);
  const minor = Math.round(major * o);
  if (!Number.isFinite(minor)) {
    fail('budget', `${major} ${currency} does not convert to a finite minor-unit amount.`);
  }
  return minor;
}

// ---------------------------------------------------------------------------
// Deterministic object naming
// ---------------------------------------------------------------------------

export type ObjectLevel = 'campaign' | 'adset' | 'ad' | 'creative';

/** Short, stable level codes. Kept short because the creative name budget is only 100. */
const LEVEL_CODE: Record<ObjectLevel, string> = {
  campaign: 'cmp',
  adset: 'set',
  ad: 'ad',
  creative: 'crt',
};

const CODE_LEVEL: Record<string, ObjectLevel> = {
  cmp: 'campaign',
  set: 'adset',
  ad: 'ad',
  crt: 'creative',
};

/**
 * Per-level name ceilings.
 *
 * Ad set 400 and creative 100 are documented. Campaign and ad are UNVERIFIED — the
 * research corpus records no published maximum — so 255 is a deliberately conservative
 * guess, matching idempotency.NAME_MAX_LENGTH.
 */
export const NAME_MAX_LENGTH: Readonly<Record<ObjectLevel, number>> = {
  campaign: 255,
  adset: 400,
  ad: 255,
  creative: 100,
};

/**
 * Room left for `idempotency.stampIntentKey`, which appends ` [idem:<32 hex>]` = 40 chars.
 *
 * Reserved here rather than discovered later, because the stamp is what an operator uses
 * to find the object in Ads Manager and it must never be the thing that gets truncated.
 */
export const NAME_STAMP_RESERVE = 40;

/** Marks an object as machine-created, so a human can tell ours from theirs at a glance. */
export const NAME_PREFIX = 'AUTO';

const NAME_SEPARATOR = '/';
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Trailing ` [idem:...]` stamp, stripped before parsing a name back. */
const STAMP_SUFFIX = /\s*\[idem:[0-9a-f]+\]$/;

export interface NameParts {
  /** Brand slug. Stable by contract — domain/brand.ts validates the shape. */
  brandId: string;
  /** Archetype slug, e.g. `website_purchase`. Part of the name so a human can triage. */
  archetype: string;
  level: ObjectLevel;
  /**
   * The creative lineage / variant discriminator. Must be derived from the intent, never
   * from the attempt: two retries of one publish have to produce the same name or
   * reconciliation by name finds nothing.
   */
  variant: string;
}

/**
 * `AUTO/<brand>/<archetype>/<level-code>/<variant>` — deterministic and parseable.
 *
 * Names are the operator-facing half of reconciliation (AdLabels are the machine half,
 * because `name` is not a documented filter on `GET /act_{id}/campaigns`). Both halves
 * only work if the same intent always produces the same string, so nothing time-derived
 * or counter-derived may enter here.
 */
export function objectName(parts: NameParts): string {
  if (!SLUG.test(parts.brandId)) {
    fail('name', `brandId "${parts.brandId}" is not a lowercase slug; object names must stay stable and parseable.`);
  }
  if (!SLUG.test(parts.variant)) {
    fail('name', `variant "${parts.variant}" is not a lowercase slug; it is the reconciliation discriminator.`);
  }
  if (!/^[a-z0-9_]+$/.test(parts.archetype)) {
    fail('name', `archetype "${parts.archetype}" is not a lowercase identifier.`);
  }
  // LEVEL_CODE and NAME_MAX_LENGTH are object literals, so an Object.prototype key
  // ("constructor", "__proto__", "toString") indexes to something truthy and would be
  // stringified straight into the name. Own-property only.
  if (!Object.hasOwn(LEVEL_CODE, parts.level)) {
    fail('name', `level "${String(parts.level)}" is not one of ${Object.keys(LEVEL_CODE).join(', ')}.`);
  }

  const name = [NAME_PREFIX, parts.brandId, parts.archetype, LEVEL_CODE[parts.level], parts.variant]
    .join(NAME_SEPARATOR);

  const budget = NAME_MAX_LENGTH[parts.level] - NAME_STAMP_RESERVE;
  if (name.length > budget) {
    fail(
      'name',
      `${parts.level} name is ${name.length} chars but only ${budget} are available ` +
        `(${NAME_MAX_LENGTH[parts.level]} limit minus ${NAME_STAMP_RESERVE} reserved for the idempotency stamp). ` +
        `Shorten brandId ("${parts.brandId}") or variant ("${parts.variant}") by ${name.length - budget}.`,
    );
  }
  return name;
}

/** Inverse of objectName, tolerant of a trailing idempotency stamp. Undefined if not ours. */
export function parseObjectName(name: string): NameParts | undefined {
  const parts = name.replace(STAMP_SUFFIX, '').split(NAME_SEPARATOR);
  if (parts.length !== 5) return undefined;
  const [prefix, brandId, archetype, code, variant] = parts;
  if (prefix !== NAME_PREFIX) return undefined;
  if (brandId === undefined || archetype === undefined || code === undefined || variant === undefined) {
    return undefined;
  }
  // Own-property only: `CODE_LEVEL['constructor']` is a function, not undefined, so a
  // name read back from Meta could otherwise yield a NameParts whose `level` matches no
  // branch of ObjectLevel and silently mis-routes reconciliation.
  const level = Object.hasOwn(CODE_LEVEL, code) ? CODE_LEVEL[code] : undefined;
  if (level === undefined) return undefined;
  return { brandId, archetype, level, variant };
}

// ---------------------------------------------------------------------------
// Special ad categories
// ---------------------------------------------------------------------------

/**
 * The four categories that silently rewrite targeting.
 *
 * Meta does not reject the illegal fields — it accepts the create and quietly runs
 * something other than what was asked for, which for an autonomous system is worse than
 * an error, because the optimiser then attributes the result to the creative.
 */
export const TARGETING_RESTRICTED_CATEGORIES: ReadonlySet<SpecialAdCategory> = new Set([
  'HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES',
]);

/** Forced age range under a restricted category: 18 through 65+. */
export const RESTRICTED_AGE_MIN = 18;
export const RESTRICTED_AGE_MAX = 65;

/**
 * Location granularities Meta prohibits under a restricted category.
 *
 * Only `zips` is expressible through this module's geo input; the rest are listed so the
 * message can name them if the input shape ever widens.
 */
export const RESTRICTED_LOCATION_GRANULARITIES: readonly string[] = [
  'zips', 'subcity', 'neighborhood', 'metro_area', 'small_geo_area',
  'subneighborhood', 'electoral_district',
];

/** Minimum radius under a restricted category, by regime. Meta publishes no mile figure for Europe. */
export const RESTRICTED_MIN_RADIUS = {
  /** "at least 15 mile or 25 kilometer radius for the US and Canada" */
  US_CA: { mile: 15, kilometer: 25 },
  /** "and 15 kilometer radius for Europe" — no mile equivalent is published. */
  EUROPE: { kilometer: 15 },
} as const;

// ---------------------------------------------------------------------------
// EU / DSA
// ---------------------------------------------------------------------------

/**
 * Countries whose targeting triggers the DSA payor/beneficiary requirement.
 *
 * EU-27 + EEA + the associated territories that carry their own ISO-3166-1 code. Meta
 * says "the EU and/or associated territories" and never enumerates them, so this set
 * errs INCLUSIVE on purpose: a false positive costs one extra string on the request
 * (both fields are silently discarded outside the EU), while a false negative is a
 * publish failure with a generic parameter error. UNVERIFIED as an exact list.
 */
export const EU_DSA_COUNTRIES: ReadonlySet<string> = new Set([
  // EU-27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA beyond the EU
  'IS', 'LI', 'NO',
  // Outermost regions and overseas countries/territories with their own codes
  'AW', 'AX', 'BL', 'BQ', 'CW', 'GF', 'GI', 'GL', 'GP', 'MF', 'MQ', 'NC', 'PF', 'PM',
  'RE', 'SX', 'TF', 'WF', 'YT',
]);

/** Both DSA fields are capped at 512 characters. */
export const DSA_FIELD_MAX_LENGTH = 512;

export type EuExposure = 'YES' | 'NO' | 'UNKNOWN';

/**
 * Whether this ad set's targeting can reach the EU.
 *
 * `UNKNOWN` is a real answer, not a shrug: `cities`, `regions` and `zips` are opaque
 * numeric keys with no country in them, and Meta ORs them with `countries` rather than
 * intersecting, so a US-countries ad set carrying a Dublin city key does reach the EU.
 * Both YES and UNKNOWN therefore demand the DSA fields.
 */
export function euExposure(geo: GeoInput): EuExposure {
  const hasOpaque =
    (geo.regions?.length ?? 0) > 0 || (geo.cities?.length ?? 0) > 0 || (geo.zips?.length ?? 0) > 0;
  const countries = geo.countries ?? [];
  if (countries.some((c) => EU_DSA_COUNTRIES.has(c.toUpperCase()))) return 'YES';
  if (hasOpaque) return 'UNKNOWN';
  return 'NO';
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export type DistanceUnit = 'mile' | 'kilometer';

export interface GeoPoint {
  /** Meta's opaque key, from the Targeting Search API. Never invented. */
  key: string;
  radius?: number;
  /**
   * Required whenever `radius` is set under a restricted category: the API's default
   * unit is undocumented and the legal minimum depends on which unit it is.
   */
  distanceUnit?: DistanceUnit;
}

export interface GeoInput {
  /** ISO-2. At least one is required — Meta rejects targeting without a country. */
  countries?: string[];
  regions?: Array<{ key: string }>;
  cities?: GeoPoint[];
  zips?: Array<{ key: string }>;
  /** e.g. ['home', 'recent']. */
  locationTypes?: string[];
}

export interface ExcludedGeoInput {
  countries?: string[];
  regions?: Array<{ key: string }>;
  cities?: GeoPoint[];
  zips?: Array<{ key: string }>;
}

export interface PlacementInput {
  publisherPlatforms?: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
  audienceNetworkPositions?: string[];
  messengerPositions?: string[];
  threadsPositions?: string[];
  devicePlatforms?: string[];
}

export interface TargetingInput {
  geo: GeoInput;
  excludedGeo?: ExcludedGeoInput;
  ageMin?: number;
  ageMax?: number;
  /** 1 = male, 2 = female. Omit for everyone — never send [1,2]. */
  genders?: number[];
  interests?: Array<{ id: string; name?: string }>;
  behaviors?: Array<{ id: string; name?: string }>;
  customAudienceIds?: string[];
  excludedCustomAudienceIds?: string[];
  lookalikeAudienceIds?: string[];
  locales?: number[];
  /**
   * `targeting_automation.advantage_audience`, 1 or 0. Defaults to 1.
   *
   * Always emitted. Since v26.0 a constrained audience under Housing / Employment /
   * Financial Products must state this explicitly on CREATION or the call fails with
   * ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG; sending it unconditionally
   * costs nothing and removes the whole class of failure.
   */
  advantageAudience?: 0 | 1;
  /**
   * Manual placements. Present = Advantage+ placements OFF, which turns the campaign's
   * whole `advantage_state` to DISABLED. Leave undefined unless you mean it.
   */
  placements?: PlacementInput;
}

/** Instagram positions removed in v26.0 — ad sets specifying them error on create. */
const REMOVED_INSTAGRAM_POSITIONS: ReadonlySet<string> = new Set(['explore']);
/** Messenger positions silently dropped in v26.0. */
const REMOVED_MESSENGER_POSITIONS: ReadonlySet<string> = new Set(['story']);
/** Accepted but no longer delivering since v24.0 — spend silently shifts elsewhere. */
const DEAD_FACEBOOK_POSITIONS: ReadonlySet<string> = new Set(['video_feeds']);

interface TargetingSpec {
  geo_locations: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Builds `targeting`, refusing any combination a special ad category would silently
 * rewrite.
 *
 * The rewriting is the reason this is a hard refusal rather than a warning: Meta accepts
 * an ad set that names a gender under HOUSING and then serves it to everyone. The
 * optimiser downstream would read the result as a creative effect and learn from a lie.
 */
export function buildTargeting(
  input: TargetingInput,
  categories: readonly SpecialAdCategory[],
  warnings: string[] = [],
): Record<string, unknown> {
  const restricted = categories.filter((c) => TARGETING_RESTRICTED_CATEGORIES.has(c));
  const isRestricted = restricted.length > 0;
  const label = restricted.join(', ');

  const countries = (input.geo.countries ?? []).map((c) => c.trim().toUpperCase());
  if (countries.length === 0) {
    fail(
      'targeting.geo_locations.countries',
      'at least one ISO-2 country is required; Meta rejects an ad set whose targeting has no country.',
    );
  }
  for (const c of countries) {
    if (!/^[A-Z]{2}$/.test(c)) {
      fail('targeting.geo_locations.countries', `"${c}" is not an ISO-2 country code.`);
    }
  }

  if (isRestricted) {
    assertRestrictedTargetingLegal(input, countries, label);
  }

  const geo: Record<string, unknown> = { countries };
  if (input.geo.regions?.length) geo['regions'] = input.geo.regions.map((r) => ({ key: r.key }));
  if (input.geo.cities?.length) geo['cities'] = input.geo.cities.map(serialiseGeoPoint);
  if (input.geo.zips?.length) geo['zips'] = input.geo.zips.map((z) => ({ key: z.key }));
  if (input.geo.locationTypes?.length) geo['location_types'] = input.geo.locationTypes;

  const spec: TargetingSpec = { geo_locations: geo };

  if (input.excludedGeo) {
    const ex: Record<string, unknown> = {};
    if (input.excludedGeo.countries?.length) ex['countries'] = input.excludedGeo.countries;
    if (input.excludedGeo.regions?.length) ex['regions'] = input.excludedGeo.regions.map((r) => ({ key: r.key }));
    if (input.excludedGeo.cities?.length) ex['cities'] = input.excludedGeo.cities.map(serialiseGeoPoint);
    if (input.excludedGeo.zips?.length) ex['zips'] = input.excludedGeo.zips.map((z) => ({ key: z.key }));
    if (Object.keys(ex).length > 0) spec['excluded_geo_locations'] = ex;
  }

  if (input.ageMin !== undefined) spec['age_min'] = input.ageMin;
  if (input.ageMax !== undefined) spec['age_max'] = input.ageMax;
  if (input.genders?.length) spec['genders'] = input.genders;
  if (input.locales?.length) spec['locales'] = input.locales;

  if (input.interests?.length) {
    // Plain `interests` is a pure OR — adding more WIDENS reach. Callers routinely
    // expect the opposite, so say it out loud rather than let them mis-read the spec.
    spec['interests'] = input.interests.map((i) => ({ id: i.id, ...(i.name !== undefined ? { name: i.name } : {}) }));
    warnings.push(
      `targeting.interests: ${input.interests.length} interests are OR'd together, which widens reach rather than ` +
        `narrowing it. Interest ids rot (v24.0 consolidated options; deprecated ones return 100/1487694) — ` +
        `re-resolve names to ids via the Targeting Search API at publish time, never from cache.`,
    );
  }
  if (input.behaviors?.length) {
    spec['behaviors'] = input.behaviors.map((b) => ({ id: b.id, ...(b.name !== undefined ? { name: b.name } : {}) }));
  }
  if (input.customAudienceIds?.length) {
    assertAudienceCount('custom_audiences', input.customAudienceIds.length);
    spec['custom_audiences'] = input.customAudienceIds.map((id) => ({ id }));
  }
  if (input.excludedCustomAudienceIds?.length) {
    assertAudienceCount('excluded_custom_audiences', input.excludedCustomAudienceIds.length);
    spec['excluded_custom_audiences'] = input.excludedCustomAudienceIds.map((id) => ({ id }));
  }
  if (input.lookalikeAudienceIds?.length) {
    // Lookalikes ride the same field as custom audiences; they are only separated here so
    // the restricted-category refusal can name them specifically. The 500 cap is on the
    // combined field, so it is re-checked after merging rather than per input list.
    const existing = (spec['custom_audiences'] as Array<{ id: string }> | undefined) ?? [];
    const merged = [...existing, ...input.lookalikeAudienceIds.map((id) => ({ id }))];
    assertAudienceCount('custom_audiences', merged.length);
    spec['custom_audiences'] = merged;
  }

  const advantageAudience = input.advantageAudience ?? 1;
  spec['targeting_automation'] = { advantage_audience: advantageAudience };
  if (advantageAudience === 0) {
    warnings.push(
      'targeting.targeting_automation.advantage_audience=0 disables the Advantage+ audience lever, so the ' +
        "campaign's advantage_state reads DISABLED. Verify that is intended before publishing.",
    );
  }

  if (input.placements) {
    applyPlacements(spec, input.placements, warnings);
  }

  return spec;
}

function serialiseGeoPoint(p: GeoPoint): Record<string, unknown> {
  return {
    key: p.key,
    ...(p.radius !== undefined ? { radius: p.radius } : {}),
    ...(p.distanceUnit !== undefined ? { distance_unit: p.distanceUnit } : {}),
  };
}

function assertAudienceCount(field: string, n: number): void {
  if (n > 500) fail(`targeting.${field}`, `${n} audiences exceeds Meta's limit of 500.`);
}

/** Every restriction Meta applies silently, turned into a loud refusal. */
function assertRestrictedTargetingLegal(
  input: TargetingInput,
  countries: readonly string[],
  label: string,
): void {
  if (input.genders?.length) {
    fail(
      'targeting.genders',
      `${label} forbids gender selection ("Specific gender cannot be chosen"). Omit the field entirely — ` +
        `sending [1,2] is not the same as omitting it.`,
    );
  }
  if (input.ageMin !== undefined && input.ageMin !== RESTRICTED_AGE_MIN) {
    fail(
      'targeting.age_min',
      `${label} fixes the age range to ${RESTRICTED_AGE_MIN}-${RESTRICTED_AGE_MAX}+, but age_min is ${input.ageMin}. ` +
        `Meta would accept this and then ignore it.`,
    );
  }
  if (input.ageMax !== undefined && input.ageMax !== RESTRICTED_AGE_MAX) {
    fail(
      'targeting.age_max',
      `${label} fixes the age range to ${RESTRICTED_AGE_MIN}-${RESTRICTED_AGE_MAX}+, but age_max is ${input.ageMax}.`,
    );
  }
  const excluded = input.excludedGeo;
  if (
    excluded &&
    ((excluded.countries?.length ?? 0) > 0 ||
      (excluded.regions?.length ?? 0) > 0 ||
      (excluded.cities?.length ?? 0) > 0 ||
      (excluded.zips?.length ?? 0) > 0)
  ) {
    fail('targeting.excluded_geo_locations', `${label} does not support location exclusion.`);
  }
  if (input.geo.zips?.length) {
    fail(
      'targeting.geo_locations.zips',
      `${label} prohibits these location granularities: ${RESTRICTED_LOCATION_GRANULARITIES.join(', ')}.`,
    );
  }
  if (input.lookalikeAudienceIds?.length) {
    fail(
      'targeting.custom_audiences',
      `${label}: "Lookalike audiences are unavailable for housing, employment, and financial products and services ads."`,
    );
  }
  if (input.behaviors?.length) {
    fail('targeting.behaviors', `${label} blocks Behaviour and Demographic targeting.`);
  }
  if (input.interests?.length) {
    fail(
      'targeting.interests',
      `${label} restricts interests to a previously approved allowlist that this system cannot read, so it ` +
        `refuses to send any. Run the ad broad and let Meta's optimiser find the audience.`,
    );
  }

  const regime = radiusRegime(countries);
  for (const city of input.geo.cities ?? []) {
    if (city.radius === undefined) {
      // The unstated-unit refusal below exists because Meta publishes no default distance
      // unit; it publishes no default RADIUS either, so a bare city key under a restricted
      // category cannot be shown to clear the documented 15 mile / 25 km floor. Meta
      // accepts it and picks its own radius, which is the silent rewrite this module
      // refuses everywhere else.
      fail(
        'targeting.geo_locations.cities.radius',
        `${label} imposes a minimum radius ("at least 15 mile or 25 kilometer radius for the US and Canada, ` +
          `and 15 kilometer radius for Europe"), and city ${city.key} states none. Meta publishes no default ` +
          `radius for a city key, so the floor cannot be shown to be met — state radius and distance_unit ` +
          `explicitly, or target the country/region instead.`,
      );
    }
    if (city.distanceUnit === undefined) {
      fail(
        'targeting.geo_locations.cities.distance_unit',
        `${label} imposes a minimum radius, and the API's default distance unit is undocumented. ` +
          `State "mile" or "kilometer" explicitly for city ${city.key}.`,
      );
    }
    if (regime === 'EUROPE' && city.distanceUnit === 'mile') {
      fail(
        'targeting.geo_locations.cities.radius',
        `${label} in Europe documents a 15 kilometre minimum radius and no mile equivalent. ` +
          `Express city ${city.key} in kilometres so the floor is checkable.`,
      );
    }
    const table = RESTRICTED_MIN_RADIUS[regime];
    const min = city.distanceUnit === 'mile'
      ? ('mile' in table ? table.mile : undefined)
      : table.kilometer;
    if (min !== undefined && city.radius < min) {
      fail(
        'targeting.geo_locations.cities.radius',
        `${label} requires at least ${min} ${city.distanceUnit} for ${regime === 'US_CA' ? 'the US and Canada' : 'Europe'}, ` +
          `but city ${city.key} has radius ${city.radius}.`,
      );
    }
  }
}

/**
 * Which minimum-radius rule applies.
 *
 * US/CA wins on a mixed set because its floors are the higher pair (15 mile / 25 km vs
 * 15 km), and a targeting spec that reaches both must satisfy both.
 */
function radiusRegime(countries: readonly string[]): 'US_CA' | 'EUROPE' {
  if (countries.includes('US') || countries.includes('CA')) return 'US_CA';
  if (countries.some((c) => EU_DSA_COUNTRIES.has(c))) return 'EUROPE';
  return 'US_CA';
}

function applyPlacements(spec: TargetingSpec, p: PlacementInput, warnings: string[]): void {
  const platforms = p.publisherPlatforms ?? [];

  const positionFields: Array<[keyof PlacementInput, string, string]> = [
    ['facebookPositions', 'facebook_positions', 'facebook'],
    ['instagramPositions', 'instagram_positions', 'instagram'],
    ['audienceNetworkPositions', 'audience_network_positions', 'audience_network'],
    ['messengerPositions', 'messenger_positions', 'messenger'],
    ['threadsPositions', 'threads_positions', 'threads'],
  ];

  for (const [inputKey, apiKey, requiredPlatform] of positionFields) {
    const values = p[inputKey] as string[] | undefined;
    if (!values?.length) continue;
    if (platforms.length > 0 && !platforms.includes(requiredPlatform)) {
      fail(
        `targeting.${apiKey}`,
        `positions are set for ${requiredPlatform} but publisher_platforms is [${platforms.join(', ')}]. ` +
          `A position without its platform is a code 100.`,
      );
    }
    if (platforms.length === 0) {
      // The refusal above cannot see this case, and it is the same mistake: positions
      // for a platform that was never named. Meta's reference says an unspecified
      // positions field defaults to every position, but says nothing about a positions
      // field whose platform is unlisted, so this is a warning rather than a refusal.
      warnings.push(
        `targeting.${apiKey}: positions are set for ${requiredPlatform} but publisher_platforms is not set at ` +
          `all. Name the platform explicitly — a position without its platform is a documented code 100, and ` +
          `whether an absent publisher_platforms rescues it is UNVERIFIED.`,
      );
    }
    spec[apiKey] = values;
  }

  for (const pos of p.instagramPositions ?? []) {
    if (REMOVED_INSTAGRAM_POSITIONS.has(pos)) {
      fail(
        'targeting.instagram_positions',
        `"${pos}" was removed in v26.0 and ad sets specifying it error on create. Use "explore_home".`,
      );
    }
  }
  for (const pos of p.messengerPositions ?? []) {
    if (REMOVED_MESSENGER_POSITIONS.has(pos)) {
      fail(
        'targeting.messenger_positions',
        `"${pos}" was silently dropped from messenger_positions in v26.0. Remove it rather than relying on it.`,
      );
    }
  }
  for (const pos of p.facebookPositions ?? []) {
    if (DEAD_FACEBOOK_POSITIONS.has(pos)) {
      warnings.push(
        `targeting.facebook_positions: "${pos}" is still accepted but stopped delivering at v24.0; ` +
          `spend silently shifts to other placements.`,
      );
    }
  }

  if (platforms.length > 0) spec['publisher_platforms'] = platforms;
  if (p.devicePlatforms?.length) spec['device_platforms'] = p.devicePlatforms;

  warnings.push(
    'targeting: manual placements are set, so advantage_placement_state will be DISABLED and with it the ' +
      "campaign's whole advantage_state. Advantage+ placements means sending NO placement fields at all — " +
      'listing every platform is not the same thing.',
  );
}

// ---------------------------------------------------------------------------
// Creative
// ---------------------------------------------------------------------------

/** The complete v26.0 `call_to_action.type` enum, verified character-for-character. */
export const CALL_TO_ACTION_TYPES = [
  'OPEN_LINK', 'LIKE_PAGE', 'SHOP_NOW', 'PLAY_GAME', 'INSTALL_APP', 'USE_APP', 'CALL', 'CALL_ME',
  'VIDEO_CALL', 'INSTALL_MOBILE_APP', 'USE_MOBILE_APP', 'MOBILE_DOWNLOAD', 'BOOK_TRAVEL',
  'LISTEN_MUSIC', 'WATCH_VIDEO', 'LEARN_MORE', 'SIGN_UP', 'DOWNLOAD', 'WATCH_MORE', 'NO_BUTTON',
  'VISIT_PAGES_FEED', 'CALL_NOW', 'APPLY_NOW', 'CONTACT', 'BUY_NOW', 'GET_OFFER',
  'GET_OFFER_VIEW', 'BUY_TICKETS', 'UPDATE_APP', 'GET_DIRECTIONS', 'BUY', 'SEND_UPDATES',
  'MESSAGE_PAGE', 'DONATE', 'SUBSCRIBE', 'SAY_THANKS', 'SELL_NOW', 'SHARE', 'DONATE_NOW',
  'GET_QUOTE', 'CONTACT_US', 'ORDER_NOW', 'START_ORDER', 'ADD_TO_CART', 'VIEW_CART',
  'VIEW_IN_CART', 'VIDEO_ANNOTATION', 'RECORD_NOW', 'INQUIRE_NOW', 'CONFIRM', 'REFER_FRIENDS',
  'REQUEST_TIME', 'GET_SHOWTIMES', 'LISTEN_NOW', 'TRY_DEMO', 'WOODHENGE_SUPPORT',
  'SOTTO_SUBSCRIBE', 'FOLLOW_USER', 'RAISE_MONEY', 'SEE_SHOP', 'GET_DETAILS', 'FIND_OUT_MORE',
  'VISIT_WEBSITE', 'BROWSE_SHOP', 'EVENT_RSVP', 'WHATSAPP_MESSAGE', 'FOLLOW_NEWS_STORYLINE',
  'SEE_MORE', 'BOOK_NOW', 'FIND_A_GROUP', 'FIND_YOUR_GROUPS', 'PAY_TO_ACCESS',
  'PURCHASE_GIFT_CARDS', 'FOLLOW_PAGE', 'SEND_A_GIFT', 'SWIPE_UP_SHOP', 'SWIPE_UP_PRODUCT',
  'SEND_GIFT_MONEY', 'PLAY_GAME_ON_FACEBOOK', 'GET_STARTED', 'OPEN_INSTANT_APP',
  'AUDIO_CALL', 'GET_PROMOTIONS', 'JOIN_CHANNEL', 'MAKE_AN_APPOINTMENT',
  'ASK_ABOUT_SERVICES', 'BOOK_A_CONSULTATION', 'GET_A_QUOTE', 'BUY_VIA_MESSAGE',
  'ASK_FOR_MORE_INFO', 'CHAT_WITH_US', 'VIEW_PRODUCT', 'VIEW_CHANNEL', 'GET_IN_TOUCH',
  'ASK_A_QUESTION', 'START_A_CHAT', 'CHAT_NOW', 'ASK_US', 'WATCH_LIVE_VIDEO',
  'JOIN_LIVE_VIDEO', 'SHOP_WITH_AI', 'TRY_ON_WITH_AI',
] as const;

export type CallToActionType = (typeof CALL_TO_ACTION_TYPES)[number];

const CTA_SET: ReadonlySet<string> = new Set(CALL_TO_ACTION_TYPES);

/**
 * CTA availability per objective is documented only in a client-rendered Help Centre page
 * Meta does not expose to machines, so this is a WARNING source, never a refusal.
 *
 * The corpus-recommended strategy for an unattended system is to submit, catch the code
 * 100 on `call_to_action.type`, and fall back to LEARN_MORE.
 */
export const SAFE_CALL_TO_ACTIONS: Readonly<Record<Objective, readonly CallToActionType[]>> = {
  OUTCOME_AWARENESS: ['LEARN_MORE', 'WATCH_MORE', 'NO_BUTTON'],
  OUTCOME_TRAFFIC: ['LEARN_MORE', 'SHOP_NOW', 'BOOK_NOW', 'DOWNLOAD', 'GET_OFFER'],
  OUTCOME_ENGAGEMENT: ['LEARN_MORE', 'LIKE_PAGE', 'MESSAGE_PAGE', 'WHATSAPP_MESSAGE'],
  OUTCOME_LEADS: ['SIGN_UP', 'APPLY_NOW', 'GET_QUOTE', 'SUBSCRIBE', 'CONTACT_US', 'BOOK_NOW'],
  OUTCOME_SALES: ['SHOP_NOW', 'BUY_NOW', 'ORDER_NOW', 'ADD_TO_CART', 'GET_OFFER'],
  OUTCOME_APP_PROMOTION: ['INSTALL_APP', 'USE_APP', 'PLAY_GAME', 'DOWNLOAD'],
};

/** The CTA every website-destination objective accepts — the documented fallback. */
export const FALLBACK_CALL_TO_ACTION: CallToActionType = 'LEARN_MORE';

/**
 * Display truncation limits for a cross-placement video ad.
 *
 * These are NOT API limits — exceeding them does not error, it truncates behind a
 * "See more" affordance, which on Reels and Stories means the copy is simply never read.
 * Generated to the minimum across the placement set, they are effectively hard.
 */
export const COPY_DISPLAY_LIMITS = { message: 40, title: 27 } as const;

/**
 * API ceilings. UNVERIFIED for `object_story_spec` specifically — these figures are
 * documented for `asset_feed_spec`, and no published limit exists for `video_data`.
 */
export const COPY_API_LIMITS = { message: 1024, title: 255, linkDescription: 255 } as const;

/** The 46 typed keys on `AdCreativeFeaturesSpec`. */
const REFERENCE_FEATURE_KEYS: readonly string[] = [
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'biz_ai', 'creative_stickers',
  'customize_product_recommendation', 'description_automation', 'fb_feed_tag', 'fb_reels_tag',
  'fb_story_tag', 'generate_cta', 'hide_price', 'ig_feed_tag', 'ig_reels_tag', 'ig_stream_tag',
  'image_animation', 'image_background_gen', 'image_templates', 'image_touchups', 'inline_comment',
  'local_store_extension', 'media_order', 'media_type_automation', 'multi_photo_to_video',
  'music_generation', 'pac_relaxation', 'product_extensions', 'profile_card', 'profile_extension',
  'replace_media_text', 'reveal_details_over_time', 'show_destination_blurbs', 'show_summary',
  'site_extensions', 'standard_enhancements', 'standard_enhancements_catalog',
  'text_extraction_for_headline', 'text_extraction_for_tap_target', 'text_optimizations',
  'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_highlights',
  'video_to_image', 'wa_mm_image_filtering', 'wa_mm_text_truncation_length',
];

/**
 * Keys the Advantage+ guide documents and the typed reference does not.
 *
 * They are real and API-settable — the 2026-06-28 out-of-cycle change names
 * `video_filtering` and `video_uncrop` explicitly — but because they are absent from the
 * typed reference you cannot assume they validate. Send them, read the creative back, and
 * diff; a missing key means either "stripped as ineligible" or "rejected as unknown" and
 * you cannot tell which.
 */
const GUIDE_ONLY_FEATURE_KEYS: readonly string[] = [
  'video_auto_crop', 'video_filtering', 'video_uncrop', 'image_uncrop', 'enhance_cta',
  'image_brightness_and_contrast', 'image_text_translation',
];

const KNOWN_FEATURE_KEYS: ReadonlySet<string> = new Set([
  ...REFERENCE_FEATURE_KEYS,
  ...GUIDE_ONLY_FEATURE_KEYS,
]);

/**
 * Every transforming feature, opted out.
 *
 * There is no master off-switch any more — the `standard_enhancements` bundle was
 * decomposed at v22.0 — so holding a generated video exactly as rendered means naming
 * each feature. Two independent reasons this is the default here:
 *
 *  1. Experimental hygiene. If Meta regrades, recrops or rewrites the asset, the ad no
 *     longer tests the creative the generator produced and the learning loop is fitting
 *     noise. `video_filtering` in particular includes SDR->HDR conversion, which will
 *     undo a deliberate colour grade.
 *  2. Rights. Meta's Ad Creative Generative AI Terms say Meta "retains all rights that it
 *     otherwise possesses in Output" and that "use or publication of Output outside of
 *     Meta's platforms is unauthorized" — so any Meta-generated transform poisons an
 *     asset intended for multi-channel use.
 *
 * Secondary sources report that since February 2026 new Sales/Leads/App campaigns launch
 * with every enhancement ON by default (UNVERIFIED). The implication is one-directional
 * and cheap: always send an explicit spec, never rely on the default.
 */
export const CREATIVE_FEATURES_OPT_OUT: readonly string[] = [
  'video_auto_crop', 'video_uncrop', 'video_filtering', 'image_animation', 'image_touchups',
  'image_uncrop', 'image_templates', 'add_text_overlay', 'replace_media_text', 'text_optimizations',
  'description_automation', 'generate_cta', 'enhance_cta', 'creative_stickers', 'music_generation',
  'translate_voiceover', 'text_translation', 'inline_comment', 'adapt_to_placement',
  'pac_relaxation', 'video_highlights', 'video_to_image', 'multi_photo_to_video', 'profile_card',
  // A no-op on v22.0+ writes, kept for older-version compatibility. Harmless.
  'standard_enhancements',
];

/** Meta's own dynamic macros — how an ad joins to first-party analytics with no mapping table. */
export const DEFAULT_URL_TAGS =
  'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}' +
  '&utm_content={{ad.id}}&fb_placement={{placement}}&fb_site={{site_source_name}}';

export interface VideoCreativeInput {
  /** From `POST /act_{id}/advideos`. Must be `video_status: "ready"` — a processing video makes a broken ad. */
  videoId: string;
  /** Poster image hash from `/adimages`. Preferred over imageUrl. */
  imageHash?: string;
  /** Hosted thumbnail URL. Must not be an FB CDN URL — Meta says so explicitly. */
  imageUrl?: string;
  /** Primary text / post body. */
  message: string;
  /** Headline. Cannot be combined with a LIKE_PAGE call to action. */
  title: string;
  linkDescription?: string;
  callToActionType: CallToActionType;
  /**
   * Destination URL. `video_data` has NO `link` field — unlike `link_data`, the URL lives
   * only inside `call_to_action.value.link`. Defaults to the brand's destination URL.
   */
  link?: string;
  /**
   * Instant Form id, for `instant_form_lead`. Goes in `call_to_action.value.lead_gen_form_id`.
   * UNVERIFIED: the corpus documents the field's existence but not the lead-ads recipe.
   */
  leadGenFormId?: string;
  /** Overrides the brand's Instagram identity. Set inside object_story_spec, not top level. */
  instagramUserId?: string;
  /** Per-locale subtitle track ids. */
  captionIds?: string[];
  /** Feature keys to flip back to OPT_IN on top of the exhaustive opt-out baseline. */
  featureOptIns?: string[];
}

// ---------------------------------------------------------------------------
// Request inputs
// ---------------------------------------------------------------------------

export type BidStrategy =
  | 'LOWEST_COST_WITHOUT_CAP'
  | 'LOWEST_COST_WITH_BID_CAP'
  | 'COST_CAP'
  | 'LOWEST_COST_WITH_MIN_ROAS';

export type BudgetLevel = 'campaign' | 'adset';

export type AttributionEventType = 'CLICK_THROUGH' | 'VIEW_THROUGH' | 'ENGAGED_VIDEO_VIEW';

export interface AttributionWindow {
  eventType: AttributionEventType;
  windowDays: number;
  weight?: number;
}

/**
 * Facts read off the ad account, never assumed.
 *
 * `currency` comes from `GET /act_{id}?fields=currency`, `minDailyBudgetMinor` from
 * `GET /act_{id}/minimum_budgets`, and the DSA defaults from
 * `default_dsa_payor` / `default_dsa_beneficiary` on the account node.
 */
export interface AccountContext {
  /** `act_<id>`. Meta requires the prefix in the PATH and forbids the id in the body. */
  adAccountId: string;
  currency: string;
  /** Overrides the offset table. Supply it for any currency in AMBIGUOUS_MINOR_UNIT_CURRENCIES. */
  currencyOffset?: number;
  /** Minor units, from /minimum_budgets. Enforced when present; a create under it errors, not warns. */
  minDailyBudgetMinor?: number;
  defaultDsaPayor?: string;
  defaultDsaBeneficiary?: string;
}

export interface PublishOptions {
  /**
   * Where the budget lives. Campaign level (CBO) is the default: it is the only path to
   * a non-DISABLED advantage_state, and it removes "which ad set gets the money" from
   * the optimiser entirely.
   */
  budgetLevel?: BudgetLevel;
  /**
   * Required by v24.0 when budgets go on ad sets. Deliberately has no default — it turns
   * on up to 20% budget sharing between ad sets, and money movement is not something this
   * module decides on the caller's behalf.
   */
  adSetBudgetSharing?: boolean;
  bidStrategy?: BidStrategy;
  /**
   * Minor units. Required by LOWEST_COST_WITH_BID_CAP and COST_CAP. Note the semantics
   * trap: with `billing_event=IMPRESSIONS` this is per 1,000 occurrences, i.e. a CPM.
   */
  bidAmountMinor?: number;
  /** Lifetime spend ceiling on the campaign, minor units. Floor is $100 USD or local equivalent. */
  spendCapMinor?: number;
  /** Minor units. Use instead of the config's daily budget for a flighted campaign. */
  lifetimeBudgetMinor?: number;
  /** ISO 8601 or a UTC unix timestamp string. */
  startTime?: string;
  /** Mandatory with a lifetime budget. */
  endTime?: string;
  attributionSpec?: readonly AttributionWindow[];
  /**
   * ISO-2 list for `special_ad_category_country`. Falls back to the brand's countries.
   * Never left to Meta's tax-country default: that silently applies the wrong country's
   * restrictions and produces a disapproval nobody can explain.
   */
  specialAdCategoryCountries?: string[];
  dsaPayor?: string;
  dsaBeneficiary?: string;
  /** eTLD+1 only, e.g. `example.com`. Derived from the destination URL when omitted. */
  conversionDomain?: string;
  /** Defaults to DEFAULT_URL_TAGS for website destinations. Pass '' to send none. */
  urlTags?: string;
  /** AdLabel ids attached to every object — the primary reconciliation handle. */
  adLabelIds?: string[];
  /** Epoch ms, for the 37-month start-date check only. Omit and that check is skipped. */
  now?: number;
}

export interface PublishRequest {
  config: ResolvedAdConfig;
  account: AccountContext;
  /** Lineage/variant slug. Same intent -> same names, always. */
  variant: string;
  targeting: TargetingInput;
  creative: VideoCreativeInput;
  options?: PublishOptions;
}

/** A ready-to-send POST: `client.post(path, params, ...)`. */
export interface BuiltRequest {
  /** Graph path WITHOUT a leading slash, e.g. `act_123/campaigns`. */
  path: string;
  params: Record<string, string>;
}

/** Everything is created paused. Activation is a separate, guarded call. */
export const CREATE_STATUS = 'PAUSED' as const;

/** Auction is the only buying type this system uses; RESERVED is reach-and-frequency. */
export const BUYING_TYPE = 'AUCTION' as const;

/** The default optimisation attribution window, set explicitly so the account stays homogeneous. */
export const DEFAULT_ATTRIBUTION_SPEC: readonly AttributionWindow[] = [
  { eventType: 'CLICK_THROUGH', windowDays: 7 },
  { eventType: 'VIEW_THROUGH', windowDays: 1 },
];

// ---------------------------------------------------------------------------
// Shared validation and normalisation
// ---------------------------------------------------------------------------

interface Prepared {
  req: PublishRequest;
  config: ResolvedAdConfig;
  spec: ArchetypeSpec;
  account: AccountContext;
  offset: number;
  options: PublishOptions;
  budgetLevel: BudgetLevel;
  bidStrategy: BidStrategy;
  names: Record<ObjectLevel, string>;
  targeting: Record<string, unknown>;
  categories: readonly SpecialAdCategory[];
  categoryCountries: readonly string[];
  dsa: { payor: string; beneficiary: string } | undefined;
  link: string | undefined;
  warnings: string[];
}

/**
 * Validates the whole request once, so an illegal tree cannot be published one legal-looking
 * object at a time. Every builder runs this, which costs a few microseconds and removes the
 * failure mode where the campaign lands and the ad set is rejected.
 */
function prepare(req: PublishRequest): Prepared {
  const warnings: string[] = [];
  const options = req.options ?? {};
  const { config, account } = req;
  const { brand, spec, destination } = config;

  if (!account.adAccountId.startsWith('act_')) {
    fail(
      'path',
      `adAccountId "${account.adAccountId}" must carry the act_ prefix — Meta rejects the path without it, ` +
        `and the id must never appear in the request body.`,
    );
  }
  if (account.adAccountId !== brand.adAccountId) {
    fail(
      'path',
      `AccountContext is for ${account.adAccountId} but brand "${brand.id}" publishes to ${brand.adAccountId}. ` +
        `Refusing to publish into the wrong ad account.`,
    );
  }

  // objectives.validateSpec is the legality matrix, but resolveAdConfig is the only
  // caller of it. This module is the last gate before the transport, so a ResolvedAdConfig
  // assembled anywhere else — by hand, or by an optimiser rebuilding a variant — must not
  // be able to walk an illegal objective/destination_type/billing_event tuple onto the wire.
  try {
    validateSpec(spec);
  } catch (e) {
    if (e instanceof IllegalTupleError) {
      fail(e.message.startsWith('billing_event') ? 'billing_event' : 'destination_type', e.message);
    }
    throw e;
  }

  const offset = resolveOffset(account);

  if (spec.confidence === 'inferred') {
    warnings.push(
      `archetype ${spec.archetype}: the objective/optimization_goal/billing_event tuple is INFERRED, not ` +
        `documented. ${spec.note}`,
    );
  }

  // --- special ad categories -------------------------------------------------
  const categories = brand.specialAdCategories;
  if (categories.length === 0) {
    fail(
      'special_ad_categories',
      'is required on every campaign create and must be an array. Send ["NONE"] for ordinary commercial ' +
        'advertising; omitting it is a hard code 100.',
    );
  }
  if (categories.includes('ISSUES_ELECTIONS_POLITICS')) {
    fail(
      'special_ad_categories',
      'ISSUES_ELECTIONS_POLITICS requires SIEP advertiser authorization, which is a manual multi-day ID and ' +
        'mailed-code process with no API, and the EU has prohibited political advertising outright since ' +
        '2025-10-06. This system refuses to publish it rather than fail at Meta or breach the ban.',
    );
  }

  const nonNone = categories.filter((c) => c !== 'NONE');
  const categoryCountries = (options.specialAdCategoryCountries ?? brand.countries).map((c) => c.toUpperCase());
  if (nonNone.length > 0 && categoryCountries.length === 0) {
    fail(
      'special_ad_category_country',
      `${nonNone.join(', ')} needs an explicit country list. Left unset Meta defaults it to the account's ` +
        `listed tax country, which applies the wrong jurisdiction's targeting restrictions and produces a ` +
        `disapproval nobody can explain.`,
    );
  }

  // --- targeting -------------------------------------------------------------
  const targeting = buildTargeting(req.targeting, categories, warnings);

  // --- EU DSA ----------------------------------------------------------------
  const dsa = resolveDsa(req, warnings);

  // --- budget ----------------------------------------------------------------
  const budgetLevel = options.budgetLevel ?? 'campaign';
  const bidStrategy = options.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP';
  validateBudget(req, offset, budgetLevel, bidStrategy, warnings);
  validateSchedule(options, warnings);

  if (budgetLevel === 'adset') {
    if (options.adSetBudgetSharing === undefined) {
      fail(
        'is_adset_budget_sharing_enabled',
        'is required on campaign creation when budgets go on ad sets (v24.0+), and it has no default here ' +
          'because it enables up to 20% budget sharing between ad sets. State true or false explicitly.',
      );
    }
    warnings.push(
      'budgetLevel=adset sets advantage_budget_state to DISABLED, which forces the campaign advantage_state ' +
        'to DISABLED. Campaign-level budget is the only Advantage+ path.',
    );
  }

  // --- destination link ------------------------------------------------------
  const link = resolveLink(req, warnings);

  // --- names -----------------------------------------------------------------
  const nameFor = (level: ObjectLevel): string =>
    objectName({ brandId: brand.id, archetype: spec.archetype, level, variant: req.variant });
  const names: Record<ObjectLevel, string> = {
    campaign: nameFor('campaign'),
    adset: nameFor('adset'),
    ad: nameFor('ad'),
    creative: nameFor('creative'),
  };

  validateCreative(req, spec, link, warnings);
  validatePromotedObject(spec, destination);

  return {
    req, config, spec, account, offset, options, budgetLevel, bidStrategy, names, targeting,
    categories, categoryCountries, dsa, link, warnings,
  };
}

function resolveOffset(account: AccountContext): number {
  if (account.currencyOffset !== undefined) {
    if (!Number.isInteger(account.currencyOffset) || account.currencyOffset < 1) {
      fail('currency', `currencyOffset must be a positive integer, got ${account.currencyOffset}.`);
    }
    return account.currencyOffset;
  }
  return currencyOffset(account.currency);
}

function resolveDsa(req: PublishRequest, warnings: string[]): { payor: string; beneficiary: string } | undefined {
  const { options = {}, account } = req;
  const payor = options.dsaPayor ?? account.defaultDsaPayor;
  const beneficiary = options.dsaBeneficiary ?? account.defaultDsaBeneficiary;
  const exposure = euExposure(req.targeting.geo);

  if (exposure !== 'NO' && (payor === undefined || beneficiary === undefined)) {
    const missing = [
      ...(payor === undefined ? ['dsa_payor'] : []),
      ...(beneficiary === undefined ? ['dsa_beneficiary'] : []),
    ];
    const why = exposure === 'YES'
      ? 'this ad set targets the EU or an associated territory'
      : 'this ad set carries city/region/zip keys, which are opaque numeric ids Meta ORs with the country ' +
        'list, so EU reach cannot be ruled out';
    fail(
      missing.join(' and '),
      `${why}, and BOTH dsa_payor and dsa_beneficiary are required there. Neither is flagged [required] in ` +
        `Meta's parameter table — the requirement is prose only, so a schema-driven client omits them silently ` +
        `and fails at publish. Set them, or read default_dsa_payor / default_dsa_beneficiary off the account.`,
    );
  }

  if (payor === undefined || beneficiary === undefined) {
    warnings.push(
      'dsa_payor / dsa_beneficiary are unset. Targeting looks non-EU so the publish will succeed, but the ' +
        'policy guidance is to set them unconditionally: they are silently discarded outside the EU, and the ' +
        'obligation re-triggers on every new, duplicated or significantly edited ad.',
    );
    return undefined;
  }

  for (const [field, value] of [['dsa_payor', payor], ['dsa_beneficiary', beneficiary]] as const) {
    if (value.length === 0) fail(field, 'is empty; it must name the legal entity.');
    if (value.length > DSA_FIELD_MAX_LENGTH) {
      fail(field, `is ${value.length} chars, over Meta's ${DSA_FIELD_MAX_LENGTH} limit.`);
    }
  }
  return { payor, beneficiary };
}

function validateBudget(
  req: PublishRequest,
  offset: number,
  budgetLevel: BudgetLevel,
  bidStrategy: BidStrategy,
  warnings: string[],
): void {
  const { options = {}, account, config } = req;
  const daily = config.dailyBudgetMinor;
  const lifetime = options.lifetimeBudgetMinor;

  const amount = lifetime ?? daily;
  const field = lifetime !== undefined ? 'lifetime_budget' : 'daily_budget';

  if (!Number.isInteger(amount)) {
    fail(field, `is ${amount}; budgets are integers in the account's minor units, not fractions.`);
  }
  if (amount <= 0) fail(field, `must be greater than zero, got ${amount}.`);

  if (lifetime === undefined && account.minDailyBudgetMinor !== undefined && daily < account.minDailyBudgetMinor) {
    fail(
      'daily_budget',
      `${formatMinor(daily, account.currency, offset)} is below the account minimum of ` +
        `${formatMinor(account.minDailyBudgetMinor, account.currency, offset)} from GET /act_{id}/minimum_budgets. ` +
        `Meta fails the create with a budget error, it does not warn.`,
    );
  }

  const ceiling = config.brand.spend.maxDailyBudgetMinor;
  if (config.dailyBudgetMinor > ceiling) {
    fail(
      'daily_budget',
      `${formatMinor(config.dailyBudgetMinor, account.currency, offset)} exceeds brand "${config.brand.id}" ` +
        `ceiling of ${formatMinor(ceiling, account.currency, offset)}. ` +
        `The envelope is the only spend authority in the system.`,
    );
  }

  if (lifetime !== undefined) {
    // The brand ceiling is a DAILY RATE, so a lifetime budget walks straight past it
    // unless the flight length is known: "spend 5,000,000 by some end date" carries no
    // rate at all. This is the one place in the module where the envelope — the system's
    // only spend authority — could be escaped without anyone noticing, so an unbounded
    // flight is refused rather than approximated.
    const endTime = options.endTime;
    if (endTime === undefined) {
      fail('lifetime_budget', 'requires end_time; Meta paces a lifetime budget across a flight and needs its end.');
    }
    const startTime = options.startTime;
    if (startTime === undefined) {
      fail(
        'start_time',
        `a lifetime_budget of ${formatMinor(lifetime, account.currency, offset)} only becomes a daily spend ` +
          `rate once the flight length is known, and brand "${config.brand.id}" caps that rate at ` +
          `${formatMinor(ceiling, account.currency, offset)}/day. Set start_time alongside end_time so the ` +
          `implied rate can be checked; this module will not publish a lifetime budget it cannot bound.`,
      );
    }
    const start = parseTime('start_time', startTime);
    // A non-positive flight is left to validateSchedule, which names it properly.
    const end = parseTime('end_time', endTime);
    const days = (end - start) / 86_400_000;
    if (days > 0) {
      const impliedDaily = Math.ceil(lifetime / days);
      if (impliedDaily > ceiling) {
        fail(
          'lifetime_budget',
          `${formatMinor(lifetime, account.currency, offset)} over a ${days.toFixed(1)}-day flight paces at ` +
            `${formatMinor(impliedDaily, account.currency, offset)}/day, above brand "${config.brand.id}" ` +
            `ceiling of ${formatMinor(ceiling, account.currency, offset)}/day. Meta paces a lifetime budget ` +
            `across the flight, so the envelope applies to the implied rate, not just to daily_budget.`,
        );
      }
    }

    if (budgetLevel === 'campaign') {
      // start_time / end_time are AD SET fields in this builder, so a campaign holding
      // the lifetime budget carries no flight of its own. The corpus documents
      // lifetime_budget on the campaign node but no campaign-level flight end, so
      // whether Meta demands one here is UNVERIFIED — settle it on the first live create
      // rather than inventing a field name.
      warnings.push(
        'lifetime_budget is on the campaign while the flight (start_time/end_time) is on the ad set. Whether a ' +
          'campaign-level lifetime budget also needs its own end field is UNVERIFIED in the research corpus; if ' +
          'the create fails with a generic code 100 naming the budget, this is the first thing to check.',
      );
    }
  }

  if (offset === 1) {
    warnings.push(
      `budget: ${account.currency} has offset 1, so ${amount} means ${amount} whole units, not ` +
        `${amount / 100}. Confirm the figure was computed against the account's currency and not divided by 100.`,
    );
  }

  if (bidStrategy === 'LOWEST_COST_WITH_BID_CAP' || bidStrategy === 'COST_CAP') {
    if (options.bidAmountMinor === undefined) {
      fail('bid_amount', `is required by bid_strategy=${bidStrategy}.`);
    }
    if (!Number.isInteger(options.bidAmountMinor) || options.bidAmountMinor <= 0) {
      fail('bid_amount', `must be a positive integer in minor units, got ${options.bidAmountMinor}.`);
    }
    // The classic off-by-1000: with IMPRESSIONS billing this figure is a CPM, not a CPA.
    if (config.spec.billingEvent === 'IMPRESSIONS') {
      warnings.push(
        `bid_amount ${options.bidAmountMinor} is per 1,000 occurrences because billing_event=IMPRESSIONS — ` +
          `it is a CPM of ${formatMinor(options.bidAmountMinor, account.currency, offset)}, not a cost per action.`,
      );
    }
  } else if (options.bidAmountMinor !== undefined) {
    fail('bid_amount', `is not accepted with bid_strategy=${bidStrategy}; Meta returns a code 100.`);
  }

  if (bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    fail(
      'bid_strategy',
      'LOWEST_COST_WITH_MIN_ROAS requires a ROAS floor whose field name is not established in the research ' +
        'corpus. Refusing to guess it — settle the field against a live account first.',
    );
  }

  if (options.spendCapMinor !== undefined) {
    if (!Number.isInteger(options.spendCapMinor) || options.spendCapMinor <= 0) {
      fail('spend_cap', `must be a positive integer in minor units, got ${options.spendCapMinor}.`);
    }
    const code = account.currency.toUpperCase();
    const usdFloorMinor = 100 * offset;
    if (code === 'USD' && options.spendCapMinor < usdFloorMinor) {
      fail(
        'spend_cap',
        `${formatMinor(options.spendCapMinor, code, offset)} is under Meta's $100 USD minimum for spend_cap.`,
      );
    }
    if (code !== 'USD') {
      warnings.push(
        `spend_cap: Meta's floor is "$100 USD or approximate local equivalent" and publishes no ${code} figure. ` +
          `UNVERIFIED whether ${formatMinor(options.spendCapMinor, code, offset)} clears it.`,
      );
    }
  }
}

function validateSchedule(options: PublishOptions, warnings: string[]): void {
  const start = options.startTime !== undefined ? parseTime('start_time', options.startTime) : undefined;
  const end = options.endTime !== undefined ? parseTime('end_time', options.endTime) : undefined;

  if (start !== undefined && end !== undefined) {
    if (end <= start) fail('end_time', `${options.endTime} is not after start_time ${options.startTime}.`);
    // A daily budget is illegal on a flight shorter than 24h; the same-day case needs a lifetime budget.
    const hours = (end - start) / 3_600_000;
    if (options.lifetimeBudgetMinor === undefined && hours <= 24) {
      fail(
        'daily_budget',
        `the flight is ${hours.toFixed(1)}h, and daily_budget is "allowed only for ad sets with a duration ` +
          `longer than 24 hours". A same-day flight must use lifetime_budget with an end_time.`,
      );
    }
  }

  if (start !== undefined && options.now !== undefined) {
    const limit = new Date(options.now);
    limit.setMonth(limit.getMonth() + 37);
    if (start > limit.getTime()) {
      fail('start_time', `${options.startTime} is more than 37 months out; Meta returns error 3018.`);
    }
    if (start < options.now) {
      warnings.push(`start_time ${options.startTime} is in the past; delivery begins immediately on activation.`);
    }
  }
}

function parseTime(field: string, value: string): number {
  // A bare unix timestamp is legal on these fields, and Date.parse would read "1767225600"
  // as a year, so digits-only is handled before falling back to ISO 8601.
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail(field, `"${value}" is not ISO 8601 or a unix timestamp.`);
  return ms;
}

/**
 * Whether this archetype's creative carries a click URL at all.
 *
 * An Instant Form IS the destination — there is nowhere to click through to — and a
 * catalogue ad derives its link per product from the feed, so neither can supply one.
 * Everything else must, because `video_data` has no `link` field of its own.
 */
function linkRequirement(archetype: ConversionArchetype): 'required' | 'optional' | 'forbidden' {
  if (archetype === 'instant_form_lead') return 'forbidden';
  if (archetype === 'catalog_sales') return 'optional';
  return 'required';
}

function resolveLink(req: PublishRequest, warnings: string[]): string | undefined {
  const { config, creative } = req;
  // An app-install ad clicks through to the store listing, which is already declared on
  // the destination as object_store_url; there is no second URL to ask the caller for.
  const link = creative.link ?? config.destination.url ?? config.destination.objectStoreUrl;
  const requirement = linkRequirement(config.spec.archetype);

  if (requirement === 'forbidden') {
    if (creative.leadGenFormId === undefined && config.destination.leadFormId === undefined) {
      fail(
        'object_story_spec.video_data.call_to_action.value.lead_gen_form_id',
        'instant_form_lead needs a lead form id; the form is the destination and there is no URL to fall back on.',
      );
    }
    return undefined;
  }

  if (link === undefined) {
    if (requirement === 'optional') return undefined;
    fail(
      'object_story_spec.video_data.call_to_action.value.link',
      `archetype ${config.spec.archetype} needs a destination URL. video_data has NO link field of its own — ` +
        `unlike link_data, the URL lives only inside call_to_action.value.link.`,
    );
  }

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return fail('call_to_action.value.link', `"${link}" is not an absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('call_to_action.value.link', `"${link}" must be http or https.`);
  }
  if (url.hash !== '') {
    // Meta appends url_tags with '&'; on a URL with a fragment the params can land after
    // the '#' and become invisible to server-side analytics.
    fail(
      'call_to_action.value.link',
      `"${link}" contains a fragment. Meta appends url_tags to the query string, and on a fragmented URL the ` +
        `tracking params can land after the '#' where server-side analytics never sees them. Strip it.`,
    );
  }
  if (url.search !== '') {
    warnings.push(
      `call_to_action.value.link already has a query string; Meta appends url_tags with '&'. Check for ` +
        `duplicated parameters.`,
    );
  }
  return link;
}

function validateCreative(
  req: PublishRequest,
  spec: ArchetypeSpec,
  link: string | undefined,
  warnings: string[],
): void {
  const c = req.creative;

  if (c.videoId.trim() === '') fail('object_story_spec.video_data.video_id', 'is empty.');

  const hasHash = c.imageHash !== undefined && c.imageHash !== '';
  const hasUrl = c.imageUrl !== undefined && c.imageUrl !== '';
  if (hasHash === hasUrl) {
    fail(
      'object_story_spec.video_data.image_hash',
      hasHash
        ? 'exactly one of image_hash or image_url may be set; both were given.'
        : 'a poster is required — set image_hash (from POST /act_{id}/adimages) or image_url.',
    );
  }
  if (hasUrl && /(^|\.)fbcdn\.net$/i.test(safeHost(c.imageUrl ?? ''))) {
    fail(
      'object_story_spec.video_data.image_url',
      'is an FB CDN URL. Meta says explicitly: "You should not use image URLs returned from the FB CDN." ' +
        'Upload the poster to /adimages and pass image_hash instead.',
    );
  }

  if (c.message.trim() === '') fail('object_story_spec.video_data.message', 'is empty.');
  if (c.title.trim() === '') fail('object_story_spec.video_data.title', 'is empty.');

  if (c.message.length > COPY_API_LIMITS.message) {
    fail('object_story_spec.video_data.message', `is ${c.message.length} chars, over the ${COPY_API_LIMITS.message} limit.`);
  }
  if (c.title.length > COPY_API_LIMITS.title) {
    fail('object_story_spec.video_data.title', `is ${c.title.length} chars, over the ${COPY_API_LIMITS.title} limit.`);
  }
  if (c.linkDescription !== undefined && c.linkDescription.length > COPY_API_LIMITS.linkDescription) {
    fail(
      'object_story_spec.video_data.link_description',
      `is ${c.linkDescription.length} chars, over the ${COPY_API_LIMITS.linkDescription} limit.`,
    );
  }

  if (c.message.length > COPY_DISPLAY_LIMITS.message) {
    warnings.push(
      `object_story_spec.video_data.message is ${c.message.length} chars; the cross-placement display limit is ` +
        `${COPY_DISPLAY_LIMITS.message} (Facebook Reels). It will not error — it truncates behind "See more", ` +
        `which on Reels means the copy is never read.`,
    );
  }
  if (c.title.length > COPY_DISPLAY_LIMITS.title) {
    warnings.push(
      `object_story_spec.video_data.title is ${c.title.length} chars; the Facebook Feed display limit is ` +
        `${COPY_DISPLAY_LIMITS.title} and it truncates silently.`,
    );
  }

  if (!CTA_SET.has(c.callToActionType)) {
    fail('object_story_spec.video_data.call_to_action.type', `"${c.callToActionType}" is not in the v26.0 enum.`);
  }
  if (c.callToActionType === 'LIKE_PAGE') {
    // The title field is documented as incompatible with LIKE_PAGE, and title is required here.
    fail(
      'object_story_spec.video_data.call_to_action.type',
      'LIKE_PAGE cannot be used with a title, and this builder always sets one.',
    );
  }
  const safe = SAFE_CALL_TO_ACTIONS[spec.objective];
  if (!safe.includes(c.callToActionType)) {
    warnings.push(
      `call_to_action.type=${c.callToActionType} is outside the known-safe set for ${spec.objective} ` +
        `(${safe.join(', ')}). CTA-by-objective availability is UNVERIFIED — Meta documents it only in a ` +
        `client-rendered Help Centre page. On a code 100 naming call_to_action, retry with ` +
        `${FALLBACK_CALL_TO_ACTION}.`,
    );
  }

  for (const key of c.featureOptIns ?? []) {
    if (!KNOWN_FEATURE_KEYS.has(key)) {
      fail(
        'degrees_of_freedom_spec.creative_features_spec',
        `"${key}" is not a known creative feature key. Meta silently deletes keys it does not recognise, so a ` +
          `typo would look like a working opt-in.`,
      );
    }
    if (GUIDE_ONLY_FEATURE_KEYS.includes(key)) {
      warnings.push(
        `degrees_of_freedom_spec: "${key}" is documented on the Advantage+ guide but absent from the typed ` +
          `AdCreativeFeaturesSpec reference, so it may be stripped OR rejected as unknown. GET the creative ` +
          `back and diff the effective spec.`,
      );
    }
  }

  if (req.creative.instagramUserId === undefined && req.config.brand.instagramUserId === undefined) {
    warnings.push(
      'object_story_spec.instagram_user_id is unset. Instagram placements fall back to a Page-Backed Instagram ' +
        'Account, whose handle renders in black and non-clickable — a visible branding penalty, not a failure.',
    );
  }

  if (link === undefined && linkRequirement(spec.archetype) === 'required') {
    fail('call_to_action.value.link', 'is required for this archetype.');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function validatePromotedObject(spec: ArchetypeSpec, dest: ResolvedAdConfig['destination']): void {
  // brand.ts already enforces presence for the fields it knows about; this catches the one
  // it does not — catalogue sales need custom_event_type alongside product_set_id.
  if (spec.promotedObject === 'product_set' && dest.customEventType === undefined) {
    fail(
      'promoted_object.custom_event_type',
      `${spec.archetype} maps to promoted_object {product_set_id, custom_event_type} and the event type is ` +
        `missing. This module will not default it — the wrong conversion event optimises for the wrong outcome ` +
        `and spends real money doing it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function put(params: Record<string, string>, key: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return;
  params[key] = typeof value === 'string' ? value : String(value);
}

function putJson(params: Record<string, string>, key: string, value: unknown): void {
  if (value === undefined) return;
  params[key] = JSON.stringify(value);
}

function adLabels(ids: readonly string[] | undefined): Array<{ id: string }> | undefined {
  if (!ids || ids.length === 0) return undefined;
  return ids.map((id) => ({ id }));
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Validates the whole publish request and returns the non-fatal warnings.
 *
 * Call this before any network I/O. Anything genuinely illegal throws; what comes back is
 * the list of things Meta will accept but that a human should see in the log — inferred
 * tuples, UNVERIFIED limits, silently-degrading choices.
 */
export function validatePublishRequest(req: PublishRequest): string[] {
  return prepare(req).warnings;
}

/**
 * `POST /act_{id}/campaigns`.
 *
 * Campaign-level budget by default: it is the only route to a non-DISABLED
 * `advantage_state`, and it deletes an entire class of "which ad set gets the money"
 * logic from the optimiser.
 */
export function buildCampaignRequest(req: PublishRequest): BuiltRequest {
  const p = prepare(req);
  const { options, account, spec, config } = p;
  const params: Record<string, string> = {};

  put(params, 'name', p.names.campaign);
  put(params, 'objective', spec.objective);
  put(params, 'status', CREATE_STATUS);
  put(params, 'buying_type', BUYING_TYPE);

  // Required on every create, must be an ARRAY, and omitting it is the single most common
  // first-call failure in the whole API.
  putJson(params, 'special_ad_categories', [...p.categories]);
  if (p.categories.some((c) => c !== 'NONE')) {
    putJson(params, 'special_ad_category_country', [...p.categoryCountries]);
  }

  if (p.budgetLevel === 'campaign') {
    if (options.lifetimeBudgetMinor !== undefined) {
      put(params, 'lifetime_budget', options.lifetimeBudgetMinor);
    } else {
      put(params, 'daily_budget', config.dailyBudgetMinor);
    }
    // bid_strategy belongs wherever the budget is; setting it in both places is a code 100.
    put(params, 'bid_strategy', p.bidStrategy);
    put(params, 'bid_amount', options.bidAmountMinor);
  } else {
    put(params, 'is_adset_budget_sharing_enabled', options.adSetBudgetSharing);
  }

  put(params, 'spend_cap', options.spendCapMinor);
  putJson(params, 'adlabels', adLabels(options.adLabelIds));

  return { path: `${account.adAccountId}/campaigns`, params };
}

/**
 * `POST /act_{id}/adsets`.
 *
 * Placement fields are emitted only when the caller asked for manual placements: the
 * absence of `publisher_platforms`, `*_positions` and `device_platforms` IS Advantage+
 * placements. Listing every platform you care about is not the same thing and silently
 * disables the campaign's advantage_state.
 */
export function buildAdSetRequest(req: PublishRequest, refs: { campaignId: string }): BuiltRequest {
  const p = prepare(req);
  const { options, account, spec, config } = p;

  if (refs.campaignId.trim() === '') fail('campaign_id', 'is empty; create the campaign first.');

  const params: Record<string, string> = {};
  put(params, 'name', p.names.adset);
  put(params, 'campaign_id', refs.campaignId);
  put(params, 'status', CREATE_STATUS);
  put(params, 'billing_event', spec.billingEvent);
  put(params, 'optimization_goal', spec.optimizationGoal);

  // Omitted entirely, never sent as an empty string, when the archetype says so:
  // OUTCOME_TRAFFIC does not list WEBSITE as legal, so sending the obvious value is the bug.
  put(params, 'destination_type', spec.destinationType);

  putJson(params, 'targeting', p.targeting);

  const promoted = promotedObjectFor(spec, config);
  if (promoted !== undefined) putJson(params, 'promoted_object', promoted);

  if (p.budgetLevel === 'adset') {
    if (options.lifetimeBudgetMinor !== undefined) {
      put(params, 'lifetime_budget', options.lifetimeBudgetMinor);
    } else {
      put(params, 'daily_budget', config.dailyBudgetMinor);
    }
    put(params, 'bid_strategy', p.bidStrategy);
    put(params, 'bid_amount', options.bidAmountMinor);
  }

  put(params, 'start_time', options.startTime);
  put(params, 'end_time', options.endTime);

  const attribution = options.attributionSpec ?? defaultAttributionFor(spec);
  if (attribution !== undefined) {
    putJson(
      params,
      'attribution_spec',
      attribution.map((w) => ({
        event_type: w.eventType,
        window_days: w.windowDays,
        ...(w.weight !== undefined ? { weight: w.weight } : {}),
      })),
    );
  }

  if (p.dsa !== undefined) {
    put(params, 'dsa_payor', p.dsa.payor);
    put(params, 'dsa_beneficiary', p.dsa.beneficiary);
  }

  putJson(params, 'adlabels', adLabels(options.adLabelIds));

  return { path: `${account.adAccountId}/adsets`, params };
}

/**
 * The attribution window is the OPTIMISATION window, not the reporting one.
 *
 * Sent only for conversion-optimised ad sets, because supported window lengths vary by
 * optimization goal and objective and an unsupported pair is another undifferentiated
 * code 100.
 */
function defaultAttributionFor(spec: ArchetypeSpec): readonly AttributionWindow[] | undefined {
  if (spec.optimizationGoal === 'OFFSITE_CONVERSIONS' || spec.optimizationGoal === 'VALUE') {
    return DEFAULT_ATTRIBUTION_SPEC;
  }
  return undefined;
}

/** Each archetype needs a different promoted_object; a wrong shape fails as a generic code 100. */
function promotedObjectFor(spec: ArchetypeSpec, config: ResolvedAdConfig): Record<string, string> | undefined {
  const d = config.destination;
  switch (spec.promotedObject) {
    case 'pixel_event':
      return { pixel_id: required(d.pixelId, 'promoted_object.pixel_id'), custom_event_type: required(d.customEventType, 'promoted_object.custom_event_type') };
    case 'page':
      return { page_id: required(config.brand.pageId, 'promoted_object.page_id') };
    case 'app':
      return {
        application_id: required(d.applicationId, 'promoted_object.application_id'),
        object_store_url: required(d.objectStoreUrl, 'promoted_object.object_store_url'),
      };
    case 'product_set':
      return {
        product_set_id: required(d.productSetId, 'promoted_object.product_set_id'),
        custom_event_type: required(d.customEventType, 'promoted_object.custom_event_type'),
      };
    case 'none':
      return undefined;
  }
}

function required(value: string | undefined, field: string): string {
  if (value === undefined || value === '') fail(field, 'is required for this archetype and is missing.');
  return value;
}

/**
 * `POST /act_{id}/adcreatives`.
 *
 * Note that every `AdCreativeVideoData` field is individually optional in the reference —
 * the validity constraint is cross-field and is enforced when the AD is created, not when
 * the creative is. A creative can therefore be created successfully and blow up one call
 * later, which is why the checks live here rather than being left to Meta.
 */
export function buildCreativeRequest(req: PublishRequest): BuiltRequest {
  const p = prepare(req);
  const { options, account, config, spec } = p;
  const c = req.creative;

  if (spec.archetype === 'catalog_sales') {
    fail(
      'object_story_spec',
      'catalogue ads are a different creative shape — they use template_data driven by the product feed, not ' +
        'video_data. This builder makes single-video creatives only. The campaign and ad set builders still ' +
        'apply; attach a catalogue creative built elsewhere.',
    );
  }

  const value: Record<string, unknown> = {};
  if (p.link !== undefined) value['link'] = p.link;
  const formId = c.leadGenFormId ?? config.destination.leadFormId;
  if (spec.archetype === 'instant_form_lead' && formId !== undefined) {
    value['lead_gen_form_id'] = formId;
  }

  const videoData: Record<string, unknown> = {
    video_id: c.videoId,
    ...(c.imageHash !== undefined ? { image_hash: c.imageHash } : {}),
    ...(c.imageUrl !== undefined ? { image_url: c.imageUrl } : {}),
    message: c.message,
    title: c.title,
    ...(c.linkDescription !== undefined ? { link_description: c.linkDescription } : {}),
    ...(c.captionIds?.length ? { caption_ids: c.captionIds } : {}),
    call_to_action: { type: c.callToActionType, value },
  };

  const instagramUserId = c.instagramUserId ?? config.brand.instagramUserId;
  const objectStorySpec: Record<string, unknown> = {
    page_id: config.brand.pageId,
    // Set INSIDE object_story_spec. The top-level instagram_user_id on the AdCreative node
    // is what you read back; writing both to different values is undefined behaviour.
    ...(instagramUserId !== undefined ? { instagram_user_id: instagramUserId } : {}),
    video_data: videoData,
  };

  const params: Record<string, string> = {};
  put(params, 'name', p.names.creative);
  putJson(params, 'object_story_spec', objectStorySpec);

  const optIns = new Set(c.featureOptIns ?? []);
  const features: Record<string, { enroll_status: 'OPT_IN' | 'OPT_OUT' }> = {};
  for (const key of CREATIVE_FEATURES_OPT_OUT) {
    features[key] = { enroll_status: optIns.has(key) ? 'OPT_IN' : 'OPT_OUT' };
  }
  for (const key of optIns) {
    if (features[key] === undefined) features[key] = { enroll_status: 'OPT_IN' };
  }
  putJson(params, 'degrees_of_freedom_spec', { creative_features_spec: features });

  const urlTags = options.urlTags ?? (p.link !== undefined ? DEFAULT_URL_TAGS : undefined);
  if (urlTags !== undefined && urlTags !== '') {
    if (urlTags.startsWith('?') || urlTags.startsWith('&')) {
      fail('url_tags', `"${urlTags}" must not start with ? or & — Meta supplies the separator.`);
    }
    put(params, 'url_tags', urlTags);
  }

  putJson(params, 'adlabels', adLabels(options.adLabelIds));

  return { path: `${account.adAccountId}/adcreatives`, params };
}

/**
 * `POST /act_{id}/ads`.
 *
 * `conversion_domain` is required whenever the campaign shares data with a pixel and must
 * be the first- and second-level domain only — `example.com`, never the full URL and
 * never a subdomain.
 */
export function buildAdRequest(
  req: PublishRequest,
  refs: { adSetId: string; creativeId: string },
): BuiltRequest {
  const p = prepare(req);
  const { options, account, spec } = p;

  if (refs.adSetId.trim() === '') fail('adset_id', 'is empty; create the ad set first.');
  if (refs.creativeId.trim() === '') fail('creative.creative_id', 'is empty; create the creative first.');

  const params: Record<string, string> = {};
  put(params, 'name', p.names.ad);
  put(params, 'adset_id', refs.adSetId);
  putJson(params, 'creative', { creative_id: refs.creativeId });
  put(params, 'status', CREATE_STATUS);

  // Required for a pixel-sharing campaign; emitted for any other archetype only when the
  // caller states it, since Meta infers it from the destination on the ones that can.
  if (spec.promotedObject === 'pixel_event' || options.conversionDomain !== undefined) {
    put(params, 'conversion_domain', conversionDomain(p.link, options.conversionDomain));
  }

  putJson(params, 'adlabels', adLabels(options.adLabelIds));

  return { path: `${account.adAccountId}/ads`, params };
}

/**
 * Public suffixes with two labels. Deriving `example.co.uk` -> `co.uk` would send Meta a
 * bare public suffix, so those hosts must be stated explicitly rather than guessed. This
 * list is deliberately short and incomplete: a real Public Suffix List is a dependency,
 * and the failure mode of a miss here is a loud refusal, not a wrong domain.
 */
const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'co.za', 'org.za', 'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'com.my',
  'co.in', 'net.in', 'org.in', 'co.kr', 'or.kr', 'co.il', 'com.pl', 'com.tw', 'co.th',
]);

/**
 * Derives the eTLD+1 for `conversion_domain`, or refuses.
 *
 * Sending `https://shop.example.com/serum` where `example.com` was wanted is a rejection,
 * and so is sending `co.uk`. Without a Public Suffix List the only honest answer for a
 * two-label suffix is to make the caller state it.
 */
export function conversionDomain(link: string | undefined, override?: string): string {
  if (override !== undefined) {
    const cleaned = override.trim().toLowerCase();
    if (cleaned === '' || cleaned.includes('/') || cleaned.includes(':')) {
      fail(
        'conversion_domain',
        `"${override}" must be a bare domain such as example.com — "only the first and second level domains, ` +
          `and not the full URL".`,
      );
    }
    return cleaned;
  }
  if (link === undefined) {
    fail('conversion_domain', 'is required for a pixel-optimised campaign and no destination URL was available.');
  }

  const host = safeHost(link).toLowerCase().replace(/\.$/, '');
  if (host === '') fail('conversion_domain', `could not read a host out of "${link}".`);

  // An IP literal has no registrable domain, and slicing its last two labels yields a
  // string ("100.7") that is neither the host nor a domain — Meta rejects it as a code 100.
  if (/^\d+(?:\.\d+)*$/.test(host) || host.startsWith('[')) {
    fail(
      'conversion_domain',
      `"${host}" is an IP literal, not a registrable domain. conversion_domain must be "only the first and ` +
        `second level domains, and not the full URL" — pass options.conversionDomain with the real domain.`,
    );
  }

  const labels = host.split('.');
  if (labels.length < 2) fail('conversion_domain', `"${host}" has no registrable domain.`);

  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    if (labels.length < 3) fail('conversion_domain', `"${host}" is a bare public suffix.`);
    fail(
      'conversion_domain',
      `"${host}" sits under the two-label public suffix "${lastTwo}", and deriving the registrable domain ` +
        `correctly needs a Public Suffix List this project does not carry. Pass options.conversionDomain ` +
        `explicitly (probably "${labels.slice(-3).join('.')}").`,
    );
  }
  return lastTwo;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const META_ID = /^\d+$/;

/**
 * The only call that starts money moving.
 *
 * Kept trivial and separate on purpose: the whole create-PAUSED shape exists so that all
 * spend risk collapses into this one idempotent status flip on an object whose id is
 * already known. The client's spend guard refuses to carry it outside LIVE mode, so this
 * builder does not need to — and must not, since STAGE deliberately builds real objects.
 */
export function buildActivationRequest(objectId: string): BuiltRequest {
  if (!META_ID.test(objectId)) {
    fail(
      'status',
      `"${objectId}" is not a Meta object id. Ids exceed 2^53 and must be carried as strings — a mangled id ` +
        `activates someone else's object.`,
    );
  }
  return { path: objectId, params: { status: 'ACTIVE' } };
}

/**
 * The kill switch. PAUSED, never DELETE: a deleted ad keeps accruing impressions, clicks
 * and actions for 28 days after delivery, so DELETE stops nothing you care about and
 * destroys the history the optimiser needs.
 */
export function buildPauseRequest(objectId: string): BuiltRequest {
  if (!META_ID.test(objectId)) fail('status', `"${objectId}" is not a Meta object id.`);
  return { path: objectId, params: { status: 'PAUSED' } };
}
