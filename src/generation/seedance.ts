import {
  assertSpecSupported,
  microsToMinorUnits,
  CapabilityError,
  ProviderRequestError,
  UnknownModelError,
  type AspectRatio,
  type CostEstimate,
  type GenerationSpec,
  type KeyframeSupport,
  type ModelCapabilities,
  type Resolution,
  type SubmitResult,
  type TaskStatus,
  type TokenRate,
  type VideoProvider,
} from './provider.ts';

/**
 * BytePlus ModelArk — Seedance / Dreamina video generation.
 *
 * Three facts shape everything in this file:
 *
 *  1. **Billing is per pixel-frame token**, not per clip and not per second:
 *     `tokens = width x height x (fps x duration + 1) / 1024`. That formula is
 *     frame-exact against a real billed generation (864x480, 5.042s, 24fps, 121
 *     frames -> 49,005 tokens, matching the invoice to the digit). The vendor's own
 *     documented estimate omits the +1 frame and under-counts by ~0.8%.
 *  2. **A running task cannot be cancelled.** `DELETE` works only while the task is
 *     still `queued`; once it starts you are billed regardless
 *     (`InvalidAction.RunningTaskDeletion`). Every cost control here is therefore
 *     pre-submit.
 *  3. **Concurrency is per model.** 10 on the Seedance 1.x line, 3 on Dreamina 2.x for
 *     an individual account, and 1 at 4K. A single global semaphore is wrong in both
 *     directions at once.
 */

export const SEEDANCE_DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';

/** 24 on every video model probed; there is no fps control anywhere in the API. */
export const SEEDANCE_FPS = 24;

/**
 * Frame area per resolution tier, in pixels.
 *
 * Only valid for the 16:9 / 9:16 family — the three verified rows below reproduce the
 * published per-clip prices exactly, and 1080p is 1088 pixels wide, not 1080. Nothing
 * in the research pins the pixel dimensions of 1:1, 4:3, 3:4 or 21:9 output, so a cost
 * estimate for those ratios is refused rather than guessed (see `estimateCost`).
 */
export interface FrameArea {
  readonly areaPx: number;
  readonly dims: string;
  readonly verified: boolean;
}

export const SEEDANCE_FRAME_AREAS: Readonly<Record<Resolution, FrameArea>> = {
  '480p': { areaPx: 864 * 480, dims: '864x480', verified: true },
  '720p': { areaPx: 1280 * 720, dims: '1280x720', verified: true },
  '1080p': { areaPx: 1920 * 1088, dims: '1920x1088 (1088, not 1080)', verified: true },
  // Exactly 4x the 1080p area. Consistent with the published 4K token prices but never
  // probed, so any estimate built on it is flagged inexact.
  '4k': { areaPx: 3840 * 2176, dims: '3840x2176 (INFERRED, unprobed)', verified: false },
};

/** Ratios whose frame dimensions the verified areas above are known to describe. */
const AREA_VERIFIED_RATIOS: readonly AspectRatio[] = ['16:9', '9:16'];

/**
 * The billed token count. `+1` is not a rounding fudge — the real invoice counted 121
 * frames for a 5-second 24fps clip, and budgeting on the documented `fps x duration`
 * form under-states every generation.
 */
export function pixelFrameTokens(
  areaPx: number,
  durationSeconds: number,
  fps: number = SEEDANCE_FPS,
): number {
  const frames = fps * durationSeconds + 1;
  return (areaPx * frames) / 1024;
}

const NO_INDEMNITY_NOTE =
  'BytePlus publishes NO clause assigning ownership of generated output to the customer, no ' +
  'indemnity for generated content, and nothing about generating identifiable people or ' +
  'third-party brands. The absence is the finding. Section 4 of the ToS also grants BytePlus a ' +
  'perpetual sub-licensable licence over uploaded data, which covers client product photography.';

const SEEDANCE_COMMON_NOTES: readonly string[] = [
  'Result URLs live 24 hours / 100 downloads; only the TASK RECORD lasts 7 days. Re-host to ' +
    'our own object store on completion — the ModelArk URL is ephemeral.',
  'A running task cannot be cancelled (InvalidAction.RunningTaskDeletion); DELETE works only ' +
    'while queued. Budget guards must run before submit.',
  'Unknown top-level fields are silently ignored, and legacy --flags in the prompt text are ' +
    'mostly unvalidated: --ratio 99:1 was accepted and produced a real, billed video at the ' +
    'wrong aspect. Send only whitelisted top-level JSON fields.',
  'Use callback_url rather than polling in production; polling a small concurrency pool every ' +
    '10s burns quota for nothing.',
];

export type SeedanceAccountTier = 'individual' | 'enterprise';

interface SeedanceModelInput {
  modelId: string;
  durations: { minSeconds: number; maxSeconds: number };
  resolutions: readonly Resolution[];
  aspectRatios: readonly AspectRatio[];
  audio: 'none' | 'optional';
  /**
   * First+last frame is documented for Dreamina 2.5 / 2.0 series / Seedance 1.5 Pro, and
   * explicitly NOT for `seedance-1-0-pro-fast` (video-gen-byteplus-seedance.md §8). The
   * 1.0 line is image-to-video capable, so it is 'first', not 'none'.
   */
  keyframes: KeyframeSupport;
  rates: readonly TokenRate[];
  /** Dreamina 2.x splits by account tier; the Seedance 1.x line does not. */
  tierSplit: boolean;
  /** 4K on Dreamina 2.0 is its own lane: concurrency 1 and 15 RPM, both account types. */
  fourKIsOwnLane?: boolean;
  notes?: readonly string[];
}

function seedanceModel(m: SeedanceModelInput, tier: SeedanceAccountTier): ModelCapabilities {
  const enterprise = tier === 'enterprise';
  const limit = m.tierSplit ? (enterprise ? 10 : 3) : 10;
  const rpm = m.tierSplit ? (enterprise ? 600 : 180) : 600;
  return {
    providerId: 'seedance',
    modelId: m.modelId,
    // Contiguous integers, not a discrete set — 7, 9, 11 and 13 all validate in range.
    durations: { kind: 'integerRange', minSeconds: m.durations.minSeconds, maxSeconds: m.durations.maxSeconds },
    resolutions: m.resolutions,
    aspectRatios: m.aspectRatios,
    fps: SEEDANCE_FPS,
    audio: m.audio,
    keyframes: m.keyframes,
    // The task API generates one video per task; there is no sampleCount equivalent.
    maxSamplesPerRequest: 1,
    concurrency: {
      limit,
      source: 'documented',
      // 4K on Dreamina 2.0 is capped at ONE concurrent task for both account types —
      // the tightest limit in the whole provider surface, and tighter than its 15 RPM.
      overrides: m.fourKIsOwnLane === true ? [{ resolution: '4k', limit: 1 }] : [],
    },
    requestsPerMinute: rpm,
    requestsPerMinuteOverrides:
      m.fourKIsOwnLane === true ? [{ resolution: '4k', limit: 15 }] : [],
    indemnified: false,
    indemnityNote: NO_INDEMNITY_NOTE,
    retirement: { earliest: undefined, qualifier: 'unannounced' },
    cancellableWhileRunning: false,
    resultUrlTtlSeconds: 24 * 60 * 60,
    regions: ['ap-southeast-1', 'eu-west-1'],
    billing: { unit: 'pixel-frame-tokens', fps: SEEDANCE_FPS, rates: m.rates },
    notes: [
      ...SEEDANCE_COMMON_NOTES,
      `Concurrency ${limit} and ${rpm} RPM on an ${tier} account` +
        (m.tierSplit ? ' (this model splits by account tier)' : ' (no account-tier split)') + '.',
      ...(m.notes ?? []),
    ],
  };
}

/** Documented ratio set. The probe found per-model extras; they are not portable. */
const DOCUMENTED_RATIOS: readonly AspectRatio[] = [
  '21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive',
];

/**
 * Defaults, not constants — `GET /models` lies in both directions (it lists models the
 * key cannot call and omits models that work), and Seedance 2.5 appeared six weeks
 * after a shipped vendor catalogue said it did not exist. Pass `models` to override.
 */
export function defaultSeedanceModels(
  tier: SeedanceAccountTier = 'individual',
): readonly ModelCapabilities[] {
  return [
    seedanceModel(
      {
        modelId: 'seedance-1-0-pro-fast-251015',
        durations: { minSeconds: 2, maxSeconds: 12 },
        resolutions: ['480p', '720p', '1080p'],
        // Documented set only. The probed extras (5:4, 3:2) were measured on
        // seedance-1-0-pro, and the dossier is explicit that the undocumented extras are
        // NOT portable across models — 3:2 is accepted there and rejected on Dreamina 2.0.
        aspectRatios: DOCUMENTED_RATIOS,
        audio: 'none',
        // First+last frame is explicitly NOT supported here; image-to-video is.
        keyframes: 'first',
        rates: [{ label: 'online', usdPerMillionTokens: 1.0 }],
        tierSplit: false,
        notes: [
          'The exploration lane: ~$0.049 for a 5s 480p 9:16 clip, the cheapest clip found ' +
            'anywhere. No audio track, and first+last frame is NOT supported on this model.',
          'Aspect ratios are the documented set only — the undocumented 5:4 / 3:2 extras were ' +
            'probed on seedance-1-0-pro, not on this model, and the probe found the extras ' +
            'differ per model.',
          'Offline (service_tier flex) is accepted but the discount is UNPRICED for the 1.0 ' +
            'line — the vendor publishes offline rates for 1.5 Pro only. Do not budget against it.',
        ],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'seedance-1-0-pro-250528',
        durations: { minSeconds: 2, maxSeconds: 12 },
        resolutions: ['480p', '720p', '1080p'],
        // 5:4 and 3:2 are undocumented but were probed as accepted ON THIS MODEL. 1.91:1
        // was probed as rejected here. Do not copy this list to another model.
        aspectRatios: [...DOCUMENTED_RATIOS, '5:4', '3:2'],
        audio: 'none',
        // The first+last-frame list names Dreamina 2.5/2.0 and 1.5 Pro; the 1.0 line is
        // image-to-video only, so last-frame interpolation is refused here too.
        keyframes: 'first',
        rates: [{ label: 'online', usdPerMillionTokens: 2.5 }],
        tierSplit: false,
        notes: ['Confirmed to emit no audio stream at all (single video track in the MP4).'],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'seedance-1-5-pro-251215',
        durations: { minSeconds: 4, maxSeconds: 12 },
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: DOCUMENTED_RATIOS,
        audio: 'optional',
        keyframes: 'first-and-last',
        rates: [
          { label: 'online, audio', usdPerMillionTokens: 2.4, audio: true },
          { label: 'online, silent', usdPerMillionTokens: 1.2, audio: false },
        ],
        tierSplit: false,
        notes: [
          'generate_audio defaults to TRUE and audio DOUBLES the rate here ($2.40 vs $1.20/M). ' +
            'Forgetting the field silently doubles spend.',
        ],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'dreamina-seedance-2-0-mini-260615',
        durations: { minSeconds: 4, maxSeconds: 15 },
        resolutions: ['480p', '720p'],
        // Documented set only: 5:4 / 1.91:1 were probed on dreamina-seedance-2-0, not here.
        aspectRatios: DOCUMENTED_RATIOS,
        audio: 'optional',
        keyframes: 'first-and-last',
        rates: [
          { label: '480p/720p, with video input', usdPerMillionTokens: 2.1, withVideoInput: true },
          { label: '480p/720p, no video input', usdPerMillionTokens: 3.5, withVideoInput: false },
        ],
        tierSplit: true,
        notes: ['Caps at 720p, so it cannot render Meta\'s recommended 1080x1920 vertical spec.'],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'dreamina-seedance-2-0-fast-260128',
        durations: { minSeconds: 4, maxSeconds: 15 },
        resolutions: ['480p', '720p'],
        // Documented set only: 5:4 / 1.91:1 were probed on dreamina-seedance-2-0, not here.
        aspectRatios: DOCUMENTED_RATIOS,
        audio: 'optional',
        keyframes: 'first-and-last',
        rates: [
          { label: '480p/720p, with video input', usdPerMillionTokens: 3.3, withVideoInput: true },
          { label: '480p/720p, no video input', usdPerMillionTokens: 5.6, withVideoInput: false },
        ],
        tierSplit: true,
        notes: ['Caps at 720p, so it cannot render Meta\'s recommended 1080x1920 vertical spec.'],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'dreamina-seedance-2-0-260128',
        durations: { minSeconds: 4, maxSeconds: 15 },
        resolutions: ['480p', '720p', '1080p', '4k'],
        // 5:4 and 1.91:1 were probed as accepted ON THIS MODEL; 3:2 was probed as rejected.
        aspectRatios: [...DOCUMENTED_RATIOS, '5:4', '1.91:1'],
        audio: 'optional',
        keyframes: 'first-and-last',
        rates: [
          { label: '4K, with video input', usdPerMillionTokens: 2.4, resolutions: ['4k'], withVideoInput: true },
          { label: '4K, no video input', usdPerMillionTokens: 4.0, resolutions: ['4k'], withVideoInput: false },
          { label: '1080p, with video input', usdPerMillionTokens: 4.7, resolutions: ['1080p'], withVideoInput: true },
          { label: '1080p, no video input', usdPerMillionTokens: 7.7, resolutions: ['1080p'], withVideoInput: false },
          { label: '480p/720p, with video input', usdPerMillionTokens: 4.3, withVideoInput: true },
          { label: '480p/720p, no video input', usdPerMillionTokens: 7.0, withVideoInput: false },
        ],
        tierSplit: true,
        fourKIsOwnLane: true,
        notes: [
          '4K is CHEAPER per token than 1080p ($4.00 vs $7.70/M) but carries ~4x the tokens, so ' +
            'the clip is far more expensive. Cheaper rate, dearer clip.',
          '4K is also limited to 15 RPM and concurrency 1 for both account types — a separate ' +
            'queue from the same model at 1080p, which is why the semaphore slot carries the ' +
            'resolution here.',
          'The only model in the probed catalogue that accepts 4K; 1440p/2K are rejected everywhere.',
        ],
      },
      tier,
    ),
    seedanceModel(
      {
        modelId: 'dreamina-seedance-2-5-260628',
        durations: { minSeconds: 4, maxSeconds: 30 },
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: DOCUMENTED_RATIOS,
        audio: 'optional',
        keyframes: 'first-and-last',
        rates: [
          { label: '1080p', usdPerMillionTokens: 11.7, resolutions: ['1080p'] },
          { label: '480p/720p', usdPerMillionTokens: 10.7 },
        ],
        tierSplit: true,
        notes: [
          'UNVERIFIED: duration 4-30s and the resolution list are docs-only. The probe key hit ' +
            'ModelNotOpen ("has not activated the model ... activate in the Ark Console"), so the ' +
            'capability matrix here has never been exercised against the API.',
          'ModelNotOpen is NOT NotFound: an access probe that only checks for NotFound reports ' +
            'this model as available when it is not.',
          'The most expensive model in the catalogue: ~$2.89 for a 5s 1080p clip, ~29x Veo 3.1 Fast.',
        ],
      },
      tier,
    ),
  ];
}

export interface SeedanceConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  models?: readonly ModelCapabilities[];
  /** Drives the concurrency and RPM figures on the Dreamina 2.x line. Defaults to the tighter one. */
  accountTier?: SeedanceAccountTier;
  now?: () => number;
}

/**
 * Legacy prompt flags. `--ratio 99:1` was accepted, silently ignored, and produced a
 * real billed video at the default aspect — correctly rendered creative that is simply
 * wrong for the placement. Most of these are never validated, so a typo cannot be
 * caught by the API and has to be caught here.
 */
const LEGACY_FLAG = /(^|\s)--(rs|rt|dur|seed|cf|wm|ratio|resolution|duration|watermark|camerafixed|audio|fps|hd|quality)\b/i;

export class SeedanceTaskNotCancellableError extends Error {
  readonly taskId: string;
  readonly state: string;

  constructor(taskId: string, state: string) {
    super(
      `Seedance task ${taskId} is ${state} and cannot be cancelled — DELETE succeeds only while a ` +
        `task is queued (InvalidAction.RunningTaskDeletion). The generation will be billed in ` +
        `full. Cost control on this provider is a PRE-SUBMIT decision; there is no abort.`,
    );
    this.name = 'SeedanceTaskNotCancellableError';
    this.taskId = taskId;
    this.state = state;
  }
}

export class SeedanceProvider implements VideoProvider {
  readonly id: 'seedance' = 'seedance';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly catalogue: Map<string, ModelCapabilities>;
  private readonly now: () => number;

  constructor(cfg: SeedanceConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? SEEDANCE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.catalogue = new Map();
    for (const m of cfg.models ?? defaultSeedanceModels(cfg.accountTier ?? 'individual')) {
      this.catalogue.set(m.modelId, m);
    }

    if (this.baseUrl.includes('/api/coding/v3')) {
      // Identical on the wire, different budget: /api/coding/v3 draws Coding-Plan quota
      // while /api/v3 bills normally. A copy-pasted base URL charges the wrong budget
      // silently, which is unrecoverable after the fact.
      throw new Error(
        `Seedance baseUrl "${this.baseUrl}" points at /api/coding/v3, which draws the Coding-Plan ` +
          `quota rather than normal billing. The two paths behave identically on the wire, so this ` +
          `misbilling is invisible at runtime. Use /api/v3.`,
      );
    }
  }

  models(): readonly ModelCapabilities[] {
    return [...this.catalogue.values()];
  }

  capabilities(modelId: string): ModelCapabilities {
    const caps = this.catalogue.get(modelId);
    if (!caps) throw new UnknownModelError('seedance', modelId, [...this.catalogue.keys()]);
    return caps;
  }

  estimateCost(spec: GenerationSpec): CostEstimate {
    const caps = this.capabilities(spec.modelId);
    assertSpecSupported(caps, spec);

    const billing = caps.billing;
    if (billing.unit !== 'pixel-frame-tokens') {
      throw new CapabilityError(
        'seedance',
        caps.modelId,
        'billing',
        `Seedance descriptors must bill in pixel-frame-tokens; got "${billing.unit}".`,
      );
    }

    if (!AREA_VERIFIED_RATIOS.includes(spec.aspectRatio)) {
      // Cost here is a function of width x height, so an unknown frame size is an
      // unknown price. Guessing it would silently mis-budget every clip in the ratio.
      throw new CapabilityError(
        'seedance',
        caps.modelId,
        'aspectRatio',
        `Cannot price ${spec.aspectRatio} on ${caps.modelId}: Seedance bills per pixel-frame ` +
          `token, and the frame dimensions this API emits for ${spec.aspectRatio} are UNVERIFIED. ` +
          `Only ${AREA_VERIFIED_RATIOS.join(' and ')} have measured frame sizes. To add one: ` +
          `submit a single clip, read usage.total_tokens off the response, solve ` +
          `area = tokens * 1024 / (24 * duration + 1), and add the row to SEEDANCE_FRAME_AREAS.`,
      );
    }

    const area = SEEDANCE_FRAME_AREAS[spec.resolution];
    const tokens = pixelFrameTokens(area.areaPx, spec.durationSeconds, billing.fps);

    // Nothing in GenerationSpec carries a source video, so every generation on this path
    // is text/image-input and pays the dearer "no video input" rate. If an edit/extend
    // lane is added later, this becomes an input rather than a constant — the cheaper
    // rows are already in the descriptors.
    const hasVideoInput = false;
    const rate = selectTokenRate(billing.rates, spec.resolution, spec.audio, hasVideoInput);
    if (!rate) {
      throw new CapabilityError(
        'seedance',
        caps.modelId,
        'billing',
        `No published rate row for ${caps.modelId} at ${spec.resolution} ` +
          `${spec.audio ? 'with audio' : 'silent'}. Refusing to guess a price.`,
      );
    }

    // tokens/1e6 x $/1e6 tokens collapses to tokens x rate in micros, exactly.
    const microUnits = Math.round(tokens * rate.usdPerMillionTokens);

    return {
      providerId: 'seedance',
      modelId: caps.modelId,
      currency: 'USD',
      microUnits,
      minorUnits: microsToMinorUnits(microUnits),
      billingUnit: 'pixel-frame-tokens',
      billedUnits: tokens,
      samples: 1,
      exact: area.verified,
      basis:
        `${area.dims} x (${billing.fps} x ${spec.durationSeconds} + 1 = ` +
        `${billing.fps * spec.durationSeconds + 1} frames) / 1024 = ${tokens} tokens ` +
        `@ $${rate.usdPerMillionTokens.toFixed(2)}/M (${rate.label})` +
        (area.verified ? '' : ' — INEXACT: frame area for this resolution is inferred, not probed'),
    };
  }

  async submit(spec: GenerationSpec): Promise<SubmitResult> {
    const caps = this.capabilities(spec.modelId);
    // Runs the capability gate and refuses an unpriceable spec before the network call,
    // because there is no abort once the task starts running.
    const estimate = this.estimateCost(spec);

    if (LEGACY_FLAG.test(spec.prompt)) {
      throw new CapabilityError(
        'seedance',
        caps.modelId,
        'prompt',
        `Prompt contains a legacy "--" parameter flag. That path is loosely validated: --ratio ` +
          `99:1 was accepted and produced a real, billed video at the default aspect, and ` +
          `--fps/--watermark/--seed are swallowed with no error at all. Pass parameters as ` +
          `top-level fields instead. Prompt: "${spec.prompt.slice(0, 120)}"`,
      );
    }

    // ModelArk has no negative-prompt field anywhere in the task API, and it silently
    // ignores unknown top-level fields — so quietly dropping this would not fail, it
    // would return a correctly-rendered, fully-billed video that ignored half the brief.
    // Exactly the failure the last-frame gate above exists to prevent, so it is refused
    // here rather than discovered on the invoice.
    if (spec.negativePrompt !== undefined) {
      throw new CapabilityError(
        'seedance',
        caps.modelId,
        'negativePrompt',
        `ModelArk has no negative-prompt field: the task API takes only the whitelisted top-level ` +
          `fields plus content[] blocks, and unknown top-level fields are silently ignored. ` +
          `Sending spec.negativePrompt would therefore not error — it would produce a ` +
          `fully-billed video that ignored it. Fold the exclusion into the positive prompt (and ` +
          `not as a legacy "--" flag, which is also swallowed), or route this brief to Veo, whose ` +
          `parameters.negativePrompt is a real field.`,
      );
    }

    const content: Array<Record<string, unknown>> = [{ type: 'text', text: spec.prompt }];
    if (spec.firstFrame) {
      content.push({
        type: 'image_url',
        image_url: { url: imageUrl(spec.firstFrame, caps.modelId) },
        role: 'first_frame',
      });
    }
    if (spec.lastFrame) {
      content.push({
        type: 'image_url',
        image_url: { url: imageUrl(spec.lastFrame, caps.modelId) },
        role: 'last_frame',
      });
    }

    // Strict whitelist. The API silently ignores unknown top-level fields, so a typo
    // here would never surface as an error — only as a wrong, billed video.
    const body: Record<string, unknown> = {
      model: caps.modelId,
      content,
      resolution: spec.resolution,
      ratio: spec.aspectRatio,
      duration: spec.durationSeconds,
      // Always explicit: the documented default is true, and on 1.5 Pro that doubles the rate.
      generate_audio: spec.audio,
      // Always explicit: a watermarked ad is a wasted impression buy, and the --wm prompt
      // flag that people reach for is silently ignored, so "off" must be a real field.
      watermark: false,
    };
    if (spec.seed !== undefined) {
      // ModelArk types seed as an int and publishes no range. A fractional or negative
      // value is certainly not one, and this API's habit is to swallow what it does not
      // understand — which would silently cost the seed-pinned consistency that creative
      // A/B comparison depends on. Veo checks its own uint32 range locally; this is the
      // same guard, narrowed to what the vendor actually documents.
      if (!Number.isInteger(spec.seed) || spec.seed < 0) {
        throw new CapabilityError(
          'seedance',
          caps.modelId,
          'seed',
          `ModelArk seed must be a non-negative integer; got ${String(spec.seed)}. BytePlus ` +
            `publishes no range, and this API silently ignores values it cannot use — a dropped ` +
            `seed produces a billed clip that is simply not reproducible, with no error.`,
        );
      }
      body['seed'] = spec.seed;
    }
    if (spec.callbackUrl !== undefined) body['callback_url'] = spec.callbackUrl;

    const json = await this.request('POST', '/contents/generations/tasks', body, true);
    const taskId = typeof json['id'] === 'string' ? json['id'] : undefined;
    if (taskId === undefined) {
      throw new ProviderRequestError(
        'seedance',
        200,
        JSON.stringify(json).slice(0, 400),
        `Task creation returned no id for ${caps.modelId}. A task may nonetheless be running and ` +
          `billable and cannot be cancelled; reconcile against GET /contents/generations/tasks ` +
          `before resubmitting.`,
      );
    }

    return {
      providerId: 'seedance',
      modelId: caps.modelId,
      taskId,
      submittedAt: this.now(),
      estimate,
    };
  }

  async poll(taskId: string): Promise<TaskStatus> {
    const json = await this.request('GET', `/contents/generations/tasks/${encodeURIComponent(taskId)}`);

    const modelId = typeof json['model'] === 'string' ? json['model'] : '(unknown)';
    const raw = typeof json['status'] === 'string' ? json['status'] : '';
    const state = mapState(raw);

    const usage = asRecord(json['usage']);
    const billedUnits =
      usage && typeof usage['total_tokens'] === 'number' ? usage['total_tokens'] : undefined;

    const content = asRecord(json['content']);
    const videoUrl = content && typeof content['video_url'] === 'string' ? content['video_url'] : undefined;

    // updated_at is epoch SECONDS. The result URL dies 24h after completion (or after
    // 100 downloads) — the task record surviving 7 days is a different clock and is the
    // usual reason a pipeline "loses" an asset it thought it still had.
    const updatedAt = typeof json['updated_at'] === 'number' ? json['updated_at'] : undefined;
    const ttl = this.catalogue.get(modelId)?.resultUrlTtlSeconds ?? 24 * 60 * 60;
    const resultExpiresAt =
      state === 'SUCCEEDED' && updatedAt !== undefined ? (updatedAt + ttl) * 1000 : undefined;

    const base = { providerId: 'seedance' as const, modelId, taskId };

    if (state === 'FAILED' || state === 'EXPIRED') {
      const err = asRecord(json['error']);
      const message =
        err && typeof err['message'] === 'string'
          ? err['message']
          : `Seedance task ${taskId} reported status "${raw}" with no error body.`;
      const code = err && typeof err['code'] === 'string' ? err['code'] : raw.toUpperCase();
      return {
        ...base,
        state,
        videos: [],
        filteredCount: 0,
        filteredReasons: [],
        partial: false,
        error: { code, message, category: code, route: 'HUMAN_REVIEW', supportCodes: [] },
        billedUnits,
        resultExpiresAt: undefined,
      };
    }

    if (state === 'SUCCEEDED' && videoUrl === undefined) {
      return {
        ...base,
        state: 'FAILED',
        videos: [],
        filteredCount: 0,
        filteredReasons: [],
        partial: false,
        error: {
          code: 'NO_VIDEO_URL',
          message:
            `Seedance reported status "succeeded" for ${taskId} but returned no content.video_url. ` +
            `The generation was billed (${billedUnits ?? 'unknown'} tokens); do not treat this as ` +
            `a creative signal.`,
          category: 'NO_VIDEO_URL',
          route: 'HUMAN_REVIEW',
          supportCodes: [],
        },
        billedUnits,
        resultExpiresAt: undefined,
      };
    }

    return {
      ...base,
      state,
      videos:
        videoUrl === undefined ? [] : [{ uri: videoUrl, base64: undefined, mimeType: 'video/mp4' }],
      filteredCount: 0,
      filteredReasons: [],
      partial: false,
      error: undefined,
      billedUnits,
      resultExpiresAt,
    };
  }

  /**
   * Cancels a task ONLY while it is still queued. Polls first so the caller gets a
   * specific error rather than the vendor's, and so a `running` task is never mistaken
   * for a cancelled one — there is no way to stop a running generation or avoid its bill.
   */
  async cancelIfQueued(taskId: string): Promise<{ cancelled: true }> {
    const status = await this.poll(taskId);
    if (status.state !== 'QUEUED') {
      throw new SeedanceTaskNotCancellableError(taskId, status.state);
    }
    try {
      await this.request('DELETE', `/contents/generations/tasks/${encodeURIComponent(taskId)}`);
    } catch (e) {
      // The task can start between the poll and the DELETE. That race is the exact
      // condition this method exists to describe, so it must not surface as a generic
      // transport error the caller has to regex.
      if (e instanceof ProviderRequestError && /RunningTaskDeletion/i.test(e.message + e.body)) {
        throw new SeedanceTaskNotCancellableError(taskId, 'RUNNING');
      }
      throw e;
    }
    return { cancelled: true };
  }

  /**
   * `billable` marks the call that creates a task. ModelArk offers no idempotency key,
   * and a task that has started cannot be cancelled, so a transport failure there is
   * AMBIGUOUS: the task may exist and may be billed. It must not reach a retry wrapper
   * as a bare TypeError that reads as "never sent".
   */
  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    billable = false,
  ): Promise<Record<string, unknown>> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ProviderRequestError(
        'seedance',
        0,
        detail,
        billable
          ? `Transport failure while creating a ModelArk task: ${detail}. This is AMBIGUOUS — ` +
            `there is no idempotency key and a started task cannot be cancelled, so a task may ` +
            `already exist and be billable. Reconcile against ` +
            `GET /contents/generations/tasks before resubmitting.`
          : `Transport failure calling ModelArk (${method} ${path}): ${detail}.`,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderRequestError(
        'seedance',
        res.status,
        text.slice(0, 400),
        `Non-JSON response from ModelArk (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    const rec = asRecord(parsed) ?? {};

    if (!res.ok) {
      const err = asRecord(rec['error']);
      const code = err && typeof err['code'] === 'string' ? err['code'] : `HTTP_${res.status}`;
      const message =
        err && typeof err['message'] === 'string' ? err['message'] : text.slice(0, 200);
      throw new ProviderRequestError(
        'seedance',
        res.status,
        text.slice(0, 400),
        `ModelArk ${code} (HTTP ${res.status}): ${message}`,
      );
    }
    return rec;
  }
}

/** First matching row wins, so descriptors list specific rows before general ones. */
export function selectTokenRate(
  rates: readonly TokenRate[],
  resolution: Resolution,
  audio: boolean,
  hasVideoInput: boolean,
): TokenRate | undefined {
  return rates.find((r) => {
    if (r.resolutions !== undefined && !r.resolutions.includes(resolution)) return false;
    if (r.audio !== undefined && r.audio !== audio) return false;
    if (r.withVideoInput !== undefined && r.withVideoInput !== hasVideoInput) return false;
    return true;
  });
}

function mapState(raw: string): TaskStatus['state'] {
  switch (raw) {
    case 'queued':
      return 'QUEUED';
    case 'running':
      return 'RUNNING';
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'expired':
      return 'EXPIRED';
    default:
      // An unrecognised status must never read as success — that would publish an ad
      // against a video that does not exist.
      return 'FAILED';
  }
}

function imageUrl(
  ref: { kind: 'uri'; uri: string } | { kind: 'base64'; data: string },
  modelId: string,
): string {
  if (ref.kind === 'uri') return ref.uri;
  throw new CapabilityError(
    'seedance',
    modelId,
    'firstFrame',
    `ModelArk takes reference images by URL only (content[].image_url.url); it has no inline ` +
      `base64 field. Upload the keyframe to object storage and pass a URI ref.`,
  );
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
