/**
 * Capability probe for src/meta/publish.ts.
 *
 * Not a unit test. The question is whether the request builders actually produce the
 * bodies Meta's documented contract demands, for EVERY archetype in objectives.ts, when
 * driven from a realistic Brand — and whether the constraints the module claims to
 * enforce actually hold when someone tries to break them.
 *
 * The module is pure (no network, no clock), so the "realistic input" here is a real
 * Brand run through the real domain/brand.ts resolver, and the observable is the exact
 * param map that would go on the wire. Field-by-field, against the shapes quoted in
 * docs/research/meta-campaign-publishing.md §3, §5, §6, §8, §9 and §14.
 *
 * The one seam that does touch a transport is exercised through MetaClient in SIMULATE,
 * with a fetch implementation that throws if called — so "no network happened" is proved
 * rather than assumed.
 *
 * Run: node --experimental-strip-types src/verify/publish.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MetaClient, SpendGuardError, type WriteIntent } from '../meta/client.ts';
import {
  ARCHETYPES,
  type ArchetypeSpec,
  type ConversionArchetype,
} from '../meta/objectives.ts';
import { resolveAdConfig, type Brand, type Destination } from '../domain/brand.ts';
import {
  buildActivationRequest,
  buildAdRequest,
  buildAdSetRequest,
  buildCampaignRequest,
  buildCreativeRequest,
  buildPauseRequest,
  buildTargeting,
  conversionDomain,
  currencyOffset,
  formatMinor,
  majorToMinor,
  objectName,
  parseObjectName,
  PublishBuildError,
  validatePublishRequest,
  type BuiltRequest,
  type PublishRequest,
  type TargetingInput,
} from '../meta/publish.ts';

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  // Set when the check could not run for an environmental reason (no assets
  // assigned, no API key, binary missing) rather than because the code is wrong.
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

class SkipSignal extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, detail: string) {
    super(detail);
    this.name = 'SkipSignal';
    this.blockedBy = blockedBy;
  }
}

function skip(blockedBy: string, detail: string): never {
  throw new SkipSignal(blockedBy, detail);
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message} — expected ${e}, got ${a}`);
}

/** Runs `fn` and expects a PublishBuildError whose message names `field` and `contains`. */
function refuses(fn: () => unknown, field: string, contains: string): string {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) {
    throw new Error(`expected a refusal naming "${field}" but the build SUCCEEDED`);
  }
  if (!(thrown instanceof PublishBuildError)) {
    throw new Error(
      `expected PublishBuildError naming "${field}", got ${(thrown as Error)?.name}: ` +
        `${(thrown as Error)?.message?.slice(0, 160)}`,
    );
  }
  if (thrown.field !== field) {
    throw new Error(`refusal named field "${thrown.field}", expected "${field}" (${thrown.message.slice(0, 120)})`);
  }
  if (!thrown.message.includes(contains)) {
    throw new Error(`refusal for "${field}" did not mention "${contains}": ${thrown.message.slice(0, 200)}`);
  }
  return thrown.message;
}

// ---------------------------------------------------------------------------
// Realistic fixtures
// ---------------------------------------------------------------------------

/**
 * Per-archetype destination, filled to exactly what domain/brand.ts requires and no more.
 *
 * That "and no more" is deliberate: it is the configuration a real operator would end up
 * with after satisfying the loader, so anything the publish builders need on top of it is
 * a contract gap between the two modules rather than an operator mistake.
 */
const DESTINATIONS: Record<ConversionArchetype, Destination> = {
  website_purchase: { url: 'https://northwindskin.com/serum', pixelId: '1088812345678901', customEventType: 'PURCHASE' },
  website_lead: { url: 'https://northwindskin.com/consult', pixelId: '1088812345678901', customEventType: 'LEAD' },
  instant_form_lead: { leadFormId: '2384852000000012345' },
  messenger_lead: {},
  whatsapp_conversation: {},
  phone_call: { phoneNumber: '+15551234567' },
  catalog_sales: { productSetId: '7745500000012345', customEventType: 'PURCHASE' },
  traffic: { url: 'https://northwindskin.com/lp' },
  app_install: {
    applicationId: '9911223344556677',
    objectStoreUrl: 'https://play.google.com/store/apps/details?id=com.northwind.skin',
  },
};

function makeBrand(archetype: ConversionArchetype, over: Partial<Brand> = {}): Brand {
  return {
    id: 'northwind',
    name: 'Northwind Skin',
    pageId: '102938475610293',
    adAccountId: 'act_1234567890123456',
    instagramUserId: '17841400000000001',
    archetype,
    destination: DESTINATIONS[archetype],
    spend: { dailyBudgetMinor: 5000, maxDailyBudgetMinor: 20000, targetCpaMinor: 4000 },
    claims: {
      substantiated: ['Free 30-minute consultation'],
      neverSay: ['guaranteed'],
      neverShow: ['competitor logos'],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
    proposition: 'A vitamin C serum sold direct to consumers.',
    ...over,
  };
}

const ACCOUNT = {
  adAccountId: 'act_1234567890123456',
  currency: 'USD',
  minDailyBudgetMinor: 100,
};

const TARGETING: TargetingInput = {
  geo: { countries: ['US'], locationTypes: ['home', 'recent'] },
  ageMin: 25,
  ageMax: 54,
};

const CTA_FOR: Record<ConversionArchetype, PublishRequest['creative']['callToActionType']> = {
  website_purchase: 'SHOP_NOW',
  website_lead: 'SIGN_UP',
  instant_form_lead: 'SIGN_UP',
  messenger_lead: 'MESSAGE_PAGE',
  whatsapp_conversation: 'WHATSAPP_MESSAGE',
  phone_call: 'CALL_NOW',
  catalog_sales: 'SHOP_NOW',
  traffic: 'LEARN_MORE',
  app_install: 'INSTALL_APP',
};

function makeRequest(archetype: ConversionArchetype, over: Partial<PublishRequest> = {}): PublishRequest {
  const brand = makeBrand(archetype);
  return {
    config: resolveAdConfig(brand),
    account: { ...ACCOUNT },
    variant: 'hook-a-v1',
    targeting: TARGETING,
    creative: {
      videoId: '2384852000000098765',
      imageHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      message: 'Brighter skin in four weeks, or your money back.',
      title: 'Vitamin C, done right',
      callToActionType: CTA_FOR[archetype],
    },
    ...over,
  };
}

/** Builds whichever of the four objects this archetype can produce, collecting failures. */
interface TreeResult {
  built: Partial<Record<'campaign' | 'adset' | 'creative' | 'ad', BuiltRequest>>;
  errors: Partial<Record<'campaign' | 'adset' | 'creative' | 'ad', Error>>;
}

function buildTree(req: PublishRequest): TreeResult {
  const built: TreeResult['built'] = {};
  const errors: TreeResult['errors'] = {};
  const steps: Array<['campaign' | 'adset' | 'creative' | 'ad', () => BuiltRequest]> = [
    ['campaign', () => buildCampaignRequest(req)],
    ['adset', () => buildAdSetRequest(req, { campaignId: '120210000000000001' })],
    ['creative', () => buildCreativeRequest(req)],
    ['ad', () => buildAdRequest(req, { adSetId: '120210000000000002', creativeId: '120210000000000003' })],
  ];
  for (const [level, fn] of steps) {
    try {
      built[level] = fn();
    } catch (e) {
      errors[level] = e instanceof Error ? e : new Error(String(e));
    }
  }
  return { built, errors };
}

const ALL_ARCHETYPES = Object.keys(ARCHETYPES) as ConversionArchetype[];

/** Archetypes whose creative shape this builder deliberately does not make. */
const CREATIVE_EXEMPT: ReadonlySet<ConversionArchetype> = new Set(['catalog_sales']);

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];

  const check = async (name: string, fn: () => string | Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS', detail });
    } catch (e) {
      if (e instanceof SkipSignal) {
        checks.push({ name, status: 'SKIP', detail: e.message, blockedBy: e.blockedBy });
        return;
      }
      checks.push({ name, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  // -------------------------------------------------------------------------
  // 1. Can every archetype actually publish?
  // -------------------------------------------------------------------------

  await check('every archetype builds a complete publish tree from a valid Brand', () => {
    const broken: string[] = [];
    for (const archetype of ALL_ARCHETYPES) {
      const { built, errors } = buildTree(makeRequest(archetype));
      for (const level of ['campaign', 'adset', 'creative', 'ad'] as const) {
        if (level === 'creative' && CREATIVE_EXEMPT.has(archetype)) {
          must(errors.creative !== undefined, `${archetype}: catalogue creative should be refused, it built`);
          continue;
        }
        const err = errors[level];
        if (err !== undefined) broken.push(`${archetype}/${level}: ${err.message.slice(0, 150)}`);
        else must(built[level] !== undefined, `${archetype}/${level}: neither built nor errored`);
      }
    }
    if (broken.length > 0) {
      throw new Error(
        `${broken.length} of ${ALL_ARCHETYPES.length * 4} object builds failed from a Brand that ` +
          `domain/brand.ts accepts:\n  ${broken.join('\n  ')}`,
      );
    }
    return `all ${ALL_ARCHETYPES.length} archetypes produced campaign+adset+ad (+creative except catalog_sales)`;
  });

  await check('the on-Meta destination archetypes fail only for want of a click URL', () => {
    // Isolates the cause of the failure above: give the same request an explicit https
    // link and everything builds, which proves the gap is the link contract and not the
    // objective/promoted_object/targeting machinery.
    const onMeta: ConversionArchetype[] = ['messenger_lead', 'whatsapp_conversation', 'phone_call'];
    const recovered: string[] = [];
    for (const archetype of onMeta) {
      const bare = buildTree(makeRequest(archetype));
      must(
        bare.errors.campaign !== undefined,
        `${archetype}: expected the bare config to fail, it built`,
      );
      const req = makeRequest(archetype);
      const withLink = buildTree({ ...req, creative: { ...req.creative, link: 'https://m.me/102938475610293' } });
      must(
        Object.keys(withLink.errors).length === 0,
        `${archetype}: still failed with an explicit link: ${JSON.stringify(withLink.errors)}`,
      );
      recovered.push(archetype);
    }
    // The phone_call archetype is the sharp case: brand.ts REQUIRES destination.phoneNumber
    // for it, and publish.ts never reads that field at all.
    const telReq = makeRequest('phone_call');
    refuses(
      () => buildCreativeRequest({ ...telReq, creative: { ...telReq.creative, link: 'tel:+15551234567' } }),
      'call_to_action.value.link',
      'must be http or https',
    );
    return (
      `${recovered.join(', ')} build once creative.link is supplied by hand; phone_call's own ` +
      `destination.phoneNumber is never read by publish.ts and a tel: URL is refused`
    );
  });

  // -------------------------------------------------------------------------
  // 2. Field-by-field against the documented create contracts
  // -------------------------------------------------------------------------

  await check('campaign: the documented required set is present and correctly typed', () => {
    const rows: string[] = [];
    for (const archetype of ALL_ARCHETYPES) {
      const req = makeRequest(archetype);
      let params: Record<string, string>;
      try {
        params = buildCampaignRequest(req).params;
      } catch {
        continue; // covered by the archetype-matrix check
      }
      const spec = ARCHETYPES[archetype];
      eq(params['objective'], spec.objective, `${archetype}: objective`);
      eq(params['status'], 'PAUSED', `${archetype}: status`);
      eq(params['buying_type'], 'AUCTION', `${archetype}: buying_type`);
      eq(params['name'], `AUTO/northwind/${archetype}/cmp/hook-a-v1`, `${archetype}: name`);

      // §14 gotcha 2: it must be a JSON ARRAY, not a bare string.
      const cats: unknown = JSON.parse(params['special_ad_categories'] ?? 'null');
      must(Array.isArray(cats), `${archetype}: special_ad_categories is ${typeof cats}, not an array`);
      eq(cats, ['NONE'], `${archetype}: special_ad_categories`);

      // Ordinary commercial advertising: no category country.
      must(
        !('special_ad_category_country' in params),
        `${archetype}: special_ad_category_country emitted for a NONE-category campaign`,
      );
      eq(params['daily_budget'], '5000', `${archetype}: daily_budget (minor units)`);
      must(!('adset_id' in params) && !('id' in params), `${archetype}: leaked an id into the campaign body`);
      rows.push(archetype);
    }
    return `${rows.length} campaign bodies carry name/objective/status/buying_type + array special_ad_categories`;
  });

  await check('campaign: a restricted category emits the ARRAY country list too', () => {
    const brand = makeBrand('website_purchase', { specialAdCategories: ['HOUSING'], countries: ['us', 'ca'] });
    const req: PublishRequest = {
      ...makeRequest('website_purchase'),
      config: resolveAdConfig(brand),
      targeting: { geo: { countries: ['US'] }, ageMin: 18, ageMax: 65 },
      options: { dsaPayor: 'Northwind Ltd', dsaBeneficiary: 'Northwind Ltd' },
    };
    const params = buildCampaignRequest(req).params;
    eq(JSON.parse(params['special_ad_categories'] ?? 'null'), ['HOUSING'], 'special_ad_categories');
    const countries: unknown = JSON.parse(params['special_ad_category_country'] ?? 'null');
    must(Array.isArray(countries), 'special_ad_category_country must be an array');
    eq(countries, ['US', 'CA'], 'special_ad_category_country is upper-cased ISO-2');
    // And the omission is refused rather than left to Meta's tax-country default (§5).
    const noCountries = resolveAdConfig(makeBrand('website_purchase', { specialAdCategories: ['HOUSING'], countries: [] }));
    refuses(
      () => buildCampaignRequest({ ...req, config: noCountries }),
      'special_ad_category_country',
      "account's",
    );
    return 'HOUSING emits ["US","CA"]; an empty country list is refused rather than defaulted by Meta';
  });

  await check('adset: destination_type is OMITTED as a key, never sent empty', () => {
    const expected: Partial<Record<ConversionArchetype, string>> = {
      website_purchase: 'WEBSITE',
      instant_form_lead: 'ON_AD',
      messenger_lead: 'LEAD_FROM_MESSENGER',
      whatsapp_conversation: 'WHATSAPP',
      phone_call: 'PHONE_CALL',
    };
    const omitted: string[] = [];
    for (const archetype of ALL_ARCHETYPES) {
      const req = makeRequest(archetype);
      let params: Record<string, string>;
      try {
        params = buildAdSetRequest(req, { campaignId: '1' }).params;
      } catch {
        const linked = makeRequest(archetype);
        params = buildAdSetRequest(
          { ...linked, creative: { ...linked.creative, link: 'https://m.me/102938475610293' } },
          { campaignId: '1' },
        ).params;
      }
      const want = expected[archetype];
      if (want === undefined) {
        must(
          !('destination_type' in params),
          `${archetype}: destination_type present as ${JSON.stringify(params['destination_type'])}; ` +
            `the spec says omit it (OUTCOME_TRAFFIC does not list WEBSITE as legal)`,
        );
        must(params['destination_type'] !== 'undefined', `${archetype}: stringified undefined`);
        omitted.push(archetype);
      } else {
        eq(params['destination_type'], want, `${archetype}: destination_type`);
      }
    }
    return `omitted for ${omitted.join(', ')}; explicit for the five archetypes whose objective documents it`;
  });

  await check('adset: promoted_object is shaped per archetype, exactly', () => {
    const expected: Record<ConversionArchetype, Record<string, string> | undefined> = {
      website_purchase: { pixel_id: '1088812345678901', custom_event_type: 'PURCHASE' },
      website_lead: { pixel_id: '1088812345678901', custom_event_type: 'LEAD' },
      instant_form_lead: { page_id: '102938475610293' },
      messenger_lead: { page_id: '102938475610293' },
      whatsapp_conversation: { page_id: '102938475610293' },
      phone_call: { page_id: '102938475610293' },
      catalog_sales: { product_set_id: '7745500000012345', custom_event_type: 'PURCHASE' },
      traffic: undefined,
      app_install: {
        application_id: '9911223344556677',
        object_store_url: 'https://play.google.com/store/apps/details?id=com.northwind.skin',
      },
    };
    for (const archetype of ALL_ARCHETYPES) {
      const req = makeRequest(archetype);
      const linked = { ...req, creative: { ...req.creative, link: 'https://m.me/102938475610293' } };
      const params = buildAdSetRequest(linked, { campaignId: '1' }).params;
      const want = expected[archetype];
      if (want === undefined) {
        must(!('promoted_object' in params), `${archetype}: promoted_object should be absent`);
      } else {
        eq(JSON.parse(params['promoted_object'] ?? 'null'), want, `${archetype}: promoted_object`);
      }
      eq(params['billing_event'], ARCHETYPES[archetype].billingEvent, `${archetype}: billing_event`);
      eq(params['optimization_goal'], ARCHETYPES[archetype].optimizationGoal, `${archetype}: optimization_goal`);
    }
    // And the one brand.ts cannot catch: a catalogue set with no conversion event.
    const noEvent = resolveAdConfig(
      makeBrand('catalog_sales', { destination: { productSetId: '7745500000012345' } }),
    );
    refuses(
      () => buildAdSetRequest({ ...makeRequest('catalog_sales'), config: noEvent }, { campaignId: '1' }),
      'promoted_object.custom_event_type',
      'will not default it',
    );
    return 'all 9 promoted_object shapes match the ODAX mapping; a missing catalogue event is refused';
  });

  await check('budget lives on exactly one node, never both (§12: "you may not set both")', () => {
    const req = makeRequest('website_purchase');
    const cbo = { campaign: buildCampaignRequest(req).params, adset: buildAdSetRequest(req, { campaignId: '1' }).params };
    eq(cbo.campaign['daily_budget'], '5000', 'CBO: campaign daily_budget');
    eq(cbo.campaign['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP', 'CBO: bid_strategy sits with the budget');
    must(!('daily_budget' in cbo.adset), 'CBO: ad set must carry NO budget');
    must(!('lifetime_budget' in cbo.adset), 'CBO: ad set must carry no lifetime budget');
    must(!('bid_strategy' in cbo.adset), 'CBO: bid_strategy in two places is a code 100');
    must(!('is_adset_budget_sharing_enabled' in cbo.campaign), 'CBO: sharing flag is an ABO field');

    const aboReq: PublishRequest = { ...req, options: { budgetLevel: 'adset', adSetBudgetSharing: true } };
    const abo = { campaign: buildCampaignRequest(aboReq).params, adset: buildAdSetRequest(aboReq, { campaignId: '1' }).params };
    must(!('daily_budget' in abo.campaign), 'ABO: campaign must carry no budget');
    eq(abo.campaign['is_adset_budget_sharing_enabled'], 'true', 'ABO: v24.0 requires the sharing flag');
    eq(abo.adset['daily_budget'], '5000', 'ABO: ad set daily_budget');
    eq(abo.adset['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP', 'ABO: bid_strategy moves down');
    // And the flag has no default, because it moves money between ad sets.
    refuses(
      () => buildCampaignRequest({ ...req, options: { budgetLevel: 'adset' } }),
      'is_adset_budget_sharing_enabled',
      'no default here',
    );
    return 'CBO puts budget+bid_strategy on the campaign only; ABO moves both down and demands the v24.0 flag';
  });

  await check('bid_amount lands on the node the docs put it on', () => {
    const req: PublishRequest = {
      ...makeRequest('website_purchase'),
      options: { bidStrategy: 'COST_CAP', bidAmountMinor: 500 },
    };
    const campaign = buildCampaignRequest(req).params;
    const adset = buildAdSetRequest(req, { campaignId: '1' }).params;
    const onCampaign = 'bid_amount' in campaign;
    const onAdSet = 'bid_amount' in adset;
    if (onCampaign && !onAdSet) {
      throw new Error(
        `under the DEFAULT campaign-level budget, bid_amount=${campaign['bid_amount']} is emitted on the ` +
          `CAMPAIGN body and the ad set carries none. The campaign create field table ` +
          `(dossier §3) does not list bid_amount at all; the dossier documents bid_amount only on the ad set ` +
          `(§6.4, "per 1,000 occurrences ... units are minor units"), and §12 moves only bid_STRATEGY to the ` +
          `campaign under CBO. So a COST_CAP or LOWEST_COST_WITH_BID_CAP campaign either loses its cap or ` +
          `fails with a generic code 100, and there is no test covering where the field lands.`,
      );
    }
    must(onAdSet, 'bid_amount reached neither node');
    return `bid_amount is on the ad set (campaign=${onCampaign})`;
  });

  await check('adset: attribution, schedule and DSA land on the ad set body', () => {
    const req: PublishRequest = {
      ...makeRequest('website_purchase'),
      options: { startTime: '2026-10-01T00:00:00+0000', endTime: '2026-10-31T00:00:00+0000' },
    };
    const params = buildAdSetRequest(req, { campaignId: '120210000000000001' }).params;
    eq(params['campaign_id'], '120210000000000001', 'campaign_id');
    eq(params['status'], 'PAUSED', 'status');
    eq(
      JSON.parse(params['attribution_spec'] ?? 'null'),
      [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
      'attribution_spec for a conversion goal',
    );
    eq(params['start_time'], '2026-10-01T00:00:00+0000', 'start_time');
    eq(params['end_time'], '2026-10-31T00:00:00+0000', 'end_time');
    // Non-conversion goals must NOT carry one: supported windows vary by goal (§6.8).
    const traffic = buildAdSetRequest(makeRequest('traffic'), { campaignId: '1' }).params;
    must(!('attribution_spec' in traffic), 'attribution_spec must be absent for LANDING_PAGE_VIEWS');
    return 'attribution_spec only for OFFSITE_CONVERSIONS/VALUE; flight fields pass through verbatim';
  });

  await check('creative + ad: object_story_spec, the CTA-only link, and the eTLD+1', () => {
    const req = makeRequest('website_purchase');
    const creative = buildCreativeRequest(req).params;
    const oss = JSON.parse(creative['object_story_spec'] ?? 'null') as Record<string, unknown>;
    eq(oss['page_id'], '102938475610293', 'object_story_spec.page_id');
    eq(oss['instagram_user_id'], '17841400000000001', 'instagram_user_id lives INSIDE object_story_spec');
    const vd = oss['video_data'] as Record<string, unknown>;
    eq(vd['video_id'], '2384852000000098765', 'video_id');
    eq(vd['image_hash'], 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'image_hash');
    // §8.1: video_data has NO link field — the URL exists only in the CTA value.
    must(!('link' in vd), 'video_data must not carry a top-level link');
    const cta = vd['call_to_action'] as Record<string, unknown>;
    eq(cta['type'], 'SHOP_NOW', 'call_to_action.type');
    eq((cta['value'] as Record<string, unknown>)['link'], 'https://northwindskin.com/serum', 'CTA link');
    // Every transforming feature opted out, none of them missing.
    const dof = JSON.parse(creative['degrees_of_freedom_spec'] ?? 'null') as {
      creative_features_spec: Record<string, { enroll_status: string }>;
    };
    const enrolled = Object.entries(dof.creative_features_spec).filter(([, v]) => v.enroll_status !== 'OPT_OUT');
    eq(enrolled, [], 'no creative feature may be opted in by default');
    must(Object.keys(dof.creative_features_spec).length >= 24, 'the opt-out list looks truncated');

    const ad = buildAdRequest(req, { adSetId: '120210000000000002', creativeId: '120210000000000003' }).params;
    eq(JSON.parse(ad['creative'] ?? 'null'), { creative_id: '120210000000000003' }, 'ad.creative');
    eq(ad['adset_id'], '120210000000000002', 'ad.adset_id');
    eq(ad['status'], 'PAUSED', 'ad.status');
    eq(ad['conversion_domain'], 'northwindskin.com', 'conversion_domain is the eTLD+1, not the URL');
    return 'video_data carries the URL only inside call_to_action.value; ad references the creative by id';
  });

  // -------------------------------------------------------------------------
  // 3. Currency — the 100x money bug
  // -------------------------------------------------------------------------

  await check('zero-decimal currencies produce a 100x-different minor amount', () => {
    eq(currencyOffset('USD'), 100, 'USD offset');
    eq(currencyOffset('JPY'), 1, 'JPY offset');
    // CRC is the entry most "zero-decimal" lists omit: ISO 4217 gives it two decimals,
    // Meta's offset table gives it one unit. The module must follow Meta.
    eq(currencyOffset('CRC'), 1, 'CRC offset must follow Meta, not ISO 4217');
    const usd = majorToMinor(50, 'USD');
    const jpy = majorToMinor(50, 'JPY');
    const crc = majorToMinor(50, 'CRC');
    eq(usd, 5000, 'majorToMinor USD');
    eq(jpy, 50, 'majorToMinor JPY');
    eq(crc, 50, 'majorToMinor CRC');
    must(usd / jpy === 100, `expected a 100x gap, got ${usd} vs ${jpy}`);

    // The same wire value means 100x different money on two real campaign bodies.
    const usdBody = buildCampaignRequest(makeRequest('website_purchase')).params;
    const jpyReq: PublishRequest = {
      ...makeRequest('website_purchase'),
      account: { adAccountId: 'act_1234567890123456', currency: 'JPY' },
    };
    const jpyBody = buildCampaignRequest(jpyReq).params;
    eq(usdBody['daily_budget'], jpyBody['daily_budget'], 'identical wire value');
    eq(formatMinor(5000, 'USD'), '50.00 USD', 'USD reading');
    eq(formatMinor(5000, 'JPY'), '5000 JPY', 'JPY reading');
    const warnings = validatePublishRequest(jpyReq);
    must(
      warnings.some((w) => w.includes('offset 1') && w.includes('whole units')),
      `an offset-1 account must warn that the figure is whole units; warnings were ${JSON.stringify(warnings)}`,
    );
    return 'daily_budget=5000 is $50.00 on USD and ¥5,000 on JPY; the offset-1 account gets an explicit warning';
  });

  await check('getting the currency offset wrong is caught, not published', () => {
    // (a) Someone multiplied a JPY figure by 100 out of habit.
    const jpyBrand = makeBrand('website_purchase', {
      spend: { dailyBudgetMinor: 500_000, maxDailyBudgetMinor: 10_000, targetCpaMinor: 4000 },
    });
    const inflated = refuses(
      () =>
        buildCampaignRequest({
          ...makeRequest('website_purchase'),
          config: resolveAdConfig(jpyBrand),
          account: { adAccountId: 'act_1234567890123456', currency: 'JPY' },
        }),
      'daily_budget',
      'exceeds brand',
    );
    must(inflated.includes('500000 JPY'), `the refusal must read the figure in JPY whole units: ${inflated}`);

    // (b) Someone forgot to multiply on a USD account: $50 entered as 50 minor units.
    refuses(
      () =>
        buildCampaignRequest({
          ...makeRequest('website_purchase'),
          config: resolveAdConfig(makeBrand('website_purchase', {
            spend: { dailyBudgetMinor: 50, maxDailyBudgetMinor: 20000, targetCpaMinor: 4000 },
          })),
        }),
      'daily_budget',
      'below the account minimum',
    );

    // (c) Where Meta's table and ISO 4217 disagree the module refuses instead of guessing.
    refuses(() => currencyOffset('BHD'), 'currency', 'no offset this system is willing to assume');
    refuses(() => currencyOffset('XOF'), 'currency', 'Guessing 100 here would misstate');
    refuses(() => currencyOffset('DOLLARS'), 'currency', 'ISO 4217 alpha-3');
    return 'a 100x-inflated JPY budget hits the brand ceiling; an un-multiplied USD budget hits the account minimum; BHD/XOF are refused outright';
  });

  // -------------------------------------------------------------------------
  // 4. EU / DSA
  // -------------------------------------------------------------------------

  await check('an EU-targeted ad set demands BOTH dsa_payor and dsa_beneficiary', () => {
    const euReq: PublishRequest = { ...makeRequest('website_purchase'), targeting: { geo: { countries: ['DE'] } } };
    const both = refuses(() => buildAdSetRequest(euReq, { campaignId: '1' }), 'dsa_payor and dsa_beneficiary', 'BOTH');
    must(both.includes('prose only'), 'the refusal should explain why a schema-driven client misses this');

    refuses(
      () => buildAdSetRequest({ ...euReq, options: { dsaPayor: 'Northwind Ltd' } }, { campaignId: '1' }),
      'dsa_beneficiary',
      'BOTH',
    );
    refuses(
      () => buildAdSetRequest({ ...euReq, options: { dsaBeneficiary: 'Northwind Ltd' } }, { campaignId: '1' }),
      'dsa_payor',
      'BOTH',
    );

    // Opaque city/region/zip keys carry no country and Meta ORs them with `countries`,
    // so a US-countries ad set holding a Dublin key still reaches the EU.
    refuses(
      () =>
        buildAdSetRequest(
          { ...makeRequest('website_purchase'), targeting: { geo: { countries: ['US'], cities: [{ key: '2964574' }] } } },
          { campaignId: '1' },
        ),
      'dsa_payor and dsa_beneficiary',
      'EU reach cannot be ruled out',
    );

    // Supplied: both must reach the AD SET body (not the campaign), and be capped at 512.
    const ok = buildAdSetRequest(
      { ...euReq, options: { dsaPayor: 'Northwind Ltd', dsaBeneficiary: 'Northwind Skin GmbH' } },
      { campaignId: '1' },
    ).params;
    eq(ok['dsa_payor'], 'Northwind Ltd', 'dsa_payor');
    eq(ok['dsa_beneficiary'], 'Northwind Skin GmbH', 'dsa_beneficiary');
    const campaign = buildCampaignRequest({
      ...euReq,
      options: { dsaPayor: 'Northwind Ltd', dsaBeneficiary: 'Northwind Skin GmbH' },
    }).params;
    must(!('dsa_payor' in campaign), 'DSA fields belong on the ad set, not the campaign');
    refuses(
      () => buildAdSetRequest({ ...euReq, options: { dsaPayor: 'x'.repeat(513), dsaBeneficiary: 'y' } }, { campaignId: '1' }),
      'dsa_payor',
      '512',
    );

    // Account-level defaults satisfy it; a non-EU ad set still gets the "set them anyway" warning.
    const viaAccount = buildAdSetRequest(
      { ...euReq, account: { ...ACCOUNT, defaultDsaPayor: 'Northwind Ltd', defaultDsaBeneficiary: 'Northwind Ltd' } },
      { campaignId: '1' },
    ).params;
    eq(viaAccount['dsa_payor'], 'Northwind Ltd', 'account default_dsa_payor');
    const nonEu = validatePublishRequest(makeRequest('website_purchase'));
    must(nonEu.some((w) => w.includes('dsa_payor')), 'a non-EU ad set should still advise setting them');
    return 'DE, and an opaque city key under US countries, both demand the pair; supplied values land on the ad set';
  });

  await check('the EU country set covers the associated territories, not just the EU-27', () => {
    // "the EU and/or associated territories" is never enumerated by Meta, so the set errs
    // inclusive on purpose. A false negative is a publish failure; check the awkward ones.
    const territories = ['IS', 'NO', 'LI', 'GF', 'RE', 'YT', 'MQ', 'GP', 'PM', 'NC', 'PF', 'AW', 'CW', 'SX'];
    const missed: string[] = [];
    for (const cc of territories) {
      try {
        buildAdSetRequest(
          { ...makeRequest('website_purchase'), targeting: { geo: { countries: [cc] } } },
          { campaignId: '1' },
        );
        missed.push(cc);
      } catch {
        // refused for want of DSA fields — the correct outcome
      }
    }
    must(missed.length === 0, `these EEA/associated territories did not trigger the DSA requirement: ${missed.join(', ')}`);
    // Lower-case input must not sneak past the set.
    refuses(
      () => buildAdSetRequest({ ...makeRequest('website_purchase'), targeting: { geo: { countries: ['de'] } } }, { campaignId: '1' }),
      'dsa_payor and dsa_beneficiary',
      'targets the EU',
    );
    return `${territories.length} EEA/outermost territories plus lower-case "de" all trigger the DSA requirement`;
  });

  // -------------------------------------------------------------------------
  // 5. Special ad categories — the silent-rewrite class
  // -------------------------------------------------------------------------

  await check('HOUSING cannot emit an illegal targeting spec', () => {
    const H = ['HOUSING'] as const;
    const attempts: Array<[string, TargetingInput, string, string]> = [
      ['gender', { geo: { countries: ['US'] }, genders: [1] }, 'targeting.genders', 'forbids gender selection'],
      ['gender=all', { geo: { countries: ['US'] }, genders: [1, 2] }, 'targeting.genders', 'is not the same as omitting it'],
      ['age_min', { geo: { countries: ['US'] }, ageMin: 25 }, 'targeting.age_min', 'fixes the age range to 18-65+'],
      ['age_max', { geo: { countries: ['US'] }, ageMax: 54 }, 'targeting.age_max', 'fixes the age range to 18-65+'],
      ['zips', { geo: { countries: ['US'], zips: [{ key: 'US:94304' }] } }, 'targeting.geo_locations.zips', 'prohibits these location granularities'],
      ['exclusion', { geo: { countries: ['US'] }, excludedGeo: { countries: ['CA'] } }, 'targeting.excluded_geo_locations', 'does not support location exclusion'],
      ['lookalike', { geo: { countries: ['US'] }, lookalikeAudienceIds: ['6001'] }, 'targeting.custom_audiences', 'Lookalike audiences are unavailable'],
      ['behaviors', { geo: { countries: ['US'] }, behaviors: [{ id: '6002' }] }, 'targeting.behaviors', 'Behaviour and Demographic'],
      ['interests', { geo: { countries: ['US'] }, interests: [{ id: '6003' }] }, 'targeting.interests', 'allowlist'],
      ['radius<15mi', { geo: { countries: ['US'], cities: [{ key: '2418779', radius: 10, distanceUnit: 'mile' }] } }, 'targeting.geo_locations.cities.radius', 'at least 15 mile'],
      ['radius<25km', { geo: { countries: ['CA'], cities: [{ key: '2418779', radius: 20, distanceUnit: 'kilometer' }] } }, 'targeting.geo_locations.cities.radius', 'at least 25 kilometer'],
      ['miles in EU', { geo: { countries: ['DE'], cities: [{ key: '2950159', radius: 20, distanceUnit: 'mile' }] } }, 'targeting.geo_locations.cities.radius', 'no mile equivalent'],
      ['unit unstated', { geo: { countries: ['US'], cities: [{ key: '2418779', radius: 30 }] } }, 'targeting.geo_locations.cities.distance_unit', 'default distance unit is undocumented'],
    ];
    for (const [label, input, field, contains] of attempts) {
      try {
        refuses(() => buildTargeting(input, H), field, contains);
      } catch (e) {
        throw new Error(`HOUSING/${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // The same input is legal without the category — proving the refusal is the
      // category's doing and not an unrelated validation.
      buildTargeting(input, ['NONE']);
    }

    // The legal HOUSING spec carries none of the forbidden keys, and does carry the
    // v26.0 explicit advantage_audience flag.
    const legal = buildTargeting(
      { geo: { countries: ['US'], cities: [{ key: '2418779', radius: 25, distanceUnit: 'mile' }] }, ageMin: 18, ageMax: 65 },
      H,
    );
    for (const forbidden of ['genders', 'excluded_geo_locations', 'interests', 'behaviors']) {
      must(!(forbidden in legal), `the legal HOUSING spec still emitted ${forbidden}`);
    }
    must(!('zips' in (legal['geo_locations'] as Record<string, unknown>)), 'zips leaked into geo_locations');
    eq(legal['targeting_automation'], { advantage_audience: 1 }, 'v26.0 requires an explicit advantage_audience');
    return `${attempts.length} illegal HOUSING combinations refused by name; the same inputs are legal under NONE`;
  });

  await check('HOUSING: a city with no radius cannot slip past the minimum-radius floor', () => {
    // Meta documents a floor of "at least 15 mile or 25 kilometer radius" and publishes no
    // default radius for a bare city key, so an omitted radius is exactly the silent-rewrite
    // this module refuses elsewhere: an unstated distance_unit is already a hard refusal.
    const spec = (): unknown => buildTargeting({ geo: { countries: ['US'], cities: [{ key: '2418779' }] } }, ['HOUSING']);
    let emitted: unknown;
    try {
      emitted = spec();
    } catch (e) {
      if (e instanceof PublishBuildError && e.field.startsWith('targeting.geo_locations.cities')) {
        return `a bare city key under HOUSING is refused: ${e.message.slice(0, 140)}`;
      }
      throw e;
    }
    throw new Error(
      `a city key with NO radius was accepted under HOUSING and emitted ` +
        `${JSON.stringify((emitted as Record<string, unknown>)['geo_locations'])}. The module refuses a radius ` +
        `whose distance_unit is unstated because "the API's default distance unit is undocumented" — the same ` +
        `argument applies with more force to an absent radius, since Meta then picks the radius itself and the ` +
        `documented 15 mile / 25 km floor cannot be shown to be met.`,
    );
  });

  await check('the categories that need a human are refused rather than attempted', () => {
    refuses(
      () =>
        buildCampaignRequest({
          ...makeRequest('website_purchase'),
          config: resolveAdConfig(makeBrand('website_purchase', { specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] })),
        }),
      'special_ad_categories',
      'SIEP advertiser authorization',
    );
    refuses(
      () =>
        buildCampaignRequest({
          ...makeRequest('website_purchase'),
          config: resolveAdConfig(makeBrand('website_purchase', { specialAdCategories: [] })),
        }),
      'special_ad_categories',
      'must be an array',
    );
    return 'SIEP is refused outright (manual authorization + the EU ban); an empty array is refused, not defaulted';
  });

  // -------------------------------------------------------------------------
  // 6. Nothing can emit ACTIVE
  // -------------------------------------------------------------------------

  await check('no builder, under any option combination, can emit status ACTIVE', () => {
    const optionSets: Array<PublishRequest['options']> = [
      undefined,
      { budgetLevel: 'adset', adSetBudgetSharing: true },
      { bidStrategy: 'COST_CAP', bidAmountMinor: 500 },
      { startTime: '2026-10-01T00:00:00+0000', endTime: '2026-10-31T00:00:00+0000' },
      { spendCapMinor: 50_000, adLabelIds: ['238485200000001'], urlTags: 'utm_source=x' },
      {
        lifetimeBudgetMinor: 100_000,
        startTime: '2026-10-01T00:00:00+0000',
        endTime: '2026-10-31T00:00:00+0000',
      },
    ];
    let bodies = 0;
    let statuses = 0;
    for (const archetype of ALL_ARCHETYPES) {
      for (const options of optionSets) {
        const base = makeRequest(archetype);
        const req: PublishRequest = {
          ...base,
          creative: { ...base.creative, link: base.config.destination.url ?? 'https://m.me/102938475610293' },
          ...(options !== undefined ? { options } : {}),
        };
        const { built } = buildTree(req);
        for (const request of Object.values(built)) {
          bodies += 1;
          for (const [key, value] of Object.entries(request.params)) {
            must(
              !value.includes('ACTIVE'),
              `${archetype}: param ${key}=${value.slice(0, 80)} contains ACTIVE`,
            );
            if (key === 'status') {
              statuses += 1;
              eq(value, 'PAUSED', `${archetype}: status`);
            }
          }
        }
      }
    }
    must(bodies > 100, `only ${bodies} bodies were scanned; the sweep is not exercising much`);
    return `${bodies} request bodies scanned across ${optionSets.length} option sets; ${statuses} status fields, all PAUSED, no value containing "ACTIVE"`;
  });

  await check('the activation flip exists, is a bare status change, and refuses a mangled id', () => {
    const act = buildActivationRequest('120210000000000001');
    eq(act, { path: '120210000000000001', params: { status: 'ACTIVE' } }, 'activation request');
    const pause = buildPauseRequest('120210000000000001');
    eq(pause.params, { status: 'PAUSED' }, 'the kill switch is PAUSED, never DELETE');
    // Ids exceed 2^53; a mangled one activates someone else's object.
    refuses(() => buildActivationRequest('1.2021e+17'), 'status', 'not a Meta object id');
    refuses(() => buildActivationRequest('act_1234567890123456'), 'status', 'not a Meta object id');
    return 'buildActivationRequest emits exactly {status: ACTIVE} on a known numeric id and nothing else';
  });

  // -------------------------------------------------------------------------
  // 7. The MetaClient seam
  // -------------------------------------------------------------------------

  await check('a built campaign body posts through MetaClient in SIMULATE with no network call', async () => {
    const intents: WriteIntent[] = [];
    const client = new MetaClient({
      appId: 'probe-app',
      appSecret: 'probe-secret',
      accessToken: 'probe-token',
      mode: 'SIMULATE',
      onIntent: (i) => intents.push(i),
      fetchImpl: () => {
        throw new Error('SIMULATE must not reach the network');
      },
    });

    const req = makeRequest('website_purchase');
    const campaign = buildCampaignRequest(req);
    const result = await client.post<{ id: string; __simulated: boolean }>(campaign.path, campaign.params, {
      adAccountId: req.account.adAccountId,
      idempotencyKey: 'probe-intent-key',
    });
    must(typeof result.id === 'string' && result.id.startsWith('simulated_'), `unexpected id ${result.id}`);
    eq(intents.length, 1, 'one intent recorded');
    const intent = intents[0];
    must(intent !== undefined, 'no intent');
    eq(intent.method, 'POST', 'intent.method');
    eq(intent.path, 'act_1234567890123456/campaigns', 'intent.path carries the act_ prefix');
    eq(intent.mode, 'SIMULATE', 'intent.mode');
    eq(intent.params, campaign.params, 'the ledger records exactly what the builder produced');

    // The whole tree goes through, and every param survives form encoding intact.
    const tree = buildTree(req);
    for (const request of Object.values(tree.built)) {
      await client.post(request.path, request.params, { adAccountId: req.account.adAccountId });
      const encoded = new URLSearchParams(request.params);
      for (const [k, v] of Object.entries(request.params)) {
        eq(encoded.get(k), v, `param ${k} did not survive x-www-form-urlencoded round-trip`);
      }
    }
    eq(intents.length, 5, 'campaign + adset + creative + ad recorded');
    for (const i of intents) {
      for (const [k, v] of Object.entries(i.params)) {
        must(typeof v === 'string', `param ${k} is ${typeof v}, the form encoder needs strings`);
      }
    }
    return 'all four bodies posted in SIMULATE, ledger recorded verbatim, fetch never called, every value a string';
  });

  await check('the spend guard refuses the activation body outside LIVE', async () => {
    const client = new MetaClient({
      appId: 'probe-app',
      appSecret: 'probe-secret',
      accessToken: 'probe-token',
      mode: 'SIMULATE',
      fetchImpl: () => {
        throw new Error('must not reach the network');
      },
    });
    const act = buildActivationRequest('120210000000000001');
    let thrown: unknown;
    try {
      await client.post(act.path, act.params);
    } catch (e) {
      thrown = e;
    }
    must(thrown instanceof SpendGuardError, `expected SpendGuardError, got ${String(thrown)}`);
    // ...and the pause body is carried, since stopping spend must always work.
    const pause = buildPauseRequest('120210000000000001');
    await client.post(pause.path, pause.params);
    return `activation refused in SIMULATE ("${(thrown as Error).message.slice(0, 70)}..."), pause carried`;
  });

  // -------------------------------------------------------------------------
  // 8. Determinism, naming and the odd corners
  // -------------------------------------------------------------------------

  await check('builders are pure: the same intent yields byte-identical params every time', () => {
    for (const archetype of ALL_ARCHETYPES) {
      const base = makeRequest(archetype);
      const req: PublishRequest = {
        ...base,
        creative: { ...base.creative, link: base.config.destination.url ?? 'https://m.me/102938475610293' },
      };
      const a = buildTree(req);
      const b = buildTree(req);
      const c = buildTree(makeRequest(archetype) === req ? req : { ...req });
      for (const level of ['campaign', 'adset', 'creative', 'ad'] as const) {
        const x = a.built[level];
        if (x === undefined) continue;
        eq(b.built[level]?.params, x.params, `${archetype}/${level}: not deterministic on a second call`);
        eq(c.built[level]?.params, x.params, `${archetype}/${level}: not deterministic on a copied request`);
      }
    }
    // Determinism is what makes name-based reconciliation work at all.
    const name = objectName({ brandId: 'northwind', archetype: 'website_purchase', level: 'ad', variant: 'hook-a-v1' });
    eq(name, 'AUTO/northwind/website_purchase/ad/hook-a-v1', 'objectName');
    eq(
      parseObjectName(`${name} [idem:0123456789abcdef0123456789abcdef]`),
      { brandId: 'northwind', archetype: 'website_purchase', level: 'ad', variant: 'hook-a-v1' },
      'parseObjectName round-trip through the idempotency stamp',
    );
    return `all ${ALL_ARCHETYPES.length} archetypes rebuild byte-identically; names round-trip through the stamp`;
  });

  await check('parseObjectName rejects a foreign name instead of returning a malformed one', () => {
    eq(parseObjectName('Q4 Retargeting — Sarah'), undefined, 'a human-made campaign name');
    eq(parseObjectName('AUTO/a/b/xyz/c'), undefined, 'an unknown level code');
    // Level codes are looked up in an object literal, so any Object.prototype key that
    // survives the split would come back as a function or an object rather than undefined,
    // and every consumer type-checks `parts.level` against a string union.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const parsed = parseObjectName(`AUTO/brand/arch/${key}/v1`);
      if (parsed === undefined) continue;
      throw new Error(
        `parseObjectName("AUTO/brand/arch/${key}/v1") returned a NameParts whose level is ` +
          `${typeof parsed.level} (${String(parsed.level).slice(0, 40)}) — an Object.prototype key leaked ` +
          `through the CODE_LEVEL lookup, so a name read back from Meta can produce a NameParts that ` +
          `satisfies no branch of ObjectLevel.`,
      );
    }
    return 'foreign names, unknown level codes and Object.prototype keys all return undefined';
  });

  await check('conversion_domain derives the eTLD+1 or refuses to guess', () => {
    eq(conversionDomain('https://shop.northwindskin.com/serum?x=1'), 'northwindskin.com', 'subdomain stripped');
    eq(conversionDomain('https://northwindskin.com./serum'), 'northwindskin.com', 'trailing dot');
    eq(conversionDomain(undefined, 'Northwind.CO.UK'), 'northwind.co.uk', 'an explicit override is honoured');
    refuses(() => conversionDomain(undefined, 'https://northwindskin.com/x'), 'conversion_domain', 'bare domain');
    refuses(() => conversionDomain('https://shop.northwind.co.uk/x'), 'conversion_domain', 'Public Suffix List');
    refuses(() => conversionDomain('https://localhost/x'), 'conversion_domain', 'no registrable domain');
    refuses(() => conversionDomain(undefined), 'conversion_domain', 'no destination URL was available');
    // An IP literal has no registrable domain at all; taking its last two labels yields a
    // string Meta cannot resolve, and the failure would surface as a generic code 100.
    let ipResult: string | undefined;
    try {
      ipResult = conversionDomain('https://198.51.100.7/checkout');
    } catch (e) {
      if (e instanceof PublishBuildError) {
        return `IP literals are refused ("${e.message.slice(0, 90)}"); subdomains, trailing dots and two-label suffixes all handled`;
      }
      throw e;
    }
    throw new Error(
      `conversionDomain("https://198.51.100.7/checkout") returned "${ipResult}" — the last two labels of an ` +
        `IPv4 literal. conversion_domain must be a registrable domain; this value is neither the host nor a ` +
        `domain, and Meta rejects it as an undifferentiated code 100.`,
    );
  });

  await check('an illegal objective tuple cannot reach the wire through a hand-built config', () => {
    // objectives.validateSpec knows OUTCOME_TRAFFIC does not list WEBSITE as a legal
    // destination_type, but only resolveAdConfig calls it. publish.ts is the last gate
    // before the transport, so a config assembled anywhere else must not slip past.
    const base = makeRequest('traffic');
    const illegal: ArchetypeSpec = { ...ARCHETYPES.traffic, destinationType: 'WEBSITE' };
    const req: PublishRequest = { ...base, config: { ...base.config, spec: illegal } };
    let params: Record<string, string>;
    try {
      params = buildAdSetRequest(req, { campaignId: '1' }).params;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      must(
        message.includes('destination_type') || message.includes('OUTCOME_TRAFFIC'),
        `refused, but for the wrong reason: ${message.slice(0, 160)}`,
      );
      return `refused: ${message.slice(0, 140)}`;
    }
    throw new Error(
      `buildAdSetRequest emitted destination_type=${params['destination_type']} under ` +
        `objective=${params['objective'] ?? ARCHETYPES.traffic.objective}. objectives.validateSpec rejects this ` +
        `tuple, but prepare() never calls it, so any ResolvedAdConfig not produced by resolveAdConfig — a ` +
        `hand-built one, or one an optimiser assembles — bypasses the whole legality matrix and lands as a ` +
        `generic code 100 at Meta.`,
    );
  });

  await check('creative copy limits: the API ceiling refuses, the display ceiling warns', () => {
    const req = makeRequest('website_purchase');
    refuses(
      () => buildCreativeRequest({ ...req, creative: { ...req.creative, message: 'x'.repeat(1025) } }),
      'object_story_spec.video_data.message',
      'over the 1024 limit',
    );
    refuses(
      () => buildCreativeRequest({ ...req, creative: { ...req.creative, title: 'x'.repeat(256) } }),
      'object_story_spec.video_data.title',
      'over the 255 limit',
    );
    const warnings = validatePublishRequest({
      ...req,
      creative: { ...req.creative, message: 'x'.repeat(60), title: 'y'.repeat(40) },
    });
    must(warnings.some((w) => w.includes('See more')), 'a 60-char message should warn about Reels truncation');
    must(warnings.some((w) => w.includes('Facebook Feed display limit')), 'a 40-char title should warn');
    // Poster source, CDN thumbnails and the LIKE_PAGE/title clash.
    refuses(
      () => buildCreativeRequest({ ...req, creative: { ...req.creative, imageUrl: 'https://x.fbcdn.net/p.jpg', imageHash: undefined as unknown as string } }),
      'object_story_spec.video_data.image_url',
      'FB CDN',
    );
    refuses(
      () => buildCreativeRequest({ ...req, creative: { ...req.creative, callToActionType: 'LIKE_PAGE' } }),
      'object_story_spec.video_data.call_to_action.type',
      'cannot be used with a title',
    );
    refuses(
      () => buildCreativeRequest({ ...req, creative: { ...req.creative, featureOptIns: ['vidoe_uncrop'] } }),
      'degrees_of_freedom_spec.creative_features_spec',
      'silently deletes keys it does not recognise',
    );
    return 'over-API-limit copy throws; display-limit copy warns; FB CDN posters, LIKE_PAGE+title and typo\'d feature keys are refused';
  });

  await check('url_tags and the fragment trap', () => {
    const req = makeRequest('website_purchase');
    const params = buildCreativeRequest(req).params;
    must(
      (params['url_tags'] ?? '').includes('{{ad.id}}') && (params['url_tags'] ?? '').includes('{{placement}}'),
      `url_tags should carry Meta's dynamic macros, got ${params['url_tags']}`,
    );
    must(!(params['url_tags'] ?? '').startsWith('?'), 'Meta supplies the separator');
    // A fragment would swallow the appended tags.
    const brandWithHash = makeBrand('website_purchase', {
      destination: { url: 'https://northwindskin.com/serum#buy', pixelId: '1', customEventType: 'PURCHASE' },
    });
    refuses(
      () => buildCreativeRequest({ ...req, config: resolveAdConfig(brandWithHash) }),
      'call_to_action.value.link',
      'contains a fragment',
    );
    // An instant form is the destination: no link, and therefore no url_tags.
    const form = buildCreativeRequest(makeRequest('instant_form_lead')).params;
    const oss = JSON.parse(form['object_story_spec'] ?? 'null') as Record<string, unknown>;
    const cta = (oss['video_data'] as Record<string, unknown>)['call_to_action'] as Record<string, unknown>;
    eq(cta['value'], { lead_gen_form_id: '2384852000000012345' }, 'instant form CTA value');
    must(!('url_tags' in form), 'an instant form ad has nowhere to append url_tags to');
    return 'website creatives carry the macro url_tags; a fragmented URL is refused; instant forms carry the form id and no tags';
  });

  // -------------------------------------------------------------------------
  // 9. What this environment cannot settle
  // -------------------------------------------------------------------------

  await check('the built bodies are accepted by Meta (VALIDATE / execution_options=validate_only)', async () => {
    const { loadDotEnv } = await import('../config.ts');
    try {
      loadDotEnv('/home/user/completeAdAutomation/.env');
    } catch {
      // fall through to the credential check
    }
    const token = process.env['META_SYSTEM_USER_TOKEN'];
    const appId = process.env['META_APP_ID'];
    const appSecret = process.env['META_APP_SECRET'];
    if (!token || !appId || !appSecret) {
      skip('no Meta credentials in the environment', 'META_APP_ID / META_APP_SECRET / META_SYSTEM_USER_TOKEN are unset.');
    }
    const client = new MetaClient({ appId, appSecret, accessToken: token, mode: 'SIMULATE' });
    let accounts: Array<{ id?: string }>;
    try {
      const res = await client.get<{ data?: Array<{ id?: string }> }>('me/adaccounts', { limit: '5' });
      accounts = res.data ?? [];
    } catch (e) {
      skip('Meta API unreachable', `read-only GET /me/adaccounts failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (accounts.length === 0) {
      skip(
        'no ad account assigned to the system user',
        'Read-only GET /me/adaccounts returned 0 accounts, so no campaign/ad-set/ad body can be sent to Meta ' +
          'with execution_options=["validate_only"] to settle the INFERRED tuples (website_purchase, ' +
          'catalog_sales, whatsapp_conversation, phone_call), the campaign-vs-ad-set home of bid_amount, or ' +
          'whether destination_type=WEBSITE is truly illegal under OUTCOME_TRAFFIC. Assign an ad account in ' +
          'Business Settings and re-run in VALIDATE. No object was created by this probe.',
      );
    }
    skip(
      'ABSOLUTE RULE: do not go live',
      `GET /me/adaccounts returned ${accounts.length} account(s), but sending a create body — even with ` +
        `execution_options=["validate_only"] — is a POST to /campaigns, which this task forbids. Run it ` +
        `deliberately in VALIDATE mode outside the probe.`,
    );
  });

  await check('the inferred archetype tuples are surfaced, not silently trusted', () => {
    const inferred = ALL_ARCHETYPES.filter((a) => ARCHETYPES[a].confidence === 'inferred');
    must(inferred.length > 0, 'no archetype is marked inferred, which contradicts objectives.ts');
    for (const archetype of inferred) {
      const base = makeRequest(archetype);
      const req: PublishRequest = {
        ...base,
        creative: { ...base.creative, link: base.config.destination.url ?? 'https://m.me/102938475610293' },
      };
      const warnings = validatePublishRequest(req);
      must(
        warnings.some((w) => w.includes('INFERRED')),
        `${archetype} is confidence=inferred but validatePublishRequest emitted no INFERRED warning: ${JSON.stringify(warnings)}`,
      );
    }
    return `${inferred.join(', ')} each raise an INFERRED warning before any network call`;
  });

  await check('publishing into the wrong ad account is refused before anything is built', () => {
    refuses(
      () => buildCampaignRequest({ ...makeRequest('website_purchase'), account: { ...ACCOUNT, adAccountId: 'act_9999999999' } }),
      'path',
      'Refusing to publish into the wrong ad account',
    );
    refuses(
      () =>
        buildCampaignRequest({
          ...makeRequest('website_purchase'),
          account: { ...ACCOUNT, adAccountId: '1234567890123456' },
        }),
      'path',
      'must carry the act_ prefix',
    );
    const { path } = buildCampaignRequest(makeRequest('website_purchase'));
    eq(path, 'act_1234567890123456/campaigns', 'path carries the prefix and no leading slash');
    return 'a mismatched or unprefixed ad account id is refused; the path is act_<id>/campaigns';
  });

  return { module: 'src/meta/publish.ts', checks };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const c of report.checks) {
    counts[c.status] += 1;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail}`);
    if (c.blockedBy !== undefined) console.log(`       blocked by: ${c.blockedBy}`);
  }
  console.log(`\n${report.module}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}
