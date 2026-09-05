import {
  assertSpecSupported,
  microsToMinorUnits,
  usdToMicros,
  CapabilityError,
  ProviderRequestError,
  UnknownModelError,
  type CostEstimate,
  type GenerationSpec,
  type GeneratedVideo,
  type ModelCapabilities,
  type PerSecondRate,
  type ProviderTaskError,
  type Resolution,
  type SafetyRoute,
  type SubmitResult,
  type TaskStatus,
  type VideoProvider,
} from './provider.ts';

/**
 * Google Veo on Vertex AI.
 *
 * Vertex, not the Gemini Developer API, and the choice is not a preference:
 *  - only the GA Vertex `-001` models are covered by Google's IP indemnity;
 *  - the Gemini Developer API enforces a rolling 10-minute SPEND cap ($10/$50/$200)
 *    that cannot be raised on demand, which at $0.96/clip is ~10 clips per 10 minutes
 *    on the middle tier — a hard architectural disqualifier for an ad factory.
 *
 * Lifecycle is `:predictLongRunning` to start and `:fetchPredictOperation` to poll.
 * Note that the poll is a **POST** carrying `{"operationName": ...}` — the Gemini
 * Developer API's equivalent is a GET, and mixing the two idioms is a silent 404.
 */

export const VEO_DEFAULT_LOCATION = 'us-central1';

/**
 * Veo's per-second rates from the Vertex price sheet
 * (cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
 *
 * ⚠ THE ONE PLACE THE RESEARCH CONTRADICTS ITSELF, AND WHY THIS SHAPE WINS.
 * The synthesis §5.2 comparison table labels these figures as the price of a *clip*
 * and argues "because Veo's billing is per-count, longer clips do not cost more".
 * Both the Veo dossier (§5.1 "`/ 1 count` = per second of output video", §5.4 worked
 * examples: "8s, 9:16, 1080p, audio, Veo 3.1 Fast | 8 × $0.12 | $0.96") and the
 * synthesis's OWN cost model (§8.1: "Video (24s, audio-off) $2.40 (Veo 3.1 Fast
 * 1080p)" = 24 × $0.10) multiply by duration. Two of three say per-second, the
 * primary sourced document is one of them, and being wrong in the per-clip direction
 * under-states an 8s clip by 8× on a budget guard that spends real money unattended.
 * So: per second of output, and the contradiction is recorded rather than hidden.
 *
 * ⚠ THE PROVIDER RECOMMENDATION TURNS ON THIS. Read per-second, an 8s 1080p silent Veo
 * 3.1 Fast clip is $0.80 while the same clip on `seedance-1-0-pro-fast` is $0.39 — the
 * inverse of synthesis §5.2's "Veo 3.1 Fast is ~2.5× cheaper than the cheapest Seedance
 * model at 1080p", which was reached by comparing Veo's $/second against Seedance's
 * $/clip. Veo's other arguments for the primary slot (IP indemnity, throughput, no
 * 10-minute rolling spend cap) are untouched by this, but the COST argument is not
 * settled. Resolve it with one billed generation and a look at the invoice line.
 *
 * What genuinely does NOT vary is pixel count within a resolution tier: a 9:16 clip
 * and a 16:9 clip at 1080p cost the same. That is the real structural difference from
 * Seedance, whose price is a function of width × height × frames.
 */
const VEO_31_RATES: readonly PerSecondRate[] = [
  { resolution: '720p', usdPerSecondWithAudio: 0.40, usdPerSecondSilent: 0.20 },
  { resolution: '1080p', usdPerSecondWithAudio: 0.40, usdPerSecondSilent: 0.20 },
  { resolution: '4k', usdPerSecondWithAudio: 0.60, usdPerSecondSilent: 0.40 },
];

const VEO_31_FAST_RATES: readonly PerSecondRate[] = [
  { resolution: '720p', usdPerSecondWithAudio: 0.10, usdPerSecondSilent: 0.08 },
  { resolution: '1080p', usdPerSecondWithAudio: 0.12, usdPerSecondSilent: 0.10 },
  { resolution: '4k', usdPerSecondWithAudio: 0.30, usdPerSecondSilent: 0.25 },
];

const VEO_31_LITE_RATES: readonly PerSecondRate[] = [
  { resolution: '720p', usdPerSecondWithAudio: 0.05, usdPerSecondSilent: 0.03 },
  { resolution: '1080p', usdPerSecondWithAudio: 0.08, usdPerSecondSilent: 0.05 },
];

const VEO_COMMON_NOTES: readonly string[] = [
  'SynthID is always on and C2PA is always signed; there is no opt-out. Never strip ' +
    'provenance metadata to evade an AI label — that is a Meta terms violation and an ' +
    'EU AI Act Art. 50(2) violation. (ffmpeg re-encoding drops C2PA but not SynthID.)',
  'English prompts only; other languages are "not evaluated".',
  'No batch lane and no dynamic shared quota — the 50 RPM is a fixed quota. Shard across ' +
    'GCP projects for headroom; a 1-9 GSU Provisioned Throughput order has a 2000s ' +
    'enforcement window and is worse than pay-as-you-go for bursty work.',
  'UNVERIFIED: whether sampleCount:4 counts as 1 or 4 requests against the 50 RPM quota. ' +
    'If 1, one project yields 200 videos/min; if 4, 50. This materially changes throughput plans.',
  'You are not charged for a video that is blocked from generating, so a cost estimate is ' +
    'an upper bound and a safety-block retry is free.',
];

function veoModel(
  modelId: string,
  opts: {
    resolutions: readonly Resolution[];
    rates: readonly PerSecondRate[];
    indemnified: boolean;
    indemnityNote: string;
    retirementEarliest: string | undefined;
    extraNotes?: readonly string[];
  },
): ModelCapabilities {
  return {
    providerId: 'veo',
    modelId,
    // 4/6/8 and nothing between. A 24s ad is necessarily three clips plus a concat.
    durations: { kind: 'discrete', seconds: [4, 6, 8] },
    resolutions: opts.resolutions,
    // The whole catalogue's binding constraint: two ratios, and neither is 4:5.
    aspectRatios: ['16:9', '9:16'],
    fps: 24,
    // `parameters.generateAudio` — undocumented in the REST guides, present in the
    // official SDK, and the toggle the "Video only" price column bills against.
    audio: 'optional',
    // The model card marks "First+last frame" supported on all three Veo 3.1 variants.
    keyframes: 'first-and-last',
    maxSamplesPerRequest: 4,
    concurrency: {
      // Google publishes a REQUEST RATE, not a concurrency cap. This number exists so
      // the semaphore has one uniform shape across providers; it is not a vendor limit.
      limit: 50,
      source: 'derived-from-rpm',
      overrides: [],
    },
    requestsPerMinute: 50,
    // Veo's 50 RPM is per base model per region and does not vary by resolution.
    requestsPerMinuteOverrides: [],
    indemnified: opts.indemnified,
    indemnityNote: opts.indemnityNote,
    retirement:
      opts.retirementEarliest === undefined
        ? { earliest: undefined, qualifier: 'unannounced' }
        : { earliest: opts.retirementEarliest, qualifier: 'or-later' },
    // Vertex documents no cancel path for a running Veo operation. Treated as
    // uncancellable, which is the safe direction: budget before submit.
    cancellableWhileRunning: false,
    // Veo writes into OUR OWN GCS bucket via storageUri, so the artefact does not expire.
    resultUrlTtlSeconds: undefined,
    regions: [VEO_DEFAULT_LOCATION],
    billing: { unit: 'seconds-of-output', rates: opts.rates },
    notes: [...VEO_COMMON_NOTES, ...(opts.extraNotes ?? [])],
  };
}

const INDEMNIFIED_NOTE =
  'Covered by Google\'s IP indemnity ONLY as a GA Vertex model on a PAID account, and never ' +
  'for trademark claims arising from use of the output in trade or commerce — i.e. never for ' +
  'advertising. Coverage is also voided for output produced after circumventing safety filters.';

const NOT_INDEMNIFIED_NOTE =
  'Preview model: outside Google\'s IP indemnity, which applies only to GA Vertex models on a ' +
  'paid account. A policy layer must decide whether an unindemnified model may generate ' +
  'creative that will run on a client ad account.';

/**
 * Defaults, not constants — pass `models` to the provider to add, replace or retire an
 * id without a deploy. Veo 3.1 states retirement "November 17, 2026 or later".
 */
export const DEFAULT_VEO_MODELS: readonly ModelCapabilities[] = [
  veoModel('veo-3.1-generate-001', {
    resolutions: ['720p', '1080p', '4k'],
    rates: VEO_31_RATES,
    indemnified: true,
    indemnityNote: INDEMNIFIED_NOTE,
    retirementEarliest: '2026-11-17',
    extraNotes: [
      'The model card lists 4K output while the parameter reference says "4k" is Veo 3.1 ' +
        'Preview models only. Probe before relying on 4K here.',
    ],
  }),
  veoModel('veo-3.1-fast-generate-001', {
    // Model card: 720p/1080p only. The price sheet publishes a 4K row for Fast anyway —
    // the capability table is the authority, so 4K is absent here.
    resolutions: ['720p', '1080p'],
    rates: VEO_31_FAST_RATES,
    indemnified: true,
    indemnityNote: INDEMNIFIED_NOTE,
    retirementEarliest: '2026-11-17',
    extraNotes: [
      'The recommended primary: ~$0.96 for an 8s 1080p 9:16 clip with audio, ~$0.80 silent.',
    ],
  }),
  veoModel('veo-3.1-lite-generate-001', {
    resolutions: ['720p', '1080p'],
    rates: VEO_31_LITE_RATES,
    indemnified: false,
    indemnityNote: NOT_INDEMNIFIED_NOTE,
    retirementEarliest: undefined,
    extraNotes: [
      'No reference images. The cheapest exploration lane, but unindemnified — the ' +
        'synthesis argues for exploring here and re-rendering only survivors on a GA model.',
      'UNVERIFIED: the Lite model card contradicts itself — its modality table says ' +
        '"Image: Not supported" while its capability table says image-to-video and ' +
        'first+last frame ARE supported. keyframes is set from the capability table; probe ' +
        'image input on Lite before routing an image-conditioned brief here.',
    ],
  }),
];

export interface VeoConfig {
  projectId: string;
  /** Bearer token, or a supplier so a short-lived OAuth token can be refreshed per call. */
  accessToken: string | (() => string | Promise<string>);
  /** gs:// prefix. Omitting storageUri returns multi-megabyte base64 inline instead. */
  storageUri: string;
  location?: string;
  fetchImpl?: typeof fetch;
  models?: readonly ModelCapabilities[];
  /**
   * Vertex spelling is `allow_adult` | `disallow`. The Gemini Developer API spells the
   * second one `dont_allow` and fixes the value by generation MODE rather than letting
   * you choose — sending the wrong spelling is a 400 on every call.
   */
  personGeneration?: 'allow_adult' | 'disallow';
  now?: () => number;
}

/** Veo support codes → category and routing. Two of these must never be auto-retried. */
const SUPPORT_CODE_CATEGORIES: ReadonlyArray<{
  codes: readonly string[];
  category: string;
  route: SafetyRoute;
}> = [
  { codes: ['58061214', '17301594'], category: 'CHILD', route: 'ABORT' },
  // Fires on photorealistic prominent people. Safe to rewrite with a generic descriptor.
  { codes: ['29310472', '15236754'], category: 'CELEBRITY', route: 'AUTO_REWRITE' },
  // The brand/logo/IP guardrail. NEVER auto-retry with a weakened prompt — doing so is
  // carve-out 2 of Google's indemnity and voids coverage for the resulting output.
  { codes: ['35561574', '35561575'], category: 'THIRD_PARTY_CONTENT', route: 'HUMAN_REVIEW' },
  { codes: ['64151117', '42237218'], category: 'VIDEO_SAFETY', route: 'HUMAN_REVIEW' },
  { codes: ['62263041'], category: 'DANGEROUS_CONTENT', route: 'HUMAN_REVIEW' },
  { codes: ['57734940', '22137204'], category: 'HATE', route: 'ABORT' },
  {
    codes: ['89371032', '49114662', '63429089', '72817394', '60599140'],
    category: 'PROHIBITED_CONTENT',
    route: 'ABORT',
  },
  { codes: ['90789179', '43188360'], category: 'SEXUAL', route: 'ABORT' },
  { codes: ['78610348'], category: 'TOXIC', route: 'ABORT' },
  { codes: ['61493863', '56562880'], category: 'VIOLENCE', route: 'ABORT' },
  { codes: ['32635315'], category: 'VULGAR', route: 'ABORT' },
  { codes: ['74803281', '29578790', '42876398'], category: 'OTHER_SAFETY', route: 'HUMAN_REVIEW' },
];

/** `Support codes: 15236754, 35561574` → ['15236754','35561574'] */
export function parseSupportCodes(message: string): readonly string[] {
  const m = /support codes?:\s*([0-9,\s]+)/i.exec(message);
  if (!m || m[1] === undefined) return [];
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function classifySupportCodes(codes: readonly string[]): {
  category: string;
  route: SafetyRoute;
} {
  for (const code of codes) {
    for (const entry of SUPPORT_CODE_CATEGORIES) {
      if (entry.codes.includes(code)) return { category: entry.category, route: entry.route };
    }
  }
  return { category: 'UNKNOWN', route: 'HUMAN_REVIEW' };
}

const OPERATION_NAME =
  /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/([^/]+)\/models\/([^/]+)\/operations\/([^/]+)$/;

export class VeoProvider implements VideoProvider {
  readonly id: 'veo' = 'veo';
  private readonly cfg: VeoConfig;
  private readonly location: string;
  private readonly fetchImpl: typeof fetch;
  private readonly catalogue: Map<string, ModelCapabilities>;
  private readonly now: () => number;

  constructor(cfg: VeoConfig) {
    this.cfg = cfg;
    this.location = cfg.location ?? VEO_DEFAULT_LOCATION;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.catalogue = new Map();
    for (const m of cfg.models ?? DEFAULT_VEO_MODELS) this.catalogue.set(m.modelId, m);

    if (this.location !== VEO_DEFAULT_LOCATION) {
      // Veo is us-central1 only, with no global endpoint and no multi-region failover.
      // A wrong region is a 404 on every call, so it fails here rather than at 3am.
      throw new Error(
        `Veo is available in ${VEO_DEFAULT_LOCATION} only; got "${this.location}". ` +
          `There is no global endpoint and no multi-region failover for video. ` +
          `For more headroom, shard across GCP projects, not regions.`,
      );
    }
  }

  models(): readonly ModelCapabilities[] {
    return [...this.catalogue.values()];
  }

  capabilities(modelId: string): ModelCapabilities {
    const caps = this.catalogue.get(modelId);
    if (!caps) throw new UnknownModelError('veo', modelId, [...this.catalogue.keys()]);
    return caps;
  }

  estimateCost(spec: GenerationSpec): CostEstimate {
    const caps = this.capabilities(spec.modelId);
    assertSpecSupported(caps, spec);

    const billing = caps.billing;
    if (billing.unit !== 'seconds-of-output') {
      throw new CapabilityError(
        'veo',
        caps.modelId,
        'billing',
        `Veo descriptors must bill in seconds-of-output; got "${billing.unit}".`,
      );
    }

    const row = billing.rates.find((r) => r.resolution === spec.resolution);
    const usdPerSecond = row
      ? spec.audio
        ? row.usdPerSecondWithAudio
        : row.usdPerSecondSilent
      : undefined;

    if (usdPerSecond === undefined) {
      throw new CapabilityError(
        'veo',
        caps.modelId,
        'billing',
        `No published Vertex rate for ${caps.modelId} at ${spec.resolution} ` +
          `${spec.audio ? 'with audio' : 'silent'}. Refusing to guess a price for a call that ` +
          `spends real money — add the rate to the descriptor from the price sheet.`,
      );
    }

    const samples = spec.samples ?? 1;
    const seconds = spec.durationSeconds * samples;
    // Rates are exact in micros ($0.12 -> 120000), so multiplying in micros avoids the
    // float drift that appears when a fractional dollar cost is accumulated per clip.
    const microUnits = usdToMicros(usdPerSecond) * spec.durationSeconds * samples;

    return {
      providerId: 'veo',
      modelId: caps.modelId,
      currency: 'USD',
      microUnits,
      minorUnits: microsToMinorUnits(microUnits),
      billingUnit: 'seconds-of-output',
      billedUnits: seconds,
      samples,
      exact: true,
      basis:
        `${samples} x ${spec.durationSeconds}s @ $${usdPerSecond.toFixed(2)}/s ` +
        `(${caps.modelId}, ${spec.resolution}, ${spec.audio ? 'audio' : 'silent'}) ` +
        `= ${seconds}s. Upper bound: blocked generations are not charged.`,
    };
  }

  async submit(spec: GenerationSpec): Promise<SubmitResult> {
    const caps = this.capabilities(spec.modelId);
    // Estimating first is not decoration: it re-runs the capability gate, so an
    // unsupported spec cannot reach the network, and it records what we expected to
    // pay before anything becomes uncancellable.
    const estimate = this.estimateCost(spec);

    const storageUri = spec.outputUri ?? this.cfg.storageUri;
    if (!storageUri.startsWith('gs://')) {
      throw new CapabilityError(
        'veo',
        caps.modelId,
        'outputUri',
        `storageUri must be a gs:// URI, got "${storageUri}". Vertex returns the whole MP4 ` +
          `base64-inline when storageUri is omitted or invalid — multi-megabyte JSON per 1080p ` +
          `clip, and a silent memory blowup in a worker.`,
      );
    }

    const instance: Record<string, unknown> = { prompt: spec.prompt };
    if (spec.firstFrame) instance['image'] = imagePayload(spec.firstFrame);
    // lastFrame is a SIBLING of image inside the instance, not a parameter.
    if (spec.lastFrame) instance['lastFrame'] = imagePayload(spec.lastFrame);

    const parameters: Record<string, unknown> = {
      storageUri,
      aspectRatio: spec.aspectRatio,
      durationSeconds: spec.durationSeconds,
      resolution: spec.resolution,
      sampleCount: spec.samples ?? 1,
      // Always explicit. This is the field the "Video only" price column bills against,
      // and leaving it out silently buys the audio tier.
      generateAudio: spec.audio,
      // Always explicit and always false: prompt rewriting silently changes the prompt,
      // which destroys the seed-pinned consistency that creative A/B comparison needs.
      enhancePrompt: false,
      personGeneration: this.cfg.personGeneration ?? 'allow_adult',
    };
    if (spec.seed !== undefined) {
      // Vertex types seed as a uint32. A float or a negative is a 400 from Google with a
      // schema message; failing here names the field and the range instead.
      if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 4_294_967_295) {
        throw new CapabilityError(
          'veo',
          caps.modelId,
          'seed',
          `Vertex seed is a uint32 (0-4294967295); got ${String(spec.seed)}.`,
        );
      }
      parameters['seed'] = spec.seed;
    }
    if (spec.negativePrompt !== undefined) parameters['negativePrompt'] = spec.negativePrompt;

    const body: Record<string, unknown> = { instances: [instance], parameters };
    // Per-campaign / per-advertiser billing attribution. Cheap, and impossible to
    // backfill once the invoice exists.
    if (spec.labels !== undefined) body['labels'] = spec.labels;

    const url =
      `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.cfg.projectId}` +
      `/locations/${this.location}/publishers/google/models/${caps.modelId}:predictLongRunning`;

    const json = await this.request(url, body, true);
    const name = typeof json['name'] === 'string' ? json['name'] : undefined;
    if (name === undefined) {
      throw new ProviderRequestError(
        'veo',
        200,
        JSON.stringify(json).slice(0, 400),
        `predictLongRunning returned no operation name for ${caps.modelId}. The generation may ` +
          `still be running and billable; do not resubmit blindly.`,
      );
    }

    return {
      providerId: 'veo',
      modelId: caps.modelId,
      taskId: name,
      submittedAt: this.now(),
      estimate,
    };
  }

  /**
   * `taskId` is the full Vertex operation name; the model id is embedded in it, which
   * is what lets a single-argument poll work across models.
   */
  async poll(taskId: string): Promise<TaskStatus> {
    const parts = OPERATION_NAME.exec(taskId);
    if (!parts) {
      throw new CapabilityError(
        'veo',
        '(unknown)',
        'taskId',
        `"${taskId}" is not a Vertex operation name. Expected ` +
          `projects/{p}/locations/{l}/publishers/google/models/{model}/operations/{id} — the ` +
          `model id is read back out of it, so a truncated id cannot be polled.`,
      );
    }
    const project = parts[1] as string;
    const location = parts[2] as string;
    const modelId = parts[4] as string;

    if (project !== this.cfg.projectId) {
      throw new CapabilityError(
        'veo',
        modelId,
        'taskId',
        `Operation belongs to project "${project}" but this provider is configured for ` +
          `"${this.cfg.projectId}". Credentials are project-scoped; polling would fail as a 403.`,
      );
    }

    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
      `/locations/${location}/publishers/google/models/${modelId}:fetchPredictOperation`;

    // POST, not GET, and the operation name goes in the body. The Gemini Developer API
    // polls the same concept with a GET; using that idiom here 404s.
    const json = await this.request(url, { operationName: taskId });

    const base = { providerId: 'veo' as const, modelId, taskId };

    const err = asRecord(json['error']);
    if (err) {
      const message = typeof err['message'] === 'string' ? err['message'] : JSON.stringify(err);
      const codes = parseSupportCodes(message);
      const { category, route } = classifySupportCodes(codes);
      const error: ProviderTaskError = {
        code: String(err['code'] ?? 'UNKNOWN'),
        message,
        category,
        route,
        supportCodes: codes,
      };
      return {
        ...base,
        state: 'FAILED',
        videos: [],
        filteredCount: 0,
        filteredReasons: [],
        partial: false,
        error,
        billedUnits: undefined,
        resultExpiresAt: undefined,
      };
    }

    if (json['done'] !== true) {
      return {
        ...base,
        state: 'RUNNING',
        videos: [],
        filteredCount: 0,
        filteredReasons: [],
        partial: false,
        error: undefined,
        billedUnits: undefined,
        resultExpiresAt: undefined,
      };
    }

    const response = asRecord(json['response']) ?? {};
    const rawVideos = Array.isArray(response['videos']) ? response['videos'] : [];
    const videos: GeneratedVideo[] = [];
    for (const v of rawVideos) {
      const rec = asRecord(v);
      if (!rec) continue;
      videos.push({
        uri: typeof rec['gcsUri'] === 'string' ? rec['gcsUri'] : undefined,
        base64: typeof rec['bytesBase64Encoded'] === 'string' ? rec['bytesBase64Encoded'] : undefined,
        mimeType: typeof rec['mimeType'] === 'string' ? rec['mimeType'] : 'video/mp4',
      });
    }

    const filteredCount =
      typeof response['raiMediaFilteredCount'] === 'number' ? response['raiMediaFilteredCount'] : 0;
    const filteredReasons = Array.isArray(response['raiMediaFilteredReasons'])
      ? response['raiMediaFilteredReasons'].filter((r): r is string => typeof r === 'string')
      : [];

    // The dominant Veo failure is not an exception, it is `done: true` with fewer videos
    // than requested and no error anywhere. The requested count is not echoed back, so
    // the caller must compare against its own sampleCount; `partial` here covers the
    // case the operation itself admits to (a non-zero filtered count).
    const partial = filteredCount > 0 && videos.length > 0;

    if (videos.length === 0) {
      const reason =
        filteredReasons.length > 0 ? filteredReasons.join('; ') : '(no reason returned)';
      return {
        ...base,
        state: 'FAILED',
        videos: [],
        filteredCount,
        filteredReasons,
        partial: false,
        error: {
          code: 'RAI_FILTERED_ALL',
          message:
            `Veo reported done:true with zero videos and raiMediaFilteredCount=${filteredCount}. ` +
            `Every sample was blocked for safety: ${reason}. This is a silent failure — there is ` +
            `no error field. Never respond by relaxing the safety filter and retrying; that voids ` +
            `Google's indemnity for the output.`,
          category: 'RAI_FILTERED',
          route: 'HUMAN_REVIEW',
          supportCodes: [],
        },
        billedUnits: undefined,
        resultExpiresAt: undefined,
      };
    }

    return {
      ...base,
      state: 'SUCCEEDED',
      videos,
      filteredCount,
      filteredReasons,
      partial,
      error: undefined,
      billedUnits: undefined,
      resultExpiresAt: undefined,
    };
  }

  /**
   * `billable` marks a call that starts a generation. Vertex offers no idempotency key
   * for `predictLongRunning`, so a transport failure on that call is AMBIGUOUS — the
   * request may have reached Google and started a billed job. It must not surface as a
   * bare TypeError that a retry wrapper reads as "never sent"; that is the shape of a
   * double charge.
   */
  private async request(
    url: string,
    body: unknown,
    billable = false,
  ): Promise<Record<string, unknown>> {
    const token =
      typeof this.cfg.accessToken === 'string' ? this.cfg.accessToken : await this.cfg.accessToken();

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ProviderRequestError(
        'veo',
        0,
        detail,
        billable
          ? `Transport failure while starting a Veo generation: ${detail}. This is AMBIGUOUS — ` +
            `Vertex has no idempotency key for predictLongRunning, so the job may have started ` +
            `and may be billed. Do not blindly resubmit; list operations for the project first.`
          : `Transport failure calling Vertex: ${detail}.`,
      );
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderRequestError(
        'veo',
        res.status,
        text.slice(0, 400),
        `Non-JSON response from Vertex (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      const rec = asRecord(parsed);
      const err = rec ? asRecord(rec['error']) : undefined;
      const message = err && typeof err['message'] === 'string' ? err['message'] : text.slice(0, 200);
      throw new ProviderRequestError(
        'veo',
        res.status,
        text.slice(0, 400),
        `Vertex HTTP ${res.status}: ${message}`,
      );
    }

    const rec = asRecord(parsed);
    if (!rec) {
      throw new ProviderRequestError(
        'veo',
        res.status,
        text.slice(0, 400),
        `Vertex returned a non-object body: ${text.slice(0, 200)}`,
      );
    }
    return rec;
  }
}

function imagePayload(ref: ImageRefLike): Record<string, unknown> {
  return ref.kind === 'uri'
    ? { gcsUri: ref.uri, mimeType: ref.mimeType }
    : { bytesBase64Encoded: ref.data, mimeType: ref.mimeType };
}

type ImageRefLike =
  | { kind: 'uri'; uri: string; mimeType: string }
  | { kind: 'base64'; data: string; mimeType: string };

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
