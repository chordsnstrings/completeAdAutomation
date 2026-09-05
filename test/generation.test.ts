import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelSemaphore,
  CapabilityError,
  UnknownModelError,
  assertIndemnified,
  concurrencyLimitFor,
  concurrencySlot,
  planAspectRatio,
  requestsPerMinuteFor,
  retirementRisk,
  supportsDuration,
  ProviderRequestError,
  type GenerationSpec,
  type ImageRef,
  type ModelCapabilities,
} from '../src/generation/provider.ts';

import {
  VeoProvider,
  DEFAULT_VEO_MODELS,
  classifySupportCodes,
  parseSupportCodes,
} from '../src/generation/veo.ts';

import {
  SeedanceProvider,
  SeedanceTaskNotCancellableError,
  defaultSeedanceModels,
  pixelFrameTokens,
  selectTokenRate,
  SEEDANCE_FRAME_AREAS,
} from '../src/generation/seedance.ts';

// ---------------------------------------------------------------------------
// Fakes. Nothing in this file may touch the network.
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function recordingFetch(
  responder: (call: Call) => { status?: number; body: unknown },
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const rawBody = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** assert.throws returns void, so these two helpers hand the error back for inspection. */
function thrown<T extends Error>(fn: () => unknown, ctor: new (...a: never[]) => T): T {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ctor, `expected ${ctor.name}, got ${String(e)}`);
    return e;
  }
  assert.fail(`expected ${ctor.name} to be thrown`);
}

async function rejected<T extends Error>(
  p: Promise<unknown>,
  ctor: new (...a: never[]) => T,
): Promise<T> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ctor, `expected ${ctor.name}, got ${String(e)}`);
    return e;
  }
  assert.fail(`expected ${ctor.name} to be rejected with`);
}

const explodingFetch = (async () => {
  throw new Error('a test made a real network call');
}) as unknown as typeof fetch;

function veo(fetchImpl: typeof fetch = explodingFetch): VeoProvider {
  return new VeoProvider({
    projectId: 'proj-1',
    accessToken: 'token-abc',
    storageUri: 'gs://creative-out/',
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
}

function seedance(
  fetchImpl: typeof fetch = explodingFetch,
  tier: 'individual' | 'enterprise' = 'individual',
): SeedanceProvider {
  return new SeedanceProvider({
    apiKey: 'ark-key',
    fetchImpl,
    accountTier: tier,
    now: () => 1_700_000_000_000,
  });
}

const VEO_FAST = 'veo-3.1-fast-generate-001';
const SD_FAST = 'seedance-1-0-pro-fast-251015';
const DREAMINA_20 = 'dreamina-seedance-2-0-260128';

function spec(over: Partial<GenerationSpec> & Pick<GenerationSpec, 'modelId'>): GenerationSpec {
  return {
    prompt: 'slow push-in on the bottle, studio light',
    durationSeconds: 8,
    aspectRatio: '9:16',
    resolution: '1080p',
    audio: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Cost estimation — Veo bills per second of output
// ---------------------------------------------------------------------------

test('veo: 8s 1080p 9:16 with audio on Fast costs $0.96', () => {
  const e = veo().estimateCost(spec({ modelId: VEO_FAST }));
  assert.equal(e.billingUnit, 'seconds-of-output');
  assert.equal(e.microUnits, 960_000);
  assert.equal(e.minorUnits, 96);
  assert.equal(e.billedUnits, 8);
  assert.equal(e.exact, true);
  assert.match(e.basis, /\$0\.12\/s/);
});

test('veo: audio-off is the real cost lever, not a rounding difference', () => {
  const withAudio = veo().estimateCost(spec({ modelId: VEO_FAST, audio: true }));
  const silent = veo().estimateCost(spec({ modelId: VEO_FAST, audio: false }));
  assert.equal(silent.microUnits, 800_000); // 8s x $0.10/s
  assert.equal(withAudio.microUnits - silent.microUnits, 160_000);

  // On the quality tier the same toggle halves the bill outright.
  const q = (audio: boolean) =>
    veo().estimateCost(spec({ modelId: 'veo-3.1-generate-001', audio })).microUnits;
  assert.equal(q(true), 3_200_000);
  assert.equal(q(false), 1_600_000);
  assert.equal(q(false) * 2, q(true));
});

test('veo: cost scales with duration AND sampleCount', () => {
  const one = veo().estimateCost(spec({ modelId: VEO_FAST }));
  const four = veo().estimateCost(spec({ modelId: VEO_FAST, samples: 4 }));
  assert.equal(four.microUnits, one.microUnits * 4);
  assert.equal(four.billedUnits, 32);
  assert.equal(four.samples, 4);

  const short = veo().estimateCost(spec({ modelId: VEO_FAST, durationSeconds: 4 }));
  assert.equal(short.microUnits, 480_000);
});

test('veo: the Lite tier is the cheap exploration lane', () => {
  const lite = veo().estimateCost(
    spec({ modelId: 'veo-3.1-lite-generate-001', resolution: '720p' }),
  );
  assert.equal(lite.microUnits, 400_000); // 8 x $0.05/s
});

// ---------------------------------------------------------------------------
// Cost estimation — Seedance bills per pixel-frame token
// ---------------------------------------------------------------------------

test('seedance: the token formula reproduces the real billed generation exactly', () => {
  // 864x480, 5s at 24fps = 121 frames -> the invoice said 49,005 tokens.
  assert.equal(pixelFrameTokens(864 * 480, 5), 49_005);
  // The vendor's documented estimate omits the +1 frame and under-counts.
  assert.equal((864 * 480 * 24 * 5) / 1024, 48_600);
  assert.equal(pixelFrameTokens(SEEDANCE_FRAME_AREAS['720p'].areaPx, 5), 108_900);
  assert.equal(pixelFrameTokens(SEEDANCE_FRAME_AREAS['1080p'].areaPx, 5), 246_840);
});

test('seedance: 5s 9:16 clip prices match the published per-clip table', () => {
  const p = seedance();
  const at = (modelId: string, resolution: '480p' | '720p' | '1080p', audio: boolean) =>
    p.estimateCost(
      spec({ modelId, resolution, audio, durationSeconds: 5, aspectRatio: '9:16' }),
    );

  assert.equal(at(SD_FAST, '480p', false).microUnits, 49_005); // $0.049
  assert.equal(at(SD_FAST, '1080p', false).microUnits, 246_840); // $0.247
  assert.equal(at('seedance-1-5-pro-251215', '1080p', false).microUnits, 296_208); // $0.296
  assert.equal(at('seedance-1-5-pro-251215', '1080p', true).microUnits, 592_416); // $0.592
  assert.equal(at(DREAMINA_20, '1080p', false).microUnits, 1_900_668); // $1.901
  assert.equal(at('dreamina-seedance-2-5-260628', '1080p', false).microUnits, 2_888_028); // $2.888
});

test('seedance: audio doubles the 1.5 Pro rate, which is why the field is never defaulted', () => {
  const p = seedance();
  const s = (audio: boolean) =>
    p.estimateCost(
      spec({ modelId: 'seedance-1-5-pro-251215', durationSeconds: 5, audio }),
    ).microUnits;
  assert.equal(s(true), s(false) * 2);
});

test('seedance: cost scales with duration and quadratically with resolution', () => {
  const p = seedance();
  const five = p.estimateCost(spec({ modelId: SD_FAST, durationSeconds: 5, audio: false }));
  const ten = p.estimateCost(spec({ modelId: SD_FAST, durationSeconds: 10, audio: false }));
  assert.ok(ten.microUnits > five.microUnits * 1.9);

  const at720 = p.estimateCost(
    spec({ modelId: SD_FAST, resolution: '720p', durationSeconds: 5, audio: false }),
  );
  const at480 = p.estimateCost(
    spec({ modelId: SD_FAST, resolution: '480p', durationSeconds: 5, audio: false }),
  );
  // 720p carries 2.22x the pixels of 480p and therefore 2.22x the tokens.
  assert.equal(at720.microUnits / at480.microUnits, (1280 * 720) / (864 * 480));
});

test('the two billing models cannot share a formula: same clip, different shape of answer', () => {
  const v = (d: number) =>
    veo().estimateCost(spec({ modelId: VEO_FAST, durationSeconds: d, audio: false }));
  const s = (d: number) =>
    seedance().estimateCost(spec({ modelId: SD_FAST, durationSeconds: d, audio: false }));

  assert.equal(v(8).billingUnit, 'seconds-of-output');
  assert.equal(v(8).billedUnits, 8);
  assert.equal(s(8).billingUnit, 'pixel-frame-tokens');
  assert.equal(s(8).billedUnits, pixelFrameTokens(1920 * 1088, 8));

  // Veo is exactly linear in duration: half the seconds, half the money.
  assert.equal(v(4).microUnits * 2, v(8).microUnits);
  // Seedance is linear in FRAMES, and the billed frame count is 24d + 1 — so halving the
  // duration does not halve the bill. One formula cannot express both.
  assert.notEqual(s(4).microUnits * 2, s(8).microUnits);
  assert.equal(s(4).microUnits * 2 - s(8).microUnits, 2040); // exactly one extra frame

  // ⚠ Under the per-second Vertex rates encoded here, the cheapest Seedance 1080p model is
  // CHEAPER per clip than Veo 3.1 Fast at every duration — the opposite of the ranking in
  // synthesis §5.2, which reached "Veo is ~2.5x cheaper" by comparing Veo's $/second figure
  // against Seedance's $/clip figure. The provider recommendation rests on that unit
  // question, so it is asserted here rather than left as prose.
  assert.ok(s(8).microUnits < v(8).microUnits);
  assert.equal(v(8).microUnits, 800_000); // 8s x $0.10/s
  assert.equal(s(8).microUnits, 393_720); // 393,720 tokens x $1.00/M
});

test('seedance: refuses to price a ratio whose frame size was never measured', () => {
  // 1:1 IS a native Seedance ratio, so the capability gate passes — but the price is a
  // function of width x height and those dimensions are unverified, so pricing refuses.
  const err = thrown(
    () => seedance().estimateCost(spec({ modelId: SD_FAST, aspectRatio: '1:1', audio: false })),
    CapabilityError,
  );
  assert.equal(err.field, 'aspectRatio');
  assert.match(err.message, /UNVERIFIED/);
  assert.match(err.message, /usage\.total_tokens/);
});

test('seedance: an inferred frame area is flagged inexact rather than silently trusted', () => {
  const e = seedance().estimateCost(
    spec({ modelId: DREAMINA_20, resolution: '4k', durationSeconds: 5, audio: false }),
  );
  assert.equal(e.exact, false);
  assert.match(e.basis, /INEXACT/);
});

test('selectTokenRate: first matching row wins, specific before general', () => {
  const rates = seedance().capabilities(DREAMINA_20).billing;
  assert.equal(rates.unit, 'pixel-frame-tokens');
  if (rates.unit !== 'pixel-frame-tokens') return;
  assert.equal(selectTokenRate(rates.rates, '1080p', false, false)?.usdPerMillionTokens, 7.7);
  assert.equal(selectTokenRate(rates.rates, '4k', false, false)?.usdPerMillionTokens, 4.0);
  assert.equal(selectTokenRate(rates.rates, '720p', false, false)?.usdPerMillionTokens, 7.0);
  // 4K is cheaper per token than 1080p but carries ~4x the tokens.
  assert.ok(
    (selectTokenRate(rates.rates, '4k', false, false)?.usdPerMillionTokens ?? 0) <
      (selectTokenRate(rates.rates, '1080p', false, false)?.usdPerMillionTokens ?? 0),
  );
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

test('4:5 is refused by BOTH providers with an actionable message', () => {
  for (const [p, modelId] of [
    [veo(), VEO_FAST],
    [seedance(), SD_FAST],
  ] as const) {
    const err = thrown(
      () => p.estimateCost(spec({ modelId, aspectRatio: '4:5', audio: false })),
    CapabilityError,
  );
    assert.equal(err.field, 'aspectRatio');
    assert.match(err.message, /4:5/);
    assert.match(err.message, /reframing stage|ffmpeg/);
    assert.match(err.message, /planAspectRatio/);
  }
});

test('planAspectRatio makes the reframe requirement checkable before anything is paid for', () => {
  const caps = veo().capabilities(VEO_FAST);
  const native = planAspectRatio(caps, '9:16');
  assert.equal(native.kind, 'native');

  const plan = planAspectRatio(caps, '4:5');
  assert.equal(plan.kind, 'reframe');
  if (plan.kind !== 'reframe') return;
  assert.equal(plan.generateAt, '9:16'); // 9:16 master, never a 16:9 one
  assert.equal(plan.deliverAt, '4:5');
  assert.match(plan.reason, /NO video model/);

  // Seedance does produce 1:1 natively, which removes one reframe step but not 4:5.
  const sd = seedance().capabilities(SD_FAST);
  assert.equal(planAspectRatio(sd, '1:1').kind, 'native');
  assert.equal(planAspectRatio(sd, '4:5').kind, 'reframe');
});

test('veo duration is a discrete set, seedance a contiguous integer range', () => {
  const v = veo().capabilities(VEO_FAST);
  assert.equal(supportsDuration(v, 6), true);
  assert.equal(supportsDuration(v, 5), false);
  const err = thrown(
    () => veo().estimateCost(spec({ modelId: VEO_FAST, durationSeconds: 5 })),
    CapabilityError,
  );
  assert.equal(err.field, 'durationSeconds');
  assert.match(err.message, /4, 6, 8 seconds only/);
  assert.match(err.message, /multi-shot/);

  const s = seedance().capabilities(SD_FAST);
  // 7, 9, 11 all validate — the "only 3/5/10" belief is wrong.
  for (const d of [2, 7, 9, 11, 12]) assert.equal(supportsDuration(s, d), true, `${d}s`);
  assert.equal(supportsDuration(s, 13), false);
  assert.equal(supportsDuration(seedance().capabilities('seedance-1-5-pro-251215'), 3), false);
});

test('the cheap Dreamina 2.0 tiers cannot serve Meta\'s 1080x1920 vertical spec', () => {
  const err = thrown(
    () =>
      seedance().estimateCost(
        spec({ modelId: 'dreamina-seedance-2-0-fast-260128', durationSeconds: 5, audio: false }),
      ),
    CapabilityError,
  );
  assert.equal(err.field, 'resolution');
  assert.match(err.message, /1080x1920/);
});

test('asking a silent model for audio fails loudly instead of returning a mute video', () => {
  const err = thrown(
    () => seedance().estimateCost(spec({ modelId: SD_FAST, durationSeconds: 5, audio: true })),
    CapabilityError,
  );
  assert.equal(err.field, 'audio');
  assert.match(err.message, /no audio track/);
});

test('sampleCount is capped at 4 on Veo and 1 on Seedance', () => {
  assert.equal(
    thrown(() => veo().estimateCost(spec({ modelId: VEO_FAST, samples: 5 })), CapabilityError).field,
    'samples',
  );
  assert.equal(
    thrown(
      () => seedance().estimateCost(spec({ modelId: SD_FAST, audio: false, samples: 2 })),
      CapabilityError,
    ).field,
    'samples',
  );
});

test('an unknown model id is an error naming the known ids, not a default', () => {
  const err = thrown(() => veo().capabilities('veo-4.0-generate-001'), UnknownModelError);
  assert.match(err.message, /veo-3\.1-fast-generate-001/);
  assert.match(err.message, /CONFIGURATION/);
});

// ---------------------------------------------------------------------------
// Per-model semaphore
// ---------------------------------------------------------------------------

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('concurrency limits come from the descriptor, per model and per account tier', () => {
  const individual = seedance(explodingFetch, 'individual');
  const enterprise = seedance(explodingFetch, 'enterprise');

  // Seedance 1.x: 10, with no account-type split at all.
  assert.equal(concurrencyLimitFor(individual.capabilities(SD_FAST), '1080p'), 10);
  assert.equal(concurrencyLimitFor(enterprise.capabilities(SD_FAST), '1080p'), 10);

  // Dreamina 2.x: 3 for an individual account, 10 for enterprise.
  assert.equal(concurrencyLimitFor(individual.capabilities(DREAMINA_20), '1080p'), 3);
  assert.equal(concurrencyLimitFor(enterprise.capabilities(DREAMINA_20), '1080p'), 10);

  // 4K is 1 on BOTH tiers — the tightest limit in the surface.
  assert.equal(concurrencyLimitFor(individual.capabilities(DREAMINA_20), '4k'), 1);
  assert.equal(concurrencyLimitFor(enterprise.capabilities(DREAMINA_20), '4k'), 1);

  // Veo publishes a request rate, not a concurrency cap; the descriptor says so.
  const v = veo().capabilities(VEO_FAST);
  assert.equal(v.concurrency.source, 'derived-from-rpm');
  assert.equal(v.requestsPerMinute, 50);
});

test('4K gets its own semaphore slot, so it cannot borrow the 1080p allowance', () => {
  const caps = seedance().capabilities(DREAMINA_20);
  assert.equal(concurrencySlot(caps, '4k'), 'seedance:dreamina-seedance-2-0-260128@4k');
  assert.equal(concurrencySlot(caps, '1080p'), 'seedance:dreamina-seedance-2-0-260128');
});

test('semaphore serialises at the per-model limit and hands slots straight over', async () => {
  const sem = new ModelSemaphore();
  const caps = seedance().capabilities(DREAMINA_20);
  const slot = concurrencySlot(caps, '4k');

  const first = await sem.acquire(caps, '4k');
  assert.equal(sem.inFlight(slot), 1);

  let secondAcquired = false;
  const second = sem.acquire(caps, '4k').then((r) => {
    secondAcquired = true;
    return r;
  });
  await tick();
  assert.equal(secondAcquired, false, '4K concurrency is 1; the second task must wait');
  assert.equal(sem.queueDepth(slot), 1);

  first();
  const release2 = await second;
  assert.equal(secondAcquired, true);
  assert.equal(sem.inFlight(slot), 1, 'the slot was handed over, not double-counted');

  // Releasing twice must not widen the limit.
  release2();
  release2();
  assert.equal(sem.inFlight(slot), 0);
});

test('semaphore slots are independent across models and across the 4K boundary', async () => {
  const sem = new ModelSemaphore();
  const p = seedance();
  const dreamina = p.capabilities(DREAMINA_20);
  const fast = p.capabilities(SD_FAST);

  const held4k = await sem.acquire(dreamina, '4k');
  // Same model at 1080p is a different queue with a limit of 3.
  const a = await sem.acquire(dreamina, '1080p');
  const b = await sem.acquire(dreamina, '1080p');
  const c = await sem.acquire(dreamina, '1080p');
  assert.equal(sem.inFlight(concurrencySlot(dreamina, '1080p')), 3);

  let fourth = false;
  void sem.acquire(dreamina, '1080p').then(() => {
    fourth = true;
  });
  await tick();
  assert.equal(fourth, false);

  // A completely different model is untouched by any of that.
  const others = await Promise.all(
    Array.from({ length: 10 }, () => sem.acquire(fast, '1080p')),
  );
  assert.equal(sem.inFlight(concurrencySlot(fast, '1080p')), 10);

  held4k();
  a();
  await tick();
  assert.equal(fourth, true, 'releasing a 1080p slot admits the queued 1080p task');
  b();
  c();
  for (const r of others) r();
});

test('ModelSemaphore.run releases the slot even when the work throws', async () => {
  const sem = new ModelSemaphore();
  const caps = seedance().capabilities(DREAMINA_20);
  const slot = concurrencySlot(caps, '4k');
  await assert.rejects(
    sem.run(caps, '4k', async () => {
      throw new Error('generation failed');
    }),
    /generation failed/,
  );
  assert.equal(sem.inFlight(slot), 0);
});

// ---------------------------------------------------------------------------
// Veo transport
// ---------------------------------------------------------------------------

const OP_NAME =
  'projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op-1';

test('veo submit posts predictLongRunning with the explicit money-relevant parameters', async () => {
  const f = recordingFetch(() => ({ body: { name: OP_NAME } }));
  const res = await veo(f.impl).submit(
    spec({ modelId: VEO_FAST, audio: false, samples: 4, seed: 42, labels: { brand: 'acme' } }),
  );

  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.equal(
    call.url,
    'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1' +
      '/publishers/google/models/veo-3.1-fast-generate-001:predictLongRunning',
  );

  const body = call.body as { instances: unknown[]; parameters: Record<string, unknown>; labels: unknown };
  assert.equal(body.parameters['storageUri'], 'gs://creative-out/');
  assert.equal(body.parameters['generateAudio'], false, 'the audio-off price lever must be explicit');
  assert.equal(body.parameters['enhancePrompt'], false, 'prompt rewriting breaks seed-pinned A/B');
  assert.equal(body.parameters['aspectRatio'], '9:16');
  assert.equal(body.parameters['durationSeconds'], 8);
  assert.equal(body.parameters['sampleCount'], 4);
  assert.equal(body.parameters['personGeneration'], 'allow_adult');
  assert.equal(body.parameters['seed'], 42);
  assert.deepEqual(body.labels, { brand: 'acme' });

  assert.equal(res.taskId, OP_NAME);
  assert.equal(res.estimate.microUnits, 3_200_000); // 4 x 8s x $0.10/s
});

test('veo submit refuses a non-gs:// sink, which would return the MP4 base64-inline', async () => {
  const f = recordingFetch(() => ({ body: {} }));
  await assert.rejects(
    veo(f.impl).submit(spec({ modelId: VEO_FAST, outputUri: 'https://example.com/out' })),
    (e: unknown) => e instanceof CapabilityError && e.field === 'outputUri',
  );
  assert.equal(f.calls.length, 0, 'the refusal must happen before the network call');
});

test('veo poll uses POST fetchPredictOperation with the operation name in the body', async () => {
  const f = recordingFetch(() => ({
    body: {
      name: OP_NAME,
      done: true,
      response: {
        raiMediaFilteredCount: 0,
        videos: [{ gcsUri: 'gs://creative-out/sample_0.mp4', mimeType: 'video/mp4' }],
      },
    },
  }));
  const status = await veo(f.impl).poll(OP_NAME);
  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.match(call.url, /:fetchPredictOperation$/);
  assert.deepEqual(call.body, { operationName: OP_NAME });

  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(status.modelId, VEO_FAST);
  assert.equal(status.videos[0]?.uri, 'gs://creative-out/sample_0.mp4');
  assert.equal(status.partial, false);
});

test('veo poll reports an unfinished operation as RUNNING, not as failure', async () => {
  const f = recordingFetch(() => ({ body: { name: OP_NAME, done: false } }));
  const status = await veo(f.impl).poll(OP_NAME);
  assert.equal(status.state, 'RUNNING');
  assert.equal(status.videos.length, 0);
});

test('veo poll surfaces silent under-delivery as partial rather than clean success', async () => {
  const f = recordingFetch(() => ({
    body: {
      name: OP_NAME,
      done: true,
      response: {
        raiMediaFilteredCount: 2,
        raiMediaFilteredReasons: ['safety'],
        videos: [
          { gcsUri: 'gs://o/0.mp4', mimeType: 'video/mp4' },
          { gcsUri: 'gs://o/1.mp4', mimeType: 'video/mp4' },
        ],
      },
    },
  }));
  const status = await veo(f.impl).poll(OP_NAME);
  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(status.partial, true, 'done:true with fewer videos is the dominant Veo failure');
  assert.equal(status.filteredCount, 2);
  assert.deepEqual(status.filteredReasons, ['safety']);
});

test('veo poll turns a fully-filtered success into an explicit failure', async () => {
  const f = recordingFetch(() => ({
    body: {
      name: OP_NAME,
      done: true,
      response: { raiMediaFilteredCount: 4, raiMediaFilteredReasons: ['unsafe'], videos: [] },
    },
  }));
  const status = await veo(f.impl).poll(OP_NAME);
  assert.equal(status.state, 'FAILED');
  assert.equal(status.error?.code, 'RAI_FILTERED_ALL');
  assert.match(status.error?.message ?? '', /never respond by relaxing the safety filter/i);
});

test('veo safety support codes route: celebrity rewrites, third-party IP goes to a human', () => {
  assert.deepEqual(parseSupportCodes('… Support codes: 15236754'), ['15236754']);
  assert.deepEqual(parseSupportCodes('Support codes: 35561574, 29310472'), ['35561574', '29310472']);
  assert.deepEqual(parseSupportCodes('no codes here'), []);

  assert.deepEqual(classifySupportCodes(['15236754']), {
    category: 'CELEBRITY',
    route: 'AUTO_REWRITE',
  });
  assert.deepEqual(classifySupportCodes(['35561575']), {
    category: 'THIRD_PARTY_CONTENT',
    route: 'HUMAN_REVIEW',
  });
  // An unrecognised code must never be auto-retried.
  assert.equal(classifySupportCodes(['99999999']).route, 'HUMAN_REVIEW');
});

test('veo poll classifies an errored operation from its support code', async () => {
  const f = recordingFetch(() => ({
    body: {
      name: OP_NAME,
      error: {
        code: 400,
        message: 'Veo could not generate videos because the input image violates … Support codes: 35561574',
      },
    },
  }));
  const status = await veo(f.impl).poll(OP_NAME);
  assert.equal(status.state, 'FAILED');
  assert.equal(status.error?.category, 'THIRD_PARTY_CONTENT');
  assert.equal(status.error?.route, 'HUMAN_REVIEW');
  assert.deepEqual(status.error?.supportCodes, ['35561574']);
});

test('veo poll rejects a task id that is not a Vertex operation name', async () => {
  await assert.rejects(
    veo().poll('op-1'),
    (e: unknown) => e instanceof CapabilityError && e.field === 'taskId',
  );
  await assert.rejects(
    veo().poll(OP_NAME.replace('proj-1', 'someone-elses-project')),
    /project-scoped/,
  );
});

test('veo refuses any region but us-central1', () => {
  assert.throws(
    () =>
      new VeoProvider({
        projectId: 'p',
        accessToken: 't',
        storageUri: 'gs://b/',
        location: 'europe-west4',
        fetchImpl: explodingFetch,
      }),
    /us-central1 only/,
  );
});

// ---------------------------------------------------------------------------
// Seedance transport
// ---------------------------------------------------------------------------

test('seedance submit sends only whitelisted top-level fields, watermark and audio explicit', async () => {
  const f = recordingFetch(() => ({ body: { id: 'cgt-1' } }));
  const res = await seedance(f.impl).submit(
    spec({ modelId: SD_FAST, audio: false, durationSeconds: 5, seed: 11, callbackUrl: 'https://cb' }),
  );

  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks');

  const body = call.body as Record<string, unknown>;
  // Unknown top-level fields are silently ignored by the API, so the whitelist is the
  // only thing that catches a typo — assert on the exact key set.
  assert.deepEqual(
    Object.keys(body).sort(),
    ['callback_url', 'content', 'duration', 'generate_audio', 'model', 'ratio', 'resolution', 'seed', 'watermark'],
  );
  assert.equal(body['watermark'], false);
  assert.equal(body['generate_audio'], false);
  assert.equal(body['ratio'], '9:16');
  assert.equal(body['duration'], 5);
  assert.equal(res.taskId, 'cgt-1');
  assert.equal(res.estimate.microUnits, 246_840);
});

test('seedance submit refuses legacy --flags, which the API bills but does not validate', async () => {
  const f = recordingFetch(() => ({ body: { id: 'cgt-1' } }));
  await assert.rejects(
    seedance(f.impl).submit(
      spec({ modelId: SD_FAST, audio: false, durationSeconds: 5, prompt: 'a bottle --ratio 99:1' }),
    ),
    (e: unknown) => e instanceof CapabilityError && e.field === 'prompt',
  );
  assert.equal(f.calls.length, 0);
});

test('seedance poll returns the video and the 24h URL expiry', async () => {
  const updatedAt = 1_765_510_559;
  const f = recordingFetch(() => ({
    body: {
      id: 'cgt-1',
      model: SD_FAST,
      status: 'succeeded',
      content: { video_url: 'https://ark/out.mp4' },
      usage: { completion_tokens: 246_840, total_tokens: 246_840 },
      updated_at: updatedAt,
    },
  }));
  const status = await seedance(f.impl).poll('cgt-1');
  assert.equal(f.calls[0]?.method, 'GET');
  assert.equal(status.state, 'SUCCEEDED');
  assert.equal(status.videos[0]?.uri, 'https://ark/out.mp4');
  assert.equal(status.billedUnits, 246_840, 'reconcile the real bill against the estimate');
  assert.equal(status.resultExpiresAt, (updatedAt + 86_400) * 1000);
});

test('seedance poll maps the task states and never reads an unknown one as success', async () => {
  const make = (status: string) =>
    seedance(
      recordingFetch(() => ({ body: { id: 'cgt-1', model: SD_FAST, status } })).impl,
    ).poll('cgt-1');
  assert.equal((await make('queued')).state, 'QUEUED');
  assert.equal((await make('running')).state, 'RUNNING');
  assert.equal((await make('expired')).state, 'EXPIRED');
  assert.equal((await make('failed')).state, 'FAILED');
  assert.equal((await make('something-new')).state, 'FAILED');
});

test('seedance poll treats succeeded-without-a-url as a billed failure', async () => {
  const f = recordingFetch(() => ({
    body: { id: 'cgt-1', model: SD_FAST, status: 'succeeded', usage: { total_tokens: 49_005 } },
  }));
  const status = await seedance(f.impl).poll('cgt-1');
  assert.equal(status.state, 'FAILED');
  assert.equal(status.error?.code, 'NO_VIDEO_URL');
  assert.equal(status.billedUnits, 49_005);
});

test('seedance cancels a queued task and refuses to pretend it can cancel a running one', async () => {
  const queued = recordingFetch((c) =>
    c.method === 'DELETE'
      ? { body: {} }
      : { body: { id: 'cgt-1', model: SD_FAST, status: 'queued' } },
  );
  assert.deepEqual(await seedance(queued.impl).cancelIfQueued('cgt-1'), { cancelled: true });
  assert.deepEqual(queued.calls.map((c) => c.method), ['GET', 'DELETE']);

  const running = recordingFetch(() => ({ body: { id: 'cgt-1', model: SD_FAST, status: 'running' } }));
  const err = await rejected(
    seedance(running.impl).cancelIfQueued('cgt-1'),
    SeedanceTaskNotCancellableError,
  );
  assert.match(err.message, /PRE-SUBMIT/);
  assert.equal(running.calls.length, 1, 'no DELETE may be attempted on a running task');
  assert.equal(seedance().capabilities(SD_FAST).cancellableWhileRunning, false);
});

test('seedance refuses a base URL that bills the wrong budget', () => {
  assert.throws(
    () =>
      new SeedanceProvider({
        apiKey: 'k',
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
        fetchImpl: explodingFetch,
      }),
    /Coding-Plan quota/,
  );
});

test('seedance surfaces a ModelArk error code rather than a bare HTTP status', async () => {
  const f = recordingFetch(() => ({
    status: 400,
    body: {
      error: {
        code: 'ModelNotOpen',
        message: 'Your account has not activated the model dreamina-seedance-2-5-260628.',
      },
    },
  }));
  await assert.rejects(
    seedance(f.impl).submit(
      spec({ modelId: 'dreamina-seedance-2-5-260628', durationSeconds: 5, audio: false }),
    ),
    /ModelNotOpen/,
  );
});

// ---------------------------------------------------------------------------
// Policy-relevant descriptor facts
// ---------------------------------------------------------------------------

test('indemnity: only the GA Vertex Veo models qualify, and nothing on BytePlus does', () => {
  const p = veo();
  assert.equal(p.capabilities('veo-3.1-generate-001').indemnified, true);
  assert.equal(p.capabilities(VEO_FAST).indemnified, true);
  assert.equal(p.capabilities('veo-3.1-lite-generate-001').indemnified, false);

  for (const caps of seedance().models()) {
    assert.equal(caps.indemnified, false, caps.modelId);
    assert.match(caps.indemnityNote, /no clause/i);
  }

  assert.throws(
    () => assertIndemnified(p.capabilities('veo-3.1-lite-generate-001')),
    (e: unknown) => e instanceof CapabilityError && e.field === 'indemnified',
  );
  assert.doesNotThrow(() => assertIndemnified(p.capabilities(VEO_FAST)));

  // The flag is necessary, not sufficient: the paid-account half is invisible here.
  assert.match(p.capabilities(VEO_FAST).indemnityNote, /PAID account/);
});

test('retirement dates are floors ("or later"), not expiries', () => {
  const caps = veo().capabilities(VEO_FAST);
  assert.equal(caps.retirement.earliest, '2026-11-17');
  assert.equal(caps.retirement.qualifier, 'or-later');
  assert.equal(retirementRisk(caps, new Date('2026-01-01')), 'active');
  assert.equal(retirementRisk(caps, new Date('2026-10-01')), 'within-90-days');
  assert.equal(retirementRisk(caps, new Date('2026-12-01')), 'past-earliest');
  assert.equal(
    retirementRisk(veo().capabilities('veo-3.1-lite-generate-001'), new Date('2026-01-01')),
    'unannounced',
  );
});

test('every descriptor states the aspect-ratio, audio and result-lifetime facts a caller needs', () => {
  const all: readonly ModelCapabilities[] = [...DEFAULT_VEO_MODELS, ...defaultSeedanceModels()];
  for (const caps of all) {
    assert.equal(caps.aspectRatios.includes('4:5'), false, `${caps.modelId} must not claim 4:5`);
    assert.equal(caps.fps, 24, `${caps.modelId} fps`);
    assert.ok(caps.notes.length > 0, `${caps.modelId} notes`);
    assert.equal(caps.cancellableWhileRunning, false, `${caps.modelId} cancellable`);
  }
  // Veo writes to our own GCS bucket, so its artefacts do not expire; Seedance's do.
  assert.equal(veo().capabilities(VEO_FAST).resultUrlTtlSeconds, undefined);
  assert.equal(seedance().capabilities(SD_FAST).resultUrlTtlSeconds, 86_400);
});

// ---------------------------------------------------------------------------
// Keyframe conditioning — the gate that stops a silently-ignored last frame
// ---------------------------------------------------------------------------

const FRAME: ImageRef = {
  kind: 'uri',
  uri: 'https://cdn.example/frame.png',
  mimeType: 'image/png',
};

test('seedance refuses a last frame on the 1.0 line, where the API would silently bill it', async () => {
  const f = recordingFetch(() => ({ body: { id: 'cgt-1' } }));
  const p = seedance(f.impl);

  const err = thrown(
    () =>
      p.estimateCost(
        spec({ modelId: SD_FAST, audio: false, durationSeconds: 5, firstFrame: FRAME, lastFrame: FRAME }),
      ),
    CapabilityError,
  );
  assert.equal(err.field, 'lastFrame');
  assert.match(err.message, /silently ignores/);

  // And the refusal reaches submit before any money is spent.
  await assert.rejects(
    p.submit(spec({ modelId: SD_FAST, audio: false, durationSeconds: 5, lastFrame: FRAME })),
    (e: unknown) => e instanceof CapabilityError && e.field === 'lastFrame',
  );
  assert.equal(f.calls.length, 0, 'no billed task may be created for an unsupported keyframe');

  // First-frame-only is image-to-video and IS supported on this model.
  const ok = await p.submit(
    spec({ modelId: SD_FAST, audio: false, durationSeconds: 5, firstFrame: FRAME }),
  );
  assert.equal(ok.taskId, 'cgt-1');
  const content = (f.calls[0]?.body as { content: Array<Record<string, unknown>> }).content;
  assert.equal(content.length, 2);
  assert.equal(content[1]?.['role'], 'first_frame');
});

test('keyframe support is per model, taken from the docs rather than assumed uniform', () => {
  const p = seedance();
  assert.equal(p.capabilities(SD_FAST).keyframes, 'first');
  assert.equal(p.capabilities('seedance-1-0-pro-250528').keyframes, 'first');
  assert.equal(p.capabilities('seedance-1-5-pro-251215').keyframes, 'first-and-last');
  assert.equal(p.capabilities(DREAMINA_20).keyframes, 'first-and-last');
  // Veo documents first+last frame on every 3.1 variant.
  for (const caps of DEFAULT_VEO_MODELS) assert.equal(caps.keyframes, 'first-and-last', caps.modelId);

  // 1.5 Pro accepts what 1.0 Pro Fast refuses — same spec, different verdict.
  const s = spec({ modelId: 'seedance-1-5-pro-251215', audio: false, durationSeconds: 5, lastFrame: FRAME });
  assert.doesNotThrow(() => p.estimateCost(s));
});

// ---------------------------------------------------------------------------
// Probed-but-unportable facts must not be copied between models
// ---------------------------------------------------------------------------

test('undocumented aspect ratios stay on the model they were probed on', () => {
  const p = seedance();
  const ratios = (m: string) => p.capabilities(m).aspectRatios;

  // 3:2 was probed accepted on seedance-1-0-pro and REJECTED on dreamina 2.0.
  assert.equal(ratios('seedance-1-0-pro-250528').includes('3:2'), true);
  assert.equal(ratios(DREAMINA_20).includes('3:2'), false);
  // 1.91:1 is the mirror image of that.
  assert.equal(ratios(DREAMINA_20).includes('1.91:1'), true);
  assert.equal(ratios('seedance-1-0-pro-250528').includes('1.91:1'), false);

  // Models that were never probed for extras carry the documented set only — claiming a
  // ratio the model rejects turns a plan-time check into a runtime 400.
  for (const m of ['seedance-1-0-pro-fast-251015', 'dreamina-seedance-2-0-fast-260128', 'dreamina-seedance-2-0-mini-260615']) {
    assert.equal(ratios(m).includes('3:2'), false, m);
    assert.equal(ratios(m).includes('1.91:1'), false, m);
    assert.equal(ratios(m).includes('5:4'), false, m);
    assert.equal(ratios(m).includes('9:16'), true, m);
  }
});

test('the 4K lane has its own request rate as well as its own concurrency', () => {
  const caps = seedance().capabilities(DREAMINA_20);
  assert.equal(requestsPerMinuteFor(caps, '1080p'), 180); // individual account
  assert.equal(requestsPerMinuteFor(caps, '4k'), 15);
  assert.equal(requestsPerMinuteFor(seedance(explodingFetch, 'enterprise').capabilities(DREAMINA_20), '4k'), 15);
  // Veo has no per-resolution split.
  assert.equal(requestsPerMinuteFor(veo().capabilities(VEO_FAST), '4k'), 50);
});

// ---------------------------------------------------------------------------
// Ambiguous writes — the shape of a double charge
// ---------------------------------------------------------------------------

test('a transport failure while starting a generation is reported as AMBIGUOUS, not as a bare error', async () => {
  const boom = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  const v = await rejected(
    veo(boom).submit(spec({ modelId: VEO_FAST })),
    ProviderRequestError,
  );
  assert.equal(v.httpStatus, 0);
  assert.match(v.message, /AMBIGUOUS/);
  assert.match(v.message, /idempotency key/);
  assert.match(v.message, /do not blindly resubmit/i);

  const s = await rejected(
    seedance(boom).submit(spec({ modelId: SD_FAST, audio: false, durationSeconds: 5 })),
    ProviderRequestError,
  );
  assert.equal(s.httpStatus, 0);
  assert.match(s.message, /AMBIGUOUS/);
  assert.match(s.message, /cannot be cancelled/);

  // A poll is a read: it carries no billing ambiguity and must not claim any.
  const r = await rejected(veo(boom).poll(OP_NAME), ProviderRequestError);
  assert.doesNotMatch(r.message, /AMBIGUOUS/);
});

test('a task that starts between the poll and the DELETE is still reported as uncancellable', async () => {
  const f = recordingFetch((c) =>
    c.method === 'DELETE'
      ? {
          status: 400,
          body: {
            error: {
              code: 'InvalidAction.RunningTaskDeletion',
              message: 'Cannot delete task `cgt-1` because it is currently running.',
            },
          },
        }
      : { body: { id: 'cgt-1', model: SD_FAST, status: 'queued' } },
  );
  const err = await rejected(
    seedance(f.impl).cancelIfQueued('cgt-1'),
    SeedanceTaskNotCancellableError,
  );
  assert.equal(err.state, 'RUNNING');
  assert.match(err.message, /PRE-SUBMIT/);
});

test('veo refuses an out-of-range seed locally instead of buying a Vertex 400', async () => {
  const f = recordingFetch(() => ({ body: { name: OP_NAME } }));
  for (const seed of [-1, 1.5, 4_294_967_296]) {
    await assert.rejects(
      veo(f.impl).submit(spec({ modelId: VEO_FAST, seed })),
      (e: unknown) => e instanceof CapabilityError && e.field === 'seed',
    );
  }
  assert.equal(f.calls.length, 0);
  // 0 is a legal uint32 and must survive the guard rather than being treated as unset.
  await veo(f.impl).submit(spec({ modelId: VEO_FAST, seed: 0 }));
  assert.equal((f.calls[0]?.body as { parameters: Record<string, unknown> }).parameters['seed'], 0);
});
