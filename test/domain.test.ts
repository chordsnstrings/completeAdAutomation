import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHETYPES, specFor, validateSpec, isBillingEventLegal, IllegalTupleError,
  unverifiedArchetypes,
} from '../src/meta/objectives.ts';
import {
  resolveAdConfig, validateBrand, ConfigConflictError, type Brand,
} from '../src/domain/brand.ts';

function brand(over: Partial<Brand> = {}): Brand {
  return {
    id: 'test-brand',
    name: 'Test',
    pageId: '1',
    adAccountId: 'act_1',
    archetype: 'instant_form_lead',
    destination: { leadFormId: 'form_1' },
    spend: { dailyBudgetMinor: 2000, maxDailyBudgetMinor: 10000, targetCpaMinor: 4000 },
    claims: { substantiated: ['a real claim'], neverSay: [], neverShow: [], likenessRightsConfirmed: false },
    specialAdCategories: ['NONE'],
    countries: ['IN'],
    proposition: 'x',
    ...over,
  };
}

test('every shipped archetype is internally legal', () => {
  for (const a of Object.keys(ARCHETYPES) as Array<keyof typeof ARCHETYPES>) {
    assert.doesNotThrow(() => specFor(a), `${a} must satisfy the legality tables`);
  }
});

test('IMPRESSIONS is legal for every optimization goal', () => {
  assert.equal(isBillingEventLegal('OFFSITE_CONVERSIONS', 'IMPRESSIONS'), true);
  assert.equal(isBillingEventLegal('LEAD_GENERATION', 'IMPRESSIONS'), true);
  assert.equal(isBillingEventLegal('LINK_CLICKS', 'LINK_CLICKS'), true);
  assert.equal(isBillingEventLegal('THRUPLAY', 'THRUPLAY'), true);
  assert.equal(isBillingEventLegal('OFFSITE_CONVERSIONS', 'LINK_CLICKS'), false);
});

test('an illegal destination_type is caught here, not at Meta', () => {
  assert.throws(
    () => validateSpec({ ...ARCHETYPES.traffic, destinationType: 'WEBSITE' }),
    IllegalTupleError,
    'OUTCOME_TRAFFIC does not list WEBSITE — sending the obvious value is the bug',
  );
});

test('traffic omits destination_type entirely', () => {
  assert.equal(specFor('traffic').destinationType, undefined);
});

test('the unverified tuples are declared, not silently trusted', () => {
  const names = unverifiedArchetypes().map((s) => s.archetype);
  assert.ok(names.includes('website_purchase'), 'OUTCOME_SALES is absent from the mapping table');
  assert.ok(!names.includes('instant_form_lead'), 'instant forms are documented');
});

test('an ad may narrow its brand budget', () => {
  const r = resolveAdConfig(brand(), { dailyBudgetMinor: 500 });
  assert.equal(r.dailyBudgetMinor, 500);
});

test('an ad may never widen its brand budget', () => {
  assert.throws(
    () => resolveAdConfig(brand(), { dailyBudgetMinor: 9000 }),
    ConfigConflictError,
    'spend authority belongs to the brand, not to an autonomously generated ad',
  );
});

test('an ad may switch archetype if it supplies what that archetype needs', () => {
  const b = brand({ destination: { leadFormId: 'f1', url: 'https://x.test', pixelId: 'p1', customEventType: 'PURCHASE' } });
  const r = resolveAdConfig(b, { archetype: 'website_purchase' });
  assert.equal(r.spec.objective, 'OUTCOME_SALES');
});

test('switching archetype without its destination fails with a specific message', () => {
  assert.throws(
    () => resolveAdConfig(brand(), { archetype: 'website_purchase' }),
    /requires pixelId, customEventType, url/,
  );
});

test('brand validation catches the money and legal mistakes', () => {
  assert.deepEqual(validateBrand(brand()), []);

  assert.match(
    validateBrand(brand({ spend: { dailyBudgetMinor: 5000, maxDailyBudgetMinor: 100 } })).join(' '),
    /ceiling is under the floor/,
  );
  assert.match(
    validateBrand(brand({ specialAdCategories: [] })).join(' '),
    /specialAdCategories is required/,
  );
  assert.match(
    validateBrand(brand({ claims: { substantiated: [], neverSay: [], neverShow: [], likenessRightsConfirmed: true } })).join(' '),
    /no approved claim/,
  );
  assert.match(validateBrand(brand({ id: 'Bad Id' })).join(' '), /lowercase slug/);
  assert.match(validateBrand(brand({ adAccountId: '123' })).join(' '), /must start with act_/);
});

test('a restricted special ad category demands a country', () => {
  assert.match(
    validateBrand(brand({ specialAdCategories: ['HOUSING'], countries: [] })).join(' '),
    /requires countries/,
  );
});
