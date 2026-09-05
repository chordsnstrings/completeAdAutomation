/**
 * CAPABILITY PROBE — src/meta/videoUpload.ts
 *
 * Not a unit test. The question is whether this module does its job end to end in THIS
 * environment: can it take a real rendered mp4 off the real ffmpeg at /usr/bin, walk
 * Meta's chunked `advideos` protocol over the real multipart wire format, survive a
 * mid-transfer crash, resume from a persisted offset, poll a real-shaped processing
 * status to readiness, and refuse a render that Meta would reject.
 *
 * HOW THE NETWORK IS FAKED
 * Nothing here touches Meta with a write (ABSOLUTE RULE: no POST to /advideos). The fake
 * is deliberately NOT a stub: every request is serialised through `new Response(formData)`
 * — the same undici path a real POST takes — and the resulting multipart BYTES are parsed
 * back out. So the probe proves the bytes Meta would receive, not the bytes we handed to
 * FormData. The fake server implements the protocol as the dossier documents it:
 *   start    -> { video_id, upload_session_id, start_offset: "0", end_offset: "N" }  (STRINGS)
 *   transfer -> { start_offset: "N", end_offset: "M" }, terminating on start == end
 *   finish   -> { success: true }
 *   error    -> { error: { code, message, error_data: { start_offset, end_offset } } }
 * and it is adversarial: it rejects a chunk whose byte length does not match the window,
 * rejects a window that does not start where it actually is, and re-dictates boundaries
 * through `error_data` exactly as the SDKs describe.
 *
 * Run:  node --experimental-strip-types src/verify/videoUpload.ts
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_VIDEO_TITLE_CHARS,
  RESUME_CHUNK_BYTES,
  VideoProcessingError,
  VideoUploader,
  bufferChunkSource,
  classifyVideoStatus,
  fileChunkSource,
  normaliseAdAccountPath,
  parseVideoStatus,
  resumeOffsetsFromError,
  selectPreferredThumbnail,
  validateAdVideoSpec,
  type ChunkSource,
  type UploadProgress,
  type VideoFileMetadata,
} from '../meta/videoUpload.ts';
import { MetaApiError } from '../meta/errors.ts';
// The render below must be the encode the pipeline actually recommends, not a hand copy
// of it. See GOOD_RENDER_ARGS. (The mp4 box walk further down stays independent on
// purpose — that one exists to disagree with the assembly module if the two ever drift.)
import { buildEncodeArgs } from '../assembly/ffmpeg.ts';

/* ------------------------------------------------------------------ contract ------- */

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  /** Set when the check could not run for an environmental reason, not a code fault. */
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

/* ------------------------------------------------------------------ tiny runner ---- */

class Blocked extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, message: string) {
    super(message);
    this.name = 'Blocked';
    this.blockedBy = blockedBy;
  }
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/* ------------------------------------------------------------------ ffmpeg ---------- */

const FFMPEG = '/usr/bin/ffmpeg';
const FFPROBE = '/usr/bin/ffprobe';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(bin: string, args: readonly string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const GOOD_CANVAS = { width: 720, height: 1280 } as const;
const GOOD_FPS = 30;

/**
 * The encode this pipeline is supposed to produce — taken from `buildEncodeArgs`, the
 * repo's OWN encode-argument builder, rather than transcribed by hand.
 *
 * That distinction is the whole point of this constant. This probe previously hand-rolled
 * an approximation of the pipeline encode (`-movflags +faststart`, no `-use_editlist 0`),
 * probed the result, watched `validateAdVideoSpec` reject it on `hasEditLists`, and
 * concluded the VALIDATOR was wrong — reporting that "ffmpeg 6.1.1's mp4 muxer writes an
 * edts/elst unconditionally and offers no flag that removes it". It does have such a flag,
 * `buildEncodeArgs` has always emitted it, and the hand-rolled copy here was the only
 * thing in the repo that did not. [MEASURED here, ffmpeg 6.1.1, same source and codecs]
 * `-movflags +faststart` alone -> elst present; adding `-use_editlist 0` -> elst absent.
 *
 * A probe that reimplements the thing it is verifying can only ever verify the
 * reimplementation, so it calls the builder. If `buildEncodeArgs` ever loses a flag, this
 * check fails — which is the behaviour that was wanted from it all along.
 */
const GOOD_RENDER_ARGS = (out: string): readonly string[] => [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `smptebars=size=${GOOD_CANVAS.width}x${GOOD_CANVAS.height}:rate=${GOOD_FPS}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4',
  ...buildEncodeArgs({}, { fps: GOOD_FPS, canvas: GOOD_CANVAS }),
  out,
];

/** Deliberately non-compliant: 2 s (under the 3 s floor), 12 fps (under 23), yuv444p, silent. */
const BAD_RENDER_ARGS = (out: string): readonly string[] => [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=12',
  '-t', '2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv444p', '-r', '12', '-an',
  out,
];

/* -------------------------------------------- real ffprobe -> VideoFileMetadata ----- */

interface Mp4Box {
  type: string;
  offset: number;
  size: number;
}

/** Top-level box walk. Independent of the assembly module so this probe stands alone. */
function topLevelBoxes(buf: Uint8Array): Mp4Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Mp4Box[] = [];
  let off = 0;
  while (off + 8 <= buf.byteLength && boxes.length < 32) {
    let size = view.getUint32(off);
    let header = 8;
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) {
      if (off + 16 > buf.byteLength) break;
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      boxes.push({ type, offset: off, size: buf.byteLength - off });
      break;
    }
    if (size < header) break;
    boxes.push({ type, offset: off, size });
    off += size;
  }
  return boxes;
}

/** `elst` inside the moov span only — scanning the whole file false-positives on mdat. */
function moovHasEditList(buf: Uint8Array, boxes: readonly Mp4Box[]): boolean | undefined {
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return undefined;
  const end = moov.offset + moov.size;
  if (end > buf.byteLength) return undefined;
  return Buffer.from(buf.subarray(moov.offset, end)).includes(Buffer.from('elst'));
}

function ratio(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const [a, b] = v.split(/[:/]/);
  const n = Number(a);
  const d = Number(b);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return NaN;
  return n / d;
}

function numOr(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

interface RealProbe {
  meta: VideoFileMetadata;
  raw: string;
  boxes: Mp4Box[];
}

/** The mapping a real caller has to write. Everything here comes off real ffprobe output. */
async function probeFile(path: string): Promise<RealProbe> {
  const r = await exec(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
  const parsed = JSON.parse(r.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const format = parsed.format ?? {};
  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  must(video, 'ffprobe found no video stream');

  const bytes = new Uint8Array(await readFile(path));
  const boxes = topLevelBoxes(bytes);
  const moovIdx = boxes.findIndex((b) => b.type === 'moov');
  const mdatIdx = boxes.findIndex((b) => b.type === 'mdat');

  const rFps = ratio(video['r_frame_rate']);
  const avgFps = ratio(video['avg_frame_rate']);
  const sar = video['sample_aspect_ratio'];

  const meta: VideoFileMetadata = {
    fileSizeBytes: numOr(format['size']) ?? bytes.byteLength,
    durationSeconds: numOr(format['duration']) ?? NaN,
    width: numOr(video['width']) ?? NaN,
    height: numOr(video['height']) ?? NaN,
    frameRate: rFps,
    videoCodec: String(video['codec_name'] ?? ''),
    ...(audio ? { audioCodec: String(audio['codec_name'] ?? '') } : {}),
    ...(numOr(video['bit_rate']) !== undefined ? { videoBitrateBps: numOr(video['bit_rate']) as number } : {}),
    ...(audio && numOr(audio['bit_rate']) !== undefined
      ? { audioBitrateBps: numOr(audio['bit_rate']) as number }
      : {}),
    ...(audio && numOr(audio['sample_rate']) !== undefined
      ? { audioSampleRateHz: numOr(audio['sample_rate']) as number }
      : {}),
    ...(audio && numOr(audio['channels']) !== undefined
      ? { audioChannels: numOr(audio['channels']) as number }
      : {}),
    ...(typeof format['format_name'] === 'string' ? { container: format['format_name'] } : {}),
    ...(typeof video['pix_fmt'] === 'string' ? { pixelFormat: video['pix_fmt'] } : {}),
    ...(moovIdx >= 0 && mdatIdx >= 0 ? { moovAtomAtFront: moovIdx < mdatIdx } : {}),
    ...(moovHasEditList(bytes, boxes) !== undefined
      ? { hasEditLists: moovHasEditList(bytes, boxes) as boolean }
      : {}),
    ...(Number.isFinite(rFps) && Number.isFinite(avgFps) ? { variableFrameRate: rFps !== avgFps } : {}),
    ...(typeof video['field_order'] === 'string'
      ? { interlaced: video['field_order'] !== 'progressive' }
      : {}),
    ...(typeof sar === 'string' && sar !== 'N/A' ? { pixelAspectRatio: ratio(sar) } : {}),
  };
  return { meta, raw: r.stdout, boxes };
}

/* ------------------------------------------------------------------ the wire -------- */

interface WirePart {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  bytes: Uint8Array;
  text: string;
}

/**
 * Parse a REAL multipart/form-data body. The module claims the chunk must be a file part
 * or "the bytes get mangled by charset handling" — the only way to check that claim is to
 * read the bytes back off the wire, not off the FormData object.
 */
function parseMultipart(body: Uint8Array, boundary: string): Map<string, WirePart> {
  const buf = Buffer.from(body);
  const delim = Buffer.from(`--${boundary}`);
  const out = new Map<string, WirePart>();
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const after = idx + delim.length;
    if (buf.subarray(after, after + 2).toString('latin1') === '--') break; // closing delimiter
    const headerStart = after + 2; // CRLF
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) throw new Error('malformed multipart: unterminated headers');
    const headers = buf.subarray(headerStart, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next === -1) throw new Error('malformed multipart: unterminated part');
    const partBytes = new Uint8Array(buf.subarray(bodyStart, next - 2)); // strip the CRLF before the delimiter
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1];
    if (name === undefined) throw new Error(`multipart part without a name: ${headers}`);
    out.set(name, {
      name,
      filename,
      contentType,
      bytes: partBytes,
      text: Buffer.from(partBytes).toString('utf8'),
    });
    idx = next;
  }
  return out;
}

interface WireRequest {
  method: string;
  url: URL;
  parts: Map<string, WirePart>;
  bodyBytes: number;
}

async function toWireRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Promise<WireRequest> {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = init?.method ?? 'GET';
  const body = init?.body;
  if (!(body instanceof FormData)) return { method, url, parts: new Map(), bodyBytes: 0 };
  // The real undici serialisation, boundary and all.
  const serialised = new Response(body);
  const ct = serialised.headers.get('content-type') ?? '';
  const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
  if (boundary === undefined) throw new Error(`FormData did not serialise to multipart: "${ct}"`);
  const raw = new Uint8Array(await serialised.arrayBuffer());
  return { method, url, parts: parseMultipart(raw, boundary), bodyBytes: raw.byteLength };
}

function part(req: WireRequest, name: string): string {
  const p = req.parts.get(name);
  must(p, `expected multipart field "${name}" on ${req.url.pathname}; got [${[...req.parts.keys()].join(', ')}]`);
  return p.text;
}

/* ------------------------------------------------------------------ fake Meta ------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function graphError(
  code: number,
  message: string,
  extra: Record<string, unknown> = {},
  status = 400,
): Response {
  return jsonResponse({ error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf', ...extra } }, status);
}

type Fault = (n: number, window: { start: number; end: number }) => Response | 'network' | undefined;

interface FakeOptions {
  size: number;
  /** Window size Meta dictates. Meta drives the boundaries; the client must follow. */
  window: (start: number) => number;
  skipUpload?: boolean;
  /** Reject a client-proposed window wider than `window(start)` with error_data offsets. */
  redictateWideWindows?: boolean;
  /** Buggy-Meta simulation: converge start==end at this offset without a success flag. */
  convergeAt?: number;
  /** Overshoot the file end on the final window, as Meta is documented to do. */
  overshootFinalWindow?: boolean;
  fault?: Fault;
  /** Raw body text returned by `finish`. Defaults to the documented `{"success":true}`. */
  finishBody?: string;
}

class FakeMeta {
  readonly opts: FakeOptions;
  readonly assembled: Buffer;
  readonly videoId = '23851234567890123';
  readonly sessionId = '19875678901234567';
  held = 0;
  starts = 0;
  finishes = 0;
  cancels = 0;
  transfers: Array<{ start: number; end: number; len: number; filename: string | undefined; contentType: string | undefined }> = [];
  /** Every transfer request that arrived, including the ones the server refused. */
  transferAttempts = 0;
  /** Only the windows the server actually consumed. */
  accepted: Array<{ start: number; end: number }> = [];
  requests: WireRequest[] = [];
  rejections = 0;

  constructor(opts: FakeOptions) {
    this.opts = opts;
    this.assembled = Buffer.alloc(opts.size);
  }

  nextEnd(from: number): number {
    const raw = from + this.opts.window(from);
    if (this.opts.overshootFinalWindow === true && raw >= this.opts.size) return raw;
    return Math.min(raw, this.opts.size);
  }

  get fetchImpl(): typeof fetch {
    return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const req = await toWireRequest(input, init);
      this.requests.push(req);
      if (req.method !== 'POST') return jsonResponse({ error: { message: 'unexpected GET', code: 100 } }, 400);
      if (!req.url.pathname.endsWith('/advideos')) {
        return jsonResponse({ error: { message: `unexpected path ${req.url.pathname}`, code: 100 } }, 400);
      }
      const phase = part(req, 'upload_phase');
      if (phase === 'start') return this.start(req);
      if (phase === 'transfer') return this.transfer(req);
      if (phase === 'finish') {
        this.finishes += 1;
        return new Response(this.opts.finishBody ?? '{"success":true}', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=UTF-8' },
        });
      }
      if (phase === 'cancel') {
        this.cancels += 1;
        return jsonResponse({ success: true });
      }
      return graphError(100, `unknown upload_phase "${phase}"`);
    };
  }

  private start(req: WireRequest): Response {
    this.starts += 1;
    const declared = Number(part(req, 'file_size'));
    if (declared !== this.opts.size) {
      return graphError(100, `file_size ${declared} does not match the ${this.opts.size} bytes offered`);
    }
    if (this.opts.skipUpload === true) {
      return jsonResponse({
        video_id: this.videoId,
        upload_session_id: this.sessionId,
        start_offset: '0',
        end_offset: '0',
        skip_upload: true,
      });
    }
    return jsonResponse({
      video_id: this.videoId,
      upload_session_id: this.sessionId,
      start_offset: '0',
      end_offset: String(this.nextEnd(0)),
      upload_domain: 'https://graph.facebook.com',
    });
  }

  private transfer(req: WireRequest): Response | never {
    const session = part(req, 'upload_session_id');
    if (session !== this.sessionId) return graphError(100, `unknown upload_session_id ${session}`);
    const start = Number(part(req, 'start_offset'));
    const end = Number(part(req, 'end_offset'));
    const chunk = req.parts.get('video_file_chunk');
    must(chunk, 'transfer arrived with no video_file_chunk part');
    this.transferAttempts += 1;

    const fault = this.opts.fault?.(this.transfers.length + 1, { start, end });
    if (fault === 'network') {
      // What a dropped connection actually looks like to fetch().
      throw new TypeError('fetch failed');
    }
    if (fault !== undefined) return fault;

    this.transfers.push({
      start,
      end,
      len: chunk.bytes.byteLength,
      filename: chunk.filename,
      contentType: chunk.contentType,
    });

    if (start !== this.held) {
      // Meta's documented resume mechanism: the offsets to replay from ride in error_data.
      this.rejections += 1;
      return graphError(100, 'Upload session offset mismatch', {
        error_subcode: 1363037,
        error_data: { start_offset: String(this.held), end_offset: String(this.nextEnd(this.held)) },
      });
    }
    if (this.opts.redictateWideWindows === true && end - start > this.opts.window(start)) {
      this.rejections += 1;
      return graphError(100, 'Chunk too large for this session', {
        error_data: { start_offset: String(this.held), end_offset: String(this.nextEnd(this.held)) },
      });
    }
    if (chunk.bytes.byteLength !== end - start) {
      return graphError(
        100,
        `video_file_chunk carried ${chunk.bytes.byteLength} bytes for the window [${start}, ${end}) ` +
          `— the body was truncated or re-encoded in transit`,
      );
    }
    Buffer.from(chunk.bytes).copy(this.assembled, start);
    this.accepted.push({ start, end });
    this.held = end;

    if (this.opts.convergeAt !== undefined && this.held >= this.opts.convergeAt) {
      return jsonResponse({ start_offset: String(this.held), end_offset: String(this.held) });
    }
    if (this.held >= this.opts.size) {
      return jsonResponse({ start_offset: String(this.opts.size), end_offset: String(this.opts.size) });
    }
    return jsonResponse({ start_offset: String(this.held), end_offset: String(this.nextEnd(this.held)) });
  }
}

const AD_ACCOUNT = 'act_1234567890';
const TOKEN = 'EAAsystem|user|token';
const APP_SECRET = 'app-secret-not-a-real-one';

function makeUploader(
  fetchImpl: typeof fetch,
  extra: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): VideoUploader {
  return new VideoUploader({
    adAccountId: AD_ACCOUNT,
    accessToken: TOKEN,
    appSecret: APP_SECRET,
    mode: 'STAGE', // never LIVE, and not SIMULATE (which stubs the very thing under test)
    fetchImpl,
    sleep: extra.sleep ?? (async () => {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
}

function fakeClock(start = 1_760_000_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** A source that records exactly which windows were read off the real file. */
function recordingSource(inner: ChunkSource, log: Array<[number, number]>): ChunkSource {
  return {
    size: inner.size,
    async read(start: number, end: number): Promise<Uint8Array> {
      log.push([start, end]);
      return inner.read(start, end);
    },
    close: () => inner.close(),
  };
}

/* ------------------------------------------------------------------ status bodies --- */

/** Verbatim shape from the dossier §2.2 / the Reels publishing guide. */
function statusBody(
  videoStatus: string,
  progress: number,
  over: {
    processing?: Record<string, unknown>;
    uploading?: Record<string, unknown>;
    publishing?: Record<string, unknown>;
  } = {},
): unknown {
  return {
    status: {
      video_status: videoStatus,
      processing_progress: progress,
      uploading_phase: over.uploading ?? {
        status: 'complete',
        bytes_transfered: 77373,
        source_file_size: 77373,
        errors: [],
      },
      processing_phase: over.processing ?? { status: 'in_progress', error: {} },
      publishing_phase: over.publishing ?? { status: 'not_started', publish_status: 'draft', error: {} },
    },
    id: '23851234567890123',
  };
}

function scriptedGet(responses: readonly (unknown | Response)[]): { fetchImpl: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof URL ? input : new URL(String(input));
    urls.push(url);
    const r = responses[Math.min(urls.length - 1, responses.length - 1)];
    return r instanceof Response ? r.clone() : jsonResponse(r);
  };
  return { fetchImpl, urls };
}

/* ------------------------------------------------------------------ the probe ------- */

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];
  const add = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS', detail });
    } catch (e) {
      if (e instanceof Blocked) {
        checks.push({ name, status: 'SKIP', detail: e.message, blockedBy: e.blockedBy });
      } else {
        checks.push({ name, status: 'FAIL', detail: errText(e) });
      }
    }
  };

  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'verify-videoupload-'));
  } catch (e) {
    return {
      module: 'meta/videoUpload',
      checks: [{ name: 'scratch-dir', status: 'FAIL', detail: errText(e) }],
    };
  }

  const goodPath = join(dir, 'good.mp4');
  const badPath = join(dir, 'bad.mp4');
  const posterPath = join(dir, 'poster.jpg');
  let goodBytes: Uint8Array | undefined;
  let goodProbe: RealProbe | undefined;

  try {
    /* ============================================================ 1. real render ==== */

    await add('ffmpeg-renders-a-real-ad-video', async () => {
      const v = await exec(FFMPEG, ['-version']).catch(() => undefined);
      if (!v || v.code !== 0) {
        throw new Blocked('ffmpeg missing at /usr/bin/ffmpeg', 'cannot render a real file');
      }
      const r = await exec(FFMPEG, GOOD_RENDER_ARGS(goodPath));
      must(r.code === 0, `ffmpeg exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
      const st = await stat(goodPath);
      must(st.size > 20_000, `render is only ${st.size} bytes — not a real multi-chunk subject`);
      goodBytes = new Uint8Array(await readFile(goodPath));
      const version = v.stdout.split('\n')[0] ?? '';
      return `${version.trim()} produced ${st.size} bytes of real 720x1280 H.264+AAC mp4 at ${goodPath}`;
    });

    await add('ffprobe-output-maps-onto-VideoFileMetadata', async () => {
      if (!goodBytes) throw new Blocked('no render', 'the ffmpeg render step did not produce a file');
      goodProbe = await probeFile(goodPath);
      const m = goodProbe.meta;
      eq(m.width, 720, 'width');
      eq(m.height, 1280, 'height');
      eq(m.frameRate, 30, 'frameRate parsed from r_frame_rate "30/1"');
      eq(m.videoCodec, 'h264', 'videoCodec');
      eq(m.audioCodec, 'aac', 'audioCodec');
      eq(m.pixelFormat, 'yuv420p', 'pixelFormat');
      eq(m.audioChannels, 2, 'audioChannels');
      eq(m.audioSampleRateHz, 48000, 'audioSampleRateHz');
      eq(m.pixelAspectRatio, 1, 'pixelAspectRatio parsed from sample_aspect_ratio "1:1"');
      eq(m.moovAtomAtFront, true, 'moovAtomAtFront (+faststart)');
      must(Math.abs(m.durationSeconds - 4) < 0.2, `durationSeconds ${m.durationSeconds}`);
      must(
        typeof m.container === 'string' && m.container.includes('mp4'),
        `container "${m.container}" must carry ffprobe's multi-name format string`,
      );
      return (
        `real ffprobe -> ${m.width}x${m.height} @${m.frameRate}fps ${m.videoCodec}/${m.audioCodec} ` +
        `${m.pixelFormat} container="${m.container}" moovFirst=${String(m.moovAtomAtFront)} ` +
        `elst=${String(m.hasEditLists)} vfr=${String(m.variableFrameRate)}`
      );
    });

    await add('spec-validator-accepts-the-pipeline-encode', () => {
      if (!goodProbe) throw new Blocked('no probe', 'ffprobe metadata unavailable');
      // The container facts ffprobe cannot see are held back here so the check isolates
      // the codec/geometry/bitrate half of the verdict.
      const { hasEditLists: _drop, ...rest } = goodProbe.meta;
      const v = validateAdVideoSpec(rest as VideoFileMetadata);
      must(
        v.errors.length === 0,
        `a straight pipeline encode was rejected: ${v.errors.map((e) => `${e.field}: ${e.message}`).join(' | ')}`,
      );
      return `ok=${String(v.ok)}, ${v.warnings.length} warning(s): [${v.warnings.map((w) => w.field).join(', ')}]`;
    });

    await add('spec-validator-rejects-a-non-compliant-render', async () => {
      const r = await exec(FFMPEG, BAD_RENDER_ARGS(badPath));
      must(r.code === 0, `ffmpeg exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
      const bad = await probeFile(badPath);
      const v = validateAdVideoSpec(bad.meta);
      must(!v.ok, 'a 2 s, 12 fps, yuv444p, silent render was accepted');
      const fields = new Set(v.errors.map((e) => e.field));
      for (const expected of ['durationSeconds', 'frameRate', 'pixelFormat']) {
        must(fields.has(expected), `expected an error on ${expected}; got [${[...fields].join(', ')}]`);
      }
      const noAudio = v.warnings.some((w) => w.field === 'audioCodec');
      must(noAudio, 'a silent render must at least warn about sound-on placements');
      return (
        `rejected with ${v.errors.length} error(s) [${[...fields].join(', ')}] — ` +
        `real probe said ${bad.meta.durationSeconds}s @${bad.meta.frameRate}fps ${bad.meta.pixelFormat}`
      );
    });

    await add('spec-validator-verdict-on-an-honestly-probed-ffmpeg-render', async () => {
      const probe = goodProbe;
      if (!probe) throw new Blocked('no probe', 'ffprobe metadata unavailable');
      const v = validateAdVideoSpec(probe.meta);
      // Before blaming the encode, establish whether ANY ffmpeg mp4 avoids the finding.
      const escapes: string[] = [];
      if (!v.ok) {
        // `-use_editlist 0` is the flag that actually removes the elst, and it is FIRST
        // here on purpose: the previous version of this list omitted it entirely, so the
        // investigation "proved" no flag existed and blamed the validator. Keep the
        // negative controls after it — they are what makes the positive result mean
        // something.
        const variants: Array<[string, readonly string[]]> = [
          ['+faststart AND -use_editlist 0 (what buildEncodeArgs emits)', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'smptebars=size=720x1280:rate=30', '-t', '1',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
            '-movflags', '+faststart', '-use_editlist', '0', join(dir, 'v0.mp4'),
          ]],
          ['+faststart+negative_cts_offsets, no b-frames, NO -use_editlist 0', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'smptebars=size=720x1280:rate=30', '-t', '1',
            '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-r', '30', '-an',
            '-movflags', '+faststart+negative_cts_offsets', join(dir, 'v1.mp4'),
          ]],
          ['stream-copy remux of the good render, NO -use_editlist 0', [
            '-y', '-hide_banner', '-loglevel', 'error', '-i', goodPath,
            '-c', 'copy', '-movflags', '+faststart', join(dir, 'v2.mp4'),
          ]],
        ];
        for (const [label, args] of variants) {
          const out = args[args.length - 1] as string;
          const r = await exec(FFMPEG, args);
          if (r.code !== 0) continue;
          const bytes = new Uint8Array(await readFile(out));
          const has = moovHasEditList(bytes, topLevelBoxes(bytes));
          escapes.push(`${label}: elst=${String(has)}`);
        }
      }
      // This is the metadata a real caller produces: ffprobe PLUS the mp4 box scan the
      // pipeline is told to run (assembly/ffmpeg.ts scanTopLevelBoxes -> moovContainsEditList).
      must(
        v.ok,
        `the recommended encode off this repo's own ffmpeg is REJECTED by its own validator: ` +
          v.errors.map((e) => `${e.field} [${e.basis}]: ${e.message}`).join(' | ') +
          ` — hasEditLists=${String(probe.meta.hasEditLists)}. Which of the two is wrong is ` +
          `decided by these renders, not by the dossier: ${escapes.join('; ')}. If the ` +
          `-use_editlist 0 variant shows elst=false while this render shows elst=true, the ENCODE ` +
          `is at fault (buildEncodeArgs lost a flag, or something re-muxed after it — note ` +
          `buildLoudnormApplyCommand needs +negative_cts_offsets as well, because a copy pass ` +
          `re-creates the list the encode pass suppressed). If even that variant shows elst=true, ` +
          `the muxer really cannot be talked out of it on this build and the AD_SPEC rule is the ` +
          `thing to revisit. gateContainerSpec (src/assembly/qa.ts:131) turns either into a hard QA ` +
          `failure, so this must never be left ambiguous.`,
      );
      return (
        `ok=${String(v.ok)} with the full container scan included: elst=` +
        `${String(probe.meta.hasEditLists)}, moovFirst=${String(probe.meta.moovAtomAtFront)}, ` +
        `audio ${String(probe.meta.audioBitrateBps)} bps, ${v.warnings.length} warning(s) ` +
        `[${v.warnings.map((w) => w.field).join(', ')}]`
      );
    });

    await add('mp4-box-scan-agrees-with-the-assembly-module', async () => {
      const file = goodBytes;
      const probe = goodProbe;
      if (!file || !probe) throw new Blocked('no render', 'no file to scan');
      let mod: {
        scanTopLevelBoxes: (b: Uint8Array, n?: number) => readonly { type: string }[];
        moovContainsEditList: (b: Uint8Array, boxes: readonly { type: string }[]) => boolean | undefined;
        moovBeforeMdat: (boxes: readonly { type: string }[]) => boolean | undefined;
      };
      try {
        mod = (await import('../assembly/ffmpeg.ts')) as unknown as typeof mod;
      } catch (e) {
        throw new Blocked('assembly module unavailable', `could not import assembly/ffmpeg.ts: ${errText(e)}`);
      }
      const boxes = mod.scanTopLevelBoxes(file);
      const theirEdit = mod.moovContainsEditList(file, boxes);
      const theirMoov = mod.moovBeforeMdat(boxes);
      eq(theirEdit, probe.meta.hasEditLists, 'edit-list verdict must match the assembly scanner');
      eq(theirMoov, probe.meta.moovAtomAtFront, 'moov-order verdict must match the assembly scanner');
      return `assembly scanner agrees: moovBeforeMdat=${String(theirMoov)}, moovContainsEditList=${String(theirEdit)}`;
    });

    /* ==================================================== 2. the chunked protocol === */

    // Captured into consts inside each closure below: TypeScript drops the narrowing of a
    // `let` that a nested function assigns, and every check here is a nested function.
    const size = (): number => goodBytes?.byteLength ?? 0;

    await add('chunked-upload-of-the-real-file-reassembles-byte-identically', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({ size: size(), window: () => 10_000 });
      const src = await fileChunkSource(goodPath);
      const reads: Array<[number, number]> = [];
      const progress: UploadProgress[] = [];
      try {
        const res = await makeUploader(fake.fetchImpl).uploadChunked({
          source: recordingSource(src, reads),
          title: 'hook A — probe',
          description: 'capability probe',
          isAiGenerated: true,
          onProgress: (p) => {
            progress.push({ ...p });
          },
        });
        eq(fake.starts, 1, 'start phase count');
        eq(fake.finishes, 1, 'finish phase count');
        eq(fake.cancels, 0, 'cancel must not fire on a clean upload');
        must(fake.transfers.length >= 7, `only ${fake.transfers.length} chunks — not a real multi-chunk transfer`);
        eq(res.chunkCount, fake.transfers.length, 'chunkCount');
        eq(res.bytesTransferred, size(), 'bytesTransferred');
        eq(res.videoId, fake.videoId, 'videoId from the start phase survives a bare finish');
        // Byte ranges must tile [0, size) exactly, with no gap and no overlap.
        let cursor = 0;
        for (const t of fake.transfers) {
          eq(t.start, cursor, `chunk start (window ${JSON.stringify(t)})`);
          eq(t.len, t.end - t.start, 'chunk byte length must equal the window width');
          cursor = t.end;
        }
        eq(cursor, size(), 'the windows must tile the whole file');
        eq(reads, fake.transfers.map((t) => [t.start, t.end]), 'reads off disk must match the windows Meta dictated');
        const digest = sha256(new Uint8Array(fake.assembled));
        eq(digest, sha256(file), 'reassembled sha256 must equal the original file');
        const starts = progress.filter((p) => p.phase === 'chunk-start').length;
        must(starts === fake.transfers.length, `chunk-start fired ${starts} times for ${fake.transfers.length} chunks`);
        return (
          `${fake.transfers.length} chunks, ${res.bytesTransferred} bytes, sha256 ${digest.slice(0, 16)}… ` +
          `identical to the source; progress fired ${progress.length} times`
        );
      } finally {
        await src.close();
      }
    });

    await add('meta-dictates-the-boundaries-including-a-final-window-past-EOF', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      // Deliberately irregular windows, including a 1-byte one, and a last window that
      // runs past the end of the file exactly as Meta is documented to hand back.
      const plan = [7, 1, 40_000, 13, 25_000, 900_000];
      let i = 0;
      const fake = new FakeMeta({
        size: size(),
        window: () => {
          const w = plan[Math.min(i, plan.length - 1)] ?? 10_000;
          i += 1;
          return w;
        },
        overshootFinalWindow: true,
      });
      const src = bufferChunkSource(file);
      const res = await makeUploader(fake.fetchImpl).uploadChunked({ source: src });
      const widths = fake.transfers.map((t) => t.end - t.start);
      eq(widths.slice(0, 4), [7, 1, 40_000, 13], 'the client must slice exactly the windows Meta asked for');
      eq(fake.transfers.at(-1)?.end, size(), 'the final window must be clamped to EOF, not sent past it');
      eq(sha256(new Uint8Array(fake.assembled)), sha256(file), 'reassembled bytes');
      eq(res.bytesTransferred, size(), 'bytesTransferred');
      return `windows [${widths.join(', ')}] followed exactly; overshoot clamped to ${size()}`;
    });

    await add('the-wire-format-is-a-real-binary-file-part-with-auth-in-the-body', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({ size: size(), window: () => 30_000 });
      await makeUploader(fake.fetchImpl).uploadChunked({
        source: bufferChunkSource(file),
        isAiGenerated: true,
      });
      const startReq = fake.requests[0];
      const transferReq = fake.requests[1];
      must(startReq && transferReq, 'expected at least a start and a transfer request');
      eq(startReq.url.pathname, `/v26.0/${AD_ACCOUNT}/advideos`, 'path must carry the act_ prefix');
      eq(startReq.url.searchParams.get('access_token'), null, 'the token must never ride in the query string');
      eq(part(startReq, 'access_token'), TOKEN, 'access_token travels in the body');
      eq(part(startReq, 'is_ai_generated'), 'true', 'is_ai_generated on the start phase');
      eq(startReq.parts.has('ad_account_id'), false, 'the account id must never be in the body');
      const proof = createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex');
      eq(part(startReq, 'appsecret_proof'), proof, 'appsecret_proof must be HMAC-SHA256(token, appSecret)');
      const chunk = transferReq.parts.get('video_file_chunk');
      must(chunk, 'no video_file_chunk part on the transfer request');
      must(chunk.filename !== undefined, 'the chunk must be a FILE part (filename=) or undici text-encodes it');
      eq(chunk.contentType, 'application/octet-stream', 'chunk content-type');
      eq(
        sha256(chunk.bytes),
        sha256(file.subarray(0, chunk.bytes.byteLength)),
        'the chunk bytes on the wire must be byte-identical to the file window',
      );
      must(
        chunk.bytes.byteLength === 30_000,
        `the wire body carried ${chunk.bytes.byteLength} bytes for a 30000-byte window`,
      );
      return `multipart part: name=video_file_chunk filename="${chunk.filename}" type=${chunk.contentType}, 30000 bytes byte-exact, appsecret_proof verified`;
    });

    await add('a-mid-transfer-crash-resumes-from-the-persisted-offset', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      let broken = true;
      const fake = new FakeMeta({
        size: size(),
        window: () => 10_000,
        // Everything from the third transfer on drops the connection, like a dead worker.
        fault: (n) => (broken && n >= 3 ? 'network' : undefined),
      });
      const src = await fileChunkSource(goodPath);
      try {
        // --- run 1: dies mid-file, having durably recorded where it was.
        let persisted: { videoId: string; uploadSessionId: string; startOffset: number } | undefined;
        const uploader = makeUploader(fake.fetchImpl);
        let failure: unknown;
        try {
          await uploader.uploadChunked({
            source: src,
            maxChunkAttempts: 2,
            onProgress: (p) => {
              // What a real worker fsyncs before the bytes go out.
              if (p.phase === 'chunk-start') {
                persisted = {
                  videoId: p.videoId,
                  uploadSessionId: p.uploadSessionId,
                  startOffset: p.startOffset,
                };
              }
            },
          });
        } catch (e) {
          failure = e;
        }
        must(failure instanceof Error, 'the dropped transfer must surface as an error');
        must(
          /resume rather than re-uploading/.test((failure as Error).message),
          `the failure must tell the operator to resume: ${(failure as Error).message}`,
        );
        eq(fake.cancels, 0, 'a transient failure must NOT cancel the session — that would force a full re-upload');
        must(persisted, 'no resume point was ever handed to onProgress');
        eq(persisted.startOffset, 20_000, 'the persisted offset must be the window that was in flight');
        eq(fake.held, 20_000, 'the server holds exactly the bytes that landed');
        const bytesLost = size() - fake.held;

        // --- run 2: a fresh worker resumes from the persisted record. No end offset in
        // the record, so the client must propose a window and let Meta re-dictate it.
        broken = false;
        const res = await makeUploader(fake.fetchImpl).uploadChunked({
          source: src,
          resume: { videoId: persisted.videoId, uploadSessionId: persisted.uploadSessionId, startOffset: persisted.startOffset },
        });
        eq(fake.starts, 1, 'a resumed upload must NOT re-run the start phase');
        eq(fake.finishes, 1, 'finish phase count');
        eq(sha256(new Uint8Array(fake.assembled)), sha256(file), 'the resumed file must reassemble byte-identically');
        eq(res.bytesTransferred, bytesLost, 'only the missing tail is re-sent');
        const resumedFirst = fake.transfers.find((t) => t.start === 20_000 && t.len > 0);
        must(resumedFirst, 'the resumed transfer never started at the persisted offset');
        return (
          `died at 20000/${size()}, resumed with no re-start, re-sent ${res.bytesTransferred} bytes ` +
          `(proposed window [20000, ${Math.min(20_000 + RESUME_CHUNK_BYTES, size())})), sha256 identical`
        );
      } finally {
        await src.close();
      }
    });

    await add('meta-re-dictates-the-resume-window-through-error_data', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      // The server refuses the client's proposed 50 MiB window and answers with the
      // offsets it actually wants, inside error.error_data — the documented resume path.
      const fake = new FakeMeta({ size: size(), window: () => 12_000, redictateWideWindows: true });
      const res = await makeUploader(fake.fetchImpl).uploadChunked({
        source: bufferChunkSource(file),
        resume: { videoId: 'v-old', uploadSessionId: '19875678901234567', startOffset: 0 },
        maxChunkAttempts: 3,
      });
      must(fake.rejections > 0, 'the server never had to re-dictate — the check proved nothing');
      eq(fake.starts, 0, 'a resume must not call the start phase');
      // The client's own opening proposal is the 50 MiB resume window; Meta refuses it and
      // names the window it wants. What matters is that every window Meta ACCEPTED is one
      // it dictated, and that each refusal was followed by a transfer at the named offset.
      const refused = fake.transfers.filter((t) => !fake.accepted.some((a) => a.start === t.start && a.end === t.end));
      eq(refused.length, fake.rejections, 'every refused window must be accounted for');
      eq(refused[0]?.end, size(), "the client's opening proposal is the 50 MiB resume window");
      must(
        fake.accepted.every((a) => a.end - a.start <= 12_000),
        `Meta accepted a window it never dictated: [${fake.accepted.map((a) => a.end - a.start).join(', ')}]`,
      );
      let cursor2 = 0;
      for (const a of fake.accepted) {
        eq(a.start, cursor2, 'the accepted windows must tile the file with no gap');
        cursor2 = a.end;
      }
      eq(cursor2, size(), 'the accepted windows must reach EOF');
      eq(sha256(new Uint8Array(fake.assembled)), sha256(file), 'reassembled bytes');
      eq(res.bytesTransferred, size(), 'bytesTransferred');
      return `${fake.rejections} error_data re-dictation(s) adopted; ${fake.transfers.length} transfer attempts; file intact`;
    });

    await add('a-crash-after-the-last-chunk-resumes-straight-into-finish', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({ size: size(), window: () => 10_000 });
      fake.held = size(); // every byte already landed; the worker died before `finish`
      Buffer.from(file).copy(fake.assembled, 0);
      const res = await makeUploader(fake.fetchImpl).uploadChunked({
        source: bufferChunkSource(file),
        resume: { videoId: fake.videoId, uploadSessionId: fake.sessionId, startOffset: size() },
      });
      eq(fake.transfers.length, 0, 'nothing may be re-sent when the file is already fully uploaded');
      eq(fake.finishes, 1, 'finish must still be called');
      eq(res.bytesTransferred, 0, 'bytesTransferred');
      return 'resume at EOF skipped the transfer loop and finished the session';
    });

    await add('skip_upload-means-Meta-already-has-the-bytes', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({ size: size(), window: () => 10_000, skipUpload: true });
      const res = await makeUploader(fake.fetchImpl).uploadChunked({ source: bufferChunkSource(file) });
      eq(fake.transfers.length, 0, 'no bytes may be sent when Meta says it already has them');
      eq(res.skippedUpload, true, 'skippedUpload');
      eq(fake.finishes, 1, 'finish must still create the asset');
      return 'dedupe path: 0 transfers, finish called, skippedUpload=true';
    });

    await add('a-gateway-502-mid-transfer-is-retried-and-the-session-is-kept', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      let blips = 0;
      const fake = new FakeMeta({
        size: size(),
        window: () => 20_000,
        fault: (n) => {
          if (n === 2 && blips < 1) {
            blips += 1;
            // What an intermediary actually returns: an HTML error page, no Graph body.
            return new Response('<html><head><title>502 Bad Gateway</title></head></html>', { status: 502 });
          }
          return undefined;
        },
      });
      const res = await makeUploader(fake.fetchImpl).uploadChunked({ source: bufferChunkSource(file) });
      eq(fake.cancels, 0, 'a gateway blip must never cancel the session');
      eq(sha256(new Uint8Array(fake.assembled)), sha256(file), 'reassembled bytes');
      eq(res.bytesTransferred, size(), 'bytesTransferred');
      return `one HTML 502 absorbed, ${fake.transfers.length} transfer attempts, file intact`;
    });

    await add('a-permanent-error-mid-transfer-cancels-the-orphaned-session', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({
        size: size(),
        window: () => 20_000,
        fault: (n) => (n === 2 ? graphError(190, 'Invalid OAuth 2.0 Access Token', {}, 400) : undefined),
      });
      let thrown: unknown;
      try {
        await makeUploader(fake.fetchImpl).uploadChunked({ source: bufferChunkSource(file) });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof MetaApiError, `expected a MetaApiError, got ${errText(thrown)}`);
      eq((thrown as MetaApiError).code, 190, 'error code');
      eq(fake.cancels, 1, 'a permanent failure must cancel the session so it is not orphaned garbage');
      eq(fake.transferAttempts, 2, 'a dead token must not be retried');
      return 'error 190 aborted immediately and cancelled the upload session';
    });

    await add('an-over-length-title-is-refused-before-a-single-byte-moves', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const fake = new FakeMeta({ size: size(), window: () => 10_000 });
      let thrown: unknown;
      try {
        await makeUploader(fake.fetchImpl).uploadChunked({
          source: bufferChunkSource(file),
          title: '🙂'.repeat(MAX_VIDEO_TITLE_CHARS),
        });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof Error, 'an over-length title must be refused');
      eq(fake.requests.length, 0, 'nothing may reach Meta once the title is known to be invalid');
      return `refused up front (emoji counted as code points): ${(thrown as Error).message.slice(0, 90)}…`;
    });

    await add('offsets-converging-early-must-not-finish-a-truncated-upload', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      // Buggy/pathological Meta: the transfer response converges start==end at 30 000
      // bytes of a 77 KB file, with no success flag. The documented exit signal fires on
      // a file that is two thirds missing.
      const fake = new FakeMeta({ size: size(), window: () => 10_000, convergeAt: 30_000 });
      let res: { bytesTransferred: number; videoId: string } | undefined;
      let thrown: unknown;
      try {
        res = await makeUploader(fake.fetchImpl).uploadChunked({ source: bufferChunkSource(file) });
      } catch (e) {
        thrown = e;
      }
      if (thrown !== undefined) {
        return `refused to finish a ${fake.held}/${size()} byte transfer: ${errText(thrown).slice(0, 140)}`;
      }
      throw new Error(
        `uploadChunked called upload_phase=finish after only ${fake.held} of ${size()} bytes and returned ` +
          `videoId=${res?.videoId} with bytesTransferred=${res?.bytesTransferred}. A caller that does not ` +
          `itself compare bytesTransferred to source.size will build an ad creative on a truncated video.`,
      );
    });

    await add('a-non-advancing-offset-is-a-loud-failure-not-a-spin', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const stuck: typeof fetch = async (input, init) => {
        const req = await toWireRequest(input, init);
        const phase = part(req, 'upload_phase');
        if (phase === 'start') {
          return jsonResponse({ video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '10000' });
        }
        if (phase === 'transfer') return jsonResponse({ start_offset: '0', end_offset: '10000' });
        return jsonResponse({ success: true });
      };
      let thrown: unknown;
      const started = Date.now();
      try {
        await makeUploader(stuck).uploadChunked({ source: bufferChunkSource(file) });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof Error, 'a wedged session must throw');
      must(
        /not advancing/.test((thrown as Error).message),
        `expected a "not advancing" abort, got: ${errText(thrown)}`,
      );
      return `aborted in ${Date.now() - started}ms instead of looping: ${(thrown as Error).message.slice(0, 80)}…`;
    });

    await add('a-truncated-chunk-would-be-caught-by-Meta-and-surfaces-as-such', async () => {
      // The fake server rejects any chunk whose byte length disagrees with its window.
      // Driving a deliberately short read through the uploader proves the failure path
      // reports Meta's own words rather than a generic transport error.
      const short: ChunkSource = {
        size: 1000,
        async read(start: number, end: number): Promise<Uint8Array> {
          return new Uint8Array(Math.max(0, end - start - 1)); // one byte short, every time
        },
        async close(): Promise<void> {},
      };
      const fake = new FakeMeta({ size: 1000, window: () => 1000 });
      let thrown: unknown;
      try {
        await makeUploader(fake.fetchImpl).uploadChunked({ source: short, maxChunkAttempts: 1 });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof Error, 'a short chunk must not be silently accepted');
      must(
        /truncated or re-encoded in transit|999 bytes/.test((thrown as Error).message),
        `the failure must carry Meta's diagnosis: ${errText(thrown)}`,
      );
      return `short chunk rejected and reported: ${(thrown as Error).message.slice(0, 110)}…`;
    });

    await add('a-big-numeric-video-id-survives-the-JSON-parse', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      // Meta ids exceed 2^53. A finish response carrying a BARE numeric id is the case
      // JSON.parse silently corrupts; parseBigIntSafe is supposed to prevent it.
      const fake = new FakeMeta({
        size: size(),
        window: () => 40_000,
        // Deliberately NOT round-tripped through JSON.parse here: that is the very step
        // that corrupts a 17-digit id, and the point is to hand the module the raw bytes.
        finishBody: '{"success":true,"id":23851234567890123}',
      });
      const res = await makeUploader(fake.fetchImpl).uploadChunked({ source: bufferChunkSource(file) });
      eq(res.videoId, '23851234567890123', 'the finish-phase id must survive exactly');
      return `finish returned a bare 17-digit number; videoId came back as "${res.videoId}" (not …124)`;
    });

    /* ======================================================= 3. processing poll ==== */

    await add('poll-walks-processing-to-ready-on-the-documented-ladder', async () => {
      const clock = fakeClock();
      const { fetchImpl, urls } = scriptedGet([
        statusBody('processing', 12),
        statusBody('processing', 68),
        statusBody('ready', 100, { processing: { status: 'complete', error: {} } }),
      ]);
      const seen: Array<[string, number | undefined]> = [];
      const status = await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123', {
        onPoll: (s) => {
          seen.push([s.videoStatus, s.processingProgress]);
        },
      });
      eq(status.videoStatus, 'ready', 'terminal status');
      eq(clock.slept, [2000, 5000], 'the documented 2s/5s backoff ladder');
      eq(seen.length, 3, 'onPoll count');
      eq(seen[0], ['processing', 12], 'first poll');
      eq(status.uploadingPhase?.bytesTransfered, 77373, "Meta's misspelt bytes_transfered must be read");
      const fields = urls[0]?.searchParams.get('fields') ?? '';
      must(
        fields.includes('processing_progress') && fields.includes('video_status'),
        `the status read must request the nested fields explicitly, got "${fields}"`,
      );
      return `3 polls, slept [${clock.slept.join(', ')}]ms, progress ${seen.map((s) => s[1]).join('->')}, ready`;
    });

    await add('a-failed-transcode-surfaces-Metas-own-reason', async () => {
      const clock = fakeClock();
      const { fetchImpl } = scriptedGet([
        statusBody('error', 40, {
          processing: { status: 'error', error: { message: 'Video codec not supported' } },
        }),
      ]);
      let thrown: unknown;
      try {
        await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123');
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof VideoProcessingError, `expected VideoProcessingError, got ${errText(thrown)}`);
      eq((thrown as VideoProcessingError).kind, 'FAILED', 'kind');
      must(
        /Video codec not supported/.test((thrown as Error).message),
        `the 3am message must quote Meta: ${(thrown as Error).message}`,
      );
      eq(clock.slept.length, 0, 'a terminal failure must not sleep through the backoff ladder first');
      return `FAILED on the first read: ${(thrown as Error).message.slice(0, 120)}…`;
    });

    await add('a-phase-error-under-a-healthy-video_status-still-fails', async () => {
      // The Reels guide shape: `errors: [...]` rather than `error: {}`, and video_status
      // still says processing while the phase has already given up.
      const { fetchImpl } = scriptedGet([
        statusBody('processing', 55, {
          uploading: { status: 'error', bytes_transfered: 10, errors: [{ message: 'Upload was interrupted' }] },
        }),
      ]);
      let thrown: unknown;
      try {
        await makeUploader(fetchImpl, fakeClock()).pollUntilReady('23851234567890123');
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof VideoProcessingError, `expected VideoProcessingError, got ${errText(thrown)}`);
      must(
        /Upload was interrupted/.test((thrown as Error).message),
        `the errors[] array must be read: ${(thrown as Error).message}`,
      );
      return 'phase-level error detected under video_status=processing, with the message from errors[]';
    });

    await add('expired-is-terminal-and-says-why-it-matters', async () => {
      const { fetchImpl } = scriptedGet([statusBody('expired', 100)]);
      let thrown: unknown;
      try {
        await makeUploader(fetchImpl, fakeClock()).pollUntilReady('23851234567890123');
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof VideoProcessingError, `expected VideoProcessingError, got ${errText(thrown)}`);
      must(/do not cache video ids/.test((thrown as Error).message), (thrown as Error).message);
      return 'expired classified FAILED with the cache warning attached';
    });

    await add('a-wedged-video-times-out-instead-of-polling-forever', async () => {
      const clock = fakeClock();
      const { fetchImpl } = scriptedGet([statusBody('processing', 40)]);
      let thrown: unknown;
      try {
        await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123', { timeoutMs: 60_000 });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof VideoProcessingError, `expected VideoProcessingError, got ${errText(thrown)}`);
      eq((thrown as VideoProcessingError).kind, 'TIMEOUT', 'kind');
      const total = clock.slept.reduce((a, b) => a + b, 0);
      eq(total, 60_000, 'the poll must not overshoot its own deadline');
      must(/processing_progress 40%/.test((thrown as Error).message), (thrown as Error).message);
      return `gave up after exactly ${total}ms across ${clock.slept.length} sleeps, reporting the last progress`;
    });

    await add('a-JSON-gateway-blip-on-the-status-read-is-absorbed', async () => {
      const clock = fakeClock();
      const { fetchImpl } = scriptedGet([
        jsonResponse({ nothing: 'useful' }, 503),
        statusBody('ready', 100),
      ]);
      const status = await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123');
      eq(status.videoStatus, 'ready', 'the poll must survive a bodyless 503');
      return 'a 503 with no Graph error body was retried, not treated as a dead video';
    });

    await add('an-HTML-gateway-blip-on-the-status-read-is-absorbed-too', async () => {
      const clock = fakeClock();
      const { fetchImpl } = scriptedGet([
        new Response('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
        statusBody('ready', 100),
      ]);
      const status = await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123');
      eq(status.videoStatus, 'ready', 'the poll must survive a proxy HTML 502');
      return "an intermediary's HTML 502 was retried like any other gateway blip, and the video came back ready";
    });

    await add('a-sustained-status-outage-still-gives-up', async () => {
      const clock = fakeClock();
      const { fetchImpl } = scriptedGet([jsonResponse({}, 503)]);
      let thrown: unknown;
      try {
        await makeUploader(fetchImpl, clock).pollUntilReady('23851234567890123', { timeoutMs: 600_000 });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof Error, 'a sustained outage must not be hidden');
      must(
        /consecutive/.test((thrown as Error).message) && /check the asset before re-uploading/.test((thrown as Error).message),
        `expected the sustained-outage message, got: ${errText(thrown)}`,
      );
      return `gave up after 5 consecutive read failures: ${(thrown as Error).message.slice(0, 100)}…`;
    });

    await add('an-empty-status-object-is-a-read-error-not-a-healthy-video', () => {
      let thrown: unknown;
      try {
        parseVideoStatus('23851234567890123', { id: '23851234567890123' });
      } catch (e) {
        thrown = e;
      }
      must(thrown instanceof Error, 'a missing status must throw');
      must(/222/.test((thrown as Error).message), 'the message must name error 222 / the token mismatch');
      eq(
        classifyVideoStatus({
          videoId: 'v',
          videoStatus: 'some_new_state_meta_invented',
          processingProgress: undefined,
          uploadingPhase: undefined,
          processingPhase: undefined,
          publishingPhase: undefined,
          raw: {},
        }),
        'PENDING',
        'an unknown status must keep polling, not fail',
      );
      return 'empty status rejected; unrecognised status classified PENDING';
    });

    /* ======================================================== 4. posters / images == */

    await add('a-real-poster-frame-uploads-through-adimages', async () => {
      if (goodBytes === undefined) throw new Blocked('no render', 'no file to extract a frame from');
      const r = await exec(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', goodPath,
        '-frames:v', '1', '-q:v', '3', posterPath,
      ]);
      must(r.code === 0, `ffmpeg poster extraction exited ${r.code}: ${r.stderr.slice(0, 200)}`);
      const poster = new Uint8Array(await readFile(posterPath));
      must(poster.byteLength > 1000, `poster is only ${poster.byteLength} bytes`);
      let seen: WireRequest | undefined;
      const fetchImpl: typeof fetch = async (input, init) => {
        seen = await toWireRequest(input, init);
        // The response map is keyed by the multipart FIELD NAME, not a constant.
        return jsonResponse({
          images: {
            'poster.jpg': { hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', url: 'https://scontent.example/x.jpg', width: 720, height: 1280 },
          },
        });
      };
      const img = await makeUploader(fetchImpl).uploadAdImage({ bytes: poster, filename: 'poster.jpg' });
      eq(img.hash, 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'image_hash');
      must(seen, 'no request was made');
      eq((seen as WireRequest).url.pathname, `/v26.0/${AD_ACCOUNT}/adimages`, 'adimages path');
      const field = (seen as WireRequest).parts.get('poster.jpg');
      must(field, 'the image must be posted under the filename field name');
      eq(sha256(field.bytes), sha256(poster), 'the poster bytes on the wire must match the file');
      eq(
        selectPreferredThumbnail([
          { id: '1', uri: 'a', width: 320, height: 180, scale: 1, isPreferred: false },
          { id: '2', uri: 'b', width: 1280, height: 720, scale: 1, isPreferred: false },
        ])?.id,
        '2',
        'thumbnail fallback must take the largest candidate',
      );
      return `real ${poster.byteLength}-byte JPEG frame posted as field "poster.jpg"; hash read from the single map entry`;
    });

    /* ============================================================= 5. safety ======= */

    await add('SIMULATE-never-touches-the-network', async () => {
      const file = goodBytes;
      if (!file) throw new Blocked('no render', 'no file to upload');
      const NEVER: typeof fetch = () => {
        throw new Error('SIMULATE mode reached the network');
      };
      const sim = new VideoUploader({
        adAccountId: AD_ACCOUNT,
        accessToken: TOKEN,
        appSecret: APP_SECRET,
        mode: 'SIMULATE',
        fetchImpl: NEVER,
      });
      const res = await sim.uploadChunked({ source: bufferChunkSource(file), title: 'dry run' });
      must(res.videoId.startsWith('simulated_video_'), `simulated id looked real: ${res.videoId}`);
      await sim.setThumbnail('v1', { bytes: new Uint8Array(10), filename: 'p.jpg' });
      const img = await sim.uploadAdImage({ bytes: new Uint8Array(10), filename: 'p.jpg' });
      must(img.hash.startsWith('simulated_imagehash_'), 'adimages must be stubbed too');
      eq(await sim.listThumbnails('v1'), [], 'thumbnails must not be fabricated');
      let phaseErr: unknown;
      try {
        await sim.startUpload(100);
      } catch (e) {
        phaseErr = e;
      }
      must(phaseErr instanceof Error && /SIMULATE/.test((phaseErr as Error).message), 'raw phases must refuse in SIMULATE');
      // And the input guards still run in a dry run.
      let guard: unknown;
      try {
        await sim.setThumbnail('v1', { bytes: new Uint8Array(11 * 1024 * 1024), filename: 'p.jpg' });
      } catch (e) {
        guard = e;
      }
      must(guard instanceof Error, 'the 10 MB thumbnail limit must still bite in SIMULATE');
      return 'every write stubbed, raw phases refused, input limits still enforced';
    });

    await add('helpers-behave-on-real-shaped-input', () => {
      eq(normaliseAdAccountPath('1234567890'), 'act_1234567890', 'bare id');
      eq(normaliseAdAccountPath('act_1234567890'), 'act_1234567890', 'prefixed id');
      let bad: unknown;
      try {
        normaliseAdAccountPath('https://business.facebook.com/act_1');
      } catch (e) {
        bad = e;
      }
      must(bad instanceof Error, 'a URL must be refused, not guessed at');
      const asString = resumeOffsetsFromError(
        new MetaApiError(
          { message: 'x', code: 100, error_subcode: 1363037, ...({ error_data: '{"start_offset":"40960","end_offset":"81920"}' } as object) },
          400,
        ),
      );
      eq(asString, { startOffset: 40960, endOffset: 81920 }, 'error_data as a JSON string');
      const asObject = resumeOffsetsFromError(
        new MetaApiError({ message: 'x', code: 100, ...({ error_data: { start_offset: 40960 } } as object) }, 400),
      );
      eq(asObject, { startOffset: 40960, endOffset: undefined }, 'error_data as an object with only a start');
      eq(resumeOffsetsFromError(new Error('not a graph error')), undefined, 'non-Meta errors carry no offsets');
      return 'account-path normalisation and both documented error_data shapes read correctly';
    });

    /* ============================================================ 6. live Meta ===== */

    await add('live-advideos-round-trip', async () => {
      const env = await readFile('/home/user/completeAdAutomation/.env', 'utf8').catch(() => '');
      const get = (k: string): string | undefined =>
        new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() || process.env[k];
      const token = get('META_SYSTEM_USER_TOKEN');
      const secret = get('META_APP_SECRET');
      if (!token || !secret) {
        throw new Blocked('no Meta credentials', 'META_SYSTEM_USER_TOKEN / META_APP_SECRET not present');
      }
      // READ-ONLY. A real upload is a POST to /advideos and is forbidden by the project
      // rule; this only establishes WHY it cannot be attempted.
      const url = new URL('https://graph.facebook.com/v26.0/me/adaccounts');
      url.searchParams.set('fields', 'id,account_status');
      url.searchParams.set('access_token', token);
      url.searchParams.set('appsecret_proof', createHmac('sha256', secret).update(token).digest('hex'));
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((e: unknown) => {
        throw new Blocked('no network path to graph.facebook.com', errText(e));
      });
      const body = (await res.json()) as { data?: unknown[]; error?: { message?: string } };
      if (body.error) {
        throw new Blocked('Graph API read failed', `GET /me/adaccounts -> ${body.error.message ?? 'error'}`);
      }
      const n = Array.isArray(body.data) ? body.data.length : 0;
      throw new Blocked(
        n === 0 ? 'no ad account assigned to the system user' : 'project rule: no POST to /advideos',
        `token is live (HTTP ${res.status}) and GET /me/adaccounts returned ${n} account(s); ` +
          `uploading a video is a POST to /act_<id>/advideos, which the ABSOLUTE RULE forbids. ` +
          `The chunked protocol above was therefore driven against a faithful fake.`,
      );
    });

    return { module: 'meta/videoUpload', checks };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ standalone ----- */

const isMain = (): boolean => {
  const arg = process.argv[1];
  return typeof arg === 'string' && import.meta.url === `file://${arg}`;
};

if (isMain()) {
  run()
    .then((report) => {
      const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
      for (const c of report.checks) counts[c.status] += 1;
      console.log(`\n=== ${report.module} ===`);
      for (const c of report.checks) {
        console.log(`[${c.status}] ${c.name}\n      ${c.detail}${c.blockedBy ? `\n      blockedBy: ${c.blockedBy}` : ''}`);
      }
      console.log(`\n${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip`);
      process.exitCode = counts.FAIL > 0 ? 1 : 0;
    })
    .catch((e: unknown) => {
      console.error(`probe crashed: ${errText(e)}`);
      process.exitCode = 1;
    });
}
