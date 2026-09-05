import test from 'node:test';
import assert from 'node:assert/strict';

import type { Brand, ResolvedAdConfig, SpecialAdCategory } from '../src/domain/brand.ts';
import { resolveAdConfig } from '../src/domain/brand.ts';
import type { ConversionArchetype } from '../src/meta/objectives.ts';
import {
  AMBIGUOUS_MINOR_UNIT_CURRENCIES,
  CREATIVE_FEATURES_OPT_OUT,
  DEFAULT_URL_TAGS,
  EU_DSA_COUNTRIES,
  NAME_MAX_LENGTH,
  NAME_STAMP_RESERVE,
  PublishBuildError,
  ZERO_DECIMAL_CURRENCIES,
  buildActivationRequest,
  buildAdRequest,
  buildAdSetRequest,
  buildCampaignRequest,
  buildCreativeRequest,
  buildPauseRequest,
  buildTargeting,
  conversionDomain,
  currencyOffset,
  euExposure,
  objectName,
  parseObjectName,
  validatePublishRequest,
  type AccountContext,
  type PublishOptions,
  type PublishRequest,
  type TargetingInput,
  type VideoCreativeInput,
} from '../src/meta/publish.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'act_1234567890';

function makeBrand(overrides: Partial<Brand> = {}): Brand {
  const base: Brand = {
    id: 'acme',
    name: 'Acme',
    pageId: '111222333',
    adAccountId: ACCOUNT_ID,
    instagramUserId: '999888777',
    archetype: 'website_purchase',
    destination: {
      url: 'https://shop.acme.com/serum',
      pixelId: '5550001',
      customEventType: 'PURCHASE',
    },
    spend: { dailyBudgetMinor: 5000, maxDailyBudgetMinor: 20000, targetCpaMinor: 4000 },
    claims: { substantiated: ['Free shipping'], neverSay: [], neverShow: [], likenessRightsConfirmed: true },
    specialAdCategories: ['NONE'],
    countries: ['US'],
    proposition: 'A serum.',
  };
  return { ...base, ...overrides };
}

function makeAccount(overrides: Partial<AccountContext> = {}): AccountContext {
  return { adAccountId: ACCOUNT_ID, currency: 'USD', ...overrides };
}

const TARGETING: TargetingInput = { geo: { countries: ['US'] } };

const CREATIVE: VideoCreativeInput = {
  videoId: '77001',
  imageHash: 'abc123hash',
  message: 'Solved in 30 seconds.',
  title: 'Meet the serum',
  linkDescription: 'Free shipping over $40',
  callToActionType: 'SHOP_NOW',
};

interface RequestOverrides {
  brand?: Partial<Brand>;
  account?: Partial<AccountContext>;
  targeting?: TargetingInput;
  creative?: Partial<VideoCreativeInput>;
  options?: PublishOptions;
  variant?: string;
}

function makeRequest(o: RequestOverrides = {}): PublishRequest {
  const brand = makeBrand(o.brand);
  const config: ResolvedAdConfig = resolveAdConfig(brand);
  return {
    config,
    account: makeAccount({ adAccountId: brand.adAccountId, ...o.account }),
    variant: o.variant ?? 'hook-a-v1',
    targeting: o.targeting ?? TARGETING,
    creative: { ...CREATIVE, ...o.creative },
    ...(o.options !== undefined ? { options: o.options } : {}),
  };
}

/** Asserts a PublishBuildError whose message names the cause, not just "invalid". */
function assertFails(fn: () => unknown, field: string, messageIncludes: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PublishBuildError, `expected PublishBuildError, got ${String(e)}`);
    assert.equal(e.field, field);
    assert.ok(
      e.message.includes(messageIncludes),
      `message "${e.message}" does not mention "${messageIncludes}"`,
    );
    return;
  }
  assert.fail(`expected a PublishBuildError on ${field}`);
}

function json(params: Record<string, string>, key: string): unknown {
  const raw = params[key];
  assert.ok(raw !== undefined, `${key} is missing from the params`);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

test('currency: the eleven zero-decimal currencies have offset 1, including CRC', () => {
  assert.equal(ZERO_DECIMAL_CURRENCIES.size, 11);
  for (const code of ['CLP', 'COP', 'CRC', 'HUF', 'IDR', 'ISK', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']) {
    assert.equal(currencyOffset(code), 1, `${code} should be offset 1`);
  }
  // CRC is the entry most published "zero decimal" lists omit; a /100 there is a 100x money bug.
  assert.ok(ZERO_DECIMAL_CURRENCIES.has('CRC'));
});

test('currency: ordinary currencies are hundredths', () => {
  for (const code of ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'BRL']) {
    assert.equal(currencyOffset(code), 100);
  }
  assert.equal(currencyOffset('usd'), 100, 'case is normalised');
});

test('currency: refuses to guess where Meta and ISO 4217 disagree', () => {
  for (const code of ['UGX', 'XOF', 'BHD', 'KWD']) {
    assert.ok(AMBIGUOUS_MINOR_UNIT_CURRENCIES.has(code));
    assertFails(() => currencyOffset(code), 'currency', 'no offset this system is willing to assume');
  }
  assertFails(() => currencyOffset('DOLLARS'), 'currency', 'ISO 4217');
});

test('currency: an explicit account offset overrides the table', () => {
  const req = makeRequest({ account: { currency: 'UGX', currencyOffset: 1 } });
  const params = buildCampaignRequest(req).params;
  assert.equal(params['daily_budget'], '5000');
});

test('currency: an offset-1 account gets a loud warning that the figure is whole units', () => {
  const warnings = validatePublishRequest(makeRequest({ account: { currency: 'JPY' } }));
  assert.ok(warnings.some((w) => w.includes('offset 1') && w.includes('whole units')));
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('naming: deterministic, parseable, and round-trips through the idempotency stamp', () => {
  const parts = { brandId: 'acme', archetype: 'website_purchase', level: 'campaign' as const, variant: 'hook-a-v1' };
  const name = objectName(parts);
  assert.equal(name, 'AUTO/acme/website_purchase/cmp/hook-a-v1');
  assert.equal(objectName(parts), name, 'same intent must always yield the same name');
  assert.deepEqual(parseObjectName(name), parts);
  // idempotency.stampIntentKey appends this; parsing must survive it.
  assert.deepEqual(parseObjectName(`${name} [idem:0123456789abcdef0123456789abcdef]`), parts);
});

test('naming: rejects a name that would leave no room for the idempotency stamp', () => {
  // The creative name ceiling is 100 and 40 are reserved for the stamp.
  assertFails(
    () => objectName({
      brandId: 'a-very-long-brand-slug-indeed',
      archetype: 'whatsapp_conversation',
      level: 'creative',
      variant: 'an-equally-long-variant-slug',
    }),
    'name',
    'reserved for the idempotency stamp',
  );
});

test('naming: rejects non-slug inputs so names stay stable and parseable', () => {
  assertFails(
    () => objectName({ brandId: 'Acme Inc', archetype: 'traffic', level: 'ad', variant: 'v1' }),
    'name',
    'lowercase slug',
  );
  assert.equal(parseObjectName('Some Human Campaign'), undefined);
});

test('naming: every level of the tree is named deterministically', () => {
  const req = makeRequest();
  assert.equal(buildCampaignRequest(req).params['name'], 'AUTO/acme/website_purchase/cmp/hook-a-v1');
  assert.equal(buildAdSetRequest(req, { campaignId: '1' }).params['name'], 'AUTO/acme/website_purchase/set/hook-a-v1');
  assert.equal(buildCreativeRequest(req).params['name'], 'AUTO/acme/website_purchase/crt/hook-a-v1');
  assert.equal(
    buildAdRequest(req, { adSetId: '1', creativeId: '2' }).params['name'],
    'AUTO/acme/website_purchase/ad/hook-a-v1',
  );
});

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

test('campaign: special_ad_categories is sent as an ARRAY on every create', () => {
  const { path, params } = buildCampaignRequest(makeRequest());
  assert.equal(path, `${ACCOUNT_ID}/campaigns`);
  assert.deepEqual(json(params, 'special_ad_categories'), ['NONE']);
  assert.equal(params['objective'], 'OUTCOME_SALES');
  assert.equal(params['status'], 'PAUSED');
  assert.equal(params['buying_type'], 'AUCTION');
  assert.equal(params['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP');
  assert.equal(params['daily_budget'], '5000');
  // The account id belongs in the path and must never appear in the body.
  assert.ok(!('account_id' in params) && !('ad_account_id' in params));
});

test('campaign: an empty specialAdCategories list is refused, not silently defaulted', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ brand: { specialAdCategories: [] } })),
    'special_ad_categories',
    'required on every campaign create',
  );
});

test('campaign: SIEP is refused outright rather than failing at Meta', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({
      brand: { specialAdCategories: ['ISSUES_ELECTIONS_POLITICS'] as SpecialAdCategory[] },
    })),
    'special_ad_categories',
    'SIEP advertiser authorization',
  );
});

test('campaign: a restricted category demands an explicit special_ad_category_country', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ brand: { specialAdCategories: ['HOUSING'], countries: [] } })),
    'special_ad_category_country',
    'tax country',
  );
  const params = buildCampaignRequest(makeRequest({
    brand: { specialAdCategories: ['HOUSING'], countries: ['US'] },
  })).params;
  assert.deepEqual(json(params, 'special_ad_category_country'), ['US']);
});

test('campaign: ad-set budgets require is_adset_budget_sharing_enabled and move bid_strategy down', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { budgetLevel: 'adset' } })),
    'is_adset_budget_sharing_enabled',
    'required on campaign creation when budgets go on ad sets',
  );

  const req = makeRequest({ options: { budgetLevel: 'adset', adSetBudgetSharing: true } });
  const campaign = buildCampaignRequest(req).params;
  assert.equal(campaign['is_adset_budget_sharing_enabled'], 'true');
  assert.equal(campaign['daily_budget'], undefined, 'the budget must live in exactly one place');
  assert.equal(campaign['bid_strategy'], undefined, 'bid_strategy follows the budget');

  const adset = buildAdSetRequest(req, { campaignId: '900' }).params;
  assert.equal(adset['daily_budget'], '5000');
  assert.equal(adset['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP');
});

test('campaign: labels are attached to every object so reconciliation can find the tree', () => {
  const req = makeRequest({ options: { adLabelIds: ['lbl_1'] } });
  for (const params of [
    buildCampaignRequest(req).params,
    buildAdSetRequest(req, { campaignId: '1' }).params,
    buildCreativeRequest(req).params,
    buildAdRequest(req, { adSetId: '1', creativeId: '2' }).params,
  ]) {
    assert.deepEqual(json(params, 'adlabels'), [{ id: 'lbl_1' }]);
  }
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('budget: refuses a daily budget below the account minimum from /minimum_budgets', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({
      brand: { spend: { dailyBudgetMinor: 300, maxDailyBudgetMinor: 20000, targetCpaMinor: 4000 } },
      account: { minDailyBudgetMinor: 500 },
    })),
    'daily_budget',
    '3.00 USD is below the account minimum of 5.00 USD',
  );
});

test('budget: a non-integer minor-unit amount is refused', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({
      brand: { spend: { dailyBudgetMinor: 50.5, maxDailyBudgetMinor: 20000, targetCpaMinor: 4000 } },
    })),
    'daily_budget',
    'integers in the account\'s minor units',
  );
});

test('budget: a lifetime budget without end_time is refused', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { lifetimeBudgetMinor: 100000 } })),
    'lifetime_budget',
    'requires end_time',
  );
  const params = buildCampaignRequest(makeRequest({
    options: {
      lifetimeBudgetMinor: 100000,
      startTime: '2026-10-01T00:00:00Z',
      endTime: '2026-10-08T00:00:00Z',
    },
  })).params;
  assert.equal(params['lifetime_budget'], '100000');
  assert.equal(params['daily_budget'], undefined);
});

test('budget: a lifetime budget may not outrun the brand ceiling on the implied daily rate', () => {
  // 20000/day ceiling; 500000 over a 7-day flight paces at 71429/day.
  assertFails(
    () => buildCampaignRequest(makeRequest({
      options: {
        lifetimeBudgetMinor: 500000,
        startTime: '2026-10-01T00:00:00Z',
        endTime: '2026-10-08T00:00:00Z',
      },
    })),
    'lifetime_budget',
    'above brand "acme" ceiling of 200.00 USD/day',
  );
  // The same money over a long enough flight is inside the envelope and publishes.
  const ok = buildCampaignRequest(makeRequest({
    options: {
      lifetimeBudgetMinor: 500000,
      startTime: '2026-10-01T00:00:00Z',
      endTime: '2026-12-01T00:00:00Z',
    },
  })).params;
  assert.equal(ok['lifetime_budget'], '500000');
});

test('budget: an unbounded lifetime flight is refused, because a rate needs a start', () => {
  // Without start_time there is no flight length, so there is no daily rate to check the
  // brand envelope against — the one path by which a lifetime budget could escape it.
  assertFails(
    () => buildCampaignRequest(makeRequest({
      options: { lifetimeBudgetMinor: 500000, endTime: '2026-10-08T00:00:00Z' },
    })),
    'start_time',
    'will not publish a lifetime budget it cannot bound',
  );
});

test('budget: a campaign-level lifetime budget warns that its flight lives on the ad set', () => {
  const warnings = validatePublishRequest(makeRequest({
    options: {
      lifetimeBudgetMinor: 100000,
      startTime: '2026-10-01T00:00:00Z',
      endTime: '2026-10-08T00:00:00Z',
    },
  }));
  assert.ok(warnings.some((w) => w.includes('lifetime_budget is on the campaign') && w.includes('UNVERIFIED')));
});

test('budget: a daily budget on a sub-24h flight is refused', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({
      options: { startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-01T18:00:00Z' },
    })),
    'daily_budget',
    'longer than 24 hours',
  );
});

test('budget: bid_amount is required by capped strategies and refused by uncapped ones', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { bidStrategy: 'COST_CAP' } })),
    'bid_amount',
    'required by bid_strategy=COST_CAP',
  );
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { bidAmountMinor: 500 } })),
    'bid_amount',
    'not accepted with bid_strategy=LOWEST_COST_WITHOUT_CAP',
  );

  const warnings = validatePublishRequest(makeRequest({
    options: { bidStrategy: 'COST_CAP', bidAmountMinor: 500 },
  }));
  // The off-by-1000 trap: with IMPRESSIONS billing this is a CPM, not a CPA.
  assert.ok(warnings.some((w) => w.includes('per 1,000 occurrences') && w.includes('CPM')));
});

test('budget: the ROAS-floor strategy is refused because the field name is unverified', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS' } })),
    'bid_strategy',
    'Refusing to guess',
  );
});

test('budget: spend_cap floor is enforced for USD and flagged as unverified elsewhere', () => {
  assertFails(
    () => buildCampaignRequest(makeRequest({ options: { spendCapMinor: 5000 } })),
    'spend_cap',
    '$100 USD minimum',
  );
  const warnings = validatePublishRequest(makeRequest({
    account: { currency: 'EUR' },
    options: { spendCapMinor: 5000 },
  }));
  assert.ok(warnings.some((w) => w.includes('spend_cap') && w.includes('UNVERIFIED')));
});

test('budget: an ad may never exceed the brand ceiling, even if the caller hand-builds the config', () => {
  const brand = makeBrand();
  const config: ResolvedAdConfig = { ...resolveAdConfig(brand), dailyBudgetMinor: 999999 };
  assertFails(
    () => buildCampaignRequest({
      config,
      account: makeAccount(),
      variant: 'v1',
      targeting: TARGETING,
      creative: CREATIVE,
    }),
    'daily_budget',
    'exceeds brand "acme" ceiling',
  );
});

// ---------------------------------------------------------------------------
// Ad set: destination_type, promoted_object, attribution
// ---------------------------------------------------------------------------

test('adset: destination_type is OMITTED, not sent empty, when the archetype says so', () => {
  const traffic = makeRequest({
    brand: { archetype: 'traffic', destination: { url: 'https://acme.com/lp' } },
  });
  const params = buildAdSetRequest(traffic, { campaignId: '900' }).params;
  assert.ok(!('destination_type' in params), 'OUTCOME_TRAFFIC does not list WEBSITE — the field must be absent');

  const sales = buildAdSetRequest(makeRequest(), { campaignId: '900' }).params;
  assert.equal(sales['destination_type'], 'WEBSITE');
});

test('adset: promoted_object shape differs per archetype', () => {
  const cases: Array<[ConversionArchetype, Partial<Brand>, unknown]> = [
    [
      'website_purchase',
      {},
      { pixel_id: '5550001', custom_event_type: 'PURCHASE' },
    ],
    [
      'instant_form_lead',
      { archetype: 'instant_form_lead', destination: { leadFormId: '4001' } },
      { page_id: '111222333' },
    ],
    [
      'app_install',
      {
        archetype: 'app_install',
        destination: { applicationId: '8001', objectStoreUrl: 'https://apps.apple.com/app/id1' },
      },
      { application_id: '8001', object_store_url: 'https://apps.apple.com/app/id1' },
    ],
    [
      'catalog_sales',
      { archetype: 'catalog_sales', destination: { productSetId: '6001', customEventType: 'PURCHASE' } },
      { product_set_id: '6001', custom_event_type: 'PURCHASE' },
    ],
  ];

  for (const [archetype, brandPatch, expected] of cases) {
    const req = makeRequest({
      brand: brandPatch,
      creative: archetype === 'instant_form_lead' ? { callToActionType: 'SIGN_UP' } : {},
    });
    const params = buildAdSetRequest(req, { campaignId: '900' }).params;
    assert.deepEqual(json(params, 'promoted_object'), expected, `${archetype} promoted_object`);
  }

  // promoted_object is absent entirely for the 'none' kind.
  const traffic = buildAdSetRequest(
    makeRequest({ brand: { archetype: 'traffic', destination: { url: 'https://acme.com/lp' } } }),
    { campaignId: '900' },
  ).params;
  assert.ok(!('promoted_object' in traffic));
});

test('adset: catalogue sales refuse to default the conversion event', () => {
  assertFails(
    () => buildAdSetRequest(
      makeRequest({ brand: { archetype: 'catalog_sales', destination: { productSetId: '6001' } } }),
      { campaignId: '900' },
    ),
    'promoted_object.custom_event_type',
    'will not default it',
  );
});

test('adset: attribution_spec is explicit for conversion goals and absent otherwise', () => {
  const sales = buildAdSetRequest(makeRequest(), { campaignId: '900' }).params;
  assert.deepEqual(json(sales, 'attribution_spec'), [
    { event_type: 'CLICK_THROUGH', window_days: 7 },
    { event_type: 'VIEW_THROUGH', window_days: 1 },
  ]);

  const traffic = buildAdSetRequest(
    makeRequest({ brand: { archetype: 'traffic', destination: { url: 'https://acme.com/lp' } } }),
    { campaignId: '900' },
  ).params;
  assert.ok(!('attribution_spec' in traffic), 'window lengths vary by goal; do not send an unsupported pair');
});

test('adset: billing_event and optimization_goal come from the archetype spec', () => {
  const params = buildAdSetRequest(makeRequest(), { campaignId: '900' }).params;
  assert.equal(params['billing_event'], 'IMPRESSIONS');
  assert.equal(params['optimization_goal'], 'OFFSITE_CONVERSIONS');
  assert.equal(params['campaign_id'], '900');
  assert.equal(params['status'], 'PAUSED');
});

test('adset: an empty campaign_id is refused rather than posted', () => {
  assertFails(() => buildAdSetRequest(makeRequest(), { campaignId: '' }), 'campaign_id', 'create the campaign first');
});

// ---------------------------------------------------------------------------
// EU DSA
// ---------------------------------------------------------------------------

test('dsa: EU targeting without BOTH fields is refused, naming the prose-only requirement', () => {
  const req = makeRequest({
    brand: { countries: ['DE'] },
    targeting: { geo: { countries: ['DE'] } },
  });
  assertFails(
    () => buildAdSetRequest(req, { campaignId: '900' }),
    'dsa_payor and dsa_beneficiary',
    'the requirement is prose only',
  );
});

test('dsa: supplying only one of the pair still fails, and names the missing one', () => {
  const req = makeRequest({
    targeting: { geo: { countries: ['FR'] } },
    options: { dsaPayor: 'Acme Ltd' },
  });
  assertFails(() => buildAdSetRequest(req, { campaignId: '900' }), 'dsa_beneficiary', 'BOTH dsa_payor');
});

test('dsa: account-level defaults satisfy the requirement and are emitted', () => {
  const req = makeRequest({
    targeting: { geo: { countries: ['IE'] } },
    account: { defaultDsaPayor: 'Acme Ltd', defaultDsaBeneficiary: 'Acme Ltd' },
  });
  const params = buildAdSetRequest(req, { campaignId: '900' }).params;
  assert.equal(params['dsa_payor'], 'Acme Ltd');
  assert.equal(params['dsa_beneficiary'], 'Acme Ltd');
});

test('dsa: opaque city keys make EU reach unknowable, so the fields are still required', () => {
  assert.equal(euExposure({ countries: ['US'] }), 'NO');
  assert.equal(euExposure({ countries: ['US'], cities: [{ key: '2430536' }] }), 'UNKNOWN');
  assert.equal(euExposure({ countries: ['ES'] }), 'YES');
  // Associated territories count too — the set errs inclusive on purpose.
  assert.ok(EU_DSA_COUNTRIES.has('GF') && EU_DSA_COUNTRIES.has('NO'));

  assertFails(
    () => buildAdSetRequest(
      makeRequest({ targeting: { geo: { countries: ['US'], cities: [{ key: '2430536' }] } } }),
      { campaignId: '900' },
    ),
    'dsa_payor and dsa_beneficiary',
    'EU reach cannot be ruled out',
  );
});

test('dsa: a non-EU ad set warns that the guidance is to set them unconditionally', () => {
  const warnings = validatePublishRequest(makeRequest());
  assert.ok(warnings.some((w) => w.includes('dsa_payor') && w.includes('unconditionally')));
});

test('dsa: over-long values are refused at 512 chars', () => {
  const req = makeRequest({
    targeting: { geo: { countries: ['DE'] } },
    options: { dsaPayor: 'x'.repeat(513), dsaBeneficiary: 'Acme' },
  });
  assertFails(() => buildAdSetRequest(req, { campaignId: '900' }), 'dsa_payor', '513 chars');
});

// ---------------------------------------------------------------------------
// Special ad category targeting restrictions
// ---------------------------------------------------------------------------

const RESTRICTED: readonly SpecialAdCategory[] = ['HOUSING'];

test('category: gender selection is refused under a restricted category', () => {
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, genders: [1] }, RESTRICTED),
    'targeting.genders',
    'forbids gender selection',
  );
  // Legal without the category.
  const spec = buildTargeting({ geo: { countries: ['US'] }, genders: [1] }, ['NONE']);
  assert.deepEqual(spec['genders'], [1]);
});

test('category: the age range is fixed at 18-65+', () => {
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, ageMin: 25 }, RESTRICTED),
    'targeting.age_min',
    'fixes the age range to 18-65+',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, ageMax: 54 }, RESTRICTED),
    'targeting.age_max',
    'fixes the age range to 18-65+',
  );
  // Stating the mandated range explicitly is fine.
  const spec = buildTargeting({ geo: { countries: ['US'] }, ageMin: 18, ageMax: 65 }, RESTRICTED);
  assert.equal(spec['age_min'], 18);
});

test('category: location exclusion, zips, lookalikes, behaviours and interests are all refused', () => {
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, excludedGeo: { countries: ['CA'] } }, RESTRICTED),
    'targeting.excluded_geo_locations',
    'does not support location exclusion',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'], zips: [{ key: 'US:94304' }] } }, RESTRICTED),
    'targeting.geo_locations.zips',
    'prohibits these location granularities',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, lookalikeAudienceIds: ['600'] }, RESTRICTED),
    'targeting.custom_audiences',
    'Lookalike audiences are unavailable',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, behaviors: [{ id: '6002' }] }, RESTRICTED),
    'targeting.behaviors',
    'blocks Behaviour and Demographic targeting',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, interests: [{ id: '6003' }] }, RESTRICTED),
    'targeting.interests',
    'previously approved allowlist',
  );
});

test('category: the minimum radius is enforced per regime and the unit must be stated', () => {
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'], cities: [{ key: '1', radius: 10 }] } }, RESTRICTED),
    'targeting.geo_locations.cities.distance_unit',
    'default distance unit is undocumented',
  );
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['US'], cities: [{ key: '1', radius: 10, distanceUnit: 'mile' }] } },
      RESTRICTED,
    ),
    'targeting.geo_locations.cities.radius',
    'at least 15 mile',
  );
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['CA'], cities: [{ key: '1', radius: 20, distanceUnit: 'kilometer' }] } },
      RESTRICTED,
    ),
    'targeting.geo_locations.cities.radius',
    'at least 25 kilometer',
  );
  // Europe: 15 km, and Meta publishes no mile equivalent, so miles are refused rather than converted.
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['DE'], cities: [{ key: '1', radius: 20, distanceUnit: 'mile' }] } },
      RESTRICTED,
    ),
    'targeting.geo_locations.cities.radius',
    'no mile equivalent',
  );
  const ok = buildTargeting(
    { geo: { countries: ['DE'], cities: [{ key: '1', radius: 15, distanceUnit: 'kilometer' }] } },
    RESTRICTED,
  );
  assert.deepEqual(ok['geo_locations'], {
    countries: ['DE'],
    cities: [{ key: '1', radius: 15, distance_unit: 'kilometer' }],
  });
});

// ---------------------------------------------------------------------------
// Targeting shape, Advantage+ and placements
// ---------------------------------------------------------------------------

test('targeting: a country is mandatory', () => {
  assertFails(
    () => buildTargeting({ geo: {} }, ['NONE']),
    'targeting.geo_locations.countries',
    'at least one ISO-2 country is required',
  );
  assertFails(
    () => buildTargeting({ geo: { countries: ['USA'] } }, ['NONE']),
    'targeting.geo_locations.countries',
    'not an ISO-2 country code',
  );
});

test('targeting: advantage_audience is always emitted explicitly (v26.0 create requirement)', () => {
  const spec = buildTargeting({ geo: { countries: ['US'] } }, ['NONE']);
  assert.deepEqual(spec['targeting_automation'], { advantage_audience: 1 });

  const optedOut = buildTargeting({ geo: { countries: ['US'] }, advantageAudience: 0 }, ['NONE']);
  assert.deepEqual(optedOut['targeting_automation'], { advantage_audience: 0 });
});

test('targeting: Advantage+ placements means no placement fields at all', () => {
  const params = buildAdSetRequest(makeRequest(), { campaignId: '900' }).params;
  const targeting = json(params, 'targeting') as Record<string, unknown>;
  for (const key of ['publisher_platforms', 'facebook_positions', 'instagram_positions', 'device_platforms']) {
    assert.ok(!(key in targeting), `${key} must be absent for advantage_placement_state ENABLED`);
  }
});

test('targeting: manual placements warn that they disable the whole advantage_state', () => {
  const warnings: string[] = [];
  buildTargeting(
    {
      geo: { countries: ['US'] },
      placements: { publisherPlatforms: ['facebook', 'instagram'], facebookPositions: ['feed'] },
    },
    ['NONE'],
    warnings,
  );
  assert.ok(warnings.some((w) => w.includes('advantage_placement_state will be DISABLED')));
});

test('targeting: v26.0 removed placements are refused, and dead ones warn', () => {
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['US'] }, placements: { publisherPlatforms: ['instagram'], instagramPositions: ['explore'] } },
      ['NONE'],
    ),
    'targeting.instagram_positions',
    'removed in v26.0',
  );
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['US'] }, placements: { publisherPlatforms: ['messenger'], messengerPositions: ['story'] } },
      ['NONE'],
    ),
    'targeting.messenger_positions',
    'silently dropped',
  );
  const warnings: string[] = [];
  buildTargeting(
    { geo: { countries: ['US'] }, placements: { publisherPlatforms: ['facebook'], facebookPositions: ['video_feeds'] } },
    ['NONE'],
    warnings,
  );
  assert.ok(warnings.some((w) => w.includes('stopped delivering at v24.0')));
});

test('targeting: a position without its publisher platform is refused', () => {
  assertFails(
    () => buildTargeting(
      { geo: { countries: ['US'] }, placements: { publisherPlatforms: ['facebook'], instagramPositions: ['reels'] } },
      ['NONE'],
    ),
    'targeting.instagram_positions',
    'A position without its platform is a code 100',
  );

  // The same mistake with publisher_platforms omitted entirely slips past that refusal,
  // so it must at least be said out loud rather than posted in silence.
  const warnings: string[] = [];
  const spec = buildTargeting(
    { geo: { countries: ['US'] }, placements: { instagramPositions: ['reels'] } },
    ['NONE'],
    warnings,
  );
  assert.deepEqual(spec['instagram_positions'], ['reels']);
  assert.ok(
    warnings.some((w) => w.includes('publisher_platforms is not set at all')),
    'positions without any publisher_platforms must warn',
  );
});

test('targeting: audience limits are enforced', () => {
  const many = Array.from({ length: 501 }, (_, i) => String(i));
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, customAudienceIds: many }, ['NONE']),
    'targeting.custom_audiences',
    'limit of 500',
  );
});

// ---------------------------------------------------------------------------
// Creative
// ---------------------------------------------------------------------------

test('creative: object_story_spec carries video_data with the URL only in the CTA', () => {
  const { path, params } = buildCreativeRequest(makeRequest());
  assert.equal(path, `${ACCOUNT_ID}/adcreatives`);
  assert.deepEqual(json(params, 'object_story_spec'), {
    page_id: '111222333',
    instagram_user_id: '999888777',
    video_data: {
      video_id: '77001',
      image_hash: 'abc123hash',
      message: 'Solved in 30 seconds.',
      title: 'Meet the serum',
      link_description: 'Free shipping over $40',
      call_to_action: { type: 'SHOP_NOW', value: { link: 'https://shop.acme.com/serum' } },
    },
  });
  assert.equal(params['url_tags'], DEFAULT_URL_TAGS);
});

test('creative: exactly one poster source is required', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({ creative: { imageHash: 'h', imageUrl: 'https://cdn.acme.com/t.jpg' } })),
    'object_story_spec.video_data.image_hash',
    'exactly one of image_hash or image_url',
  );
  const noPoster = makeRequest();
  const creativeWithoutPoster = { ...noPoster.creative };
  delete (creativeWithoutPoster as { imageHash?: string }).imageHash;
  assertFails(
    () => buildCreativeRequest({ ...noPoster, creative: creativeWithoutPoster }),
    'object_story_spec.video_data.image_hash',
    'a poster is required',
  );
});

test('creative: an FB CDN thumbnail is refused', () => {
  const req = makeRequest({ creative: { imageUrl: 'https://scontent.xx.fbcdn.net/v/t1.jpg' } });
  const withoutHash = { ...req.creative };
  delete (withoutHash as { imageHash?: string }).imageHash;
  assertFails(
    () => buildCreativeRequest({ ...req, creative: withoutHash }),
    'object_story_spec.video_data.image_url',
    'should not use image URLs returned from the FB CDN',
  );
});

test('creative: LIKE_PAGE cannot coexist with a title, and unknown CTA types are refused', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({ creative: { callToActionType: 'LIKE_PAGE' } })),
    'object_story_spec.video_data.call_to_action.type',
    'cannot be used with a title',
  );
  assertFails(
    () => buildCreativeRequest(makeRequest({
      creative: { callToActionType: 'SHOP_NOW_PLEASE' as VideoCreativeInput['callToActionType'] },
    })),
    'object_story_spec.video_data.call_to_action.type',
    'not in the v26.0 enum',
  );
});

test('creative: a CTA outside the known-safe set warns with the documented fallback', () => {
  const warnings = validatePublishRequest(makeRequest({ creative: { callToActionType: 'DONATE' } }));
  assert.ok(warnings.some((w) => w.includes('outside the known-safe set for OUTCOME_SALES') && w.includes('LEARN_MORE')));
});

test('creative: copy over the display limit warns; over the API limit throws', () => {
  const warnings = validatePublishRequest(makeRequest({
    creative: { message: 'x'.repeat(120), title: 'y'.repeat(60) },
  }));
  assert.ok(warnings.some((w) => w.includes('display limit is 40')));
  assert.ok(warnings.some((w) => w.includes('display limit is 27')));

  assertFails(
    () => buildCreativeRequest(makeRequest({ creative: { message: 'x'.repeat(1025) } })),
    'object_story_spec.video_data.message',
    'over the 1024 limit',
  );
});

test('creative: degrees_of_freedom_spec opts out of every transforming feature', () => {
  const params = buildCreativeRequest(makeRequest()).params;
  const dof = json(params, 'degrees_of_freedom_spec') as {
    creative_features_spec: Record<string, { enroll_status: string }>;
  };
  assert.equal(Object.keys(dof.creative_features_spec).length, CREATIVE_FEATURES_OPT_OUT.length);
  for (const key of CREATIVE_FEATURES_OPT_OUT) {
    assert.equal(dof.creative_features_spec[key]?.enroll_status, 'OPT_OUT', `${key} must be OPT_OUT`);
  }
  // The video keys are the ones that would silently regrade or recrop a generated asset.
  for (const key of ['video_auto_crop', 'video_uncrop', 'video_filtering']) {
    assert.ok(key in dof.creative_features_spec);
  }
});

test('creative: an opt-in flips exactly one key and an unknown key is refused', () => {
  const params = buildCreativeRequest(makeRequest({ creative: { featureOptIns: ['adapt_to_placement'] } })).params;
  const dof = json(params, 'degrees_of_freedom_spec') as {
    creative_features_spec: Record<string, { enroll_status: string }>;
  };
  assert.equal(dof.creative_features_spec['adapt_to_placement']?.enroll_status, 'OPT_IN');
  assert.equal(dof.creative_features_spec['text_optimizations']?.enroll_status, 'OPT_OUT');

  assertFails(
    () => buildCreativeRequest(makeRequest({ creative: { featureOptIns: ['make_it_pop'] } })),
    'degrees_of_freedom_spec.creative_features_spec',
    'not a known creative feature key',
  );
});

test('creative: guide-only feature keys warn that the read-back may not match', () => {
  const warnings = validatePublishRequest(makeRequest({ creative: { featureOptIns: ['video_filtering'] } }));
  assert.ok(warnings.some((w) => w.includes('absent from the typed')));
});

test('creative: a destination URL with a fragment is refused because url_tags would be lost', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({ creative: { link: 'https://acme.com/lp#offer' } })),
    'call_to_action.value.link',
    'contains a fragment',
  );
});

test('creative: an instant form puts the form id in the CTA and sends no link or url_tags', () => {
  const req = makeRequest({
    brand: { archetype: 'instant_form_lead', destination: { leadFormId: '4001' } },
    creative: { callToActionType: 'SIGN_UP' },
  });
  const params = buildCreativeRequest(req).params;
  const spec = json(params, 'object_story_spec') as {
    video_data: { call_to_action: { type: string; value: Record<string, string> } };
  };
  assert.deepEqual(spec.video_data.call_to_action, { type: 'SIGN_UP', value: { lead_gen_form_id: '4001' } });
  assert.ok(!('url_tags' in params), 'no click URL means no url_tags');
});

test('creative: a missing Instagram identity warns about the PBIA branding penalty', () => {
  const brand = makeBrand();
  delete (brand as { instagramUserId?: string }).instagramUserId;
  const warnings = validatePublishRequest({
    config: resolveAdConfig(brand),
    account: makeAccount(),
    variant: 'v1',
    targeting: TARGETING,
    creative: CREATIVE,
  });
  assert.ok(warnings.some((w) => w.includes('Page-Backed Instagram Account')));
});

test('creative: url_tags must not carry its own separator', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({ options: { urlTags: '?utm_source=facebook' } })),
    'url_tags',
    'must not start with ? or &',
  );
});

// ---------------------------------------------------------------------------
// Ad and conversion_domain
// ---------------------------------------------------------------------------

test('ad: references the creative by id, stays PAUSED, and carries the eTLD+1', () => {
  const { path, params } = buildAdRequest(makeRequest(), { adSetId: '901', creativeId: '902' });
  assert.equal(path, `${ACCOUNT_ID}/ads`);
  assert.equal(params['adset_id'], '901');
  assert.deepEqual(json(params, 'creative'), { creative_id: '902' });
  assert.equal(params['status'], 'PAUSED');
  assert.equal(params['conversion_domain'], 'acme.com', 'subdomain and path must be stripped');
});

test('ad: conversion_domain is omitted when the campaign shares no pixel data', () => {
  const params = buildAdRequest(
    makeRequest({ brand: { archetype: 'traffic', destination: { url: 'https://acme.com/lp' } } }),
    { adSetId: '901', creativeId: '902' },
  ).params;
  assert.ok(!('conversion_domain' in params));
});

test('conversion_domain: derives the eTLD+1, and refuses to guess under a two-label suffix', () => {
  assert.equal(conversionDomain('https://shop.acme.com/serum'), 'acme.com');
  assert.equal(conversionDomain(undefined, 'Acme.com'), 'acme.com');
  assertFails(
    () => conversionDomain('https://shop.acme.co.uk/x'),
    'conversion_domain',
    'Public Suffix List this project does not carry',
  );
  assertFails(() => conversionDomain(undefined, 'https://acme.com/x'), 'conversion_domain', 'bare domain');
  assertFails(() => conversionDomain(undefined), 'conversion_domain', 'no destination URL was available');
});

test('ad: empty ids are refused rather than posted', () => {
  assertFails(
    () => buildAdRequest(makeRequest(), { adSetId: '', creativeId: '902' }),
    'adset_id',
    'create the ad set first',
  );
  assertFails(
    () => buildAdRequest(makeRequest(), { adSetId: '901', creativeId: '' }),
    'creative.creative_id',
    'create the creative first',
  );
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

test('activation: the one money-starting call is a bare status flip on a known id', () => {
  assert.deepEqual(buildActivationRequest('120210000000000000'), {
    path: '120210000000000000',
    params: { status: 'ACTIVE' },
  });
  assert.deepEqual(buildPauseRequest('120210000000000000'), {
    path: '120210000000000000',
    params: { status: 'PAUSED' },
  });
});

test('activation: a mangled object id is refused, since ids exceed 2^53', () => {
  assertFails(() => buildActivationRequest('1.2021e+17'), 'status', 'not a Meta object id');
  assertFails(() => buildActivationRequest(`${ACCOUNT_ID}`), 'status', 'not a Meta object id');
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

test('publishing into the wrong ad account is refused before anything is built', () => {
  const req = makeRequest();
  assertFails(
    () => buildCampaignRequest({ ...req, account: makeAccount({ adAccountId: 'act_999' }) }),
    'path',
    'Refusing to publish into the wrong ad account',
  );
  assertFails(
    () => buildCampaignRequest({ ...req, account: makeAccount({ adAccountId: '1234567890' }) }),
    'path',
    'must carry the act_ prefix',
  );
});

test('an inferred archetype tuple surfaces as a warning rather than passing silently', () => {
  const warnings = validatePublishRequest(makeRequest());
  assert.ok(
    warnings.some((w) => w.includes('INFERRED, not documented') && w.includes('website_purchase')),
    'OUTCOME_SALES has no documented ODAX mapping row — the code must say so',
  );
});

test('builders are pure: the same request yields byte-identical params every time', () => {
  const req = makeRequest();
  const once = {
    campaign: buildCampaignRequest(req),
    adset: buildAdSetRequest(req, { campaignId: '900' }),
    creative: buildCreativeRequest(req),
    ad: buildAdRequest(req, { adSetId: '901', creativeId: '902' }),
  };
  const twice = {
    campaign: buildCampaignRequest(req),
    adset: buildAdSetRequest(req, { campaignId: '900' }),
    creative: buildCreativeRequest(req),
    ad: buildAdRequest(req, { adSetId: '901', creativeId: '902' }),
  };
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test('every param value is a string, as the form encoder requires', () => {
  const req = makeRequest();
  for (const built of [
    buildCampaignRequest(req),
    buildAdSetRequest(req, { campaignId: '900' }),
    buildCreativeRequest(req),
    buildAdRequest(req, { adSetId: '901', creativeId: '902' }),
  ]) {
    for (const [k, v] of Object.entries(built.params)) {
      assert.equal(typeof v, 'string', `${built.path} ${k} must be a string`);
    }
    assert.ok(!built.path.startsWith('/'), 'the client joins the path itself');
  }
});

test('creative: catalogue ads are refused because they are a different creative shape', () => {
  const req = makeRequest({
    brand: { archetype: 'catalog_sales', destination: { productSetId: '6001', customEventType: 'PURCHASE' } },
  });
  // The campaign and ad set still build — only the video creative is out of scope.
  assert.equal(buildCampaignRequest(req).params['objective'], 'OUTCOME_SALES');
  assertFails(() => buildCreativeRequest(req), 'object_story_spec', 'template_data driven by the product feed');
});

test('creative: an app-install ad clicks through to the store listing already declared', () => {
  const req = makeRequest({
    brand: {
      archetype: 'app_install',
      destination: { applicationId: '8001', objectStoreUrl: 'https://apps.apple.com/app/id1' },
    },
    creative: { callToActionType: 'INSTALL_APP' },
  });
  const spec = json(buildCreativeRequest(req).params, 'object_story_spec') as {
    video_data: { call_to_action: { value: Record<string, string> } };
  };
  assert.deepEqual(spec.video_data.call_to_action.value, { link: 'https://apps.apple.com/app/id1' });
});

test('targeting: lookalikes and custom audiences share the 500 cap', () => {
  const custom = Array.from({ length: 400 }, (_, i) => `c${i}`);
  const lookalike = Array.from({ length: 101 }, (_, i) => `l${i}`);
  assertFails(
    () => buildTargeting({ geo: { countries: ['US'] }, customAudienceIds: custom, lookalikeAudienceIds: lookalike }, ['NONE']),
    'targeting.custom_audiences',
    'limit of 500',
  );
});

test('naming: a maximum-length name still fits the real idempotency stamp untruncated', async () => {
  const { stampIntentKey, extractIntentKey } = await import('../src/meta/idempotency.ts');
  const key = 'a'.repeat(32);
  for (const level of ['campaign', 'adset', 'ad', 'creative'] as const) {
    const budget = NAME_MAX_LENGTH[level] - NAME_STAMP_RESERVE;
    const base = objectName({
      brandId: 'b'.repeat(budget - 'AUTO/'.length - '/traffic/crt/v'.length),
      archetype: 'traffic',
      level,
      variant: 'v',
    });
    const stamped = stampIntentKey(base, key, NAME_MAX_LENGTH[level]);
    assert.ok(stamped.length <= NAME_MAX_LENGTH[level], `${level} stamped name overruns its ceiling`);
    assert.equal(extractIntentKey(stamped), key, 'the stamp must never be the thing that gets truncated');
    assert.equal(parseObjectName(stamped)?.level, level);
  }
});

// ---------------------------------------------------------------------------
// On-Meta destinations — the archetypes with no website URL
// ---------------------------------------------------------------------------

/** Exactly what domain/brand.ts demands per archetype, and not one field more. */
const ARCHETYPE_DESTINATIONS: Record<ConversionArchetype, Brand['destination']> = {
  website_purchase: { url: 'https://shop.acme.com/serum', pixelId: '5550001', customEventType: 'PURCHASE' },
  website_lead: { url: 'https://acme.com/consult', pixelId: '5550001', customEventType: 'LEAD' },
  instant_form_lead: { leadFormId: '4001' },
  messenger_lead: {},
  whatsapp_conversation: {},
  phone_call: { phoneNumber: '+15551234567' },
  catalog_sales: { productSetId: '6001', customEventType: 'PURCHASE' },
  traffic: { url: 'https://acme.com/lp' },
  app_install: { applicationId: '8001', objectStoreUrl: 'https://apps.apple.com/app/id1' },
};

const ARCHETYPE_CTA: Record<ConversionArchetype, VideoCreativeInput['callToActionType']> = {
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

function archetypeRequest(archetype: ConversionArchetype): PublishRequest {
  return makeRequest({
    brand: { archetype, destination: ARCHETYPE_DESTINATIONS[archetype] },
    creative: { callToActionType: ARCHETYPE_CTA[archetype] },
  });
}

test('publish: every archetype builds a whole tree from a Brand brand.ts accepts', () => {
  // The contract between domain/brand.ts and this module: a config the loader validates as
  // GOOD must be publishable without an operator discovering a second, undocumented field.
  const archetypes = Object.keys(ARCHETYPE_DESTINATIONS) as ConversionArchetype[];
  for (const archetype of archetypes) {
    const req = archetypeRequest(archetype);
    assert.ok(buildCampaignRequest(req).params['objective'], `${archetype}: campaign`);
    assert.ok(buildAdSetRequest(req, { campaignId: '1' }).params['optimization_goal'], `${archetype}: ad set`);
    assert.ok(
      buildAdRequest(req, { adSetId: '2', creativeId: '3' }).params['adset_id'],
      `${archetype}: ad`,
    );
    if (archetype === 'catalog_sales') continue; // a different creative shape, refused on purpose
    const value = (json(buildCreativeRequest(req).params, 'object_story_spec') as {
      video_data: { call_to_action: { value: Record<string, string> } };
    }).video_data.call_to_action.value;
    assert.ok(
      Object.keys(value).length > 0,
      `${archetype}: an empty call_to_action.value leaves the ad with no destination at all`,
    );
  }
});

test('creative: a click-to-message ad names its surface instead of demanding a URL', () => {
  for (const [archetype, appDestination] of [
    ['messenger_lead', 'MESSENGER'],
    ['whatsapp_conversation', 'WHATSAPP'],
  ] as const) {
    const params = buildCreativeRequest(archetypeRequest(archetype)).params;
    const spec = json(params, 'object_story_spec') as {
      video_data: { call_to_action: { value: Record<string, string> } };
    };
    assert.deepEqual(spec.video_data.call_to_action.value, { app_destination: appDestination });
    assert.ok(!('url_tags' in params), 'an m.me / WhatsApp thread has no query string to decorate');
    // The ad set has to agree about where the click goes.
    const adset = buildAdSetRequest(archetypeRequest(archetype), { campaignId: '1' }).params;
    assert.equal(adset['destination_type'], archetype === 'messenger_lead' ? 'LEAD_FROM_MESSENGER' : 'WHATSAPP');
  }
});

test('creative: a click-to-call ad dials the number brand.ts made mandatory', () => {
  const params = buildCreativeRequest(archetypeRequest('phone_call')).params;
  const spec = json(params, 'object_story_spec') as {
    video_data: { call_to_action: { type: string; value: Record<string, string> } };
  };
  assert.deepEqual(spec.video_data.call_to_action, { type: 'CALL_NOW', value: { link: 'tel:+15551234567' } });
  assert.ok(!('url_tags' in params), 'nothing to append utm parameters to');
});

test('creative: a non-E.164 phone number is refused rather than dialled into nowhere', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({
      brand: { archetype: 'phone_call', destination: { phoneNumber: '(555) 123-4567' } },
      creative: { callToActionType: 'CALL_NOW' },
    })),
    'object_story_spec.video_data.call_to_action.value.link',
    'E.164',
  );
});

test('creative: a hand-written tel: URI in creative.link is refused, number or not', () => {
  assertFails(
    () => buildCreativeRequest(makeRequest({
      brand: { archetype: 'phone_call', destination: { phoneNumber: '+15551234567' } },
      creative: { callToActionType: 'CALL_NOW', link: 'tel:+15551234567' },
    })),
    'call_to_action.value.link',
    'must be http or https',
  );
});

test('creative: the undocumented on-Meta recipe warns UNVERIFIED rather than passing silently', () => {
  for (const archetype of ['messenger_lead', 'whatsapp_conversation', 'phone_call'] as const) {
    const warnings = validatePublishRequest(archetypeRequest(archetype));
    assert.ok(
      warnings.some((w) => w.includes('UNVERIFIED') && w.includes('click-to-message')),
      `${archetype} should flag the missing click-to-message dossier: ${JSON.stringify(warnings)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// bid_amount lives on the ad set, under either budget level
// ---------------------------------------------------------------------------

test('budget: bid_amount is an ad set field under BOTH budget levels, never a campaign one', () => {
  // §3's campaign create field table does not list bid_amount at all; §6.4 documents it on
  // the ad set, and §9 records it as deprecated at the ad level. §12 moves only
  // bid_STRATEGY to the campaign under CBO. A cap emitted on the campaign is either
  // dropped or a code 100 — a bid silently not applied, which costs money quietly.
  const cbo = makeRequest({ options: { bidStrategy: 'COST_CAP', bidAmountMinor: 500 } });
  const cboCampaign = buildCampaignRequest(cbo).params;
  const cboAdSet = buildAdSetRequest(cbo, { campaignId: '1' }).params;
  assert.ok(!('bid_amount' in cboCampaign), 'CBO: bid_amount must not ride along with bid_strategy');
  assert.equal(cboCampaign['bid_strategy'], 'COST_CAP', 'CBO: bid_strategy follows the budget');
  assert.equal(cboAdSet['bid_amount'], '500');
  assert.ok(!('bid_strategy' in cboAdSet), 'CBO: bid_strategy in two places is a code 100');

  const abo = makeRequest({
    options: { budgetLevel: 'adset', adSetBudgetSharing: false, bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmountMinor: 250 },
  });
  const aboCampaign = buildCampaignRequest(abo).params;
  const aboAdSet = buildAdSetRequest(abo, { campaignId: '1' }).params;
  assert.ok(!('bid_amount' in aboCampaign), 'ABO: the campaign carries no bid fields');
  assert.equal(aboAdSet['bid_amount'], '250');
  assert.equal(aboAdSet['bid_strategy'], 'LOWEST_COST_WITH_BID_CAP');

  // An uncapped strategy still emits nothing, on either node.
  const uncapped = makeRequest();
  assert.ok(!('bid_amount' in buildCampaignRequest(uncapped).params));
  assert.ok(!('bid_amount' in buildAdSetRequest(uncapped, { campaignId: '1' }).params));
});
