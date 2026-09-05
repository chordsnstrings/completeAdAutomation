/**
 * Deterministic pre-flight policy and claim screening.
 *
 * This is the cheapest tier of the pre-flight gate described in
 * docs/research/meta-policy-compliance.md §11.1 — pure functions over text plus a
 * creative descriptor, run BEFORE any model-based screening, before any render, and
 * long before `POST /act_<id>/ads`. Nothing here calls a network or an LLM.
 *
 * Why it exists at all. The threat model is not "an ad gets rejected"; it is "the
 * Business Account gets restricted" (§0.4). Meta restricts assets for *"severely or
 * repeatedly violating policies"*, and an autonomous copywriter generating at volume
 * accumulates violations faster than any human operation ever could. Every violation
 * caught here is one that never reaches Meta's counter.
 *
 * Three design rules, all of which cost something and are worth it:
 *
 *   1. FAIL CLOSED. An input we cannot screen (empty copy, an unknown presenter kind,
 *      a disapproval with no readable reason) is a BLOCK, never a PASS. Silence is not
 *      evidence of compliance.
 *   2. EVERY finding carries a policy reference and an offending span, because the
 *      remediation loop has a budget of two attempts per lineage (§9.2.4) and a loop
 *      that regenerates blindly burns both. A finding that cannot be acted on is noise.
 *   3. Rules run cheapest-first and, by default, ALL of them run. Short-circuiting on
 *      the first BLOCK saves microseconds and costs a whole remediation attempt: the
 *      rewrite fixes violation one and trips violation two on the next pass.
 *
 * What this tier explicitly CANNOT do, so that nobody mistakes a PASS for safety:
 * it does not see pixels. Frame-level NSFW/suggestiveness, celebrity-face matching,
 * logo detection and burned-in-text OCR are a separate vision stage (§11.1.3), and
 * *most policy-violating text in a video ad is burned into the frame*. Feed OCR output
 * back through here via `copy.onScreenText` once it exists.
 */

import type { ClaimSet, SpecialAdCategory } from '../domain/brand.ts';

// ---------------------------------------------------------------------------
// Verdict vocabulary
// ---------------------------------------------------------------------------

/**
 * Deliberately the same three strings as `Severity` in src/preflight/checks.ts rather
 * than an import: the two modules report to the same console surface and must line up,
 * but neither should have to change when the other's result shape does.
 */
export type PolicyVerdict = 'PASS' | 'WARN' | 'BLOCK';

const VERDICT_RANK: Readonly<Record<PolicyVerdict, number>> = { PASS: 0, WARN: 1, BLOCK: 2 };

export function worstVerdict(verdicts: readonly PolicyVerdict[]): PolicyVerdict {
  let worst: PolicyVerdict = 'PASS';
  for (const v of verdicts) if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  return worst;
}

/**
 * Confidence tags carried straight through from the dossier. A rule built on an
 * UNVERIFIED source stays labelled UNVERIFIED here so an operator reading a 3am
 * disapproval knows which of our rules are quoting Meta and which are inference.
 */
export type SourceConfidence = 'OFFICIAL' | 'OFFICIAL-IDX' | 'SDK' | '2ND' | 'UNVERIFIED';

export interface PolicyRef {
  /** Slug drawn from Meta's own Advertising Standards namespace (§1), not a bespoke one. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly confidence: SourceConfidence;
}

const T = 'https://transparency.meta.com/policies/ad-standards';

/**
 * The policy namespace this module emits labels from. Reconciling a disapproval's
 * `ad_review_feedback` code against our own pre-flight label is only possible if both
 * live in the same namespace (§1, "Engineering consequence").
 */
export const POLICIES = {
  personalAttributes: {
    id: 'objectionable-content/privacy-violations-personal-attributes',
    title: 'Privacy Violations and Personal Attributes',
    url: `${T}/objectionable-content/`,
    confidence: 'OFFICIAL',
  },
  personalHealth: {
    id: 'restricted-goods-services/health-and-wellness',
    title: 'Health and Wellness (personal health, negative self-perception)',
    url: `${T}/restricted-goods-services/`,
    confidence: 'OFFICIAL',
  },
  unrealisticOutcomes: {
    id: 'fraud-scams/unrealistic-outcomes',
    title: 'Unrealistic Outcomes',
    url: 'https://www.facebook.com/business/m/small-business/ad-policy-guidance',
    confidence: 'OFFICIAL',
  },
  unacceptableBusinessPractices: {
    id: 'fraud-scams/unacceptable-business-practices',
    title: 'Unacceptable Business Practices',
    url: `${T}/fraud-scams/unacceptable-business-practices/`,
    confidence: 'OFFICIAL',
  },
  financialProducts: {
    id: 'restricted-goods-services/financial-and-insurance-products-services',
    title: 'Financial and Insurance Products and Services',
    url: `${T}/restricted-goods-services/`,
    confidence: 'OFFICIAL',
  },
  cryptocurrency: {
    id: 'restricted-goods-services/cryptocurrency-products-services',
    title: 'Cryptocurrency Products and Services',
    url: `${T}/restricted-goods-services/`,
    confidence: 'OFFICIAL',
  },
  onlineGambling: {
    id: 'restricted-goods-services/online-gambling-and-games',
    title: 'Online Gambling and Games',
    url: `${T}/restricted-goods-services/`,
    confidence: 'OFFICIAL',
  },
  discriminatoryPractices: {
    id: 'unacceptable-content/discriminatory-practices',
    title: 'Discriminatory Practices / Special Ad Categories',
    url: `${T}/unacceptable-content/discriminatory-practices/`,
    confidence: 'OFFICIAL',
  },
  siep: {
    id: 'SIEP-advertising/SIEP',
    title: 'Ads about Social Issues, Elections or Politics',
    url: `${T}/SIEP-advertising/SIEP/`,
    confidence: 'OFFICIAL',
  },
  intellectualProperty: {
    id: 'intellectual-property-infringement/third-party-infringement',
    title: 'Third-Party Intellectual Property Infringement',
    url: `${T}/intellectual-property-infringement/third-party-infringement/`,
    confidence: 'OFFICIAL',
  },
  metaBrand: {
    id: 'intellectual-property-infringement/Using-Meta-Intellectual-Property-Licenses',
    title: 'Using Meta Intellectual Property Licenses',
    url: `${T}/intellectual-property-infringement/Using-Meta-Intellectual-Property-Licenses/`,
    confidence: 'OFFICIAL',
  },
  videoAds: {
    id: 'format-specific/video-ads',
    title: 'Video Ads (no overly disruptive tactics, e.g. flashing screens)',
    url: `${T}/`,
    confidence: 'OFFICIAL',
  },
  adultContent: {
    id: 'objectionable-content/adult-nudity-and-sexual-activity',
    title: 'Adult Nudity and Sexual Activity',
    url: `${T}/objectionable-content/`,
    confidence: 'OFFICIAL',
  },
  engagementBait: {
    id: 'ranking/engagement-bait',
    title: 'Engagement Bait (content distribution guideline, not an ad rejection)',
    url: 'https://transparency.meta.com/features/approach-to-ranking/content-distribution-guidelines/engagement-bait/',
    confidence: 'OFFICIAL',
  },
  ftcTestimonials: {
    id: 'ftc/16-cfr-465',
    title: 'FTC Rule on the Use of Consumer Reviews and Testimonials (16 CFR Part 465)',
    url: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465',
    confidence: 'OFFICIAL',
  },
  euAiActArticle50: {
    id: 'eu/ai-act-article-50',
    title: 'EU AI Act Article 50 — transparency obligations for synthetic media',
    url: 'https://artificialintelligenceact.eu/article/50/',
    confidence: 'OFFICIAL',
  },
  brandClaimSet: {
    id: 'internal/substantiated-claim-set',
    title: 'Brand claim set — nothing may be asserted outside claims.substantiated',
    url: 'docs/research/00-SYNTHESIS.md#inputs-only-a-human-can-supply',
    confidence: 'OFFICIAL',
  },
} as const satisfies Readonly<Record<string, PolicyRef>>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type CopyField =
  | 'primaryText'
  | 'headline'
  | 'description'
  | 'callToAction'
  | 'onScreenText'
  | 'transcript'
  | 'visualDescription'
  | 'presenterDescription';

export interface TextSpan {
  readonly field: CopyField;
  /** Present only for array-valued fields (`onScreenText`, `visualDescription`). */
  readonly index?: number;
  /** UTF-16 offsets into the ORIGINAL field text, so a rewriter can splice precisely. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface AdCopy {
  readonly primaryText: string;
  readonly headline?: string;
  readonly description?: string;
  readonly callToAction?: string;
  /**
   * Text burned into frames, from OCR. Screened identically to primary text because
   * Meta reviews it identically — and because a text-only check that skips it misses
   * most of the policy-violating text in a video ad (§11.1.3).
   */
  readonly onScreenText?: readonly string[];
  /** Voiceover / dialogue transcript. */
  readonly transcript?: string;
}

export type PresenterKind =
  | 'none'
  | 'voice_only'
  | 'animated_character'
  | 'synthetic_human'
  | 'real_human';

/**
 * How the on-screen person is FRAMED in the script. `customer_testimonial` is the one
 * value that is never legal for a synthetic presenter: an AI person recounting a
 * personal product result is a fabricated testimonial under 16 CFR Part 465, which
 * carries civil penalties per-ad-per-day and in which AI mass-generation is explicitly
 * in scope. Meta approving the ad is not a defence (§4.9).
 */
export type PresenterFraming = 'presenter' | 'narrator' | 'customer_testimonial';

export type VoiceKind =
  | 'none'
  | 'synthetic_generic'
  | 'cloned_licensed'
  | 'cloned_unlicensed'
  | 'real_recorded';

export interface Presenter {
  readonly kind: PresenterKind;
  readonly framing: PresenterFraming;
  readonly voice: VoiceKind;
  /** Wardrobe, setting, appearance — whatever the generator was told to render. */
  readonly description?: string;
  /**
   * A named real person the presenter is meant to resemble. ANY value blocks: Meta runs
   * facial recognition over >500,000 protected public figures and sued advertisers for
   * exactly this in Feb 2026 (§8.4).
   */
  readonly resemblesRealPerson?: string;
}

export interface CreativeDescriptor {
  /**
   * The creative LINEAGE, not the ad. The two-attempt remediation budget and the
   * `dri_*` permanent halt both apply to the lineage, so every remediated variant must
   * carry the id of the creative it descends from.
   */
  readonly lineageId: string;
  readonly copy: AdCopy;
  /**
   * Required, never defaulted. This pipeline generates everything with AI, so the safe
   * value is `true` — but a default would let a caller silently disable the realness
   * rules (§4.6) by forgetting a field.
   */
  readonly aiGenerated: boolean;
  readonly presenter?: Presenter;
  /** Shot descriptions / generator prompts. `neverShow` is screened against these. */
  readonly visualDescription?: readonly string[];
}

/** Everything the screen needs from a brand. A `Brand` satisfies this structurally. */
export interface ScreenBrand {
  readonly id: string;
  readonly claims: ClaimSet;
  readonly specialAdCategories: readonly SpecialAdCategory[];
  /** ISO alpha-2. Drives the EU AI Act Art. 50 in-creative disclosure requirement. */
  readonly countries: readonly string[];
}

export interface Finding {
  readonly ruleId: string;
  readonly severity: PolicyVerdict;
  readonly policy: PolicyRef;
  /** Names the actual cause. Nobody is awake to interpret a generic message. */
  readonly message: string;
  /** What has to change. Fed to the rewriter alongside the span. */
  readonly remedy: string;
  readonly span?: TextSpan;
  /** True when the match was only found after undoing an evasion (spacing, homoglyphs). */
  readonly evasion?: boolean;
}

export interface ScreenReport {
  readonly brandId: string;
  readonly lineageId: string;
  readonly verdict: PolicyVerdict;
  readonly findings: readonly Finding[];
  /** Stage ids in the order they ran. */
  readonly stagesRun: readonly string[];
  /**
   * False when screening short-circuited. A partial report must never be read as a
   * clean bill of health — there may be further violations nobody has looked for.
   */
  readonly complete: boolean;
}

export interface ScreenOptions {
  /**
   * Off by default, and it should stay off for anything headed for remediation: the
   * loop has two attempts per lineage, and fixing one violation at a time spends both.
   * Turn it on only for a cheap admission test where the full list is not wanted.
   */
  readonly stopAtFirstBlock?: boolean;
}

export class ScreenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenInputError';
  }
}

// ---------------------------------------------------------------------------
// Text normalisation — the anti-evasion layer
// ---------------------------------------------------------------------------

/**
 * Homoglyph folding. A Cyrillic `а` is one keystroke away from an ASCII `a`, renders
 * identically, and defeats every naïve `includes()` — and an LLM asked to "avoid the
 * word guaranteed" will reach for exactly these tricks. Built from paired strings and
 * length-checked at import so a typo fails loudly instead of silently mis-mapping.
 */
const CONFUSABLE_PAIRS: readonly (readonly [string, string])[] = [
  ['авекмнорстухіјѕ', 'abekmhopctyxijs'], // Cyrillic
  ['αβεικορτυχνμ', 'abeikoptuxvu'],       // Greek
  ['ɑɡıȷɩɭ', 'agijil'],                   // Latin extended
];

const CONFUSABLES = new Map<string, string>();
for (const [from, to] of CONFUSABLE_PAIRS) {
  const src = [...from];
  const dst = [...to];
  if (src.length !== dst.length) {
    throw new Error(
      `Confusable table is malformed: "${from}" (${src.length}) and "${to}" (${dst.length}) ` +
        `must be the same length. A mis-aligned table silently mis-folds every neverSay match.`,
    );
  }
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    const d = dst[i];
    if (s !== undefined && d !== undefined) CONFUSABLES.set(s, d);
  }
}

/**
 * Leetspeak, folded ONLY where a digit or symbol sits between two letters. That position
 * is the signature of the substitution ("gu4ranteed", "ca$h", "cla!m"), and gating on it
 * is what stops ordinary punctuation and prices from folding into letters: un-gated,
 * "risk! free" normalises to "riskifre" and stops matching the needle "risk free", and
 * "$50" becomes "so".
 */
const LEET: ReadonlyMap<string, string> = new Map([
  ['0', 'o'], ['1', 'i'], ['3', 'e'], ['4', 'a'], ['5', 's'], ['7', 't'], ['8', 'b'],
  ['@', 'a'], ['$', 's'], ['!', 'i'], ['|', 'i'],
]);

const IS_LETTER = /\p{L}/u;

/** Zero-width and directional marks: invisible in a diff, fatal to substring matching. */
const INVISIBLE = new Set(['​', '‌', '‍', '⁠', '﻿', '­', '᠎']);

interface Normalised {
  readonly text: string;
  /** `map[i]` is the offset in the source string of the character that produced `text[i]`. */
  readonly map: readonly number[];
}

function foldChar(ch: string, prev: string, next: string): string {
  const folded = CONFUSABLES.get(ch.toLowerCase()) ?? ch;
  // Per-character NFKD keeps source offsets exact: a decomposition that yields several
  // characters maps all of them back to the one offset it came from.
  const decomposed = folded.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
  const intraWord = IS_LETTER.test(prev) && IS_LETTER.test(next);
  let out = '';
  for (const c of decomposed) {
    const leet = (intraWord ? LEET.get(c) : undefined) ?? c;
    if ((leet >= 'a' && leet <= 'z') || (leet >= '0' && leet <= '9')) out += leet;
  }
  return out;
}

/**
 * Aggressive normalisation for `neverSay` / `neverShow`: strips ALL separators and
 * punctuation, folds homoglyphs, diacritics, fullwidth forms and leetspeak, and
 * collapses repeated letters. "g u a r-a-n t e e d", "gu4ranteed" and "guaaaranteed"
 * all become the same string as "guaranteed".
 *
 * The cost is the Scunthorpe problem: with separators gone, a short needle can match
 * inside an innocent word. That is why matches are also tested against a plain,
 * word-boundary-aware pass — a finding says which one fired (`evasion`) — and why the
 * aggressive pass ignores needles shorter than `MIN_EVASION_NEEDLE`. Even so it fails
 * closed: a false BLOCK costs one regeneration, a false PASS costs an account.
 */
export function normaliseAggressive(input: string): Normalised {
  // Neighbours are read from the SOURCE string, so what counts as intra-word does not
  // depend on which earlier characters happened to survive folding — but a RUN of
  // substituted characters has to be looked past, or a doubled substitution defeats the
  // whole thing: in "gu4r4nt33d" each "3" has the other "3" beside it, so neither was
  // intra-word, neither folded, and the needle "guaranteed" did not match. Both
  // neighbour scans therefore skip over invisible characters and over other
  // substitutable characters, in one linear pass each. "$50" and "risk! free" still do
  // not fold, because what sits beyond those runs is a space, not a letter.
  const before: string[] = new Array<string>(input.length).fill('');
  const after: string[] = new Array<string>(input.length).fill('');
  let carry = '';
  for (let i = 0; i < input.length; i++) {
    before[i] = carry;
    const raw = input[i] ?? '';
    if (!INVISIBLE.has(raw) && !LEET.has(raw)) carry = raw;
  }
  carry = '';
  for (let i = input.length - 1; i >= 0; i--) {
    after[i] = carry;
    const raw = input[i] ?? '';
    if (!INVISIBLE.has(raw) && !LEET.has(raw)) carry = raw;
  }

  let text = '';
  const map: number[] = [];
  let last = '';
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (raw === undefined || INVISIBLE.has(raw)) continue;
    for (const ch of foldChar(raw, before[i] ?? '', after[i] ?? '')) {
      if (ch === last) continue; // collapse runs, symmetrically on needle and haystack
      text += ch;
      map.push(i);
      last = ch;
    }
  }
  return { text, map };
}

/** Case/diacritic-insensitive but structure-preserving: words stay words. */
function normalisePlain(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const MIN_EVASION_NEEDLE = 4;

function containsAsWord(hayPlain: string, needlePlain: string): boolean {
  if (needlePlain.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = hayPlain.indexOf(needlePlain, from);
    if (at === -1) return false;
    const before = at === 0 ? ' ' : hayPlain.charAt(at - 1);
    const afterAt = at + needlePlain.length;
    const after = afterAt >= hayPlain.length ? ' ' : hayPlain.charAt(afterAt);
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}

export interface PhraseMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly evasion: boolean;
}

/**
 * Finds `phrase` in `haystack`, defeating case, punctuation, spacing, diacritics,
 * homoglyphs, leetspeak, zero-width characters and letter-doubling. Returns offsets
 * into the ORIGINAL haystack.
 */
export function findPhrase(haystack: string, phrase: string): PhraseMatch | undefined {
  const needle = normaliseAggressive(phrase).text;
  if (needle.length === 0) return undefined;

  const hay = normaliseAggressive(haystack);
  const at = hay.text.indexOf(needle);
  if (at === -1) return undefined;
  if (needle.length < MIN_EVASION_NEEDLE && !containsAsWord(normalisePlain(haystack), normalisePlain(phrase))) {
    // Too short to survive separator-stripping without hitting innocent substrings.
    return undefined;
  }

  const start = hay.map[at];
  const endMapped = hay.map[at + needle.length - 1];
  if (start === undefined || endMapped === undefined) return undefined;
  const end = endMapped + 1;

  const evasion = !containsAsWord(normalisePlain(haystack), normalisePlain(phrase));
  if (evasion && start > 0 && /[\p{L}\p{N}]/u.test(haystack.charAt(start - 1))) {
    // The aggressive pass strips separators, so a needle can land INSIDE a longer word:
    // neverSay "cure" matched "seCURE checkout" and "maniCURE", and "fair trade" matched
    // "unFAIR TRADEs". Those are Scunthorpe hits, not evasions, and a BLOCK on "secure
    // checkout" stops an unattended publisher on copy nobody would ever write to evade.
    //
    // A real evasion ("g u a r a n t e e d", "gu4ranteed", "guar​anteed") still begins
    // where the word begins, so requiring a non-alphanumeric character before the match
    // keeps every evasion and drops the infixes. The END is deliberately NOT guarded:
    // "guaranteed" must keep matching the phrase "guarantee", which is a suffix
    // extension, not a different word.
    return undefined;
  }

  return {
    start,
    end,
    text: haystack.slice(start, end),
    evasion,
  };
}

// ---------------------------------------------------------------------------
// Chunking — every screenable piece of text, with its field identity
// ---------------------------------------------------------------------------

interface Chunk {
  readonly field: CopyField;
  readonly index: number | undefined;
  readonly text: string;
  /** Copy is what Meta reads as ad text; visual chunks are what the generator renders. */
  readonly kind: 'copy' | 'visual';
}

function chunksOf(creative: CreativeDescriptor): Chunk[] {
  const c = creative.copy;
  const out: Chunk[] = [{ field: 'primaryText', index: undefined, text: c.primaryText, kind: 'copy' }];
  if (c.headline !== undefined) out.push({ field: 'headline', index: undefined, text: c.headline, kind: 'copy' });
  if (c.description !== undefined) out.push({ field: 'description', index: undefined, text: c.description, kind: 'copy' });
  if (c.callToAction !== undefined) out.push({ field: 'callToAction', index: undefined, text: c.callToAction, kind: 'copy' });
  if (c.transcript !== undefined) out.push({ field: 'transcript', index: undefined, text: c.transcript, kind: 'copy' });
  for (const [i, t] of (c.onScreenText ?? []).entries()) {
    out.push({ field: 'onScreenText', index: i, text: t, kind: 'copy' });
  }
  for (const [i, t] of (creative.visualDescription ?? []).entries()) {
    out.push({ field: 'visualDescription', index: i, text: t, kind: 'visual' });
  }
  const p = creative.presenter;
  if (p?.description !== undefined) {
    out.push({ field: 'presenterDescription', index: undefined, text: p.description, kind: 'visual' });
  }
  return out;
}

function spanFrom(chunk: Chunk, start: number, end: number): TextSpan {
  return {
    field: chunk.field,
    ...(chunk.index !== undefined ? { index: chunk.index } : {}),
    start,
    end,
    text: chunk.text.slice(start, end),
  };
}

// ---------------------------------------------------------------------------
// Stage: neverSay / neverShow
// ---------------------------------------------------------------------------

function screenBrandProhibitions(brand: ScreenBrand, creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const chunks = chunksOf(creative);

  for (const phrase of brand.claims.neverSay) {
    for (const chunk of chunks) {
      const hit = findPhrase(chunk.text, phrase);
      if (!hit) continue;
      findings.push({
        ruleId: 'brand.neverSay',
        severity: 'BLOCK',
        policy: POLICIES.brandClaimSet,
        message:
          `Copy contains the brand-prohibited phrase "${phrase}"` +
          (hit.evasion
            ? ` — matched only after undoing an evasion; the literal text is "${hit.text}". ` +
              `A near-miss spelling of a banned phrase is the phrase.`
            : ` as "${hit.text}".`),
        remedy: `Remove "${hit.text}". A brand put this in claims.neverSay; the generator may not route around it.`,
        span: spanFrom(chunk, hit.start, hit.end),
        ...(hit.evasion ? { evasion: true } : {}),
      });
      break; // one finding per phrase is enough to act on; the rewriter re-screens anyway
    }
  }

  // neverShow governs depiction, so it is screened against what the generator renders,
  // not against ad copy. Screening it against copy would flag a brand that bans showing
  // its own product being eaten for merely saying the word.
  for (const phrase of brand.claims.neverShow) {
    for (const chunk of chunks) {
      if (chunk.kind !== 'visual') continue;
      const hit = findPhrase(chunk.text, phrase);
      if (!hit) continue;
      findings.push({
        ruleId: 'brand.neverShow',
        severity: 'BLOCK',
        policy: POLICIES.brandClaimSet,
        message: `Shot description depicts "${phrase}", which the brand lists in claims.neverShow (as "${hit.text}").`,
        remedy: `Rewrite the shot so "${hit.text}" is not depicted. This is a brand rights/legal constraint, not a style note.`,
        span: spanFrom(chunk, hit.start, hit.end),
        ...(hit.evasion ? { evasion: true } : {}),
      });
      break;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stage: likeness rights
// ---------------------------------------------------------------------------

const LIKENESS_KINDS: ReadonlySet<PresenterKind> = new Set(['synthetic_human', 'real_human']);
const CLONED_VOICES: ReadonlySet<VoiceKind> = new Set(['cloned_licensed', 'cloned_unlicensed', 'real_recorded']);
/**
 * The subset that is SYNTHESISED from a real person. `real_recorded` is a genuine
 * recording, so it needs a rights release (above) but is not artificially generated and
 * does not carry an Art. 50 marking obligation of its own.
 */
const SYNTHETIC_VOICE_CLONES: ReadonlySet<VoiceKind> = new Set(['cloned_licensed', 'cloned_unlicensed']);

/** The "prominent physician" fact pattern Meta litigated in Feb 2026 (§8.4). */
const CLINICAL_SETTING = /\b(white coat|lab coat|stethoscope|scrubs|doctor|physician|surgeon|nurse|clinic(al)? setting|examination room|medical office)\b/iu;
const FIRST_PERSON_RESULT = /\b(i (lost|gained|earned|made|tried|used|cured|healed|beat)|it changed my life|worked for me|my results|my transformation|i went from)\b/iu;

function screenLikeness(brand: ScreenBrand, creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const p = creative.presenter;
  // NOT a bare `kind === 'none'` short-circuit: a voice-only creative has no face and is
  // still a likeness. Meta's Feb 2026 suits named "altered images AND voices" explicitly.
  if (p === undefined) return findings;
  if (
    p.kind === 'none' && p.voice === 'none' &&
    p.description === undefined && p.resemblesRealPerson === undefined
  ) {
    return findings;
  }

  const needsRights = LIKENESS_KINDS.has(p.kind) || CLONED_VOICES.has(p.voice);
  if (needsRights && !brand.claims.likenessRightsConfirmed) {
    findings.push({
      ruleId: 'likeness.rights-unconfirmed',
      severity: 'BLOCK',
      policy: POLICIES.euAiActArticle50,
      message:
        `Creative specifies a human presenter (kind=${p.kind}, voice=${p.voice}) but brand "${brand.id}" ` +
        `has claims.likenessRightsConfirmed = false. A synthetic likeness of a real person is a ` +
        `right-of-publicity claim and an EU AI Act Art. 50(4) disclosure obligation, and a cloned voice ` +
        `is likeness too.`,
      remedy:
        `A human must set claims.likenessRightsConfirmed = true for this brand, or the creative must ` +
        `drop to presenter.kind = "none" / "animated_character" with voice = "synthetic_generic". ` +
        `This flag is not something the pipeline can infer.`,
    });
  }

  if (p.voice === 'cloned_unlicensed') {
    findings.push({
      ruleId: 'likeness.cloned-voice-unlicensed',
      severity: 'BLOCK',
      policy: POLICIES.intellectualProperty,
      message: `Presenter voice is cloned_unlicensed. Meta's Feb 2026 suits named "altered images and voices of celebrities" explicitly.`,
      remedy: 'Use a licensed clone or a generic synthetic voice. No brand flag can authorise an unlicensed clone.',
    });
  }

  if (p.resemblesRealPerson !== undefined && p.resemblesRealPerson.trim() !== '') {
    findings.push({
      ruleId: 'likeness.resembles-real-person',
      severity: 'BLOCK',
      policy: POLICIES.unacceptableBusinessPractices,
      message:
        `Presenter is specified to resemble "${p.resemblesRealPerson}". Meta runs facial recognition over ` +
        `>500,000 protected public figures and sued advertisers over celeb-bait in Feb 2026.`,
      remedy: 'Discard this render — do not blur or stylise past it. Generate a presenter with no real-person reference.',
    });
  }

  if (p.framing === 'customer_testimonial' && p.kind === 'synthetic_human') {
    findings.push({
      ruleId: 'likeness.synthetic-testimonial',
      severity: 'BLOCK',
      policy: POLICIES.ftcTestimonials,
      message:
        `A synthetic_human presenter is framed as customer_testimonial. An AI person recounting a personal ` +
        `product result is a fabricated consumer testimonial under 16 CFR Part 465 — civil penalties, ` +
        `per-ad-per-day, with AI mass-generation explicitly in scope. Meta approving the ad is not a defence.`,
      remedy:
        'Reframe as presenter/narrator ("here is what the product does"), never as a customer recounting a ' +
        'result, and carry an on-screen "Dramatization — AI-generated presenter" disclosure.',
    });
  }

  // Synthetic presenter + first-person result language is the same violation arriving
  // through the script instead of through the framing field.
  if (p.kind === 'synthetic_human' && p.framing !== 'customer_testimonial') {
    for (const chunk of chunksOf(creative)) {
      if (chunk.kind !== 'copy') continue;
      const m = FIRST_PERSON_RESULT.exec(chunk.text);
      if (m === null || m.index === undefined) continue;
      findings.push({
        ruleId: 'likeness.first-person-result',
        severity: 'BLOCK',
        policy: POLICIES.ftcTestimonials,
        message:
          `Script puts a first-person product result ("${m[0]}") in the mouth of a synthetic_human presenter, ` +
          `which is a fabricated testimonial regardless of how presenter.framing is declared.`,
        remedy: `Rewrite "${m[0]}" in the third person, or make the presenter a non-human narrator.`,
        span: spanFrom(chunk, m.index, m.index + m[0].length),
      });
      break;
    }
  }

  if (p.description !== undefined && CLINICAL_SETTING.test(p.description)) {
    const m = CLINICAL_SETTING.exec(p.description);
    findings.push({
      ruleId: 'likeness.clinical-authority-figure',
      severity: 'WARN',
      policy: POLICIES.unacceptableBusinessPractices,
      message:
        `Presenter is rendered as a clinical authority figure ("${m?.[0] ?? 'clinical setting'}"). Meta sued ` +
        `over deepfakes of a physician promoting healthcare products; a synthetic doctor making health ` +
        `claims is the exact litigated fact pattern.`,
      remedy:
        'Drop the clinical wardrobe/setting unless a real, named, consenting clinician is on camera under a ' +
        'signed release — and then this is not a synthetic presenter at all.',
      ...(m?.index !== undefined
        ? { span: { field: 'presenterDescription', start: m.index, end: m.index + m[0].length, text: m[0] } }
        : {}),
    });
  }

  // EU AI Act Art. 50(5) requires disclosure "at the latest at the time of the first
  // interaction or exposure". Meta's own "AI info" label sits behind a three-dot menu,
  // so it does not satisfy this and the disclosure must be burned into the creative.
  // A cloned voice counts. Art. 50(4) covers "synthetic audio" and the deepfake test is
  // about resemblance to a real subject, not about whether a face is on screen — and
  // Meta's Feb 2026 suits named "altered images AND voices". Keying only on the presenter
  // kind let a licensed voice clone into Germany with no in-creative disclosure at all.
  if (isAiGenerated(creative) && (LIKENESS_KINDS.has(p.kind) || SYNTHETIC_VOICE_CLONES.has(p.voice))) {
    const eu = brand.countries.filter((c) => EU_EEA.has(c.toUpperCase()));
    if (eu.length > 0) {
      findings.push({
        ruleId: 'likeness.eu-disclosure-required',
        severity: 'WARN',
        policy: POLICIES.euAiActArticle50,
        message:
          `AI-generated human likeness (presenter kind=${p.kind}, voice=${p.voice}) delivered into ` +
          `${eu.join(', ')}. EU AI Act Art. 50 has applied since ` +
          `2026-08-02; penalties reach EUR 15M or 3% of worldwide turnover.`,
        remedy:
          'Burn an in-creative disclosure (first-frame supertitle or persistent caption) into the render. ' +
          'Do not rely on Meta\'s "AI info" label — it is behind the three-dot menu and is not "clear and ' +
          'distinguishable at first exposure".',
      });
    }
  }

  return findings;
}

/** EU-27 plus EEA. "Associated territories" is broader still (§5.7) — this is a floor. */
const EU_EEA: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
]);

// ---------------------------------------------------------------------------
// Stage: the rule pack
// ---------------------------------------------------------------------------

interface LexicalRule {
  readonly id: string;
  readonly severity: PolicyVerdict;
  readonly policy: PolicyRef;
  readonly pattern: RegExp;
  readonly scope: 'copy' | 'visual' | 'both';
  readonly message: string;
  readonly remedy: string;
  /** Only fires when the creative is AI-generated (§4.6). */
  readonly aiOnly?: boolean;
}

/**
 * The rejection reasons that actually hit a direct-response video pipeline (§6).
 *
 * Every entry is a *deterministic* rule and therefore deliberately narrow: it exists to
 * catch the cases an LLM copywriter produces by construction, not to be a policy
 * classifier. The LLM stage (§11.1.4) and the vision stage cover the rest. Where a rule
 * would over-block ordinary DR copy it is a WARN and the claim-set stage decides the
 * BLOCK — "clinically proven" is a WARN here and a BLOCK there unless the brand has
 * substantiated it.
 *
 * These patterns match LITERAL text. Evasion-resistant matching (spacing, homoglyphs,
 * leetspeak) is applied only to the brand's `neverSay`/`neverShow` phrases, because
 * those are fixed strings a hostile-ish generator would route around deliberately,
 * whereas these patterns carry `\s+` and `\b` that separator-stripping would destroy.
 * So "gu4ranteed" is caught as a neverSay hit, not by this table. That asymmetry is
 * deliberate; the LLM stage is what covers obfuscated policy language generally.
 */
const RULES: readonly LexicalRule[] = [
  {
    id: 'unrealistic-outcomes.timeframe',
    severity: 'BLOCK',
    policy: POLICIES.unrealisticOutcomes,
    scope: 'copy',
    // Two arms, because the verb alone does not make an outcome promise. `lose/shed/melt`
    // take a body-outcome object almost by construction, so a timeframe after them is the
    // violation. `make/generate/earn/gain/drop` are ordinary English — "Make dinner in 15
    // minutes", "Generate a report in 30 seconds", "Drop your files in 5 seconds" are a
    // meal kit, a BI tool and a file host, and BLOCKing them stops legitimate advertising
    // cold — so those verbs additionally require a QUANTIFIED outcome (money, a
    // percentage, a weight, a count) between the verb and the timeframe. "Make $5,000 in
    // 30 days" still fires; "Make dinner in 15 minutes" no longer does.
    pattern: /\b(?:(?:lose|shed|erase|melt|burn|shrink)\b[^.!?\n]{0,60}?|(?:gain|drop|earn|make|generate|pocket|bank)\b[^.!?\n]{0,40}?(?:[$£€]\s?\d|\b\d[\d,.]*\s*(?:%|percent\b|x\b|times\b|lbs?\b|pounds?\b|kgs?\b|kilos?\b|stone\b|inches\b|dress\s+sizes\b|followers?\b|subscribers?\b|leads?\b|sales?\b|customers?\b|clients?\b|dollars?\b))[^.!?\n]{0,40}?)\b(in|within)\s+(just\s+|as little as\s+|only\s+)?\d+\s*(second|minute|hour|day|week|month)s?\b/giu,
    message:
      'Specific outcome plus a short timeframe. This is the exact shape Unrealistic Outcomes forbids, and ' +
      'it is also what maximises CTR — which is why an unconstrained DR copywriter generates it constantly.',
    remedy: 'Remove the timeframe or the quantified outcome. State what the product does, not what the reader will get by when.',
  },
  {
    id: 'unrealistic-outcomes.guaranteed-result',
    severity: 'BLOCK',
    policy: POLICIES.unrealisticOutcomes,
    scope: 'copy',
    // Targeted at guaranteed OUTCOMES. A money-back or satisfaction guarantee is a
    // legitimate and very common DR offer term and must not be caught here.
    pattern: /\b(guaranteed\s+(results?|weight\s*loss|income|returns?|profits?|approval|success|cure)|(results?|income|returns?|profits?|approval)\s+guaranteed|100%\s*(effective|guaranteed|results?)|risk[-\s]?free\s+results?)\b/giu,
    message: 'Guarantees a result. Unrealistic Outcomes forbids promises or suggestions of unrealistic outcomes.',
    remedy: 'Delete the guarantee. A money-back or satisfaction guarantee (about the purchase, not the result) is fine and is not what fired here.',
  },
  {
    id: 'unrealistic-outcomes.cure-incurable',
    severity: 'BLOCK',
    policy: POLICIES.personalHealth,
    scope: 'both',
    pattern: /\b(cures?|cured|heals?|reverses?|eliminates?|gets?\s+rid\s+of)\b[^.!?\n]{0,40}?\b(diabetes|cancer|autism|hiv|aids|alzheimer'?s?|dementia|arthritis|multiple\s+sclerosis|parkinson'?s?)\b/giu,
    message: 'Claims to cure, heal or eliminate an incurable disease — named explicitly in the Health and Wellness policy.',
    remedy: 'Remove the disease claim entirely. There is no compliant phrasing of it; this is not a wording problem.',
  },
  {
    id: 'unrealistic-outcomes.income-promise',
    severity: 'BLOCK',
    policy: POLICIES.unrealisticOutcomes,
    scope: 'copy',
    // The rate is what makes it an income promise. "Make your $50 gift card go further"
    // is not one, so a bare figure is deliberately not enough to fire this rule.
    pattern: /\b(make|earn|generate|pocket|bank)\b[^.!?\n]{0,40}?[$£€]\s?\d[\d,.]*\s*(k\b|m\b|million\b|\s*\/\s*(day|week|month|year)|\s+(per|a)\s+(day|week|month|year))/giu,
    message: 'Promises a specific income. Unrealistic Outcomes explicitly covers "economic opportunity" claims.',
    remedy: 'Remove the figure. Describe the offer, not an earnings outcome.',
  },
  {
    id: 'personal-health.negative-self-perception',
    severity: 'BLOCK',
    policy: POLICIES.personalHealth,
    scope: 'copy',
    // The shame arm MUST be gated on a body/appearance/health object. Before it was, it
    // fired on `<shame verb> ... your <anything>` and BLOCKed "Sick of your slow
    // commute?" and "Embarrassed by your outdated website?" — bog-standard DR copy with
    // no Personal Health dimension at all. A BLOCK stops publishing at 3am exactly as
    // hard as a real violation does, so a BLOCK-severity rule has to be narrow; the
    // module's own rule is that anything that would over-block ordinary DR copy is a
    // WARN or is left to the LLM stage. One slack word is allowed between "your" and the
    // body noun so "your thinning hair" still fires.
    pattern: /\b((are|do)\s+you\s+(fat|obese|overweight|ugly|balding|bald|wrinkl\w+)|(embarrassed|ashamed|humiliated|self[-\s]conscious|insecure|disgusted|sick|tired|fed\s+up)\s+(of|by|with|about)\s+your\s+(?:\p{L}+\s+)?(belly\s+fat|body\s+fat|beer\s+belly|belly|flabby\w*|double\s+chin|muffin\s+top|love\s+handles|problem\s+areas|stretch\s+marks|cellulite|wrinkles?|fine\s+lines|crow'?s\s+feet|age\s+spots|dark\s+circles|acne|blemishes|breakouts|skin|complexion|pores|teeth|smile|hairline|hair\s+loss|hair|bald\s+spot|weight|waistline|waist|thighs|stomach|tummy|gut|figure|physique|body|jowls|moobs|man\s+boobs|dad\s+bod|snoring|body\s+odou?r)\b|\byour\s+(belly\s+fat|flabby|double\s+chin|muffin\s+top|problem\s+areas))/giu,
    message:
      'Generates negative self-perception to promote a health, diet or appearance product — prohibited outright, ' +
      'and independently a Personal Attributes violation because it asserts a physical characteristic of the reader.',
    remedy: 'Reframe around the product, not the reader\'s body. "Designed for X" instead of "are you X".',
  },
  {
    id: 'personal-health.before-after',
    severity: 'WARN',
    policy: POLICIES.personalHealth,
    scope: 'both',
    pattern: /\b(before\s*(and|&|\/|-|\s)\s*after|transformation\s+(photos?|pics?|shots?)|results?\s+photos?)\b/giu,
    message:
      'Before/after framing. This is NOT categorically banned — Meta permits before-and-after depictions for ' +
      'cosmetic products and for weight products with results and timeframes clearly indicated, when targeting 18+. ' +
      'What is banned is idealised body-image framing and untargeted delivery.',
    remedy:
      'Force targeting.age_min = 18 at ad-set creation, keep the framing product-centric rather than body-shaming, ' +
      'and state the timeframe the results took. Then this is compliant.',
  },
  {
    id: 'superlatives.absolute',
    severity: 'WARN',
    policy: POLICIES.unacceptableBusinessPractices,
    scope: 'copy',
    pattern: /(#\s?1\b|\bno\.?\s?1\b|\bnumber\s+one\b|\bworld'?s\s+(best|leading|most|#\s?1)\b|\bthe\s+only\s+\w[\w\s]{0,20}?\bthat\b|\bbest\s+\w[\w\s]{0,15}?\b(ever|in\s+the\s+world|on\s+the\s+market)\b|\bnever\s+fails\b|\bunbeatable\b)/giu,
    message:
      'Absolute superlative. Unacceptable Business Practices forbids "deceptive or exaggerated claims about the ' +
      'success of a product or service"; an unqualified #1/best/only claim is exaggerated unless it is substantiated.',
    remedy: 'Either substantiate it (add it to claims.substantiated with its evidence) or qualify/remove it. The claim-set stage blocks it while it is unsubstantiated.',
  },
  {
    id: 'health-claims.efficacy-language',
    severity: 'WARN',
    policy: POLICIES.unacceptableBusinessPractices,
    scope: 'copy',
    pattern: /\b(clinically\s+proven|scientifically\s+proven|medically\s+proven|doctor[-\s]recommended|dermatologist[-\s]recommended|fda[-\s]approved|clinically\s+tested)\b/giu,
    message:
      'Health-efficacy language. Unacceptable Business Practices forbids "deceptive or exaggerated claims about ' +
      'health-related benefits", and these phrases attract manual review even when true.',
    remedy: 'Keep it only if the exact phrase is in claims.substantiated with evidence behind it; the claim-set stage blocks it otherwise.',
  },
  {
    id: 'financial.prohibited-product',
    severity: 'BLOCK',
    policy: POLICIES.financialProducts,
    scope: 'copy',
    pattern: /\b(payday\s+loans?|paycheck\s+advances?|cash\s+advance\s+loans?|binary\s+options?|contracts?\s+for\s+difference|\bcfds?\b|initial\s+coin\s+offering|\bico\b|penny\s+auctions?)\b/giu,
    message: 'Names a product the Financial and Insurance Products and Services policy prohibits outright.',
    remedy: 'This product cannot be advertised on Meta at all. Escalate to a human — there is no compliant creative for it.',
  },
  {
    id: 'financial.cryptocurrency',
    severity: 'WARN',
    policy: POLICIES.cryptocurrency,
    scope: 'copy',
    pattern: /\b(cryptocurrenc(y|ies)|crypto\s+(trading|exchange|wallet|investment)|bitcoin|ethereum|altcoins?|token\s+sale|\bnfts?\b)\b/giu,
    message:
      'Cryptocurrency promotion requires evidence of appropriate licensing AND written permission from Meta — a ' +
      'manual application, with no API.',
    remedy: 'Confirm the written Meta permission exists for this advertiser before publishing. If it does not, this creative cannot run.',
  },
  {
    id: 'engagement-bait',
    severity: 'WARN',
    policy: POLICIES.engagementBait,
    scope: 'copy',
    pattern: /\b(like\s+(and|&)\s+share|share\s+this\s+(post|with)|tag\s+(a|your)\s+friend|comment\s+(below|yes)|double\s+tap|hit\s+(the\s+)?like|vote\s+in\s+the\s+comments)\b/giu,
    message:
      'Engagement bait. This is a RANKING guideline, not a rejection reason: Meta demotes posts that repeatedly ' +
      'use it, and there is no API signal for the demotion. It costs delivery silently.',
    remedy: 'Replace with a specific call to action tied to the offer. An explicit engagement request is never worth the distribution penalty.',
  },
  {
    id: 'ai-content.realness-claim',
    severity: 'BLOCK',
    policy: POLICIES.unacceptableBusinessPractices,
    scope: 'copy',
    aiOnly: true,
    pattern: /\b(real\s+(customers?|people|results?|footage)|actual\s+(customers?|footage)|not\s+(paid\s+)?actors?|unscripted|filmed\s+on\s+location|caught\s+on\s+camera|no\s+cgi)\b/giu,
    message:
      'Copy asserts the footage is real, on an AI-generated creative. Meta applies an unremovable "AI info" label ' +
      'from its own detection; that label sitting next to this copy converts a stylistic choice into a ' +
      'deceptive practice.',
    remedy: 'Delete the realness claim. You cannot prevent the label and you cannot remove it, so the copy must survive it.',
  },
  {
    id: 'meta-brand.misuse',
    severity: 'WARN',
    policy: POLICIES.metaBrand,
    scope: 'copy',
    pattern: /(\bFB\b|\bIG\b|\b[Ff]acebooks\b|\b[Ii]nstagrams\b)/gu,
    message:
      'Meta brand misuse. Meta\'s IP licence forbids abbreviating "Facebook" to "FB", pluralising its brands, or ' +
      'uncapitalising them outside a URL.',
    remedy: 'Write "Facebook" / "Instagram" in full and singular, and only to clarify a destination.',
  },
  {
    id: 'video.disruptive-tactics',
    severity: 'WARN',
    policy: POLICIES.videoAds,
    scope: 'visual',
    pattern: /\b(flashing|strobe|strobing|rapid\s+strobe|flicker(ing)?\s+(lights?|screens?))\b/giu,
    message:
      'Shot description asks for flashing or strobing. The Video Ads policy forbids "overly disruptive tactics, ' +
      'such as flashing screens", and it is a photosensitivity hazard independently of Meta.',
    remedy: 'Remove the flash/strobe direction and cap the luminance flash rate in the render pipeline.',
  },
  {
    id: 'adult.suggestive-direction',
    severity: 'WARN',
    policy: POLICIES.adultContent,
    scope: 'visual',
    pattern: /\b(lingerie|bikini|cleavage|topless|nude|nudity|seductive|sensual|revealing\s+(outfit|clothing)|skimpy)\b/giu,
    message:
      'Shot direction likely to produce frames that trip the suggestive-content classifier. Text-to-video models ' +
      'drift toward this shape unprompted, so an explicit direction makes it near-certain.',
    remedy:
      'Rewrite the shot direction. This deterministic tier cannot see pixels — the frame-level NSFW pass at >=1fps ' +
      'is still required and is the check that actually decides.',
  },
];

function screenRulePack(creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const chunks = chunksOf(creative);

  for (const rule of RULES) {
    if (rule.aiOnly === true && !isAiGenerated(creative)) continue;
    for (const chunk of chunks) {
      if (rule.scope !== 'both' && rule.scope !== chunk.kind) continue;
      // Fresh regex per scan: the table's patterns are global, and a shared lastIndex
      // makes results depend on scan order.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      const m = re.exec(chunk.text);
      if (m === null || m.index === undefined) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        policy: rule.policy,
        message: `"${m[0].trim()}" — ${rule.message}`,
        remedy: rule.remedy,
        span: spanFrom(chunk, m.index, m.index + m[0].length),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stage: personal attributes (second person x protected attribute, by proximity)
// ---------------------------------------------------------------------------

/**
 * Meta EXPLICITLY allows "you/your" language that does not reference a protected
 * characteristic, so this rule keys on the conjunction and never on second person
 * alone — keying on the pronoun would block essentially all direct-response copy.
 *
 * The window is measured in tokens across the whole field rather than within a
 * sentence, because Meta's own counter-example splits the two halves across a sentence
 * boundary: "Bad credit? We can help you."
 */
export const PERSONAL_ATTRIBUTE_WINDOW_TOKENS = 10;

const SECOND_PERSON = /^(you|youre|your|yours|yourself|u|ur)$/u;

/**
 * The protected-attribute lexicon. Deliberately excludes bare colour and nationality
 * words ("black", "asian") which appear constantly in innocent ad copy; the LLM stage
 * covers what a lexicon cannot.
 */
const ATTRIBUTE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['physical or mental health', /\b(diabetes|diabetics?|cancer|hiv|aids|depression|depressed|anxiety|adhd|autism|autistic|arthritis|obese|obesity|overweight|erectile\s+dysfunction|hair\s+loss|balding|incontinence|menopause|menopausal|infertility|infertile|insomnia|chronic\s+pain|addiction|addicted|alcoholics?|std|herpes|psoriasis|eczema|ibs)\b/giu],
  // "blind" needs its idioms carved out: "check your blind spot", "a blind test", "a
  // blind date" are not disability references, and a BLOCK on them stops legitimate
  // automotive and research copy dead.
  ['disability', /\b(disabled|disability|wheelchair|handicapped|deaf|blind(?!\s+(?:spot|test|tasting|date|corner|side|study|trial|panel))|amputees?)\b/giu],
  // Two carve-outs, both of which were blocking ordinary DR copy outright:
  //   * "no credit" fired on "No credit card required" — arguably the single most common
  //     sentence in software direct response. The financial-vulnerability sense is
  //     "no credit check" / "no credit history", never "no credit card".
  //   * bare "broke" is far more often the past tense of "break" ("your last blender
  //     broke") than the financial adjective, so it now needs a copular/idiomatic frame.
  ['vulnerable financial status', /\b(bad\s+credit|poor\s+credit|no\s+credit(?!\s+cards?\b)|in\s+debt|drowning\s+in\s+debt|bankrupt(cy)?|foreclosure|evicted|low[-\s]income|(?:(?:i|you|we|they)\s*['’]?\s*(?:m|re)|am|is|are|was|were|feel|feeling|being|flat|going|dead|too|so|still)\s+(?:\p{L}+\s+){0,2}broke|unemployed|jobless|laid\s+off)\b/giu],
  // Age is the one attribute whose lexicon is mostly digits, so it needs the most
  // guarding in both directions. Two defects fixed here:
  //   * `(4|5|6|7|8)0\s?\+` followed by the group-level `\b` was DEAD. "+" is not a word
  //     character, so the boundary after it never matched unless a letter followed
  //     immediately — "the 50+ crowd" was silently invisible to the whole rule.
  //   * `over\s+\d0` fired on "Over 40 colours to choose from — pick yours today", a
  //     BLOCK on copy containing no age reference whatsoever. The plural-noun and
  //     percent lookaheads reject the "over N <things>" counting sense.
  // The currency/digit lookbehind keeps "$50 + free shipping" out of the age lexicon.
  //   * The bare "N0+" arm ALSO counted, not just aged: "40+ hours of playback",
  //     "50+ integrations", "60+ recipes" are quantities, and next to any "your" they
  //     were a BLOCK. It now carries the same plural-noun and unit lookaheads the
  //     "over N" arm already had, so "the 50+ crowd" still fires and "40+ hours" does not.
  ['age', /(\b(?:over|aged?)[-\s]+(?:4|5|6|7|8)0s\b|\b(?:over|aged?)\s+(?:4|5|6|7|8)0\b(?!\s*%)(?!\s+percent\b)(?!\s+\p{L}+s\b)|(?<![$£€\d.,])\b(?:4|5|6|7|8)0\+(?!\s*\p{L}+s\b)(?!\s*(?:hour|hr|minute|min|second|sec|day|week|month|year|mile|km|kg|lb|pound|item|page|colou?r|flavou?r|design|style|recipe|feature|integration|template|location|store|brand|option|channel|course|lesson|review|country|language|partner|customer|client|user|member|project|tool|model|size|photo|video|episode|question|exercise|workout|meal|ingredient|award|patent)\b)|\b(?:4|5|6|7|8)0\s+(?:and|or)\s+(?:over|older|above|up)\b|\bin\s+your\s+(?:4|5|6|7|8)0s\b|\bsenior\s+citizens?\b|\bretirees?\b|\belderly\b|\bpensioners?\b|\bbaby\s+boomers?\b)/giu],
  ['religion or beliefs', /\b(muslim|christian|jewish|catholic|hindu|buddhist|atheist|evangelical|orthodox\s+jew)\b/giu],
  ['sexual orientation or gender identity', /\b(gay|lesbian|bisexual|transgender|trans\s+(man|woman|people)|lgbtq?\+?)\b/giu],
  ['race or ethnicity', /\b(african[-\s]american|latino|latina|latinx|hispanic|native\s+american|immigrants?|undocumented)\b/giu],
  ['family or relationship status', /\b(single\s+(moms?|mums?|dads?|parents?|mothers?|fathers?)|divorced|divorcees?|widow(s|ed|ers?)?|newly\s+single)\b/giu],
  ['criminal record', /\b(felony|felons?|criminal\s+record|convicted|ex[-\s]offenders?|arrested|dui)\b/giu],
  ['trade union membership', /\b(union\s+members?|unionised|unionized)\b/giu],
  ['pregnancy', /\b(pregnant|pregnancy|expecting\s+a\s+baby|trying\s+to\s+conceive)\b/giu],
];

/**
 * The attribute is attached to a THIRD-PERSON GROUP, not to the reader: "options for
 * people managing diabetes", "designed for runners over 40". Meta's rule is about
 * asserting or implying knowledge of *the reader's* attribute, and this shape asserts
 * nothing about them — it is, verbatim, the rewrite this very rule's `remedy` asks for.
 *
 * Before this existed, that remedy was unusable: "Support for people managing diabetes.
 * Find your plan." BLOCKed, so the rewriter's compliant output tripped the same rule that
 * demanded it and burned the second of two remediation attempts. It is a downgrade to
 * WARN rather than an exemption, because "for people with bad credit — you're approved"
 * is still worth a look from the model tier; WARN keeps the signal without refusing to
 * publish.
 *
 * Deliberately requires an explicit group noun. A bare preposition would swallow "Rates
 * for retirees like you", which really is the violation.
 */
const THIRD_PERSON_GROUP_FRAME =
  /\b(?:for|among|by|serving|helping|supporting|supports)\s+(?:the\s+|our\s+|all\s+|many\s+|most\s+|other\s+)?(?:\p{L}+\s+){0,2}(?:people|persons|adults|men|women|families|parents|patients|customers|clients|members|individuals|residents|drivers|runners|shoppers|readers|users|students|workers|professionals|veterans|those|anyone|everyone|homeowners|renters|households|teams|businesses|carers|caregivers)\s+(?:\p{L}+\s+){0,3}$/iu;

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenise(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu)) {
    if (m.index === undefined) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function tokenIndexAt(tokens: readonly Token[], offset: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== undefined && offset >= t.start && offset < t.end) return i;
  }
  // Between tokens: attribute the offset to the next one, so distance stays a lower bound.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== undefined && t.start >= offset) return i;
  }
  return tokens.length - 1;
}

function screenPersonalAttributes(creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];

  for (const chunk of chunksOf(creative)) {
    if (chunk.kind !== 'copy') continue;
    const tokens = tokenise(chunk.text);
    const pronouns: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === undefined) continue;
      if (SECOND_PERSON.test(t.text.toLowerCase().replace(/['’]/gu, ''))) pronouns.push(i);
    }
    if (pronouns.length === 0) continue;

    for (const [label, pattern] of ATTRIBUTE_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      // Collect every in-window match for this attribute class BEFORE reporting one.
      // Only one finding per (field, class) is emitted — the rewriter re-screens — but
      // which one matters now that a third-person frame downgrades to WARN: reporting the
      // first match would let "Loans for people with bad credit. Are you in debt?" come
      // back WARN, because the framed occurrence was found first and stopped the scan.
      // A BLOCK-worthy occurrence anywhere in the field wins.
      interface Candidate {
        readonly match: string;
        readonly index: number;
        readonly pronoun: Token;
        readonly distance: number;
        readonly thirdPerson: boolean;
      }
      const candidates: Candidate[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(chunk.text)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const at = tokenIndexAt(tokens, m.index);
        let nearest: number | undefined;
        let best = Number.POSITIVE_INFINITY;
        for (const p of pronouns) {
          const d = Math.abs(p - at);
          if (d < best) {
            best = d;
            nearest = p;
          }
        }
        if (nearest === undefined || best > PERSONAL_ATTRIBUTE_WINDOW_TOKENS) continue;
        const pron = tokens[nearest];
        if (pron === undefined) continue;
        candidates.push({
          match: m[0],
          index: m.index,
          pronoun: pron,
          distance: best,
          thirdPerson: THIRD_PERSON_GROUP_FRAME.test(chunk.text.slice(Math.max(0, m.index - 80), m.index)),
        });
      }
      const chosen = candidates.find((c) => !c.thirdPerson) ?? candidates[0];
      if (chosen !== undefined) {
        const start = Math.min(chosen.pronoun.start, chosen.index);
        const end = Math.max(chosen.pronoun.end, chosen.index + chosen.match.length);
        findings.push({
          ruleId: 'personal-attributes.second-person-proximity',
          severity: chosen.thirdPerson ? 'WARN' : 'BLOCK',
          policy: POLICIES.personalAttributes,
          message:
            `Second person "${chosen.pronoun.text}" sits ${chosen.distance} token(s) from "${chosen.match}" ` +
            `(${label}). Ads must not assert or imply personal attributes, including implying the advertiser ` +
            `KNOWS the reader's health, financial or personal information. Second person alone is fine; the ` +
            `conjunction is what violates.` +
            (chosen.thirdPerson
              ? ` Downgraded to WARN: "${chosen.match}" is attached to a third-person group here, not to the ` +
                `reader, which is the permitted form — but a nearby "${chosen.pronoun.text}" can still read as ` +
                `addressing them, so the model tier should look.`
              : ''),
          remedy:
            `Rewrite in the third person about a group, not the reader: "for people managing ${chosen.match}" ` +
            `rather than "${chosen.pronoun.text} ... ${chosen.match}". A passing reference to an age range with ` +
            `no "you" is also permitted.`,
          span: spanFrom(chunk, start, end),
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stage: special ad category consistency
// ---------------------------------------------------------------------------

interface CategorySignal {
  readonly id: string;
  readonly label: string;
  /** Any one of these declared on the brand satisfies the signal. */
  readonly satisfiedBy: readonly SpecialAdCategory[];
  readonly pattern: RegExp;
  readonly remedy: string;
}

/**
 * Deliberately narrow patterns. A false BLOCK here stops publishing at 3am just as
 * effectively as a real one, so each pattern is a distinctive multi-word phrase rather
 * than a bare keyword — "apply now" is a universal DR call to action and is NOT an
 * employment signal.
 */
const CATEGORY_SIGNALS: readonly CategorySignal[] = [
  {
    id: 'housing',
    label: 'housing',
    satisfiedBy: ['HOUSING'],
    pattern: /\b(apartments?\s+for\s+rent|homes?\s+for\s+sale|houses?\s+for\s+sale|condos?\s+for\s+sale|now\s+leasing|leasing\s+office|rental\s+(unit|propert|listing)\w*|real\s+estate\s+listings?|move[-\s]in\s+special|section\s+8|mortgage\s+(rates?|pre[-\s]?approval)|find\s+your\s+new\s+home)\b/giu,
    remedy: 'Set special_ad_categories = ["HOUSING"] with special_ad_category_country, or remove the housing framing from the copy.',
  },
  {
    id: 'employment',
    label: 'employment',
    satisfiedBy: ['EMPLOYMENT'],
    pattern: /\b(now\s+hiring|we'?re\s+hiring|job\s+openings?|job\s+vacanc(y|ies)|career\s+opportunit(y|ies)|employment\s+opportunit(y|ies)|join\s+our\s+team|apply\s+for\s+(this|the|our)\s+(job|position|role)|(full|part)[-\s]time\s+(position|role|job)|starting\s+(salary|pay)|\$\d[\d,.]*\s*(\/|per\s+)(hour|hr)\b)/giu,
    remedy: 'Set special_ad_categories = ["EMPLOYMENT"] with special_ad_category_country, or remove the recruitment framing from the copy.',
  },
  {
    id: 'credit',
    label: 'credit',
    // CREDIT is the DEPRECATED input, superseded by FINANCIAL_PRODUCTS_SERVICES on
    // 2025-01-14 for US advertisers/audiences. Both still satisfy the requirement.
    satisfiedBy: ['CREDIT', 'FINANCIAL_PRODUCTS_SERVICES'],
    // "credit card" is a credit signal only when the ad is about one. "No credit card
    // required" / "no credit card needed" is a friction-removal line on a free trial and
    // has nothing to do with the CREDIT special ad category — it was BLOCKing every
    // SaaS trial ad in the corpus.
    pattern: /\b((?<!\bno\s)(?<!\bwithout\s)credit\s+cards?(?!\s+(?:required|needed|necessary))|credit\s+scores?|credit\s+repair|no\s+credit\s+check|personal\s+loans?|auto\s+loans?|student\s+loans?|debt\s+consolidation|line\s+of\s+credit|refinanc(e|ing)\s+your|\bapr\b)\b/giu,
    remedy: 'Set special_ad_categories = ["FINANCIAL_PRODUCTS_SERVICES"] with special_ad_category_country, or remove the credit framing.',
  },
  {
    id: 'financial-services',
    label: 'financial products and services',
    satisfiedBy: ['FINANCIAL_PRODUCTS_SERVICES', 'CREDIT'],
    pattern: /\b((life|health|auto|home)\s+insurance|insurance\s+(quotes?|policy|policies|plans?)|brokerage\s+account|retirement\s+(plan|account)|401\(?k\)?|\bira\b|savings\s+accounts?|checking\s+accounts?|investment\s+(account|platform|advice))\b/giu,
    remedy: 'Set special_ad_categories = ["FINANCIAL_PRODUCTS_SERVICES"] with special_ad_category_country, or remove the financial-product framing.',
  },
  {
    id: 'gambling',
    label: 'online gambling and gaming',
    satisfiedBy: ['ONLINE_GAMBLING_AND_GAMING'],
    pattern: /\b(online\s+casino|sportsbook|free\s+spins|real[-\s]money\s+(slots?|games?|poker)|place\s+a\s+bet|betting\s+odds|jackpot\s+payout)\b/giu,
    remedy: 'Set special_ad_categories = ["ONLINE_GAMBLING_AND_GAMING"] — a value that exists in the SDK enum but is absent from the human docs page.',
  },
];

/**
 * SIEP is a hard block regardless of what the brand declares. The authorization flow is
 * human-only and multi-day with no API, the "Paid for by" disclaimer is manual, SIEP is
 * prohibited outright in the EU since 2025-10-06, and US midterm blackout weeks apply.
 * There is no version of this an unattended system can run (§5.6).
 */
const SIEP_PATTERN = /\b(vote\s+(for|no|yes)\b|register\s+to\s+vote|polling\s+(place|station)|on\s+the\s+ballot|ballot\s+(measure|initiative)|our\s+campaign\s+for|elect\s+\w+|re[-\s]?elect|candidate\s+for\s+\w+|state\s+senate|congressional\s+(race|district)|immigration\s+(reform|policy)|gun\s+control|abortion\s+(rights?|ban)|climate\s+(legislation|policy)|tell\s+your\s+(senator|representative)|sign\s+the\s+petition)\b/giu;

function screenSpecialAdCategories(brand: ScreenBrand, creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set(brand.specialAdCategories);
  const copyChunks = chunksOf(creative).filter((c) => c.kind === 'copy');

  for (const signal of CATEGORY_SIGNALS) {
    if (signal.satisfiedBy.some((c) => declared.has(c))) continue;
    for (const chunk of copyChunks) {
      const re = new RegExp(signal.pattern.source, signal.pattern.flags);
      const m = re.exec(chunk.text);
      if (m === null || m.index === undefined) continue;
      findings.push({
        ruleId: `special-ad-category.mismatch.${signal.id}`,
        severity: 'BLOCK',
        policy: POLICIES.discriminatoryPractices,
        message:
          `Copy reads as ${signal.label} ("${m[0].trim()}") but brand "${brand.id}" declares ` +
          `special_ad_categories = [${brand.specialAdCategories.join(', ')}]. Meta detects the category from the ` +
          `creative and disapproves the mismatch — HOUSING_OR_CREDIT is a real, observed ad_review_feedback key ` +
          `and its remediation sentence is about certifying non-discrimination, which reads as unexplainable ` +
          `if the declaration says NONE.`,
        remedy: signal.remedy,
        span: spanFrom(chunk, m.index, m.index + m[0].length),
      });
      break;
    }
  }

  for (const chunk of copyChunks) {
    const re = new RegExp(SIEP_PATTERN.source, SIEP_PATTERN.flags);
    const m = re.exec(chunk.text);
    if (m === null || m.index === undefined) continue;
    findings.push({
      ruleId: 'special-ad-category.siep',
      severity: 'BLOCK',
      policy: POLICIES.siep,
      message:
        `Copy reads as social issue / electoral / political advertising ("${m[0].trim()}"). SIEP is out of scope ` +
        `for an unattended publisher in every jurisdiction: authorization is human-only with no API, the ` +
        `"Paid for by" disclaimer is manual, SIEP ads are prohibited in the EU since 2025-10-06 (a hard POST ` +
        `failure on /campaigns, /adsets, /ads and /adcreatives), and US election blackout weeks apply.`,
      remedy:
        'Rewrite out of the social-issue frame entirely. Do not set ISSUES_ELECTIONS_POLITICS to "fix" this — ' +
        'declaring it does not make the campaign runnable, it only makes the failure later and more expensive.',
      span: spanFrom(chunk, m.index, m.index + m[0].length),
    });
    break;
  }

  if (declared.has('ISSUES_ELECTIONS_POLITICS')) {
    findings.push({
      ruleId: 'special-ad-category.siep-declared',
      severity: 'BLOCK',
      policy: POLICIES.siep,
      message: `Brand "${brand.id}" declares ISSUES_ELECTIONS_POLITICS. This system cannot publish SIEP ads at all.`,
      remedy: 'Remove the category and the campaign, or move this advertiser to a human-operated workflow.',
    });
  }

  if (declared.has('CREDIT')) {
    findings.push({
      ruleId: 'special-ad-category.credit-deprecated',
      severity: 'WARN',
      policy: POLICIES.discriminatoryPractices,
      message:
        'CREDIT is the deprecated special ad category, superseded by FINANCIAL_PRODUCTS_SERVICES on 2025-01-14 ' +
        'for US-based advertisers and US-targeted campaigns. It still validates, which is why old code keeps using it.',
      remedy: 'Change the brand to FINANCIAL_PRODUCTS_SERVICES.',
    });
  }

  const certRequired: readonly SpecialAdCategory[] = ['HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES'];
  const needsCert = certRequired.filter((c) => declared.has(c));
  if (needsCert.length > 0) {
    findings.push({
      ruleId: 'special-ad-category.certification-precondition',
      severity: 'WARN',
      policy: POLICIES.discriminatoryPractices,
      message:
        `Brand declares ${needsCert.join(', ')}. Error 2859024 ("Certification Required") cannot be cleared by any ` +
        `API call — a business admin must accept the non-discrimination policy in Business Manager, and until they ` +
        `do, every ad in these categories is blocked.`,
      remedy:
        'Confirm the certification was accepted at onboarding, and that special_ad_category_country is set ' +
        'explicitly — it silently defaults to the advertiser\'s tax country, which is wrong for a multi-country platform.',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stage: claim-set enforcement
// ---------------------------------------------------------------------------

/**
 * Fraction of a claim sentence's content tokens that must also appear in an approved
 * claim for that claim to count as covering it. Set below 1 on purpose: the same claim
 * gets rephrased for every placement, and demanding literal equality would block all of
 * them. The falsifiable parts — every NUMBER and every claim MARKER — must still match
 * exactly, which is where the substantiation actually lives.
 */
export const CLAIM_COVERAGE_MIN = 0.5;

/**
 * What makes a sentence an assertion rather than framing. Copy that asks a question,
 * names the brand or issues a call to action asserts nothing and needs no
 * substantiation; treating every sentence as a claim produces an unusable screen that
 * gets switched off, which is worse than no screen.
 */
interface ClaimMarker {
  readonly label: string;
  readonly pattern: RegExp;
  /**
   * Returns true when this match is an OFFER rather than a claim about the product.
   * The offer is a structured, human-configured field elsewhere in the system, not
   * generated prose, so "Save 20%" and "yours for $29" are not the copywriter asserting
   * something the brand has to substantiate. Without this, every promotional line in
   * every ad blocks — and a screen that blocks everything gets switched off, which is
   * strictly worse than no screen.
   */
  readonly isOffer?: (left: string, right: string) => boolean;
}

const MONEY_OFFER_LEFT = /\b(for|from|only|just|starting\s+at|priced\s+at|was|now|save|off|discount|spend|spends|spending|orders?\s+over|purchases?\s+over|minimum|under)\s*[:\-]?\s*$/iu;
const OFFER_RIGHT = /^\s*(off\b|discount\b)/iu;
const PERCENT_OFFER_LEFT = /\b(save|saving)\s*$/iu;
/**
 * A guarantee ABOUT THE PURCHASE is a standard DR offer term, not an efficacy claim —
 * the rule pack says so explicitly ("a money-back or satisfaction guarantee ... is fine")
 * and then the claim-set stage BLOCKed it anyway as an unsubstantiated efficacy marker.
 * The two stages have to agree or the screen refuses to publish ordinary offers.
 */
const GUARANTEE_OFFER_LEFT = /\b(money[-\s]?back|money\s+back|satisfaction|happiness|price|lowest[-\s]?price|best[-\s]?price|lifetime|no[-\s]?quibble|\d+[-\s]?day)\s*$/iu;

const CLAIM_MARKERS: readonly ClaimMarker[] = [
  {
    label: 'quantified outcome',
    // A magnitude — not a bare duration. "Try it for 30 days" is a trial term, not a
    // claim; a duration only becomes a claim when it is promised ("in 4 weeks"), which
    // the timeframe-promise marker below covers.
    // No trailing \b on the group: "%" is not a word character, so a boundary after it
    // never matches and the whole percentage arm goes dead. Boundaries go on the word
    // alternatives individually.
    pattern: /\b\d+(?:[.,]\d+)?\s*(%|percent\b|x\b|times\b|lbs?\b|pounds?\b|kgs?\b|kilos?\b|inches\b|cm\b)/giu,
    isOffer: (left, right) => PERCENT_OFFER_LEFT.test(left) || OFFER_RIGHT.test(right),
  },
  {
    label: 'timeframe promise',
    pattern: /\b(in|within)\s+(just\s+|as\s+little\s+as\s+|only\s+)?\d+(?:[.,]\d+)?\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/giu,
  },
  {
    label: 'monetary figure',
    pattern: /[$£€]\s?\d[\d,.]*\s*(k\b|m\b|million)?/giu,
    isOffer: (left, right) => MONEY_OFFER_LEFT.test(left) || OFFER_RIGHT.test(right),
  },
  {
    label: 'efficacy',
    pattern: /\b(cures?|heals?|eliminates?|reverses?|prevents?|clinically\s+proven|scientifically\s+proven|medically\s+proven|fda[-\s]approved|doctor[-\s]recommended|clinically\s+tested|guaranteed?)\b/giu,
    isOffer: (left) => GUARANTEE_OFFER_LEFT.test(left),
  },
  {
    label: 'superlative',
    // "best seller" is a catalogue label, not a superlative claim about the product's
    // performance, and "Shop our best sellers" is not a proposition anyone substantiates.
    pattern: /(#\s?1\b|\bno\.?\s?1\b|\bnumber\s+one\b|\bbest\b(?![-\s]+sell)|\bthe\s+only\b|\bfastest\b|\bstrongest\b|\bmost\s+effective\b|\bunbeatable\b|\bnever\s+fails\b)/giu,
  },
  { label: 'comparative', pattern: /\b(\d+x|twice|double|triple|\d+\s*times)\s+(better|faster|stronger|more|longer|cheaper)\b/giu },
  // "organic reach/traffic/search" is marketing vocabulary, not a certification.
  { label: 'certification', pattern: /\b(certified|patented|award[-\s]winning|iso\s?\d+|organic(?!\s+(?:reach|traffic|search|growth|results?|posts?|social|listings?|rankings?))|non[-\s]gmo|vegan|cruelty[-\s]free)\b/giu },
];

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'as', 'at',
  'by', 'is', 'are', 'be', 'been', 'was', 'were', 'it', 'its', 'this', 'that', 'these', 'those',
  'you', 'your', 'yours', 'we', 'our', 'ours', 'i', 'me', 'my', 'they', 'them', 'their', 'he',
  'she', 'his', 'her', 'can', 'will', 'just', 'now', 'more', 'than', 'so', 'if', 'not', 'no',
  'all', 'any', 'up', 'out', 'into', 'over', 'get', 'gets', 'got', 'have', 'has', 'had', 'do',
  'does', 'did', 'new', 'every',
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenise(normalisePlain(text))) {
    let w = t.text;
    if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1); // light stem: "reduces" ~ "reduce"
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/gu)) out.add(m[0].replace(/,/gu, ''));
  return out;
}

interface Sentence {
  readonly text: string;
  readonly start: number;
}

function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  // A bare `[.!?]` split cut "Cuts drying time by 1.5x." into "Cuts drying time by 1" and
  // "5x", which scatters one claim across two fragments and puts a meaningless span in
  // the finding. Split on a full stop only when it is not sitting between two digits.
  const re = /(?:(?<!\d)[.!?]|[.!?](?!\d))[.!?]*|[\n\r]+|\s+[—–|•·]\s+/gu;
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    push(text.slice(from, m.index), from);
    from = m.index + m[0].length;
  }
  push(text.slice(from), from);
  return out;

  function push(raw: string, start: number): void {
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length > 0) out.push({ text: body, start: start + lead });
  }
}

interface Coverage {
  readonly covered: boolean;
  readonly nearest: string | undefined;
  readonly nearestScore: number;
}

function coverageOf(sentence: string, markerTexts: readonly string[], substantiated: readonly string[]): Coverage {
  const sTokens = contentTokens(sentence);
  const sNumbers = numbersIn(sentence);
  let nearest: string | undefined;
  let nearestScore = 0;

  for (const claim of substantiated) {
    const cTokens = contentTokens(claim);
    let hits = 0;
    for (const t of sTokens) if (cTokens.has(t)) hits++;
    const score = sTokens.size === 0 ? 1 : hits / sTokens.size;
    if (score > nearestScore) {
      nearestScore = score;
      nearest = claim;
    }
    if (score < CLAIM_COVERAGE_MIN) continue;

    // The falsifiable parts must match exactly. "Lose 10 lbs" does not substantiate
    // "lose 30 lbs", and "reduces wrinkles" does not substantiate "eliminates wrinkles".
    const cNumbers = numbersIn(claim);
    let numbersOk = true;
    for (const n of sNumbers) if (!cNumbers.has(n)) numbersOk = false;
    if (!numbersOk) continue;

    const claimNorm = normaliseAggressive(claim).text;
    let markersOk = true;
    for (const marker of markerTexts) {
      const needle = normaliseAggressive(marker).text;
      if (needle.length > 0 && !claimNorm.includes(needle)) markersOk = false;
    }
    if (!markersOk) continue;

    return { covered: true, nearest: claim, nearestScore: score };
  }

  return { covered: false, nearest, nearestScore };
}

function screenClaimSet(brand: ScreenBrand, creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const approved = brand.claims.substantiated;

  for (const chunk of chunksOf(creative)) {
    if (chunk.kind !== 'copy') continue;
    for (const sentence of sentencesOf(chunk.text)) {
      const markers: string[] = [];
      const labels = new Set<string>();
      for (const marker of CLAIM_MARKERS) {
        const re = new RegExp(marker.pattern.source, marker.pattern.flags);
        for (const m of sentence.text.matchAll(re)) {
          if (m.index === undefined) continue;
          const left = sentence.text.slice(Math.max(0, m.index - 24), m.index);
          const right = sentence.text.slice(m.index + m[0].length, m.index + m[0].length + 16);
          if (marker.isOffer?.(left, right) === true) continue;
          markers.push(m[0].trim());
          labels.add(marker.label);
        }
      }
      if (markers.length === 0) continue; // asserts nothing that needs substantiating

      if (approved.length === 0) {
        findings.push({
          ruleId: 'claim-set.no-approved-claims',
          severity: 'BLOCK',
          policy: POLICIES.brandClaimSet,
          message:
            `Copy makes an assertion ("${sentence.text}") but brand "${brand.id}" has an empty ` +
            `claims.substantiated list, so nothing is approved to be said.`,
          remedy: 'A human must populate claims.substantiated for this brand. This cannot be inferred from the proposition.',
          span: spanFrom(chunk, sentence.start, sentence.start + sentence.text.length),
        });
        continue;
      }

      const cov = coverageOf(sentence.text, markers, approved);
      if (cov.covered) continue;

      findings.push({
        ruleId: 'claim-set.unsubstantiated-assertion',
        severity: 'BLOCK',
        policy: POLICIES.brandClaimSet,
        message:
          `Unsubstantiated assertion: "${sentence.text}" (${[...labels].join(', ')}; markers: ` +
          `${markers.join(', ')}). Nothing outside claims.substantiated may be asserted.` +
          (cov.nearest !== undefined
            ? ` Closest approved claim (${Math.round(cov.nearestScore * 100)}% token overlap): "${cov.nearest}".`
            : ''),
        remedy:
          cov.nearest !== undefined
            ? `Rewrite the sentence to say no more than "${cov.nearest}", or have a human add this claim to ` +
              `claims.substantiated with its evidence. Numbers and efficacy words must match the approved claim exactly.`
            : 'Rewrite the sentence to assert nothing, or have a human add the claim to claims.substantiated with its evidence.',
        span: spanFrom(chunk, sentence.start, sentence.start + sentence.text.length),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stage: input validation (design rule 1 — fail closed)
// ---------------------------------------------------------------------------

const KNOWN_PRESENTER_KINDS: ReadonlySet<string> = new Set<PresenterKind>([
  'none', 'voice_only', 'animated_character', 'synthetic_human', 'real_human',
]);
const KNOWN_PRESENTER_FRAMINGS: ReadonlySet<string> = new Set<PresenterFraming>([
  'presenter', 'narrator', 'customer_testimonial',
]);
const KNOWN_VOICE_KINDS: ReadonlySet<string> = new Set<VoiceKind>([
  'none', 'synthetic_generic', 'cloned_licensed', 'cloned_unlicensed', 'real_recorded',
]);

/**
 * Fail closed on a descriptor this module cannot reason about. The types say these
 * fields are unions and a boolean, but the descriptor is assembled by a generator from
 * model output and config, and TypeScript is erased at runtime: a `kind: "human"` typo
 * matched no rule, was screened by nothing, and came out `PASS` — which is precisely
 * the "an unknown presenter kind is a BLOCK, never a PASS" case in this file's own
 * header. Likewise an absent `aiGenerated` silently switched off every `aiOnly` rule,
 * which is the default the field exists to prevent.
 */
function screenInputs(_brand: ScreenBrand, creative: CreativeDescriptor): Finding[] {
  const findings: Finding[] = [];
  const p = creative.presenter;

  if (typeof creative.aiGenerated !== 'boolean') {
    findings.push({
      ruleId: 'input.ai-flag-missing',
      severity: 'BLOCK',
      policy: POLICIES.unacceptableBusinessPractices,
      message:
        `CreativeDescriptor.aiGenerated is ${JSON.stringify(creative.aiGenerated)}, not a boolean. Every ` +
        `AI-only rule (the realness claim, the EU Art. 50 disclosure) keys on it, so an absent flag silently ` +
        `disables them. Screening proceeds as if the creative IS AI-generated.`,
      remedy: 'Set aiGenerated explicitly on the descriptor. It is required and must never be defaulted.',
    });
  }

  if (p !== undefined) {
    const unknown: string[] = [];
    if (!KNOWN_PRESENTER_KINDS.has(p.kind)) unknown.push(`kind=${JSON.stringify(p.kind)}`);
    if (!KNOWN_PRESENTER_FRAMINGS.has(p.framing)) unknown.push(`framing=${JSON.stringify(p.framing)}`);
    if (!KNOWN_VOICE_KINDS.has(p.voice)) unknown.push(`voice=${JSON.stringify(p.voice)}`);
    if (unknown.length > 0) {
      findings.push({
        ruleId: 'input.unknown-presenter-value',
        severity: 'BLOCK',
        policy: POLICIES.euAiActArticle50,
        message:
          `Presenter carries unrecognised value(s): ${unknown.join(', ')}. The likeness stage keys on these exact ` +
          `strings, so an unknown one matches no rule and the whole likeness gate — rights confirmation, cloned ` +
          `voice, fabricated testimonial, EU disclosure — silently does not run. An input we cannot screen is a BLOCK.`,
        remedy:
          `Use one of kind ${[...KNOWN_PRESENTER_KINDS].join('|')}, framing ` +
          `${[...KNOWN_PRESENTER_FRAMINGS].join('|')}, voice ${[...KNOWN_VOICE_KINDS].join('|')}.`,
      });
    }
  }

  return findings;
}

/** Fail closed: anything that is not literally `false` is screened as AI-generated. */
function isAiGenerated(creative: CreativeDescriptor): boolean {
  return creative.aiGenerated !== false;
}

interface Stage {
  readonly id: string;
  readonly run: (brand: ScreenBrand, creative: CreativeDescriptor) => Finding[];
}

/**
 * Cheapest first. `brand.prohibitions` is a handful of substring scans over a few
 * hundred characters; `claim-set` tokenises every sentence against every approved
 * claim. Ordering matters only for the short-circuit path and for report readability —
 * by default every stage runs.
 */
const STAGES: readonly Stage[] = [
  { id: 'input', run: screenInputs },
  { id: 'brand.prohibitions', run: screenBrandProhibitions },
  { id: 'likeness', run: screenLikeness },
  { id: 'rule-pack', run: (_b, c) => screenRulePack(c) },
  { id: 'personal-attributes', run: (_b, c) => screenPersonalAttributes(c) },
  { id: 'special-ad-category', run: screenSpecialAdCategories },
  { id: 'claim-set', run: screenClaimSet },
];

/**
 * Screens one creative against one brand. Pure: no I/O, no clock, no randomness, so the
 * same inputs always produce the same report and a report can be stored as evidence
 * (§11.5) and replayed against a later rule pack.
 */
export function screenCreative(
  brand: ScreenBrand,
  creative: CreativeDescriptor,
  options: ScreenOptions = {},
): ScreenReport {
  // Fail closed on inputs we cannot screen. An empty primary text is not a compliant
  // ad, it is an ad nobody has looked at.
  if (creative.copy.primaryText.trim() === '') {
    return {
      brandId: brand.id,
      lineageId: creative.lineageId,
      verdict: 'BLOCK',
      findings: [
        {
          ruleId: 'input.empty-copy',
          severity: 'BLOCK',
          policy: POLICIES.brandClaimSet,
          message: 'copy.primaryText is empty, so there is nothing to screen. A screen that cannot run is a BLOCK, never a PASS.',
          remedy: 'Supply the ad copy. If the creative genuinely has no text, screen the on-screen OCR output as primaryText.',
        },
      ],
      stagesRun: [],
      // NOT complete: no stage ran, so this report says nothing about the rest of the
      // creative. `complete` means "every stage was given a chance to look", and a caller
      // that reads it as a clean bill of health must be wrong here too.
      complete: false,
    };
  }
  if (creative.lineageId.trim() === '') {
    throw new ScreenInputError(
      'CreativeDescriptor.lineageId is empty. The two-attempt remediation budget and the dri_* permanent halt ' +
        'are both scoped to a lineage; without an id neither can be enforced and a copyright halt would be ' +
        'silently retried.',
    );
  }

  const findings: Finding[] = [];
  const stagesRun: string[] = [];
  let complete = true;

  for (const stage of STAGES) {
    stagesRun.push(stage.id);
    findings.push(...stage.run(brand, creative));
    if (options.stopAtFirstBlock === true && findings.some((f) => f.severity === 'BLOCK')) {
      complete = stagesRun.length === STAGES.length;
      break;
    }
  }

  return {
    brandId: brand.id,
    lineageId: creative.lineageId,
    verdict: worstVerdict(findings.map((f) => f.severity)),
    findings,
    stagesRun,
    complete,
  };
}

/** Convenience for a publisher: `if (!mayPublish(report)) refuse`. */
export function mayPublish(report: ScreenReport): boolean {
  return report.complete && report.verdict !== 'BLOCK';
}

// ---------------------------------------------------------------------------
// Remediation-loop policy
// ---------------------------------------------------------------------------

/**
 * Hard cap on automated remediation attempts per creative LINEAGE (§9.2.4). An
 * unbounded generate -> submit -> reject -> regenerate loop is a machine for
 * accumulating violations, which is exactly what escalates to account-level restriction.
 */
export const MAX_REMEDIATION_ATTEMPTS = 2;

/**
 * `placement_specific` surfaces whose presence means a rights-holder REPORT, not an ML
 * classifier: DRI is the IP-complaint pipeline, it feeds account `disable_reason = 2
 * (ADS_IP_REVIEW)`, and repeat hits are the fastest route to asset action. Any surface
 * beginning `dri_` is treated as halting, not only the two Meta documents, because the
 * placement_specific field list is discovered by observation and a new dri_* surface
 * must fail closed.
 */
export const HALTING_SURFACE_PREFIX = 'dri_';

export const POLITICAL_AUTHORIZATION_CATEGORIES: readonly string[] = [
  'POLITICAL',
  'POLITICAL_WITH_DIGITALLY_CREATED_MEDIA',
];

export interface ReviewFeedback {
  /** `ad_review_feedback.global` — reason code -> human remediation sentence. */
  readonly global?: Readonly<Record<string, string>>;
  /** `ad_review_feedback.placement_specific` — surface -> (reason code -> sentence). */
  readonly placementSpecific?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface MergedReason {
  /** `global`, or the placement surface name (`instagram`, `dri_copyright`, ...). */
  readonly surface: string;
  readonly code: string;
  /**
   * Meta's own remediation sentence, verbatim. Often contains "How to fix:" and is the
   * highest-signal input to a rewriter — higher than the opaque code.
   */
  readonly message: string;
}

/**
 * Merges `global` and EVERY `placement_specific` surface into one list.
 *
 * `global` is routinely `{}` while `placement_specific` is populated — an ad can be
 * DISAPPROVED on Instagram and fine on Facebook. Reading only `global` and concluding
 * "no reason given" is the single most common way a remediation loop goes blind.
 */
export function mergeReviewFeedback(feedback: ReviewFeedback): MergedReason[] {
  const out: MergedReason[] = [];
  for (const [code, message] of Object.entries(feedback.global ?? {})) {
    out.push({ surface: 'global', code, message });
  }
  for (const [surface, map] of Object.entries(feedback.placementSpecific ?? {})) {
    for (const [code, message] of Object.entries(map ?? {})) {
      out.push({ surface, code, message });
    }
  }
  return out;
}

export interface LineageState {
  readonly lineageId: string;
  /** Automated remediation attempts already spent on this lineage. */
  readonly attempts: number;
  /** True once this lineage has ever been halted. A halt is permanent. */
  readonly halted: boolean;
}

export type RemediationDisposition = 'RETRY' | 'QUARANTINE' | 'HALT';

export interface RemediationDecision {
  readonly disposition: RemediationDisposition;
  /**
   * `NEW_AD_IN_SAME_ADSET`, never "edit the disapproved ad": an edit is a significant
   * edit, it is treated as a new ad by review anyway, and it disturbs the ad set's
   * learning phase. Creating a new ad and pausing the old one preserves learning.
   */
  readonly action: 'NEW_AD_IN_SAME_ADSET' | 'NONE';
  /** How wide the pause has to be. An IP complaint taints every ad sharing the lineage. */
  readonly pauseScope: 'ad' | 'campaign' | 'lineage';
  readonly pageHuman: boolean;
  readonly reason: string;
  /** Meta's verbatim sentences, for the rewriter prompt. Never paraphrase these. */
  readonly verbatimReasons: readonly string[];
  readonly attemptsRemaining: number;
}

export interface DisapprovalContext {
  readonly lineage: LineageState;
  readonly feedback: ReviewFeedback;
  /**
   * `creative.effective_authorization_category` — what Meta's systems CONCLUDED the ad
   * is, which can differ from what was set. Meta deciding an ad is political is a free
   * classifier output and an emergency. Unavailable on Dynamic Ads, so `undefined` here
   * means "not read", not "not political".
   */
  readonly effectiveAuthorizationCategory?: string;
}

export class LineageHaltedError extends Error {
  readonly lineageId: string;
  constructor(lineageId: string) {
    super(
      `Creative lineage "${lineageId}" is permanently halted and must never be re-submitted. ` +
        `A halt comes from a rights-holder report (dri_copyright / dri_counterfeit), which feeds account ` +
        `disable_reason = 2 (ADS_IP_REVIEW). An automated "tweak and resubmit" against an IP complaint is the ` +
        `definition of evasion and is how an account gets restricted.`,
    );
    this.name = 'LineageHaltedError';
    this.lineageId = lineageId;
  }
}

/** The loud refusal. Call before publishing anything derived from a lineage. */
export function assertMayPublish(lineage: LineageState): void {
  if (lineage.halted) throw new LineageHaltedError(lineage.lineageId);
}

/**
 * Decides what happens to a disapproved ad's lineage. Pure over the caller's state, so
 * the halt ledger stays where it belongs (durable storage) rather than in this module.
 *
 * Order is not arbitrary: the halt checks come BEFORE the attempt budget, because a
 * copyright complaint on attempt 0 must halt just as hard as one on attempt 2.
 */
export function decideRemediation(context: DisapprovalContext): RemediationDecision {
  const reasons = mergeReviewFeedback(context.feedback);
  const verbatimReasons = reasons.map((r) => r.message).filter((m) => m.trim() !== '');
  const attemptsRemaining = Math.max(0, MAX_REMEDIATION_ATTEMPTS - context.lineage.attempts);

  if (context.lineage.halted) {
    return {
      disposition: 'HALT',
      action: 'NONE',
      pauseScope: 'lineage',
      pageHuman: false, // already paged when the halt was recorded; re-paging is noise
      reason: `Lineage "${context.lineage.lineageId}" was already halted. A halt is permanent and is never retried.`,
      verbatimReasons,
      attemptsRemaining: 0,
    };
  }

  const dri = reasons.filter((r) => r.surface.startsWith(HALTING_SURFACE_PREFIX));
  if (dri.length > 0) {
    return {
      disposition: 'HALT',
      action: 'NONE',
      pauseScope: 'lineage',
      pageHuman: true,
      reason:
        `Rights-holder report on ${dri.map((r) => r.surface).join(', ')}. This is a DRI complaint, not a ` +
        `classifier hit: it feeds account disable_reason = 2 (ADS_IP_REVIEW) and repeat hits are the fastest ` +
        `route to asset action. Halt every ad sharing this creative lineage globally and page a human. ` +
        `Never auto-retry.`,
      verbatimReasons,
      attemptsRemaining: 0,
    };
  }

  const authCategory = context.effectiveAuthorizationCategory;
  if (authCategory !== undefined && POLITICAL_AUTHORIZATION_CATEGORIES.includes(authCategory)) {
    return {
      disposition: 'QUARANTINE',
      action: 'NONE',
      pauseScope: 'campaign',
      pageHuman: true,
      reason:
        `Meta reclassified this ad as ${authCategory} via effective_authorization_category. SIEP needs manual ` +
        `authorization and a "Paid for by" disclaimer, and is prohibited outright in the EU — pause the campaign ` +
        `and escalate. "Social issue" is broad and an autonomous copywriter wanders into it.`,
      verbatimReasons,
      attemptsRemaining: 0,
    };
  }

  if (context.lineage.attempts >= MAX_REMEDIATION_ATTEMPTS) {
    return {
      disposition: 'QUARANTINE',
      action: 'NONE',
      pauseScope: 'ad',
      pageHuman: true,
      reason:
        `Remediation budget exhausted: ${context.lineage.attempts} of ${MAX_REMEDIATION_ATTEMPTS} attempts spent ` +
        `on lineage "${context.lineage.lineageId}". Further automated attempts accumulate violations against the ` +
        `ad account rather than fixing the creative.`,
      verbatimReasons,
      attemptsRemaining: 0,
    };
  }

  if (verbatimReasons.length === 0) {
    return {
      disposition: 'QUARANTINE',
      action: 'NONE',
      pauseScope: 'ad',
      pageHuman: true,
      reason:
        'Disapproved with no readable reason in either ad_review_feedback.global or placement_specific. ' +
        'Regenerating blind spends a remediation attempt on a guess; check issues_info and the poll field list ' +
        'first, because "no reason given" usually means the reason was not read.',
      verbatimReasons,
      attemptsRemaining,
    };
  }

  return {
    disposition: 'RETRY',
    action: 'NEW_AD_IN_SAME_ADSET',
    pauseScope: 'ad',
    pageHuman: false,
    reason:
      `Ordinary policy disapproval, attempt ${context.lineage.attempts + 1} of ${MAX_REMEDIATION_ATTEMPTS}. ` +
      `Feed the verbatim reason strings to the rewriter, re-run the full pre-flight gate, then create a NEW ad ` +
      `in the SAME ad set and pause the disapproved one — editing is a significant edit and resets learning.`,
    verbatimReasons,
    attemptsRemaining,
  };
}
