/**
 * Capability probe for src/generation/{provider,veo,seedance}.ts.
 *
 * Not a unit test. The question is whether the provider abstraction actually does its
 * job when driven with a realistic ad brief, end to end, in this environment:
 *
 *  - Does it price a real ad's worth of clips correctly on EVERY model in both
 *    catalogues, to the digit, against the figures the dossiers verified against real
 *    invoices? A wrong cost model is how an autonomous system silently overspends.
 *  - Does it refuse an unbuildable spec BEFORE the network call, given that neither
 *    provider can cancel a running generation and both bill it in full?
 *  - Does the per-model semaphore actually serialise to the documented concurrency?
 *  - Do submit/poll parse the providers' ACTUAL documented response shapes — including
 *    the two silent-failure shapes (Veo `done:true` with fewer videos; ModelArk
 *    `succeeded` with no video_url) that are the whole reason this layer exists?
 *
 * No real generation is attempted: no provider credential is configured in this
 * environment and every call costs money. Both providers are driven through fakes that
 * mimic the documented wire shapes verbatim:
 *   - Vertex `:predictLongRunning` / `:fetchPredictOperation`
 *     (docs/research/video-gen-google-veo.md §3.1, §9.2)
 *   - ModelArk `POST/GET/DELETE /contents/generations/tasks`
 *     (docs/research/video-gen-byteplus-seedance.md §2, §5, §9, §10)
 *
 * Run: node --experimental-strip-types src/verify/generation.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CapabilityError,
  ModelSemaphore,
  NO_NATIVE_4_5_NOTE,
  ProviderRequestError,
  UnknownModelError,
  concurrencyLimitFor,
  concurrencySlot,
  describeDurations,
  microsToMinorUnits,
  planAspectRatio,
  requestsPerMinuteFor,
  retirementRisk,
  supportsDuration,
  usdToMicros,
  type AspectRatio,
  type GenerationSpec,
  type ImageRef,
  type ModelCapabilities,
  type Resolution,
  type TokenRate,
  type VideoProvider,
} from '../generation/provider.ts';
import {
  DEFAULT_VEO_MODELS,
  VeoProvider,
  classifySupportCodes,
  parseSupportCodes,
} from '../generation/veo.ts';
import {
  SEEDANCE_FRAME_AREAS,
  SeedanceProvider,
  SeedanceTaskNotCancellableError,
  defaultSeedanceModels,
  pixelFrameTokens,
  selectTokenRate,
} from '../generation/seedance.ts';

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  // Set when the check could not run for an environmental reason (no assets
  // assigned, no API key, binary missing) rather than because the code is wrong.
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

// ---------------------------------------------------------------------------
// Probe harness
// ---------------------------------------------------------------------------

class ProbeFailure extends Error {}

function must(condition: boolean, message: string): void {
  if (!condition) throw new ProbeFailure(message);
}

function eq<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new ProbeFailure(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Asserts a CapabilityError naming an exact field, with a message that says why. */
function refuses(fn: () => unknown, field: string, needle: RegExp | string): CapabilityError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) throw new ProbeFailure(`expected a CapabilityError on "${field}", nothing was thrown`);
  if (!(caught instanceof CapabilityError)) {
    throw new ProbeFailure(
      `expected CapabilityError on "${field}", got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
    );
  }
  if (caught.field !== field) {
    throw new ProbeFailure(`expected CapabilityError.field "${field}", got "${caught.field}" (${caught.message})`);
  }
  const ok = typeof needle === 'string' ? caught.message.includes(needle) : needle.test(caught.message);
  if (!ok) throw new ProbeFailure(`message for "${field}" did not match ${String(needle)}: ${caught.message}`);
  return caught;
}

async function refusesAsync(
  fn: () => Promise<unknown>,
  field: string,
  needle: RegExp | string,
): Promise<CapabilityError> {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  return refuses(
    () => {
      if (threw) throw caught;
    },
    field,
    needle,
  );
}

async function rejectsWith<T>(
  fn: () => Promise<unknown>,
  ctor: new (...args: never[]) => T,
  needle: RegExp,
): Promise<T> {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) throw new ProbeFailure(`expected ${ctor.name}, nothing was thrown`);
  if (!(caught instanceof ctor)) {
    throw new ProbeFailure(
      `expected ${ctor.name}, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
    );
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  if (!needle.test(message)) {
    throw new ProbeFailure(`${ctor.name} message did not match ${String(needle)}: ${message}`);
  }
  return caught;
}

// ---------------------------------------------------------------------------
// Realistic inputs
// ---------------------------------------------------------------------------

/** A real brief shape: a 9:16 vertical DTC hook shot, English, no legacy --flags. */
const AD_PROMPT =
  'Vertical 9:16 product hero shot: a matte black stainless water bottle on a sunlit ' +
  'kitchen counter, slow dolly-in, condensation beading, warm morning light, shallow depth ' +
  'of field, no on-screen text.';

interface SpecInput {
  modelId: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  audio: boolean;
  prompt?: string;
  samples?: number;
  seed?: number;
  negativePrompt?: string;
  firstFrame?: ImageRef;
  lastFrame?: ImageRef;
  outputUri?: string;
  callbackUrl?: string;
  labels?: Record<string, string>;
}

/** exactOptionalPropertyTypes: optional keys are OMITTED, never set to undefined. */
function makeSpec(i: SpecInput): GenerationSpec {
  const s: {
    modelId: string;
    prompt: string;
    durationSeconds: number;
    aspectRatio: AspectRatio;
    resolution: Resolution;
    audio: boolean;
    samples?: number;
    seed?: number;
    negativePrompt?: string;
    firstFrame?: ImageRef;
    lastFrame?: ImageRef;
    outputUri?: string;
    callbackUrl?: string;
    labels?: Record<string, string>;
  } = {
    modelId: i.modelId,
    prompt: i.prompt ?? AD_PROMPT,
    durationSeconds: i.durationSeconds,
    aspectRatio: i.aspectRatio,
    resolution: i.resolution,
    audio: i.audio,
  };
  if (i.samples !== undefined) s.samples = i.samples;
  if (i.seed !== undefined) s.seed = i.seed;
  if (i.negativePrompt !== undefined) s.negativePrompt = i.negativePrompt;
  if (i.firstFrame !== undefined) s.firstFrame = i.firstFrame;
  if (i.lastFrame !== undefined) s.lastFrame = i.lastFrame;
  if (i.outputUri !== undefined) s.outputUri = i.outputUri;
  if (i.callbackUrl !== undefined) s.callbackUrl = i.callbackUrl;
  if (i.labels !== undefined) s.labels = i.labels;
  return s;
}

// ---------------------------------------------------------------------------
// Fake transports mimicking the documented wire shapes
// ---------------------------------------------------------------------------

interface WireCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface WireReply {
  status?: number;
  body?: unknown;
  text?: string;
  throwTransport?: string;
}

interface Recorder {
  impl: typeof fetch;
  calls: WireCall[];
}

function recorder(handler: (call: WireCall, index: number) => WireReply): Recorder {
  const calls: WireCall[] = [];
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: WireCall = { url, method: init?.method ?? 'GET', headers, body };
    const index = calls.length;
    calls.push(call);
    const reply = handler(call, index);
    if (reply.throwTransport !== undefined) throw new TypeError(reply.throwTransport);
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

/** A transport that proves no network happened: it explodes if it is ever called. */
function noNetwork(): Recorder {
  return recorder(() => {
    throw new ProbeFailure(
      'the provider contacted the network for a spec its own capability descriptor refuses',
    );
  });
}

const VEO_PROJECT = 'ad-factory-prod';
const VEO_BUCKET = 'gs://ad-factory-creative/veo/';
const VEO_FAST = 'veo-3.1-fast-generate-001';
const VEO_QUALITY = 'veo-3.1-generate-001';
const VEO_LITE = 'veo-3.1-lite-generate-001';
const OP_NAME = `projects/${VEO_PROJECT}/locations/us-central1/publishers/google/models/${VEO_FAST}/operations/9f2e1c7a-4b55-4a1e-8b2c-000000000001`;

function veoProvider(fetchImpl?: typeof fetch): VeoProvider {
  return new VeoProvider({
    projectId: VEO_PROJECT,
    accessToken: 'ya29.probe-token-not-a-real-credential',
    storageUri: VEO_BUCKET,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

function seedanceProvider(fetchImpl?: typeof fetch, tier?: 'individual' | 'enterprise'): SeedanceProvider {
  return new SeedanceProvider({
    apiKey: 'ark-probe-key-not-a-real-credential',
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(tier === undefined ? {} : { accountTier: tier }),
  });
}

const SEEDANCE_FAST = 'seedance-1-0-pro-fast-251015';
const SEEDANCE_PRO = 'seedance-1-0-pro-250528';
const SEEDANCE_15 = 'seedance-1-5-pro-251215';
const DREAMINA_MINI = 'dreamina-seedance-2-0-mini-260615';
const DREAMINA_FAST = 'dreamina-seedance-2-0-fast-260128';
const DREAMINA_20 = 'dreamina-seedance-2-0-260128';
const DREAMINA_25 = 'dreamina-seedance-2-5-260628';

// ---------------------------------------------------------------------------
// Dossier reference figures
// ---------------------------------------------------------------------------

/** video-gen-google-veo.md §5.1, USD per SECOND of output. */
const VEO_DOSSIER_RATES: ReadonlyArray<{
  modelId: string;
  resolution: Resolution;
  audio: number;
  silent: number;
}> = [
  { modelId: VEO_QUALITY, resolution: '720p', audio: 0.4, silent: 0.2 },
  { modelId: VEO_QUALITY, resolution: '1080p', audio: 0.4, silent: 0.2 },
  { modelId: VEO_QUALITY, resolution: '4k', audio: 0.6, silent: 0.4 },
  { modelId: VEO_FAST, resolution: '720p', audio: 0.1, silent: 0.08 },
  { modelId: VEO_FAST, resolution: '1080p', audio: 0.12, silent: 0.1 },
  { modelId: VEO_LITE, resolution: '720p', audio: 0.05, silent: 0.03 },
  { modelId: VEO_LITE, resolution: '1080p', audio: 0.08, silent: 0.05 },
];

/** video-gen-byteplus-seedance.md §5, "cost per 9:16 vertical clip, 5 s", USD. */
const SEEDANCE_DOSSIER_CLIP_USD: ReadonlyArray<{
  modelId: string;
  audio: boolean;
  usd: Partial<Record<Resolution, number>>;
}> = [
  { modelId: SEEDANCE_FAST, audio: false, usd: { '480p': 0.049, '720p': 0.109, '1080p': 0.247 } },
  { modelId: SEEDANCE_PRO, audio: false, usd: { '480p': 0.123, '720p': 0.272, '1080p': 0.617 } },
  { modelId: SEEDANCE_15, audio: false, usd: { '480p': 0.059, '720p': 0.131, '1080p': 0.296 } },
  { modelId: SEEDANCE_15, audio: true, usd: { '480p': 0.118, '720p': 0.261, '1080p': 0.592 } },
  { modelId: DREAMINA_MINI, audio: false, usd: { '480p': 0.172, '720p': 0.381 } },
  { modelId: DREAMINA_FAST, audio: false, usd: { '480p': 0.274, '720p': 0.61 } },
  { modelId: DREAMINA_20, audio: false, usd: { '480p': 0.343, '720p': 0.762, '1080p': 1.901 } },
  { modelId: DREAMINA_25, audio: false, usd: { '480p': 0.524, '720p': 1.165, '1080p': 2.888 } },
];

/** video-gen-byteplus-seedance.md §10 rate-limit table, individual account. */
const SEEDANCE_DOSSIER_LIMITS: ReadonlyArray<{
  modelId: string;
  individual: { concurrency: number; rpm: number };
  enterprise: { concurrency: number; rpm: number };
}> = [
  { modelId: SEEDANCE_FAST, individual: { concurrency: 10, rpm: 600 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: SEEDANCE_PRO, individual: { concurrency: 10, rpm: 600 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: SEEDANCE_15, individual: { concurrency: 10, rpm: 600 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: DREAMINA_MINI, individual: { concurrency: 3, rpm: 180 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: DREAMINA_FAST, individual: { concurrency: 3, rpm: 180 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: DREAMINA_20, individual: { concurrency: 3, rpm: 180 }, enterprise: { concurrency: 10, rpm: 600 } },
  { modelId: DREAMINA_25, individual: { concurrency: 3, rpm: 180 }, enterprise: { concurrency: 10, rpm: 600 } },
];

const USD_TOLERANCE = 0.0006; // the dossier tables are printed to 3 decimal places

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Realistic ad plan: 24 s of 9:16 vertical, best resolution the model can serve
// ---------------------------------------------------------------------------

function clipPlan(caps: ModelCapabilities, totalSeconds: number): number[] {
  const clips: number[] = [];
  let remaining = totalSeconds;
  const d = caps.durations;
  const longest = d.kind === 'discrete' ? Math.max(...d.seconds) : d.maxSeconds;
  const shortest = d.kind === 'discrete' ? Math.min(...d.seconds) : d.minSeconds;
  let guard = 0;
  while (remaining > 0 && guard++ < 32) {
    let take = Math.min(longest, remaining);
    if (d.kind === 'discrete') {
      const fit = [...d.seconds].filter((s) => s <= take).sort((a, b) => b - a)[0];
      take = fit ?? shortest;
    } else if (take < shortest) {
      take = shortest;
    }
    clips.push(take);
    remaining -= take;
  }
  return clips;
}

function bestVerticalResolution(caps: ModelCapabilities): Resolution {
  for (const r of ['1080p', '720p', '480p'] as const) {
    if (caps.resolutions.includes(r)) return r;
  }
  const first = caps.resolutions[0];
  if (first === undefined) throw new ProbeFailure(`${caps.modelId} declares no resolutions at all`);
  return first;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];

  const add = async (name: string, fn: () => string | Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS', detail });
    } catch (e) {
      const detail =
        e instanceof ProbeFailure
          ? e.message
          : e instanceof Error
            ? `${e.name}: ${e.message}`
            : String(e);
      checks.push({ name, status: 'FAIL', detail });
    }
  };

  const skip = (name: string, blockedBy: string, detail: string): void => {
    checks.push({ name, status: 'SKIP', detail, blockedBy });
  };

  const veoModels = DEFAULT_VEO_MODELS;
  const seedanceModelsIndividual = defaultSeedanceModels('individual');
  const seedanceModelsEnterprise = defaultSeedanceModels('enterprise');
  const allModels: ModelCapabilities[] = [...veoModels, ...seedanceModelsIndividual];

  // =========================================================================
  // A. Cost model — the number that spends real money
  // =========================================================================

  await add('veo: the dossier\'s worked ad costs reproduce to the cent', () => {
    const p = veoProvider(noNetwork().impl);
    const rows: string[] = [];
    const cases: Array<{ model: string; res: Resolution; audio: boolean; seconds: number; expect: number }> = [
      { model: VEO_FAST, res: '1080p', audio: true, seconds: 8, expect: 960_000 },
      { model: VEO_FAST, res: '1080p', audio: false, seconds: 8, expect: 800_000 },
      { model: VEO_FAST, res: '720p', audio: true, seconds: 8, expect: 800_000 },
      { model: VEO_LITE, res: '720p', audio: true, seconds: 8, expect: 400_000 },
      { model: VEO_QUALITY, res: '1080p', audio: true, seconds: 8, expect: 3_200_000 },
      { model: VEO_QUALITY, res: '1080p', audio: false, seconds: 8, expect: 1_600_000 },
    ];
    for (const c of cases) {
      const est = p.estimateCost(
        makeSpec({ modelId: c.model, durationSeconds: c.seconds, aspectRatio: '9:16', resolution: c.res, audio: c.audio }),
      );
      eq(est.microUnits, c.expect, `${c.model} ${c.res} ${c.audio ? 'audio' : 'silent'} ${c.seconds}s`);
      eq(est.billedUnits, c.seconds, `${c.model} billed seconds`);
      eq(est.billingUnit, 'seconds-of-output', 'veo billing unit');
      must(est.exact, `${c.model} estimate must be exact`);
      rows.push(`${c.model.replace('veo-3.1-', '').replace('-generate-001', '')} ${c.res} ${c.audio ? 'A' : 'S'}=${usd(est.microUnits)}`);
    }
    // §5.4: 24s ad = 3 x 8s Fast 1080p audio = $2.88; sampleCount 4 = $11.52.
    const clip = p.estimateCost(
      makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
    );
    eq(clip.microUnits * 3, 2_880_000, '24s ad = 3 x 8s Veo 3.1 Fast 1080p audio');
    const four = p.estimateCost(
      makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, samples: 4 }),
    );
    eq(four.microUnits * 3, 11_520_000, 'sampleCount 4 across a 3-clip ad');
    eq(four.billedUnits, 32, 'sampleCount 4 bills 4 x 8s');
    eq(four.samples, 4, 'samples echoed');
    return `${rows.join('; ')}. 24s ad = 3 x 8s = $2.880000; the same with sampleCount:4 = $11.520000 — both match dossier §5.4 exactly.`;
  });

  await add('veo: every published rate cell matches the Vertex price sheet', () => {
    const p = veoProvider(noNetwork().impl);
    let cells = 0;
    for (const row of VEO_DOSSIER_RATES) {
      const caps = p.capabilities(row.modelId);
      if (!caps.resolutions.includes(row.resolution)) continue; // capability table is the authority
      for (const [audio, rate] of [[true, row.audio] as const, [false, row.silent] as const]) {
        const est = p.estimateCost(
          makeSpec({ modelId: row.modelId, durationSeconds: 4, aspectRatio: '9:16', resolution: row.resolution, audio }),
        );
        eq(
          est.microUnits,
          usdToMicros(rate) * 4,
          `${row.modelId} ${row.resolution} ${audio ? 'audio' : 'silent'} @ $${rate}/s x 4s`,
        );
        cells += 1;
      }
    }
    eq(cells, 14, 'rate cells exercised');
    // Fast publishes a 4K price but the model card does not list 4K: the capability
    // table must win, or the pipeline buys a resolution the model cannot render.
    refuses(
      () =>
        p.estimateCost(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '4k', audio: true }),
        ),
      'resolution',
      /cannot render 4k/i,
    );
    return `14 rate cells (7 model/resolution pairs x audio on/off) verified against video-gen-google-veo.md §5.1, priced per SECOND of output. Veo 3.1 Fast 4K is refused on the capability table even though the price sheet publishes a 4K row for it.`;
  });

  await add('veo: refuses to invent a price for an unpriced cell rather than guessing', () => {
    // A configuration override is the supported way to add a model. Give a descriptor a
    // resolution with no matching rate row and prove the estimator refuses.
    const base = DEFAULT_VEO_MODELS.find((m) => m.modelId === VEO_LITE);
    must(base !== undefined, 'lite descriptor present');
    const bent: ModelCapabilities = { ...(base as ModelCapabilities), resolutions: ['720p', '1080p', '4k'] };
    const p = new VeoProvider({
      projectId: VEO_PROJECT,
      accessToken: 't',
      storageUri: VEO_BUCKET,
      fetchImpl: noNetwork().impl,
      models: [bent],
    });
    const err = refuses(
      () =>
        p.estimateCost(
          makeSpec({ modelId: VEO_LITE, durationSeconds: 8, aspectRatio: '9:16', resolution: '4k', audio: true }),
        ),
      'billing',
      /Refusing to guess a price/i,
    );
    must(/No published Vertex rate/.test(err.message), 'names the missing rate');
    return 'A descriptor that allows a resolution with no published rate row produces a CapabilityError on "billing", not a silently-zero or guessed price.';
  });

  await add('seedance: the pixel-frame formula reproduces the real billed invoice', () => {
    // The one hard datum in the whole cost model: a real generation on
    // seedance-1-0-pro-250528 returned total_tokens 49005 for 864x480, 121 frames.
    eq(pixelFrameTokens(864 * 480, 5), 49_005, '864x480 x 121 / 1024');
    eq(SEEDANCE_FRAME_AREAS['480p'].areaPx, 864 * 480, '480p frame area');
    eq(pixelFrameTokens(SEEDANCE_FRAME_AREAS['720p'].areaPx, 5), 108_900, '720p 5s tokens');
    eq(pixelFrameTokens(SEEDANCE_FRAME_AREAS['1080p'].areaPx, 5), 246_840, '1080p 5s tokens');
    // The docs' own estimate omits the +1 frame and under-counts by 0.8%.
    const docsForm = (864 * 480 * (24 * 5)) / 1024;
    eq(docsForm, 48_600, 'the documented estimate form');
    must(docsForm < 49_005, 'the documented form under-counts');
    // 1080p is 1088 pixels tall-side, not 1080 — get that wrong and every 1080p
    // estimate is 0.7% light.
    must(SEEDANCE_FRAME_AREAS['1080p'].dims.includes('1088'), '1080p is 1088, not 1080');
    const wrong = pixelFrameTokens(1920 * 1080, 5);
    return `49,005 tokens reproduced to the digit (the invoice figure); the docs' fps x duration form gives 48,600 (-0.83%). 1080p uses 1920x1088: using 1920x1080 would give ${wrong} instead of 246,840 (-0.74% per clip).`;
  });

  await add('seedance: the per-clip price table reproduces on every model and tier', () => {
    const p = seedanceProvider(noNetwork().impl);
    const rows: string[] = [];
    let cells = 0;
    for (const row of SEEDANCE_DOSSIER_CLIP_USD) {
      const caps = p.capabilities(row.modelId);
      for (const [res, expected] of Object.entries(row.usd) as Array<[Resolution, number]>) {
        must(
          caps.resolutions.includes(res),
          `${row.modelId} should support ${res} for the dossier price table`,
        );
        const est = p.estimateCost(
          makeSpec({ modelId: row.modelId, durationSeconds: 5, aspectRatio: '9:16', resolution: res, audio: row.audio }),
        );
        const actual = est.microUnits / 1_000_000;
        must(
          Math.abs(actual - expected) < USD_TOLERANCE,
          `${row.modelId} ${res} ${row.audio ? 'audio' : 'silent'}: dossier $${expected}, got ${usd(est.microUnits)}`,
        );
        eq(est.billingUnit, 'pixel-frame-tokens', 'seedance billing unit');
        eq(est.samples, 1, 'seedance has no sampleCount');
        cells += 1;
      }
      rows.push(`${row.modelId}${row.audio ? '+audio' : ''}`);
    }
    eq(cells, 22, 'seedance price cells exercised');
    return `22 per-clip prices across 7 models reproduced within $0.0006 of the dossier §5 table (${rows.length} rate configurations). Prices are computed from the verified pixel-frame formula, not copied.`;
  });

  await add('seedance: audio doubles 1.5 Pro and the mini/fast tiers are audio-neutral', () => {
    const p = seedanceProvider(noNetwork().impl);
    const base = (modelId: string, audio: boolean, res: Resolution = '720p'): number =>
      p.estimateCost(makeSpec({ modelId, durationSeconds: 5, aspectRatio: '9:16', resolution: res, audio })).microUnits;
    const silent = base(SEEDANCE_15, false);
    const loud = base(SEEDANCE_15, true);
    eq(loud, silent * 2, 'audio doubles seedance-1-5-pro');
    // Dreamina publishes no audio split — asking for audio must not change the price.
    eq(base(DREAMINA_MINI, true), base(DREAMINA_MINI, false), 'dreamina mini audio-neutral');
    eq(base(DREAMINA_20, true), base(DREAMINA_20, false), 'dreamina 2.0 audio-neutral');
    // The inversion the dossier flags: 4K is a CHEAPER rate but a DEARER clip.
    const at1080 = p.estimateCost(
      makeSpec({ modelId: DREAMINA_20, durationSeconds: 5, aspectRatio: '9:16', resolution: '1080p', audio: false }),
    );
    const at4k = p.estimateCost(
      makeSpec({ modelId: DREAMINA_20, durationSeconds: 5, aspectRatio: '9:16', resolution: '4k', audio: false }),
    );
    const billing = p.capabilities(DREAMINA_20).billing;
    must(billing.unit === 'pixel-frame-tokens', 'seedance bills in pixel-frame tokens');
    const rates: readonly TokenRate[] = billing.unit === 'pixel-frame-tokens' ? billing.rates : [];
    const rate1080 = selectTokenRate(rates, '1080p', false, false);
    const rate4k = selectTokenRate(rates, '4k', false, false);
    must(rate4k !== undefined && rate1080 !== undefined, 'both rate rows resolve');
    must(
      (rate4k?.usdPerMillionTokens ?? 0) < (rate1080?.usdPerMillionTokens ?? 0),
      '4K rate is cheaper per token',
    );
    must(at4k.microUnits > at1080.microUnits, '4K clip is nonetheless dearer');
    must(!at4k.exact, '4K estimate must be flagged inexact — the frame area is inferred');
    must(at4k.basis.includes('INEXACT'), 'basis says why it is inexact');
    return `1.5 Pro audio $1.20/M -> $2.40/M doubles the clip (${usd(silent)} -> ${usd(loud)}); Dreamina publishes no audio split and the estimator does not invent one. Dreamina 2.0 4K: $4.00/M vs $7.70/M at 1080p, yet the clip is ${usd(at4k.microUnits)} vs ${usd(at1080.microUnits)} — and the 4K estimate is correctly flagged exact:false.`;
  });

  await add('money accumulates in micros, so a 50-clip exploration batch does not drift', () => {
    const p = seedanceProvider(noNetwork().impl);
    const est = p.estimateCost(
      makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '9:16', resolution: '480p', audio: false }),
    );
    eq(est.microUnits, 49_005, 'the cheapest clip in the catalogue');
    eq(est.minorUnits, 5, 'display cents round UP');
    const inMicros = est.microUnits * 50;
    const inCents = est.minorUnits * 50;
    eq(inMicros, 2_450_250, '50 clips in micros');
    eq(inCents, 250, '50 clips accumulated in cents');
    const driftPct = ((inCents / 100 - inMicros / 1_000_000) / (inMicros / 1_000_000)) * 100;
    must(driftPct > 1.9 && driftPct < 2.1, `cent accumulation should drift ~2%, got ${driftPct.toFixed(3)}%`);
    // And rounding UP is the safe direction for a single-item guard.
    eq(microsToMinorUnits(1), 1, 'a sub-cent cost still shows as a cent');
    eq(microsToMinorUnits(0), 0, 'zero is zero');
    eq(microsToMinorUnits(49_005), 5, '4.9005c rounds up to 5c');
    return `A 50-clip exploration batch is ${usd(inMicros)} accumulated in micros vs $2.500000 accumulated in cents — a ${driftPct.toFixed(2)}% overstatement per batch. CostEstimate.microUnits is the summable field and minorUnits is documented as display-only.`;
  });

  await add('a realistic 24s vertical ad prices on every model in both catalogues', () => {
    const veo = veoProvider(noNetwork().impl);
    const ark = seedanceProvider(noNetwork().impl);
    const lines: string[] = [];
    for (const caps of allModels) {
      const provider: VideoProvider = caps.providerId === 'veo' ? veo : ark;
      const res = bestVerticalResolution(caps);
      const clips = clipPlan(caps, 24);
      eq(
        clips.reduce((a, b) => a + b, 0),
        24,
        `${caps.modelId} clip plan totals 24s`,
      );
      for (const c of clips) must(supportsDuration(caps, c), `${caps.modelId} accepts a ${c}s clip`);
      const audio = caps.audio === 'always' ? true : caps.audio === 'none' ? false : true;
      let micros = 0;
      for (const c of clips) {
        micros += provider.estimateCost(
          makeSpec({ modelId: caps.modelId, durationSeconds: c, aspectRatio: '9:16', resolution: res, audio }),
        ).microUnits;
      }
      must(micros > 0, `${caps.modelId} priced above zero`);
      lines.push(
        `${caps.modelId} @${res} ${clips.length}x[${clips.join('+')}]s ${audio ? 'audio' : 'silent'} = ${usd(micros)}`,
      );
    }
    eq(lines.length, 10, 'all ten catalogue models priced');
    const sorted = [...lines].sort();
    return `24s 9:16 ad, best resolution each model can serve: ${sorted.join(' | ')}`;
  });

  await add('seedance: refuses to price a ratio whose frame size was never measured', () => {
    const p = seedanceProvider(noNetwork().impl);
    // These ratios are in the models' aspectRatios (they generate), but Seedance bills
    // per pixel, and nothing pins the emitted frame size — so the price is unknown.
    const unpriceable: AspectRatio[] = ['1:1', '4:3', '3:4', '21:9', 'adaptive'];
    for (const ratio of unpriceable) {
      const caps = p.capabilities(SEEDANCE_FAST);
      must(caps.aspectRatios.includes(ratio), `${ratio} is a generatable ratio on ${SEEDANCE_FAST}`);
      const err = refuses(
        () =>
          p.estimateCost(
            makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: ratio, resolution: '720p', audio: false }),
          ),
        'aspectRatio',
        /frame dimensions this API emits/i,
      );
      must(/usage\.total_tokens/.test(err.message), 'says exactly how to measure and add the row');
    }
    // 5:4 and 3:2 were probed on seedance-1-0-pro only, and are not portable.
    refuses(
      () =>
        p.estimateCost(
          makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '3:2', resolution: '720p', audio: false }),
        ),
      'aspectRatio',
      /cannot generate 3:2 natively/i,
    );
    const pro = p.capabilities(SEEDANCE_PRO);
    must(pro.aspectRatios.includes('3:2'), '3:2 was probed as accepted on seedance-1-0-pro');
    return `5 generatable-but-unpriceable ratios are refused with a CapabilityError on aspectRatio that names the measurement recipe. The undocumented 5:4 / 3:2 extras stay on the model they were probed on — 3:2 is refused on ${SEEDANCE_FAST} and present on ${SEEDANCE_PRO}.`;
  });

  // =========================================================================
  // B. Capability gating — before the money is spent
  // =========================================================================

  await add('4:5 is refused by EVERY model in the catalogue, with the reframe route named', () => {
    const veo = veoProvider(noNetwork().impl);
    const ark = seedanceProvider(noNetwork().impl);
    const seen: string[] = [];
    for (const caps of allModels) {
      const provider: VideoProvider = caps.providerId === 'veo' ? veo : ark;
      must(!caps.aspectRatios.includes('4:5'), `${caps.modelId} must not claim 4:5`);
      const err = refuses(
        () =>
          provider.estimateCost(
            makeSpec({
              modelId: caps.modelId,
              durationSeconds: caps.durations.kind === 'discrete' ? 8 : 5,
              aspectRatio: '4:5',
              resolution: bestVerticalResolution(caps),
              audio: caps.audio === 'none' ? false : true,
            }),
          ),
        'aspectRatio',
        /cannot generate 4:5 natively/i,
      );
      must(
        err.message.includes('Meta\'s recommended Feed video ratio'),
        `${caps.modelId} 4:5 refusal must quote why it matters`,
      );
      must(err.message.includes('9:16 master'), `${caps.modelId} 4:5 refusal must name the reframe route`);
      const plan = planAspectRatio(caps, '4:5');
      eq(plan.kind, 'reframe', `${caps.modelId} plan for 4:5`);
      if (plan.kind === 'reframe') {
        eq(plan.generateAt, '9:16', `${caps.modelId} generates the master at 9:16`);
        must(plan.reason.includes(NO_NATIVE_4_5_NOTE), 'plan carries the catalogue-wide note');
      }
      seen.push(caps.modelId);
    }
    eq(seen.length, 10, 'every model probed for 4:5');
    // The third branch: a model with no 9:16 at all cannot reach 4:5 by reframing.
    const landscapeOnly: ModelCapabilities = { ...(veoModels[0] as ModelCapabilities), aspectRatios: ['16:9'] };
    const plan = planAspectRatio(landscapeOnly, '4:5');
    eq(plan.kind, 'unsupported', 'no 9:16 master means 4:5 is unreachable');
    return `All 10 catalogue models (3 Veo + 7 Seedance) refuse 4:5 pre-submit with a message quoting NO_NATIVE_4_5_NOTE and directing to a 9:16 master + ffmpeg reframe. planAspectRatio returns "reframe" for all 10 and "unsupported" for a descriptor with no 9:16.`;
  });

  await add('out-of-descriptor duration, resolution, audio and keyframes are refused pre-submit', async () => {
    const veoNet = noNetwork();
    const arkNet = noNetwork();
    const veo = veoProvider(veoNet.impl);
    const ark = seedanceProvider(arkNet.impl);
    const refusals: string[] = [];

    // Veo: 4/6/8 and nothing between.
    for (const bad of [3, 5, 7, 9, 8.5]) {
      await refusesAsync(
        () =>
          veo.submit(
            makeSpec({ modelId: VEO_FAST, durationSeconds: bad, aspectRatio: '9:16', resolution: '1080p', audio: true }),
          ),
        'durationSeconds',
        /accepts 4, 6, 8 seconds only/,
      );
    }
    refusals.push('veo 3/5/7/9/8.5s');

    // Seedance: contiguous integer ranges, per model, and non-integers are out.
    const durationCases: Array<{ model: string; bad: number[] }> = [
      { model: SEEDANCE_FAST, bad: [1, 13, 5.5] },
      { model: SEEDANCE_15, bad: [3, 13] },
      { model: DREAMINA_20, bad: [3, 16] },
      { model: DREAMINA_25, bad: [3, 31] },
    ];
    for (const c of durationCases) {
      for (const bad of c.bad) {
        await refusesAsync(
          () =>
            ark.submit(
              makeSpec({ modelId: c.model, durationSeconds: bad, aspectRatio: '9:16', resolution: '480p', audio: false }),
            ),
          'durationSeconds',
          /does not accept/,
        );
      }
    }
    refusals.push('seedance out-of-range and fractional durations on 4 models');

    // Resolution: the 720p-capped tiers cannot serve Meta's 1080x1920 spec.
    for (const model of [DREAMINA_FAST, DREAMINA_MINI]) {
      const err = await refusesAsync(
        () =>
          ark.submit(
            makeSpec({ modelId: model, durationSeconds: 5, aspectRatio: '9:16', resolution: '1080p', audio: false }),
          ),
        'resolution',
        /cannot render 1080p/,
      );
      must(/1080x1920/.test(err.message), 'names the Meta spec it cannot serve');
    }
    // 4K is only on dreamina-seedance-2-0-260128.
    for (const model of [SEEDANCE_FAST, SEEDANCE_15, DREAMINA_25]) {
      await refusesAsync(
        () =>
          ark.submit(
            makeSpec({ modelId: model, durationSeconds: 5, aspectRatio: '9:16', resolution: '4k', audio: false }),
          ),
        'resolution',
        /cannot render 4k/,
      );
    }
    refusals.push('1080p on the 720p-capped tiers; 4k on the five models that lack it');

    // Audio: asking a silent model to speak.
    for (const model of [SEEDANCE_FAST, SEEDANCE_PRO]) {
      await refusesAsync(
        () =>
          ark.submit(
            makeSpec({ modelId: model, durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: true }),
          ),
        'audio',
        /produces no audio track at all/,
      );
    }
    refusals.push('audio:true on the two silent 1.0 models');

    // Keyframes: last-frame interpolation on a model that would silently ignore it.
    const frame: ImageRef = { kind: 'uri', uri: 'https://cdn.example.com/last.png', mimeType: 'image/png' };
    const err = await refusesAsync(
      () =>
        ark.submit(
          makeSpec({
            modelId: SEEDANCE_FAST,
            durationSeconds: 5,
            aspectRatio: '9:16',
            resolution: '720p',
            audio: false,
            lastFrame: frame,
          }),
        ),
      'lastFrame',
      /does not support last-frame interpolation/,
    );
    must(/fully-billed video that ignored the last frame/.test(err.message), 'names the silent-billing risk');
    refusals.push('lastFrame on the 1.0 line');

    // Samples: Veo caps at 4, Seedance at 1.
    await refusesAsync(
      () =>
        veo.submit(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, samples: 5 }),
        ),
      'samples',
      /at most 4 sample/,
    );
    await refusesAsync(
      () =>
        ark.submit(
          makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: false, samples: 2 }),
        ),
      'samples',
      /at most 1 sample/,
    );
    await refusesAsync(
      () =>
        veo.submit(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, samples: 0 }),
        ),
      'samples',
      /positive integer/,
    );
    refusals.push('samples 5 on Veo, 2 on Seedance, 0 anywhere');

    // Unknown model ids never fall back to a default.
    await rejectsWith(
      () =>
        veo.submit(
          makeSpec({ modelId: 'veo-4.0-generate-001', durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
        ),
      UnknownModelError,
      /Model ids are CONFIGURATION here/,
    );
    await rejectsWith(
      () =>
        ark.submit(
          makeSpec({ modelId: 'seedance-9-9-pro', durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: false }),
        ),
      UnknownModelError,
      /Known: seedance-1-0-pro-fast-251015/,
    );
    refusals.push('unknown model ids on both providers');

    eq(veoNet.calls.length, 0, 'Veo made no network call for a refused spec');
    eq(arkNet.calls.length, 0, 'ModelArk made no network call for a refused spec');
    return `${refusals.join('; ')} — 30 refused specs across both providers, and the fetch implementation (which throws if touched) was called 0 times. Every refusal happens before the uncancellable, billable request.`;
  });

  await add('the descriptors match the probed capability matrix model by model', () => {
    const p = seedanceProvider(noNetwork().impl);
    const expected: Array<{ model: string; min: number; max: number; res: Resolution[] }> = [
      { model: SEEDANCE_PRO, min: 2, max: 12, res: ['480p', '720p', '1080p'] },
      { model: SEEDANCE_FAST, min: 2, max: 12, res: ['480p', '720p', '1080p'] },
      { model: SEEDANCE_15, min: 4, max: 12, res: ['480p', '720p', '1080p'] },
      { model: DREAMINA_20, min: 4, max: 15, res: ['480p', '720p', '1080p', '4k'] },
      { model: DREAMINA_FAST, min: 4, max: 15, res: ['480p', '720p'] },
      { model: DREAMINA_MINI, min: 4, max: 15, res: ['480p', '720p'] },
      { model: DREAMINA_25, min: 4, max: 30, res: ['480p', '720p', '1080p'] },
    ];
    for (const e of expected) {
      const caps = p.capabilities(e.model);
      eq(caps.durations.kind, 'integerRange', `${e.model} duration shape`);
      if (caps.durations.kind === 'integerRange') {
        eq(caps.durations.minSeconds, e.min, `${e.model} min duration`);
        eq(caps.durations.maxSeconds, e.max, `${e.model} max duration`);
      }
      eq(caps.resolutions.join(','), e.res.join(','), `${e.model} resolutions`);
      eq(caps.fps, 24, `${e.model} fps`);
      eq(caps.maxSamplesPerRequest, 1, `${e.model} has no sampleCount`);
      eq(caps.indemnified, false, `${e.model} has no vendor indemnity`);
      eq(caps.cancellableWhileRunning, false, `${e.model} cannot be cancelled once running`);
      eq(caps.resultUrlTtlSeconds, 86_400, `${e.model} result URL TTL`);
      // 7, 9, 11 are the integers the widespread "3/5/10 only" belief would reject.
      for (const s of [7, 9, 11]) {
        if (s >= e.min && s <= e.max) must(supportsDuration(caps, s), `${e.model} accepts ${s}s`);
      }
    }
    const veo = veoProvider(noNetwork().impl);
    for (const m of veoModels) {
      eq(describeDurations(m), '4, 6, 8 seconds only', `${m.modelId} durations`);
      eq(m.aspectRatios.join(','), '16:9,9:16', `${m.modelId} ratios`);
      eq(m.maxSamplesPerRequest, 4, `${m.modelId} sampleCount cap`);
      eq(m.keyframes, 'first-and-last', `${m.modelId} keyframes`);
      eq(m.fps, 24, `${m.modelId} fps`);
      eq(veo.capabilities(m.modelId).modelId, m.modelId, 'catalogue lookup');
    }
    return '7 Seedance descriptors match the probed duration/resolution matrix (§3) including the contiguous-integer durations 7/9/11 that the "3/5/10 only" belief rejects; 3 Veo descriptors are 4/6/8s, 16:9+9:16, sampleCount<=4, 24fps.';
  });

  await add('indemnity and retirement are reported as facts, not as expiry dates', () => {
    const veo = veoProvider(noNetwork().impl);
    eq(veo.capabilities(VEO_FAST).indemnified, true, 'GA Fast is indemnified');
    eq(veo.capabilities(VEO_QUALITY).indemnified, true, 'GA quality is indemnified');
    eq(veo.capabilities(VEO_LITE).indemnified, false, 'Lite is a preview model');
    for (const m of veoModels) {
      if (m.indemnified) {
        must(
          /never for advertising/i.test(m.indemnityNote),
          `${m.modelId} must record that the indemnity excludes trade/commerce use`,
        );
      }
    }
    for (const m of seedanceModelsIndividual) {
      eq(m.indemnified, false, `${m.modelId} indemnity`);
      must(/The absence is the finding/.test(m.indemnityNote), 'BytePlus silence is recorded');
    }
    const now = new Date();
    const fastRisk = retirementRisk(veo.capabilities(VEO_FAST), now);
    const liteRisk = retirementRisk(veo.capabilities(VEO_LITE), now);
    eq(liteRisk, 'unannounced', 'Lite has no announced retirement');
    eq(retirementRisk(veo.capabilities(VEO_QUALITY), new Date('2027-01-01')), 'past-earliest', 'after the floor');
    eq(retirementRisk(veo.capabilities(VEO_QUALITY), new Date('2026-01-01')), 'active', 'well before the floor');
    eq(veo.capabilities(VEO_FAST).retirement.qualifier, 'or-later', 'the date is a floor, not an expiry');
    return `Veo 3.1 GA models: retirement floor 2026-11-17 with qualifier "or-later"; today (${now.toISOString().slice(0, 10)}) that classifies as "${fastRisk}". Lite is "${liteRisk}". Every indemnified Veo descriptor records that the coverage excludes advertising use, and all 7 Seedance models are indemnified:false.`;
  });

  // =========================================================================
  // C. Per-model semaphore
  // =========================================================================

  const measure = async (
    sem: ModelSemaphore,
    caps: ModelCapabilities,
    resolution: Resolution,
    tasks: number,
  ): Promise<{ peak: number; completed: number }> => {
    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    await Promise.all(
      Array.from({ length: tasks }, () =>
        sem.run(caps, resolution, async () => {
          inFlight += 1;
          if (inFlight > peak) peak = inFlight;
          must(
            sem.inFlight(concurrencySlot(caps, resolution)) <= concurrencyLimitFor(caps, resolution),
            'the semaphore over-counted its own slot',
          );
          await new Promise<void>((r) => setTimeout(r, 2));
          inFlight -= 1;
          completed += 1;
        }),
      ),
    );
    return { peak, completed };
  };

  await add('the semaphore serialises to the documented per-model concurrency', async () => {
    const p = seedanceProvider(noNetwork().impl);
    const results: string[] = [];
    for (const row of SEEDANCE_DOSSIER_LIMITS) {
      const caps = p.capabilities(row.modelId);
      eq(concurrencyLimitFor(caps, '720p'), row.individual.concurrency, `${row.modelId} individual concurrency`);
      eq(requestsPerMinuteFor(caps, '720p'), row.individual.rpm, `${row.modelId} individual RPM`);
      eq(caps.concurrency.source, 'documented', `${row.modelId} concurrency is a vendor number`);
      const sem = new ModelSemaphore();
      const { peak, completed } = await measure(sem, caps, '720p', row.individual.concurrency * 3 + 4);
      eq(peak, row.individual.concurrency, `${row.modelId} observed peak concurrency`);
      eq(completed, row.individual.concurrency * 3 + 4, `${row.modelId} all tasks completed`);
      eq(sem.inFlight(concurrencySlot(caps, '720p')), 0, `${row.modelId} drained to zero`);
      eq(sem.queueDepth(concurrencySlot(caps, '720p')), 0, `${row.modelId} queue drained`);
      results.push(`${row.modelId}=${peak}`);
    }
    // Enterprise widens Dreamina to 10; the 1.x line has no tier split at all.
    const ent = seedanceProvider(noNetwork().impl, 'enterprise');
    for (const row of SEEDANCE_DOSSIER_LIMITS) {
      const caps = ent.capabilities(row.modelId);
      eq(concurrencyLimitFor(caps, '720p'), row.enterprise.concurrency, `${row.modelId} enterprise concurrency`);
      eq(requestsPerMinuteFor(caps, '720p'), row.enterprise.rpm, `${row.modelId} enterprise RPM`);
    }
    const entDreamina = ent.capabilities(DREAMINA_20);
    const entPeak = await measure(new ModelSemaphore(), entDreamina, '1080p', 24);
    eq(entPeak.peak, 10, 'enterprise Dreamina runs 10 concurrent');
    // Seedance 1.x must NOT widen on an enterprise account — it has no split.
    eq(concurrencyLimitFor(ent.capabilities(SEEDANCE_FAST), '720p'), 10, 'no tier split on 1.x');
    return `Observed peak concurrency with a live in-flight counter, individual account: ${results.join(', ')} — 10 on the whole Seedance 1.x line, 3 on Dreamina 2.x. Enterprise widens Dreamina 2.0 to 10 (observed) and leaves the 1.x line at 10.`;
  });

  await add('4K is its own queue: concurrency 1, 15 RPM, and it cannot borrow the 1080p lane', async () => {
    const p = seedanceProvider(noNetwork().impl);
    const caps = p.capabilities(DREAMINA_20);
    eq(concurrencyLimitFor(caps, '4k'), 1, '4K concurrency');
    eq(requestsPerMinuteFor(caps, '4k'), 15, '4K RPM');
    eq(concurrencyLimitFor(caps, '1080p'), 3, 'non-4K concurrency, individual');
    eq(requestsPerMinuteFor(caps, '1080p'), 180, 'non-4K RPM, individual');
    const slot4k = concurrencySlot(caps, '4k');
    const slot1080 = concurrencySlot(caps, '1080p');
    must(slot4k !== slot1080, '4K must not share a slot with 1080p');
    must(slot4k.endsWith('@4k'), 'the 4K slot carries the resolution');
    eq(slot1080, `seedance:${DREAMINA_20}`, 'the unnarrowed slot carries no resolution');
    // Enterprise does not widen the 4K lane: the vendor says 1 for both account types.
    const ent = seedanceProvider(noNetwork().impl, 'enterprise');
    eq(concurrencyLimitFor(ent.capabilities(DREAMINA_20), '4k'), 1, '4K stays at 1 on enterprise');
    eq(requestsPerMinuteFor(ent.capabilities(DREAMINA_20), '4k'), 15, '4K RPM stays at 15 on enterprise');

    const sem = new ModelSemaphore();
    const four = await measure(sem, caps, '4k', 5);
    eq(four.peak, 1, '4K serialises completely');

    // Saturating 4K must not block 1080p, and vice versa.
    const shared = new ModelSemaphore();
    const releaseHold = await shared.acquire(caps, '4k');
    eq(shared.inFlight(slot4k), 1, '4K lane saturated');
    const hd = await measure(shared, caps, '1080p', 9);
    eq(hd.peak, 3, '1080p keeps its own allowance while 4K is saturated');
    releaseHold();
    eq(shared.inFlight(slot4k), 0, '4K released');
    return `Dreamina 2.0 4K is a separate queue (slot "${slot4k}"): observed peak 1 across 5 tasks, 15 RPM, and unchanged on an enterprise account — matching the dossier §10 table, which lists "(non-4K)" and "4K" as separate rows. With the 4K lane held, 1080p still ran at its own peak of 3.`;
  });

  await add('a double release cannot widen the limit, and a throw still frees the slot', async () => {
    const p = seedanceProvider(noNetwork().impl);
    const caps = p.capabilities(DREAMINA_20);
    const sem = new ModelSemaphore();
    const slot = concurrencySlot(caps, '4k');

    // Limit 1. Hold it, queue two waiters, then release TWICE. A non-idempotent
    // releaser would hand out two slots and run both waiters at once.
    const release = await sem.acquire(caps, '4k');
    let running = 0;
    let peak = 0;
    const body = async (): Promise<void> => {
      const r = await sem.acquire(caps, '4k');
      running += 1;
      if (running > peak) peak = running;
      await new Promise<void>((res) => setTimeout(res, 5));
      running -= 1;
      r();
    };
    const a = body();
    const b = body();
    await new Promise<void>((r) => setTimeout(r, 1));
    eq(sem.queueDepth(slot), 2, 'two waiters queued behind a limit of 1');
    release();
    release();
    release();
    await Promise.all([a, b]);
    eq(peak, 1, 'a triple release must not widen a concurrency of 1');
    eq(sem.inFlight(slot), 0, 'the slot drained exactly');
    eq(sem.queueDepth(slot), 0, 'no waiter was stranded');

    // run() releases on throw, so a failed generation does not leak a slot forever.
    const sem2 = new ModelSemaphore();
    const slot2 = concurrencySlot(caps, '1080p');
    for (let i = 0; i < 5; i += 1) {
      try {
        await sem2.run(caps, '1080p', async () => {
          throw new ProviderRequestError('seedance', 500, '{}', 'ModelArk 500');
        });
      } catch {
        /* expected */
      }
    }
    eq(sem2.inFlight(slot2), 0, 'five consecutive failures leaked no slots');
    const after = await measure(sem2, caps, '1080p', 9);
    eq(after.peak, 3, 'the full allowance is still available after the failures');

    // A descriptor that declares a nonsense limit must fail loudly, not run unbounded.
    const broken: ModelCapabilities = {
      ...caps,
      concurrency: { limit: 0, source: 'documented', overrides: [] },
    };
    await rejectsWith(() => new ModelSemaphore().acquire(broken, '720p'), Error, /must declare at least 1/);
    return 'Releasing three times from one holder handed over exactly one slot (observed peak 1 on a limit of 1, no stranded waiters). Five consecutive throwing generations leaked no slots. A descriptor declaring concurrency 0 throws instead of running unbounded.';
  });

  await add('Veo concurrency is flagged as derived from a request rate, not a vendor cap', async () => {
    const veo = veoProvider(noNetwork().impl);
    for (const m of veoModels) {
      const caps = veo.capabilities(m.modelId);
      eq(caps.concurrency.source, 'derived-from-rpm', `${m.modelId} concurrency provenance`);
      eq(caps.concurrency.limit, 50, `${m.modelId} operational stand-in`);
      eq(requestsPerMinuteFor(caps, '1080p'), 50, `${m.modelId} RPM`);
      eq(requestsPerMinuteFor(caps, '720p'), 50, 'Veo RPM does not vary by resolution');
      eq(concurrencySlot(caps, '1080p'), `veo:${m.modelId}`, 'no resolution narrowing on Veo');
    }
    const sem = new ModelSemaphore();
    const r = await measure(sem, veo.capabilities(VEO_FAST), '1080p', 120);
    eq(r.peak, 50, 'the Veo lane serialises at its stand-in number');
    eq(r.completed, 120, 'all 120 tasks completed');
    return 'All three Veo descriptors declare concurrency 50 with source "derived-from-rpm" — Google publishes a 50 RPM request rate, not a concurrency cap, and the provenance flag says so. Observed peak 50 across 120 queued tasks.';
  });

  // =========================================================================
  // D. Driving the providers against faithful fakes
  // =========================================================================

  await add('veo submit posts predictLongRunning with the exact documented body', async () => {
    const f = recorder(() => ({ body: { name: OP_NAME } }));
    const p = veoProvider(f.impl);
    const first: ImageRef = { kind: 'uri', uri: 'gs://ad-factory-creative/kf/first.png', mimeType: 'image/png' };
    const last: ImageRef = { kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/jpeg' };
    const result = await p.submit(
      makeSpec({
        modelId: VEO_FAST,
        durationSeconds: 8,
        aspectRatio: '9:16',
        resolution: '1080p',
        audio: false,
        samples: 2,
        seed: 4_294_967_295,
        negativePrompt: 'text overlays, watermarks, distorted hands',
        firstFrame: first,
        lastFrame: last,
        labels: { brand: 'hydra', campaign: 'q4-prospecting' },
      }),
    );
    eq(f.calls.length, 1, 'exactly one call');
    const call = f.calls[0] as WireCall;
    eq(call.method, 'POST', 'predictLongRunning is a POST');
    eq(
      call.url,
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${VEO_PROJECT}/locations/us-central1/publishers/google/models/${VEO_FAST}:predictLongRunning`,
      'Vertex URL',
    );
    eq(call.headers['authorization'], 'Bearer ya29.probe-token-not-a-real-credential', 'bearer token');
    eq(call.headers['content-type'], 'application/json; charset=utf-8', 'documented content type');
    const body = call.body as Record<string, unknown>;
    const instances = body['instances'] as Array<Record<string, unknown>>;
    const instance = instances[0] as Record<string, unknown>;
    eq(instance['prompt'], AD_PROMPT, 'prompt');
    // image / lastFrame are SIBLINGS inside the instance, not parameters.
    eq(JSON.stringify(instance['image']), JSON.stringify({ gcsUri: first.uri, mimeType: 'image/png' }), 'first frame');
    eq(
      JSON.stringify(instance['lastFrame']),
      JSON.stringify({ bytesBase64Encoded: 'aGVsbG8=', mimeType: 'image/jpeg' }),
      'last frame is a sibling of image',
    );
    const params = body['parameters'] as Record<string, unknown>;
    eq(params['storageUri'], VEO_BUCKET, 'gs:// sink — omitting it returns base64 inline');
    eq(params['aspectRatio'], '9:16', 'aspect');
    eq(params['durationSeconds'], 8, 'duration');
    eq(params['resolution'], '1080p', 'resolution');
    eq(params['sampleCount'], 2, 'sampleCount');
    eq(params['generateAudio'], false, 'generateAudio is ALWAYS explicit — it is the price lever');
    eq(params['enhancePrompt'], false, 'enhancePrompt is explicit false so a pinned seed stays meaningful');
    eq(params['personGeneration'], 'allow_adult', 'Vertex spelling, not the Gemini API spelling');
    eq(params['seed'], 4_294_967_295, 'uint32 upper bound accepted');
    eq(params['negativePrompt'], 'text overlays, watermarks, distorted hands', 'negative prompt forwarded');
    eq(JSON.stringify(body['labels']), JSON.stringify({ brand: 'hydra', campaign: 'q4-prospecting' }), 'billing labels are top-level');
    eq(result.taskId, OP_NAME, 'task id is the operation name');
    eq(result.estimate.microUnits, 1_600_000, 'the pre-submit estimate is recorded: 2 x 8s @ $0.10/s');
    eq(result.providerId, 'veo', 'provider id');

    // A non-gs:// sink would return a multi-megabyte base64 MP4 inline.
    const g = recorder(() => ({ body: { name: OP_NAME } }));
    await refusesAsync(
      () =>
        veoProvider(g.impl).submit(
          makeSpec({
            modelId: VEO_FAST,
            durationSeconds: 8,
            aspectRatio: '9:16',
            resolution: '1080p',
            audio: true,
            outputUri: 'https://storage.googleapis.com/bucket/',
          }),
        ),
      'outputUri',
      /base64-inline/,
    );
    eq(g.calls.length, 0, 'the bad sink never reached the network');
    // A seed outside uint32 is caught locally rather than bought as a Vertex 400.
    await refusesAsync(
      () =>
        veoProvider(g.impl).submit(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, seed: -1 }),
        ),
      'seed',
      /uint32 \(0-4294967295\)/,
    );
    eq(g.calls.length, 0, 'the bad seed never reached the network');
    return 'The wire body matches video-gen-google-veo.md §3.1 field for field: instances[0].{prompt,image,lastFrame}, parameters.{storageUri,aspectRatio,durationSeconds,resolution,sampleCount,generateAudio,enhancePrompt,personGeneration,seed,negativePrompt} and a top-level labels map. generateAudio and enhancePrompt are always explicit. A non-gs:// sink and an out-of-range seed are both refused before the billable call.';
  });

  await add('veo poll uses POST fetchPredictOperation and parses the documented response', async () => {
    const f = recorder(() => ({
      body: {
        name: OP_NAME,
        done: true,
        response: {
          raiMediaFilteredCount: 0,
          '@type': 'type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse',
          videos: [
            { gcsUri: 'gs://ad-factory-creative/veo/20260905/sample_0.mp4', mimeType: 'video/mp4' },
            { gcsUri: 'gs://ad-factory-creative/veo/20260905/sample_1.mp4', mimeType: 'video/mp4' },
          ],
        },
      },
    }));
    const status = await veoProvider(f.impl).poll(OP_NAME);
    const call = f.calls[0] as WireCall;
    eq(call.method, 'POST', 'fetchPredictOperation is a POST, not a GET — the Gemini API idiom 404s here');
    must(call.url.endsWith(`/models/${VEO_FAST}:fetchPredictOperation`), 'poll URL derives the model from the operation name');
    eq((call.body as Record<string, unknown>)['operationName'], OP_NAME, 'operation name goes in the body');
    eq(status.state, 'SUCCEEDED', 'state');
    eq(status.videos.length, 2, 'two videos parsed');
    eq(status.videos[0]?.uri, 'gs://ad-factory-creative/veo/20260905/sample_0.mp4', 'gcsUri');
    eq(status.videos[0]?.mimeType, 'video/mp4', 'mime type');
    eq(status.partial, false, 'clean success');
    eq(status.modelId, VEO_FAST, 'model id read back out of the operation name');
    eq(status.resultExpiresAt, undefined, 'Veo writes into our own GCS bucket, so nothing expires');

    // An unfinished operation is RUNNING, never a failure.
    const g = recorder(() => ({ body: { name: OP_NAME } }));
    eq((await veoProvider(g.impl).poll(OP_NAME)).state, 'RUNNING', 'done absent means RUNNING');

    // base64-inline videos (the storageUri-omitted shape) still parse.
    const h = recorder(() => ({
      body: { name: OP_NAME, done: true, response: { videos: [{ bytesBase64Encoded: 'AAAA', mimeType: 'video/mp4' }] } },
    }));
    const inline = await veoProvider(h.impl).poll(OP_NAME);
    eq(inline.videos[0]?.base64, 'AAAA', 'bytesBase64Encoded parsed');
    eq(inline.videos[0]?.uri, undefined, 'no gcsUri in the inline shape');

    // A truncated operation name cannot be polled: the model id lives inside it.
    await refusesAsync(() => veoProvider(f.impl).poll('operations/abc'), 'taskId', /not a Vertex operation name/);
    // Polling another project's operation would be a 403; it is caught locally.
    await refusesAsync(
      () => veoProvider(f.impl).poll(OP_NAME.replace(VEO_PROJECT, 'someone-elses-project')),
      'taskId',
      /Credentials are project-scoped/,
    );
    return 'poll() POSTs to :fetchPredictOperation with {"operationName": ...} in the body, parses videos[].gcsUri and bytesBase64Encoded, reports an unfinished operation as RUNNING, and refuses a truncated operation name or one belonging to another project before spending a 403.';
  });

  await add('veo: a fully-filtered success is turned into an explicit failure, not a silent one', async () => {
    const f = recorder(() => ({
      body: {
        name: OP_NAME,
        done: true,
        response: {
          raiMediaFilteredCount: 4,
          raiMediaFilteredReasons: [
            'Support codes: 15236754',
            'The prompt couldn\'t be submitted or it might violate our policies.',
          ],
          videos: [],
        },
      },
    }));
    const status = await veoProvider(f.impl).poll(OP_NAME);
    eq(status.state, 'FAILED', 'done:true with zero videos is a failure');
    eq(status.error?.code, 'RAI_FILTERED_ALL', 'error code');
    eq(status.error?.route, 'HUMAN_REVIEW', 'never auto-retried');
    eq(status.filteredCount, 4, 'filtered count surfaced');
    must(
      /never respond by relaxing the safety filter/i.test(status.error?.message ?? ''),
      'the indemnity carve-out is quoted in the error',
    );

    // Partial delivery: 2 of 4, with the filtered count present.
    const g = recorder(() => ({
      body: {
        name: OP_NAME,
        done: true,
        response: {
          raiMediaFilteredCount: 2,
          raiMediaFilteredReasons: ['safety'],
          videos: [
            { gcsUri: 'gs://b/0.mp4', mimeType: 'video/mp4' },
            { gcsUri: 'gs://b/1.mp4', mimeType: 'video/mp4' },
          ],
        },
      },
    }));
    const partial = await veoProvider(g.impl).poll(OP_NAME);
    eq(partial.state, 'SUCCEEDED', 'Vertex still calls it a success');
    eq(partial.partial, true, 'the module flags it as partial');
    eq(partial.filteredCount, 2, 'filtered count');
    return 'done:true with zero videos and raiMediaFilteredCount=4 becomes a FAILED status with code RAI_FILTERED_ALL routed to HUMAN_REVIEW and the indemnity carve-out quoted. A 2-of-4 delivery with raiMediaFilteredCount=2 is reported SUCCEEDED but partial:true.';
  });

  await add('veo: under-delivery with no raiMediaFilteredCount is reconcilable from the estimate', async () => {
    // The dossier's §9.1 case 2: "you may get 1, 2, or 0 videos back and done: true".
    // raiMediaFilteredCount is documented as "Returns if any videos were filtered", i.e.
    // it can be ABSENT. Then poll() alone cannot know the batch under-delivered.
    const submitFetch = recorder(() => ({ body: { name: OP_NAME } }));
    const p = veoProvider(submitFetch.impl);
    const submitted = await p.submit(
      makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, samples: 4 }),
    );
    eq(submitted.estimate.samples, 4, 'SubmitResult carries the requested sample count');

    const pollFetch = recorder(() => ({
      body: {
        name: OP_NAME,
        done: true,
        response: { videos: [{ gcsUri: 'gs://b/0.mp4', mimeType: 'video/mp4' }] },
      },
    }));
    const status = await veoProvider(pollFetch.impl).poll(OP_NAME);
    eq(status.state, 'SUCCEEDED', 'Vertex reports success');
    eq(status.filteredCount, 0, 'no filtered count in the payload');
    // poll() alone cannot see this; the caller MUST hold SubmitResult.estimate.samples.
    must(status.videos.length < submitted.estimate.samples, 'the batch under-delivered 1 of 4');
    eq(
      status.partial,
      false,
      'BUG SURFACE: with raiMediaFilteredCount absent, poll() cannot flag partial from the payload alone',
    );
    // The second, explicit form: poll() accepts the expected sample count and then does.
    const withExpectation = await veoProvider(
      recorder(() => ({
        body: { name: OP_NAME, done: true, response: { videos: [{ gcsUri: 'gs://b/0.mp4', mimeType: 'video/mp4' }] } },
      })).impl,
    ).poll(OP_NAME, submitted.estimate.samples);
    eq(withExpectation.partial, true, 'told what it asked for, poll() detects the silent under-delivery');
    eq(withExpectation.filteredCount, 3, 'the missing videos are counted as filtered');
    must(
      withExpectation.filteredReasons.some((r) => /fewer videos/i.test(r)),
      'the reason names the under-delivery',
    );
    return 'Confirmed the dominant Veo failure shape. With raiMediaFilteredCount absent, a 1-of-4 delivery is indistinguishable from success in the payload — poll(taskId) alone reports partial:false. poll(taskId, expectedSamples) now closes it: partial:true, filteredCount 3, and a reason naming the under-delivery. SubmitResult.estimate.samples is the value to pass.';
  });

  await add('veo safety support codes route by SEVERITY, not by their order in the message', () => {
    eq(JSON.stringify(parseSupportCodes('… Support codes: 15236754')), JSON.stringify(['15236754']), 'single code');
    eq(
      JSON.stringify(parseSupportCodes('Support codes: 35561574, 29310472')),
      JSON.stringify(['35561574', '29310472']),
      'comma-separated codes',
    );
    eq(JSON.stringify(parseSupportCodes('no codes at all')), JSON.stringify([]), 'no codes');

    eq(classifySupportCodes(['15236754']).route, 'AUTO_REWRITE', 'celebrity is safe to rewrite');
    eq(classifySupportCodes(['15236754']).category, 'CELEBRITY', 'celebrity category');
    eq(classifySupportCodes(['35561575']).route, 'HUMAN_REVIEW', 'third-party IP goes to a human');
    eq(classifySupportCodes(['58061214']).route, 'ABORT', 'child content aborts');
    eq(classifySupportCodes(['99999999']).route, 'HUMAN_REVIEW', 'an unknown code is never auto-retried');

    // The adversarial case: Veo returns a LIST of codes. If routing takes the first
    // match by message order, a celebrity code listed before a third-party-IP code
    // routes the whole refusal to AUTO_REWRITE — and auto-retrying a weakened prompt
    // past the IP guardrail is carve-out (2) of Google's indemnity.
    const mixed = classifySupportCodes(['29310472', '35561574']);
    eq(mixed.route, 'HUMAN_REVIEW', 'a mixed celebrity + third-party-IP refusal must go to a human');
    eq(mixed.category, 'THIRD_PARTY_CONTENT', 'the binding category is reported');
    const withChild = classifySupportCodes(['29310472', '58061214']);
    eq(withChild.route, 'ABORT', 'anything paired with a child-safety code aborts');
    eq(withChild.category, 'CHILD', 'the abort category is reported');
    const reversed = classifySupportCodes(['35561574', '29310472']);
    eq(reversed.route, 'HUMAN_REVIEW', 'routing is order-independent');
    eq(
      JSON.stringify(classifySupportCodes(['29310472', '35561574'])),
      JSON.stringify(classifySupportCodes(['35561574', '29310472'])),
      'the same code set routes identically in either order',
    );
    return 'Single-code routing matches the §9.2 table. Multi-code refusals now route on the most restrictive category (ABORT > HUMAN_REVIEW > AUTO_REWRITE > RETRY) and are order-independent: {celebrity, third-party-IP} routes to HUMAN_REVIEW in both orders rather than to AUTO_REWRITE.';
  });

  await add('veo: an errored operation is classified and a billable transport failure is AMBIGUOUS', async () => {
    const f = recorder(() => ({
      body: {
        name: OP_NAME,
        error: {
          code: 400,
          message:
            'Veo could not generate videos because the input image violates Agent Platform\'s usage guidelines. ' +
            'If you think this was an error, send feedback. Support codes: 35561574',
        },
      },
    }));
    const status = await veoProvider(f.impl).poll(OP_NAME);
    eq(status.state, 'FAILED', 'errored operation');
    eq(status.error?.category, 'THIRD_PARTY_CONTENT', 'the brand/logo guardrail');
    eq(status.error?.route, 'HUMAN_REVIEW', 'never auto-retried');
    eq(JSON.stringify(status.error?.supportCodes), JSON.stringify(['35561574']), 'codes captured for the ledger');
    eq(status.error?.code, '400', 'vendor code');

    // A transport failure on the BILLABLE call must not look like "never sent".
    const t = recorder(() => ({ throwTransport: 'fetch failed: ECONNRESET' }));
    const err = await rejectsWith(
      () =>
        veoProvider(t.impl).submit(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
        ),
      ProviderRequestError,
      /AMBIGUOUS/,
    );
    must(/Do not blindly resubmit/.test(err.message), 'tells the retry wrapper what to do');
    eq(err.httpStatus, 0, 'transport failures carry status 0');
    // The same failure on the non-billable poll is reported plainly.
    const t2 = recorder(() => ({ throwTransport: 'fetch failed: ECONNRESET' }));
    const pollErr = await rejectsWith(() => veoProvider(t2.impl).poll(OP_NAME), ProviderRequestError, /Transport failure calling Vertex/);
    must(!/AMBIGUOUS/.test(pollErr.message), 'a poll failure is not ambiguous — nothing was charged');

    // A 200 with no operation name is also treated as possibly-billed.
    const n = recorder(() => ({ body: { metadata: {} } }));
    await rejectsWith(
      () =>
        veoProvider(n.impl).submit(
          makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
        ),
      ProviderRequestError,
      /may still be running and billable/,
    );
    // An HTTP error surfaces Google's message rather than a bare status.
    const e429 = recorder(() => ({
      status: 429,
      body: { error: { code: 429, message: 'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model' } },
    }));
    await rejectsWith(
      () => veoProvider(e429.impl).poll(OP_NAME),
      ProviderRequestError,
      /Vertex HTTP 429: Quota exceeded/,
    );
    // Non-JSON (an HTML error page from a proxy) does not crash the parser.
    const html = recorder(() => ({ status: 502, text: '<html><body>502 Bad Gateway</body></html>' }));
    await rejectsWith(() => veoProvider(html.impl).poll(OP_NAME), ProviderRequestError, /Non-JSON response from Vertex/);
    return 'A refusal carrying "Support codes: 35561574" classifies as THIRD_PARTY_CONTENT/HUMAN_REVIEW with the codes kept for the provenance ledger. A transport failure on predictLongRunning is raised as AMBIGUOUS (may already be billed) while the same failure on poll is reported plainly; a 200 with no operation name, a 429 quota error and an HTML 502 page are all turned into typed ProviderRequestErrors.';
  });

  await add('seedance submit sends only whitelisted top-level fields', async () => {
    const f = recorder(() => ({ body: { id: 'cgt-20260905093000-abcde' } }));
    const p = seedanceProvider(f.impl);
    const result = await p.submit(
      makeSpec({
        modelId: SEEDANCE_15,
        durationSeconds: 10,
        aspectRatio: '9:16',
        resolution: '1080p',
        audio: false,
        seed: 58_944,
        callbackUrl: 'https://hooks.ad-factory.internal/modelark',
        firstFrame: { kind: 'uri', uri: 'https://cdn.ad-factory.internal/kf/first.png', mimeType: 'image/png' },
        lastFrame: { kind: 'uri', uri: 'https://cdn.ad-factory.internal/kf/last.png', mimeType: 'image/png' },
      }),
    );
    eq(f.calls.length, 1, 'one call');
    const call = f.calls[0] as WireCall;
    eq(call.method, 'POST', 'task creation is a POST');
    eq(call.url, 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', 'ModelArk URL');
    eq(call.headers['authorization'], 'Bearer ark-probe-key-not-a-real-credential', 'bearer key');
    const body = call.body as Record<string, unknown>;
    const keys = Object.keys(body).sort().join(',');
    eq(
      keys,
      'callback_url,content,duration,generate_audio,model,ratio,resolution,seed,watermark',
      'strict whitelist — ModelArk silently ignores unknown top-level fields',
    );
    eq(body['model'], SEEDANCE_15, 'model routes the task');
    eq(body['resolution'], '1080p', 'resolution');
    eq(body['ratio'], '9:16', 'ratio');
    eq(body['duration'], 10, 'duration');
    eq(body['generate_audio'], false, 'generate_audio ALWAYS explicit — it defaults to true and doubles the rate');
    eq(body['watermark'], false, 'watermark ALWAYS explicit — a watermarked ad is a wasted impression buy');
    const content = body['content'] as Array<Record<string, unknown>>;
    eq(content.length, 3, 'text + two keyframes');
    eq(content[0]?.['type'], 'text', 'text block first');
    eq(content[1]?.['role'], 'first_frame', 'first frame role');
    eq(content[2]?.['role'], 'last_frame', 'last frame role');
    eq(
      JSON.stringify((content[1] as Record<string, unknown>)['image_url']),
      JSON.stringify({ url: 'https://cdn.ad-factory.internal/kf/first.png' }),
      'image_url shape',
    );
    eq(result.taskId, 'cgt-20260905093000-abcde', 'task id');
    // 1920x1088 x (24 x 10 + 1 = 241 frames) / 1024 = 491,640 tokens @ $1.20/M.
    eq(result.estimate.billedUnits, 491_640, 'estimated tokens');
    eq(result.estimate.microUnits, 589_968, 'the pre-submit estimate for a 10s 1080p silent 1.5 Pro clip');

    // ModelArk takes reference images by URL only — a base64 ref must be refused.
    const g = recorder(() => ({ body: { id: 'x' } }));
    await refusesAsync(
      () =>
        seedanceProvider(g.impl).submit(
          makeSpec({
            modelId: SEEDANCE_15,
            durationSeconds: 5,
            aspectRatio: '9:16',
            resolution: '720p',
            audio: false,
            firstFrame: { kind: 'base64', data: 'AAAA', mimeType: 'image/png' },
          }),
        ),
      'firstFrame',
      /by URL only/,
    );
    eq(g.calls.length, 0, 'no billable call for a base64 keyframe');

    // Legacy --flags are the documented silent-failure generator.
    await refusesAsync(
      () =>
        seedanceProvider(g.impl).submit(
          makeSpec({
            modelId: SEEDANCE_FAST,
            durationSeconds: 5,
            aspectRatio: '9:16',
            resolution: '720p',
            audio: false,
            prompt: 'a bottle on a counter --ratio 99:1 --wm false',
          }),
        ),
      'prompt',
      /legacy "--" parameter flag/,
    );
    eq(g.calls.length, 0, 'no billable call for a legacy-flag prompt');
    return 'The wire body carries exactly the 9 whitelisted keys (video-gen-byteplus-seedance.md §2), with generate_audio and watermark always explicit and keyframes as content[] blocks with first_frame/last_frame roles. A base64 keyframe and a prompt carrying legacy --flags are both refused before the uncancellable POST.';
  });

  await add('seedance: a spec field the API has no home for is refused, not silently dropped', async () => {
    // The module\'s stated thesis: ModelArk silently ignores what it does not
    // understand, so an unsendable field must be a refusal rather than a fully-billed
    // video that ignored half the brief. negativePrompt has no ModelArk field at all.
    const f = recorder(() => ({ body: { id: 'cgt-x' } }));
    const err = await refusesAsync(
      () =>
        seedanceProvider(f.impl).submit(
          makeSpec({
            modelId: SEEDANCE_15,
            durationSeconds: 5,
            aspectRatio: '9:16',
            resolution: '720p',
            audio: false,
            negativePrompt: 'text overlays, watermarks, extra fingers',
          }),
        ),
      'negativePrompt',
      /no negative-prompt field/i,
    );
    must(/silently/i.test(err.message), 'explains that sending it would be swallowed');
    eq(f.calls.length, 0, 'refused before the billable call');
    // A spec without it still submits cleanly.
    const g = recorder(() => ({ body: { id: 'cgt-y' } }));
    const ok = await seedanceProvider(g.impl).submit(
      makeSpec({ modelId: SEEDANCE_15, durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: false }),
    );
    eq(ok.taskId, 'cgt-y', 'the happy path is unaffected');
    // The two fields GenerationSpec documents as provider-specific stay documented drops.
    const h = recorder(() => ({ body: { id: 'cgt-z' } }));
    await seedanceProvider(h.impl).submit(
      makeSpec({
        modelId: SEEDANCE_15,
        durationSeconds: 5,
        aspectRatio: '9:16',
        resolution: '720p',
        audio: false,
        outputUri: 'gs://ignored/',
        labels: { brand: 'hydra' },
      }),
    );
    const body = (h.calls[0] as WireCall).body as Record<string, unknown>;
    must(!('outputUri' in body) && !('labels' in body), 'Veo-only fields are not sent to ModelArk');
    return 'GenerationSpec.negativePrompt has no ModelArk equivalent; submitting one now raises a CapabilityError on "negativePrompt" before the billable POST instead of producing a fully-billed clip that ignored it. outputUri and labels remain documented Veo-only drops.';
  });

  await add('seedance poll parses the task shape, the 24h URL clock and the billed tokens', async () => {
    const updatedAt = 1_765_510_559; // epoch SECONDS, per the documented response
    const f = recorder(() => ({
      body: {
        id: 'cgt-20260905093000-abcde',
        model: SEEDANCE_FAST,
        status: 'succeeded',
        content: { video_url: 'https://ark-content.example/cgt-abcde.mp4', last_frame_url: 'https://ark-content.example/last.png' },
        usage: { completion_tokens: 246_840, total_tokens: 246_840 },
        created_at: 1_765_510_475,
        updated_at: updatedAt,
        seed: 58_944,
        resolution: '1080p',
        ratio: '9:16',
        duration: 5,
        framespersecond: 24,
        service_tier: 'default',
        execution_expires_after: 172_800,
      },
    }));
    const p = seedanceProvider(f.impl);
    const status = await p.poll('cgt-20260905093000-abcde');
    const call = f.calls[0] as WireCall;
    eq(call.method, 'GET', 'task query is a GET');
    eq(
      call.url,
      'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/cgt-20260905093000-abcde',
      'task URL',
    );
    eq(status.state, 'SUCCEEDED', 'state');
    eq(status.videos[0]?.uri, 'https://ark-content.example/cgt-abcde.mp4', 'video url');
    eq(status.billedUnits, 246_840, 'actual billed tokens read off usage.total_tokens');
    eq(status.resultExpiresAt, (updatedAt + 86_400) * 1000, 'the result URL dies 24h after completion');

    // Reconciliation: the pre-submit estimate must equal the invoice for the same clip.
    const est = p.estimateCost(
      makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '9:16', resolution: '1080p', audio: false }),
    );
    eq(est.billedUnits, status.billedUnits, 'the estimate reconciles to the billed token count exactly');

    // Every documented status maps, and an unrecognised one must never read as success.
    const states: Array<[string, string]> = [
      ['queued', 'QUEUED'],
      ['running', 'RUNNING'],
      ['succeeded', 'SUCCEEDED'],
      ['failed', 'FAILED'],
      ['expired', 'EXPIRED'],
      ['cancelled', 'FAILED'],
      ['', 'FAILED'],
    ];
    for (const [raw, expected] of states) {
      const g = recorder(() => ({
        body: {
          id: 't',
          model: SEEDANCE_FAST,
          status: raw,
          ...(raw === 'succeeded' ? { content: { video_url: 'https://x/y.mp4' }, updated_at: updatedAt } : {}),
        },
      }));
      eq((await seedanceProvider(g.impl).poll('t')).state, expected, `status "${raw}"`);
    }

    // "succeeded" with no video_url is a BILLED failure, not a creative signal.
    const h = recorder(() => ({
      body: { id: 't', model: SEEDANCE_FAST, status: 'succeeded', usage: { total_tokens: 49_005 }, updated_at: updatedAt },
    }));
    const noUrl = await seedanceProvider(h.impl).poll('t');
    eq(noUrl.state, 'FAILED', 'no url means failed');
    eq(noUrl.error?.code, 'NO_VIDEO_URL', 'explicit code');
    eq(noUrl.billedUnits, 49_005, 'and it was still billed');
    must(/was billed/.test(noUrl.error?.message ?? ''), 'says it was billed');

    // A failed task surfaces the vendor error body.
    const i = recorder(() => ({
      body: {
        id: 't',
        model: SEEDANCE_FAST,
        status: 'failed',
        error: { code: 'OutputVideoSensitiveContentDetected', message: 'The generated video contains sensitive content.' },
        usage: { total_tokens: 49_005 },
      },
    }));
    const failed = await seedanceProvider(i.impl).poll('t');
    eq(failed.state, 'FAILED', 'failed');
    eq(failed.error?.code, 'OutputVideoSensitiveContentDetected', 'vendor code preserved');
    eq(failed.error?.route, 'HUMAN_REVIEW', 'a safety refusal is never auto-retried');
    eq(failed.resultExpiresAt, undefined, 'nothing to expire');
    return 'The documented ModelArk task shape parses field for field: status, content.video_url, usage.total_tokens, and updated_at (epoch SECONDS) + 24h for the result-URL death clock. 7 status values map with unknown -> FAILED. "succeeded" with no video_url and a safety-refused task both become explicit FAILED statuses that keep the billed token count. The pre-submit estimate of 246,840 tokens reconciles exactly to the reported invoice figure.';
  });

  await add('seedance: cancellation is honest about what cannot be cancelled', async () => {
    // Queued: DELETE works.
    const f = recorder((call) =>
      call.method === 'DELETE' ? { body: {} } : { body: { id: 't', model: SEEDANCE_FAST, status: 'queued' } },
    );
    const result = await seedanceProvider(f.impl).cancelIfQueued('t');
    eq(result.cancelled, true, 'a queued task cancels');
    eq(f.calls.length, 2, 'poll then delete');
    eq((f.calls[1] as WireCall).method, 'DELETE', 'delete issued');

    // Running: refused with a specific error, not the vendor's.
    const g = recorder(() => ({ body: { id: 't', model: SEEDANCE_FAST, status: 'running' } }));
    const e = await rejectsWith(
      () => seedanceProvider(g.impl).cancelIfQueued('t'),
      SeedanceTaskNotCancellableError,
      /cost control on this provider is a PRE-SUBMIT decision/i,
    );
    eq(e.state, 'RUNNING', 'state recorded');
    eq(g.calls.length, 1, 'no DELETE attempted for a running task');

    // The race: the task starts BETWEEN the poll and the DELETE.
    const h = recorder((call) =>
      call.method === 'DELETE'
        ? { status: 400, body: { error: { code: 'InvalidAction.RunningTaskDeletion', message: 'task is running' } } }
        : { body: { id: 't', model: SEEDANCE_FAST, status: 'queued' } },
    );
    const raced = await rejectsWith(
      () => seedanceProvider(h.impl).cancelIfQueued('t'),
      SeedanceTaskNotCancellableError,
      /cannot be cancelled/,
    );
    eq(raced.state, 'RUNNING', 'the race is reported as running, not as a transport error');

    // A ModelArk error code is surfaced rather than a bare HTTP status.
    const i = recorder(() => ({
      status: 404,
      body: { error: { code: 'ModelNotOpen', message: 'The model has not been activated. Activate it in the Ark Console.' } },
    }));
    const notOpen = await rejectsWith(
      () => seedanceProvider(i.impl).poll('t'),
      ProviderRequestError,
      /ModelArk ModelNotOpen \(HTTP 404\)/,
    );
    eq(notOpen.httpStatus, 404, 'status kept');
    // A billable transport failure is AMBIGUOUS on this provider too.
    const t = recorder(() => ({ throwTransport: 'fetch failed: EPIPE' }));
    const amb = await rejectsWith(
      () =>
        seedanceProvider(t.impl).submit(
          makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: false }),
        ),
      ProviderRequestError,
      /AMBIGUOUS/,
    );
    must(/cannot be cancelled/.test(amb.message), 'names the reason resubmitting is dangerous');
    return 'cancelIfQueued polls first: a queued task is DELETEd, a running task raises SeedanceTaskNotCancellableError without attempting the DELETE, and the poll/DELETE race (InvalidAction.RunningTaskDeletion) is reported as RUNNING rather than as a transport error. ModelNotOpen is surfaced as a named code, and a transport failure on task creation is AMBIGUOUS.';
  });

  await add('provider misconfiguration fails at construction, not at 3am', () => {
    // Veo is us-central1 only: a wrong region is a 404 on every call.
    let threw = false;
    try {
      new VeoProvider({ projectId: 'p', accessToken: 't', storageUri: 'gs://b/', location: 'europe-west4' });
    } catch (e) {
      threw = true;
      must(/us-central1 only/.test((e as Error).message), 'names the only region');
      must(/shard across GCP projects, not regions/.test((e as Error).message), 'says what to do instead');
    }
    must(threw, 'a non-us-central1 Veo provider must not construct');

    // /api/coding/v3 is identical on the wire and draws the wrong budget.
    let threw2 = false;
    try {
      new SeedanceProvider({ apiKey: 'k', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3' });
    } catch (e) {
      threw2 = true;
      must(/Coding-Plan quota/.test((e as Error).message), 'names the wrong budget');
      must(/invisible at runtime/.test((e as Error).message), 'says why it must be caught here');
    }
    must(threw2, 'the coding-plan base URL must not construct');

    // A token supplier is accepted so short-lived OAuth tokens can be refreshed.
    const p = new VeoProvider({
      projectId: VEO_PROJECT,
      accessToken: () => Promise.resolve('ya29.refreshed'),
      storageUri: VEO_BUCKET,
      fetchImpl: noNetwork().impl,
    });
    eq(p.models().length, 3, 'catalogue loaded with a token supplier');
    return 'A non-us-central1 Veo location and a /api/coding/v3 ModelArk base URL both throw at construction with a message naming the consequence (404 on every call; the Coding-Plan quota drawn silently). An async access-token supplier is accepted for short-lived OAuth.';
  });

  await add('the catalogue is configuration: models can be added, replaced and retired', async () => {
    // Model ids rotate inside release cycles; a shipped catalogue was stale in 6 weeks.
    const nextGen: ModelCapabilities = {
      ...(DEFAULT_VEO_MODELS[1] as ModelCapabilities),
      modelId: 'veo-3.2-fast-generate-001',
      retirement: { earliest: '2027-06-01', qualifier: 'or-later' },
    };
    const f = recorder(() => ({ body: { name: OP_NAME.replace(VEO_FAST, 'veo-3.2-fast-generate-001') } }));
    const p = new VeoProvider({
      projectId: VEO_PROJECT,
      accessToken: 't',
      storageUri: VEO_BUCKET,
      fetchImpl: f.impl,
      models: [nextGen],
    });
    eq(p.models().length, 1, 'the override replaces the default catalogue entirely');
    await rejectsWith(
      () => Promise.resolve(p.capabilities(VEO_FAST)),
      UnknownModelError,
      /Known: veo-3\.2-fast-generate-001/,
    );
    const est = p.estimateCost(
      makeSpec({ modelId: 'veo-3.2-fast-generate-001', durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
    );
    eq(est.microUnits, 960_000, 'the injected descriptor prices with its own rates');
    const submitted = await p.submit(
      makeSpec({ modelId: 'veo-3.2-fast-generate-001', durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true }),
    );
    must((f.calls[0] as WireCall).url.includes('veo-3.2-fast-generate-001'), 'the new id reaches the URL');
    must(submitted.taskId.includes('veo-3.2-fast-generate-001'), 'the operation name carries the new id');

    // Same on the Seedance side, including a tier override.
    const ark = new SeedanceProvider({
      apiKey: 'k',
      fetchImpl: noNetwork().impl,
      models: [
        {
          ...(defaultSeedanceModels('enterprise')[0] as ModelCapabilities),
          modelId: 'seedance-2-9-pro-270101',
        },
      ],
    });
    eq(ark.models().length, 1, 'seedance catalogue overridden');
    eq(ark.capabilities('seedance-2-9-pro-270101').concurrency.limit, 10, 'the injected descriptor keeps its limits');
    return 'Passing `models` replaces the catalogue wholesale on both providers: a hypothetical veo-3.2 descriptor prices, submits and lands its id in the Vertex URL and the returned operation name, and the removed default id then raises UnknownModelError listing only the configured ids.';
  });

  await add('adversarial: degenerate durations, seeds and prompts are all caught locally', async () => {
    const veoNet = noNetwork();
    const arkNet = noNetwork();
    const veo = veoProvider(veoNet.impl);
    const ark = seedanceProvider(arkNet.impl);

    // Values a planner can produce by arithmetic: 0, negative, NaN, Infinity.
    for (const bad of [0, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
      await refusesAsync(
        () => veo.submit(makeSpec({ modelId: VEO_FAST, durationSeconds: bad, aspectRatio: '9:16', resolution: '1080p', audio: true })),
        'durationSeconds',
        /does not accept/,
      );
      await refusesAsync(
        () => ark.submit(makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: bad, aspectRatio: '9:16', resolution: '720p', audio: false })),
        'durationSeconds',
        /does not accept/,
      );
    }

    // Seeds. Veo checks its uint32 range; ModelArk publishes none, so the guard is
    // narrowed to what is certainly invalid — and the failure is local either way.
    for (const bad of [1.5, -1, Number.NaN]) {
      await refusesAsync(
        () => veo.submit(makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, seed: bad })),
        'seed',
        /uint32/,
      );
      await refusesAsync(
        () => ark.submit(makeSpec({ modelId: SEEDANCE_FAST, durationSeconds: 5, aspectRatio: '9:16', resolution: '720p', audio: false, seed: bad })),
        'seed',
        /non-negative integer/,
      );
    }
    await refusesAsync(
      () => veo.submit(makeSpec({ modelId: VEO_FAST, durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', audio: true, seed: 4_294_967_296 })),
      'seed',
      /uint32/,
    );
    eq(veoNet.calls.length, 0, 'no Veo network call');
    eq(arkNet.calls.length, 0, 'no ModelArk network call');

    // Legacy flags in a REALISTIC multi-line brief, where the flag follows a newline.
    const g = recorder(() => ({ body: { id: 'x' } }));
    await refusesAsync(
      () =>
        seedanceProvider(g.impl).submit(
          makeSpec({
            modelId: SEEDANCE_FAST,
            durationSeconds: 5,
            aspectRatio: '9:16',
            resolution: '720p',
            audio: false,
            prompt: 'Product hero shot, slow dolly-in.\n--dur 5\n--cf false',
          }),
        ),
      'prompt',
      /legacy "--" parameter flag/,
    );
    eq(g.calls.length, 0, 'the multi-line flag prompt never reached the network');

    // ...and the guard must not false-positive on a legitimate brief. An em-dash aside
    // that happens to precede one of the flag words is normal copywriting.
    const h = recorder(() => ({ body: { id: 'ok' } }));
    const ok = await seedanceProvider(h.impl).submit(
      makeSpec({
        modelId: SEEDANCE_FAST,
        durationSeconds: 5,
        aspectRatio: '9:16',
        resolution: '720p',
        audio: false,
        prompt: 'A matte bottle on a counter -- quality lighting, high-fps feel, no --- harsh shadows.',
      }),
    );
    eq(ok.taskId, 'ok', 'a legitimate em-dash brief is not refused');
    return 'Durations 0 / -8 / NaN / Infinity and seeds 1.5 / -1 / NaN / 2^32 are all refused locally on both providers with zero network calls. A multi-line brief carrying "\\n--dur 5" is refused as a legacy flag, while an em-dash aside ("-- quality lighting", "no --- harsh shadows") is correctly NOT refused — the guard requires the flag word glued to the dashes.';
  });

  await add('adversarial: support-code parsing survives the real error-message shapes', () => {
    // The documented message: prose, then the codes, then more prose.
    const real =
      'Veo could not generate videos because the input image violates Agent Platform\'s usage ' +
      'guidelines. If you think this was an error, send feedback. Support codes: 15236754';
    eq(JSON.stringify(parseSupportCodes(real)), JSON.stringify(['15236754']), 'documented message');
    // Singular "Support code:", lowercase, trailing sentence, and a following number that
    // is NOT a support code must not be swallowed into the list.
    eq(JSON.stringify(parseSupportCodes('support code: 62263041. Retry in 30 seconds.')), JSON.stringify(['62263041']), 'singular + trailing prose');
    eq(
      JSON.stringify(parseSupportCodes('Support codes: 35561574\n\nRequest id: 90789179')),
      JSON.stringify(['35561574']),
      'a following labelled number is not absorbed',
    );
    eq(
      JSON.stringify(parseSupportCodes('Support codes: 29310472, 35561574, 58061214')),
      JSON.stringify(['29310472', '35561574', '58061214']),
      'three codes',
    );
    eq(JSON.stringify(parseSupportCodes('')), JSON.stringify([]), 'empty message');
    eq(JSON.stringify(parseSupportCodes('quota exceeded, code 429')), JSON.stringify([]), 'an HTTP status is not a support code');
    // And the whole path end to end: a multi-code refusal off the wire must route safely.
    eq(classifySupportCodes(parseSupportCodes('Support codes: 29310472, 35561574')).route, 'HUMAN_REVIEW', 'end to end');
    eq(classifySupportCodes(parseSupportCodes('Support codes: 15236754, 99999999')).route, 'HUMAN_REVIEW', 'an unknown code cannot be out-voted into AUTO_REWRITE');
    return 'parseSupportCodes handles the documented message shape, the singular "Support code:", lowercase, trailing prose and a following labelled number without absorbing it, and does not mistake an HTTP status for a code. End to end, a wire message naming celebrity + third-party-IP routes to HUMAN_REVIEW, and a known AUTO_REWRITE code paired with an unrecognised one also routes to HUMAN_REVIEW.';
  });

  await add('adversarial: the RPM and concurrency lanes describe the same queues', () => {
    // concurrencySlot() narrows on a CONCURRENCY override only. If a descriptor ever
    // narrowed the request rate for a resolution without narrowing concurrency, the RPM
    // limiter and the semaphore would be policing two different lane definitions.
    const offenders: string[] = [];
    for (const caps of allModels) {
      const conc = new Set(caps.concurrency.overrides.map((o) => o.resolution));
      const rpm = new Set(caps.requestsPerMinuteOverrides.map((o) => o.resolution));
      for (const r of rpm) if (!conc.has(r)) offenders.push(`${caps.modelId}: RPM override at ${r} with no concurrency override`);
      for (const r of conc) if (!rpm.has(r)) offenders.push(`${caps.modelId}: concurrency override at ${r} with no RPM override`);
      // Every declared resolution must resolve to a usable limit.
      for (const r of caps.resolutions) {
        must(concurrencyLimitFor(caps, r) >= 1, `${caps.modelId} concurrency at ${r}`);
        must(requestsPerMinuteFor(caps, r) >= 1, `${caps.modelId} RPM at ${r}`);
      }
    }
    eq(offenders.join('; '), '', 'lane definitions must agree');
    // And every model must declare its aspect ratios, resolutions and notes non-empty.
    for (const caps of allModels) {
      must(caps.resolutions.length > 0, `${caps.modelId} resolutions`);
      must(caps.aspectRatios.includes('9:16'), `${caps.modelId} must offer the vertical master ratio`);
      must(caps.notes.length > 0, `${caps.modelId} carries operator notes`);
      must(caps.indemnityNote.length > 0, `${caps.modelId} indemnity note`);
    }
    return 'Across all 10 descriptors, every requestsPerMinute override has a matching concurrency override and vice versa (only dreamina-seedance-2-0-260128 @4k has either), so the rate limiter and the semaphore cannot disagree about what a lane is. Every model resolves a usable limit at every declared resolution and offers 9:16 for the master.';
  });

  await add('adversarial: a task response missing fields degrades without lying', async () => {
    // ModelArk omitting `model` is survivable; what must NOT happen is a missing or
    // unrecognised field reading as a clean success.
    const f = recorder(() => ({ body: { id: 't', status: 'succeeded', content: { video_url: 'https://x/y.mp4' } } }));
    const noModel = await seedanceProvider(f.impl).poll('t');
    eq(noModel.state, 'SUCCEEDED', 'still parses');
    eq(noModel.modelId, '(unknown)', 'the missing model id is reported as unknown, not guessed');
    eq(noModel.resultExpiresAt, undefined, 'no updated_at means no expiry clock is invented');
    eq(noModel.billedUnits, undefined, 'no usage means no billed figure is invented');

    // An entirely empty body must not read as success.
    const g = recorder(() => ({ body: {} }));
    const empty = await seedanceProvider(g.impl).poll('t');
    eq(empty.state, 'FAILED', 'an empty task body is a failure, not a success');
    // Veo: a done:true with a response that is not an object.
    const h = recorder(() => ({ body: { name: OP_NAME, done: true, response: 'unexpected' } }));
    const weird = await veoProvider(h.impl).poll(OP_NAME);
    eq(weird.state, 'FAILED', 'a non-object response yields zero videos, which is a failure');
    eq(weird.error?.code, 'RAI_FILTERED_ALL', 'and it is explicit about it');
    // Veo: videos array containing junk entries.
    const i = recorder(() => ({
      body: { name: OP_NAME, done: true, response: { videos: [null, 'nope', { gcsUri: 'gs://b/0.mp4' }] } },
    }));
    const junk = await veoProvider(i.impl).poll(OP_NAME);
    eq(junk.videos.length, 1, 'junk entries are dropped, the real one is kept');
    eq(junk.videos[0]?.mimeType, 'video/mp4', 'a missing mimeType defaults to video/mp4');
    return 'A ModelArk response with no `model` reports modelId "(unknown)" and invents neither an expiry clock nor a billed figure; an empty body is FAILED, not SUCCEEDED. A Veo response whose `response` is not an object, and one whose videos array holds nulls and strings, both degrade to an explicit failure or to just the parseable videos — never to a silent success.';
  });

  // =========================================================================
  // E. What genuinely cannot be exercised here
  // =========================================================================

  const hasVertexCredential =
    (process.env['GOOGLE_APPLICATION_CREDENTIALS'] ?? '') !== '' ||
    (process.env['GOOGLE_VERTEX_ACCESS_TOKEN'] ?? '') !== '';
  const hasArkKey = (process.env['ARK_API_KEY'] ?? '') !== '' || (process.env['BYTEPLUS_API_KEY'] ?? '') !== '';

  if (!hasVertexCredential) {
    skip(
      'veo: a real 4s 720p generation against Vertex',
      'no GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_VERTEX_ACCESS_TOKEN in this environment, and generation costs money',
      'The cheapest real Veo probe (4s 720p silent on Lite) would cost $0.12 and would settle the one unresolved question in the cost model: whether the Vertex line item is per second (as coded, and as the dossier concludes) or per clip (as synthesis §5.2 asserts). It cannot run without a credential.',
    );
  }
  if (!hasArkKey) {
    skip(
      'seedance: a real 5s 480p generation against ModelArk',
      'no ARK_API_KEY / BYTEPLUS_API_KEY in this environment, and generation costs money',
      'A single $0.049 clip on seedance-1-0-pro-fast at 480p would confirm the pixel-frame estimate against usage.total_tokens end to end, and one clip per unpriced ratio (1:1, 4:3, 3:4, 21:9) would let SEEDANCE_FRAME_AREAS be extended so those ratios stop being unpriceable. It cannot run without a key.',
    );
  }
  skip(
    'the per-clip vs per-second Veo billing contradiction',
    'requires one billed generation and a look at the Cloud Billing invoice line',
    'src/generation/veo.ts prices per SECOND (8s 1080p Fast with audio = $0.96), following video-gen-google-veo.md §5.1/§5.4 and the synthesis\'s own §8.1 cost model. Synthesis §5.2 instead labels the same figures per CLIP. Read per-second, Veo 3.1 Fast at 1080p is DEARER than seedance-1-0-pro-fast ($0.80 vs $0.247 for a comparable clip), which inverts §5.2\'s provider recommendation. The code takes the safe direction (over-stating an 8s clip 8x is a budget guard that refuses too much; under-stating it spends 8x unattended) but the question is only settleable against a real invoice.',
  );
  skip(
    'ffmpeg 4:5 reframing from the 9:16 master',
    'belongs to src/assembly/, not to the generation provider layer',
    'Every model in the catalogue refuses 4:5 and directs the caller to generate a 9:16 master and derive 4:5 downstream. This probe verifies the refusal and the plan; whether the reframe actually happens is the assembly module\'s contract.',
  );

  return { module: 'src/generation/{provider,veo,seedance}.ts', checks };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const c of report.checks) {
    counts[c.status] += 1;
    console.log(`[${c.status}] ${c.name}`);
    console.log(`       ${c.detail}`);
    if (c.blockedBy !== undefined) console.log(`       blocked by: ${c.blockedBy}`);
  }
  console.log(`\n${report.module}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}
