/**
 * Video generation provider abstraction.
 *
 * The interface is deliberately tiny — `submit`, `poll`, `estimateCost`, plus a
 * capability descriptor per model. It exists for three reasons that are all facts
 * about the market rather than guesses about the future
 * (docs/research/00-SYNTHESIS.md §5.6):
 *
 *  1. The verified providers use INCOMPATIBLE BILLING UNITS. Veo is priced against
 *     seconds of output video; Seedance is priced against pixel-frame tokens
 *     (w × h × frames / 1024). There is no single formula, so `estimateCost` has to
 *     be a per-provider method rather than shared arithmetic. A system with a
 *     per-tenant generation budget cap cannot skip this.
 *  2. Model ids rotate inside release cycles. A locally-installed vendor catalogue
 *     was already contradicted by the live probe six weeks later, and Veo 3.1 states
 *     a retirement of "November 17, 2026 or later". **Model ids are configuration,
 *     never constants** — every provider here takes a catalogue override.
 *  3. Aspect ratio is the binding creative constraint and it is knowable up front.
 *     4:5 is Meta's recommended Feed ratio and no video model in the live catalogue
 *     produces it. The descriptor makes that checkable BEFORE a clip is paid for,
 *     instead of at assembly time when the money is already spent.
 */

export type ProviderId = 'veo' | 'seedance';

/**
 * Every ratio observed across the live catalogue. `4:5` is included precisely so it
 * can be REQUESTED and REFUSED with a specific message — it is Meta's recommended
 * Feed ratio and nothing generates it natively.
 */
export type AspectRatio =
  | '21:9' | '1.91:1' | '16:9' | '3:2' | '5:4' | '4:3'
  | '1:1' | '4:5' | '3:4' | '9:16' | 'adaptive';

export type Resolution = '480p' | '720p' | '1080p' | '4k';

/** `none` — the model has no audio track at all. `always` — audio cannot be turned off. */
export type AudioSupport = 'none' | 'optional' | 'always';

/**
 * Veo accepts 4, 6 or 8 seconds and nothing between. Seedance accepts every integer
 * in a contiguous range (the probe corrected the widespread belief that only 3/5/10
 * are accepted). Those are different shapes, so the descriptor carries both.
 */
export type DurationSupport =
  | { readonly kind: 'discrete'; readonly seconds: readonly number[] }
  | { readonly kind: 'integerRange'; readonly minSeconds: number; readonly maxSeconds: number };

export type BillingUnit = 'seconds-of-output' | 'pixel-frame-tokens';

/**
 * Keyframe conditioning. Split three ways because BytePlus silently ignores content
 * blocks it does not understand (video-gen-byteplus-seedance.md §15 gotcha 2), so
 * sending a `last_frame` to a model that does not do interpolation is not an error —
 * it is a correctly-rendered, fully-billed video that ignored half the brief. The
 * whole point of a capability descriptor is to catch that before the money is spent.
 */
export type KeyframeSupport = 'none' | 'first' | 'first-and-last';

/** Vertex publishes a $/second rate per (model, resolution, audio-on/off). */
export interface PerSecondRate {
  readonly resolution: Resolution;
  /** undefined = the vendor publishes no rate for this cell; asking for it must fail loudly. */
  readonly usdPerSecondWithAudio: number | undefined;
  readonly usdPerSecondSilent: number | undefined;
}

/**
 * A BytePlus price-sheet row. Matchers are optional; an omitted matcher means "any".
 * Rows are evaluated in order, so put the specific ones first.
 */
export interface TokenRate {
  readonly label: string;
  readonly usdPerMillionTokens: number;
  readonly resolutions?: readonly Resolution[];
  readonly audio?: boolean;
  /** BytePlus charges less when a video was supplied as input (edit/extend lane). */
  readonly withVideoInput?: boolean;
}

export type BillingModel =
  | { readonly unit: 'seconds-of-output'; readonly rates: readonly PerSecondRate[] }
  | { readonly unit: 'pixel-frame-tokens'; readonly fps: number; readonly rates: readonly TokenRate[] };

/**
 * Concurrency is PER MODEL, not per account (synthesis §12 adjudication #9). Driving a
 * single global semaphore from the wrong number understated the recommended Seedance
 * lane's ceiling by ~3.3× and missed the tightest limit in the whole surface, which is
 * a concurrency of ONE on Dreamina 2.0 at 4K.
 */
export interface ConcurrencyLimit {
  readonly limit: number;
  /**
   * `documented` — the vendor publishes a concurrency number.
   * `derived-from-rpm` — the vendor publishes only a request rate; the number here is
   * an operational stand-in so the semaphore stays uniform, NOT a vendor limit.
   */
  readonly source: 'documented' | 'derived-from-rpm';
  /** Narrower caps for specific resolutions. 4K on Dreamina 2.0 is 1, not 3 or 10. */
  readonly overrides: readonly { readonly resolution: Resolution; readonly limit: number }[];
}

export interface Retirement {
  /** ISO date, or undefined when the vendor has announced nothing. */
  readonly earliest: string | undefined;
  /**
   * Google says "November 17, 2026 **or later**" — that is a floor, not a date, and
   * code that treats it as an expiry will retire a working model early.
   */
  readonly qualifier: 'exact' | 'or-later' | 'unannounced';
}

export interface ModelCapabilities {
  readonly providerId: ProviderId;
  /** Configuration, never a constant. See the file header. */
  readonly modelId: string;
  readonly durations: DurationSupport;
  readonly resolutions: readonly Resolution[];
  readonly aspectRatios: readonly AspectRatio[];
  /** 24 on every model probed, on both providers. Neither exposes an fps control. */
  readonly fps: number;
  readonly audio: AudioSupport;
  readonly keyframes: KeyframeSupport;
  readonly maxSamplesPerRequest: number;
  readonly concurrency: ConcurrencyLimit;
  readonly requestsPerMinute: number;
  /**
   * Narrower request rates for specific resolutions, same shape as the concurrency
   * overrides and for the same reason: 4K on `dreamina-seedance-2-0-260128` is 15 RPM
   * against the model's 180/600, so a limiter reading the top-level number alone
   * over-drives that lane by up to 40x.
   */
  readonly requestsPerMinuteOverrides: readonly {
    readonly resolution: Resolution;
    readonly limit: number;
  }[];
  /**
   * Whether the MODEL qualifies for the vendor's IP indemnity. Google's covers only GA
   * Vertex models on a PAID account; the paid-account half is an account fact this
   * descriptor cannot see, so this flag is necessary, not sufficient. BytePlus has no
   * equivalent clause at all, so every Seedance model is false.
   *
   * This is deliberately a plain boolean and nothing here enforces it — a policy layer
   * decides whether an unindemnified model may be used for a given brand.
   */
  readonly indemnified: boolean;
  readonly indemnityNote: string;
  readonly retirement: Retirement;
  /**
   * A Seedance task that is already RUNNING cannot be cancelled — DELETE works only
   * while it is queued. Cost control is therefore a pre-submit problem on every
   * provider here, and this flag exists so a caller cannot assume otherwise.
   */
  readonly cancellableWhileRunning: boolean;
  /** Seconds the provider's result URL stays fetchable. undefined = we own the sink (Veo→GCS). */
  readonly resultUrlTtlSeconds: number | undefined;
  readonly regions: readonly string[];
  readonly billing: BillingModel;
  readonly notes: readonly string[];
}

export type ImageRef =
  | { readonly kind: 'uri'; readonly uri: string; readonly mimeType: 'image/png' | 'image/jpeg' }
  | { readonly kind: 'base64'; readonly data: string; readonly mimeType: 'image/png' | 'image/jpeg' };

export interface GenerationSpec {
  readonly modelId: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly aspectRatio: AspectRatio;
  readonly resolution: Resolution;
  /**
   * Explicit on every call, never defaulted. On Vertex audio-off HALVES the Veo 3.1
   * price; on `seedance-1-5-pro` the field defaults to TRUE and forgetting it doubles
   * the rate. In both directions the default is the expensive one.
   */
  readonly audio: boolean;
  /** Veo `sampleCount` (1–4). Seedance has no equivalent and rejects anything above 1. */
  readonly samples?: number;
  readonly seed?: number;
  readonly negativePrompt?: string;
  readonly firstFrame?: ImageRef;
  readonly lastFrame?: ImageRef;
  /** Veo `storageUri` (gs://). Overrides the provider default. Ignored by Seedance. */
  readonly outputUri?: string;
  /** Seedance `callback_url`. Ignored by Veo, which uses Pub/Sub instead. */
  readonly callbackUrl?: string;
  /** Vertex `labels` — per-campaign billing attribution. Ignored by Seedance. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface CostEstimate {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly currency: 'USD';
  /**
   * Integer millionths of a dollar. **Sum this** across a batch.
   *
   * A 480p Seedance exploration clip costs $0.049005. Rounded to whole cents that is
   * either 4 or 5 — a 2% error per clip, and the exploration lane runs fifty at a time,
   * so accumulating in cents drifts the generation budget guard by real money.
   */
  readonly microUnits: number;
  /** Integer minor units (USD cents), rounded UP. For display and single-item limits — do not sum. */
  readonly minorUnits: number;
  readonly billingUnit: BillingUnit;
  /** Seconds of output, or pixel-frame tokens. The vendor's own unit, for the ledger. */
  readonly billedUnits: number;
  readonly samples: number;
  /**
   * false when some input to the arithmetic is UNVERIFIED — an inferred frame size, an
   * unpriced tier. The caller must not present an inexact estimate as a quote.
   */
  readonly exact: boolean;
  /** The arithmetic, in words, so a spend ledger row can be audited later. */
  readonly basis: string;
}

export type TaskState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

/**
 * How to route a failure. Encoded because two of these must never be automated:
 * third-party-IP refusals go to a human, and nothing here may "relax the safety filter
 * and retry" — that is carve-out 2 of Google's indemnity and voids coverage for the
 * output (video-gen-google-veo.md §7.3).
 */
export type SafetyRoute = 'RETRY' | 'AUTO_REWRITE' | 'HUMAN_REVIEW' | 'ABORT';

export interface ProviderTaskError {
  readonly code: string;
  readonly message: string;
  readonly category: string;
  readonly route: SafetyRoute;
  /** Vendor support codes parsed out of the message, for the provenance ledger. */
  readonly supportCodes: readonly string[];
}

export interface GeneratedVideo {
  readonly uri: string | undefined;
  readonly base64: string | undefined;
  readonly mimeType: string;
}

export interface TaskStatus {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly taskId: string;
  readonly state: TaskState;
  readonly videos: readonly GeneratedVideo[];
  /**
   * Videos the provider suppressed for safety. Veo reports `done: true` with FEWER
   * videos than requested and no error at all, so this and `partial` are the only
   * signal that a batch silently under-delivered.
   */
  readonly filteredCount: number;
  readonly filteredReasons: readonly string[];
  /** true when the task "succeeded" but returned fewer videos than were requested. */
  readonly partial: boolean;
  readonly error: ProviderTaskError | undefined;
  /** Actual billed units, once the provider reports them. Reconcile against the estimate. */
  readonly billedUnits: number | undefined;
  /** Epoch ms after which the result URL is dead. Seedance: 24h. Re-host before this. */
  readonly resultExpiresAt: number | undefined;
}

export interface SubmitResult {
  readonly providerId: ProviderId;
  readonly modelId: string;
  /** Opaque to the caller; `poll` accepts exactly this string. */
  readonly taskId: string;
  readonly submittedAt: number;
  /** The pre-submit estimate. Nothing can be cancelled after this point — see below. */
  readonly estimate: CostEstimate;
}

export interface VideoProvider {
  readonly id: ProviderId;
  /** Throws UnknownModelError rather than guessing defaults for an unrecognised id. */
  capabilities(modelId: string): ModelCapabilities;
  models(): readonly ModelCapabilities[];
  /** Gates the spec first: an unsupported spec has no cost, it has an error. */
  estimateCost(spec: GenerationSpec): CostEstimate;
  submit(spec: GenerationSpec): Promise<SubmitResult>;
  /**
   * `expectedSamples` is the sample count the job was submitted with — pass
   * `SubmitResult.estimate.samples`. Providers that can return FEWER videos than were
   * asked for use it to detect a silently short batch; on a provider whose
   * `maxSamplesPerRequest` is 1 it is simply ignored. It is optional because the task id
   * alone is enough to poll, but omitting it on Veo makes the provider's most common
   * failure mode indistinguishable from success.
   */
  poll(taskId: string, expectedSamples?: number): Promise<TaskStatus>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CapabilityError extends Error {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly field: string;

  constructor(providerId: ProviderId, modelId: string, field: string, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.providerId = providerId;
    this.modelId = modelId;
    this.field = field;
  }
}

export class UnknownModelError extends Error {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly known: readonly string[];

  constructor(providerId: ProviderId, modelId: string, known: readonly string[]) {
    super(
      `Unknown ${providerId} model "${modelId}". Known: ${known.join(', ') || '(none configured)'}. ` +
        `Model ids are CONFIGURATION here, not constants — vendors rotate them inside release ` +
        `cycles and a locally-installed catalogue was already stale six weeks after capture. ` +
        `Add a ModelCapabilities entry for it rather than letting the pipeline assume defaults.`,
    );
    this.name = 'UnknownModelError';
    this.providerId = providerId;
    this.modelId = modelId;
    this.known = known;
  }
}

export class ProviderRequestError extends Error {
  readonly providerId: ProviderId;
  readonly httpStatus: number;
  readonly body: string;

  constructor(providerId: ProviderId, httpStatus: number, body: string, message: string) {
    super(message);
    this.name = 'ProviderRequestError';
    this.providerId = providerId;
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

/**
 * The single most load-bearing sentence in the provider research
 * (docs/research/live-provider-probe.md): 4:5 is Meta's recommended Feed video ratio
 * and NOTHING in the live catalogue generates it. Quoted into the error text so the
 * 3am reader does not have to go and find out whether a different model would help.
 */
export const NO_NATIVE_4_5_NOTE =
  '4:5 is Meta\'s recommended Feed video ratio and NO video model in the 2026-09-02 live ' +
  'catalogue generates it natively — switching provider will not fix this. Generate a 9:16 ' +
  'master and derive 4:5 in the ffmpeg reframing stage.';

export function supportsAspectRatio(caps: ModelCapabilities, ratio: AspectRatio): boolean {
  return caps.aspectRatios.includes(ratio);
}

export function supportsDuration(caps: ModelCapabilities, seconds: number): boolean {
  const d = caps.durations;
  if (d.kind === 'discrete') return d.seconds.includes(seconds);
  return Number.isInteger(seconds) && seconds >= d.minSeconds && seconds <= d.maxSeconds;
}

export function describeDurations(caps: ModelCapabilities): string {
  const d = caps.durations;
  return d.kind === 'discrete'
    ? `${d.seconds.join(', ')} seconds only`
    : `any integer ${d.minSeconds}-${d.maxSeconds} seconds`;
}

export type AspectPlan =
  | { readonly kind: 'native'; readonly generateAt: AspectRatio }
  | {
      readonly kind: 'reframe';
      readonly generateAt: AspectRatio;
      readonly deliverAt: AspectRatio;
      readonly reason: string;
    }
  | { readonly kind: 'unsupported'; readonly deliverAt: AspectRatio; readonly reason: string };

/**
 * Answer "can this model deliver that ratio, and if not what has to happen" BEFORE
 * anything is generated. Call this at plan time; `assertSpecSupported` is the backstop
 * that fires if you did not.
 *
 * The master is always 9:16 where available: it is the densest crop and the native
 * ratio for Reels/Stories, and a 16:9 master cannot be safely auto-cropped to 9:16
 * without losing the subject. Reframing down from 9:16 is cheap; reframing up is not
 * possible.
 */
export function planAspectRatio(caps: ModelCapabilities, deliverAt: AspectRatio): AspectPlan {
  if (supportsAspectRatio(caps, deliverAt)) return { kind: 'native', generateAt: deliverAt };
  if (supportsAspectRatio(caps, '9:16')) {
    return {
      kind: 'reframe',
      generateAt: '9:16',
      deliverAt,
      reason:
        `${caps.modelId} generates ${caps.aspectRatios.join(', ')} only, so ${deliverAt} must be ` +
        `derived from a 9:16 master by the ffmpeg reframing stage.` +
        (deliverAt === '4:5' ? ` ${NO_NATIVE_4_5_NOTE}` : ''),
    };
  }
  return {
    kind: 'unsupported',
    deliverAt,
    reason:
      `${caps.modelId} generates ${caps.aspectRatios.join(', ')} and cannot produce a 9:16 master ` +
      `to reframe from, so ${deliverAt} is unreachable on this model.`,
  };
}

/** Throws a CapabilityError naming the exact field and the actual cause. */
export function assertSpecSupported(caps: ModelCapabilities, spec: GenerationSpec): void {
  const fail = (field: string, message: string): never => {
    throw new CapabilityError(caps.providerId, caps.modelId, field, message);
  };

  if (spec.modelId !== caps.modelId) {
    fail('modelId', `Spec is for "${spec.modelId}" but was checked against "${caps.modelId}".`);
  }

  if (!caps.resolutions.includes(spec.resolution)) {
    fail(
      'resolution',
      `${caps.modelId} cannot render ${spec.resolution} (supports ${caps.resolutions.join(', ')}).` +
        (spec.resolution === '1080p'
          ? ' Meta\'s recommended vertical video spec is 1080x1920, so this model cannot serve the Feed master.'
          : ''),
    );
  }

  if (!supportsAspectRatio(caps, spec.aspectRatio)) {
    const plan = planAspectRatio(caps, spec.aspectRatio);
    fail(
      'aspectRatio',
      `${caps.modelId} cannot generate ${spec.aspectRatio} natively ` +
        `(supports ${caps.aspectRatios.join(', ')}). ` +
        (plan.kind === 'reframe' ? plan.reason : plan.kind === 'unsupported' ? plan.reason : '') +
        ' Call planAspectRatio() at plan time instead of discovering this at assembly time.',
    );
  }

  if (!supportsDuration(caps, spec.durationSeconds)) {
    fail(
      'durationSeconds',
      `${caps.modelId} does not accept ${spec.durationSeconds}s — it accepts ` +
        `${describeDurations(caps)}. A longer ad is multi-shot plus concatenation, not a longer clip.`,
    );
  }

  if (spec.audio && caps.audio === 'none') {
    fail(
      'audio',
      `${caps.modelId} produces no audio track at all, so audio: true cannot be honoured. ` +
        `Generate silent and dub, or pick a model whose descriptor says audio "optional".`,
    );
  }
  if (!spec.audio && caps.audio === 'always') {
    fail(
      'audio',
      `${caps.modelId} always generates audio and offers no opt-out, so audio: false cannot be ` +
        `honoured — and on this provider the audio-off price break does not exist either.`,
    );
  }

  // Keyframes before samples: on Seedance an unsupported keyframe role is silently
  // dropped rather than rejected, so this gate is the only thing standing between a
  // caller and a billed clip that ignored the last-frame half of the brief.
  if (spec.lastFrame !== undefined && caps.keyframes !== 'first-and-last') {
    fail(
      'lastFrame',
      `${caps.modelId} does not support last-frame interpolation (keyframes: "${caps.keyframes}"). ` +
        (caps.providerId === 'seedance'
          ? 'ModelArk silently ignores content blocks it does not understand, so this would not ' +
            'fail — it would return a fully-billed video that ignored the last frame. '
          : '') +
        'Pick a model whose descriptor says "first-and-last", or drop spec.lastFrame.',
    );
  }
  if (spec.firstFrame !== undefined && caps.keyframes === 'none') {
    fail(
      'firstFrame',
      `${caps.modelId} accepts no image conditioning at all (keyframes: "none"), so ` +
        `spec.firstFrame cannot be honoured. Use a text-to-video spec or a different model.`,
    );
  }

  const samples = spec.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) {
    fail('samples', `samples must be a positive integer, got ${String(spec.samples)}.`);
  }
  if (samples > caps.maxSamplesPerRequest) {
    fail(
      'samples',
      `${caps.modelId} returns at most ${caps.maxSamplesPerRequest} sample(s) per request, ` +
        `got ${samples}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Integer millionths of a dollar. Everything internal accumulates in this unit. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** Rounded UP: a budget guard that under-states a cost is the dangerous direction. */
export function microsToMinorUnits(micros: number): number {
  return Math.ceil(micros / 10_000);
}

// ---------------------------------------------------------------------------
// Per-model concurrency
// ---------------------------------------------------------------------------

export function concurrencyLimitFor(caps: ModelCapabilities, resolution: Resolution): number {
  for (const o of caps.concurrency.overrides) {
    if (o.resolution === resolution) return o.limit;
  }
  return caps.concurrency.limit;
}

/** The request rate for this exact (model, resolution) lane, not the model's headline number. */
export function requestsPerMinuteFor(caps: ModelCapabilities, resolution: Resolution): number {
  for (const o of caps.requestsPerMinuteOverrides) {
    if (o.resolution === resolution) return o.limit;
  }
  return caps.requestsPerMinute;
}

/**
 * The semaphore key. It carries the resolution ONLY where the descriptor narrows the
 * limit for it, because Dreamina 2.0 at 4K is a concurrency of 1 while the same model
 * at 1080p is 3 or 10 — they are separate queues, not one queue with a smaller number.
 */
export function concurrencySlot(caps: ModelCapabilities, resolution: Resolution): string {
  const narrowed = caps.concurrency.overrides.some((o) => o.resolution === resolution);
  return `${caps.providerId}:${caps.modelId}${narrowed ? `@${resolution}` : ''}`;
}

/**
 * A per-model semaphore driven from the capability descriptors, never a single global
 * number. Slots are handed directly from a releaser to the next waiter so the count
 * cannot drift, and each release function is idempotent because a retry wrapper that
 * releases twice would silently widen the limit.
 */
export class ModelSemaphore {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async acquire(caps: ModelCapabilities, resolution: Resolution): Promise<() => void> {
    const slot = concurrencySlot(caps, resolution);
    const limit = concurrencyLimitFor(caps, resolution);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Concurrency limit for ${slot} is ${limit}; a descriptor must declare at least 1.`,
      );
    }

    const current = this.active.get(slot) ?? 0;
    if (current < limit) {
      this.active.set(slot, current + 1);
    } else {
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(slot) ?? [];
        queue.push(resolve);
        this.waiters.set(slot, queue);
      });
      // The releasing holder handed its slot over without decrementing, so the count
      // is already correct and must not be incremented again here.
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(slot);
    };
  }

  /** Runs `fn` holding a slot. Releases on throw. */
  async run<T>(
    caps: ModelCapabilities,
    resolution: Resolution,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(caps, resolution);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  inFlight(slot: string): number {
    return this.active.get(slot) ?? 0;
  }

  queueDepth(slot: string): number {
    return this.waiters.get(slot)?.length ?? 0;
  }

  private release(slot: string): void {
    const queue = this.waiters.get(slot);
    const next = queue?.shift();
    if (next) {
      next();
      return;
    }
    const current = this.active.get(slot) ?? 0;
    this.active.set(slot, Math.max(0, current - 1));
  }
}

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

export type RetirementRisk = 'unannounced' | 'active' | 'within-90-days' | 'past-earliest';

/**
 * `past-earliest` does NOT mean the model is gone — Google's wording is "or later", so
 * the announced date is a floor. It means the model may vanish without further notice
 * and a migration should already have happened.
 */
export function retirementRisk(caps: ModelCapabilities, now: Date): RetirementRisk {
  const { earliest, qualifier } = caps.retirement;
  if (earliest === undefined || qualifier === 'unannounced') return 'unannounced';
  const then = Date.parse(earliest);
  if (Number.isNaN(then)) return 'unannounced';
  const daysAway = (then - now.getTime()) / 86_400_000;
  if (daysAway < 0) return 'past-earliest';
  if (daysAway <= 90) return 'within-90-days';
  return 'active';
}

/** Convenience for a policy layer that refuses unindemnified models for some brands. */
export function assertIndemnified(caps: ModelCapabilities): void {
  if (caps.indemnified) return;
  throw new CapabilityError(
    caps.providerId,
    caps.modelId,
    'indemnified',
    `${caps.modelId} is not covered by a vendor IP indemnity. ${caps.indemnityNote}`,
  );
}
