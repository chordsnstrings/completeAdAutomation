/**
 * Capability probe — src/domain/genome.ts
 *
 * Not a unit test. The question here is whether the attribute vector genuinely does its
 * job end to end: does a realistic genome survive the only channel it actually travels
 * on (a Meta ad name, alongside a human-readable prefix and the idempotency stamp), does
 * the feature projection hold still well enough to hang stored bandit coefficients on,
 * and does validation actually refuse the vectors that would poison the training set.
 *
 * Every check drives the real exported code. Nothing here is stubbed: the ad-name checks
 * run through `publish.objectName` and `idempotency.stampIntentKey`, which is the exact
 * pair that competes with the genome for the one 255-char name field.
 *
 * Run standalone:
 *   node --experimental-strip-types src/verify/genome.ts
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  AnglePerformance,
  AwarenessStage,
  CaptionStyle,
  CreativeGenome,
  CreativeTemplate,
  DurationBucket,
  GenomeIssue,
  MusicPresence,
  Pacing,
  SpokespersonType,
  VariantCell,
} from '../domain/genome.ts';

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  /**
   * Set when the check could not run for an environmental reason (no assets assigned,
   * no API key, binary missing) rather than because the code is wrong.
   */
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

const MODULE = 'src/domain/genome.ts';

type GenomeMod = typeof import('../domain/genome.ts');
type PublishMod = typeof import('../meta/publish.ts');
type IdemMod = typeof import('../meta/idempotency.ts');

// ---------------------------------------------------------------------------
// Tiny assertion kit — kept local so the probe has no test-runner dependency.
// ---------------------------------------------------------------------------

class ProbeFailure extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ProbeFailure(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new ProbeFailure(`${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

/** Structural equality that treats an own `key: undefined` as different from an absent key. */
function sameGenome(a: CreativeGenome, b: CreativeGenome): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of ka) if (ra[k] !== rb[k]) return false;
  return true;
}

function pick<T>(xs: readonly T[], n: number): T {
  if (xs.length === 0) throw new ProbeFailure('cannot pick from an empty dimension');
  const v = xs[((n % xs.length) + xs.length) % xs.length];
  if (v === undefined) throw new ProbeFailure('dimension yielded undefined');
  return v;
}

function head<T>(xs: readonly T[], fallback: T): T {
  return xs.length > 0 ? (xs[0] as T) : fallback;
}

function errCodes(r: { errors: GenomeIssue[] }): string[] {
  return r.errors.map((e) => e.code).sort();
}

function warnCodes(r: { warnings: GenomeIssue[] }): string[] {
  return r.warnings.map((w) => w.code).sort();
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];

  const add = (name: string, status: Check['status'], detail: string, blockedBy?: string): void => {
    checks.push(blockedBy === undefined ? { name, status, detail } : { name, status, detail, blockedBy });
  };

  /** Runs one check body; any throw becomes a FAIL carrying the message. */
  const check = (name: string, body: () => string): void => {
    try {
      add(name, 'PASS', body());
    } catch (err) {
      add(name, 'FAIL', message(err));
    }
  };

  // --- load ----------------------------------------------------------------
  // Dynamic, because the codebook self-checks at module load: a duplicate or malformed
  // code throws during evaluation, and a static import would take the probe down with it.
  let G: GenomeMod;
  let P: PublishMod;
  let I: IdemMod;
  try {
    G = await import('../domain/genome.ts');
    P = await import('../meta/publish.ts');
    I = await import('../meta/idempotency.ts');
  } catch (err) {
    add('module_loads', 'FAIL', `import failed — the codebook self-check throws at load: ${message(err)}`);
    return { module: MODULE, checks };
  }
  add(
    'module_loads',
    'PASS',
    `codebook self-check passed at import: ${G.HOOK_TACTICS.length} hook tactics, ` +
      `${G.CREATIVE_TEMPLATES.length} templates, ${G.FEATURE_COUNT} feature columns, ` +
      `encoding ${G.GENOME_ENCODING_VERSION}, fingerprint ${G.FEATURE_SPACE_FINGERPRINT}.`,
  );

  // --- fixtures ------------------------------------------------------------

  const ANGLE_IDS: readonly string[] = [
    'wallet-bulge',
    'a',
    '0',
    'x9',
    'spring-sale-2026',
    'a-b-c-d-e-f-g-h-i-j-k-l',
    'zzzzzzzzzzzzzzzzzzzzzzzz', // exactly ANGLE_ID_MAX_LENGTH
    'trailing-hyphen-',
    'double--hyphen',
    'g1',                       // looks like the encoding version prefix
    '2026',
  ];

  /**
   * Deterministic by index, no Math.random. Co-prime strides so the dimensions advance
   * independently instead of moving in lockstep.
   */
  const genomeAtIndex = (n: number): CreativeGenome => {
    const primary = pick(G.PSYCH_TRIGGERS, n * 13);
    const wantSecondary = n % 3 !== 0;
    let secondary = pick(G.PSYCH_TRIGGERS, n * 17 + 1);
    if (secondary === primary) secondary = pick(G.PSYCH_TRIGGERS, n * 17 + 2);
    const g: CreativeGenome = {
      angleId: pick(ANGLE_IDS, n * 7),
      awarenessStage: pick(G.AWARENESS_STAGES, n * 3),
      mechanic: pick(G.CREATIVE_MECHANICS, n * 5),
      hookTactic: pick(G.HOOK_TACTICS, n * 11),
      primaryTrigger: primary,
      template: pick(G.CREATIVE_TEMPLATES, n * 19),
      assetType: pick(G.ASSET_TYPES, n * 23),
      spokespersonType: pick(G.SPOKESPERSON_TYPES, n * 29),
      pacing: pick(G.PACINGS, n * 31),
      captionStyle: pick(G.CAPTION_STYLES, n * 37),
      aspectRatio: pick(G.ASPECT_RATIOS, n * 41),
      durationBucket: pick(G.DURATION_BUCKETS, n * 43),
      musicPresence: pick(G.MUSIC_PRESENCES, n * 47),
      dominantColour: pick(G.DOMINANT_COLOURS, n * 53),
      emotionalRegister: pick(G.EMOTIONAL_REGISTERS, n * 59),
      offerType: pick(G.OFFER_TYPES, n * 61),
      cta: pick(G.GENOME_CTAS, n * 67),
    };
    return wantSecondary && secondary !== primary ? { ...g, secondaryTrigger: secondary } : g;
  };

  /** Longest code in every dimension, so the encoded form hits its declared ceiling. */
  const worstCaseGenome = (angleId: string): CreativeGenome => ({
    angleId,
    awarenessStage: 'problem_aware',
    mechanic: 'contrast_without_comment',   // cwc — 3
    hookTactic: 'call_to_action_first',     // ctaf — 4
    primaryTrigger: 'pain_agitation',
    secondaryTrigger: 'curiosity_gap',
    template: 'problem_solution_demo',      // psd — 3
    assetType: 'ugc',                       // 3
    spokespersonType: 'none',               // non — 3
    pacing: 'moderate',                     // mod — 3
    captionStyle: 'burned_in_word_by_word', // bww — 3
    aspectRatio: '9:16',                    // 9x16 — 4
    durationBucket: 's15_30',               // d1530 — 5
    musicPresence: 'trending',              // trd — 3
    dominantColour: 'mono_dark',            // mdk — 3
    emotionalRegister: 'frustration_to_relief', // f2r — 3
    offerType: 'promo',                     // pro — 3
    cta: 'SHOP_NOW',                        // shn — 3
  });

  /** A buildable, on-book genome for one endorsed (template, mechanic, tactic) cell. */
  const genomeForCell = (cell: VariantCell, angleId: string): CreativeGenome => {
    const spec = G.TEMPLATE_SPECS[cell.template];
    const duration: DurationBucket = head<DurationBucket>(spec.durationBuckets, 's15_30');
    const isStatic = duration === 'static';
    const spokespersonType: SpokespersonType = spec.requiresPerson
      ? head<SpokespersonType>(spec.spokespersons ?? [], 'customer')
      : 'none';
    const pacing: Pacing = isStatic ? 'static' : 'moderate';
    const captionStyle: CaptionStyle = isStatic ? 'burned_in_static' : 'burned_in_word_by_word';
    const musicPresence: MusicPresence = isStatic ? 'none' : 'library';
    return {
      angleId,
      awarenessStage: head<AwarenessStage>(spec.awarenessFit, 'problem_aware'),
      mechanic: cell.mechanic,
      hookTactic: cell.hookTactic,
      primaryTrigger: 'curiosity_gap',
      secondaryTrigger: 'pain_agitation',
      template: cell.template,
      assetType: spec.defaultAssetType,
      spokespersonType,
      pacing,
      captionStyle,
      aspectRatio: '9:16',
      durationBucket: duration,
      musicPresence,
      dominantColour: 'mono_dark',
      emotionalRegister: 'earnest_sincere',
      offerType: 'promo',
      cta: 'SHOP_NOW',
    };
  };

  /**
   * The real codebook, recovered by encoding one genome per level and reading the segment
   * at that field's position. The codecs are module-private, so this is the only honest
   * way to assert on the codes an ad name will actually carry.
   */
  const sweeps: readonly {
    field: string;
    index: number;
    values: readonly string[];
    apply: (g: CreativeGenome, i: number) => CreativeGenome;
  }[] = [
    { field: 'awarenessStage', index: 1, values: G.AWARENESS_STAGES, apply: (g, i) => ({ ...g, awarenessStage: pick(G.AWARENESS_STAGES, i) }) },
    { field: 'mechanic', index: 2, values: G.CREATIVE_MECHANICS, apply: (g, i) => ({ ...g, mechanic: pick(G.CREATIVE_MECHANICS, i) }) },
    { field: 'hookTactic', index: 3, values: G.HOOK_TACTICS, apply: (g, i) => ({ ...g, hookTactic: pick(G.HOOK_TACTICS, i) }) },
    { field: 'primaryTrigger', index: 4, values: G.PSYCH_TRIGGERS, apply: (g, i) => ({ ...g, primaryTrigger: pick(G.PSYCH_TRIGGERS, i) }) },
    { field: 'template', index: 6, values: G.CREATIVE_TEMPLATES, apply: (g, i) => ({ ...g, template: pick(G.CREATIVE_TEMPLATES, i) }) },
    { field: 'assetType', index: 7, values: G.ASSET_TYPES, apply: (g, i) => ({ ...g, assetType: pick(G.ASSET_TYPES, i) }) },
    { field: 'spokespersonType', index: 8, values: G.SPOKESPERSON_TYPES, apply: (g, i) => ({ ...g, spokespersonType: pick(G.SPOKESPERSON_TYPES, i) }) },
    { field: 'pacing', index: 9, values: G.PACINGS, apply: (g, i) => ({ ...g, pacing: pick(G.PACINGS, i) }) },
    { field: 'captionStyle', index: 10, values: G.CAPTION_STYLES, apply: (g, i) => ({ ...g, captionStyle: pick(G.CAPTION_STYLES, i) }) },
    { field: 'aspectRatio', index: 11, values: G.ASPECT_RATIOS, apply: (g, i) => ({ ...g, aspectRatio: pick(G.ASPECT_RATIOS, i) }) },
    { field: 'durationBucket', index: 12, values: G.DURATION_BUCKETS, apply: (g, i) => ({ ...g, durationBucket: pick(G.DURATION_BUCKETS, i) }) },
    { field: 'musicPresence', index: 13, values: G.MUSIC_PRESENCES, apply: (g, i) => ({ ...g, musicPresence: pick(G.MUSIC_PRESENCES, i) }) },
    { field: 'dominantColour', index: 14, values: G.DOMINANT_COLOURS, apply: (g, i) => ({ ...g, dominantColour: pick(G.DOMINANT_COLOURS, i) }) },
    { field: 'emotionalRegister', index: 15, values: G.EMOTIONAL_REGISTERS, apply: (g, i) => ({ ...g, emotionalRegister: pick(G.EMOTIONAL_REGISTERS, i) }) },
    { field: 'offerType', index: 16, values: G.OFFER_TYPES, apply: (g, i) => ({ ...g, offerType: pick(G.OFFER_TYPES, i) }) },
    { field: 'cta', index: 17, values: G.GENOME_CTAS, apply: (g, i) => ({ ...g, cta: pick(G.GENOME_CTAS, i) }) },
  ];

  const codeAt = (g: CreativeGenome, index: number): string => {
    const seg = G.encodeGenome(g).split('-')[index];
    if (seg === undefined) throw new ProbeFailure(`encoded genome has no segment ${index}`);
    return seg;
  };

  const SAMPLE_COUNT = 20_000;

  // =========================================================================
  // 1. Codebook integrity
  // =========================================================================

  check('codebook_codes_are_unique_and_slug_safe', () => {
    const base = genomeAtIndex(1);
    const lines: string[] = [];
    let total = 0;
    for (const sweep of sweeps) {
      const seen = new Map<string, string>();
      for (let i = 0; i < sweep.values.length; i++) {
        const value = pick(sweep.values, i);
        const code = codeAt(sweep.apply(base, i), sweep.index);
        must(/^[a-z0-9]+$/.test(code), `${sweep.field}: code "${code}" for "${value}" is not [a-z0-9]+ — a hyphen would split the field`);
        const prior = seen.get(code);
        must(prior === undefined, `${sweep.field}: code "${code}" is shared by "${prior}" and "${value}" — decode would be ambiguous`);
        seen.set(code, value);
        total++;
      }
      lines.push(`${sweep.field}:${sweep.values.length}`);
    }
    // The sentinel that stands in for an absent secondary trigger must not be a real code.
    const single: CreativeGenome = { ...base };
    delete (single as { secondaryTrigger?: unknown }).secondaryTrigger;
    const sentinel = codeAt(single, 5);
    for (let i = 0; i < G.PSYCH_TRIGGERS.length; i++) {
      eq(codeAt({ ...base, primaryTrigger: pick(G.PSYCH_TRIGGERS, i) }, 4) === sentinel, false,
        `the no-secondary sentinel "${sentinel}" collides with a real trigger code`);
    }
    return `${total} codes across ${sweeps.length} dimensions are unique within their dimension and slug-safe; no-secondary sentinel "${sentinel}" collides with nothing. ${lines.join(' ')}`;
  });

  check('hook_tactic_taxonomy_split_is_intact', () => {
    eq(G.HOOK_TACTICS.length, 42, 'hook tactic count');
    eq(G.CANONICAL_HOOK_TACTIC_COUNT, 33, 'canonical slice length');
    const canonical = G.HOOK_TACTICS.slice(0, G.CANONICAL_HOOK_TACTIC_COUNT);
    eq(canonical[canonical.length - 1], 'warning', 'last canonical tactic');
    eq(G.HOOK_TACTICS[G.CANONICAL_HOOK_TACTIC_COUNT], 'newness', 'first leaderboard-only tactic');
    let promotional = 0;
    let interrupt = 0;
    for (const t of G.HOOK_TACTICS) {
      const c = G.HOOK_TACTIC_CLUSTER[t];
      must(c === 'promotional' || c === 'interrupt' || c === 'unclustered', `tactic "${t}" has no cluster`);
      if (c === 'promotional') promotional++;
      if (c === 'interrupt') interrupt++;
    }
    must(interrupt > 0, 'interrupt cluster is empty — INTERRUPT_EXPLORATION_FLOOR would reserve budget for nothing');
    must(G.INTERRUPT_EXPLORATION_FLOOR > 0 && G.INTERRUPT_EXPLORATION_FLOOR < 1, 'exploration floor is not a fraction');
    return `42 tactics = 33 canonical + 9 leaderboard-only; clusters promotional=${promotional} interrupt=${interrupt} unclustered=${42 - promotional - interrupt}; floor ${G.INTERRUPT_EXPLORATION_FLOOR}.`;
  });

  // =========================================================================
  // 2. Round trip — the learning contract
  // =========================================================================

  check('roundtrip_every_level_of_every_dimension', () => {
    const base = genomeAtIndex(5);
    let n = 0;
    for (const sweep of sweeps) {
      for (let i = 0; i < sweep.values.length; i++) {
        const g = sweep.apply(base, i);
        const decoded = G.decodeGenome(G.encodeGenome(g));
        must(sameGenome(decoded, g), `${sweep.field}="${pick(sweep.values, i)}" did not round-trip: ${G.encodeGenome(g)}`);
        n++;
      }
    }
    for (let i = 0; i < G.PSYCH_TRIGGERS.length; i++) {
      const primary = pick(G.PSYCH_TRIGGERS, i);
      const secondary = pick(G.PSYCH_TRIGGERS, i + 1);
      const g: CreativeGenome = { ...base, primaryTrigger: primary, secondaryTrigger: secondary };
      must(sameGenome(G.decodeGenome(G.encodeGenome(g)), g), `trigger pair ${primary}+${secondary} did not round-trip`);
      n++;
    }
    return `${n} single-level round trips exact (every level of all 16 coded dimensions, plus every ordered trigger pair).`;
  });

  check('roundtrip_bulk_deterministic_sample', () => {
    let withSecondary = 0;
    const distinctCodes = new Set<string>();
    for (let n = 0; n < SAMPLE_COUNT; n++) {
      const g = genomeAtIndex(n);
      const code = G.encodeGenome(g);
      distinctCodes.add(code);
      const decoded = G.decodeGenome(code);
      must(sameGenome(decoded, g), `sample ${n} did not round-trip: ${code}`);
      must(/^[a-z0-9][a-z0-9-]*$/.test(code), `sample ${n} is not a publish-safe variant slug: ${code}`);
      must(G.looksLikeGenomeCode(code), `sample ${n} is not recognised as a genome code`);
      if (g.secondaryTrigger !== undefined) withSecondary++;
    }
    return `${SAMPLE_COUNT} deterministic samples (${distinctCodes.size} distinct codes, ${withSecondary} with a secondary trigger) round-tripped exactly and are all slug-safe variants.`;
  });

  check('roundtrip_omits_absent_secondary_trigger_rather_than_writing_undefined', () => {
    // exactOptionalPropertyTypes: an own key holding undefined is a different object and
    // would serialise into the training set as a present-but-null attribute.
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const g: CreativeGenome = { ...genomeAtIndex(i) };
      delete (g as { secondaryTrigger?: unknown }).secondaryTrigger;
      const decoded = G.decodeGenome(G.encodeGenome(g));
      eq(Object.hasOwn(decoded, 'secondaryTrigger'), false, `sample ${i}: decoded genome carries an own secondaryTrigger key`);
      must(sameGenome(decoded, g), `sample ${i} single-trigger round trip`);
      n++;
    }
    return `${n} single-trigger genomes decode with no secondaryTrigger key at all (not key=undefined), so the sentinel never becomes a phantom level.`;
  });

  check('roundtrip_edge_case_angle_ids', () => {
    const details: string[] = [];
    for (const angleId of ANGLE_IDS) {
      const g: CreativeGenome = { ...worstCaseGenome(angleId) };
      const decoded = G.decodeGenome(G.encodeGenome(g));
      eq(decoded.angleId, angleId, `angleId "${angleId}" did not survive`);
      must(sameGenome(decoded, g), `angleId "${angleId}" corrupted the rest of the vector`);
      details.push(`"${angleId}"`);
    }
    eq(ANGLE_IDS.includes('zzzzzzzzzzzzzzzzzzzzzzzz'), true, 'max-length angle id fixture missing');
    eq('zzzzzzzzzzzzzzzzzzzzzzzz'.length, G.ANGLE_ID_MAX_LENGTH, 'max-length fixture is not at the ceiling');
    return `${ANGLE_IDS.length} adversarial angle ids round-trip, including embedded hyphens, a trailing hyphen, a doubled hyphen, a bare digit, the literal "g1" version prefix, and one at the ${G.ANGLE_ID_MAX_LENGTH}-char ceiling: ${details.join(' ')}.`;
  });

  check('encoded_length_ceiling_is_exact_not_merely_safe', () => {
    const worst = G.encodeGenome(worstCaseGenome('z'.repeat(G.ANGLE_ID_MAX_LENGTH)));
    eq(worst.length, G.GENOME_CODE_MAX_LENGTH, 'the constructed worst case does not equal the advertised ceiling');
    let longest = 0;
    for (let n = 0; n < SAMPLE_COUNT; n++) {
      const len = G.encodeGenome({ ...genomeAtIndex(n), angleId: 'z'.repeat(G.ANGLE_ID_MAX_LENGTH) }).length;
      longest = Math.max(longest, len);
      must(len <= G.GENOME_CODE_MAX_LENGTH, `sample ${n} is ${len} chars, over the ${G.GENOME_CODE_MAX_LENGTH} ceiling`);
    }
    must(longest >= G.GENOME_CODE_MAX_LENGTH - 1, `the ceiling ${G.GENOME_CODE_MAX_LENGTH} is loose; the longest of ${SAMPLE_COUNT} samples was only ${longest}`);
    return `GENOME_CODE_MAX_LENGTH=${G.GENOME_CODE_MAX_LENGTH} is attained exactly by the longest-code-per-dimension genome ("${worst}"), and never exceeded over ${SAMPLE_COUNT} samples (longest sampled ${longest}) — so it is a budgetable number, not a guess.`;
  });

  // =========================================================================
  // 3. Corruption must not decode silently
  // =========================================================================

  check('decode_refuses_malformed_and_foreign_codes', () => {
    const good = G.encodeGenome(worstCaseGenome('spring-sale-2026'));
    const segs = good.split('-');
    const bad: string[] = [
      '',
      'g1',
      'g1-pb',
      good.replace(/^g1/, 'g2'),
      good.replace(/^g1/, 'G1'),
      segs.slice(0, 18).join('-'),                        // no angle id at all
      `${segs.slice(0, 18).join('-')}-Bad_Angle`,         // angle id that is not a slug
      `${segs.slice(0, 18).join('-')}-${'a'.repeat(G.ANGLE_ID_MAX_LENGTH + 1)}`,
    ];
    for (const s of bad) {
      let threw = false;
      try { G.decodeGenome(s); } catch (err) { threw = err instanceof G.GenomeError; }
      must(threw, `decodeGenome("${s}") did not throw a GenomeError`);
    }
    // A foreign code in each of the 17 positions.
    for (let i = 1; i <= 17; i++) {
      const mutated = [...segs.slice(0, i), 'zzq', ...segs.slice(i + 1)].join('-');
      let threw = false;
      try { G.decodeGenome(mutated); } catch (err) { threw = err instanceof G.GenomeError; }
      must(threw, `an unknown code at position ${i} (${G.ENCODED_FIELD_ORDER[i - 1]}) decoded instead of throwing`);
    }
    return `${bad.length} malformed forms plus an unknown code in each of the 17 positions all raise GenomeError — a mislabelled row never reaches the training set.`;
  });

  check('decode_detects_a_dropped_or_duplicated_field_rather_than_shifting', () => {
    // The angle id is the only variable-length segment, so a name whose middle is damaged
    // can still carry a legal segment COUNT. If a shifted read ever validated, the vector
    // would enter the training set as a confident mislabel. Drive every single-segment
    // deletion and duplication, over several angle ids of different segment counts.
    const angleIds = ['spring-sale-2026', 'a-b-c-d-e-f-g-h-i-j-k-l', 'wallet-bulge', 'x9'];
    let attempts = 0;
    let refused = 0;
    const shifted: string[] = [];
    const absorbedIntoAngleId: string[] = [];
    for (const angleId of angleIds) {
      const g = worstCaseGenome(angleId);
      const good = G.encodeGenome(g);
      const segs = good.split('-');
      for (let i = 1; i <= 17; i++) {
        for (const mutated of [
          [...segs.slice(0, i), ...segs.slice(i + 1)].join('-'),                     // dropped
          [...segs.slice(0, i), segs[i] as string, ...segs.slice(i)].join('-'),      // duplicated
        ]) {
          attempts++;
          let decoded: CreativeGenome;
          try {
            decoded = G.decodeGenome(mutated);
          } catch {
            refused++;
            continue;
          }
          // The 17 coded attributes are positional, so a shift there is a silent
          // mislabel. The angle id is by contract "everything after position 17", so a
          // damaged tail reading back as a different id is faithful, not a shift — but
          // it is worth counting, because it introduces a phantom angle.
          if (!sameGenome({ ...decoded, angleId }, g)) {
            shifted.push(`${G.ENCODED_FIELD_ORDER[i - 1]} -> ${G.describeGenome(decoded)}`);
          } else if (decoded.angleId !== angleId) {
            absorbedIntoAngleId.push(`"${angleId}" -> "${decoded.angleId}"`);
          }
        }
      }
    }
    must(shifted.length === 0,
      `${shifted.length}/${attempts} damaged codes decoded with the positional fields SHIFTED, producing a confident mislabel: ${shifted.slice(0, 2).join(' | ')}`);
    return `${attempts} single-segment deletions and duplications across ${angleIds.length} angle-id shapes: ${refused} refused outright, none shifted the 17 positional attributes. ` +
      `${absorbedIntoAngleId.length} cases (all duplications of the final CTA code) are absorbed into the trailing variable-length angle id instead — ` +
      `the coded vector stays correct but the row lands under a phantom angle (${absorbedIntoAngleId.slice(0, 2).join(', ')}), which is the unavoidable cost of a variable-length last field with no checksum.`;
  });

  // =========================================================================
  // 4. The three-way fight for the ad name — the real integration risk
  // =========================================================================

  check('ad_name_fits_prefix_plus_genome_plus_idempotency_stamp', () => {
    const brands = ['acme-wallets', 'example-brand', 'a', 'north-ridge-outfitters-co'];
    const archetypes = ['website_purchase', 'whatsapp_conversation', 'instant_form_lead', 'traffic'];
    const adBudget = P.NAME_MAX_LENGTH.ad - P.NAME_STAMP_RESERVE;
    let worstStamped = 0;
    let worstCase = '';
    let n = 0;
    for (const brandId of brands) {
      for (const archetype of archetypes) {
        for (const angleId of ANGLE_IDS) {
          const genome = worstCaseGenome(angleId);
          const name = P.objectName({ brandId, archetype, level: 'ad', variant: G.encodeGenome(genome) });
          const built = G.adNameForGenome({ brandId, archetype, genome });
          eq(built, name, 'adNameForGenome disagrees with publish.objectName');
          must(built.length <= adBudget, `ad name is ${built.length} chars, over the ${adBudget} pre-stamp budget`);

          // The real stamp, from a real intent key — not a placeholder of the right length.
          const key = I.intentKey({
            brandId,
            adAccountId: 'act_1234567890',
            kind: 'ad',
            role: `ad:${angleId}`,
            mode: 'SIMULATE',
            params: { name: built, adsetId: 'reserved', creativeId: 'reserved' },
          });
          const stamped = I.stampIntentKey(built, key);
          must(stamped.length <= P.NAME_MAX_LENGTH.ad, `stamped ad name is ${stamped.length} chars, over the ${P.NAME_MAX_LENGTH.ad} ceiling`);
          must(!stamped.startsWith(built.slice(0, built.length - 1) + ' ') || stamped.startsWith(built), 'the stamp truncated the base name');
          eq(stamped.startsWith(built), true, `stampIntentKey truncated the genome out of the name: ${stamped}`);
          eq(I.extractIntentKey(stamped), key, 'the intent key is not recoverable from the stamped name');

          // And the genome must come back out of the stamped name Insights actually returns.
          const back = G.genomeFromAdName(stamped);
          must(back !== undefined, `genomeFromAdName returned undefined for our own stamped name: ${stamped}`);
          must(sameGenome(back as CreativeGenome, genome), `genome did not survive the stamped ad name: ${stamped}`);
          if (stamped.length > worstStamped) { worstStamped = stamped.length; worstCase = stamped; }
          n++;
        }
      }
    }
    // How much room is actually left, so the number is on the record rather than implied.
    let firstFailingBrandLen = -1;
    for (let len = 1; len <= 200; len++) {
      try {
        G.adNameForGenome({ brandId: 'b'.repeat(len), archetype: 'whatsapp_conversation', genome: worstCaseGenome('z'.repeat(G.ANGLE_ID_MAX_LENGTH)) });
      } catch {
        firstFailingBrandLen = len;
        break;
      }
    }
    return `${n} worst-case combinations fit: longest stamped name ${worstStamped}/${P.NAME_MAX_LENGTH.ad} chars ("${worstCase}"). ` +
      `With the longest archetype (whatsapp_conversation, 21) and a ${G.ANGLE_ID_MAX_LENGTH}-char angle id, brand slugs up to ${firstFailingBrandLen - 1} chars still fit — ` +
      `${P.NAME_MAX_LENGTH.ad - worstStamped} chars of headroom on the realistic worst case. The three claimants on the name field do not collide.`;
  });

  check('genome_is_correctly_placed_on_the_ad_not_the_creative', () => {
    // The module's stated reason for putting the genome on the ad is that the creative
    // name budget cannot hold it. Prove the premise rather than trusting the comment.
    const variant = G.encodeGenome(worstCaseGenome('z'.repeat(G.ANGLE_ID_MAX_LENGTH)));
    const creativeBudget = P.NAME_MAX_LENGTH.creative - P.NAME_STAMP_RESERVE;
    let refused = false;
    try {
      P.objectName({ brandId: 'acme-wallets', archetype: 'website_purchase', level: 'creative', variant });
    } catch (err) {
      refused = err instanceof P.PublishBuildError;
    }
    eq(refused, true, 'a genome-bearing creative name was accepted, so the ad-level placement is unmotivated');
    const back = G.genomeFromAdName(`AUTO/acme-wallets/website_purchase/crt/${variant}`);
    eq(back, undefined, 'genomeFromAdName read a genome off a creative-level name');
    return `A ${variant.length}-char genome cannot fit the ${creativeBudget}-char creative budget (refused by objectName), and genomeFromAdName ignores non-ad levels — the ad-level placement is load-bearing, not stylistic.`;
  });

  check('foreign_and_handmade_ad_names_are_ignored_not_thrown_on', () => {
    const notOurs = [
      'Some human-made ad',
      'AUTO/acme/website_purchase/ad/handmade-variant',
      'AUTO/acme/website_purchase/crt/g1-pb',
      'Copy of AUTO/acme/website_purchase/ad/g1-pb',
      '',
      'AUTO/acme/website_purchase/xx/g1-pb',
    ];
    for (const name of notOurs) eq(G.genomeFromAdName(name), undefined, `"${name}" should be ignored`);
    // But a name that IS ours and IS genome-bearing yet corrupt must throw, not vanish.
    let threw = false;
    try {
      G.genomeFromAdName('AUTO/acme/website_purchase/ad/g1-pb-cwc-nope-pa-xx-tht-ugc-cus-fst-bww-9x16-d3060-lib-mdk-f2r-pro-shn-a');
    } catch (err) { threw = err instanceof G.GenomeError; }
    eq(threw, true, 'a corrupt genome in one of our own ad names was silently dropped');
    return `${notOurs.length} foreign/hand-made names return undefined; a corrupt genome inside one of our own ad names raises GenomeError instead of quietly shrinking the training set.`;
  });

  // =========================================================================
  // 5. Feature projection — is it safe to hang coefficients on?
  // =========================================================================

  check('feature_space_layout_is_a_clean_partition', () => {
    eq(G.FEATURE_COUNT, G.FEATURE_NAMES.length, 'FEATURE_COUNT disagrees with FEATURE_NAMES');
    eq(new Set(G.FEATURE_NAMES).size, G.FEATURE_NAMES.length, 'duplicate feature names — two attributes would share a column');
    let cursor = 0;
    const fields: string[] = [];
    for (const group of G.FEATURE_GROUPS) {
      eq(group.start, cursor, `group "${group.field}" starts at ${group.start}, expected ${cursor} — the blocks do not tile`);
      must(group.length > 0, `group "${group.field}" is empty`);
      for (let i = 0; i < group.length; i++) {
        const name = G.FEATURE_NAMES[group.start + i];
        must(name !== undefined && name.startsWith(`${group.field}=`), `column ${group.start + i} is "${name}", not a ${group.field} level`);
      }
      cursor += group.length;
      fields.push(`${group.field}:${group.length}`);
    }
    eq(cursor, G.FEATURE_COUNT, 'the groups do not cover the whole vector');
    for (let i = 0; i < G.FEATURE_NAMES.length; i++) {
      eq(G.featureIndex(G.FEATURE_NAMES[i] as string), i, `featureIndex disagrees at column ${i}`);
    }
    eq(G.featureIndex('hookTactic=not_a_tactic'), undefined, 'featureIndex invented a column');
    eq(G.featureIndex('angleId=wallet-bulge'), undefined, 'angleId leaked into the design matrix as a column');
    eq(G.featureIndex('funnelStage=TOF'), undefined, 'funnelStage is a function of awarenessStage; including it makes the matrix singular');
    return `${G.FEATURE_COUNT} columns in ${G.FEATURE_GROUPS.length} contiguous, non-overlapping, correctly-named blocks (${fields.join(' ')}); every name resolves back to its own index; angleId and the derived groupings are absent as intended.`;
  });

  check('feature_vector_is_well_formed_for_every_sampled_genome', () => {
    const oneHotGroups = G.FEATURE_GROUPS.filter((g) => g.field !== 'psychTrigger');
    const triggerGroup = G.FEATURE_GROUPS.find((g) => g.field === 'psychTrigger');
    must(triggerGroup !== undefined, 'no psychTrigger block');
    const tg = triggerGroup as { start: number; length: number };
    let twoTrigger = 0;
    for (let n = 0; n < 5000; n++) {
      const g = genomeAtIndex(n);
      const fv = G.featureVector(g);
      eq(fv.values.length, G.FEATURE_COUNT, `sample ${n} width`);
      eq(fv.fingerprint, G.FEATURE_SPACE_FINGERPRINT, `sample ${n} fingerprint`);
      for (const v of fv.values) must(v === 0 || v === 1, `sample ${n} has a non-binary entry ${v}`);
      for (const group of oneHotGroups) {
        let sum = 0;
        for (let i = 0; i < group.length; i++) sum += fv.values[group.start + i] as number;
        eq(sum, 1, `sample ${n}: block "${group.field}" is not one-hot`);
      }
      let tsum = 0;
      for (let i = 0; i < tg.length; i++) tsum += fv.values[tg.start + i] as number;
      const expected = g.secondaryTrigger === undefined ? 1 : 2;
      eq(tsum, expected, `sample ${n}: trigger block sums to ${tsum}, expected ${expected}`);
      if (expected === 2) twoTrigger++;
      // The set bit must be the one named for the level actually held.
      const idx = G.featureIndex(`hookTactic=${g.hookTactic}`);
      must(idx !== undefined && fv.values[idx] === 1, `sample ${n}: hookTactic column is not the one set`);
    }
    return `5000 projections: width ${G.FEATURE_COUNT}, strictly 0/1, all ${oneHotGroups.length} one-hot blocks sum to exactly 1, the multi-hot trigger block sums to 1 or 2 (${twoTrigger} two-trigger samples), and the set column always matches the level held.`;
  });

  check('feature_projection_is_deterministic_and_order_independent', () => {
    const g = genomeAtIndex(11);
    const a = G.featureVector(g).values.join('');
    // Same vector, keys inserted in reverse order: a projection that walked Object.keys
    // would move columns and silently invalidate stored coefficients.
    const reordered = Object.fromEntries(Object.entries(g).reverse()) as unknown as CreativeGenome;
    eq(G.featureVector(reordered).values.join(''), a, 'projection depends on key insertion order');
    eq(G.featureVector(g).values.join(''), a, 'projection is not repeatable');
    // angleId is deliberately not a column: same vector, different angle.
    eq(G.featureVector({ ...g, angleId: 'a-totally-different-one' }).values.join(''), a,
      'angleId changed the vector — it is meant to be a pooling group, not a column');
    // Every other single-field change must move the vector, or that attribute is unlearnable.
    let moved = 0;
    for (const sweep of sweeps) {
      const current = G.featureVector(g).values.join('');
      let seenDifferent = false;
      for (let i = 0; i < sweep.values.length; i++) {
        const alt = sweep.apply(g, i);
        if (G.featureVector(alt).values.join('') !== current) seenDifferent = true;
      }
      must(seenDifferent, `no value of ${sweep.field} changes the feature vector — the attribute cannot be learnt`);
      moved++;
    }
    return `Projection is repeatable and independent of key insertion order; angleId is correctly excluded; all ${moved} coded dimensions plus the trigger block move the vector, so every attribute is regressable.`;
  });

  check('feature_fingerprint_matches_the_layout_it_claims_to_pin', () => {
    const recomputed = createHash('sha256').update(G.FEATURE_NAMES.join('\n')).digest('hex').slice(0, 16);
    eq(G.FEATURE_SPACE_FINGERPRINT, recomputed, 'fingerprint does not cover the current column names');
    // A shifted layout must fingerprint differently, or the guard is decorative.
    const shifted = [...G.FEATURE_NAMES];
    const first = shifted.shift();
    shifted.push(first as string);
    const shiftedFp = createHash('sha256').update(shifted.join('\n')).digest('hex').slice(0, 16);
    must(shiftedFp !== G.FEATURE_SPACE_FINGERPRINT, 'a rotated column layout produces the same fingerprint — stale coefficients would be applied silently');
    return `FEATURE_SPACE_FINGERPRINT=${G.FEATURE_SPACE_FINGERPRINT} is exactly sha256(FEATURE_NAMES)[0:16], and a one-column rotation changes it to ${shiftedFp} — the guard actually detects a moved design matrix.`;
  });

  // A fresh process is the honest test of "will stored coefficients still line up
  // tomorrow": Map/Set iteration or object key order changing across runs would show here.
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const genomePath = fileURLToPath(new URL('../domain/genome.ts', import.meta.url));
    const script =
      `const m = await import(${JSON.stringify(genomePath)});` +
      `console.log(JSON.stringify({fp: m.FEATURE_SPACE_FINGERPRINT, n: m.FEATURE_COUNT, names: m.FEATURE_NAMES.join('|')}));`;
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--no-warnings', '-e', script],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const parsed = JSON.parse(out.trim()) as { fp: string; n: number; names: string };
    if (parsed.fp !== G.FEATURE_SPACE_FINGERPRINT || parsed.n !== G.FEATURE_COUNT || parsed.names !== G.FEATURE_NAMES.join('|')) {
      add('feature_space_stable_across_processes', 'FAIL',
        `a fresh Node process produced fingerprint ${parsed.fp}/${parsed.n} columns against this process's ${G.FEATURE_SPACE_FINGERPRINT}/${G.FEATURE_COUNT} — stored coefficients cannot be trusted across runs. Probe file: ${selfPath}`);
    } else {
      add('feature_space_stable_across_processes', 'PASS',
        `A fresh Node process built the identical ${parsed.n}-column layout and fingerprint ${parsed.fp}, so coefficients stored today still line up with the columns tomorrow.`);
    }
  } catch (err) {
    add('feature_space_stable_across_processes', 'SKIP',
      `could not spawn a second Node process to re-derive the layout: ${message(err)}`,
      'child process / type-stripping unavailable in this environment');
  }

  // =========================================================================
  // 6. Validation — does it actually refuse what would poison the learning?
  // =========================================================================

  check('validation_refuses_the_incoherent_combinations_it_names', () => {
    const demo = genomeForCell({ template: 'problem_solution_demo', mechanic: 'borrowed_enemy', hookTactic: 'explainer' }, 'wallet-bulge');
    const cases: readonly { why: string; g: CreativeGenome; code: string }[] = [
      { why: 'a spokesperson on an asset type with nobody in frame',
        g: { ...demo, assetType: 'text_only', spokespersonType: 'customer' }, code: 'spokesperson_on_personless_asset' },
      { why: 'a talking-head testimonial with nobody on camera',
        g: { ...genomeForCell({ template: 'talking_head_testimonial', mechanic: 'social_witness', hookTactic: 'social_proof' }, 'a'), spokespersonType: 'none' }, code: 'template_requires_person' },
      { why: 'a founder story fronted by a paid expert',
        g: { ...genomeForCell({ template: 'founder_story', mechanic: 'reframe', hookTactic: 'confession' }, 'a'), spokespersonType: 'expert' }, code: 'spokesperson_wrong_for_template' },
      { why: 'a synthetic presenter on a format that presents lived experience (FTC)',
        g: { ...genomeForCell({ template: 'before_after', mechanic: 'contrast_without_comment', hookTactic: 'contrast' }, 'a'), assetType: 'ugc', spokespersonType: 'synthetic' }, code: 'synthetic_presenter_forbidden' },
      { why: 'a still frame with cuts',
        g: { ...demo, template: 'offer_led', assetType: 'product_image_with_text', spokespersonType: 'none', hookTactic: 'offer_only', mechanic: 'this_and_a', durationBucket: 'static', pacing: 'fast', musicPresence: 'none', captionStyle: 'burned_in_static' }, code: 'static_with_pacing' },
      { why: 'a still frame with a soundtrack',
        g: { ...demo, template: 'offer_led', assetType: 'product_image_with_text', spokespersonType: 'none', hookTactic: 'offer_only', mechanic: 'this_and_a', durationBucket: 'static', pacing: 'static', musicPresence: 'trending', captionStyle: 'burned_in_static' }, code: 'static_with_music' },
      { why: 'a still frame with word-by-word captions',
        g: { ...demo, template: 'offer_led', assetType: 'product_image_with_text', spokespersonType: 'none', hookTactic: 'offer_only', mechanic: 'this_and_a', durationBucket: 'static', pacing: 'static', musicPresence: 'none', captionStyle: 'burned_in_karaoke' }, code: 'static_with_motion_captions' },
      { why: 'an offer-led ad with no offer',
        g: { ...genomeForCell({ template: 'offer_led', mechanic: 'this_and_a', hookTactic: 'price_anchor' }, 'a'), offerType: 'none' }, code: 'template_requires_offer' },
      { why: 'a sale-announcement hook announcing nothing',
        g: { ...demo, hookTactic: 'sale_announcement', offerType: 'none' }, code: 'offer_tactic_without_offer' },
      { why: 'a "second" trigger that repeats the first',
        g: { ...demo, primaryTrigger: 'curiosity_gap', secondaryTrigger: 'curiosity_gap' }, code: 'duplicate_trigger' },
      { why: 'an angle id that is not a slug (it goes verbatim into the ad name)',
        g: { ...demo, angleId: 'Spring Sale!' }, code: 'angle_id_shape' },
      { why: 'an angle id past the ad-name budget',
        g: { ...demo, angleId: 'a'.repeat(G.ANGLE_ID_MAX_LENGTH + 1) }, code: 'angle_id_length' },
    ];
    for (const c of cases) {
      const r = G.validateGenome(c.g);
      must(errCodes(r).includes(c.code), `${c.why}: expected error "${c.code}", got [${errCodes(r).join(', ')}]`);
      let threw = false;
      try { G.assertValidGenome(c.g); } catch (err) { threw = err instanceof G.GenomeError; }
      must(threw, `${c.why}: assertValidGenome let it through`);
      let refusedName = false;
      try { G.adNameForGenome({ brandId: 'acme-wallets', archetype: 'website_purchase', genome: c.g }); }
      catch (err) { refusedName = err instanceof G.GenomeError; }
      must(refusedName, `${c.why}: adNameForGenome would have published it`);
    }
    return `All ${cases.length} named incoherent combinations are rejected as errors, refused by assertValidGenome, and blocked before an ad name can be built: ${cases.map((c) => c.code).join(', ')}.`;
  });

  check('validation_does_not_false-refuse_the_endorsed_variant_space', () => {
    // Every cell the planner is told to explore must actually be buildable. A dead cell
    // would show up as permanent under-coverage and stop the angle ever retiring.
    const unexpectedWarnings = new Map<string, string[]>();
    for (const cell of G.ANGLE_VARIANT_SPACE) {
      const g = genomeForCell(cell, 'wallet-bulge');
      const r = G.validateGenome(g);
      must(r.errors.length === 0,
        `endorsed cell ${cell.template}|${cell.mechanic}|${cell.hookTactic} cannot be built: [${errCodes(r).join(', ')}]`);
      const unexpected = warnCodes(r).filter((c) => c !== 'human_review_required');
      if (unexpected.length > 0) unexpectedWarnings.set(`${cell.template}|${cell.mechanic}|${cell.hookTactic}`, unexpected);
      G.adNameForGenome({ brandId: 'acme-wallets', archetype: 'website_purchase', genome: g });
    }
    must(unexpectedWarnings.size === 0,
      `${unexpectedWarnings.size} endorsed cells warn about being off-book against their own template spec: ` +
      [...unexpectedWarnings.entries()].slice(0, 3).map(([k, v]) => `${k} -> ${v.join(',')}`).join(' | '));
    // The escape hatch must still be an escape hatch, not a refusal.
    const offBook = { ...genomeForCell({ template: 'unboxing', mechanic: 'implied_answer', hookTactic: 'curiosity' }, 'a'), awarenessStage: 'unaware' as AwarenessStage, mechanic: 'trojan_horse' as const, hookTactic: 'confession' as const };
    const r = G.validateGenome(offBook);
    eq(r.errors.length, 0, 'an off-book but legal combination was refused — §5.3 says prefer, never forbid');
    must(warnCodes(r).includes('stage_off_template'), 'an off-book stage produced no warning at all');
    must(warnCodes(r).includes('mechanic_off_template'), 'an off-book mechanic produced no warning at all');
    must(warnCodes(r).includes('tactic_off_template'), 'an off-book tactic produced no warning at all');
    return `All ${G.ANGLE_VARIANT_SPACE.length} endorsed variant cells build clean (zero errors, no off-book warnings against their own spec) and produce a publishable ad name; a deliberately off-book vector warns three times but is not refused, so the escape hatch survives.`;
  });

  check('template_specs_are_internally_consistent', () => {
    const problems: string[] = [];
    const personless = new Set(['text_only', 'product_image', 'product_image_with_text', 'illustration', 'animation']);
    for (const template of G.CREATIVE_TEMPLATES) {
      const spec = G.TEMPLATE_SPECS[template];
      eq(spec.template, template, `TEMPLATE_SPECS["${template}"].template is "${spec.template}"`);
      if (spec.awarenessFit.length === 0) problems.push(`${template}: empty awarenessFit`);
      if (spec.funnel.length === 0) problems.push(`${template}: empty funnel`);
      if (spec.mechanics.length === 0) problems.push(`${template}: no mechanics`);
      if (spec.hookTactics.length === 0) problems.push(`${template}: no hook tactics`);
      if (spec.durationBuckets.length === 0) problems.push(`${template}: no duration buckets`);
      if (spec.visualFormat.trim() === '') problems.push(`${template}: no visual_format to join on`);
      if (spec.requiresPerson && personless.has(spec.defaultAssetType)) {
        problems.push(`${template}: requiresPerson but defaultAssetType "${spec.defaultAssetType}" has nobody in frame — the default is unbuildable`);
      }
      if (spec.forbidsSynthetic && (spec.spokespersons ?? []).includes('synthetic')) {
        problems.push(`${template}: lists synthetic as a spokesperson while forbidding it`);
      }
      if (spec.requiresPerson && spec.spokespersons !== undefined && spec.spokespersons.length === 0) {
        problems.push(`${template}: requiresPerson with an empty spokesperson list`);
      }
      for (const m of spec.mechanics) must(G.CREATIVE_MECHANICS.includes(m), `${template}: unknown mechanic "${m}"`);
      for (const h of spec.hookTactics) must(G.HOOK_TACTICS.includes(h), `${template}: unknown hook tactic "${h}"`);
      for (const s of spec.awarenessFit) must(G.AWARENESS_STAGES.includes(s), `${template}: unknown awareness stage "${s}"`);
      for (const d of spec.durationBuckets) must(G.DURATION_BUCKETS.includes(d), `${template}: unknown duration bucket "${d}"`);
      must(G.ASSET_TYPES.includes(spec.defaultAssetType), `${template}: unknown defaultAssetType`);
    }
    must(problems.length === 0, problems.join(' | '));
    return `All ${G.CREATIVE_TEMPLATES.length} template specs reference only known levels, carry a joinable visual_format, and pair requiresPerson/forbidsSynthetic with a buildable default.`;
  });

  check('funnel_and_duration_helpers_agree_with_their_own_bands', () => {
    const stages: readonly [AwarenessStage, string][] = [
      ['unaware', 'TOF'], ['problem_aware', 'MOF'], ['solution_aware', 'MOF'],
      ['product_aware', 'BOF'], ['most_aware', 'BOF'],
    ];
    for (const [stage, expected] of stages) eq(G.funnelStageFor(stage), expected, `funnelStageFor(${stage})`);
    const durations: readonly [number, string][] = [
      [0, 'static'], [1, 's3_8'], [8, 's3_8'], [8.5, 's6_15'], [15, 's6_15'],
      [15.001, 's15_30'], [30, 's15_30'], [60, 's30_60'], [61, 's60_plus'], [3600, 's60_plus'],
    ];
    for (const [s, expected] of durations) eq(G.durationBucketForSeconds(s), expected, `durationBucketForSeconds(${s})`);
    const cuts: readonly [number, string][] = [
      [0, 'static'], [1, 'slow'], [2, 'slow'], [3, 'moderate'], [5, 'moderate'],
      [6, 'fast'], [9, 'fast'], [10, 'rapid'], [999, 'rapid'],
    ];
    for (const [c, expected] of cuts) eq(G.pacingForCutsPer10s(c), expected, `pacingForCutsPer10s(${c})`);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let threwD = false;
      let threwP = false;
      try { G.durationBucketForSeconds(bad); } catch (err) { threwD = err instanceof G.GenomeError; }
      try { G.pacingForCutsPer10s(bad); } catch (err) { threwP = err instanceof G.GenomeError; }
      must(threwD, `durationBucketForSeconds(${bad}) did not refuse`);
      must(threwP, `pacingForCutsPer10s(${bad}) did not refuse`);
    }
    // Every bucket a helper can return must be an encodable level.
    for (let s = 0; s <= 120; s += 0.5) must(G.DURATION_BUCKETS.includes(G.durationBucketForSeconds(s)), `duration ${s}s maps outside the codebook`);
    for (let c = 0; c <= 40; c++) must(G.PACINGS.includes(G.pacingForCutsPer10s(c)), `pacing ${c} maps outside the codebook`);
    return `Funnel mapping, the overlapping §5.6 duration bands (lower bucket wins at 8s and 15s) and the cut-density bands all land where documented; negatives, NaN and Infinity are refused; every continuous input maps to an encodable level.`;
  });

  // =========================================================================
  // 7. Angles — the learning entity
  // =========================================================================

  check('angle_validation_catches_taglines_and_unfalsifiable_hypotheses', () => {
    const now = new Date('2026-09-05T00:00:00.000Z').toISOString();
    const good = {
      id: 'wallet-bulge', brandId: 'acme-wallets', statement: 'Your wallet ruins every pair of trousers',
      anchorType: 'pain' as const, painOrDesireId: 'bulk', personaId: 'commuter-30s',
      hypothesis: 'If bulk is the real pain, a slim-profile angle beats a leather-quality angle on CPA. Falsified if CPA is not lower after 50 conversions.',
      status: 'testing' as const, createdAtIso: now,
    };
    eq(G.validateAngle(good, { brandTerms: ['Acme', 'Acme Wallets'] }).errors.length, 0, 'a good angle was refused');
    const cases: readonly [string, Record<string, unknown>, string, string[]?][] = [
      ['names the seller', { statement: 'Acme wallets are slimmer than the rest' }, 'angle_names_brand', ['Acme']],
      ['names the seller mid-sentence with punctuation', { statement: "Nothing beats Acme's grip" }, 'angle_names_brand', ['Acme']],
      ['is marketing copy, not a core truth', { statement: 'Professional grade natural healing without prescription side effects or unwanted long term risk' }, 'angle_statement_too_long'],
      ['is empty', { statement: '   ' }, 'angle_statement_empty'],
      ['cannot be falsified', { hypothesis: '' }, 'angle_no_hypothesis'],
      ['is global rather than per-brand', { brandId: '' }, 'angle_no_brand'],
      ['has an unstable id', { id: 'Wallet Bulge' }, 'angle_id_shape'],
      ['has an id past the ad-name budget', { id: 'a'.repeat(G.ANGLE_ID_MAX_LENGTH + 1) }, 'angle_id_length'],
    ];
    for (const [why, patch, code, terms] of cases) {
      const r = G.validateAngle({ ...good, ...patch } as typeof good, { brandTerms: terms ?? ['Acme'] });
      must(errCodes(r).includes(code), `angle that ${why}: expected "${code}", got [${errCodes(r).join(', ')}]`);
    }
    // The whole-word rule: a brand called "Ash" must not veto the word "washer".
    const ashy = G.validateAngle({ ...good, statement: 'You should not need a power washer for this' }, { brandTerms: ['Ash'] });
    eq(ashy.errors.length, 0, 'substring matching false-refused an angle — the angle supply is the scarce input');
    const slogan = G.validateAngle({ ...good, statement: 'Your wallet ruins every pair of trousers!' }, { brandTerms: ['Acme'] });
    must(warnCodes(slogan).includes('angle_reads_as_slogan'), 'an exclamation-mark slogan produced no warning');
    must(G.ANGLE_MANUAL_CHECKS.length > 0, 'the manual-check list is empty, so the Out-Loud Test is silently skipped');
    return `${cases.length} bad angles are refused with the right code, brand-term matching is whole-word (a brand called "Ash" does not veto "washer"), the slogan warning fires, and ${G.ANGLE_MANUAL_CHECKS.length} machine-unrunnable checks are surfaced rather than pretended.`;
  });

  check('angle_arithmetic_refuses_records_that_would_misallocate_budget', () => {
    const window = { windowStartIso: '2026-08-01T00:00:00.000Z', windowEndIso: '2026-08-29T00:00:00.000Z' };
    const base: AnglePerformance = {
      angleId: 'wallet-bulge', creativesWithSpend: 40, winners: 4, midRange: 20, losers: 12,
      spendUsd: 12_000, accountCreativesWithSpend: 400, accountSpendUsd: 80_000, ...window,
    };
    eq(Math.round(G.hitRate(base) * 1000) / 1000, 0.1, 'hit rate');
    eq(Math.round(G.spendUseRatio(base) * 1000) / 1000, 1.5, 'spend-use ratio');
    eq(G.classifyAngle(base), 'safest_bet', 'high hit + high SUR');
    eq(G.classifyAngle({ ...base, winners: 1 }), 'high_variance_bet', 'low hit + high SUR must not be a loser');
    eq(G.classifyAngle({ ...base, spendUsd: 500 }), 'workhorse', 'high hit + low SUR');
    eq(G.classifyAngle({ ...base, winners: 1, spendUsd: 500 }), 'stop_generating', 'low hit + low SUR');
    eq(G.classifyAngle({ ...base, creativesWithSpend: 9, winners: 1, midRange: 4, losers: 4 }), 'insufficient_data', 'below the classification floor');
    // Documented boundary behaviour: hit rate is >=, SUR is strictly >.
    eq(G.classifyAngle({ ...base, creativesWithSpend: 50, winners: 4, midRange: 20, losers: 12, spendUsd: 10_000, accountSpendUsd: 80_000, accountCreativesWithSpend: 400 }), 'workhorse',
      'hit rate exactly at the reference should count as high, SUR exactly 1.0 should not');
    // A mid-flight window legitimately under-sums and must NOT be refused.
    const midFlight = { ...base, winners: 1, midRange: 2, losers: 3 };
    eq(typeof G.hitRate(midFlight), 'number', 'a mid-flight window was refused');
    const incoherent: readonly [string, Partial<AnglePerformance>][] = [
      ['more winners than creatives with spend', { winners: 60 }],
      ['classified count over the denominator', { winners: 20, midRange: 20, losers: 20 }],
      ['angle bigger than its own account', { creativesWithSpend: 500 }],
      ['angle spending more than the account', { spendUsd: 90_000 }],
      ['a fractional creative count', { creativesWithSpend: 40.5 }],
      ['a negative count', { winners: -1 }],
      ['a non-finite spend', { spendUsd: Number.NaN }],
    ];
    for (const [why, patch] of incoherent) {
      let threw = 0;
      for (const fn of [() => G.hitRate({ ...base, ...patch }), () => G.spendUseRatio({ ...base, ...patch }), () => G.classifyAngle({ ...base, ...patch })]) {
        try { fn(); } catch (err) { if (err instanceof G.GenomeError) threw++; }
      }
      eq(threw, 3, `${why}: only ${threw}/3 of hitRate/spendUseRatio/classifyAngle refused it`);
    }
    for (const empty of [{ creativesWithSpend: 0, winners: 0, midRange: 0, losers: 0 }, { accountSpendUsd: 0, spendUsd: 0 }, { accountCreativesWithSpend: 0, creativesWithSpend: 0, winners: 0, midRange: 0, losers: 0 }]) {
      let threw = false;
      try { G.spendUseRatio({ ...base, ...empty }); } catch (err) { threw = err instanceof G.GenomeError; }
      must(threw, 'a zero denominator produced a number instead of a refusal');
    }
    return `The §4.4 2x2 lands on all four quadrants plus insufficient_data and the documented >=/> boundary; ${incoherent.length} impossible records are refused by all three of hitRate/spendUseRatio/classifyAngle; zero denominators refuse rather than returning 0; a mid-flight window that under-sums is correctly allowed.`;
  });

  check('variant_space_coverage_and_retirement_behave_as_a_partition', () => {
    const keys = new Set(G.ANGLE_VARIANT_SPACE.map((c) => `${c.template}|${c.mechanic}|${c.hookTactic}`));
    eq(keys.size, G.ANGLE_VARIANT_SPACE.length, 'the variant space contains duplicate cells');
    must(G.ANGLE_VARIANT_SPACE.length > 0, 'the variant space is empty, so exhaustion is instant');
    eq(G.angleVariantCoverage('wallet-bulge', []), 0, 'coverage of nothing is not zero');
    eq(G.unexploredVariants('wallet-bulge', []).length, G.ANGLE_VARIANT_SPACE.length, 'nothing launched but some cells already explored');

    const launched: CreativeGenome[] = [];
    let previous = -1;
    for (let i = 0; i < G.ANGLE_VARIANT_SPACE.length; i++) {
      const cell = G.ANGLE_VARIANT_SPACE[i] as VariantCell;
      launched.push(genomeForCell(cell, 'wallet-bulge'));
      const coverage = G.angleVariantCoverage('wallet-bulge', launched);
      const unexplored = G.unexploredVariants('wallet-bulge', launched);
      must(coverage > previous, `coverage did not advance after launching cell ${i}`);
      previous = coverage;
      eq(Math.round(coverage * G.ANGLE_VARIANT_SPACE.length) + unexplored.length, G.ANGLE_VARIANT_SPACE.length,
        `coverage and unexploredVariants disagree at cell ${i}`);
    }
    eq(G.angleVariantCoverage('wallet-bulge', launched), 1, 'launching every cell did not reach full coverage');
    eq(G.unexploredVariants('wallet-bulge', launched).length, 0, 'cells remain unexplored after launching all of them');

    // Another angle's launches must not count, and neither must off-space combinations.
    eq(G.angleVariantCoverage('other-angle', launched), 0, "another angle's launches inflated this angle's coverage");
    const offSpace: CreativeGenome = { ...genomeForCell(G.ANGLE_VARIANT_SPACE[0] as VariantCell, 'fresh-angle'), mechanic: 'trojan_horse', hookTactic: 'wordplay' };
    eq(G.angleVariantCoverage('fresh-angle', [offSpace]), 0, 'an off-space launch inflated coverage — the angle could "exhaust" cells that were never in its space');

    eq(G.shouldRetireAngle({ performanceDeclining: true, coverage: 1 }), true, 'a declining, exhausted angle was not retired');
    eq(G.shouldRetireAngle({ performanceDeclining: true, coverage: G.ANGLE_EXHAUSTION_COVERAGE - 0.01 }), false, 'an angle was retired before its space was explored');
    eq(G.shouldRetireAngle({ performanceDeclining: false, coverage: 1 }), false, 'a healthy angle was retired on exhaustion alone');
    eq(G.shouldRetireAngle({ performanceDeclining: true, coverage: G.ANGLE_EXHAUSTION_COVERAGE }), true, 'the exhaustion threshold is not inclusive');
    return `${G.ANGLE_VARIANT_SPACE.length} distinct endorsed cells; coverage rises strictly monotonically to exactly 1 over an incremental launch history and always partitions against unexploredVariants; other angles and off-space launches contribute nothing; retirement needs decline AND >=${G.ANGLE_EXHAUSTION_COVERAGE} coverage, never a timer.`;
  });

  check('describeGenome_carries_every_attribute_an_operator_needs', () => {
    const g = genomeAtIndex(9);
    const line = G.describeGenome(g);
    for (const [k, v] of Object.entries(g)) {
      if (k === 'secondaryTrigger') continue;
      must(line.includes(String(v)), `describeGenome omitted ${k}="${String(v)}"`);
    }
    must(line.includes(G.funnelStageFor(g.awarenessStage)), 'describeGenome omitted the derived funnel stage');
    must(line.includes(G.HOOK_TACTIC_CLUSTER[g.hookTactic]), 'describeGenome omitted the hook-tactic cluster');
    const single: CreativeGenome = { ...g };
    delete (single as { secondaryTrigger?: unknown }).secondaryTrigger;
    must(!G.describeGenome(single).includes('+'), 'a single-trigger genome renders as a pair');
    return `The log line names all 17 attributes plus the derived funnel stage and hook cluster (${line.length} chars), and a one-trigger hook does not render as a pair.`;
  });

  // =========================================================================
  // 8. Defects found — recorded as failing checks so they cannot be waved past
  // =========================================================================

  check('validateGenome_raises_a_domain_error_for_an_unknown_template', () => {
    // A genome can arrive from a planner, a YAML file or a ledger row, so `template` is
    // not guaranteed to be one of the ten at runtime. assertValidGenome is documented as
    // the thing to call "before anything that spends money"; a caller catching GenomeError
    // around it will not catch a TypeError.
    const g = genomeAtIndex(4);
    const offenders: string[] = [];
    for (const template of ['carousel', 'constructor', 'toString', '__proto__', '']) {
      try {
        const r = G.validateGenome({ ...g, template: template as CreativeTemplate });
        if (r.errors.length === 0) offenders.push(`"${template}" -> accepted as valid`);
      } catch (err) {
        if (!(err instanceof G.GenomeError)) offenders.push(`"${template}" -> ${message(err)}`);
      }
    }
    must(offenders.length === 0,
      `validateGenome does not raise GenomeError for an unknown template value; it crashes with a raw TypeError from the TEMPLATE_SPECS lookup: ${offenders.join(' | ')}. ` +
      'publish.ts guards the same class of lookup with Object.hasOwn; genome.ts does not.');
    return `An unknown or prototype-shaped template value is reported as a GenomeError rather than crashing the caller.`;
  });

  check('validation_rejects_a_still_image_carrying_motion_attributes', () => {
    // The mirror rule already exists: durationBucket "static" forbids pacing, music and
    // motion captions. The other direction is unguarded, so a still-image asset can be
    // tagged with rapid cuts and a soundtrack and the regression will credit the result
    // to attributes that were never on screen — the exact failure the
    // spokesperson_on_personless_asset rule exists to prevent.
    const base = genomeForCell({ template: 'problem_solution_demo', mechanic: 'borrowed_enemy', hookTactic: 'explainer' }, 'wallet-bulge');
    const offenders: string[] = [];
    // Only the three unambiguous stills. `text_only` and `animation` are excluded on
    // purpose: a text card can be a motion asset and an animation always is, so claiming
    // them would be a false refusal, which this module is right to treat as the more
    // expensive error.
    for (const assetType of ['product_image', 'product_image_with_text', 'illustration'] as const) {
      const still: CreativeGenome = {
        ...base, assetType, spokespersonType: 'none',
        durationBucket: 's30_60', pacing: 'rapid', musicPresence: 'trending', captionStyle: 'burned_in_karaoke',
      };
      const r = G.validateGenome(still);
      if (r.errors.length === 0) {
        offenders.push(`assetType "${assetType}" + pacing rapid + music trending + karaoke captions -> errors [] warnings [${warnCodes(r).join(',') || 'none'}]`);
      }
    }
    must(offenders.length === 0,
      `a still-image asset carrying motion-only attributes validates clean, with no error and (mostly) no warning: ${offenders.join(' | ')}. ` +
      'genome.ts guards the mirror rule (durationBucket=static forbids pacing, music and motion captions) but not this direction, ' +
      'so the regression will credit a still image\'s result to "rapid pacing" and "trending music" that were never on screen — ' +
      'the same failure the spokesperson_on_personless_asset rule exists to prevent. ' +
      'A STILL_ASSET_TYPES set covering product_image / product_image_with_text / illustration, checked against pacing !== "static", ' +
      'musicPresence !== "none" and MOTION_ONLY_CAPTION_STYLES, closes it. Note durationBucket must stay OUT of that rule: ' +
      'TEMPLATE_SPECS.offer_led pairs defaultAssetType "product_image_with_text" with durationBuckets ["static","s3_8"], so a still held for 3-8s is endorsed by the corpus.');
    return `Still-image asset types cannot be tagged with cuts, music or motion captions.`;
  });

  check('ad_name_failure_names_the_actual_cause', () => {
    // adNameForGenome rewrites every PublishBuildError as a length problem. When the real
    // cause is a malformed brand slug the headline sentence is false, and the operator
    // reading it at 3am is told to shorten an angle id that is already short.
    const g = genomeForCell({ template: 'unboxing', mechanic: 'implied_answer', hookTactic: 'curiosity' }, 'wallet-bulge');
    const lengthFailure = (() => {
      try { G.adNameForGenome({ brandId: 'b'.repeat(150), archetype: 'website_purchase', genome: { ...g, angleId: 'a'.repeat(G.ANGLE_ID_MAX_LENGTH) } }); return ''; }
      catch (err) { return message(err); }
    })();
    must(/shorten the angle id/.test(lengthFailure), `a genuinely over-long name did not produce the length guidance: ${lengthFailure}`);
    const shapeFailure = (() => {
      try { G.adNameForGenome({ brandId: 'Acme_Wallets', archetype: 'website_purchase', genome: g }); return ''; }
      catch (err) { return message(err); }
    })();
    must(shapeFailure !== '', 'a malformed brand slug was accepted into an ad name');
    must(!/will not fit/.test(shapeFailure),
      `a malformed brandId is reported as a length problem it is not: ${shapeFailure}`);
    return `A too-long name says so; a malformed brand slug is reported as a shape problem rather than being mislabelled as a length problem.`;
  });

  return { module: MODULE, checks };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === arg || import.meta.url === new URL(`file://${arg}`).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const report = await run();
  const tally = { PASS: 0, FAIL: 0, SKIP: 0 };
  console.log(`\n=== capability probe: ${report.module} ===\n`);
  for (const c of report.checks) {
    tally[c.status]++;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail}`);
    if (c.blockedBy !== undefined) console.log(`       blockedBy: ${c.blockedBy}`);
    console.log('');
  }
  console.log(`PASS ${tally.PASS}  FAIL ${tally.FAIL}  SKIP ${tally.SKIP}  (${report.checks.length} checks)`);
  process.exitCode = tally.FAIL > 0 ? 1 : 0;
}
