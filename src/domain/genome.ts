/**
 * The creative attribute vector — the mechanism that makes learning transferable.
 *
 * Killing a loser teaches nothing about what to make next unless the loser was tagged.
 * Tag it, and "problem-callout hooks underperform for this brand" becomes a durable,
 * queryable lesson that survives the ad it was learnt from. That is the whole point of
 * this file: the unit of analysis is the creative, but the unit of INFERENCE is the
 * attribute value (performance-creative-playbook.md §4.6).
 *
 * Sources — docs/research/performance-creative-playbook.md throughout:
 *   §2    the four-layer creative stack (angle → mechanic → hook → format)
 *   §3.6  the 8 psychological triggers
 *   §4.2  Motion's published AI-tagging dimensions
 *   §4.4  hit rate vs spend-use ratio — two different questions, both encoded
 *   §4.5  the concrete genome schema this type is a tightened version of
 *   §4.6  how to regress on it, and the three traps
 *   §5.3  format → funnel stage ("prefer, don't forbid")
 *   §5.4  asset type = production tier, 15 values
 *   §5.6  duration is per-format, never a global constant
 *   §5.7  the ten canonical templates, with their validators
 *   §6.1  the 33 hook tactics; §6.2 the promotional/interrupt clusters
 *   §7    the 8 creative mechanics
 *   §10.4 what a messaging angle is, and how to validate a generated one
 *   §11.3 the diversity tuple; §11.4 retire on exhaustion, never on a timer
 *   §12.5 encode the genome into the object NAME
 *
 * Four things drove the shape of this module:
 *
 *  - **Angle is a first-class entity, not a string on a creative.** Meta has never
 *    claimed this layer and cannot measure it, because it does not know your angles
 *    exist (§10.1, 00-SYNTHESIS.md §"Reason about your angle and your offer"). An angle
 *    has an id, a hypothesis and a performance record, and every ad launched under it
 *    carries its id in the ad name.
 *
 *  - **Codes are a frozen contract.** The encoded vector goes into a Meta ad name, and
 *    ad names live in Meta's data long after this process exits. Re-spelling a code
 *    orphans every historical row that carried the old one, so the codebook is written
 *    out longhand rather than derived from array position — appending a value is safe,
 *    renumbering is not.
 *
 *  - **The feature space is fingerprinted.** A bandit that stores coefficients against
 *    172 columns must refuse to apply them after the columns move. FEATURE_SPACE_FINGERPRINT
 *    is the guard; store it beside the coefficients and compare before use.
 *
 *  - **Errors, warnings, and the escape hatch are three different things.** §5.3 is
 *    explicit that any format can work at any awareness stage if the messaging is right,
 *    so stage/format mismatch is a WARNING. A synthetic presenter delivering a customer
 *    testimonial is an FTC fabricated-testimonial problem, so that is an ERROR.
 */

import { createHash } from 'node:crypto';
import {
  NAME_MAX_LENGTH,
  NAME_STAMP_RESERVE,
  PublishBuildError,
  objectName,
  parseObjectName,
  type CallToActionType,
} from '../meta/publish.ts';

// ---------------------------------------------------------------------------
// Errors and issues
// ---------------------------------------------------------------------------

/** Thrown for a genome that cannot be encoded, decoded, or safely published. */
export class GenomeError extends Error {
  /** The genome field at fault, e.g. `spokespersonType`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'GenomeError';
    this.field = field;
  }
}

/**
 * One validation finding.
 *
 * `code` is machine-stable and safe to alert on; `message` names the actual cause,
 * because nobody is awake at 3am to work out which of eleven rules fired.
 */
export interface GenomeIssue {
  code: string;
  field: string;
  message: string;
}

export interface ValidationResult {
  /** Publishing with any of these is a refusal. */
  errors: GenomeIssue[];
  /** Worth logging and worth a bandit prior, but not worth blocking a launch. */
  warnings: GenomeIssue[];
}

function issue(code: string, field: string, message: string): GenomeIssue {
  return { code, field, message };
}

// ---------------------------------------------------------------------------
// Codec machinery
// ---------------------------------------------------------------------------

/**
 * Codes are restricted to what a Meta object name and `publish.objectName`'s variant
 * slug both accept, minus the hyphen, which is the field separator.
 */
const CODE_RE = /^[a-z0-9]+$/;

type CodeTable = readonly (readonly [string, string])[];

interface Codec<T extends string> {
  readonly field: string;
  readonly values: readonly T[];
  readonly maxCodeLength: number;
  /** Value → frozen short code. Throws rather than emitting a name we cannot read back. */
  code(value: T): string;
  /** Short code → value, or undefined if the code is not in this dimension's book. */
  value(code: string): T | undefined;
}

/**
 * Builds a two-way codec and self-checks the codebook at module load.
 *
 * A duplicate or malformed code is a programming error that would silently corrupt every
 * ad name written afterwards, so it fails at import rather than at publish time.
 */
function buildCodec<P extends CodeTable>(field: string, table: P): Codec<P[number][0]> {
  type V = P[number][0];
  const toCode = new Map<string, string>();
  const fromCode = new Map<string, V>();
  let maxCodeLength = 0;

  for (const [value, code] of table) {
    if (!CODE_RE.test(code)) {
      throw new GenomeError(field, `code "${code}" for "${value}" must match ${CODE_RE} (no hyphens: hyphen is the field separator).`);
    }
    if (toCode.has(value)) throw new GenomeError(field, `value "${value}" appears twice in the codebook.`);
    if (fromCode.has(code)) {
      throw new GenomeError(field, `code "${code}" is used by both "${fromCode.get(code)}" and "${value}"; codes must be unique within a dimension.`);
    }
    toCode.set(value, code);
    // The table's element type is a literal tuple, so the first element really is a V.
    fromCode.set(code, value as V);
    maxCodeLength = Math.max(maxCodeLength, code.length);
  }

  const values = table.map((pair) => pair[0]) as readonly V[];

  return {
    field,
    values,
    maxCodeLength,
    code(value: V): string {
      const c = toCode.get(value);
      if (c === undefined) {
        throw new GenomeError(field, `"${value}" is not a value of this dimension. Valid: ${values.join(', ')}.`);
      }
      return c;
    },
    value(code: string): V | undefined {
      return fromCode.get(code);
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy layer — awareness stage and funnel position
// ---------------------------------------------------------------------------

/** Eugene Schwartz's five stages (§6.3). The angle stays constant; only expression changes. */
const AWARENESS_STAGE_TABLE = [
  ['unaware', 'un'],
  ['problem_aware', 'pb'],
  ['solution_aware', 'so'],
  ['product_aware', 'pd'],
  ['most_aware', 'mo'],
] as const;
export type AwarenessStage = (typeof AWARENESS_STAGE_TABLE)[number][0];
const AWARENESS_STAGE = buildCodec('awarenessStage', AWARENESS_STAGE_TABLE);
export const AWARENESS_STAGES: readonly AwarenessStage[] = AWARENESS_STAGE.values;

export type FunnelStage = 'TOF' | 'MOF' | 'BOF';

/**
 * Derived, never stored: two sources of truth for the same fact drift.
 *
 * The mapping is the §5.3 funnel table read backwards through §6.3's stage definitions —
 * cold and problem-aware audiences are prospecting, comparison is consideration, and a
 * most-aware audience is a conversion audience.
 */
export function funnelStageFor(stage: AwarenessStage): FunnelStage {
  switch (stage) {
    case 'unaware':
      return 'TOF';
    case 'problem_aware':
    case 'solution_aware':
      return 'MOF';
    case 'product_aware':
    case 'most_aware':
      return 'BOF';
  }
}

// ---------------------------------------------------------------------------
// Concept layer — mechanic, hook tactic, psychological trigger
// ---------------------------------------------------------------------------

/**
 * The 8 creative mechanics (§7) — "the cognitive or emotional move that makes the
 * concept land". This layer is absent from most tagging schemas and is where the
 * "why did this work" signal actually lives, which is exactly why it is here.
 */
const MECHANIC_TABLE = [
  ['implied_answer', 'ia'],
  ['social_witness', 'sw'],
  ['overheard_conversation', 'oc'],
  ['reframe', 'rf'],
  ['borrowed_enemy', 'be'],
  ['trojan_horse', 'th'],
  ['contrast_without_comment', 'cwc'],
  ['this_and_a', 'taa'],
] as const;
export type CreativeMechanic = (typeof MECHANIC_TABLE)[number][0];
const MECHANIC = buildCodec('mechanic', MECHANIC_TABLE);
export const CREATIVE_MECHANICS: readonly CreativeMechanic[] = MECHANIC.values;

/**
 * Hook tactics — the strategic frame of the first 1–3 seconds.
 *
 * The first 33 are Motion's published `/library/hooks/tactics/` enum (§6.1). The nine
 * after them appear on the 2026 benchmark leaderboard (§6.2) and in the §5.7 template
 * definitions but are NOT on the 33-tactic page. The corpus flags that as a genuine
 * source discrepancy, so they are carried separately rather than blended in: a caller
 * that wants only the canonical taxonomy can slice on CANONICAL_HOOK_TACTIC_COUNT.
 */
const HOOK_TACTIC_TABLE = [
  ['aspirational', 'asp'],
  ['authority', 'aut'],
  ['belief', 'bel'],
  ['bold_claim', 'bcl'],
  ['call_to_action_first', 'ctaf'],
  ['challenge', 'chl'],
  ['confession', 'cnf'],
  ['contrast', 'cst'],
  ['contrarian', 'ctr'],
  ['curiosity', 'cur'],
  ['demographic_callout', 'dco'],
  ['direct_address', 'dad'],
  ['directive', 'drv'],
  ['exclusivity', 'exc'],
  ['explainer', 'exp'],
  ['fomo', 'fom'],
  ['how_to', 'hto'],
  ['if_then', 'ift'],
  ['listicle', 'lst'],
  ['myth_busting', 'myb'],
  ['offer_only', 'ofo'],
  ['price_anchor', 'pra'],
  ['question', 'qst'],
  ['reasons_why', 'rwy'],
  ['relatability', 'rel'],
  ['reverse_psychology', 'rps'],
  ['risk_reversal', 'rrv'],
  ['shocking_statement', 'shk'],
  ['social_proof', 'spr'],
  ['statistic', 'sta'],
  ['storytelling', 'sty'],
  ['urgency', 'urg'],
  ['warning', 'wrn'],
  // --- leaderboard-only, absent from the 33-tactic page: [UNVERIFIED] as taxonomy members
  ['newness', 'nws'],
  ['sale_announcement', 'sal'],
  ['announcement', 'ann'],
  ['new_product_announcement', 'npa'],
  ['product_announcement', 'pan'],
  ['event_announcement', 'eva'],
  ['giveaway', 'giv'],
  ['wordplay', 'wpl'],
  ['us_vs_them', 'uvt'],
] as const;
export type HookTactic = (typeof HOOK_TACTIC_TABLE)[number][0];
const HOOK_TACTIC = buildCodec('hookTactic', HOOK_TACTIC_TABLE);
export const HOOK_TACTICS: readonly HookTactic[] = HOOK_TACTIC.values;
/** Everything below this index is from the published 33-value enum; above it is §6.2-only. */
export const CANONICAL_HOOK_TACTIC_COUNT = 33;

export type HookTacticCluster = 'promotional' | 'interrupt' | 'unclustered';

/**
 * §6.2's two-cluster model — the useful abstraction over the leaderboard.
 *
 * Promotional tactics posted both a high hit rate and a high spend-use ratio in a window
 * that spanned BFCM, and the report says so itself: their advantage is seasonally
 * inflated. Interrupt tactics are lower hit rate but higher variance and season-stable.
 * A greedy bandit will starve the interrupt cluster, which is why the floor below exists.
 */
export const HOOK_TACTIC_CLUSTER: Readonly<Record<HookTactic, HookTacticCluster>> = (() => {
  // Exactly the nine §6.2 names the promotional row lists, and no more. `announcement`,
  // `product_announcement` and `exclusivity` sit high on the leaderboard but the report
  // does not put them in either cluster, and cluster membership is not cosmetic: it is
  // what INTERRUPT_EXPLORATION_FLOOR is defined against and what a seasonality rule keys
  // off. Guessing a member in either direction moves weekly launch budget.
  const promotional: readonly HookTactic[] = [
    'newness', 'sale_announcement', 'price_anchor', 'urgency', 'offer_only', 'fomo',
    'new_product_announcement', 'event_announcement', 'giveaway',
  ];
  const interrupt: readonly HookTactic[] = [
    'confession', 'contrarian', 'shocking_statement', 'reverse_psychology', 'warning',
    'myth_busting', 'bold_claim',
  ];
  const out = {} as Record<HookTactic, HookTacticCluster>;
  for (const t of HOOK_TACTICS) out[t] = 'unclustered';
  for (const t of promotional) out[t] = 'promotional';
  for (const t of interrupt) out[t] = 'interrupt';
  return out;
})();

/**
 * Non-negotiable share of weekly launches reserved for the interrupt cluster.
 *
 * §6.2 gives the range as 20–30% and the reasoning as variance, not as a hedge: interrupt
 * tactics "when they connect, tend to connect hard". The low end is taken so the floor is
 * a floor. [INFERRED] within the stated range.
 */
export const INTERRUPT_EXPLORATION_FLOOR = 0.2;

/** The 8 psychological triggers (§3.6) — the emotional mechanism inside the frame. */
const PSYCH_TRIGGER_TABLE = [
  ['pattern_interrupt', 'pi'],
  ['identity_callout', 'ic'],
  ['pain_agitation', 'pa'],
  ['curiosity_gap', 'cg'],
  ['social_proof', 'sp'],
  ['contrarian', 'co'],
  ['aspiration', 'ax'],
  ['urgency_stakes', 'us'],
] as const;
export type PsychTrigger = (typeof PSYCH_TRIGGER_TABLE)[number][0];
const PSYCH_TRIGGER = buildCodec('psychTrigger', PSYCH_TRIGGER_TABLE);
export const PSYCH_TRIGGERS: readonly PsychTrigger[] = PSYCH_TRIGGER.values;

/** Occupies the secondary-trigger slot when a hook runs on one trigger only. */
const NO_SECONDARY_TRIGGER_CODE = 'xx';
if (PSYCH_TRIGGER.value(NO_SECONDARY_TRIGGER_CODE) !== undefined) {
  throw new GenomeError('secondaryTrigger', `sentinel "${NO_SECONDARY_TRIGGER_CODE}" collides with a real trigger code.`);
}

// ---------------------------------------------------------------------------
// Execution layer
// ---------------------------------------------------------------------------

/**
 * The ten canonical templates of §5.7 — the shapes a generator can actually produce.
 *
 * This is deliberately NOT Motion's 113-value `visual_format` taxonomy. That taxonomy is
 * for TAGGING ads someone else made; these ten are the ones §5.7 parameterises into beat
 * tables with validators, i.e. the ones this system can generate and check. Each spec
 * below records which visual_format it renders as, so the two vocabularies can be joined
 * against published per-format benchmarks later.
 *
 * Carousel and Celebrity are absent on purpose (§5.7 closing note): carousel is last on
 * both leaderboards, and a synthetic celebrity likeness is a right-of-publicity claim
 * plus an EU AI Act disclosure obligation.
 */
const TEMPLATE_TABLE = [
  ['talking_head_testimonial', 'tht'],
  ['problem_solution_demo', 'psd'],
  ['unboxing', 'unb'],
  ['before_after', 'bfa'],
  ['listicle', 'lsi'],
  ['founder_story', 'fnd'],
  ['social_proof_stack', 'sps'],
  ['offer_led', 'ofl'],
  ['comparison', 'cmp'],
  ['day_in_the_life', 'dil'],
] as const;
export type CreativeTemplate = (typeof TEMPLATE_TABLE)[number][0];
const TEMPLATE = buildCodec('template', TEMPLATE_TABLE);
export const CREATIVE_TEMPLATES: readonly CreativeTemplate[] = TEMPLATE.values;

/**
 * Asset type = the medium and production tier (§5.4), 15 values, ordered by the 2026
 * hit-rate leaderboard. The order is load-bearing documentation, not just aesthetics:
 * the top of this list is text-forward and UGC-forward, NOT high production, which is
 * directly contrary to the premise of a video-generation platform. Stage 1 discovery
 * belongs at the top of this list; expensive video is a stage-2 upgrade for an angle
 * that already proved out.
 */
const ASSET_TYPE_TABLE = [
  ['text_only', 'txt'],
  ['product_image_with_text', 'pit'],
  ['lifestyle_product_image', 'lpi'],
  ['ugc', 'ugc'],
  ['high_production', 'hip'],
  ['gif', 'gif'],
  ['illustration', 'ill'],
  ['ugc_mashup', 'ugm'],
  ['lifestyle_product_image_with_text', 'lpt'],
  ['lifestyle_image_with_text', 'lit'],
  ['lifestyle_image', 'lif'],
  ['hybrid', 'hyb'],
  ['product_image', 'pim'],
  ['animation', 'ani'],
  ['carousel', 'car'],
] as const;
export type AssetType = (typeof ASSET_TYPE_TABLE)[number][0];
const ASSET_TYPE = buildCodec('assetType', ASSET_TYPE_TABLE);
export const ASSET_TYPES: readonly AssetType[] = ASSET_TYPE.values;

/**
 * Asset types that cannot carry a person on screen.
 *
 * Setting a spokesperson on one of these is the canonical incoherent combination: the
 * regression would then attribute a text-only ad's result to "customer spokesperson".
 */
const PERSONLESS_ASSET_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
  'text_only', 'product_image', 'product_image_with_text', 'illustration', 'animation',
]);

const SPOKESPERSON_TABLE = [
  ['none', 'non'],
  ['customer', 'cus'],
  ['founder', 'fou'],
  ['expert', 'xpr'],
  ['celebrity', 'cel'],
  ['influencer', 'inf'],
  ['synthetic', 'syn'],
] as const;
export type SpokespersonType = (typeof SPOKESPERSON_TABLE)[number][0];
const SPOKESPERSON = buildCodec('spokespersonType', SPOKESPERSON_TABLE);
export const SPOKESPERSON_TYPES: readonly SpokespersonType[] = SPOKESPERSON.values;

/**
 * Cut density, bucketed. §4.5 carries it as `pacing_cuts_per_10s`; a raw count is not a
 * categorical you can regress on at this sample size, so it is bucketed here and the
 * raw number belongs in provenance.
 *
 * Bands (cuts per 10s): static 0 · slow 1–2 · moderate 3–5 · fast 6–9 · rapid 10+.
 */
const PACING_TABLE = [
  ['static', 'stt'],
  ['slow', 'slw'],
  ['moderate', 'mod'],
  ['fast', 'fst'],
  ['rapid', 'rpd'],
] as const;
export type Pacing = (typeof PACING_TABLE)[number][0];
const PACING = buildCodec('pacing', PACING_TABLE);
export const PACINGS: readonly Pacing[] = PACING.values;

/** Cuts-per-10s → bucket. Kept beside the bands so the two cannot drift. */
export function pacingForCutsPer10s(cuts: number): Pacing {
  if (!Number.isFinite(cuts) || cuts < 0) {
    throw new GenomeError('pacing', `cuts per 10s must be a finite non-negative number, got ${cuts}.`);
  }
  if (cuts === 0) return 'static';
  if (cuts <= 2) return 'slow';
  if (cuts <= 5) return 'moderate';
  if (cuts <= 9) return 'fast';
  return 'rapid';
}

/**
 * §4.5 gives the shape as `burned_in_* | none | platform_auto` and names
 * `burned_in_word_by_word` as its example. The three burned-in variants below are
 * [INFERRED] — a plausible bucketing of `burned_in_*`, not a published enum.
 */
const CAPTION_STYLE_TABLE = [
  ['none', 'non'],
  ['platform_auto', 'pau'],
  ['burned_in_static', 'bis'],
  ['burned_in_word_by_word', 'bww'],
  ['burned_in_karaoke', 'bka'],
] as const;
export type CaptionStyle = (typeof CAPTION_STYLE_TABLE)[number][0];
const CAPTION_STYLE = buildCodec('captionStyle', CAPTION_STYLE_TABLE);
export const CAPTION_STYLES: readonly CaptionStyle[] = CAPTION_STYLE.values;

/** Caption styles that only exist in motion — meaningless on a static. */
const MOTION_ONLY_CAPTION_STYLES: ReadonlySet<CaptionStyle> = new Set<CaptionStyle>([
  'platform_auto', 'burned_in_word_by_word', 'burned_in_karaoke',
]);

const ASPECT_RATIO_TABLE = [
  ['9:16', '9x16'],
  ['4:5', '4x5'],
  ['1:1', '1x1'],
  ['16:9', '16x9'],
] as const;
export type AspectRatio = (typeof ASPECT_RATIO_TABLE)[number][0];
const ASPECT_RATIO = buildCodec('aspectRatio', ASPECT_RATIO_TABLE);
export const ASPECT_RATIOS: readonly AspectRatio[] = ASPECT_RATIO.values;

/**
 * Duration buckets from the §5.6 per-format table.
 *
 * §5.6 resolves a real contradiction in the corpus: the "5–15 s" folklore is awareness
 * guidance, and DR video on Meta routinely runs 30–60 s with VSL beyond that. Duration is
 * therefore a per-format parameter with a range, never a global constant — which is why
 * each TEMPLATE_SPECS entry carries its own allowed buckets.
 */
const DURATION_BUCKET_TABLE = [
  ['static', 'd0'],
  ['s3_8', 'd38'],
  ['s6_15', 'd615'],
  ['s15_30', 'd1530'],
  ['s30_60', 'd3060'],
  ['s60_plus', 'd60p'],
] as const;
export type DurationBucket = (typeof DURATION_BUCKET_TABLE)[number][0];
const DURATION_BUCKET = buildCodec('durationBucket', DURATION_BUCKET_TABLE);
export const DURATION_BUCKETS: readonly DurationBucket[] = DURATION_BUCKET.values;

/**
 * Seconds → bucket. Boundaries overlap in §5.6's own table (3–8, 6–15), so the lower
 * bucket wins at a shared edge and the choice is made here once rather than at each
 * call site.
 */
export function durationBucketForSeconds(seconds: number): DurationBucket {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new GenomeError('durationBucket', `duration must be a finite non-negative number of seconds, got ${seconds}.`);
  }
  if (seconds === 0) return 'static';
  if (seconds <= 8) return 's3_8';
  if (seconds <= 15) return 's6_15';
  if (seconds <= 30) return 's15_30';
  if (seconds <= 60) return 's30_60';
  return 's60_plus';
}

/**
 * `meta_sound_collection` is separated from `library` because it is the only option with
 * a licence Meta itself grants — a policy fact, not a creative one.
 */
const MUSIC_PRESENCE_TABLE = [
  ['none', 'non'],
  ['library', 'lib'],
  ['meta_sound_collection', 'msc'],
  ['generated', 'gen'],
  ['trending', 'trd'],
] as const;
export type MusicPresence = (typeof MUSIC_PRESENCE_TABLE)[number][0];
const MUSIC_PRESENCE = buildCodec('musicPresence', MUSIC_PRESENCE_TABLE);
export const MUSIC_PRESENCES: readonly MusicPresence[] = MUSIC_PRESENCE.values;

/**
 * Dominant colour as a family, not a hex.
 *
 * §4.5 carries raw hexes; a hex is not a level you can regress on — every creative would
 * be its own category. The raw palette belongs in provenance; this is the regressable
 * projection of it.
 */
const DOMINANT_COLOUR_TABLE = [
  ['mono_dark', 'mdk'],
  ['mono_light', 'mlt'],
  ['red', 'red'],
  ['orange', 'org'],
  ['yellow', 'yel'],
  ['green', 'grn'],
  ['teal', 'tea'],
  ['blue', 'blu'],
  ['purple', 'pur'],
  ['pink', 'pnk'],
  ['earth_neutral', 'ert'],
  ['multi_vivid', 'mvd'],
] as const;
export type DominantColour = (typeof DOMINANT_COLOUR_TABLE)[number][0];
const DOMINANT_COLOUR = buildCodec('dominantColour', DOMINANT_COLOUR_TABLE);
export const DOMINANT_COLOURS: readonly DominantColour[] = DOMINANT_COLOUR.values;

/** §4.5's `emotion_target`: the felt arc, distinct from the trigger that opens it. */
const EMOTIONAL_REGISTER_TABLE = [
  ['calm_reassuring', 'clm'],
  ['urgent', 'urg'],
  ['playful_humorous', 'ply'],
  ['earnest_sincere', 'ern'],
  ['authoritative', 'ath'],
  ['aspirational', 'asr'],
  ['frustration_to_relief', 'f2r'],
  ['shock_alarm', 'shk'],
  ['warm_nostalgic', 'wnm'],
  ['deadpan_dry', 'ddp'],
] as const;
export type EmotionalRegister = (typeof EMOTIONAL_REGISTER_TABLE)[number][0];
const EMOTIONAL_REGISTER = buildCodec('emotionalRegister', EMOTIONAL_REGISTER_TABLE);
export const EMOTIONAL_REGISTERS: readonly EmotionalRegister[] = EMOTIONAL_REGISTER.values;

// ---------------------------------------------------------------------------
// Commercial layer
// ---------------------------------------------------------------------------

/**
 * Offer type is the highest-leverage lever in the whole vector.
 *
 * §10.2 ranks it #1 in test order — cheapest to change (no asset regeneration), largest
 * swing — and a creative-centric system misses it because it looks like a campaign input
 * rather than a variable. It is a variable.
 */
const OFFER_TYPE_TABLE = [
  ['none', 'non'],
  ['promo', 'pro'],
  ['evergreen', 'evg'],
  ['bundle', 'bnd'],
  ['gift_with_purchase', 'gwp'],
  ['free_trial', 'ftr'],
  ['guarantee', 'grt'],
  // §4.5 publishes seven values (promo|evergreen|bundle|gwp|free_trial|guarantee|none).
  // `financing` is [INFERRED] — a real DR offer shape for mid-to-high ticket, but not on
  // the published list. Appending is safe for the codec; it is flagged so a caller does
  // not read the whole dimension as sourced.
  ['financing', 'fin'],
] as const;
export type OfferType = (typeof OFFER_TYPE_TABLE)[number][0];
const OFFER_TYPE = buildCodec('offerType', OFFER_TYPE_TABLE);
export const OFFER_TYPES: readonly OfferType[] = OFFER_TYPE.values;

/** Hook tactics whose entire content IS the offer — generating one without an offer is a lie. */
const OFFER_BEARING_TACTICS: ReadonlySet<HookTactic> = new Set<HookTactic>([
  'offer_only', 'sale_announcement', 'giveaway',
]);

/**
 * The CTA subset the genome regresses over.
 *
 * Deliberately frozen here rather than derived from `publish.SAFE_CALL_TO_ACTIONS`: that
 * map is another module's to change, and a change to it would silently reshape this
 * module's feature space and invalidate stored bandit coefficients. Typing it against
 * `CallToActionType` still means a CTA Meta drops from its enum fails the typecheck,
 * which is the coupling we want — compile-time, not runtime.
 */
const CTA_TABLE = [
  ['LEARN_MORE', 'lm'],
  ['SHOP_NOW', 'shn'],
  ['BUY_NOW', 'byn'],
  ['ORDER_NOW', 'orn'],
  ['ADD_TO_CART', 'atc'],
  ['GET_OFFER', 'gof'],
  ['SIGN_UP', 'sgu'],
  ['SUBSCRIBE', 'sub'],
  ['APPLY_NOW', 'apn'],
  ['GET_QUOTE', 'gqt'],
  ['CONTACT_US', 'cnu'],
  ['BOOK_NOW', 'bkn'],
  ['DOWNLOAD', 'dwn'],
  ['WATCH_MORE', 'wmr'],
  ['NO_BUTTON', 'nob'],
  ['LIKE_PAGE', 'lkp'],
  ['MESSAGE_PAGE', 'msp'],
  ['WHATSAPP_MESSAGE', 'wap'],
  ['INSTALL_APP', 'ina'],
  ['USE_APP', 'usa'],
  ['PLAY_GAME', 'plg'],
  ['GET_STARTED', 'gst'],
] as const satisfies readonly (readonly [CallToActionType, string])[];
export type GenomeCta = (typeof CTA_TABLE)[number][0];
const CTA = buildCodec('cta', CTA_TABLE);
export const GENOME_CTAS: readonly GenomeCta[] = CTA.values;

// ---------------------------------------------------------------------------
// The vector
// ---------------------------------------------------------------------------

/**
 * One creative's attribute vector.
 *
 * Every field is a level of a categorical the optimiser can regress on. Anything
 * continuous, free-text, or per-creative unique (hexes, seeds, prompt hashes, script
 * text, review ids) belongs in provenance, not here — it would be a category of one.
 *
 * The strategy layer above this (pain, persona) hangs off the Angle, which is why only
 * `angleId` appears: the angle is the entity, not an attribute.
 */
export interface CreativeGenome {
  /** The Angle this creative expresses. Slug; appears verbatim in the ad name. */
  angleId: string;
  awarenessStage: AwarenessStage;
  mechanic: CreativeMechanic;
  hookTactic: HookTactic;
  primaryTrigger: PsychTrigger;
  /** §3.6: "the best ones combine two". Omitted when the hook runs on one. */
  secondaryTrigger?: PsychTrigger;
  template: CreativeTemplate;
  assetType: AssetType;
  spokespersonType: SpokespersonType;
  pacing: Pacing;
  captionStyle: CaptionStyle;
  aspectRatio: AspectRatio;
  durationBucket: DurationBucket;
  musicPresence: MusicPresence;
  dominantColour: DominantColour;
  emotionalRegister: EmotionalRegister;
  offerType: OfferType;
  cta: GenomeCta;
}

// ---------------------------------------------------------------------------
// Template specifications — §5.7, machine-readable
// ---------------------------------------------------------------------------

export interface TemplateSpec {
  template: CreativeTemplate;
  /** The Motion `visual_format` slug this renders as, for joining to published benchmarks. */
  visualFormat: string;
  /** §5.7 `awareness_fit`. Preference, not a gate — §5.3's escape hatch applies. */
  awarenessFit: readonly AwarenessStage[];
  /**
   * The published funnel placement of the FORMAT (§5.3/§5.7), which is not the same
   * question as `funnelStageFor(awarenessFit)` — that one places the AUDIENCE.
   *
   * The two genuinely diverge in the corpus and both are quoted rather than reconciled:
   * Before & After is listed under MOF in §5.3's funnel table while §5.7 gives it a
   * `product_aware` fit, and Testimonial is "MOF-BOF" against a `product_aware`/
   * `most_aware` fit. Deriving one from the other would silently overwrite a published
   * fact with an inference.
   */
  funnel: readonly FunnelStage[];
  mechanics: readonly CreativeMechanic[];
  hookTactics: readonly HookTactic[];
  /** When present, the template is DEFINED by who is on camera; anything else is incoherent. */
  spokespersons?: readonly SpokespersonType[];
  /** A person must be on camera for the template to exist at all. */
  requiresPerson: boolean;
  /**
   * A synthetic presenter here is a fabricated testimonial under the FTC Reviews &
   * Testimonials Rule (§5.7 T1/T4/T7 validators, §8.4) — a hard block, not a warning.
   */
  forbidsSynthetic: boolean;
  /** §5.7 T8's explicit gate: "do NOT generate when offer_type == none". */
  requiresOffer: boolean;
  durationBuckets: readonly DurationBucket[];
  defaultAssetType: AssetType;
  /** §5.7 T4: before/after carries the highest rejection and legal risk of the ten. */
  humanReviewRequired: boolean;
  note: string;
}

export const TEMPLATE_SPECS: Readonly<Record<CreativeTemplate, TemplateSpec>> = {
  talking_head_testimonial: {
    template: 'talking_head_testimonial',
    visualFormat: 'testimonial',
    awarenessFit: ['product_aware', 'most_aware'],
    funnel: ['MOF', 'BOF'],
    mechanics: ['social_witness', 'reframe'],
    hookTactics: ['confession', 'social_proof', 'relatability'],
    // §5.7 T1 states `spokesperson: customer` only. `influencer` is [INFERRED] — the
    // taxonomy files Influencer Endorsement as its own visual_format (§5.5), so a
    // licensed creator reading a testimonial is arguably that format rather than this
    // one. Kept because the beat table works identically; drop it if the join to the
    // published testimonial row ever matters more than buildability.
    spokespersons: ['customer', 'influencer'],
    requiresPerson: true,
    forbidsSynthetic: true,
    requiresOffer: false,
    durationBuckets: ['s15_30', 's30_60'],
    defaultAssetType: 'ugc',
    humanReviewRequired: false,
    note: 'Workhorse, not a breakout: 6.5% hit rate, 13.3% of creative, SUR 1.0.',
  },
  problem_solution_demo: {
    template: 'problem_solution_demo',
    // §5.7 T2 writes this as the sequence `problem_agitation` -> `demo`. Only the second
    // is the format the 8.1% row is measured on, and this field exists to JOIN against
    // those published rows, so it carries the joinable slug and the note carries the
    // lead-in. A composite string would join to nothing and fail silently.
    visualFormat: 'demo',
    awarenessFit: ['problem_aware', 'solution_aware'],
    funnel: ['MOF'],
    mechanics: ['contrast_without_comment', 'borrowed_enemy'],
    hookTactics: ['shocking_statement', 'explainer', 'if_then'],
    requiresPerson: false,
    forbidsSynthetic: false,
    requiresOffer: false,
    durationBuckets: ['s15_30', 's30_60'],
    defaultAssetType: 'ugc',
    humanReviewRequired: false,
    note: 'Opens on a problem_agitation beat, then Demo: 8.1% hit rate, SUR 1.0; the two co-occur 19% of the time.',
  },
  unboxing: {
    template: 'unboxing',
    visualFormat: 'unboxing',
    awarenessFit: ['product_aware', 'most_aware'],
    funnel: ['BOF'],
    mechanics: ['implied_answer', 'this_and_a'],
    hookTactics: ['newness', 'curiosity', 'exclusivity'],
    requiresPerson: false,
    forbidsSynthetic: false,
    requiresOffer: false,
    durationBuckets: ['s6_15'],
    defaultAssetType: 'ugc',
    humanReviewRequired: false,
    note: 'Highest single format hit rate (9.8%) on only 2.1% of volume — under-used, SUR 1.3.',
  },
  before_after: {
    template: 'before_after',
    visualFormat: 'before_and_after',
    awarenessFit: ['problem_aware', 'solution_aware', 'product_aware'],
    funnel: ['MOF'],
    mechanics: ['contrast_without_comment'],
    hookTactics: ['contrast', 'bold_claim', 'statistic'],
    requiresPerson: false,
    forbidsSynthetic: true,
    requiresOffer: false,
    durationBuckets: ['s6_15', 's15_30'],
    defaultAssetType: 'hybrid',
    humanReviewRequired: true,
    note: 'Meta restricts before/after for health, weight-loss and cosmetic outcomes; exact current wording is UNVERIFIED. Human review before publish.',
  },
  listicle: {
    template: 'listicle',
    visualFormat: 'listicle',
    awarenessFit: ['solution_aware', 'product_aware'],
    funnel: ['MOF'],
    mechanics: ['implied_answer'],
    hookTactics: ['listicle', 'reasons_why', 'directive'],
    requiresPerson: false,
    forbidsSynthetic: false,
    requiresOffer: false,
    durationBuckets: ['s15_30'],
    defaultAssetType: 'hybrid',
    humanReviewRequired: false,
    note: 'Three items outperforms five at DR lengths [INFERRED]; works in almost any vertical.',
  },
  founder_story: {
    template: 'founder_story',
    visualFormat: 'founder',
    awarenessFit: ['unaware', 'problem_aware', 'solution_aware'],
    funnel: ['TOF', 'MOF'],
    mechanics: ['reframe', 'borrowed_enemy'],
    hookTactics: ['confession', 'contrarian', 'belief', 'authority'],
    spokespersons: ['founder'],
    requiresPerson: true,
    forbidsSynthetic: true,
    requiresOffer: false,
    durationBuckets: ['s30_60'],
    defaultAssetType: 'ugc',
    humanReviewRequired: false,
    note: 'Strongly vertical-dependent: top-5 in Health & Wellness, absent from Fashion. Founder must be a real, identified person.',
  },
  social_proof_stack: {
    template: 'social_proof_stack',
    visualFormat: 'social_proof_mashup',
    awarenessFit: ['product_aware', 'most_aware'],
    funnel: ['BOF'],
    mechanics: ['social_witness'],
    hookTactics: ['social_proof', 'statistic', 'authority'],
    requiresPerson: false,
    forbidsSynthetic: true,
    requiresOffer: false,
    durationBuckets: ['s6_15', 's15_30'],
    defaultAssetType: 'hybrid',
    humanReviewRequired: false,
    note: 'Every quote must map to a real, retrievable review id in provenance — fabricated reviews sit squarely inside the FTC rule.',
  },
  offer_led: {
    template: 'offer_led',
    visualFormat: 'offer_first_banner',
    awarenessFit: ['most_aware'],
    funnel: ['BOF'],
    mechanics: ['this_and_a'],
    hookTactics: ['offer_only', 'sale_announcement', 'price_anchor', 'urgency', 'fomo'],
    requiresPerson: false,
    forbidsSynthetic: false,
    requiresOffer: true,
    durationBuckets: ['static', 's3_8'],
    defaultAssetType: 'product_image_with_text',
    humanReviewRequired: false,
    note: 'Volume and performance leader (8.6% hit rate, 29.3% of spend, SUR 1.3) and the most seasonally inflated — do not default to it outside a promotional window.',
  },
  comparison: {
    template: 'comparison',
    visualFormat: 'us_vs_them',
    awarenessFit: ['solution_aware', 'product_aware'],
    funnel: ['MOF', 'BOF'],
    mechanics: ['contrast_without_comment', 'borrowed_enemy'],
    hookTactics: ['contrast', 'us_vs_them', 'myth_busting', 'price_anchor'],
    requiresPerson: false,
    forbidsSynthetic: false,
    requiresOffer: false,
    durationBuckets: ['s15_30'],
    defaultAssetType: 'hybrid',
    humanReviewRequired: false,
    note: 'Compare against a category or practice, never a named brand or recognisable trade dress.',
  },
  day_in_the_life: {
    template: 'day_in_the_life',
    visualFormat: 'pov',
    awarenessFit: ['unaware', 'problem_aware'],
    funnel: ['TOF'],
    mechanics: ['trojan_horse'],
    hookTactics: ['relatability', 'demographic_callout', 'curiosity', 'storytelling'],
    requiresPerson: true,
    forbidsSynthetic: false,
    requiresOffer: false,
    durationBuckets: ['s30_60'],
    defaultAssetType: 'ugc',
    humanReviewRequired: false,
    note: 'The Trojan Horse mechanic’s natural vessel: no product noun before 0.8 x duration.',
  },
};

// ---------------------------------------------------------------------------
// Angle — a first-class entity
// ---------------------------------------------------------------------------

export const ANGLE_STATUSES = ['proposed', 'testing', 'proven', 'retired'] as const;
export type AngleStatus = (typeof ANGLE_STATUSES)[number];

export type AnchorType = 'pain' | 'desire';

/**
 * A messaging angle: the core truth at one pain × persona intersection (§10.4).
 *
 * This exists as an entity rather than a string because it is the layer Meta has never
 * claimed and structurally cannot measure — it does not know your angles exist. Per-angle
 * attribution is therefore a reporting asset Meta cannot replicate, and the bandit runs
 * over angles as arms, not over rendered files.
 */
export interface Angle {
  /** Slug, stable for the life of the angle; embedded in every ad name beneath it. */
  id: string;
  brandId: string;
  /** The angle itself. Conversational, <=10 words, un-branded: "Your wallet sucks". */
  statement: string;
  anchorType: AnchorType;
  /** The pain or desire bucket this sits under. Free identifier; the planner owns it. */
  painOrDesireId: string;
  personaId: string;
  /** What we believe and — crucially — what result would tell us we were wrong. */
  hypothesis: string;
  status: AngleStatus;
  createdAtIso: string;
}

/**
 * Length ceiling for an angle id.
 *
 * The id is the only variable-length part of the encoded vector, so it is the part that
 * has to be bounded for an ad name to be predictably safe. 24 leaves generous headroom
 * under the ad-name budget even for long brand and archetype slugs.
 */
export const ANGLE_ID_MAX_LENGTH = 24;
const ANGLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** §10.4: "conversational, human statement… Not marketing copy. Not a tagline." */
export const ANGLE_STATEMENT_MAX_WORDS = 10;

/**
 * Checks a machine cannot run, listed so they are not silently skipped.
 *
 * §10.4's Out-Loud Test is the load-bearing one and it needs a human or a model with a
 * voice, not a regex. Surfacing the list beats pretending validateAngle is complete.
 */
export const ANGLE_MANUAL_CHECKS: readonly string[] = [
  'Out-Loud Test: read it aloud — if it sounds like an ad, it is not an angle.',
  'It must be a claim about the reader’s world, not a claim about the product.',
  'It must be language a real person would actually say or think.',
];

/**
 * Whole-word, case-insensitive containment.
 *
 * A plain substring test refuses "You shouldn't need a power washer" for a brand called
 * "Ash", and a false refusal here silently shrinks the angle supply — the one input the
 * whole system is short of. Boundaries are non-word characters, so "Ridge-style" and
 * "Acme's" still match their term.
 */
function containsWord(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function assertAngleId(id: string): void {
  if (!ANGLE_ID_RE.test(id)) {
    throw new GenomeError('angleId', `"${id}" is not a lowercase slug; the angle id is embedded verbatim in every ad name and must stay stable and parseable.`);
  }
  if (id.length > ANGLE_ID_MAX_LENGTH) {
    throw new GenomeError('angleId', `"${id}" is ${id.length} chars; the ceiling is ${ANGLE_ID_MAX_LENGTH} because the angle id is the only variable-length part of the encoded genome in a Meta ad name.`);
  }
}

/**
 * Validates a generated angle against §10.4.
 *
 * `brandTerms` are the brand and product names that must NOT appear: the published
 * bad/good contrast is "Professional-grade natural healing without prescription side
 * effects" versus "Your dermatologist wrecked your skin", and the difference is that the
 * good one never mentions the seller.
 */
export function validateAngle(angle: Angle, opts?: { brandTerms?: readonly string[] }): ValidationResult {
  const errors: GenomeIssue[] = [];
  const warnings: GenomeIssue[] = [];

  if (!ANGLE_ID_RE.test(angle.id)) {
    errors.push(issue('angle_id_shape', 'id', `"${angle.id}" is not a lowercase slug.`));
  } else if (angle.id.length > ANGLE_ID_MAX_LENGTH) {
    errors.push(issue('angle_id_length', 'id', `"${angle.id}" is ${angle.id.length} chars, ceiling ${ANGLE_ID_MAX_LENGTH}.`));
  }

  const statement = angle.statement.trim();
  if (statement.length === 0) {
    errors.push(issue('angle_statement_empty', 'statement', 'An angle with no statement is a label, not an angle.'));
  } else {
    const words = statement.split(/\s+/);
    if (words.length > ANGLE_STATEMENT_MAX_WORDS) {
      errors.push(issue(
        'angle_statement_too_long',
        'statement',
        `${words.length} words; the ceiling is ${ANGLE_STATEMENT_MAX_WORDS}. An angle is a core truth ("Your wallet sucks"), not marketing copy.`,
      ));
    }
    for (const term of opts?.brandTerms ?? []) {
      const t = term.trim();
      if (t.length > 0 && containsWord(statement, t)) {
        errors.push(issue(
          'angle_names_brand',
          'statement',
          `contains the brand/product term "${term}". An angle is a claim about the reader’s world; naming the seller turns it into a tagline.`,
        ));
      }
    }
    if (/[!]$/.test(statement)) {
      warnings.push(issue('angle_reads_as_slogan', 'statement', 'Ends in an exclamation mark — reads as a slogan rather than something a person would say.'));
    }
  }

  if (angle.hypothesis.trim().length === 0) {
    errors.push(issue(
      'angle_no_hypothesis',
      'hypothesis',
      'An angle without a hypothesis cannot be falsified, so its performance record teaches nothing.',
    ));
  }

  if (angle.brandId.trim().length === 0) {
    errors.push(issue('angle_no_brand', 'brandId', 'Angles are per-brand; a global angle would pool learnings across brands that do not share an audience.'));
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Angle performance record
// ---------------------------------------------------------------------------

/**
 * The angle's measured record over one window.
 *
 * Both §4.4 axes are stored because they answer different questions: hit rate is "how
 * often does this produce an outlier", spend-use ratio is "given how much I used it, was
 * it worth it". SUR is the correct exploration signal for a bandit precisely because it
 * is already normalised by usage.
 */
export interface AnglePerformance {
  angleId: string;
  /** Creatives launched under this angle that accrued spend in the window. */
  creativesWithSpend: number;
  /** §1.3's definition: `spend / account_median_creative_spend >= 10` AND `spend >= $500`. */
  winners: number;
  midRange: number;
  /** Killed before day 28. */
  losers: number;
  spendUsd: number;
  /** Account totals over the SAME window — the SUR denominators. */
  accountCreativesWithSpend: number;
  accountSpendUsd: number;
  windowStartIso: string;
  windowEndIso: string;
}

/**
 * Reference hit rate, used only as a high/low threshold.
 *
 * §6.2 quotes the tier averages as a "4–8%" band; §1.2's own table actually runs 4.0
 * (micro) to 8.8 (enterprise). 0.08 is the top of the quoted band. The corpus publishes
 * bands, never a threshold, so this is [INFERRED] and is a knob, not a finding.
 */
export const HIT_RATE_REFERENCE = 0.08;
/** SUR 1.0 is "performs as expected" by definition (§4.4). */
export const SPEND_USE_RATIO_REFERENCE = 1.0;

/**
 * Minimum creatives before a per-angle estimate is worth acting on.
 *
 * §4.6 trap 2: the benchmark authors suppress any segment under 50 ACCOUNTS, and inside a
 * single account you will never have 50 accounts, so per-angle estimates stay noisy for a
 * long time. 10 is the floor at which Motion's own tagging system will even run on an
 * account, borrowed here as an equally arbitrary but at least published number. Below it
 * `classifyAngle` refuses rather than guessing. [INFERRED]
 */
export const MIN_CREATIVES_FOR_ANGLE_CLASSIFICATION = 10;

/**
 * Refuses a record that cannot describe a real window.
 *
 * These are not defensive paranoia: every one of them, left unchecked, produces a
 * plausible-looking number that classifyAngle turns into a budget decision. `winners`
 * above `creativesWithSpend` yields a hit rate over 1 and promotes a broken angle to
 * `safest_bet`; an angle spending more than its account does yields an SUR that promotes
 * it the same way. Both are silent, and both allocate money against a lie.
 *
 * Note what is deliberately NOT asserted: winners + midRange + losers === creativesWithSpend.
 * §1.1 classifies a loser as killed before day 28 and a mid-range as >=28 days and never
 * a winner, so a creative that is 5 days old is none of the three yet. A window mid-flight
 * legitimately under-sums, and refusing that would be a loud false refusal.
 */
function assertCoherentPerformance(p: AnglePerformance): void {
  const counts: readonly (readonly [string, number])[] = [
    ['creativesWithSpend', p.creativesWithSpend],
    ['winners', p.winners],
    ['midRange', p.midRange],
    ['losers', p.losers],
    ['accountCreativesWithSpend', p.accountCreativesWithSpend],
  ];
  for (const [field, n] of counts) {
    if (!Number.isInteger(n) || n < 0) {
      throw new GenomeError(field, `angle "${p.angleId}": ${field} is ${n}; creative counts must be non-negative integers.`);
    }
  }
  for (const [field, n] of [['spendUsd', p.spendUsd], ['accountSpendUsd', p.accountSpendUsd]] as const) {
    if (!Number.isFinite(n) || n < 0) {
      throw new GenomeError(field, `angle "${p.angleId}": ${field} is ${n}; spend must be a finite non-negative amount.`);
    }
  }
  const classified = p.winners + p.midRange + p.losers;
  if (classified > p.creativesWithSpend) {
    throw new GenomeError(
      'creativesWithSpend',
      `angle "${p.angleId}": ${classified} creatives are classified (winners+midRange+losers) but only ${p.creativesWithSpend} accrued spend in ${p.windowStartIso}..${p.windowEndIso}. ` +
        'The window is mis-joined; a hit rate computed from it would be above its own denominator.',
    );
  }
  if (p.creativesWithSpend > p.accountCreativesWithSpend) {
    throw new GenomeError(
      'accountCreativesWithSpend',
      `angle "${p.angleId}": ${p.creativesWithSpend} angle creatives against ${p.accountCreativesWithSpend} account creatives. ` +
        'The angle is a subset of the account, so this is a mismatched window and every share computed from it is wrong.',
    );
  }
  if (p.spendUsd > p.accountSpendUsd) {
    throw new GenomeError(
      'accountSpendUsd',
      `angle "${p.angleId}": angle spend ${p.spendUsd} exceeds account spend ${p.accountSpendUsd} over ${p.windowStartIso}..${p.windowEndIso}. ` +
        'Mismatched windows or currencies; the spend-use ratio would over-promote this angle.',
    );
  }
}

export function hitRate(p: AnglePerformance): number {
  // The zero-denominator message is more specific than the coherence one, so it wins.
  if (p.creativesWithSpend <= 0) {
    throw new GenomeError('hitRate', `angle "${p.angleId}" has no creatives with spend in ${p.windowStartIso}..${p.windowEndIso}; a hit rate over zero creatives is not zero, it is unknown.`);
  }
  assertCoherentPerformance(p);
  return p.winners / p.creativesWithSpend;
}

/**
 * (share of spend) / (share of creative volume) — §4.4.
 *
 * >1 punches above its weight, ~1 performs as expected, <1 is overused relative to result.
 */
export function spendUseRatio(p: AnglePerformance): number {
  if (p.accountSpendUsd <= 0 || p.accountCreativesWithSpend <= 0) {
    throw new GenomeError('spendUseRatio', `angle "${p.angleId}" has no account-level denominator for ${p.windowStartIso}..${p.windowEndIso}; SUR is a share-of-share and cannot be computed without account totals.`);
  }
  if (p.creativesWithSpend <= 0) {
    throw new GenomeError('spendUseRatio', `angle "${p.angleId}" has no creatives with spend; its volume share is zero and the ratio is undefined.`);
  }
  assertCoherentPerformance(p);
  const spendShare = p.spendUsd / p.accountSpendUsd;
  const volumeShare = p.creativesWithSpend / p.accountCreativesWithSpend;
  return spendShare / volumeShare;
}

export type AngleClass =
  | 'insufficient_data'
  | 'safest_bet'
  | 'workhorse'
  | 'high_variance_bet'
  | 'stop_generating';

/**
 * §4.4's 2x2, which is the portfolio decision the bandit needs.
 *
 * Low hit rate + high SUR is NOT a loser — it is a high-variance bet that deserves a
 * small fixed slot the bandit must not starve. Collapsing the two axes into one score
 * would lose exactly that distinction, which is why both are kept.
 */
export function classifyAngle(p: AnglePerformance): AngleClass {
  // Coherence before the early return: a record that cannot be true must not be waved
  // through as "insufficient data" either, because that is also an allocation decision.
  assertCoherentPerformance(p);
  if (p.creativesWithSpend < MIN_CREATIVES_FOR_ANGLE_CLASSIFICATION) return 'insufficient_data';
  const highHit = hitRate(p) >= HIT_RATE_REFERENCE;
  const highSur = spendUseRatio(p) > SPEND_USE_RATIO_REFERENCE;
  if (highHit && highSur) return 'safest_bet';
  if (highHit) return 'workhorse';
  if (highSur) return 'high_variance_bet';
  return 'stop_generating';
}

// ---------------------------------------------------------------------------
// Angle variant space — the exhaustion half of the retirement rule
// ---------------------------------------------------------------------------

export interface VariantCell {
  template: CreativeTemplate;
  mechanic: CreativeMechanic;
  hookTactic: HookTactic;
}

/**
 * Every (template, mechanic, hook tactic) the ten specs actually endorse — 52 cells.
 *
 * This is "the angle's variant space" §11.4 means. The full cross product is ~50k cells
 * and coverage over it would never leave zero, which would make the rule inert; the
 * endorsed sub-tree is small enough to exhaust and is what a planner would generate from
 * anyway. Angle and awareness stage are deliberately NOT part of a cell: §11.3's
 * diversity tuple omits stage, and the space is per-angle by construction.
 *
 * §11.3's tuple also carries `asset_type`, which this cell does NOT. That is a deliberate
 * narrowing and it biases the rule one way: an angle can reach ANGLE_EXHAUSTION_COVERAGE
 * without ever having been tried at a different production tier, so shouldNotRetire is
 * the safer reading and a planner should exhaust §5.4's stage-1 tiers before believing
 * the coverage number. Adding asset type would multiply the space by 15 and make
 * exhaustion unreachable, which would make the retirement rule inert instead.
 */
export const ANGLE_VARIANT_SPACE: readonly VariantCell[] = (() => {
  const cells: VariantCell[] = [];
  for (const template of CREATIVE_TEMPLATES) {
    const spec = TEMPLATE_SPECS[template];
    for (const mechanic of spec.mechanics) {
      for (const hookTactic of spec.hookTactics) {
        cells.push({ template, mechanic, hookTactic });
      }
    }
  }
  return cells;
})();

function cellKey(c: VariantCell): string {
  return `${c.template}|${c.mechanic}|${c.hookTactic}`;
}

const VARIANT_SPACE_KEYS: ReadonlySet<string> = new Set(ANGLE_VARIANT_SPACE.map(cellKey));

/**
 * Fraction of the angle's endorsed variant space already launched.
 *
 * Genomes for other angles are ignored, and off-space combinations (legal, just not
 * endorsed by a template spec) do not inflate the numerator — otherwise an angle could
 * "exhaust" its space by launching cells that were never in it.
 */
export function angleVariantCoverage(angleId: string, launched: readonly CreativeGenome[]): number {
  const seen = new Set<string>();
  for (const g of launched) {
    if (g.angleId !== angleId) continue;
    const key = cellKey(g);
    if (VARIANT_SPACE_KEYS.has(key)) seen.add(key);
  }
  return seen.size / ANGLE_VARIANT_SPACE.length;
}

/** The cells still untried for this angle — what the planner should pick the next test from. */
export function unexploredVariants(angleId: string, launched: readonly CreativeGenome[]): readonly VariantCell[] {
  const seen = new Set<string>();
  for (const g of launched) {
    if (g.angleId === angleId) seen.add(cellKey(g));
  }
  return ANGLE_VARIANT_SPACE.filter((c) => !seen.has(cellKey(c)));
}

/** How much of the space must be spent before "exhausted" is credible. [INFERRED] — §11.4 gives no number. */
export const ANGLE_EXHAUSTION_COVERAGE = 0.8;

/**
 * §11.4's synthesised rule, verbatim in intent:
 *   `refresh = performance_decline_detected AND NOT iteration_space_exhausted`
 * inverted — retire the ANGLE only once its sub-tree has been explored AND is declining.
 *
 * The two failure modes this exists to prevent are both natural to an unattended system:
 * never rotating, and rotating on a cron. Elapsed time is not an input here on purpose.
 */
export function shouldRetireAngle(input: { performanceDeclining: boolean; coverage: number }): boolean {
  return input.performanceDeclining && input.coverage >= ANGLE_EXHAUSTION_COVERAGE;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Rejects incoherent vectors and flags off-book ones.
 *
 * The error/warning split follows the corpus: structural impossibilities and legal
 * hard-blocks are errors; §5.3's "any format can work at any stage if the messaging is
 * right" makes fit mismatches warnings. A system that refused every off-book combination
 * would never discover anything, which is the opposite of the point.
 */
export function validateGenome(g: CreativeGenome): ValidationResult {
  const errors: GenomeIssue[] = [];
  const warnings: GenomeIssue[] = [];
  const spec = TEMPLATE_SPECS[g.template];

  if (!ANGLE_ID_RE.test(g.angleId)) {
    errors.push(issue('angle_id_shape', 'angleId', `"${g.angleId}" is not a lowercase slug; it is embedded verbatim in the ad name.`));
  } else if (g.angleId.length > ANGLE_ID_MAX_LENGTH) {
    errors.push(issue('angle_id_length', 'angleId', `"${g.angleId}" is ${g.angleId.length} chars, ceiling ${ANGLE_ID_MAX_LENGTH}.`));
  }

  // --- person / format coherence -------------------------------------------
  const hasSpokesperson = g.spokespersonType !== 'none';

  if (hasSpokesperson && PERSONLESS_ASSET_TYPES.has(g.assetType)) {
    errors.push(issue(
      'spokesperson_on_personless_asset',
      'spokespersonType',
      `spokespersonType "${g.spokespersonType}" cannot appear on assetType "${g.assetType}", which has no person in frame. ` +
        'Left uncaught, the regression would credit this ad’s result to a spokesperson that was never on screen.',
    ));
  }

  if (spec.requiresPerson && !hasSpokesperson) {
    errors.push(issue(
      'template_requires_person',
      'spokespersonType',
      `template "${g.template}" is defined by who is on camera and cannot be built with spokespersonType "none".`,
    ));
  }

  if (hasSpokesperson && spec.spokespersons !== undefined && !spec.spokespersons.includes(g.spokespersonType)) {
    errors.push(issue(
      'spokesperson_wrong_for_template',
      'spokespersonType',
      `template "${g.template}" is a ${spec.spokespersons.join(' or ')} format; "${g.spokespersonType}" is a different ad. ${spec.note}`,
    ));
  }

  if (g.spokespersonType === 'synthetic' && spec.forbidsSynthetic) {
    errors.push(issue(
      'synthetic_presenter_forbidden',
      'spokespersonType',
      `template "${g.template}" presents lived experience as first-hand. A synthetic presenter makes it a fabricated testimonial under the FTC Reviews & Testimonials Rule — hard-blocked, not a warning.`,
    ));
  }

  if (g.spokespersonType === 'synthetic') {
    warnings.push(issue(
      'synthetic_presenter_disclosure',
      'spokespersonType',
      'A synthetic human presenter carries an AI-disclosure obligation and, if it resembles a real person, a right-of-publicity claim. Confirm likeness rights before publish.',
    ));
  }

  if (g.spokespersonType === 'celebrity') {
    warnings.push(issue(
      'celebrity_requires_licence',
      'spokespersonType',
      'Celebrity has the highest spend-use ratio in the dataset (2.1) but requires a real licensed celebrity; this cannot be generated.',
    ));
  }

  // --- static / motion coherence -------------------------------------------
  if (g.durationBucket === 'static') {
    if (g.pacing !== 'static') {
      errors.push(issue('static_with_pacing', 'pacing', `durationBucket "static" is a still frame; pacing "${g.pacing}" describes cuts that cannot exist.`));
    }
    if (g.musicPresence !== 'none') {
      errors.push(issue('static_with_music', 'musicPresence', `durationBucket "static" is a still frame; musicPresence "${g.musicPresence}" cannot play.`));
    }
    if (MOTION_ONLY_CAPTION_STYLES.has(g.captionStyle)) {
      errors.push(issue('static_with_motion_captions', 'captionStyle', `captionStyle "${g.captionStyle}" only exists over time; a static can carry "none" or "burned_in_static".`));
    }
  }

  if (!spec.durationBuckets.includes(g.durationBucket)) {
    warnings.push(issue(
      'duration_off_template',
      'durationBucket',
      `template "${g.template}" is specified at ${spec.durationBuckets.join('/')}; "${g.durationBucket}" is outside that. Duration is a per-format parameter, so this is a real deviation rather than a global rule.`,
    ));
  }

  // --- offer coherence ------------------------------------------------------
  if (spec.requiresOffer && g.offerType === 'none') {
    errors.push(issue(
      'template_requires_offer',
      'offerType',
      `template "${g.template}" leads with the offer; with offerType "none" there is nothing to lead with. ${spec.note}`,
    ));
  }

  if (g.offerType === 'none' && OFFER_BEARING_TACTICS.has(g.hookTactic)) {
    errors.push(issue(
      'offer_tactic_without_offer',
      'hookTactic',
      `hookTactic "${g.hookTactic}" IS the offer; with offerType "none" the ad would announce something that does not exist. Offer/landing-page drift is a common cause of a policy strike.`,
    ));
  }

  // --- trigger coherence ----------------------------------------------------
  if (g.secondaryTrigger !== undefined && g.secondaryTrigger === g.primaryTrigger) {
    errors.push(issue(
      'duplicate_trigger',
      'secondaryTrigger',
      `secondaryTrigger repeats "${g.primaryTrigger}". The point of a second trigger is combination; repeating one records diversity that is not there.`,
    ));
  }

  // --- fit warnings (§5.3 escape hatch: prefer, never forbid) ---------------
  if (!spec.awarenessFit.includes(g.awarenessStage)) {
    warnings.push(issue(
      'stage_off_template',
      'awarenessStage',
      `template "${g.template}" fits ${spec.awarenessFit.join('/')}; "${g.awarenessStage}" is off-book. Any format can work at any stage if the messaging is right — treat as a deliberate bet, not a mistake.`,
    ));
  }

  if (!spec.mechanics.includes(g.mechanic)) {
    warnings.push(issue('mechanic_off_template', 'mechanic', `template "${g.template}" is specified with ${spec.mechanics.join('/')}; "${g.mechanic}" is an untested pairing.`));
  }

  if (!spec.hookTactics.includes(g.hookTactic)) {
    warnings.push(issue('tactic_off_template', 'hookTactic', `template "${g.template}" is specified with ${spec.hookTactics.join('/')}; "${g.hookTactic}" is an untested pairing.`));
  }

  if (spec.humanReviewRequired) {
    warnings.push(issue('human_review_required', 'template', `template "${g.template}" requires human review before publish. ${spec.note}`));
  }

  if (g.assetType === 'carousel') {
    warnings.push(issue('carousel_underperforms', 'assetType', 'Carousel is last on both the hit-rate and spend-use leaderboards; never make it a default.'));
  }

  return { errors, warnings };
}

/** validateGenome, but a refusal. Use before anything that spends money. */
export function assertValidGenome(g: CreativeGenome): void {
  const { errors } = validateGenome(g);
  if (errors.length > 0) {
    const first = errors[0] as GenomeIssue;
    throw new GenomeError(
      first.field,
      `${errors.length} incoherent attribute${errors.length === 1 ? '' : 's'}: ` +
        errors.map((e) => `[${e.code}] ${e.message}`).join(' | '),
    );
  }
}

// ---------------------------------------------------------------------------
// Encoding — the ad-name round trip
// ---------------------------------------------------------------------------

/**
 * Bumped only when the field ORDER or the field COUNT changes.
 *
 * Adding a value to an existing dimension does not need a bump: old names still decode.
 * Reordering or removing a field does, because an old name would then decode to a
 * different vector — silently, and into the training set.
 */
export const GENOME_ENCODING_VERSION = 'g1';

const FIELD_SEPARATOR = '-';

/** Documentation and test anchor: the positional contract of an encoded genome. */
export const ENCODED_FIELD_ORDER: readonly string[] = [
  'awarenessStage', 'mechanic', 'hookTactic', 'primaryTrigger', 'secondaryTrigger',
  'template', 'assetType', 'spokespersonType', 'pacing', 'captionStyle', 'aspectRatio',
  'durationBucket', 'musicPresence', 'dominantColour', 'emotionalRegister', 'offerType', 'cta',
];

/**
 * Longest possible encoded genome: version + longest code per field + separators + angle id.
 *
 * Computed rather than asserted so it tracks the codebook, and exported so a caller can
 * budget an ad name without constructing one.
 */
export const GENOME_CODE_MAX_LENGTH =
  GENOME_ENCODING_VERSION.length +
  [
    AWARENESS_STAGE, MECHANIC, HOOK_TACTIC, PSYCH_TRIGGER, PSYCH_TRIGGER, TEMPLATE, ASSET_TYPE,
    SPOKESPERSON, PACING, CAPTION_STYLE, ASPECT_RATIO, DURATION_BUCKET, MUSIC_PRESENCE,
    DOMINANT_COLOUR, EMOTIONAL_REGISTER, OFFER_TYPE, CTA,
  ].reduce((sum, c) => sum + c.maxCodeLength, 0) +
  (ENCODED_FIELD_ORDER.length + 1) * FIELD_SEPARATOR.length +
  ANGLE_ID_MAX_LENGTH;

/**
 * `g1-<17 codes>-<angleId>` — stable, slug-safe, and readable back out of Insights.
 *
 * The ad name is the only per-object metadata reliably readable back from Insights, and
 * §12.5 is explicit that the genome belongs in it: any third-party tool can then group by
 * it, a human can triage in Ads Manager, and attribution survives losing our own database.
 *
 * The angle id goes LAST because it is the only part that may contain the separator, so
 * everything before it is positional and everything after it is the id.
 */
export function encodeGenome(g: CreativeGenome): string {
  assertAngleId(g.angleId);
  const codes = [
    AWARENESS_STAGE.code(g.awarenessStage),
    MECHANIC.code(g.mechanic),
    HOOK_TACTIC.code(g.hookTactic),
    PSYCH_TRIGGER.code(g.primaryTrigger),
    g.secondaryTrigger === undefined ? NO_SECONDARY_TRIGGER_CODE : PSYCH_TRIGGER.code(g.secondaryTrigger),
    TEMPLATE.code(g.template),
    ASSET_TYPE.code(g.assetType),
    SPOKESPERSON.code(g.spokespersonType),
    PACING.code(g.pacing),
    CAPTION_STYLE.code(g.captionStyle),
    ASPECT_RATIO.code(g.aspectRatio),
    DURATION_BUCKET.code(g.durationBucket),
    MUSIC_PRESENCE.code(g.musicPresence),
    DOMINANT_COLOUR.code(g.dominantColour),
    EMOTIONAL_REGISTER.code(g.emotionalRegister),
    OFFER_TYPE.code(g.offerType),
    CTA.code(g.cta),
  ];
  return [GENOME_ENCODING_VERSION, ...codes, g.angleId].join(FIELD_SEPARATOR);
}

function read<T extends string>(codec: Codec<T>, parts: readonly string[], index: number, whole: string): T {
  const raw = parts[index];
  if (raw === undefined) {
    throw new GenomeError(codec.field, `encoded genome "${whole}" ends before field ${index} (${codec.field}).`);
  }
  const value = codec.value(raw);
  if (value === undefined) {
    throw new GenomeError(
      codec.field,
      `"${raw}" at position ${index} of "${whole}" is not a known ${codec.field} code. Known codes: ${codec.values.map((v) => codec.code(v)).join(', ')}.`,
    );
  }
  return value;
}

/**
 * The exact inverse of encodeGenome. Throws — never returns a partial vector.
 *
 * A vector decoded wrong is worse than one not decoded at all: it enters the training set
 * as a confident mislabel and the system then learns from an ad that never existed.
 */
export function decodeGenome(code: string): CreativeGenome {
  const parts = code.split(FIELD_SEPARATOR);
  const version = parts[0];
  if (version !== GENOME_ENCODING_VERSION) {
    throw new GenomeError('version', `"${code}" is not a ${GENOME_ENCODING_VERSION} genome (found "${version ?? ''}"). A genome from another encoding version must be migrated, not guessed at.`);
  }
  // version + 17 codes + at least one angle-id segment
  if (parts.length < ENCODED_FIELD_ORDER.length + 2) {
    throw new GenomeError('encoding', `"${code}" has ${parts.length} segments; a ${GENOME_ENCODING_VERSION} genome needs at least ${ENCODED_FIELD_ORDER.length + 2}.`);
  }

  const angleId = parts.slice(ENCODED_FIELD_ORDER.length + 1).join(FIELD_SEPARATOR);
  assertAngleId(angleId);

  const rawSecondary = parts[5];
  const secondaryTrigger = rawSecondary === NO_SECONDARY_TRIGGER_CODE
    ? undefined
    : read(PSYCH_TRIGGER, parts, 5, code);

  return {
    angleId,
    awarenessStage: read(AWARENESS_STAGE, parts, 1, code),
    mechanic: read(MECHANIC, parts, 2, code),
    hookTactic: read(HOOK_TACTIC, parts, 3, code),
    primaryTrigger: read(PSYCH_TRIGGER, parts, 4, code),
    ...(secondaryTrigger !== undefined ? { secondaryTrigger } : {}),
    template: read(TEMPLATE, parts, 6, code),
    assetType: read(ASSET_TYPE, parts, 7, code),
    spokespersonType: read(SPOKESPERSON, parts, 8, code),
    pacing: read(PACING, parts, 9, code),
    captionStyle: read(CAPTION_STYLE, parts, 10, code),
    aspectRatio: read(ASPECT_RATIO, parts, 11, code),
    durationBucket: read(DURATION_BUCKET, parts, 12, code),
    musicPresence: read(MUSIC_PRESENCE, parts, 13, code),
    dominantColour: read(DOMINANT_COLOUR, parts, 14, code),
    emotionalRegister: read(EMOTIONAL_REGISTER, parts, 15, code),
    offerType: read(OFFER_TYPE, parts, 16, code),
    cta: read(CTA, parts, 17, code),
  };
}

/** True if a string looks like one of ours, without committing to it decoding cleanly. */
export function looksLikeGenomeCode(s: string): boolean {
  return s.startsWith(`${GENOME_ENCODING_VERSION}${FIELD_SEPARATOR}`);
}

/**
 * The ad name to publish this creative under.
 *
 * Ad level only. The creative-level name ceiling is 100 chars, which a genome plus the
 * `AUTO/<brand>/<archetype>/crt/` prefix cannot fit, so the genome goes on the AD — which
 * is also the object Insights reports on, and therefore the only one worth encoding.
 *
 * Validity is asserted here rather than at encode time: encoding a broken vector for a
 * log is harmless, publishing one spends money on an ad whose attributes are a lie.
 */
export function adNameForGenome(input: { brandId: string; archetype: string; genome: CreativeGenome }): string {
  assertValidGenome(input.genome);
  const variant = encodeGenome(input.genome);
  try {
    return objectName({ brandId: input.brandId, archetype: input.archetype, level: 'ad', variant });
  } catch (err) {
    if (err instanceof PublishBuildError) {
      const budget = NAME_MAX_LENGTH.ad - NAME_STAMP_RESERVE;
      throw new GenomeError(
        'adName',
        `genome code is ${variant.length} chars and will not fit the ${budget}-char ad-name budget alongside brand "${input.brandId}" and archetype "${input.archetype}". ` +
          `The genome itself is fixed-width apart from the angle id ("${input.genome.angleId}"), so shorten the angle id or the brand slug. Underlying: ${err.message}`,
      );
    }
    throw err;
  }
}

/**
 * Recovers the genome from an ad name read back from Insights.
 *
 * Returns undefined for a name that is not ours or not genome-bearing — a hand-made ad in
 * the same account is normal and must not throw. A name that IS genome-bearing but will
 * not decode throws, because that is corruption and silently dropping it would quietly
 * shrink the training set.
 */
export function genomeFromAdName(name: string): CreativeGenome | undefined {
  const parts = parseObjectName(name);
  if (parts === undefined) return undefined;
  if (parts.level !== 'ad') return undefined;
  if (!looksLikeGenomeCode(parts.variant)) return undefined;
  return decodeGenome(parts.variant);
}

/** Human-readable one-liner for logs and operator output. */
export function describeGenome(g: CreativeGenome): string {
  const triggers = g.secondaryTrigger === undefined ? g.primaryTrigger : `${g.primaryTrigger}+${g.secondaryTrigger}`;
  return [
    `angle=${g.angleId}`,
    `stage=${g.awarenessStage}(${funnelStageFor(g.awarenessStage)})`,
    `mechanic=${g.mechanic}`,
    `hook=${g.hookTactic}[${HOOK_TACTIC_CLUSTER[g.hookTactic]}]`,
    `trigger=${triggers}`,
    `template=${g.template}`,
    `asset=${g.assetType}`,
    `spokesperson=${g.spokespersonType}`,
    `pacing=${g.pacing}`,
    `captions=${g.captionStyle}`,
    `ar=${g.aspectRatio}`,
    `duration=${g.durationBucket}`,
    `music=${g.musicPresence}`,
    `colour=${g.dominantColour}`,
    `emotion=${g.emotionalRegister}`,
    `offer=${g.offerType}`,
    `cta=${g.cta}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Feature projection for the contextual bandit
// ---------------------------------------------------------------------------

interface OneHotDimension {
  field: string;
  values: readonly string[];
  get(g: CreativeGenome): string;
}

/**
 * The one-hot blocks, in the order they occupy the design matrix.
 *
 * Deliberately absent:
 *  - `angleId` — an open vocabulary that grows per brand. §4.6 wants angle as a GROUPING
 *    factor (a random effect) so estimates partially pool across angles, not as a column
 *    that would be a category of one for every new angle.
 *  - `funnelStage` and `hookTacticCluster` — both are exact functions of a column already
 *    present, so including them makes the design matrix singular. They are exported as
 *    lookups instead, for the model to use as pooling groups.
 */
const ONE_HOT_DIMENSIONS: readonly OneHotDimension[] = [
  { field: 'awarenessStage', values: AWARENESS_STAGE.values, get: (g) => g.awarenessStage },
  { field: 'mechanic', values: MECHANIC.values, get: (g) => g.mechanic },
  { field: 'hookTactic', values: HOOK_TACTIC.values, get: (g) => g.hookTactic },
  { field: 'template', values: TEMPLATE.values, get: (g) => g.template },
  { field: 'assetType', values: ASSET_TYPE.values, get: (g) => g.assetType },
  { field: 'spokespersonType', values: SPOKESPERSON.values, get: (g) => g.spokespersonType },
  { field: 'pacing', values: PACING.values, get: (g) => g.pacing },
  { field: 'captionStyle', values: CAPTION_STYLE.values, get: (g) => g.captionStyle },
  { field: 'aspectRatio', values: ASPECT_RATIO.values, get: (g) => g.aspectRatio },
  { field: 'durationBucket', values: DURATION_BUCKET.values, get: (g) => g.durationBucket },
  { field: 'musicPresence', values: MUSIC_PRESENCE.values, get: (g) => g.musicPresence },
  { field: 'dominantColour', values: DOMINANT_COLOUR.values, get: (g) => g.dominantColour },
  { field: 'emotionalRegister', values: EMOTIONAL_REGISTER.values, get: (g) => g.emotionalRegister },
  { field: 'offerType', values: OFFER_TYPE.values, get: (g) => g.offerType },
  { field: 'cta', values: CTA.values, get: (g) => g.cta },
];

/** Where each field's block starts, so a model can put a group-level prior on it. */
export interface FeatureGroup {
  field: string;
  start: number;
  length: number;
}

const { names: builtNames, groups: builtGroups } = (() => {
  const names: string[] = [];
  const groups: FeatureGroup[] = [];
  for (const dim of ONE_HOT_DIMENSIONS) {
    groups.push({ field: dim.field, start: names.length, length: dim.values.length });
    for (const v of dim.values) names.push(`${dim.field}=${v}`);
  }
  // Multi-hot: §3.6 allows two triggers at once, so this block can sum to 2.
  groups.push({ field: 'psychTrigger', start: names.length, length: PSYCH_TRIGGERS.length });
  for (const t of PSYCH_TRIGGERS) names.push(`psychTrigger=${t}`);
  return { names, groups };
})();

export const FEATURE_NAMES: readonly string[] = builtNames;
export const FEATURE_GROUPS: readonly FeatureGroup[] = builtGroups;
export const FEATURE_COUNT = FEATURE_NAMES.length;

const FEATURE_INDEX: ReadonlyMap<string, number> = new Map(FEATURE_NAMES.map((n, i) => [n, i]));

/**
 * Fingerprint of the column layout.
 *
 * Store it alongside any learned coefficients and refuse to apply them when it differs.
 * Coefficients silently applied to a shifted design matrix do not fail — they just
 * allocate budget against the wrong attributes, which is the expensive failure mode.
 */
export const FEATURE_SPACE_FINGERPRINT = createHash('sha256')
  .update(FEATURE_NAMES.join('\n'))
  .digest('hex')
  .slice(0, 16);

export interface FeatureVector {
  /** Aligned with FEATURE_NAMES; 0/1 throughout. */
  values: number[];
  /** Refuse stored coefficients whose fingerprint differs from this. */
  fingerprint: string;
}

/**
 * One-hot / multi-hot projection for the contextual bandit.
 *
 * Note the width: 172 columns against a small account's handful of winners per month
 * (§1.2: micro tier averages 0.0 winners/month). This is not a design matrix you fit
 * unregularised. §4.6 trap 2 is the instruction — partial pooling, a global prior fitted
 * across accounts, shrunk toward the per-account estimate as data accrues — and
 * FEATURE_GROUPS exists so the shrinkage can be applied per attribute rather than
 * uniformly across all 172.
 */
export function featureVector(g: CreativeGenome): FeatureVector {
  const values = new Array<number>(FEATURE_COUNT).fill(0);

  for (const group of FEATURE_GROUPS) {
    if (group.field === 'psychTrigger') continue;
    const dim = ONE_HOT_DIMENSIONS.find((d) => d.field === group.field);
    if (dim === undefined) {
      // Unreachable while the groups are built from the dimensions, and a throw rather
      // than a `continue` on purpose: skipping would emit an all-zero block, which is a
      // valid-looking vector whose coefficients land on the wrong attribute.
      throw new GenomeError(group.field, `feature group "${group.field}" has no source dimension; the layout and the projection have diverged.`);
    }
    const value = dim.get(g);
    const offset = dim.values.indexOf(value);
    if (offset < 0) {
      throw new GenomeError(dim.field, `"${value}" is not a level of ${dim.field}; the vector cannot be projected without inventing a column.`);
    }
    values[group.start + offset] = 1;
  }

  const triggerGroup = FEATURE_GROUPS.find((gr) => gr.field === 'psychTrigger');
  if (triggerGroup === undefined) throw new GenomeError('psychTrigger', 'feature layout is missing the trigger block.');
  for (const t of [g.primaryTrigger, g.secondaryTrigger]) {
    if (t === undefined) continue;
    const offset = PSYCH_TRIGGERS.indexOf(t);
    if (offset < 0) throw new GenomeError('psychTrigger', `"${t}" is not a known trigger.`);
    values[triggerGroup.start + offset] = 1;
  }

  return { values, fingerprint: FEATURE_SPACE_FINGERPRINT };
}

/** Index of a named feature, e.g. `hookTactic=confession`. Undefined if the space has moved. */
export function featureIndex(name: string): number | undefined {
  return FEATURE_INDEX.get(name);
}
