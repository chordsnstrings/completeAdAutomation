/**
 * Audience API builders — video-view, page, IG and lookalike — plus the readiness gate.
 *
 * Same posture as `src/meta/publish.ts`: every function here is PURE, from an input
 * object to a `{ path, params }` request the client can send. Nothing in this file
 * performs a write. The one impure function, `awaitAudienceReady`, takes a GET-only
 * fetch port and a sleep port, so it can be driven at full speed in a test and cannot
 * be turned into a write by accident.
 *
 * Sources: docs/research/funnel-video-lookalike.md (§1 ToS gate, §2 rule grammar,
 * §3 video shapes, §4 other engagement audiences, §5 node fields, §6 lookalikes,
 * §7 sizes and status polling, §8 attaching to an ad set, §11 limits) and
 * docs/research/funnel-strategy.md (§2.3–2.4 the undocumented video rule, §4 lookalike
 * placement, §7 retention windows, §11.4 constants).
 *
 * Three facts from the research shape the whole file and are worth stating up front,
 * because each of them is a place where the obvious implementation is wrong:
 *
 *  1. **`subtype` is inverted between audience families.** It must be OMITTED for page,
 *     IG, lead-form and instant-experience engagement audiences (deprecated Sept 2018),
 *     must be `ENGAGEMENT` for video, and must be `LOOKALIKE` for lookalikes. Sending it
 *     where it is deprecated produces a misleading `#2654 Invalid event name` rather than
 *     an "unsupported field" error, which is a genuinely expensive debugging trap.
 *
 *  2. **The video rule is a bare JSON array, not the `{inclusions:{...}}` object every
 *     other audience uses**, retention rides at the top level as `retention_days`, and
 *     `context_id` is the Facebook PAGE that published the video — not the ad account.
 *     Meta has removed the video-audience documentation entirely; this shape is
 *     reconstructed from legacy snippets and live read-back of UI-created audiences, so
 *     every video request carries an `unverified` note and the read-back verification
 *     fields are exported alongside it.
 *
 *  3. **An undersized seed is refused, not warned about.** Meta's hard floor is 100
 *     people *per target country*; the floor at which a lookalike is worth building is
 *     ~1,000. A lookalike built from a 300-person seed is not a small lookalike, it is a
 *     model fitted to noise that will then spend real money — and because the seed
 *     snapshot at build time is what gets modelled, it never gets better. The refusal
 *     says how many people short the seed is, so the caller can decide whether to widen
 *     the retention window (the cheap lever) or wait.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One error class, carrying the Meta parameter that is wrong.
 *
 * `field` is Meta's own parameter path (`rule`, `lookalike_spec.ratio`,
 * `retention_days`) rather than our input name, because whoever reads this at 3am is
 * holding Meta's reference page, not this file.
 */
export class AudienceBuildError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'AudienceBuildError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new AudienceBuildError(field, message);
}

// ---------------------------------------------------------------------------
// Hard limits — every one of these is an error code we would otherwise discover live
// ---------------------------------------------------------------------------

/** `#2654 / 1870231 "Video engagement audience too big"` above this. Chunk by construction. */
export const MAX_VIDEOS_PER_VIDEO_AUDIENCE = 200;

/** `#200 / 1713153` above this. Observed, not documented by Meta. */
export const MAX_PAGE_SOURCES_PER_AUDIENCE = 5;

/** Per ad account. Reachable faster than it looks: 5 thresholds x 4 windows x 25 brands = 500. */
export const MAX_ENGAGEMENT_AUDIENCES_PER_ACCOUNT = 500;

/** Lookalikes derivable from a single seed. */
export const MAX_LOOKALIKES_PER_SOURCE = 500;

/** `custom_audiences` and `excluded_custom_audiences` are each capped at this per ad set. */
export const MAX_AUDIENCES_PER_ADSET = 500;

/** Rules per audience, and filters per rule. */
export const MAX_RULES_PER_AUDIENCE = 10;
export const MAX_FILTERS_PER_RULE = 100;

/** Meta's documented hard floor for a lookalike seed — and it is per TARGET COUNTRY, not total. */
export const LOOKALIKE_HARD_MIN_SEED = 100;

/**
 * The floor at which a lookalike is worth building, as opposed to merely buildable.
 *
 * Meta's Help Centre recommends a 1,000–5,000 seed while its API guide says "as large as
 * possible"; the two are not reconcilable and the research grades the gap UNVERIFIED.
 * 1,000 is the conservative reading and the number this module gates on by default.
 */
export const LOOKALIKE_QUALITY_MIN_SEED = 1000;

export const LOOKALIKE_RECOMMENDED_SEED = { min: 1000, max: 5000 } as const;

/** Documented API range. Ads Manager exposes only 1%–10%; above 0.10 is UNVERIFIED in v26.0. */
export const LOOKALIKE_RATIO = { min: 0.01, max: 0.2, step: 0.01 } as const;
export const LOOKALIKE_RATIO_UI_MAX = 0.1;

/**
 * Practitioner consensus for the size at which an audience delivers reliably.
 *
 * Not a Meta-published number. Below it, `delivery_status` frequently reads 300
 * ("too small — currently inactive"), and under a CBO campaign the budget then silently
 * reallocates to the other ad sets, which corrupts any experiment running across them.
 */
export const AUDIENCE_DELIVERY_FLOOR = 1000;

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export type AudienceSourceKind =
  | 'video'
  | 'page'
  | 'page_likes'
  | 'ig_business'
  | 'lead_form'
  | 'canvas'
  | 'shopping'
  | 'ar'
  | 'website';

/** The ceiling Meta documents per source. Exceeding it is an error on some, a silent truncation on others. */
export const RETENTION_MAX_DAYS: Record<AudienceSourceKind, number> = {
  video: 365,
  page: 730,
  page_likes: 0,
  ig_business: 730,
  lead_form: 90,
  canvas: 730,
  shopping: 365,
  ar: 365,
  website: 180,
};

/**
 * The ceiling this module treats as safe, which is lower than the documented one where
 * Meta's own pages disagree with each other.
 *
 * The engagement guide pairs a "730 days" label for Page with the number 31,536,000
 * seconds, which is 365 days; the audience-rules guide caps `retention_seconds` at 365
 * days; the CustomAudience node reference caps `retention_days` at 180. Three Meta pages,
 * three answers. Practitioner reports say an over-large value is SILENTLY TRUNCATED
 * rather than rejected — which is the worst failure mode available, because the audience
 * then quietly holds a different window from the one the funnel was designed around.
 * Hence: refuse above the documented max, warn above the safe max, and always read
 * `retention_days` back (see `RETENTION_READBACK_FIELDS`).
 */
export const RETENTION_SAFE_MAX_DAYS: Record<AudienceSourceKind, number> = {
  video: 365,
  page: 365,
  page_likes: 0,
  ig_business: 365,
  lead_form: 90,
  canvas: 365,
  shopping: 365,
  ar: 365,
  website: 180,
};

/** Meta defaults video-audience retention to 730 days when `retention_days` is omitted. Never omit it. */
export const VIDEO_RETENTION_DEFAULT_IF_OMITTED = 730;

export interface RetentionCheck {
  days: number;
  ok: boolean;
  warnings: string[];
}

/**
 * Refuses a retention window above the documented ceiling; warns between the safe and
 * documented ceilings, where Meta's pages contradict each other.
 */
export function checkRetention(kind: AudienceSourceKind, days: number): RetentionCheck {
  const warnings: string[] = [];
  if (!Number.isInteger(days) || days < 0) {
    fail('retention_days', `${days} is not a whole number of days.`);
  }
  const max = RETENTION_MAX_DAYS[kind];
  const safe = RETENTION_SAFE_MAX_DAYS[kind];

  if (kind === 'page_likes') {
    if (days !== 0) {
      fail(
        'retention_days',
        `a page_liked (followers) audience must send 0 — it is an always-live "everyone who currently ` +
          `likes the Page" set with no rolling window. A non-zero value fails with ` +
          `#2654 subcode 1713214 "Can't Choose Data Time Limit". Got ${days}.`,
      );
    }
    return { days, ok: true, warnings };
  }

  if (days < 1) {
    fail('retention_days', `must be at least 1 day for a ${kind} audience.`);
  }
  if (days > max) {
    fail(
      'retention_days',
      `${days} exceeds the documented maximum of ${max} days for a ${kind} audience. ` +
        `Meta truncates some over-large windows silently rather than rejecting them, so this is ` +
        `refused here instead of being discovered as a pool that is smaller than the plan assumed.`,
    );
  }
  if (days > safe) {
    warnings.push(
      `retention_days=${days} is above the conservative ceiling of ${safe} for ${kind}. Meta's own pages ` +
        `disagree (${max} documented here, ${safe} elsewhere) and over-large values are reported to be ` +
        `silently truncated. Read retention_days back after create and compare.`,
    );
  }
  return { days, ok: true, warnings };
}

// ---------------------------------------------------------------------------
// Video-view audiences
// ---------------------------------------------------------------------------

/**
 * The four thresholds expressible through the API.
 *
 * Ads Manager also offers 3-second and ThruPlay(15s). No `event_name` for either could be
 * found in any source, primary or otherwise, so they are deliberately NOT in this union:
 * inventing a constant here would surface as `#2654 Invalid event name` at create time
 * with nothing in the codebase explaining why.
 */
export type VideoThreshold = 'p25' | 'p50' | 'p75' | 'p95';

export const VIDEO_THRESHOLDS: readonly VideoThreshold[] = ['p25', 'p50', 'p75', 'p95'];

/**
 * Threshold -> `event_name`.
 *
 * Note `p95 -> video_completed`, NOT `video_view_95_percent`. Two live-verified
 * third-party implementations disagree on this one; the one used here is the one that
 * read the value back out of audiences Meta itself had stored, which is stronger evidence
 * than a guess at what to send. `VIDEO_EVENT_ALTERNATES` carries the loser so the fallback
 * is written down rather than rediscovered.
 */
export const VIDEO_THRESHOLD_EVENT: Record<VideoThreshold, string> = {
  p25: 'video_view_25_percent',
  p50: 'video_view_50_percent',
  p75: 'video_view_75_percent',
  p95: 'video_completed',
};

/** The contested spelling, to try if `video_completed` is rejected with #2654. */
export const VIDEO_EVENT_ALTERNATES: Record<VideoThreshold, readonly string[]> = {
  p25: [],
  p50: [],
  p75: [],
  p95: ['video_view_95_percent'],
};

/**
 * Which thresholds make a defensible lookalike seed.
 *
 * A 25% or 3-second pool encodes "scrolls slowly"; a 75%/95% pool encodes "watched your
 * whole pitch". The strategy research is blunt that seeding from the shallow thresholds
 * is soft remarketing — you build a population of people who like watching videos and
 * then optimise toward them.
 */
export const VIDEO_SEED_QUALITY: Record<VideoThreshold, 'poor' | 'usable'> = {
  p25: 'poor',
  p50: 'poor',
  p75: 'usable',
  p95: 'usable',
};

export type AudienceRequestKind =
  | 'video_engagement'
  | 'page_engagement'
  | 'ig_engagement'
  | 'lookalike';

/** A ready-to-send POST plus everything the caller should log before sending it. */
export interface BuiltAudienceRequest {
  kind: AudienceRequestKind;
  /** Graph path WITHOUT a leading slash, e.g. `act_123/customaudiences`. */
  path: string;
  params: Record<string, string>;
  /** The audience name, lifted out so a caller can reconcile without re-parsing params. */
  name: string;
  warnings: string[];
  /**
   * Claims in this request that no Meta primary source confirms. Non-empty is normal for
   * video audiences and is the reason `AUDIENCE_READ_FIELDS` exists.
   */
  unverified: string[];
}

export interface VideoViewAudienceInput {
  /** `act_<id>`. */
  adAccountId: string;
  /** Base name. A chunk suffix is appended only when more than one audience is needed. */
  name: string;
  /** The Facebook Page that PUBLISHED the videos. Not the ad account. Omitting it is a common failure. */
  pageId: string;
  videoIds: readonly string[];
  threshold: VideoThreshold;
  retentionDays: number;
  /**
   * Backfill with people who already matched before the audience existed. Defaults to
   * true: for videos that have already run, `prefill=0` means the pool starts empty and
   * the seed minimum is unreachable for weeks.
   */
  prefill?: boolean;
  description?: string;
}

/** Splits into fixed-size chunks, preserving order. */
export function chunkIds(ids: readonly string[], size: number): string[][] {
  if (size < 1) fail('rule', `chunk size must be at least 1, got ${size}.`);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** ` (2 of 5)` — deterministic, so a re-run produces the same names and never double-suffixes. */
export function chunkName(base: string, index: number, total: number): string {
  return total <= 1 ? base : `${base} (${index + 1} of ${total})`;
}

/**
 * Builds the video-view engagement audience(s) for one threshold.
 *
 * Returns an ARRAY because an autonomous creative pipeline accumulates video ids
 * monotonically and will cross the 200-video cap within a year on a single brand. The
 * chunking is by construction rather than by error handling: discovering the cap through
 * `#2654 / 1870231` means the audience layer has already failed once in production, and
 * the ids are OR'd back together at ad-set targeting time anyway (500 audiences per ad
 * set, so there is comfortable room).
 */
export function buildVideoViewAudienceRequests(input: VideoViewAudienceInput): BuiltAudienceRequest[] {
  assertAdAccount(input.adAccountId);
  if (!/^\d+$/.test(input.pageId)) {
    fail(
      'rule.context_id',
      `pageId "${input.pageId}" must be the numeric Facebook Page id that published the video. ` +
        `context_id is the PAGE, not the ad account — omitting it or passing act_<id> is a common failure.`,
    );
  }
  if (input.videoIds.length === 0) {
    fail('rule', 'a video-view audience needs at least one video id.');
  }
  for (const id of input.videoIds) {
    if (!/^\d+$/.test(id)) fail('rule.object_id', `video id "${id}" is not numeric.`);
  }

  const retention = checkRetention('video', input.retentionDays);
  const eventName = VIDEO_THRESHOLD_EVENT[input.threshold];
  const prefill = input.prefill ?? true;
  const chunks = chunkIds([...input.videoIds], MAX_VIDEOS_PER_VIDEO_AUDIENCE);

  return chunks.map((chunk, i) => {
    const name = sanitiseAudienceName(chunkName(input.name, i, chunks.length));
    const rule = chunk.map((videoId) => ({
      event_name: eventName,
      object_id: videoId,
      context_id: input.pageId,
    }));

    const params: Record<string, string> = {
      name: name.name,
      // The documented exception to the Sept-2018 subtype deprecation. ENGAGEMENT is not
      // even in the published subtype enum, yet it is what the legacy docs instruct and
      // what UI-created video audiences read back as.
      subtype: 'ENGAGEMENT',
      retention_days: String(retention.days),
      rule: JSON.stringify(rule),
      prefill: prefill ? '1' : '0',
    };
    if (input.description !== undefined) params['description'] = input.description;

    const warnings = [...retention.warnings, ...name.warnings];
    if (chunks.length > 1) {
      warnings.push(
        `${input.videoIds.length} videos exceed the ${MAX_VIDEOS_PER_VIDEO_AUDIENCE}-per-audience cap, so this ` +
          `is audience ${i + 1} of ${chunks.length}. OR them together in targeting.custom_audiences.`,
      );
    }
    if (VIDEO_SEED_QUALITY[input.threshold] === 'poor') {
      warnings.push(
        `threshold ${input.threshold} is a POOR lookalike seed: it encodes "scrolls slowly", not "buys". ` +
          `Use it as an exclusion if you must, and seed lookalikes from p75/p95 instead.`,
      );
    }

    return {
      kind: 'video_engagement',
      path: `${input.adAccountId}/customaudiences`,
      params,
      name: name.name,
      warnings,
      unverified: [
        'Meta has REMOVED the video-engagement audience documentation entirely. The bare-array rule shape, ' +
          'the top-level retention_days, and subtype=ENGAGEMENT are reconstructed from legacy doc snippets ' +
          'and live read-back of UI-created audiences.',
        `event_name="${eventName}" for ${input.threshold}: two live-verified implementations disagree at the ` +
          `top tier. A wrong name surfaces as #2654 "Invalid event name"; the alternate to try is ` +
          `${VIDEO_EVENT_ALTERNATES[input.threshold].join(', ') || 'none'}.`,
        'Videos used ONLY in placement-asset-customisation campaigns are ineligible for video engagement ' +
          'audiences, and Audience Network views may not be counted — so this pool can be silently empty.',
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Page and Instagram engagement audiences
// ---------------------------------------------------------------------------

export type PageEngagementEvent =
  | 'page_engaged'
  | 'page_visited'
  | 'page_liked'
  | 'page_messaged'
  | 'page_cta_clicked'
  | 'page_or_post_save'
  | 'page_post_interaction';

/**
 * IG engagement events. `INSTAGRAM_PROFILE_FOLLOW` is UPPERCASE, uniquely among these
 * constants — do not normalise the case of an event name anywhere in this file.
 */
export type IgEngagementEvent =
  | 'ig_business_profile_all'
  | 'ig_business_profile_engaged'
  | 'ig_business_profile_visit'
  | 'ig_user_messaged_business'
  | 'ig_ad_like'
  | 'ig_organic_comment'
  | 'INSTAGRAM_PROFILE_FOLLOW';

export interface EngagementAudienceInput {
  adAccountId: string;
  name: string;
  /**
   * Page ids for a page audience. For an IG audience this can legitimately be the
   * FACEBOOK Page id rather than the IG account id — the IG rule wraps the same ids in an
   * `ig_business` event source.
   */
  sourceIds: readonly string[];
  retentionDays: number;
  prefill?: boolean;
  description?: string;
}

export interface PageEngagementAudienceInput extends EngagementAudienceInput {
  events: readonly PageEngagementEvent[];
}

export interface IgEngagementAudienceInput extends EngagementAudienceInput {
  events: readonly IgEngagementEvent[];
}

const DAY_SECONDS = 86400;

/**
 * Page-engagement audience, in the modern `event_sources` grammar.
 *
 * Note what is NOT here: `subtype`. It has been deprecated for every engagement audience
 * except video since September 2018, and sending it produces `#2654 Invalid event name` —
 * an error that points at the wrong field entirely.
 */
export function buildPageEngagementAudienceRequest(
  input: PageEngagementAudienceInput,
): BuiltAudienceRequest {
  assertAdAccount(input.adAccountId);
  if (input.sourceIds.length === 0) fail('rule.event_sources', 'needs at least one page id.');
  if (input.sourceIds.length > MAX_PAGE_SOURCES_PER_AUDIENCE) {
    fail(
      'rule.event_sources',
      `${input.sourceIds.length} page sources exceeds the observed cap of ${MAX_PAGE_SOURCES_PER_AUDIENCE}; ` +
        `a 6+-source POST fails atomically with #200 subcode 1713153. Split into several audiences and OR ` +
        `them in targeting.`,
    );
  }
  if (input.events.length === 0) fail('rule.filter', 'needs at least one event name.');

  const likesOnly = input.events.includes('page_liked');
  if (likesOnly && input.events.length > 1) {
    fail(
      'rule.filter',
      `page_liked cannot be combined with other page events — it is an always-live follower set with no ` +
        `retention window, and the other events all carry one. Build it as its own audience.`,
    );
  }

  const kind: AudienceSourceKind = likesOnly ? 'page_likes' : 'page';
  const retention = checkRetention(kind, input.retentionDays);
  return buildEventSourceAudience(
    'page_engagement',
    'page',
    input,
    input.events,
    retention,
  );
}

export function buildIgEngagementAudienceRequest(
  input: IgEngagementAudienceInput,
): BuiltAudienceRequest {
  assertAdAccount(input.adAccountId);
  if (input.sourceIds.length === 0) fail('rule.event_sources', 'needs at least one ig_business id.');
  if (input.events.length === 0) fail('rule.filter', 'needs at least one event name.');

  const retention = checkRetention('ig_business', input.retentionDays);
  const built = buildEventSourceAudience('ig_engagement', 'ig_business', input, input.events, retention);
  built.unverified.push(
    'IG_BUSINESS appears in the documented subtype enum, which contradicts the blanket "omit subtype" rule ' +
      'for engagement audiences. subtype is omitted here; if create fails with #2654, try subtype=IG_BUSINESS.',
  );
  return built;
}

function buildEventSourceAudience(
  kind: AudienceRequestKind,
  sourceType: 'page' | 'ig_business',
  input: EngagementAudienceInput,
  events: readonly string[],
  retention: RetentionCheck,
): BuiltAudienceRequest {
  const name = sanitiseAudienceName(input.name);
  const rule = {
    inclusions: {
      operator: 'or',
      rules: [
        {
          event_sources: input.sourceIds.map((id) => ({ id, type: sourceType })),
          retention_seconds: retention.days * DAY_SECONDS,
          filter: {
            operator: 'or',
            // `eq` rather than `=`: both are accepted, but Meta's own UI-created audiences
            // read back as `eq`, so a read-back diff stays clean.
            filters: events.map((event) => ({ field: 'event', operator: 'eq', value: event })),
          },
        },
      ],
    },
  };

  if (events.length > MAX_FILTERS_PER_RULE) {
    fail('rule.filter.filters', `${events.length} filters exceeds the ${MAX_FILTERS_PER_RULE}-per-rule maximum.`);
  }

  const params: Record<string, string> = {
    name: name.name,
    rule: JSON.stringify(rule),
    prefill: (input.prefill ?? true) ? '1' : '0',
  };
  if (input.description !== undefined) params['description'] = input.description;

  return {
    kind,
    path: `${input.adAccountId}/customaudiences`,
    params,
    name: name.name,
    warnings: [...retention.warnings, ...name.warnings],
    unverified: [],
  };
}

// ---------------------------------------------------------------------------
// Lookalikes
// ---------------------------------------------------------------------------

export type LookalikeSeedVerdict = 'too_small' | 'warming' | 'ok';

export interface LookalikeSeedCheck {
  verdict: LookalikeSeedVerdict;
  ok: boolean;
  seedSize: number;
  country: string;
  hardMinimum: number;
  qualityFloor: number;
  /** People short of Meta's hard floor. 0 when the seed clears it. */
  shortfallToHardMinimum: number;
  /** People short of the quality floor this module gates on. 0 when the seed clears it. */
  shortfallToQualityFloor: number;
  message: string;
}

export interface LookalikeSeedOptions {
  /** ISO-2. The 100-person floor is PER TARGET COUNTRY, not per audience. */
  country?: string;
  /** Override the 1,000-person quality gate. Lower it only for a genuine cold start. */
  qualityFloor?: number;
  /**
   * Permit a seed between the hard floor and the quality floor. The build then proceeds
   * with a warning instead of a refusal — the "we have nothing better and never will"
   * case, which is exactly the cold-start case lookalikes still exist for.
   */
  allowUndersized?: boolean;
}

/**
 * Grades a seed without throwing, so a planner can report "not yet, and here is how far
 * off you are" rather than crashing.
 *
 * The distinction between the two floors is the whole point. 100 is "will it build".
 * ~1,000 is "will it be worth anything". A system that only checks the first will happily
 * construct statistically meaningless lookalikes and then spend against them, and because
 * the seed snapshot at build time is what Meta models, that lookalike never improves —
 * you have to delete it and rebuild once the seed has grown.
 */
export function checkLookalikeSeed(seedSize: number, opts: LookalikeSeedOptions = {}): LookalikeSeedCheck {
  const country = (opts.country ?? 'the target country').toUpperCase();
  const qualityFloor = opts.qualityFloor ?? LOOKALIKE_QUALITY_MIN_SEED;
  const hardShort = Math.max(0, LOOKALIKE_HARD_MIN_SEED - seedSize);
  const qualityShort = Math.max(0, qualityFloor - seedSize);

  if (hardShort > 0) {
    return {
      verdict: 'too_small',
      ok: false,
      seedSize,
      country,
      hardMinimum: LOOKALIKE_HARD_MIN_SEED,
      qualityFloor,
      shortfallToHardMinimum: hardShort,
      shortfallToQualityFloor: qualityShort,
      message:
        `Seed holds ${seedSize} people in ${country}. Meta's hard minimum is ${LOOKALIKE_HARD_MIN_SEED} ` +
        `IN THE TARGET COUNTRY — ${hardShort} short. The create will be rejected. Either widen the ` +
        `retention window (the cheap lever: it grows the pool without more spend), set ` +
        `allow_international_seeds, or wait for the pool to fill.`,
    };
  }

  if (qualityShort > 0) {
    return {
      verdict: 'warming',
      ok: false,
      seedSize,
      country,
      hardMinimum: LOOKALIKE_HARD_MIN_SEED,
      qualityFloor,
      shortfallToHardMinimum: 0,
      shortfallToQualityFloor: qualityShort,
      message:
        `Seed holds ${seedSize} people in ${country}. That clears Meta's hard floor of ` +
        `${LOOKALIKE_HARD_MIN_SEED} but is ${qualityShort} short of the ${qualityFloor}-person quality ` +
        `floor. A lookalike built now models this snapshot permanently and cannot improve as the seed ` +
        `grows. Refusing unless allowUndersized is set — the recommended seed is ` +
        `${LOOKALIKE_RECOMMENDED_SEED.min}–${LOOKALIKE_RECOMMENDED_SEED.max}.`,
    };
  }

  return {
    verdict: 'ok',
    ok: true,
    seedSize,
    country,
    hardMinimum: LOOKALIKE_HARD_MIN_SEED,
    qualityFloor,
    shortfallToHardMinimum: 0,
    shortfallToQualityFloor: 0,
    message: `Seed holds ${seedSize} people in ${country}, above the ${qualityFloor}-person quality floor.`,
  };
}

/** Throwing form of `checkLookalikeSeed`, for the publish path. */
export function assertLookalikeSeed(seedSize: number, opts: LookalikeSeedOptions = {}): LookalikeSeedCheck {
  const check = checkLookalikeSeed(seedSize, opts);
  if (check.ok) return check;
  if (check.verdict === 'warming' && opts.allowUndersized === true) return check;
  fail('origin_audience_id', check.message);
}

export interface LookalikeInput {
  adAccountId: string;
  name: string;
  /** The seed custom audience. Its members are excluded from the lookalike automatically. */
  seedAudienceId: string;
  /** ISO-2. Still required, though Meta has announced (and delayed) its removal. */
  country: string;
  /**
   * Top x%. 0.03 is this platform's default: big enough to deliver in a small country,
   * small enough to mean something in the cases where Advantage+ lookalike is off.
   */
  ratio: number;
  /**
   * Lower bound of a band. `startingRatio 0.01, ratio 0.03` is the 1–3% band. Without it,
   * `ratio` is CUMULATIVE — a "5% ad set" contains the whole 1% — so two tiers run as two
   * ad sets are bidding for the same people and the smaller one starves.
   */
  startingRatio?: number;
  /** Measured seed size. Required unless `skipSeedCheck`; the refusal is the point of this module. */
  seedSize?: number;
  seedOptions?: LookalikeSeedOptions;
  /** Lets Meta find seed members outside the target country when it holds fewer than 100 there. */
  allowInternationalSeeds?: boolean;
  description?: string;
}

export function buildLookalikeAudienceRequest(input: LookalikeInput): BuiltAudienceRequest {
  assertAdAccount(input.adAccountId);
  if (!/^\d+$/.test(input.seedAudienceId)) {
    fail('origin_audience_id', `seedAudienceId "${input.seedAudienceId}" is not a numeric audience id.`);
  }
  const country = input.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    fail('lookalike_spec.country', `"${input.country}" is not an ISO-2 country code.`);
  }

  const warnings: string[] = [];

  if (input.seedSize === undefined) {
    fail(
      'origin_audience_id',
      `seedSize is required. A lookalike is a model fitted to whatever the seed holds AT BUILD TIME, so ` +
        `building one blind is the single easiest way for this system to spend money on noise. Read ` +
        `approximate_count_lower_bound off the seed and pass it.`,
    );
  }
  const seedOpts: LookalikeSeedOptions = {
    country,
    ...(input.seedOptions?.qualityFloor !== undefined ? { qualityFloor: input.seedOptions.qualityFloor } : {}),
    ...(input.seedOptions?.allowUndersized !== undefined
      ? { allowUndersized: input.seedOptions.allowUndersized }
      : {}),
  };
  const seed = assertLookalikeSeed(input.seedSize, seedOpts);
  if (!seed.ok) warnings.push(seed.message);

  assertRatio('lookalike_spec.ratio', input.ratio);
  if (input.startingRatio !== undefined) {
    assertRatio('lookalike_spec.starting_ratio', input.startingRatio, true);
    if (input.startingRatio >= input.ratio) {
      fail(
        'lookalike_spec.starting_ratio',
        `starting_ratio ${input.startingRatio} must be strictly less than ratio ${input.ratio}.`,
      );
    }
  }
  if (input.ratio > LOOKALIKE_RATIO_UI_MAX) {
    warnings.push(
      `ratio ${input.ratio} is above the ${LOOKALIKE_RATIO_UI_MAX} ceiling Ads Manager exposes. The API doc ` +
        `range goes to ${LOOKALIKE_RATIO.max}, but whether v26.0 still accepts it is UNVERIFIED.`,
    );
  }

  const spec: Record<string, unknown> = { ratio: round2(input.ratio), country };
  if (input.startingRatio !== undefined) {
    spec['starting_ratio'] = round2(input.startingRatio);
    // The tiering examples in Meta's guide omit `type` when starting_ratio is present;
    // the value-based docs use "custom_ratio" with an explicit ratio. Which one binds is
    // UNVERIFIED, so `type` is omitted and custom_ratio is the documented fallback.
  }
  if (input.allowInternationalSeeds === true) spec['allow_international_seeds'] = true;

  const name = sanitiseAudienceName(input.name);
  const params: Record<string, string> = {
    name: name.name,
    // The documented exception: unlike engagement audiences, LOOKALIKE subtype is REQUIRED.
    subtype: 'LOOKALIKE',
    origin_audience_id: input.seedAudienceId,
    lookalike_spec: JSON.stringify(spec),
  };
  if (input.description !== undefined) params['description'] = input.description;

  warnings.push(...name.warnings);
  warnings.push(
    'Do NOT also exclude the seed from an ad set targeting this lookalike — Meta already removes seed ' +
      'members from the lookalike automatically.',
  );

  return {
    kind: 'lookalike',
    path: `${input.adAccountId}/customaudiences`,
    params,
    name: name.name,
    warnings,
    unverified: [
      'Whether `type` must be "custom_ratio" when starting_ratio is set. It is omitted here; if create ' +
        'fails, resend with type="custom_ratio".',
      'Meta announced the removal of `country`/`location_spec` from lookalike creation in 2021 and has ' +
        'delayed it since; the Help Centre already says location is no longer chosen. Expect this to break.',
    ],
  };
}

export interface LookalikeTier {
  startingRatio: number;
  ratio: number;
}

/**
 * Non-overlapping ratio tiers, as N separate POSTs — there is no batch or multi-ratio
 * parameter.
 *
 * Offered because the API supports it, with a warning attached because the research is
 * unambiguous that running tiers as separate ad sets is a mistake in 2026: Advantage+
 * lookalike is on by default and cannot be turned off when optimising for conversions, so
 * a "1% lookalike" ad set does not deliver to a 1% audience. Splitting tiers then buys
 * fragmentation for nothing, and the smaller tier starves.
 */
export function buildLookalikeTierRequests(
  input: Omit<LookalikeInput, 'ratio' | 'startingRatio'>,
  tiers: readonly LookalikeTier[],
): BuiltAudienceRequest[] {
  if (tiers.length === 0) fail('lookalike_spec.ratio', 'at least one tier is required.');

  const sorted = [...tiers].sort((a, b) => a.startingRatio - b.startingRatio);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.startingRatio < prev.ratio) {
      fail(
        'lookalike_spec.starting_ratio',
        `tiers overlap: [${prev.startingRatio}, ${prev.ratio}] and [${cur.startingRatio}, ${cur.ratio}]. ` +
          `ratio is cumulative by default, so overlapping tiers run as separate ad sets compete for the ` +
          `same people and the smaller one starves.`,
      );
    }
  }

  return sorted.map((tier, i) => {
    const req = buildLookalikeAudienceRequest({
      ...input,
      name: `${input.name} ${formatPct(tier.startingRatio)}-${formatPct(tier.ratio)}`,
      ratio: tier.ratio,
      ...(tier.startingRatio > 0 ? { startingRatio: tier.startingRatio } : {}),
    });
    req.warnings.push(
      `tier ${i + 1} of ${sorted.length}. Ratio tiers are largely notional in 2026: Advantage+ lookalike is ` +
        `automatically enabled and cannot be turned off when optimising for conversions, so the seed is a ` +
        `hint rather than a boundary. Prefer ONE lookalike at ratio 0.03 attached as a suggestion.`,
    );
    return req;
  });
}

function assertRatio(field: string, value: number, allowZero = false): void {
  const min = allowZero ? 0 : LOOKALIKE_RATIO.min;
  if (!(value >= min && value <= LOOKALIKE_RATIO.max)) {
    fail(field, `${value} is outside the documented range ${min}–${LOOKALIKE_RATIO.max}.`);
  }
  const steps = value / LOOKALIKE_RATIO.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    fail(field, `${value} is not a multiple of ${LOOKALIKE_RATIO.step}.`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatPct(n: number): string {
  return `${round2(n * 100)}%`;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Words that trip Meta's audience integrity filter (`operation_status: 471`, rolled out
 * 2 September 2025), which blocks audiences whose names suggest a health condition or
 * financial status. Creating a lookalike from a flagged seed fails with
 * `code 100 / subcode 1713232 "Seed audience restricted"`.
 *
 * This matters here specifically because audience names in this system are generated from
 * brand copy, so the platform can trip the filter by accident and then be unable to build
 * a lookalike from an otherwise perfect seed.
 */
export const INTEGRITY_RISK_TERMS: readonly string[] = [
  'high income',
  'high-income',
  'wealthy',
  'affluent',
  'premium buyers',
  'low income',
  'bad credit',
  'debt',
  'loan',
  'diabetes',
  'cancer',
  'pregnan',
  'mental health',
  'depression',
  'weight loss',
  'std',
  'hiv',
];

export interface SanitisedName {
  name: string;
  warnings: string[];
}

/** Trims, collapses whitespace, and flags integrity-filter risk without silently rewriting the name. */
export function sanitiseAudienceName(raw: string): SanitisedName {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) fail('name', 'an audience name is required.');
  const lower = name.toLowerCase();
  const hits = INTEGRITY_RISK_TERMS.filter((t) => lower.includes(t));
  const warnings =
    hits.length > 0
      ? [
          `name contains ${hits.map((h) => `"${h}"`).join(', ')}, which can trip Meta's audience integrity ` +
            `filter (operation_status 471). A flagged seed then fails lookalike creation with ` +
            `code 100 / subcode 1713232. Rename before creating.`,
        ]
      : [];
  return { name, warnings };
}

function assertAdAccount(id: string): void {
  if (!id.startsWith('act_')) {
    fail('path', `adAccountId "${id}" must carry the act_ prefix — Meta rejects the path without it.`);
  }
}

// ---------------------------------------------------------------------------
// Readiness — the gate that stops an ad set targeting an empty audience
// ---------------------------------------------------------------------------

/** Everything worth reading back after a create. Step 7 of the build sequence is not optional. */
export const AUDIENCE_READ_FIELDS =
  'id,name,subtype,rule,retention_days,operation_status,delivery_status,' +
  'approximate_count_lower_bound,approximate_count_upper_bound,data_source,time_content_updated';

/** The subset needed just to verify Meta did not silently truncate the retention window. */
export const RETENTION_READBACK_FIELDS = 'id,name,retention_days,subtype,data_source';

/** `operation_status` codes that mean the audience is unusable and will not become usable by waiting. */
export const OPERATION_STATUS_FAIL: ReadonlySet<number> = new Set([
  415, // replace failed
  421, // no pixel installed
  422, // pixel not firing
  423, // invalid pixel
  432, // lookalike build failed
  433, // lookalike build failed
  470, // creator account inactive
  471, // flagged for integrity violations
  500, // error, action required
]);

/** `operation_status` codes that mean "not yet" — poll again. */
export const OPERATION_STATUS_WAIT: ReadonlySet<number> = new Set([
  0, // status not available
  410, // no upload yet
  414, // replace in progress
  434, // lookalike build retrying
  441, // building — size will increase. The normal populating state.
]);

/** `operation_status` codes that are usable but worth logging. */
export const OPERATION_STATUS_WARN: ReadonlySet<number> = new Set([
  100, // expiring, unused 2+ years
  400, // informational warning
  411, // low match rate
  412, // high number of invalid entries
  431, // lookalike refresh failed
  442, // prefill unsuccessful — seed may be undersized
  450, // unused 30+ days, out of date
]);

export const DELIVERY_STATUS_READY = 200;
/** "Too small — currently inactive". The exact condition that wastes spend. */
export const DELIVERY_STATUS_TOO_SMALL = 300;

export type ReadinessVerdict = 'ready' | 'wait' | 'fail';

export interface AudienceStatusNode {
  id?: string;
  name?: string;
  operation_status?: { code?: number; description?: string };
  delivery_status?: { code?: number; description?: string };
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  retention_days?: number;
  time_content_updated?: number;
}

export interface AudienceReadiness {
  verdict: ReadinessVerdict;
  audienceId: string;
  operationStatusCode: number | undefined;
  deliveryStatusCode: number | undefined;
  approximateLowerBound: number | undefined;
  /** People short of the quality floor. 0 when it is met or unknown. */
  shortfall: number;
  reason: string;
  warnings: string[];
  attempts: number;
}

export interface ReadinessOptions {
  /**
   * Minimum `approximate_count_lower_bound` before the audience may be targeted.
   * Defaults to `AUDIENCE_DELIVERY_FLOOR`. Pass 0 for an audience used ONLY as an
   * exclusion — an exclusion has no size floor, it is a hard constraint at any size.
   */
  qualityFloor?: number;
}

/**
 * The publish-path predicate, from the research verbatim:
 *
 *     proceed iff delivery_status.code == 200
 *             and operation_status.code in {200, 400, ...usable}
 *             and approximate_count_lower_bound >= quality floor
 *
 * `delivery_status == 300` is the case this exists for. An ad set whose only targeting is
 * a 300 audience under-delivers or does not deliver at all, and under a CBO campaign the
 * budget then silently reallocates to the other ad sets — so the failure looks like a
 * creative result rather than a targeting one, and the autonomy loop learns from a lie.
 */
export function classifyAudienceReadiness(
  node: AudienceStatusNode,
  opts: ReadinessOptions = {},
): AudienceReadiness {
  const floor = opts.qualityFloor ?? AUDIENCE_DELIVERY_FLOOR;
  const audienceId = node.id ?? '(unknown)';
  const op = node.operation_status?.code;
  const delivery = node.delivery_status?.code;
  const lower = node.approximate_count_lower_bound;
  const warnings: string[] = [];

  const base = {
    audienceId,
    operationStatusCode: op,
    deliveryStatusCode: delivery,
    approximateLowerBound: lower,
    attempts: 1,
  };

  if (op !== undefined && OPERATION_STATUS_FAIL.has(op)) {
    return {
      ...base,
      verdict: 'fail',
      shortfall: 0,
      reason:
        `operation_status ${op} (${node.operation_status?.description ?? 'no description'}) is terminal — ` +
        `waiting will not fix it. This needs a human or a rebuild, not a retry.`,
      warnings,
    };
  }
  if (delivery !== undefined && delivery >= 400) {
    return {
      ...base,
      verdict: 'fail',
      shortfall: 0,
      reason: `delivery_status ${delivery} (${node.delivery_status?.description ?? 'unusable'}).`,
      warnings,
    };
  }

  if (op !== undefined && OPERATION_STATUS_WARN.has(op)) {
    warnings.push(
      `operation_status ${op} (${node.operation_status?.description ?? 'warning'}) — usable, but logged. ` +
        `442 in particular means the prefill did not complete and the pool may be smaller than planned.`,
    );
  }

  if (op !== undefined && OPERATION_STATUS_WAIT.has(op)) {
    return {
      ...base,
      verdict: 'wait',
      shortfall: lower !== undefined ? Math.max(0, floor - lower) : 0,
      reason: `operation_status ${op} — still populating. 441 is the normal building state.`,
      warnings,
    };
  }

  if (delivery === DELIVERY_STATUS_TOO_SMALL) {
    return {
      ...base,
      verdict: 'wait',
      shortfall: lower !== undefined ? Math.max(0, floor - lower) : 0,
      reason:
        `delivery_status 300 — Meta considers this audience too small to deliver. Targeting it now wastes ` +
        `spend: the ad set under-delivers and, under a campaign budget, the money silently moves to the ` +
        `other ad sets. Widen the retention window before raising the budget.`,
      warnings,
    };
  }

  if (delivery !== DELIVERY_STATUS_READY) {
    return {
      ...base,
      verdict: 'wait',
      shortfall: 0,
      reason: `delivery_status ${delivery ?? 'absent'} — not yet 200 (active and ready to be used in ads).`,
      warnings,
    };
  }

  if (floor > 0) {
    if (lower === undefined) {
      return {
        ...base,
        verdict: 'wait',
        shortfall: 0,
        reason:
          `approximate_count_lower_bound is absent, so the ${floor}-person floor cannot be checked. Meta ` +
          `returns -1 for an audience that has been inactive 90 days.`,
        warnings,
      };
    }
    if (lower < floor) {
      return {
        ...base,
        verdict: 'wait',
        shortfall: floor - lower,
        reason:
          `${lower} people is ${floor - lower} short of the ${floor}-person floor for reliable delivery. ` +
          `The cheap lever is a longer retention window, not more budget.`,
        warnings,
      };
    }
  }

  return {
    ...base,
    verdict: 'ready',
    shortfall: 0,
    reason: `delivery_status 200, operation_status ${op ?? 'absent'}, ${lower ?? 'unknown'} people.`,
    warnings,
  };
}

/**
 * READ-ONLY port. A function rather than a client object, so this module cannot be handed
 * something that can write, and so a test needs no fixture beyond a closure.
 *
 * Wire it as `(path, params) => client.get(path, params, { adAccountId })`.
 */
export type AudienceFetch = (path: string, params: Record<string, string>) => Promise<unknown>;

export interface AwaitReadyOptions extends ReadinessOptions {
  /** Defaults to 20. */
  maxAttempts?: number;
  /** Defaults to 60_000. Engagement-audience prefill is reported at ~30min to a few hours. */
  intervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls an audience until it is usable, fails terminally, or the attempt budget runs out.
 *
 * The gate belongs HERE, on the seed and on any audience about to be targeted — and
 * explicitly NOT on a lookalike that is merely populating: Meta states that ads can run
 * against a populating lookalike and delivery catches up. Blocking on that would cost days
 * for nothing. What must not happen is (a) targeting an audience at `delivery_status 300`,
 * and (b) building a lookalike from a seed that has not finished its prefill, because the
 * seed snapshot at build time is what gets modelled and that mistake is permanent.
 */
export async function awaitAudienceReady(
  fetch: AudienceFetch,
  audienceId: string,
  opts: AwaitReadyOptions = {},
): Promise<AudienceReadiness> {
  const maxAttempts = opts.maxAttempts ?? 20;
  const intervalMs = opts.intervalMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const readinessOpts: ReadinessOptions =
    opts.qualityFloor !== undefined ? { qualityFloor: opts.qualityFloor } : {};

  let last: AudienceReadiness | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await fetch(audienceId, { fields: AUDIENCE_READ_FIELDS });
    const node = asStatusNode(raw, audienceId);
    const readiness = classifyAudienceReadiness(node, readinessOpts);
    last = { ...readiness, attempts: attempt };
    if (last.verdict !== 'wait') return last;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  const fallback: AudienceReadiness = last ?? {
    verdict: 'wait',
    audienceId,
    operationStatusCode: undefined,
    deliveryStatusCode: undefined,
    approximateLowerBound: undefined,
    shortfall: 0,
    reason: 'no response',
    warnings: [],
    attempts: 0,
  };
  return {
    ...fallback,
    reason:
      `${fallback.reason} Still not ready after ${fallback.attempts} attempts over ` +
      `~${Math.round((maxAttempts * intervalMs) / 60_000)} minutes. Do not publish an ad set against it.`,
  };
}

/** Defensive parse: the Graph response is `unknown`, and a missing field must not read as 0. */
export function asStatusNode(raw: unknown, fallbackId: string): AudienceStatusNode {
  if (typeof raw !== 'object' || raw === null) return { id: fallbackId };
  const o = raw as Record<string, unknown>;
  const node: AudienceStatusNode = { id: typeof o['id'] === 'string' ? o['id'] : fallbackId };

  const op = readStatus(o['operation_status']);
  if (op !== undefined) node.operation_status = op;
  const delivery = readStatus(o['delivery_status']);
  if (delivery !== undefined) node.delivery_status = delivery;

  if (typeof o['name'] === 'string') node.name = o['name'];
  const lower = readNumber(o['approximate_count_lower_bound']);
  if (lower !== undefined) node.approximate_count_lower_bound = lower;
  const upper = readNumber(o['approximate_count_upper_bound']);
  if (upper !== undefined) node.approximate_count_upper_bound = upper;
  const retention = readNumber(o['retention_days']);
  if (retention !== undefined) node.retention_days = retention;
  const updated = readNumber(o['time_content_updated']);
  if (updated !== undefined) node.time_content_updated = updated;

  return node;
}

function readStatus(v: unknown): { code?: number; description?: string } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: { code?: number; description?: string } = {};
  const code = readNumber(o['code']);
  if (code !== undefined) out.code = code;
  if (typeof o['description'] === 'string') out.description = o['description'];
  return out;
}

function readNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * Compares what was sent with what Meta stored.
 *
 * Meta silently truncates an over-large retention window rather than rejecting it, so
 * without this the funnel runs against a shorter window than it was designed for and the
 * pool forecast is quietly wrong. Returns undefined when they match.
 */
export function retentionDrift(sentDays: number, storedDays: number | undefined): string | undefined {
  if (storedDays === undefined) {
    return `retention_days was not returned on read-back, so the ${sentDays}-day window is unverified.`;
  }
  if (storedDays === sentDays) return undefined;
  return (
    `retention_days was sent as ${sentDays} and Meta stored ${storedDays}. Meta truncates silently; ` +
    `every pool-size forecast built on ${sentDays} days is now wrong.`
  );
}

// ---------------------------------------------------------------------------
// The human-only gate in front of all of the above
// ---------------------------------------------------------------------------

/**
 * READ-ONLY. `GET act_<id>?fields=tos_accepted` and check `custom_audience_tos === 1`.
 *
 * Custom Audience ToS acceptance is per-user-per-business, UI-only, and there is NO API
 * to grant it. It blocks audience creation entirely. This belongs in preflight next to the
 * existing "no ad accounts / no Pages assigned" checks, so it fails as a named blocker
 * rather than as a confusing `#200` at publish time.
 */
export const CUSTOM_AUDIENCE_TOS_FIELDS = 'tos_accepted';

export function customAudienceTosUrl(adAccountId: string): string {
  const bare = adAccountId.replace(/^act_/, '');
  return `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${bare}`;
}

/**
 * Error subcodes that all mean "a human must accept terms in the UI".
 *
 * All three must be treated as one terminal class. Handling only 1870090 — the one most
 * commonly cited — lets 1870034 fall through into a generic-permission retry loop that can
 * never succeed, and an autonomous system will retry it forever.
 */
export const TOS_NOT_ACCEPTED_SUBCODES: ReadonlySet<number> = new Set([
  1870034, // Custom Audience Terms Not Accepted
  1870090, // Custom Audience terms
  1870092, // Meta Business Tools terms — a SEPARATE acceptance from the two above
]);

/** Deterministic and fixable without a human: chunk, or fix the retention value, and resend. */
export const AUDIENCE_SPLIT_REQUIRED_SUBCODES: ReadonlySet<number> = new Set([
  1870231, // too many videos (>200)
  1713153, // too many page sources (>5)
]);

export const RETENTION_MUST_BE_ZERO_SUBCODE = 1713214;

export interface TosStatus {
  accepted: boolean;
  reason: string;
  acceptanceUrl: string;
}

export function readTosStatus(raw: unknown, adAccountId: string): TosStatus {
  const acceptanceUrl = customAudienceTosUrl(adAccountId);
  if (typeof raw !== 'object' || raw === null) {
    return { accepted: false, reason: 'no response from GET act_<id>?fields=tos_accepted', acceptanceUrl };
  }
  const tos = (raw as Record<string, unknown>)['tos_accepted'];
  if (typeof tos !== 'object' || tos === null) {
    return { accepted: false, reason: 'tos_accepted was absent from the response', acceptanceUrl };
  }
  const flag = (tos as Record<string, unknown>)['custom_audience_tos'];
  const accepted = flag === 1 || flag === '1';
  return {
    accepted,
    reason: accepted
      ? 'custom_audience_tos = 1 at the business level'
      : `custom_audience_tos is ${String(flag)}. Acceptance is UI-only — there is no API to grant it. ` +
        `Note this system authenticates as a SYSTEM USER, and whether a system user inherits ` +
        `business-level acceptance is UNVERIFIED; practitioner reports suggest a human in the OWNING ` +
        `business must accept first.`,
    acceptanceUrl,
  };
}
