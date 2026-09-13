import {
  assertSpecSupported, CapabilityError, ProviderRequestError, UnknownModelError,
  type CostEstimate, type GenerationSpec, type ImageRef, type ModelCapabilities,
  type SubmitResult, type TaskStatus, type VideoProvider,
} from './provider.ts';

export const H3_USD_PER_SECOND = 0.08;
export const H3_PRICING_SOURCE = 'https://platform.minimax.io/docs/guides/pricing-paygo';
const origin = 'https://api.minimax.io';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** H3 v2 contract verified 2026-09-13. No automatic paid submission retries. */
export class MiniMaxProvider implements VideoProvider {
  readonly id = 'minimax';
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly usdPerSecond: number;
  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; usdPerSecond?: number }) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.usdPerSecond = options.usdPerSecond ?? H3_USD_PER_SECOND;
    if (!Number.isFinite(this.usdPerSecond) || this.usdPerSecond <= 0 || this.usdPerSecond > 100)
      throw new Error('A valid MiniMax H3 USD price per second is required.');
  }
  models(): readonly ModelCapabilities[] {
    return [{
      providerId: this.id, modelId: 'MiniMax-H3',
      durations: { kind: 'integerRange', minSeconds: 4, maxSeconds: 15 },
      resolutions: ['768p'], aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
      fps: undefined, audio: 'always', keyframes: 'first-and-last', maxSamplesPerRequest: 1,
      concurrency: { limit: 1, source: 'operational', overrides: [] },
      requestsPerMinute: 6, requestsPerMinuteOverrides: [],
      indemnified: false, indemnityNote: 'No indemnity assumption is used by this integration.',
      retirement: { earliest: undefined, qualifier: 'unannounced' },
      cancellableWhileRunning: false, resultUrlTtlSeconds: undefined, regions: [],
      billing: { unit: 'seconds-of-output', rates: [{ resolution: '768p', usdPerSecondWithAudio: this.usdPerSecond, usdPerSecondSilent: undefined }] },
      notes: ['768P is the configured production tier. H3 v2 offers no audio-off parameter; assembly replaces source audio with narration.',
        'The first five input images are free; additional images cost $0.04 each. Input video is not submitted by this adapter.',
        'Concurrency and RPM values are conservative application limits, not advertised account quotas. Query completed tasks within seven days.'],
    }];
  }
  capabilities(modelId: string): ModelCapabilities {
    const model = this.models().find(m => m.modelId === modelId);
    if (!model) throw new UnknownModelError(this.id, modelId, this.models().map(m => m.modelId));
    return model;
  }
  estimateCost(spec: GenerationSpec): CostEstimate {
    assertSpecSupported(this.capabilities(spec.modelId), spec);
    const fail = (field: string, message: string): never => { throw new CapabilityError(this.id, spec.modelId, field, message); };
    if (!spec.prompt.trim() || Array.from(spec.prompt).length > 7000) fail('prompt', 'H3 needs a non-empty prompt of at most 7,000 characters.');
    if (spec.referenceImages && spec.referenceImages.length > 9) fail('referenceImages', 'H3 accepts at most nine reference images.');
    if (spec.referenceImages?.length && (spec.firstFrame || spec.lastFrame)) fail('referenceImages', 'H3 cannot mix reference images with first or last frames.');
    if ((spec.firstFrame || spec.lastFrame) && spec.aspectRatio !== 'adaptive') fail('aspectRatio', 'H3 keyframes determine the output ratio. Use reference images for a fixed 9:16 composition.');
    if (!spec.firstFrame && !spec.lastFrame && !spec.referenceImages?.length && spec.aspectRatio === 'adaptive') fail('aspectRatio', 'H3 text-to-video requires an explicit aspect ratio.');
    if (spec.seed !== undefined || spec.negativePrompt !== undefined || spec.callbackUrl !== undefined || spec.outputUri !== undefined || spec.labels !== undefined)
      fail('options', 'This H3 adapter supports polling and rejects unsupported request options.');
    const images = [...(spec.referenceImages ?? []), ...(spec.firstFrame ? [spec.firstFrame] : []), ...(spec.lastFrame ? [spec.lastFrame] : [])];
    for (const ref of images) {
      if (ref.kind === 'uri') {
        let url: URL; try { url = new URL(ref.uri); } catch { fail('image', 'H3 images need public HTTPS URLs.'); }
        if (url!.protocol !== 'https:' || url!.username || url!.password) fail('image', 'H3 images need HTTPS URLs without credentials.');
      } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ref.data) || Buffer.byteLength(ref.data, 'base64') > 30 * 1024 * 1024) fail('image', 'H3 image data is invalid or exceeds 30 MB.');
    }
    const extraImages = Math.max(0, images.length - 5);
    const microUnits = Math.ceil(spec.durationSeconds * this.usdPerSecond * 1e6 + extraImages * 40000);
    return { providerId: this.id, modelId: spec.modelId, currency: 'USD', microUnits, minorUnits: Math.ceil(microUnits / 10000),
      billingUnit: 'seconds-of-output', billedUnits: spec.durationSeconds, usdPerUnit: this.usdPerSecond, samples: 1, exact: true,
      basis: `${spec.durationSeconds} output seconds × $${this.usdPerSecond}/second at 768P + ${extraImages} extra images × $0.04. First five images free.` };
  }
  async submit(spec: GenerationSpec): Promise<SubmitResult> {
    const estimate = this.estimateCost(spec);
    if (!this.apiKey) throw new Error('Save a MiniMax pay-as-you-go API key in Connections.');
    const content: Record<string, unknown>[] = [{ type: 'text', text: spec.prompt }];
    const add = (ref: ImageRef, role: string) => content.push({ type: 'image_url', role, image_url: { url: ref.kind === 'uri' ? ref.uri : `data:${ref.mimeType};base64,${ref.data}` } });
    if (spec.firstFrame) add(spec.firstFrame, 'first_frame');
    if (spec.lastFrame) add(spec.lastFrame, 'last_frame');
    for (const ref of spec.referenceImages ?? []) add(ref, 'reference_image');
    const { data, requestId } = await this.request('/v2/video_generation', { method: 'POST', body: JSON.stringify({ model: spec.modelId, content, duration: spec.durationSeconds, resolution: '768P', ratio: spec.aspectRatio }) });
    if (typeof data['task_id'] !== 'string' || !/^[\w-]{1,200}$/.test(data['task_id'])) throw new Error('H3 submission has no valid task ID. Reconcile its outcome before resubmitting.');
    return { providerId: this.id, modelId: spec.modelId, taskId: data['task_id'], submittedAt: Date.now(), estimate, requestId };
  }
  async poll(taskId: string): Promise<TaskStatus> {
    if (!/^[\w-]{1,200}$/.test(taskId)) throw new Error('Invalid H3 task ID.');
    const { data } = await this.request(`/v2/query/video_generation/${encodeURIComponent(taskId)}`, { method: 'GET' });
    const task = record(data['task']), usage = record(task['usage']);
    if (task['id'] !== taskId || task['model'] !== 'MiniMax-H3' || (task['task_type'] !== undefined && task['task_type'] !== 'generation')) throw new Error('H3 returned a mismatched task.');
    const states = { queued: 'QUEUED', running: 'RUNNING', succeeded: 'SUCCEEDED', failed: 'FAILED', cancelled: 'FAILED' } as const;
    const state = states[String(task['status']) as keyof typeof states];
    if (!state) throw new Error('H3 returned an unknown task status.');
    if (state === 'SUCCEEDED' && task['resolution'] !== '768P') throw new Error('H3 returned a different resolution tier. Reconcile its price before accepting the receipt.');
    const uri = record(task['content'])['url'];
    const validUri = typeof uri === 'string' && uri.startsWith('https://');
    const units = usage['output_seconds'];
    return { providerId: this.id, modelId: 'MiniMax-H3', taskId, state,
      videos: state === 'SUCCEEDED' && validUri ? [{ uri, base64: undefined, mimeType: 'video/mp4' }] : [],
      filteredCount: 0, filteredReasons: [], partial: state === 'SUCCEEDED' && !validUri,
      error: state === 'FAILED' ? { code: String(record(task['error'])['code'] ?? task['status']).slice(0, 100), message: `MiniMax H3 task ${String(task['status'])}. Check the provider task receipt.`, category: 'provider', route: 'HUMAN_REVIEW', supportCodes: [] } : undefined,
      billedUnits: typeof units === 'number' && Number.isFinite(units) && units >= 0 ? units : undefined,
      usage, resultExpiresAt: undefined,
    };
  }
  private async request(path: string, init: RequestInit) {
    const response = await this.fetchImpl(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' } });
    const raw = await response.text();
    if (raw.length > 1000000) throw new Error('H3 response exceeded the size limit.');
    if (!response.ok) throw new ProviderRequestError(this.id, response.status, raw, `MiniMax H3 returned HTTP ${response.status}.`);
    const data = record(JSON.parse(raw));
    if (data['type'] === 'error' || data['error']) throw new Error('H3 returned an error without a definitive HTTP outcome. Reconcile the task history.');
    return { data, requestId: response.headers.get('x-request-id') ?? (typeof data['request_id'] === 'string' ? data['request_id'].slice(0, 200) : '') };
  }
}
