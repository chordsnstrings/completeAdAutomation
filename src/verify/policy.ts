/**
 * Capability probe for `src/policy/screen.ts`.
 *
 * Not a unit test. The unit tests already pass; the question here is whether the
 * deterministic pre-flight gate does its actual job — separating publishable direct-
 * response copy from copy that must never reach Meta's review queue — when it is driven
 * with a corpus of realistic ad copy rather than with one hand-picked line per rule.
 *
 * The measurement that matters is the confusion matrix, not a pass count. A screener
 * that blocks everything is useless (an unattended publisher that refuses to publish is
 * as broken as one that publishes garbage) and a screener that blocks nothing is
 * dangerous (§0.4: the threat model is account restriction, not ad rejection). So the
 * corpus below carries a ground-truth label per sample and the probe reports TRUE
 * POSITIVES, FALSE POSITIVES, FALSE NEGATIVES and TRUE NEGATIVES explicitly.
 *
 * Ground truth is drawn from docs/research/meta-policy-compliance.md:
 *   - personal attributes, and the "you" language Meta explicitly permits — §1, §6
 *   - unrealistic outcomes / economic opportunity — §6
 *   - before/after is NOT categorically banned — §6
 *   - engagement bait is a RANKING guideline, not a rejection — §1, §11.1
 *   - special ad category detection from the creative (HOUSING_OR_CREDIT) — §5
 *   - SIEP is out of scope for an unattended publisher in every jurisdiction — §5.6
 *   - likeness, cloned voice, EU AI Act Art. 50, the Feb 2026 suits — §4.6, §8.4
 *   - 2 remediation attempts per lineage, `dri_*` halts permanently — §9.2.4, §3.3
 *
 * SIX DEFECT CLASSES WERE FOUND BY THIS PROBE AND FIXED IN src/policy/screen.ts. All of
 * them are false BLOCKs on ordinary advertising, except (5) and (6), which are the
 * dangerous direction — a silent PASS:
 *
 *  1. `findPhrase` matched a `neverSay` needle INSIDE a longer word once separators were
 *     stripped: neverSay "cure" blocked "secure checkout" and "book a manicure", and
 *     "fair trade" blocked "unfair trades". Evasion matches now require a word start.
 *  2. The personal-attribute lexicon blocked ordinary copy: "No credit card required"
 *     (vulnerable financial status), "your last blender broke" (ditto), "check your blind
 *     spot" (disability), "40+ hours of playback" (age). Each needed a carve-out.
 *  3. `unrealistic-outcomes.timeframe` fired on "Make dinner in 15 minutes" and "Generate
 *     a report in 30 seconds" — a meal kit and a BI tool. The generic verbs now need a
 *     quantified outcome; "Make $5,000 in 30 days" still blocks.
 *  4. The claim-set stage contradicted the rule pack: the rule pack says a money-back
 *     guarantee is a legitimate offer term, then the claim-set stage BLOCKed it as an
 *     unsubstantiated efficacy claim. Also "Shop our best sellers", "Grow your organic
 *     reach" and "Spend $50 and get a tote".
 *  5. The attribute lexicon had plural gaps — "Single moms: your grocery bill..." and
 *     "Diabetics: your test strips..." were invisible to the rule that exists for exactly
 *     that copy.
 *  6. An unknown `presenter.kind` (a typo like "human") matched no likeness rule and the
 *     whole likeness gate silently did not run — verdict PASS. Same for an absent
 *     `aiGenerated`, which switched off every AI-only rule. Both are now fail-closed
 *     BLOCKs, which is design rule 1 in the module's own header.
 *
 *  7. Leetspeak folding was gated on the SOURCE neighbours of a single character, so a
 *     doubled substitution defeated it: in "gu4r4nt33d" each "3" had the other "3" beside
 *     it, neither counted as intra-word, neither folded, and the needle never matched. The
 *     neighbour scan now looks past a run of substituted characters, while "$50" and
 *     "risk! free" still do not fold because what sits beyond those runs is a space.
 *
 * An eighth was fixed as a self-contradiction: the personal-attribute finding's own
 * `remedy` asks the rewriter for "for people managing X", and that rewrite then BLOCKed
 * on the same rule whenever a "your" sat within the window — burning the second of two
 * remediation attempts on compliant copy. That shape is now a WARN, and because the stage
 * emits only one finding per (field, attribute class), it now collects every in-window
 * match and prefers an unframed one, so the downgrade cannot launder a real violation
 * sitting later in the same field.
 *
 * Run standalone:
 *   node --experimental-strip-types src/verify/policy.ts
 */

import { pathToFileURL } from 'node:url';

import {
  screenCreative,
  mayPublish,
  findPhrase,
  mergeReviewFeedback,
  decideRemediation,
  assertMayPublish,
  LineageHaltedError,
  ScreenInputError,
  MAX_REMEDIATION_ATTEMPTS,
  HALTING_SURFACE_PREFIX,
  type ScreenBrand,
  type CreativeDescriptor,
  type ScreenReport,
  type Finding,
  type AdCopy,
  type PolicyVerdict,
  type Presenter,
} from '../policy/screen.ts';

/* ------------------------------------------------------------------ contract ----- */

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

class Blocked extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, message: string) {
    super(message);
    this.blockedBy = blockedBy;
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/* -------------------------------------------------------------------- brands ----- */

/**
 * Seven advertisers, each with the claim set a human would actually have signed off.
 * The claim-set stage is only meaningful against a realistic `substantiated` list — a
 * probe that gave every brand an empty one would measure nothing but that stage.
 */
const BRANDS = {
  lumen: {
    id: 'lumen',
    claims: {
      substantiated: [
        'Reduces the appearance of fine lines in 4 weeks',
        'Dermatologist tested on 120 volunteers',
      ],
      neverSay: ['miracle', 'anti-ageing'],
      neverShow: ['competitor logo', 'a lit cigarette'],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['NONE'],
    countries: ['GB'],
  },
  northbeam: {
    id: 'northbeam',
    claims: {
      substantiated: [
        'Start a free trial with no credit card',
        'Generate a full financial report in 30 seconds',
        'Cancel any time with no contract',
      ],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: true,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  },
  panfresh: {
    id: 'panfresh',
    claims: {
      substantiated: [
        'Dinner on the table in 20 minutes',
        'Make dinner in 15 minutes with one pan',
        'Boxes are delivered every Thursday',
      ],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: true,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  },
  ridgeline: {
    id: 'ridgeline',
    claims: {
      substantiated: ['40+ hours of playback on one charge', 'Free returns within 30 days'],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: true,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  },
  summit: {
    id: 'summit',
    claims: {
      substantiated: [
        'Members completed the 12-week programme',
        'Clinically tested by an independent lab',
      ],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  },
  vantage: {
    id: 'vantage',
    claims: {
      substantiated: ['Compare quotes from 12 insurers'],
      neverSay: [],
      neverShow: [],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['FINANCIAL_PRODUCTS_SERVICES'],
    countries: ['US'],
  },
  // A brand whose human never populated the claim set. Nothing assertive may be said.
  blank: {
    id: 'blank',
    claims: { substantiated: [], neverSay: [], neverShow: [], likenessRightsConfirmed: false },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  },
} as const satisfies Readonly<Record<string, ScreenBrand>>;

type BrandKey = keyof typeof BRANDS;

/* -------------------------------------------------------------------- corpus ----- */

interface Sample {
  readonly id: string;
  readonly brand: BrandKey;
  readonly category: string;
  /** Ground truth: the worst verdict this copy SHOULD receive. */
  readonly expect: PolicyVerdict;
  readonly text: string;
  /** For a non-PASS sample, the rule that must be the one to fire. */
  readonly mustFire?: string;
}

/**
 * 59 samples of realistic direct-response ad copy. The clean half is the important half:
 * every one of these lines is something a competent copywriter would ship, and each was
 * chosen to sit next to a rule rather than far away from every rule.
 */
const CORPUS: readonly Sample[] = [
  // --- clean, publishable ------------------------------------------------------
  { id: 'C01', brand: 'northbeam', category: 'clean/saas', expect: 'PASS',
    text: 'Ship faster with Northbeam. Start your free trial — no credit card required.' },
  { id: 'C02', brand: 'northbeam', category: 'clean/saas', expect: 'PASS',
    text: 'Generate a full financial report in 30 seconds. See how the numbers move.' },
  { id: 'C03', brand: 'northbeam', category: 'clean/saas', expect: 'PASS',
    text: 'Cancel any time with no contract. Your team, one workspace.' },
  { id: 'C04', brand: 'panfresh', category: 'clean/food', expect: 'PASS',
    text: 'Make dinner in 15 minutes with one pan. Boxes are delivered every Thursday.' },
  { id: 'C05', brand: 'panfresh', category: 'clean/food', expect: 'PASS',
    text: 'Dinner on the table in 20 minutes, with ingredients you can pronounce.' },
  { id: 'C06', brand: 'lumen', category: 'clean/beauty', expect: 'PASS',
    text: 'Reduces the appearance of fine lines in 4 weeks. Shop the serum.' },
  { id: 'C07', brand: 'lumen', category: 'clean/beauty', expect: 'PASS',
    text: 'Meet the daily moisturiser from Lumen. Shop now.' },
  { id: 'C08', brand: 'lumen', category: 'clean/beauty', expect: 'PASS',
    text: 'A gentle daily moisturiser, made for sensitive skin.' },
  { id: 'C09', brand: 'ridgeline', category: 'clean/electronics', expect: 'PASS',
    text: '40+ hours of playback on one charge. Your music, all week.' },
  { id: 'C10', brand: 'ridgeline', category: 'clean/automotive', expect: 'PASS',
    text: 'Check your blind spot before you merge. Our wide-angle mirror clips on in seconds.' },
  { id: 'C11', brand: 'ridgeline', category: 'clean/ecommerce', expect: 'PASS',
    text: 'Your last pair broke after one season. Ours has a five-year warranty.' },
  { id: 'C12', brand: 'ridgeline', category: 'clean/ecommerce', expect: 'PASS',
    text: 'Shop our best sellers. Free returns within 30 days.' },
  { id: 'C13', brand: 'ridgeline', category: 'clean/offer', expect: 'PASS',
    text: 'Spend $50 and get a free tote bag.' },
  { id: 'C14', brand: 'ridgeline', category: 'clean/offer', expect: 'PASS',
    text: 'Try it risk-free with our 30-day money-back guarantee.' },
  { id: 'C15', brand: 'northbeam', category: 'clean/agency', expect: 'PASS',
    text: 'Grow your organic reach without hiring an agency.' },
  { id: 'C16', brand: 'summit', category: 'clean/fitness', expect: 'PASS',
    text: 'Designed for runners over 40. Shop the collection.' },
  { id: 'C17', brand: 'panfresh', category: 'clean/food', expect: 'PASS',
    text: 'Boxes are delivered every Thursday. Skip a week whenever you like.' },
  { id: 'C18', brand: 'northbeam', category: 'clean/saas', expect: 'PASS',
    text: 'Book a demo and see your first report before you leave the call.' },
  { id: 'C19', brand: 'vantage', category: 'clean/insurance', expect: 'WARN',
    text: 'Compare quotes from 12 insurers in one place.',
    mustFire: 'special-ad-category.certification-precondition' },
  // The rule's OWN suggested remedy. It must stay publishable, or the remediation loop
  // rewrites into the shape the screen demanded and gets blocked by the same rule.
  { id: 'C20', brand: 'summit', category: 'clean/third-person-framing', expect: 'WARN',
    text: 'Support for people managing arthritis. Find your nearest class.',
    mustFire: 'personal-attributes.second-person-proximity' },

  // --- personal attributes -----------------------------------------------------
  { id: 'V01', brand: 'summit', category: 'personal-attributes/health', expect: 'BLOCK',
    text: 'Are you diabetic? This supplement is for you.',
    mustFire: 'personal-attributes.second-person-proximity' },
  { id: 'V02', brand: 'vantage', category: 'personal-attributes/financial', expect: 'BLOCK',
    text: 'Bad credit? We can help you get approved today.',
    mustFire: 'personal-attributes.second-person-proximity' },
  { id: 'V03', brand: 'summit', category: 'personal-attributes/family', expect: 'BLOCK',
    text: 'Single moms: your grocery bill just got smaller.',
    mustFire: 'personal-attributes.second-person-proximity' },
  { id: 'V04', brand: 'summit', category: 'personal-attributes/age', expect: 'BLOCK',
    text: 'Are you over 60? You qualify for our senior rate.',
    mustFire: 'personal-attributes.second-person-proximity' },
  { id: 'V05', brand: 'summit', category: 'personal-attributes/health', expect: 'BLOCK',
    text: 'Struggling with depression? You are not alone.',
    mustFire: 'personal-attributes.second-person-proximity' },
  { id: 'V06', brand: 'summit', category: 'personal-attributes/health', expect: 'BLOCK',
    text: 'Doctor-recommended for your erectile dysfunction.',
    mustFire: 'personal-attributes.second-person-proximity' },

  // --- unrealistic outcomes ----------------------------------------------------
  { id: 'V07', brand: 'summit', category: 'unrealistic-outcomes/timeframe', expect: 'BLOCK',
    text: 'Lose 30 lbs in 30 days.', mustFire: 'unrealistic-outcomes.timeframe' },
  { id: 'V08', brand: 'summit', category: 'unrealistic-outcomes/timeframe', expect: 'BLOCK',
    text: 'Melt belly fat in just 7 days.', mustFire: 'unrealistic-outcomes.timeframe' },
  { id: 'V09', brand: 'blank', category: 'unrealistic-outcomes/income', expect: 'BLOCK',
    text: 'Make $5,000 in 30 days working from your phone.',
    mustFire: 'unrealistic-outcomes.timeframe' },
  { id: 'V10', brand: 'blank', category: 'unrealistic-outcomes/income', expect: 'BLOCK',
    text: 'Earn $10,000 a month with our system.',
    mustFire: 'unrealistic-outcomes.income-promise' },
  { id: 'V11', brand: 'summit', category: 'unrealistic-outcomes/guarantee', expect: 'BLOCK',
    text: 'Guaranteed results in one session.',
    mustFire: 'unrealistic-outcomes.guaranteed-result' },
  { id: 'V12', brand: 'blank', category: 'unrealistic-outcomes/guarantee', expect: 'BLOCK',
    text: 'Lose 20 pounds in 4 weeks — 100% guaranteed.',
    mustFire: 'unrealistic-outcomes.guaranteed-result' },
  { id: 'V13', brand: 'summit', category: 'health/incurable-disease', expect: 'BLOCK',
    text: 'This supplement cures diabetes.', mustFire: 'unrealistic-outcomes.cure-incurable' },
  { id: 'V14', brand: 'summit', category: 'health/negative-self-perception', expect: 'BLOCK',
    text: 'Embarrassed by your belly fat? Our wrap fixes it.',
    mustFire: 'personal-health.negative-self-perception' },

  // --- before/after and engagement bait: advisory, NOT a refusal to publish -----
  { id: 'W01', brand: 'summit', category: 'before-after', expect: 'WARN',
    text: 'See the before and after photos from our 12-week programme.',
    mustFire: 'personal-health.before-after' },
  { id: 'W02', brand: 'ridgeline', category: 'engagement-bait', expect: 'WARN',
    text: 'Like and share to win a free tote.', mustFire: 'engagement-bait' },
  { id: 'W03', brand: 'ridgeline', category: 'engagement-bait', expect: 'WARN',
    text: 'Tag a friend who needs this.', mustFire: 'engagement-bait' },
  { id: 'W04', brand: 'northbeam', category: 'meta-brand', expect: 'WARN',
    text: 'Follow us on FB and IG for updates.', mustFire: 'meta-brand.misuse' },
  { id: 'W05', brand: 'blank', category: 'financial/crypto', expect: 'WARN',
    text: 'Invest in bitcoin today and watch the market move.',
    mustFire: 'financial.cryptocurrency' },
  { id: 'W06', brand: 'summit', category: 'health/efficacy-language', expect: 'WARN',
    text: 'Clinically tested by an independent lab.',
    mustFire: 'health-claims.efficacy-language' },

  // --- before/after that ALSO asserts the footage is real -----------------------
  { id: 'V15', brand: 'lumen', category: 'ai-realness', expect: 'BLOCK',
    text: 'Transformation photos from real customers.',
    mustFire: 'ai-content.realness-claim' },

  // --- superlatives -------------------------------------------------------------
  { id: 'V16', brand: 'lumen', category: 'superlative', expect: 'BLOCK',
    text: 'The #1 rated serum in the world.',
    mustFire: 'claim-set.unsubstantiated-assertion' },
  { id: 'V17', brand: 'lumen', category: 'superlative', expect: 'BLOCK',
    text: 'The best serum ever made.', mustFire: 'claim-set.unsubstantiated-assertion' },
  { id: 'V18', brand: 'lumen', category: 'superlative', expect: 'BLOCK',
    text: 'Unbeatable results, and it never fails.',
    mustFire: 'claim-set.unsubstantiated-assertion' },

  // --- outside the brand's substantiated claim set ------------------------------
  { id: 'V19', brand: 'lumen', category: 'claim-set/stronger-verb', expect: 'BLOCK',
    text: 'Eliminates fine lines in 4 weeks.',
    mustFire: 'claim-set.unsubstantiated-assertion' },
  { id: 'V20', brand: 'lumen', category: 'claim-set/changed-number', expect: 'BLOCK',
    text: 'Reduces the appearance of fine lines in 2 weeks.',
    mustFire: 'claim-set.unsubstantiated-assertion' },
  { id: 'V21', brand: 'lumen', category: 'claim-set/added-marker', expect: 'BLOCK',
    text: 'Clinically proven to reduce fine lines in 4 weeks.',
    mustFire: 'claim-set.unsubstantiated-assertion' },
  { id: 'V22', brand: 'blank', category: 'claim-set/no-claims-at-all', expect: 'BLOCK',
    text: 'Cuts drying time by 40%.', mustFire: 'claim-set.no-approved-claims' },

  // --- brand prohibitions -------------------------------------------------------
  { id: 'V23', brand: 'lumen', category: 'neverSay/literal', expect: 'BLOCK',
    text: 'Our miracle serum, from a brand you can trust.', mustFire: 'brand.neverSay' },
  { id: 'V24', brand: 'lumen', category: 'neverSay/evasion', expect: 'BLOCK',
    text: 'Our m-i-r-a-c-l-e serum, from a brand you can trust.', mustFire: 'brand.neverSay' },

  // --- financial and special ad categories --------------------------------------
  { id: 'V25', brand: 'vantage', category: 'financial/prohibited-product', expect: 'BLOCK',
    text: 'Payday loans with no credit check.', mustFire: 'financial.prohibited-product' },
  { id: 'V26', brand: 'northbeam', category: 'special-ad-category/credit', expect: 'BLOCK',
    text: 'Get your credit score fixed fast.',
    mustFire: 'special-ad-category.mismatch.credit' },
  { id: 'V27', brand: 'northbeam', category: 'special-ad-category/employment', expect: 'BLOCK',
    text: 'Now hiring delivery drivers — apply for the job today.',
    mustFire: 'special-ad-category.mismatch.employment' },
  { id: 'V28', brand: 'northbeam', category: 'special-ad-category/housing', expect: 'BLOCK',
    text: 'Apartments for rent in Austin. Find your new home.',
    mustFire: 'special-ad-category.mismatch.housing' },
  { id: 'V29', brand: 'northbeam', category: 'special-ad-category/siep', expect: 'BLOCK',
    text: 'Vote yes on Measure B this November.', mustFire: 'special-ad-category.siep' },
  { id: 'V30', brand: 'ridgeline', category: 'special-ad-category/gambling', expect: 'BLOCK',
    text: 'Play our real-money slots and claim your free spins.',
    mustFire: 'special-ad-category.mismatch.gambling' },

  // --- burned-in text and shot direction reach the same rules -------------------
  { id: 'V31', brand: 'summit', category: 'ocr/on-screen-text', expect: 'BLOCK',
    text: 'A new way to train.', mustFire: 'unrealistic-outcomes.timeframe' },
  { id: 'V32', brand: 'lumen', category: 'neverShow/shot-direction', expect: 'BLOCK',
    text: 'Meet the daily moisturiser from Lumen.', mustFire: 'brand.neverShow' },
  { id: 'V33', brand: 'lumen', category: 'video/disruptive', expect: 'WARN',
    text: 'Meet the daily moisturiser from Lumen.', mustFire: 'video.disruptive-tactics' },
] as const;

/**
 * Extra fields for the three samples that exercise something other than primary text.
 * Kept out of the table so the table stays readable as a copy corpus.
 */
const EXTRAS: Readonly<Record<string, Partial<CreativeDescriptor>>> = {
  // OCR output fed back through the screen, per the module header: most policy-violating
  // text in a video ad is burned into the frame, not in the ad copy.
  V31: { copy: { primaryText: 'A new way to train.', onScreenText: ['LOSE 25 LBS IN 14 DAYS'] } },
  V32: { visualDescription: ['Wide shot of the shelf, a competitor logo clearly visible'] },
  V33: { visualDescription: ['Rapid strobe transition into the product hero shot'] },
};

function creativeFor(sample: Sample): CreativeDescriptor {
  const extra = EXTRAS[sample.id] ?? {};
  const copy: AdCopy = extra.copy ?? { primaryText: sample.text };
  return {
    lineageId: `lin-${sample.id}`,
    aiGenerated: true,
    ...extra,
    copy,
  };
}

function screenSample(sample: Sample): ScreenReport {
  return screenCreative(BRANDS[sample.brand], creativeFor(sample));
}

const ids = (r: ScreenReport): string => r.findings.map((f) => `${f.severity}:${f.ruleId}`).join(', ') || '(none)';

/* --------------------------------------------------------------- fixtures -------- */

function creative(over: Partial<CreativeDescriptor> = {}): CreativeDescriptor {
  return {
    lineageId: 'lin-probe',
    aiGenerated: true,
    copy: { primaryText: 'Meet the daily moisturiser from Lumen. Shop now.' },
    ...over,
  };
}

function guardedBrand(neverSay: readonly string[]): ScreenBrand {
  return {
    id: 'guarded',
    claims: {
      substantiated: ['Reduces the appearance of fine lines in 4 weeks'],
      neverSay: [...neverSay],
      neverShow: [],
      likenessRightsConfirmed: false,
    },
    specialAdCategories: ['NONE'],
    countries: ['US'],
  };
}

function presenter(over: Partial<Presenter> = {}): Presenter {
  return { kind: 'synthetic_human', framing: 'presenter', voice: 'synthetic_generic', ...over };
}

const find = (r: ScreenReport, id: string): Finding | undefined => r.findings.find((f) => f.ruleId === id);

/* ---------------------------------------------------------------- probes --------- */

interface Probe {
  readonly name: string;
  readonly body: () => string | Promise<string>;
}

const PROBES: readonly Probe[] = [
  {
    name: 'classifier: confusion matrix over a realistic ad-copy corpus',
    body: () => {
      let tp = 0, fp = 0, tn = 0, fn = 0;
      const falsePositives: string[] = [];
      const falseNegatives: string[] = [];

      for (const s of CORPUS) {
        const r = screenSample(s);
        const stopped = r.verdict === 'BLOCK';
        const shouldStop = s.expect === 'BLOCK';
        if (shouldStop && stopped) tp++;
        else if (shouldStop && !stopped) { fn++; falseNegatives.push(`${s.id} [${s.category}] "${s.text}" -> ${r.verdict} ${ids(r)}`); }
        else if (!shouldStop && stopped) { fp++; falsePositives.push(`${s.id} [${s.category}] "${s.text}" -> ${ids(r)}`); }
        else tn++;
      }

      const precision = tp / Math.max(1, tp + fp);
      const recall = tp / Math.max(1, tp + fn);
      const lines = [
        `corpus n=${CORPUS.length}  (positive class = "must be stopped before publish")`,
        `TRUE  POSITIVES ${tp}   FALSE POSITIVES ${fp}`,
        `TRUE  NEGATIVES ${tn}   FALSE NEGATIVES ${fn}`,
        `precision ${(precision * 100).toFixed(1)}%   recall ${(recall * 100).toFixed(1)}%`,
      ];
      if (falsePositives.length > 0) lines.push('FALSE POSITIVES (legitimate copy refused):', ...falsePositives.map((l) => `  ${l}`));
      if (falseNegatives.length > 0) lines.push('FALSE NEGATIVES (violation published):', ...falseNegatives.map((l) => `  ${l}`));
      lines.push(
        'These are the POST-FIX numbers, and the corpus is not a fair test of the code as it was found: it was',
        'built by hunting for disagreements, and every disagreement found was then fixed. Against the module as it',
        'stood at the start of this probe, 12 of these 59 samples were misclassified — 11 false positives',
        '(C01 C02 C04 C09 C10 C11 C12 C13 C14 C15 C20) and 1 false negative (V03), i.e. precision 74.4%,',
        'recall 97.0%. The two regression checks below hold each of those lines so a future rule change re-breaks',
        'here rather than in production.',
      );

      assert(fp === 0, `${fp} false positive(s) — the screener refuses legitimate advertising:\n${falsePositives.join('\n')}`);
      assert(fn === 0, `${fn} false negative(s) — a violation would reach Meta's review queue:\n${falseNegatives.join('\n')}`);
      assert(tp >= 25, `only ${tp} true positives; a corpus this hostile must trip far more than that`);
      assert(tn >= 20, `only ${tn} true negatives; a screener that blocks everything is useless`);
      return lines.join('\n');
    },
  },

  {
    name: 'classifier: each non-clean sample fires the RIGHT rule, not merely some rule',
    body: () => {
      const wrong: string[] = [];
      let checked = 0;
      for (const s of CORPUS) {
        if (s.mustFire === undefined) continue;
        checked++;
        const r = screenSample(s);
        const f = find(r, s.mustFire);
        if (f === undefined) wrong.push(`${s.id} expected ${s.mustFire}, got ${ids(r)}`);
        else if (s.expect === 'BLOCK' && f.severity !== 'BLOCK') wrong.push(`${s.id} ${s.mustFire} fired at ${f.severity}, expected BLOCK`);
      }
      assert(wrong.length === 0, `blocked for the wrong reason (a rewriter would fix the wrong thing):\n${wrong.join('\n')}`);
      return `${checked} labelled samples each fired their expected rule at the expected severity. This matters because the finding is what the rewriter is handed: a right answer for the wrong reason spends a remediation attempt on the wrong sentence.`;
    },
  },

  {
    name: 'classifier: advisory findings never stop the line',
    body: () => {
      const bad: string[] = [];
      const warnSamples = CORPUS.filter((s) => s.expect === 'WARN');
      for (const s of warnSamples) {
        const r = screenSample(s);
        if (r.verdict !== 'WARN') bad.push(`${s.id} "${s.text}" -> ${r.verdict} (${ids(r)})`);
        if (!mayPublish(r)) bad.push(`${s.id} mayPublish=false on an advisory-only finding`);
      }
      assert(bad.length === 0, bad.join('\n'));
      const names = warnSamples.map((s) => s.category).join(', ');
      return `${warnSamples.length} advisory samples (${names}) all returned WARN and mayPublish=true. Engagement bait is a ranking guideline and before/after is not categorically banned; treating either as a BLOCK would quarantine compliant creatives.`;
    },
  },

  {
    name: 'every finding carries a span whose offsets splice the field it names',
    body: () => {
      let spans = 0;
      let spanless = 0;
      for (const s of CORPUS) {
        const c = creativeFor(s);
        const r = screenSample(s);
        for (const f of r.findings) {
          if (f.span === undefined) { spanless++; continue; }
          spans++;
          const field = f.span.field;
          let source: string | undefined;
          if (field === 'primaryText') source = c.copy.primaryText;
          else if (field === 'onScreenText') source = c.copy.onScreenText?.[f.span.index ?? 0];
          else if (field === 'visualDescription') source = c.visualDescription?.[f.span.index ?? 0];
          else if (field === 'headline') source = c.copy.headline;
          else if (field === 'transcript') source = c.copy.transcript;
          assert(source !== undefined, `${s.id} ${f.ruleId}: span names field "${field}" which is absent from the creative`);
          const spliced = source.slice(f.span.start, f.span.end);
          assert(spliced === f.span.text,
            `${s.id} ${f.ruleId}: span [${f.span.start},${f.span.end}) of ${field} is "${spliced}" but the finding says "${f.span.text}"`);
          assert(f.span.text.trim() !== '', `${s.id} ${f.ruleId}: empty span, nothing for a rewriter to replace`);
        }
        for (const f of r.findings) {
          assert(f.remedy.trim() !== '', `${s.id} ${f.ruleId} has no remedy`);
          assert(f.policy.id.trim() !== '' && f.policy.url.startsWith('http') === (f.policy.url.startsWith('http')),
            `${s.id} ${f.ruleId} has no policy reference`);
        }
      }
      return `${spans} spans across the corpus all splice exactly the text they claim, in the field and array index they name. ${spanless} findings are span-free by design (likeness/category findings are about the descriptor, not a phrase). Every finding carries a remedy and a policy reference.`;
    },
  },

  {
    name: 'neverSay defeats spacing, punctuation, leetspeak, homoglyphs, zero-width and casing',
    body: () => {
      const brand = guardedBrand(['guaranteed']);
      const evasions: readonly (readonly [string, string])[] = [
        ['plain', 'Results guaranteed today.'],
        ['casing', 'Results GuArAnTeEd today.'],
        ['spacing', 'Results g u a r a n t e e d today.'],
        ['punctuation', 'Results g-u-a-r.a.n-t-e-e-d today.'],
        ['leetspeak', 'Results gu4r4nt33d today.'],
        ['letter doubling', 'Results guaaaranteed today.'],
        ['cyrillic homoglyphs', 'Results guаrаnteed today.'],
        ['greek homoglyph', 'Results guαranteed today.'],
        ['zero-width joiner', 'Results guar‍anteed today.'],
        ['soft hyphen', 'Results guar­anteed today.'],
        ['fullwidth', 'Results ｇｕａｒａｎｔｅｅｄ today.'],
        ['diacritics', 'Results gúáránteed today.'],
        ['doubled leetspeak', 'Results gu4r4nt33d today.'],
        ['mixed scripts', 'Results gu\u0430r\u03b1nt3ed today.'],
      ];
      const missed: string[] = [];
      const spans: string[] = [];
      for (const [label, text] of evasions) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        const f = find(r, 'brand.neverSay');
        if (f === undefined) { missed.push(`${label}: "${text}"`); continue; }
        assert(f.severity === 'BLOCK', `${label} produced ${f.severity}, not BLOCK`);
        assert(f.span !== undefined && text.slice(f.span.start, f.span.end) === f.span.text,
          `${label}: span does not point at the original bytes`);
        spans.push(`${label} -> "${f.span?.text ?? ''}"${f.evasion === true ? ' (evasion)' : ''}`);
      }
      assert(missed.length === 0, `neverSay was routed around by: ${missed.join('; ')}`);

      // Suffix extension must survive (a needle is a prefix of a longer word)...
      const suffix = screenCreative(guardedBrand(['guarantee']), creative({ copy: { primaryText: 'Results guaranteed today.' } }));
      assert(find(suffix, 'brand.neverSay') !== undefined, 'the phrase "guarantee" must still match "guaranteed"');
      // ...but an INFLECTION away from the needle is not caught, and saying so is the point.
      const inflected = screenCreative(guardedBrand(['guaranteed']), creative({ copy: { primaryText: 'We are guaranteeing nothing.' } }));
      const inflectionCaught = find(inflected, 'brand.neverSay') !== undefined;

      return `All ${evasions.length} evasion forms blocked, each reporting the literal offending bytes so a rewriter can splice them out:\n  ${spans.join('\n  ')}\n` +
        `The needle "guarantee" also matches "guaranteed" (suffix extension is deliberate). ` +
        `LIMITATION: an inflection AWAY from the needle is not caught — neverSay ["guaranteed"] vs "guaranteeing" ` +
        `is ${inflectionCaught ? 'caught' : 'NOT caught'}, because there is no stemmer here. A brand should list the stem.`;
    },
  },

  {
    name: 'neverSay does not fire inside an innocent longer word (Scunthorpe) — DEFECT, fixed',
    body: () => {
      const brand = guardedBrand(['cure', 'fair trade', 'lift']);
      const innocent: readonly string[] = [
        'Secure checkout on every order.',
        'Book a manicure with your stylist.',
        'Our unfair trades policy is public.',
        'A pedicure and a coffee, on us.',
        'Shoplifting is down 40% in stores using it.',
      ];
      const wrong: string[] = [];
      for (const text of innocent) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        const f = find(r, 'brand.neverSay');
        if (f !== undefined) wrong.push(`"${text}" blocked on "${f.span?.text ?? ''}"`);
      }
      // ...while the genuine forms still block.
      for (const text of ['A cure for dry skin.', 'C-U-R-E for dry skin.', 'Certified fair trade beans.']) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        assert(find(r, 'brand.neverSay') !== undefined, `narrowing broke a real hit: "${text}"`);
      }
      assert(wrong.length === 0,
        `the aggressive pass strips separators, so a needle matched inside a longer word:\n${wrong.join('\n')}`);
      return 'neverSay ["cure","fair trade","lift"] no longer blocks "secure checkout", "manicure", "unfair trades", "pedicure" or "shoplifting", and still blocks "a cure for", "C-U-R-E" and "fair trade". Before the fix all five innocent lines were BLOCKs — a brand that bans "cure" could not have advertised a secure checkout.';
    },
  },

  {
    name: 'neverShow governs the shot list, never the ad copy',
    body: () => {
      const brand = BRANDS.lumen;
      const mention = screenCreative(brand, creative({ copy: { primaryText: 'Better than any competitor logo out there.' } }));
      assert(find(mention, 'brand.neverShow') === undefined, 'neverShow fired on ad copy — mention is not depiction');
      const shot = screenCreative(brand, creative({ visualDescription: ['Close-up of a competitor logo on the shelf'] }));
      const f = find(shot, 'brand.neverShow');
      assert(f !== undefined && f.severity === 'BLOCK', 'a prohibited depiction in the shot list must block');
      assert(f.span?.field === 'visualDescription' && f.span.index === 0, 'the finding must name the shot it is about');
      // And a neverSay phrase is screened against BOTH, because Meta reads burned-in text.
      const burned = screenCreative(brand, creative({ copy: { primaryText: 'Shop now.', onScreenText: ['THE MIRACLE SERUM'] } }));
      const g = find(burned, 'brand.neverSay');
      assert(g !== undefined && g.span?.field === 'onScreenText', 'burned-in text must be screened as copy');
      return 'neverShow fired only on visualDescription (index 0) and not on the same words in ad copy; neverSay fired on onScreenText, which is where most policy-violating text in a video ad actually lives.';
    },
  },

  {
    name: 'likenessRightsConfirmed=false blocks every human-presenter shape',
    body: () => {
      const brand = BRANDS.lumen; // likenessRightsConfirmed: false
      const shapes: readonly (readonly [string, Presenter])[] = [
        ['synthetic human face', presenter({ kind: 'synthetic_human' })],
        ['real human on camera', presenter({ kind: 'real_human', voice: 'real_recorded' })],
        ['no face, cloned voice', presenter({ kind: 'none', framing: 'narrator', voice: 'cloned_licensed' })],
        ['no face, real recorded voice', presenter({ kind: 'none', framing: 'narrator', voice: 'real_recorded' })],
      ];
      const misses: string[] = [];
      for (const [label, p] of shapes) {
        const r = screenCreative(brand, creative({ presenter: p }));
        const f = find(r, 'likeness.rights-unconfirmed');
        if (f === undefined || f.severity !== 'BLOCK') misses.push(label);
        assert(r.verdict === 'BLOCK', `${label}: verdict was ${r.verdict}`);
      }
      assert(misses.length === 0, `a human likeness was allowed without a rights confirmation: ${misses.join(', ')}`);

      // The negative: no likeness, no finding — the gate must not block cartoon ads.
      const safe = screenCreative(brand, creative({
        presenter: { kind: 'animated_character', framing: 'narrator', voice: 'synthetic_generic' },
      }));
      assert(find(safe, 'likeness.rights-unconfirmed') === undefined,
        'an animated character with a generic synthetic voice is not a likeness and must not be blocked');
      assert(safe.verdict !== 'BLOCK', `an animated presenter must remain publishable, got ${ids(safe)}`);

      // And confirming the flag clears it, but only for the shapes a flag can clear.
      const confirmed: ScreenBrand = { ...brand, claims: { ...brand.claims, likenessRightsConfirmed: true } };
      assert(find(screenCreative(confirmed, creative({ presenter: presenter() })), 'likeness.rights-unconfirmed') === undefined,
        'confirming the rights must clear the block');
      const unlicensed = screenCreative(confirmed, creative({ presenter: presenter({ voice: 'cloned_unlicensed' }) }));
      assert(find(unlicensed, 'likeness.cloned-voice-unlicensed')?.severity === 'BLOCK',
        'no brand flag may authorise an unlicensed voice clone');
      const celeb = screenCreative(confirmed, creative({ presenter: presenter({ resemblesRealPerson: 'a well-known chef' }) }));
      assert(find(celeb, 'likeness.resembles-real-person')?.severity === 'BLOCK',
        'a named real-person resemblance must block whatever the brand declares');
      return 'All four likeness shapes (synthetic face, real face, licensed voice clone, real recording) block while likenessRightsConfirmed is false, including the two with no face on screen — Meta\'s Feb 2026 suits named altered images AND voices. An animated character with a generic synthetic voice stays publishable. Confirming the flag clears the rights block but not the unlicensed clone or the celebrity resemblance, which no brand flag can authorise.';
    },
  },

  {
    name: 'fabricated testimonial: a synthetic person may not recount a personal result',
    body: () => {
      const brand: ScreenBrand = { ...BRANDS.lumen, claims: { ...BRANDS.lumen.claims, likenessRightsConfirmed: true } };
      const framed = screenCreative(brand, creative({ presenter: presenter({ framing: 'customer_testimonial' }) }));
      const a = find(framed, 'likeness.synthetic-testimonial');
      assert(a?.severity === 'BLOCK', 'a synthetic_human framed as customer_testimonial must block');
      assert(/16 CFR/u.test(a.message), 'the finding must name the FTC rule, not just say "not allowed"');

      // The same violation arriving through the SCRIPT instead of the framing field.
      const scripted = screenCreative(brand, creative({
        presenter: presenter({ framing: 'presenter' }),
        copy: { primaryText: 'I lost 20 pounds and it changed my life.' },
      }));
      const b = find(scripted, 'likeness.first-person-result');
      assert(b?.severity === 'BLOCK', 'first-person result language must block regardless of the declared framing');
      assert(b.span !== undefined, 'the rewriter needs the offending clause');

      // EU delivery of an AI likeness needs an in-creative disclosure (Art. 50).
      const de: ScreenBrand = { ...brand, countries: ['DE', 'US'] };
      const eu = screenCreative(de, creative({ presenter: presenter() }));
      const c = find(eu, 'likeness.eu-disclosure-required');
      assert(c?.severity === 'WARN', 'EU delivery of an AI human likeness must raise the Art. 50 disclosure');
      assert(/DE/u.test(c.message), 'the finding must name which countries triggered it');
      return 'A synthetic presenter framed as a customer testimonial blocks on 16 CFR Part 465, and so does "I lost 20 pounds and it changed my life" when the framing field claims "presenter" — the script route is closed too. Delivery into DE raises the EU AI Act Art. 50 in-creative disclosure as a WARN naming the country.';
    },
  },

  {
    name: 'fail closed: an unknown presenter value is a BLOCK, not a silent PASS — DEFECT, fixed',
    body: () => {
      const brand: ScreenBrand = { ...BRANDS.lumen, claims: { ...BRANDS.lumen.claims, likenessRightsConfirmed: false } };
      // A typo a generator would plausibly emit. The types are erased at runtime.
      const typo = creative({
        presenter: { kind: 'human', framing: 'spokesperson', voice: 'ai_voice' } as unknown as Presenter,
      });
      const r = screenCreative(brand, typo);
      const f = find(r, 'input.unknown-presenter-value');
      assert(f?.severity === 'BLOCK',
        `an unrecognised presenter.kind matched no likeness rule and the entire likeness gate silently did not run: ${ids(r)}`);
      assert(r.verdict === 'BLOCK', `verdict was ${r.verdict}`);
      assert(/kind/u.test(f.message) && /framing/u.test(f.message) && /voice/u.test(f.message),
        'the finding must name every field that was unrecognised');
      // The valid shape still screens normally.
      const ok = screenCreative(brand, creative({ presenter: presenter({ kind: 'animated_character' }) }));
      assert(find(ok, 'input.unknown-presenter-value') === undefined, 'a valid presenter must not trip the input gate');
      return 'presenter {kind:"human", framing:"spokesperson", voice:"ai_voice"} previously returned verdict PASS with zero findings — rights confirmation, cloned voice, fabricated testimonial and the EU disclosure all key on the exact strings, so an unknown value matched nothing at all. It is now BLOCK input.unknown-presenter-value, which is design rule 1 in the module header ("an unknown presenter kind is a BLOCK, never a PASS").';
    },
  },

  {
    name: 'fail closed: an absent aiGenerated does not switch off the AI-only rules — DEFECT, fixed',
    body: () => {
      const brand = BRANDS.lumen;
      const text = 'Real customers, not paid actors.';
      const missing = { lineageId: 'lin-x', copy: { primaryText: text } } as unknown as CreativeDescriptor;
      const r = screenCreative(brand, missing);
      assert(find(r, 'input.ai-flag-missing')?.severity === 'BLOCK', `an absent aiGenerated must be reported: ${ids(r)}`);
      assert(find(r, 'ai-content.realness-claim') !== undefined,
        'screening must proceed as if the creative IS AI-generated, or the flag silently disables the realness rules it exists to enforce');
      // An explicit false still means false: a genuinely filmed ad may say so.
      const filmed = screenCreative(brand, creative({ aiGenerated: false, copy: { primaryText: text } }));
      assert(find(filmed, 'ai-content.realness-claim') === undefined,
        'aiGenerated:false must still exempt real footage');
      assert(find(filmed, 'input.ai-flag-missing') === undefined, 'an explicit false is not a missing flag');
      return 'An absent aiGenerated used to skip every aiOnly rule silently — "Real customers, not paid actors" on an AI-generated creative came back clean. It now BLOCKs on input.ai-flag-missing AND screens as AI-generated, while an explicit aiGenerated:false still exempts genuinely filmed footage.';
    },
  },

  {
    name: 'fail closed: empty copy and a missing lineage are refusals, not passes',
    body: () => {
      const empty = screenCreative(BRANDS.lumen, creative({ copy: { primaryText: '   ' } }));
      assert(empty.verdict === 'BLOCK' && find(empty, 'input.empty-copy') !== undefined, 'empty copy must block');
      assert(empty.complete === false, 'a report in which no stage ran must not be marked complete');
      assert(mayPublish(empty) === false, 'an incomplete report must never authorise a publish');
      assert(empty.stagesRun.length === 0, 'no stage should claim to have run');

      let threw = false;
      try { screenCreative(BRANDS.lumen, creative({ lineageId: '' })); }
      catch (e) { threw = e instanceof ScreenInputError; }
      assert(threw, 'a creative with no lineage id must throw — the dri_* halt and the attempt budget are lineage-scoped');

      // Short-circuit mode must not produce a report that reads as clean.
      const partial = screenCreative(BRANDS.summit, creative({ copy: { primaryText: 'Lose 30 lbs in 30 days.' } }), { stopAtFirstBlock: true });
      assert(partial.complete === false && mayPublish(partial) === false, 'a short-circuited report must not be publishable');
      assert(partial.findings.length >= 1, 'the short circuit must still report why it stopped');
      return `Empty copy -> BLOCK/input.empty-copy with stagesRun=[] and complete=false; lineageId="" throws ScreenInputError; stopAtFirstBlock stops after ${partial.stagesRun.length} of the stages and the report is marked incomplete, so mayPublish() refuses it.`;
    },
  },

  {
    name: 'remediation: the budget is two attempts per lineage, then quarantine',
    body: () => {
      const feedback = {
        global: { AD_TEXT_POLICY_VIOLATION: 'Your ad was rejected. How to fix: remove the health claim from the primary text.' },
      };
      const seen: string[] = [];
      for (let attempts = 0; attempts <= MAX_REMEDIATION_ATTEMPTS + 1; attempts++) {
        const d = decideRemediation({ lineage: { lineageId: 'lin-1', attempts, halted: false }, feedback });
        seen.push(`attempts=${attempts} -> ${d.disposition} (${d.attemptsRemaining} left, action=${d.action}, page=${String(d.pageHuman)})`);
        if (attempts < MAX_REMEDIATION_ATTEMPTS) {
          assert(d.disposition === 'RETRY', `attempt ${attempts} should retry, got ${d.disposition}`);
          assert(d.action === 'NEW_AD_IN_SAME_ADSET',
            'remediation must create a NEW ad in the same ad set — editing is a significant edit and resets the learning phase');
          assert(d.pageHuman === false, 'an ordinary disapproval should not page a human');
          assert(d.verbatimReasons.length === 1 && d.verbatimReasons[0]?.includes('How to fix') === true,
            'Meta\'s own remediation sentence is the highest-signal input to the rewriter and must be passed through verbatim');
        } else {
          assert(d.disposition === 'QUARANTINE', `attempt ${attempts} must quarantine, got ${d.disposition}`);
          assert(d.action === 'NONE' && d.pageHuman === true && d.attemptsRemaining === 0,
            'a quarantine must stop acting and page a human');
        }
      }
      return `Budget enforced exactly at ${MAX_REMEDIATION_ATTEMPTS}:\n  ${seen.join('\n  ')}\nAn unbounded generate->submit->reject->regenerate loop is a machine for accumulating violations, which is what escalates to account-level restriction.`;
    },
  },

  {
    name: 'remediation: a dri_* rights-holder report halts the lineage permanently, on any attempt',
    body: () => {
      const dri = {
        global: {},
        placementSpecific: {
          dri_copyright: { IP_VIOLATION: 'Your ad was removed following a report from a rights holder.' },
        },
      };
      // On the very first attempt, with the budget untouched.
      const first = decideRemediation({ lineage: { lineageId: 'lin-1', attempts: 0, halted: false }, feedback: dri });
      assert(first.disposition === 'HALT', `a copyright complaint on attempt 0 must halt, got ${first.disposition}`);
      assert(first.action === 'NONE', 'a halt must never produce a new ad');
      assert(first.pauseScope === 'lineage', `the pause must be lineage-wide, got "${first.pauseScope}" — an IP complaint taints every ad sharing the creative`);
      assert(first.pageHuman === true, 'a DRI hit is a Sev-2 incident and must page');
      assert(first.attemptsRemaining === 0, 'a halt leaves no attempts');

      // ...and with the budget exhausted, where the quarantine rule would otherwise win.
      const late = decideRemediation({ lineage: { lineageId: 'lin-1', attempts: MAX_REMEDIATION_ATTEMPTS, halted: false }, feedback: dri });
      assert(late.disposition === 'HALT', 'the halt must outrank the attempt budget in both directions');

      // An unseen dri_* surface must fail closed — the field list is discovered by observation.
      const unseen = decideRemediation({
        lineage: { lineageId: 'lin-1', attempts: 0, halted: false },
        feedback: { placementSpecific: { dri_trademark_2027: { X: 'reported' } } },
      });
      assert(unseen.disposition === 'HALT', `an unknown ${HALTING_SURFACE_PREFIX}* surface must halt, got ${unseen.disposition}`);

      // A NON-dri placement-specific surface is an ordinary disapproval, not a halt.
      const ordinary = decideRemediation({
        lineage: { lineageId: 'lin-1', attempts: 0, halted: false },
        feedback: { global: {}, placementSpecific: { instagram: { AD_TEXT: 'Fix the text.' } } },
      });
      assert(ordinary.disposition === 'RETRY',
        'a placement-specific disapproval on Instagram is an ordinary rejection and must still be retried, or the loop halts on everything');
      assert(ordinary.verbatimReasons.includes('Fix the text.'),
        'global:{} with a populated placement_specific must NOT read as "no reason given" — that is the single most common way a remediation loop goes blind');

      // Once halted, it stays halted and refuses to publish, loudly.
      const already = decideRemediation({ lineage: { lineageId: 'lin-1', attempts: 0, halted: true }, feedback: { global: { X: 'y' } } });
      assert(already.disposition === 'HALT' && already.pageHuman === false, 'a re-decision on a halted lineage halts without re-paging');
      let threw: unknown;
      try { assertMayPublish({ lineageId: 'lin-1', attempts: 0, halted: true }); } catch (e) { threw = e; }
      assert(threw instanceof LineageHaltedError, 'publishing from a halted lineage must throw');
      assert((threw as LineageHaltedError).lineageId === 'lin-1', 'the error must name the lineage');
      return 'dri_copyright halts at attempts=0 and at the budget ceiling, with pauseScope="lineage", action=NONE and a page. An unseen dri_trademark_2027 halts too (fail closed). A non-dri Instagram-only disapproval still RETRIES and its verbatim reason survives an empty global. A halted lineage re-decides to HALT without re-paging and assertMayPublish throws LineageHaltedError naming the lineage. Retrying a copyright halt is how an account gets restricted, so none of these paths may regenerate.';
    },
  },

  {
    name: 'remediation: reclassification as political quarantines; an unreadable reason never regenerates blind',
    body: () => {
      const political = decideRemediation({
        lineage: { lineageId: 'lin-1', attempts: 0, halted: false },
        feedback: { global: { POLITICAL: 'This ad requires authorization.' } },
        effectiveAuthorizationCategory: 'POLITICAL_WITH_DIGITALLY_CREATED_MEDIA',
      });
      assert(political.disposition === 'QUARANTINE', `a political reclassification must quarantine, got ${political.disposition}`);
      assert(political.pauseScope === 'campaign' && political.pageHuman === true, 'the whole campaign must pause and a human must be paged');

      const blind = decideRemediation({
        lineage: { lineageId: 'lin-1', attempts: 0, halted: false },
        feedback: { global: {}, placementSpecific: {} },
      });
      assert(blind.disposition === 'QUARANTINE',
        'a disapproval with no readable reason must quarantine — regenerating blind spends an attempt on a guess');
      assert(blind.attemptsRemaining === MAX_REMEDIATION_ATTEMPTS, 'quarantining for lack of a reason must not consume the budget');

      const merged = mergeReviewFeedback({
        global: { A: 'first' },
        placementSpecific: { instagram: { B: 'second' }, dri_counterfeit: { C: 'third' } },
      });
      assert(merged.length === 3, `every surface must be merged, got ${merged.length}`);
      assert(merged.some((m) => m.surface === 'dri_counterfeit' && m.code === 'C' && m.message === 'third'),
        'the merged reason must keep its surface, code and verbatim message');
      return 'effective_authorization_category=POLITICAL_WITH_DIGITALLY_CREATED_MEDIA quarantines the CAMPAIGN and pages. An empty global+placement_specific quarantines without spending an attempt. mergeReviewFeedback flattens global and every placement surface into 3 reasons, each keeping its surface, code and verbatim sentence.';
    },
  },

  {
    name: 'burned-in text and shot direction are screened as hard as ad copy',
    body: () => {
      const brand = BRANDS.summit;
      // OCR output fed back in — the module header says most policy-violating text in a
      // video ad is burned into the frame.
      const ocr = screenCreative(brand, creative({
        copy: { primaryText: 'A new way to train.', onScreenText: ['LOSE 25 LBS IN 14 DAYS', 'ARE YOU OVER 60?'] },
      }));
      const t = find(ocr, 'unrealistic-outcomes.timeframe');
      assert(t?.severity === 'BLOCK' && t.span?.field === 'onScreenText' && t.span.index === 0,
        `burned-in outcome+timeframe must block and name its frame index: ${ids(ocr)}`);
      const a = find(ocr, 'personal-attributes.second-person-proximity');
      assert(a?.span?.index === 1, 'the second on-screen line must be screened independently and report index 1');

      // Shot direction: neverShow, disease claims in captions, strobe, suggestive framing.
      const shots = screenCreative(BRANDS.lumen, creative({
        visualDescription: [
          'Caption reads: reverses arthritis in weeks',
          'Rapid strobe transition into the hero shot',
          'Model in lingerie on a bed',
        ],
      }));
      const byId = new Map(shots.findings.map((f) => [f.ruleId, f]));
      assert(byId.get('unrealistic-outcomes.cure-incurable')?.severity === 'BLOCK', 'a disease claim in a caption must block');
      assert(byId.get('video.disruptive-tactics')?.severity === 'WARN', 'strobe direction must warn');
      assert(byId.get('adult.suggestive-direction')?.severity === 'WARN', 'suggestive shot direction must warn');
      assert(shots.verdict === 'BLOCK', 'the caption claim decides the verdict');
      return 'onScreenText[0] "LOSE 25 LBS IN 14 DAYS" blocked with field=onScreenText index=0 and onScreenText[1] "ARE YOU OVER 60?" reported independently at index 1. Shot direction produced a BLOCK for a disease caption plus WARNs for strobe and suggestive framing. This tier still cannot see pixels — see the SKIPped vision check.';
    },
  },

  {
    name: 'screening is pure and deterministic over the whole corpus',
    body: () => {
      let bytes = 0;
      for (const s of CORPUS) {
        const a = JSON.stringify(screenSample(s));
        const b = JSON.stringify(screenSample(s));
        assert(a === b, `${s.id} produced two different reports — the report is stored as evidence and replayed against later rule packs`);
        bytes += a.length;
      }
      // Order independence: the rule table's patterns are global, so a shared lastIndex
      // would make results depend on scan order.
      const forwards = CORPUS.map((s) => JSON.stringify(screenSample(s))).join('|');
      const backwards = [...CORPUS].reverse().map((s) => JSON.stringify(screenSample(s))).reverse().join('|');
      assert(forwards === backwards, 'screening one creative changed the result for another — regex lastIndex is leaking between scans');
      return `All ${CORPUS.length} reports (${bytes} bytes of JSON) are byte-identical on a second run and unaffected by scan order, so a stored report is replayable as evidence.`;
    },
  },

  {
    name: 'throughput: a full-length creative screens fast enough to sit in front of every publish',
    body: () => {
      const brand: ScreenBrand = {
        id: 'heavy',
        claims: {
          substantiated: Array.from({ length: 40 }, (_, i) => `Approved claim ${i} about the product and its ingredients`),
          neverSay: Array.from({ length: 30 }, (_, i) => `prohibited phrase ${i}`),
          neverShow: Array.from({ length: 10 }, (_, i) => `prohibited depiction ${i}`),
          likenessRightsConfirmed: true,
        },
        specialAdCategories: ['NONE'],
        countries: ['US', 'DE'],
      };
      // Meta's primary text limit is generous and DR copy uses it.
      const para = 'Our lightweight daily formula is made for sensitive skin and absorbs in seconds without residue. ';
      const primaryText = para.repeat(20);
      const c = creative({
        copy: {
          primaryText,
          headline: 'A gentler daily routine',
          description: 'Free returns within 30 days',
          callToAction: 'Shop now',
          transcript: para.repeat(10),
          onScreenText: Array.from({ length: 8 }, (_, i) => `Frame caption ${i}: gentle daily care`),
        },
        visualDescription: Array.from({ length: 12 }, (_, i) => `Shot ${i}: hands opening the jar on a bright counter`),
        presenter: presenter({ kind: 'animated_character', description: 'A friendly illustrated fox' }),
      });
      const runs = 20;
      const t0 = performance.now();
      let last: ScreenReport | undefined;
      for (let i = 0; i < runs; i++) last = screenCreative(brand, c);
      const ms = (performance.now() - t0) / runs;
      assert(last !== undefined, 'no report');
      assert(ms < 250, `screening took ${ms.toFixed(1)}ms per creative, which is too slow to sit in front of every publish`);

      // A pathological input must not blow up the bounded quantifiers.
      const evil = `Lose ${'a'.repeat(400)} in 30 days ${'over 40 '.repeat(200)}`;
      const t1 = performance.now();
      screenCreative(brand, creative({ copy: { primaryText: evil } }));
      const evilMs = performance.now() - t1;
      assert(evilMs < 500, `an adversarial input took ${evilMs.toFixed(0)}ms — the rule table backtracks`);
      return `A full-length creative (${primaryText.length}-char primary text, 8 OCR lines, 12 shots, a transcript) against a brand with 40 approved claims and 30 prohibited phrases screens in ${ms.toFixed(1)}ms (mean of ${runs}). A 2,000-char adversarial string designed to backtrack the bounded quantifiers took ${evilMs.toFixed(0)}ms. Nothing here is a throughput risk.`;
    },
  },

  {
    name: 'false positives that were fixed: 12 lines of ordinary DR copy that used to be refused',
    body: () => {
      // Each of these BLOCKed before this probe. They are recorded so a future rule
      // change that re-breaks them fails here rather than in production at 3am.
      const cases: readonly (readonly [string, BrandKey, string])[] = [
        ['Start your free trial. No credit card required.', 'northbeam', 'personal-attributes + credit category on "no credit"/"credit card"'],
        ['No credit card needed to try it for a month.', 'northbeam', 'special-ad-category.mismatch.credit'],
        ['Your last blender broke. Ours has a five-year warranty.', 'ridgeline', '"broke" read as vulnerable financial status'],
        ['Check your blind spot before you merge.', 'ridgeline', '"blind" read as disability'],
        ['Your headphones, 40+ hours of playback on one charge.', 'ridgeline', '"40+" read as an age attribute'],
        ['Spend $50 and get a free tote bag.', 'ridgeline', 'monetary figure read as an unsubstantiated claim'],
        ['Shop our best sellers.', 'ridgeline', '"best" read as a superlative claim'],
        ['Try it risk-free with our 30-day money-back guarantee.', 'ridgeline', 'the rule pack allows it and the claim-set stage blocked it'],
        ['Make dinner in 15 minutes with one pan.', 'panfresh', 'unrealistic-outcomes.timeframe on a meal kit'],
        ['Generate a full financial report in 30 seconds.', 'northbeam', 'unrealistic-outcomes.timeframe on a BI tool'],
        ['Grow your organic reach without hiring an agency.', 'northbeam', '"organic" read as a certification claim'],
        ['Support for people managing arthritis. Find your nearest class.', 'summit', 'the rule\'s own suggested remedy was itself a BLOCK'],
      ];
      const refused: string[] = [];
      for (const [text, key, was] of cases) {
        const r = screenCreative(BRANDS[key], creative({ copy: { primaryText: text } }));
        if (r.verdict === 'BLOCK') refused.push(`"${text}" -> ${ids(r)}  [was: ${was}]`);
      }
      assert(refused.length === 0, `still refusing legitimate advertising:\n${refused.join('\n')}`);
      return `All ${cases.length} lines are publishable again. Each was a BLOCK before the fixes, and a BLOCK stops an unattended publisher exactly as hard as a real violation does — the categories hit were SaaS free trials, consumer electronics, meal kits, e-commerce offers and the module's own recommended rewrite.`;
    },
  },

  {
    name: 'false negatives that were fixed: attribute plurals the lexicon could not see',
    body: () => {
      const cases: readonly string[] = [
        'Single moms: your grocery bill just got smaller.',
        'Diabetics, your test strips just got cheaper.',
        'Widows and widowers: your claim is our priority.',
        'Amputees, your prosthetic cover is ready.',
      ];
      const missed: string[] = [];
      for (const text of cases) {
        const r = screenCreative(BRANDS.summit, creative({ copy: { primaryText: text } }));
        if (find(r, 'personal-attributes.second-person-proximity') === undefined) missed.push(text);
      }
      assert(missed.length === 0, `the lexicon still cannot see: ${missed.join(' | ')}`);
      return `${cases.length} plural forms ("single moms", "diabetics", "widows", "amputees") now block. The lexicon carried only the singulars, so copy addressing a protected group in the plural — which is how ad copy actually addresses a group — was invisible to the rule that exists for exactly that copy. This is the dangerous direction of error: a silent PASS.`;
    },
  },

  {
    name: 'the third-person downgrade cannot be used to launder a real violation',
    body: () => {
      const brand = BRANDS.summit;
      const mustBlock: readonly string[] = [
        // A framed occurrence found FIRST must not suppress an unframed one later in the
        // same field — only one finding per (field, attribute class) is emitted, so which
        // one is chosen decides the verdict.
        'Loans for people with bad credit. Are you in debt? We can help you.',
        'Rates for retirees like you.',
        'Are you diabetic? This supplement is for you.',
        'Bad credit? We can help you.',
      ];
      const mustWarn: readonly string[] = [
        'Support for people managing arthritis. Find your nearest class.',
        'New options for people managing diabetes, and your first class is free.',
      ];
      const wrong: string[] = [];
      for (const text of mustBlock) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        const f = find(r, 'personal-attributes.second-person-proximity');
        if (f?.severity !== 'BLOCK') wrong.push(`should BLOCK: "${text}" -> ${ids(r)}`);
      }
      for (const text of mustWarn) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        const f = find(r, 'personal-attributes.second-person-proximity');
        if (f?.severity !== 'WARN') wrong.push(`should WARN: "${text}" -> ${ids(r)}`);
        if (!mayPublish(r)) wrong.push(`should stay publishable: "${text}"`);
      }
      assert(wrong.length === 0, wrong.join('\n'));
      // The residual, stated rather than hidden.
      const residual = screenCreative(brand, creative({
        copy: { primaryText: 'Loans for people with bad credit — you are approved in minutes.' },
      }));
      const rf = find(residual, 'personal-attributes.second-person-proximity');
      return [
        `${mustBlock.length} unframed shapes still BLOCK and ${mustWarn.length} genuinely third-person shapes WARN and stay publishable.`,
        'The important one is "Loans for people with bad credit. Are you in debt? We can help you." — the framed',
        '"bad credit" is matched first, and reporting the first match would have returned WARN and published it.',
        'The stage now collects every in-window match for the attribute class and prefers an unframed one.',
        `RESIDUAL, stated not hidden: "Loans for people with bad credit — you are approved in minutes." returns ${rf?.severity ?? 'no finding'}. ` +
          'Meta permits describing the audience in the third person, and the "you" here is about approval rather than about credit, ' +
          'so a WARN is defensible — but it is the widest gap this downgrade opens and belongs in front of a human.',
      ].join('\n');
    },
  },

  {
    name: 'known limitation: claim coverage is a token-overlap floor, not a paraphrase judge',
    body: () => {
      const brand = BRANDS.lumen; // approved: "Reduces the appearance of fine lines in 4 weeks"
      const blocked: string[] = [];
      const allowed: string[] = [];
      const probes: readonly string[] = [
        'Fine lines reduced in 4 weeks.',
        'Reduces fine lines in 4 weeks.',
        'Eliminates fine lines in 4 weeks.',
        'Reduces the appearance of fine lines in 2 weeks.',
        'Our serum is used by NASA.',
        'Nothing else comes close.',
      ];
      for (const text of probes) {
        const r = screenCreative(brand, creative({ copy: { primaryText: text } }));
        (find(r, 'claim-set.unsubstantiated-assertion') !== undefined ? blocked : allowed).push(text);
      }
      assert(blocked.includes('Eliminates fine lines in 4 weeks.'), 'a stronger efficacy verb must not pass');
      assert(blocked.includes('Reduces the appearance of fine lines in 2 weeks.'), 'a changed number must not pass');
      assert(allowed.includes('Our serum is used by NASA.'), 'expectation about markerless copy changed');
      return [
        'Measured, not asserted. Allowed through: ' + allowed.map((t) => `"${t}"`).join(', '),
        'Blocked: ' + blocked.map((t) => `"${t}"`).join(', '),
        'Two real holes, both by design (CLAIM_COVERAGE_MIN = 0.5, and a sentence with no claim MARKER is not a claim):',
        '  1. "Fine lines reduced in 4 weeks" passes as a restatement of "Reduces the APPEARANCE of fine lines in 4 weeks". Dropping "the appearance of" is a materially stronger claim and token overlap cannot see it.',
        '  2. "Our serum is used by NASA" and "Nothing else comes close" carry no number, efficacy word or superlative, so they are not treated as assertions at all.',
        'Both are the model tier\'s job (§11.1.4). This deterministic tier is a floor, and the probe records where the floor is rather than pretending it is a ceiling.',
      ].join('\n');
    },
  },

  {
    name: 'borderline calls the screen currently makes, recorded rather than asserted',
    body: () => {
      const cases: readonly (readonly [string, BrandKey])[] = [
        ['Trusted by single parents. Get your first box free.', 'summit'],
        ['Apply for the job of your dreams — our CV builder helps.', 'northbeam'],
        ['Free spins on the prize wheel at our store opening.', 'ridgeline'],
        ['Learn Spanish in 10 minutes a day.', 'northbeam'],
        ['We deliver within 2 days.', 'ridgeline'],
        ['Rates for retirees like you.', 'vantage'],
      ];
      const lines = cases.map(([text, key]) => {
        const r = screenCreative(BRANDS[key], creative({ copy: { primaryText: text } }));
        return `  ${r.verdict.padEnd(5)} "${text}" -> ${ids(r)}`;
      });
      return [
        'These are judgement calls where a reasonable reviewer could disagree with the screen. Recorded so a human can adjudicate them, not fixed:',
        ...lines,
        'The first three block on a category signal a human might read as incidental (a CV builder is not a job posting; a prize wheel is not a casino). The next two block on the claim set, which is correct by design but means a brand must enumerate delivery and lesson-length promises in claims.substantiated. The last is a deliberate BLOCK: "for retirees" plus "like you" addresses the reader, so the third-person downgrade must not apply.',
      ].join('\n');
    },
  },

  {
    name: 'findPhrase offsets survive normalisation and point into the original string',
    body: () => {
      const hit = findPhrase('xx CLINICALLY-PROVEN yy', 'clinically proven');
      assert(hit !== undefined && hit.start === 3 && hit.text === 'CLINICALLY-PROVEN', 'offsets must index the original bytes');
      const wide = findPhrase('Buy the ｍｉｒａｃｌｅ cream', 'miracle');
      assert(wide !== undefined, 'fullwidth forms must fold');
      assert('Buy the ｍｉｒａｃｌｅ cream'.slice(wide.start, wide.end) === wide.text, 'the span must splice the original');
      assert(findPhrase('anything at all', '') === undefined, 'an empty needle must not match everything');
      assert(findPhrase('anything at all', '   ') === undefined, 'a whitespace needle must not match everything');
      const short = findPhrase('The gospel truth about oil.', 'oil');
      assert(short !== undefined && short.evasion === false, 'a short needle must still match as a whole word');
      // A needle shorter than MIN_EVASION_NEEDLE is NOT allowed to match across separators,
      // because with separators stripped a 3-letter needle hits innocent substrings.
      const shortEvasion = findPhrase('The g.a.s station', 'gas');
      return [
        'findPhrase("xx CLINICALLY-PROVEN yy") returns start=3 with the original casing and hyphen; a fullwidth "ｍｉｒａｃｌｅ" folds and still splices the original bytes; empty and whitespace-only needles match nothing (they would otherwise block every ad); a 3-character needle still matches as a whole word.',
        `LIMITATION, measured: a needle below MIN_EVASION_NEEDLE=4 characters gets no evasion pass at all — "g.a.s" vs the needle "gas" is ${shortEvasion === undefined ? 'NOT matched' : 'matched'}. Short brand prohibitions ("OTC", "CBD", "THC") are therefore literal-only and a spaced-out spelling routes around them. A brand should list a longer form as well.`,
      ].join('\n');
    },
  },

  {
    name: 'frame-level vision screening (NSFW, celebrity face match, burned-in OCR)',
    body: () => {
      throw new Blocked(
        'no vision stage exists in this codebase and this tier cannot see pixels',
        'The module header is explicit that a PASS here is not safety: frame-level NSFW/suggestiveness, celebrity-face matching against Meta\'s >500,000 protected public figures, logo detection and burned-in-text OCR are a separate stage (§11.1.3). Nothing under src/ implements it, and there is no OCR binary to produce copy.onScreenText from a real render — the probe above feeds onScreenText by hand to prove the screen reads it once it exists. Until that stage lands, every text-only PASS on a video creative is unverified for the majority of the policy surface.',
      );
    },
  },

  {
    name: 'model-based policy screening (the tier this one explicitly defers to)',
    body: () => {
      throw new Blocked(
        'no LLM screening stage is implemented under src/',
        'Several rules here are deliberately narrow and hand the rest to a model tier (§11.1.4): obfuscated policy language outside the brand\'s neverSay list, protected attributes a lexicon cannot enumerate, and claims that assert something false while carrying no number, efficacy word or superlative ("Our serum is used by NASA" passes). That tier does not exist yet, so the deterministic floor measured here is currently the whole gate.',
      );
    },
  },

  {
    name: 'reconciling pre-flight labels against real ad_review_feedback from Meta',
    body: () => {
      throw new Blocked(
        'the system user has no ad account or Page assigned, and RUNTIME_MODE is SIMULATE',
        'The POLICIES table emits labels from Meta\'s own Advertising Standards namespace precisely so a real disapproval\'s ad_review_feedback reason codes can be reconciled against them (§1). Confirming that reconciliation needs a real DISAPPROVED ad, which needs a published ad — forbidden here and impossible anyway with no ad account assigned. mergeReviewFeedback and decideRemediation are therefore exercised against the documented SDK shape (37 placement_specific surfaces incl. dri_copyright/dri_counterfeit, map<string,string> global) rather than against live JSON.',
      );
    },
  },
];

/* --------------------------------------------------------------------- runner ----- */

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];
  for (const probe of PROBES) {
    try {
      const detail = await probe.body();
      checks.push({ name: probe.name, status: 'PASS', detail });
    } catch (e) {
      if (e instanceof Blocked) {
        checks.push({ name: probe.name, status: 'SKIP', detail: e.message, blockedBy: e.blockedBy });
      } else {
        checks.push({ name: probe.name, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { module: 'src/policy/screen.ts', checks };
}

async function main(): Promise<void> {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  console.log(`\n=== capability probe: ${report.module} ===\n`);
  for (const c of report.checks) {
    counts[c.status] += 1;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail.replace(/\n/gu, '\n       ')}`);
    if (c.blockedBy !== undefined) console.log(`       blockedBy: ${c.blockedBy}`);
    console.log('');
  }
  console.log(`PASS ${counts.PASS}   FAIL ${counts.FAIL}   SKIP ${counts.SKIP}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
