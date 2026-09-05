import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANGLE_EXHAUSTION_COVERAGE,
  ANGLE_ID_MAX_LENGTH,
  ANGLE_VARIANT_SPACE,
  ASPECT_RATIOS,
  ASSET_TYPES,
  AWARENESS_STAGES,
  CAPTION_STYLES,
  CREATIVE_MECHANICS,
  CREATIVE_TEMPLATES,
  DOMINANT_COLOURS,
  DURATION_BUCKETS,
  EMOTIONAL_REGISTERS,
  ENCODED_FIELD_ORDER,
  FEATURE_COUNT,
  FEATURE_GROUPS,
  FEATURE_NAMES,
  FEATURE_SPACE_FINGERPRINT,
  GENOME_CODE_MAX_LENGTH,
  GENOME_CTAS,
  GENOME_ENCODING_VERSION,
  GenomeError,
  HOOK_TACTICS,
  HOOK_TACTIC_CLUSTER,
  MUSIC_PRESENCES,
  OFFER_TYPES,
  PACINGS,
  PSYCH_TRIGGERS,
  SPOKESPERSON_TYPES,
  TEMPLATE_SPECS,
  adNameForGenome,
  angleVariantCoverage,
  assertValidGenome,
  classifyAngle,
  decodeGenome,
  describeGenome,
  durationBucketForSeconds,
  encodeGenome,
  featureIndex,
  featureVector,
  funnelStageFor,
  genomeFromAdName,
  hitRate,
  looksLikeGenomeCode,
  pacingForCutsPer10s,
  shouldRetireAngle,
  spendUseRatio,
  unexploredVariants,
  validateAngle,
  validateGenome,
  type Angle,
  type AnglePerformance,
  type CreativeGenome,
  type CreativeTemplate,
} from '../src/domain/genome.ts';

// ---------------------------------------------------------------------------
// Deterministic combination generator
// ---------------------------------------------------------------------------

/** noUncheckedIndexedAccess: every array read has to be narrowed, so do it once here. */
function pick<T>(values: readonly T[], i: number): T {
  const v = values[((i % values.length) + values.length) % values.length];
  if (v === undefined) throw new Error(`empty taxonomy at index ${i}`);
  return v;
}

const ANGLE_IDS: readonly string[] = ['a', 'wallet-sucks', 'angle-7', 'x9', 'pain-persona-3', '0'];

/**
 * Builds combination number `n`, deterministically.
 *
 * Each dimension advances by its own prime stride rather than by an odometer, because an
 * odometer over 17 fields only ever varies the last two or three within any run length a
 * test can afford. Every stride is larger than every taxonomy, so each is coprime with
 * its dimension's length and each dimension cycles through all of its values.
 */
function genomeAtIndex(n: number): CreativeGenome {
  // The secondary trigger is offset from the primary so it is never a repeat of it: a
  // repeated trigger is an invalid vector in its own right and would confound the
  // multi-hot invariant this generator feeds.
  const primaryIndex = (n * 53) % PSYCH_TRIGGERS.length;
  const primary = pick(PSYCH_TRIGGERS, primaryIndex);
  const secondarySlot = n % PSYCH_TRIGGERS.length;
  const secondary = secondarySlot === PSYCH_TRIGGERS.length - 1
    ? undefined
    : pick(PSYCH_TRIGGERS, primaryIndex + 1 + secondarySlot);
  return {
    angleId: pick(ANGLE_IDS, n * 43),
    awarenessStage: pick(AWARENESS_STAGES, n * 47),
    mechanic: pick(CREATIVE_MECHANICS, n * 59),
    hookTactic: pick(HOOK_TACTICS, n * 61),
    primaryTrigger: primary,
    ...(secondary !== undefined ? { secondaryTrigger: secondary } : {}),
    template: pick(CREATIVE_TEMPLATES, n * 67),
    assetType: pick(ASSET_TYPES, n * 71),
    spokespersonType: pick(SPOKESPERSON_TYPES, n * 73),
    pacing: pick(PACINGS, n * 79),
    captionStyle: pick(CAPTION_STYLES, n * 83),
    aspectRatio: pick(ASPECT_RATIOS, n * 89),
    durationBucket: pick(DURATION_BUCKETS, n * 97),
    musicPresence: pick(MUSIC_PRESENCES, n * 101),
    dominantColour: pick(DOMINANT_COLOURS, n * 103),
    emotionalRegister: pick(EMOTIONAL_REGISTERS, n * 107),
    offerType: pick(OFFER_TYPES, n * 109),
    cta: pick(GENOME_CTAS, n * 113),
  };
}

const SAMPLE_COUNT = 2000;

/** A vector built entirely from a template's own §5.7 spec — the generator's default path. */
function specDefaultGenome(template: CreativeTemplate): CreativeGenome {
  const spec = TEMPLATE_SPECS[template];
  const bucket = pick(spec.durationBuckets, 0);
  const isStatic = bucket === 'static';
  const spokesperson = spec.spokespersons !== undefined
    ? pick(spec.spokespersons, 0)
    : spec.requiresPerson ? 'customer' : 'none';
  return {
    angleId: 'wallet-sucks',
    awarenessStage: pick(spec.awarenessFit, 0),
    mechanic: pick(spec.mechanics, 0),
    hookTactic: pick(spec.hookTactics, 0),
    primaryTrigger: 'pain_agitation',
    template,
    assetType: spec.defaultAssetType,
    spokespersonType: spokesperson,
    pacing: isStatic ? 'static' : 'moderate',
    captionStyle: isStatic ? 'burned_in_static' : 'burned_in_word_by_word',
    aspectRatio: '9:16',
    durationBucket: bucket,
    musicPresence: isStatic ? 'none' : 'library',
    dominantColour: 'mono_dark',
    emotionalRegister: 'earnest_sincere',
    offerType: spec.requiresOffer ? 'promo' : 'none',
    cta: 'SHOP_NOW',
  };
}

// ---------------------------------------------------------------------------
// Encoding round trip
// ---------------------------------------------------------------------------

test('encode/decode round-trips over many deterministically generated combinations', () => {
  for (let n = 0; n < SAMPLE_COUNT; n++) {
    const g = genomeAtIndex(n);
    const code = encodeGenome(g);
    assert.deepEqual(decodeGenome(code), g, `combination ${n} did not round-trip: ${code}`);
    // Re-encoding the decoded vector must reproduce the identical string, or two runs of
    // the same intent would publish two differently named ads and reconciliation breaks.
    assert.equal(encodeGenome(decodeGenome(code)), code, `combination ${n} is not encode-stable`);
  }
});

test('round trip covers every value of every dimension', () => {
  const seen = new Map<string, Set<string>>();
  const note = (field: string, value: string): void => {
    const set = seen.get(field) ?? new Set<string>();
    set.add(value);
    seen.set(field, set);
  };
  for (let n = 0; n < SAMPLE_COUNT; n++) {
    const g = genomeAtIndex(n);
    note('awarenessStage', g.awarenessStage);
    note('mechanic', g.mechanic);
    note('hookTactic', g.hookTactic);
    note('template', g.template);
    note('assetType', g.assetType);
    note('spokespersonType', g.spokespersonType);
    note('pacing', g.pacing);
    note('captionStyle', g.captionStyle);
    note('aspectRatio', g.aspectRatio);
    note('durationBucket', g.durationBucket);
    note('musicPresence', g.musicPresence);
    note('dominantColour', g.dominantColour);
    note('emotionalRegister', g.emotionalRegister);
    note('offerType', g.offerType);
    note('cta', g.cta);
    note('primaryTrigger', g.primaryTrigger);
  }
  const expected: readonly (readonly [string, number])[] = [
    ['awarenessStage', AWARENESS_STAGES.length],
    ['mechanic', CREATIVE_MECHANICS.length],
    ['hookTactic', HOOK_TACTICS.length],
    ['template', CREATIVE_TEMPLATES.length],
    ['assetType', ASSET_TYPES.length],
    ['spokespersonType', SPOKESPERSON_TYPES.length],
    ['pacing', PACINGS.length],
    ['captionStyle', CAPTION_STYLES.length],
    ['aspectRatio', ASPECT_RATIOS.length],
    ['durationBucket', DURATION_BUCKETS.length],
    ['musicPresence', MUSIC_PRESENCES.length],
    ['dominantColour', DOMINANT_COLOURS.length],
    ['emotionalRegister', EMOTIONAL_REGISTERS.length],
    ['offerType', OFFER_TYPES.length],
    ['cta', GENOME_CTAS.length],
    ['primaryTrigger', PSYCH_TRIGGERS.length],
  ];
  for (const [field, count] of expected) {
    assert.equal(seen.get(field)?.size, count, `${field} was not exercised at every level`);
  }
});

test('within every dimension, each value encodes to a distinct code', () => {
  // Two values sharing a code would make two different creatives indistinguishable in
  // Ads Manager and would merge their rows in the regression. Checked end-to-end through
  // the encoder rather than by inspecting the codebook.
  const base = genomeAtIndex(11);
  const dimensions: readonly (readonly [string, readonly string[], (v: string) => CreativeGenome])[] = [
    ['awarenessStage', AWARENESS_STAGES, (v) => ({ ...base, awarenessStage: v as CreativeGenome['awarenessStage'] })],
    ['mechanic', CREATIVE_MECHANICS, (v) => ({ ...base, mechanic: v as CreativeGenome['mechanic'] })],
    ['hookTactic', HOOK_TACTICS, (v) => ({ ...base, hookTactic: v as CreativeGenome['hookTactic'] })],
    ['primaryTrigger', PSYCH_TRIGGERS, (v) => ({ ...base, primaryTrigger: v as CreativeGenome['primaryTrigger'] })],
    ['template', CREATIVE_TEMPLATES, (v) => ({ ...base, template: v as CreativeGenome['template'] })],
    ['assetType', ASSET_TYPES, (v) => ({ ...base, assetType: v as CreativeGenome['assetType'] })],
    ['spokespersonType', SPOKESPERSON_TYPES, (v) => ({ ...base, spokespersonType: v as CreativeGenome['spokespersonType'] })],
    ['pacing', PACINGS, (v) => ({ ...base, pacing: v as CreativeGenome['pacing'] })],
    ['captionStyle', CAPTION_STYLES, (v) => ({ ...base, captionStyle: v as CreativeGenome['captionStyle'] })],
    ['aspectRatio', ASPECT_RATIOS, (v) => ({ ...base, aspectRatio: v as CreativeGenome['aspectRatio'] })],
    ['durationBucket', DURATION_BUCKETS, (v) => ({ ...base, durationBucket: v as CreativeGenome['durationBucket'] })],
    ['musicPresence', MUSIC_PRESENCES, (v) => ({ ...base, musicPresence: v as CreativeGenome['musicPresence'] })],
    ['dominantColour', DOMINANT_COLOURS, (v) => ({ ...base, dominantColour: v as CreativeGenome['dominantColour'] })],
    ['emotionalRegister', EMOTIONAL_REGISTERS, (v) => ({ ...base, emotionalRegister: v as CreativeGenome['emotionalRegister'] })],
    ['offerType', OFFER_TYPES, (v) => ({ ...base, offerType: v as CreativeGenome['offerType'] })],
    ['cta', GENOME_CTAS, (v) => ({ ...base, cta: v as CreativeGenome['cta'] })],
  ];
  for (const [field, values, build] of dimensions) {
    const codes = new Set<string>();
    for (const v of values) {
      const g = build(v);
      const code = encodeGenome(g);
      assert.ok(!codes.has(code), `${field}: "${v}" collides with another value's code`);
      codes.add(code);
      assert.deepEqual(decodeGenome(code), g, `${field}: "${v}" did not round-trip`);
    }
    assert.equal(codes.size, values.length);
  }
});

test('a one-trigger hook round-trips as one trigger, not as a repeated one', () => {
  const g = genomeAtIndex(7);
  const single: CreativeGenome = { ...g };
  delete (single as { secondaryTrigger?: unknown }).secondaryTrigger;
  const decoded = decodeGenome(encodeGenome(single));
  assert.equal('secondaryTrigger' in decoded, false);
  assert.deepEqual(decoded, single);
});

test('no encoded genome exceeds the advertised ceiling', () => {
  let longest = 0;
  for (let n = 0; n < SAMPLE_COUNT; n++) {
    const len = encodeGenome({ ...genomeAtIndex(n), angleId: 'a'.repeat(ANGLE_ID_MAX_LENGTH) }).length;
    longest = Math.max(longest, len);
    assert.ok(len <= GENOME_CODE_MAX_LENGTH, `encoded genome ${n} is ${len} chars, ceiling ${GENOME_CODE_MAX_LENGTH}`);
  }
  // The ceiling must be tight enough to be worth budgeting against.
  assert.ok(longest >= GENOME_CODE_MAX_LENGTH - 4, `ceiling ${GENOME_CODE_MAX_LENGTH} is loose; longest observed ${longest}`);
});

test('the encoded form is a lowercase slug, so it can be a publish variant', () => {
  for (let n = 0; n < 200; n++) {
    const code = encodeGenome(genomeAtIndex(n));
    assert.match(code, /^[a-z0-9][a-z0-9-]*$/, `"${code}" is not slug-safe`);
  }
});

test('the positional contract is 17 fields plus version plus angle id', () => {
  assert.equal(ENCODED_FIELD_ORDER.length, 17);
  const code = encodeGenome({ ...genomeAtIndex(3), angleId: 'x9' });
  assert.equal(code.split('-').length, ENCODED_FIELD_ORDER.length + 2);
  assert.ok(looksLikeGenomeCode(code));
  assert.ok(code.startsWith(`${GENOME_ENCODING_VERSION}-`));
});

// ---------------------------------------------------------------------------
// Decoding refuses rather than guesses
// ---------------------------------------------------------------------------

test('decode rejects another encoding version instead of guessing at it', () => {
  const code = encodeGenome(genomeAtIndex(1)).replace(/^g1/, 'g2');
  assert.throws(() => decodeGenome(code), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.match(err.message, /not a g1 genome/);
    return true;
  });
});

test('decode names the offending field and code', () => {
  const parts = encodeGenome(genomeAtIndex(2)).split('-');
  parts[3] = 'zzz'; // hook tactic slot
  assert.throws(() => decodeGenome(parts.join('-')), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.equal(err.field, 'hookTactic');
    assert.match(err.message, /"zzz" at position 3/);
    return true;
  });
});

test('decode rejects a truncated genome', () => {
  assert.throws(() => decodeGenome('g1-pb-cwc'), /needs at least 19/);
});

test('decode rejects an angle id that could not have been encoded', () => {
  const parts = encodeGenome(genomeAtIndex(4)).split('-');
  const truncated = parts.slice(0, 18).join('-');
  assert.throws(() => decodeGenome(`${truncated}-NOTASLUG`), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.equal(err.field, 'angleId');
    return true;
  });
});

test('encode refuses an over-long angle id, naming the ceiling', () => {
  const g: CreativeGenome = { ...genomeAtIndex(5), angleId: 'a'.repeat(ANGLE_ID_MAX_LENGTH + 1) };
  assert.throws(() => encodeGenome(g), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.equal(err.field, 'angleId');
    assert.match(err.message, new RegExp(String(ANGLE_ID_MAX_LENGTH)));
    return true;
  });
});

// ---------------------------------------------------------------------------
// Ad-name round trip — the only per-object metadata Insights gives back
// ---------------------------------------------------------------------------

test('genome survives a round trip through a Meta ad name', () => {
  for (let n = 0; n < 300; n++) {
    const g = specDefaultGenome(pick(CREATIVE_TEMPLATES, n));
    const withAngle: CreativeGenome = { ...g, angleId: pick(ANGLE_IDS, n * 43) };
    const name = adNameForGenome({ brandId: 'acme-wallets', archetype: 'website_purchase', genome: withAngle });
    assert.ok(name.length <= 255 - 40, `ad name is ${name.length} chars, over the budget`);
    assert.deepEqual(genomeFromAdName(name), withAngle);
  }
});

test('the genome survives the idempotency stamp that publishing appends', () => {
  // This is the real read-back path: Insights returns the stamped name, not the clean one.
  const g = specDefaultGenome('comparison');
  const name = adNameForGenome({ brandId: 'acme-wallets', archetype: 'website_purchase', genome: g });
  const stamped = `${name} [idem:${'0123456789abcdef'.repeat(2)}]`;
  assert.deepEqual(genomeFromAdName(stamped), g);
  assert.ok(stamped.length <= 255, `stamped ad name is ${stamped.length} chars`);
});

test('a name that is not ours yields undefined rather than an error', () => {
  assert.equal(genomeFromAdName('Some human-made ad'), undefined);
  assert.equal(genomeFromAdName('AUTO/acme/website_purchase/ad/handmade-variant'), undefined);
  // Right prefix, wrong level: the genome lives on the ad, not on the creative.
  assert.equal(genomeFromAdName('AUTO/acme/website_purchase/crt/g1-pb'), undefined);
});

test('a corrupt genome in one of our names throws instead of silently dropping the row', () => {
  assert.throws(
    () => genomeFromAdName('AUTO/acme/website_purchase/ad/g1-pb-cwc-nope-pa-xx-tht-ugc-cus-fst-bww-9x16-d3060-lib-mdk-f2r-pro-shn-a'),
    GenomeError,
  );
});

test('adNameForGenome refuses an incoherent vector before it can spend money', () => {
  const g: CreativeGenome = { ...specDefaultGenome('offer_led'), offerType: 'none', hookTactic: 'offer_only' };
  assert.throws(() => adNameForGenome({ brandId: 'acme', archetype: 'website_purchase', genome: g }), GenomeError);
});

test('an ad name that cannot fit says the angle id is the shortenable part', () => {
  const g: CreativeGenome = { ...specDefaultGenome('unboxing'), angleId: 'a'.repeat(ANGLE_ID_MAX_LENGTH) };
  assert.throws(
    () => adNameForGenome({ brandId: 'a'.repeat(150), archetype: 'website_purchase', genome: g }),
    (err: unknown) => {
      assert.ok(err instanceof GenomeError);
      assert.equal(err.field, 'adName');
      assert.match(err.message, /shorten the angle id/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('every template’s own spec produces a coherent vector', () => {
  for (const template of CREATIVE_TEMPLATES) {
    const result = validateGenome(specDefaultGenome(template));
    assert.deepEqual(result.errors, [], `${template} default is incoherent: ${JSON.stringify(result.errors)}`);
    const unexpected = result.warnings.filter((w) => w.code !== 'human_review_required');
    assert.deepEqual(unexpected, [], `${template} default warned unexpectedly: ${JSON.stringify(unexpected)}`);
  }
});

test('before/after is the one template that always asks for human review', () => {
  const warnings = validateGenome(specDefaultGenome('before_after')).warnings.map((w) => w.code);
  assert.ok(warnings.includes('human_review_required'));
});

test('a spokesperson on a product-only asset is an error, not a warning', () => {
  const g: CreativeGenome = { ...specDefaultGenome('offer_led'), spokespersonType: 'customer' };
  const { errors } = validateGenome(g);
  const codes = errors.map((e) => e.code);
  assert.ok(codes.includes('spokesperson_on_personless_asset'), JSON.stringify(errors));
  assert.throws(() => assertValidGenome(g), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.equal(err.field, 'spokespersonType');
    assert.match(err.message, /product_image_with_text/);
    return true;
  });
});

test('a template defined by who is on camera refuses spokespersonType none', () => {
  const g: CreativeGenome = { ...specDefaultGenome('founder_story'), spokespersonType: 'none' };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('template_requires_person'));
});

test('a founder story cannot be delivered by a customer', () => {
  const g: CreativeGenome = { ...specDefaultGenome('founder_story'), spokespersonType: 'customer' };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('spokesperson_wrong_for_template'));
});

test('a synthetic presenter is hard-blocked on templates that present lived experience', () => {
  for (const template of ['talking_head_testimonial', 'before_after', 'social_proof_stack', 'founder_story'] as const) {
    const g: CreativeGenome = { ...specDefaultGenome(template), spokespersonType: 'synthetic', assetType: 'ugc' };
    const errors = validateGenome(g).errors;
    assert.ok(
      errors.some((e) => e.code === 'synthetic_presenter_forbidden'),
      `${template} allowed a synthetic presenter: ${JSON.stringify(errors)}`,
    );
    assert.ok(errors.some((e) => /FTC/.test(e.message)), 'the message must name the actual cause');
  }
});

test('a synthetic presenter that is allowed still carries a disclosure warning', () => {
  const g: CreativeGenome = { ...specDefaultGenome('day_in_the_life'), spokespersonType: 'synthetic' };
  assert.deepEqual(validateGenome(g).errors, []);
  assert.ok(validateGenome(g).warnings.some((w) => w.code === 'synthetic_presenter_disclosure'));
});

test('a still frame cannot have cuts, music, or motion captions', () => {
  const g: CreativeGenome = {
    ...specDefaultGenome('offer_led'),
    durationBucket: 'static',
    pacing: 'fast',
    musicPresence: 'trending',
    captionStyle: 'burned_in_karaoke',
  };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('static_with_pacing'));
  assert.ok(codes.includes('static_with_music'));
  assert.ok(codes.includes('static_with_motion_captions'));
});

test('an offer-led template without an offer is refused', () => {
  const g: CreativeGenome = { ...specDefaultGenome('offer_led'), offerType: 'none' };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('template_requires_offer'));
});

test('an offer-bearing hook tactic without an offer is refused', () => {
  const g: CreativeGenome = { ...specDefaultGenome('unboxing'), hookTactic: 'sale_announcement', offerType: 'none' };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('offer_tactic_without_offer'));
});

test('a repeated psychological trigger is refused', () => {
  const g: CreativeGenome = {
    ...specDefaultGenome('unboxing'),
    primaryTrigger: 'curiosity_gap',
    secondaryTrigger: 'curiosity_gap',
  };
  const codes = validateGenome(g).errors.map((e) => e.code);
  assert.ok(codes.includes('duplicate_trigger'));
});

test('an off-book awareness stage warns but never blocks — §5.3’s escape hatch', () => {
  const g: CreativeGenome = { ...specDefaultGenome('unboxing'), awarenessStage: 'unaware' };
  const { errors, warnings } = validateGenome(g);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.code === 'stage_off_template'));
  assert.doesNotThrow(() => assertValidGenome(g));
});

test('carousel is flagged but not forbidden', () => {
  const g: CreativeGenome = { ...specDefaultGenome('listicle'), assetType: 'carousel' };
  assert.deepEqual(validateGenome(g).errors, []);
  assert.ok(validateGenome(g).warnings.some((w) => w.code === 'carousel_underperforms'));
});

test('validation never throws on any generated combination', () => {
  for (let n = 0; n < SAMPLE_COUNT; n++) {
    const g = genomeAtIndex(n);
    const result = validateGenome(g);
    assert.ok(Array.isArray(result.errors) && Array.isArray(result.warnings));
    for (const i of [...result.errors, ...result.warnings]) {
      assert.ok(i.code.length > 0 && i.field.length > 0 && i.message.length > 0);
    }
  }
});

// ---------------------------------------------------------------------------
// Feature projection
// ---------------------------------------------------------------------------

test('the feature space layout is pinned', () => {
  // A change to any taxonomy shifts stored bandit coefficients onto the wrong columns.
  // If this fails, that is the point: bump the fingerprint deliberately and migrate.
  assert.equal(FEATURE_COUNT, 172);
  assert.equal(FEATURE_SPACE_FINGERPRINT, '4beda6ae6557c22a');
  assert.equal(FEATURE_NAMES.length, FEATURE_COUNT);
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_COUNT, 'feature names must be unique');
});

test('feature groups tile the vector exactly once, in order', () => {
  let cursor = 0;
  for (const group of FEATURE_GROUPS) {
    assert.equal(group.start, cursor, `group ${group.field} does not abut the previous one`);
    assert.ok(group.length > 0);
    cursor += group.length;
  }
  assert.equal(cursor, FEATURE_COUNT);
});

test('every one-hot block has exactly one set bit and the trigger block up to two', () => {
  for (let n = 0; n < SAMPLE_COUNT; n++) {
    const g = genomeAtIndex(n);
    const fv = featureVector(g);
    assert.equal(fv.values.length, FEATURE_COUNT);
    assert.equal(fv.fingerprint, FEATURE_SPACE_FINGERPRINT);
    let total = 0;
    for (const group of FEATURE_GROUPS) {
      const block = fv.values.slice(group.start, group.start + group.length);
      const sum = block.reduce((a, b) => a + b, 0);
      const expected = group.field === 'psychTrigger' ? (g.secondaryTrigger === undefined ? 1 : 2) : 1;
      assert.equal(sum, expected, `combination ${n}: block ${group.field} summed to ${sum}, expected ${expected}`);
      total += sum;
    }
    assert.equal(fv.values.reduce((a, b) => a + b, 0), total);
    for (const v of fv.values) assert.ok(v === 0 || v === 1);
  }
});

test('the set bits are the ones named after the genome’s own values', () => {
  const g = specDefaultGenome('talking_head_testimonial');
  const fv = featureVector(g);
  const on = FEATURE_NAMES.filter((_, i) => fv.values[i] === 1);
  assert.ok(on.includes(`template=${g.template}`));
  assert.ok(on.includes(`hookTactic=${g.hookTactic}`));
  assert.ok(on.includes(`cta=${g.cta}`));
  assert.ok(on.includes(`psychTrigger=${g.primaryTrigger}`));
  assert.ok(!on.includes('template=unboxing'));
  const idx = featureIndex(`template=${g.template}`);
  assert.ok(idx !== undefined && fv.values[idx] === 1);
  assert.equal(featureIndex('template=does_not_exist'), undefined);
});

test('angle is deliberately not a feature column', () => {
  // §4.6 wants angle as a pooling group, not as a category-of-one column.
  assert.ok(!FEATURE_NAMES.some((n) => n.startsWith('angleId=')));
  const a = featureVector({ ...specDefaultGenome('unboxing'), angleId: 'a' });
  const b = featureVector({ ...specDefaultGenome('unboxing'), angleId: 'wallet-sucks' });
  assert.deepEqual(a.values, b.values);
});

test('derived columns are excluded so the design matrix is not singular', () => {
  assert.ok(!FEATURE_NAMES.some((n) => n.startsWith('funnelStage=')));
  assert.ok(!FEATURE_NAMES.some((n) => n.startsWith('hookTacticCluster=')));
});

// ---------------------------------------------------------------------------
// Angle as a first-class entity
// ---------------------------------------------------------------------------

function angle(overrides: Partial<Angle> = {}): Angle {
  return {
    id: 'wallet-sucks',
    brandId: 'acme-wallets',
    statement: 'Your wallet sucks',
    anchorType: 'pain',
    painOrDesireId: 'bulky_wallet',
    personaId: 'minimalist_professional',
    hypothesis: 'Minimalist professionals will react to bulk as an insult, not a feature. Falsified if hook rate stays under the account median across three templates.',
    status: 'proposed',
    createdAtIso: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

test('a published example angle validates clean', () => {
  const result = validateAngle(angle(), { brandTerms: ['Acme', 'RidgeWallet'] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('an angle longer than ten words is marketing copy, not an angle', () => {
  const bad = angle({ statement: 'Professional grade natural healing without any of the prescription side effects at all' });
  const codes = validateAngle(bad).errors.map((e) => e.code);
  assert.ok(codes.includes('angle_statement_too_long'));
});

test('an angle that names the brand is rejected', () => {
  const bad = angle({ statement: 'Acme fixes your bulky wallet' });
  const errors = validateAngle(bad, { brandTerms: ['Acme'] }).errors;
  assert.ok(errors.some((e) => e.code === 'angle_names_brand'));
  // Same statement is fine when that term is not the brand.
  assert.deepEqual(validateAngle(bad, { brandTerms: ['Ridge'] }).errors, []);
});

test('a brand term matches as a word, not as any substring', () => {
  // A substring test refuses a perfectly good published angle for a brand called "Ash",
  // and a false refusal here quietly shrinks the angle supply.
  const ok = angle({ statement: 'You shouldn’t need a power washer' });
  assert.deepEqual(validateAngle(ok, { brandTerms: ['Ash', 'Owe'] }).errors, []);
  // Real occurrences still fail, including possessives and hyphenated compounds.
  for (const statement of ['Ridge wallets are heavy', 'Your Ridge-style wallet sucks', 'Ridge’s wallet sucks']) {
    const errors = validateAngle(angle({ statement }), { brandTerms: ['Ridge'] }).errors;
    assert.ok(errors.some((e) => e.code === 'angle_names_brand'), statement);
  }
  // Case-insensitively, and a regex metacharacter in the term is literal, not a pattern.
  assert.ok(validateAngle(angle({ statement: 'acme fixes it' }), { brandTerms: ['ACME'] }).errors.length > 0);
  assert.deepEqual(validateAngle(angle({ statement: 'Your wallet sucks' }), { brandTerms: ['.*'] }).errors, []);
});

test('an angle without a hypothesis cannot be falsified, so it is rejected', () => {
  const codes = validateAngle(angle({ hypothesis: '   ' })).errors.map((e) => e.code);
  assert.ok(codes.includes('angle_no_hypothesis'));
});

test('an over-long or non-slug angle id is rejected at the entity, not just at encode time', () => {
  assert.ok(validateAngle(angle({ id: 'Wallet Sucks' })).errors.some((e) => e.code === 'angle_id_shape'));
  assert.ok(validateAngle(angle({ id: 'a'.repeat(ANGLE_ID_MAX_LENGTH + 1) })).errors.some((e) => e.code === 'angle_id_length'));
});

test('a slogan-shaped angle warns without blocking', () => {
  const result = validateAngle(angle({ statement: 'Murder your thirst!' }));
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((w) => w.code === 'angle_reads_as_slogan'));
});

// ---------------------------------------------------------------------------
// Angle performance record
// ---------------------------------------------------------------------------

function performance(overrides: Partial<AnglePerformance> = {}): AnglePerformance {
  return {
    angleId: 'wallet-sucks',
    creativesWithSpend: 20,
    winners: 2,
    midRange: 9,
    losers: 9,
    spendUsd: 4000,
    accountCreativesWithSpend: 200,
    accountSpendUsd: 20000,
    windowStartIso: '2026-08-01',
    windowEndIso: '2026-08-29',
    ...overrides,
  };
}

test('hit rate and spend use ratio are computed as the two separate questions they are', () => {
  const p = performance();
  assert.equal(hitRate(p), 0.1);
  // spend share 0.2 over volume share 0.1
  assert.equal(spendUseRatio(p), 2);
});

test('a missing denominator is a refusal, not a zero', () => {
  assert.throws(() => hitRate(performance({ creativesWithSpend: 0 })), (err: unknown) => {
    assert.ok(err instanceof GenomeError);
    assert.match(err.message, /not zero, it is unknown/);
    return true;
  });
  assert.throws(() => spendUseRatio(performance({ accountSpendUsd: 0 })), GenomeError);
  assert.throws(() => spendUseRatio(performance({ accountCreativesWithSpend: 0 })), GenomeError);
  assert.throws(() => spendUseRatio(performance({ creativesWithSpend: 0 })), GenomeError);
});

test('the 2x2 keeps the high-variance bet distinct from the loser', () => {
  assert.equal(classifyAngle(performance()), 'safest_bet');
  // Low hit rate, high SUR: the bet a greedy bandit would starve.
  assert.equal(classifyAngle(performance({ winners: 0 })), 'high_variance_bet');
  // High hit rate, unremarkable spend share: the volume backbone.
  assert.equal(classifyAngle(performance({ spendUsd: 1000 })), 'workhorse');
  assert.equal(classifyAngle(performance({ winners: 0, spendUsd: 1000 })), 'stop_generating');
  // Below the floor the record still has to be internally coherent, so the counts move
  // with the denominator rather than being left over from the 20-creative fixture.
  assert.equal(
    classifyAngle(performance({ creativesWithSpend: 4, winners: 1, midRange: 2, losers: 1 })),
    'insufficient_data',
  );
});

test('a performance record that cannot be true is refused before it becomes a budget decision', () => {
  // Each of these produces a plausible number and a wrong class if it is not caught.
  const cases: readonly (readonly [string, Partial<AnglePerformance>])[] = [
    // More winners than creatives: hit rate 1.5, promoted to safest_bet.
    ['winners above the denominator', { winners: 30, midRange: 0, losers: 0 }],
    // The angle cannot have spent more than the whole account did.
    ['angle spend above account spend', { spendUsd: 999_999 }],
    // Nor can it own more creatives than the account ran.
    ['angle creatives above account creatives', { accountCreativesWithSpend: 5 }],
    ['a fractional creative count', { winners: 2.5 }],
    ['a negative count', { losers: -1 }],
  ];
  for (const [label, overrides] of cases) {
    const p = performance(overrides);
    assert.throws(() => classifyAngle(p), GenomeError, label);
    // and not only through classifyAngle — the raw axes refuse it too.
    assert.throws(() => (overrides.spendUsd === undefined && overrides.accountCreativesWithSpend === undefined
      ? hitRate(p)
      : spendUseRatio(p)), GenomeError, label);
  }
});

test('a window still in flight under-sums without being refused', () => {
  // §1.1 only classifies a creative as loser (<28 days) or mid-range (>=28 days, never a
  // winner); one that is five days old is none of the three yet, so an under-sum is legal.
  const p = performance({ creativesWithSpend: 20, winners: 1, midRange: 2, losers: 3 });
  assert.doesNotThrow(() => classifyAngle(p));
  assert.equal(hitRate(p), 0.05);
});

// ---------------------------------------------------------------------------
// Variant-space exhaustion — the retirement rule
// ---------------------------------------------------------------------------

test('the variant space is the templates’ own endorsed combinations', () => {
  let expected = 0;
  for (const template of CREATIVE_TEMPLATES) {
    const spec = TEMPLATE_SPECS[template];
    expected += spec.mechanics.length * spec.hookTactics.length;
  }
  assert.equal(ANGLE_VARIANT_SPACE.length, expected);
  assert.equal(ANGLE_VARIANT_SPACE.length, 52);
});

test('coverage counts only cells actually in the space, and only for this angle', () => {
  const base = specDefaultGenome('unboxing');
  assert.equal(angleVariantCoverage('wallet-sucks', []), 0);

  const inSpace: CreativeGenome = { ...base, angleId: 'wallet-sucks' };
  const otherAngle: CreativeGenome = { ...base, angleId: 'grout-stains' };
  const offSpace: CreativeGenome = { ...base, angleId: 'wallet-sucks', hookTactic: 'wordplay' };

  const covered = angleVariantCoverage('wallet-sucks', [inSpace, otherAngle, offSpace, inSpace]);
  assert.equal(covered, 1 / ANGLE_VARIANT_SPACE.length);
  assert.equal(angleVariantCoverage('grout-stains', [inSpace, otherAngle]), 1 / ANGLE_VARIANT_SPACE.length);
});

test('unexplored variants are what the planner should test next', () => {
  const g = specDefaultGenome('unboxing');
  const remaining = unexploredVariants('wallet-sucks', [{ ...g, angleId: 'wallet-sucks' }]);
  assert.equal(remaining.length, ANGLE_VARIANT_SPACE.length - 1);
  assert.ok(!remaining.some((c) => c.template === g.template && c.mechanic === g.mechanic && c.hookTactic === g.hookTactic));
});

test('an angle retires on decline AND exhaustion, never on either alone', () => {
  assert.equal(shouldRetireAngle({ performanceDeclining: true, coverage: ANGLE_EXHAUSTION_COVERAGE }), true);
  assert.equal(shouldRetireAngle({ performanceDeclining: true, coverage: 0.4 }), false);
  assert.equal(shouldRetireAngle({ performanceDeclining: false, coverage: 1 }), false);
});

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

test('funnel stage is derived from awareness stage for all five stages', () => {
  assert.equal(funnelStageFor('unaware'), 'TOF');
  assert.equal(funnelStageFor('problem_aware'), 'MOF');
  assert.equal(funnelStageFor('solution_aware'), 'MOF');
  assert.equal(funnelStageFor('product_aware'), 'BOF');
  assert.equal(funnelStageFor('most_aware'), 'BOF');
});

test('duration buckets follow the per-format table, with the lower bucket winning at an edge', () => {
  assert.equal(durationBucketForSeconds(0), 'static');
  assert.equal(durationBucketForSeconds(5), 's3_8');
  assert.equal(durationBucketForSeconds(8), 's3_8');
  assert.equal(durationBucketForSeconds(12), 's6_15');
  assert.equal(durationBucketForSeconds(30), 's15_30');
  assert.equal(durationBucketForSeconds(45), 's30_60');
  assert.equal(durationBucketForSeconds(180), 's60_plus');
  assert.throws(() => durationBucketForSeconds(-1), GenomeError);
  assert.throws(() => durationBucketForSeconds(Number.NaN), GenomeError);
});

test('pacing buckets follow the documented cuts-per-10s bands', () => {
  assert.equal(pacingForCutsPer10s(0), 'static');
  assert.equal(pacingForCutsPer10s(2), 'slow');
  assert.equal(pacingForCutsPer10s(5), 'moderate');
  assert.equal(pacingForCutsPer10s(6), 'fast');
  assert.equal(pacingForCutsPer10s(12), 'rapid');
  assert.throws(() => pacingForCutsPer10s(-1), GenomeError);
});

test('every hook tactic is clustered, and both clusters are non-empty', () => {
  const counts = { promotional: 0, interrupt: 0, unclustered: 0 };
  for (const t of HOOK_TACTICS) {
    const cluster = HOOK_TACTIC_CLUSTER[t];
    assert.ok(cluster !== undefined, `${t} is unclustered`);
    counts[cluster]++;
  }
  assert.ok(counts.promotional > 0 && counts.interrupt > 0);
  assert.equal(counts.promotional + counts.interrupt + counts.unclustered, HOOK_TACTICS.length);
  // §6.2's season-stable interrupt members must be in the interrupt cluster, since the
  // fixed exploration floor is defined against exactly that set.
  for (const t of ['confession', 'contrarian', 'shocking_statement', 'warning'] as const) {
    assert.equal(HOOK_TACTIC_CLUSTER[t], 'interrupt');
  }
});

test('the two clusters hold exactly §6.2’s published members and nothing else', () => {
  // Cluster membership is what the exploration floor and any seasonality rule are defined
  // against, so an extra member moves launch budget. Pinned verbatim from the §6.2 table.
  const promotional = HOOK_TACTICS.filter((t) => HOOK_TACTIC_CLUSTER[t] === 'promotional');
  const interrupt = HOOK_TACTICS.filter((t) => HOOK_TACTIC_CLUSTER[t] === 'interrupt');
  assert.deepEqual([...promotional].sort(), [
    'event_announcement', 'fomo', 'giveaway', 'new_product_announcement', 'newness',
    'offer_only', 'price_anchor', 'sale_announcement', 'urgency',
  ]);
  assert.deepEqual([...interrupt].sort(), [
    'bold_claim', 'confession', 'contrarian', 'myth_busting', 'reverse_psychology',
    'shocking_statement', 'warning',
  ]);
  // The report clusters neither of these; inventing a home for them is the failure.
  for (const t of ['announcement', 'product_announcement', 'exclusivity'] as const) {
    assert.equal(HOOK_TACTIC_CLUSTER[t], 'unclustered');
  }
});

test('every §5.7 template renders as a slug that exists in the §5.2 taxonomy', () => {
  // The field exists to join against published benchmark rows; a composite or invented
  // slug joins to nothing and does so silently.
  for (const template of CREATIVE_TEMPLATES) {
    const vf = TEMPLATE_SPECS[template].visualFormat;
    assert.match(vf, /^[a-z][a-z0-9_]*$/, `${template} visualFormat "${vf}" is not a single taxonomy slug`);
  }
});

test('template specs are internally consistent', () => {
  for (const template of CREATIVE_TEMPLATES) {
    const spec = TEMPLATE_SPECS[template];
    assert.equal(spec.template, template);
    assert.ok(spec.awarenessFit.length > 0, `${template} has no awareness fit`);
    assert.ok(spec.mechanics.length > 0, `${template} has no mechanic`);
    assert.ok(spec.hookTactics.length > 0, `${template} has no hook tactic`);
    assert.ok(spec.durationBuckets.length > 0, `${template} has no duration`);
    assert.ok(spec.note.length > 0, `${template} has no note`);
    assert.ok(spec.funnel.length > 0, `${template} has no funnel placement`);
    for (const f of spec.funnel) assert.ok(['TOF', 'MOF', 'BOF'].includes(f));
    if (spec.spokespersons !== undefined) {
      assert.ok(spec.requiresPerson, `${template} names spokespersons but does not require a person`);
      assert.ok(!spec.spokespersons.includes('none'), `${template} lists "none" as a spokesperson`);
    }
  }
});

test('the published format funnel and the derived audience funnel are allowed to diverge', () => {
  // Pinned so the divergence stays visible: §5.3 files Before & After under MOF while
  // §5.7 gives it a product_aware fit, which this module derives as BOF. Both are quoted
  // as published; "fixing" one to match the other would overwrite a fact with a guess.
  const spec = TEMPLATE_SPECS.before_after;
  assert.deepEqual([...spec.funnel], ['MOF']);
  assert.ok(spec.awarenessFit.includes('product_aware'));
  assert.equal(funnelStageFor('product_aware'), 'BOF');
});

test('describeGenome names every field for the operator reading a log', () => {
  const text = describeGenome(specDefaultGenome('offer_led'));
  for (const key of ['angle=', 'stage=', 'mechanic=', 'hook=', 'trigger=', 'template=', 'asset=', 'offer=', 'cta=']) {
    assert.ok(text.includes(key), `describeGenome omitted ${key}`);
  }
  assert.ok(text.includes('(BOF)'));
});
