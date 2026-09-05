/**
 * Video ingest: `POST /act_{id}/advideos` (simple and chunked/resumable), the async
 * processing poll, thumbnails, and the ad-video spec validator.
 *
 * WHY THIS MODULE OWNS ITS OWN TRANSPORT
 * `MetaClient.post` encodes every write as `application/x-www-form-urlencoded`. The
 * `transfer` phase must send raw binary in a multipart part (`video_file_chunk`), so it
 * cannot go through that method. Rather than run two auth paths for one protocol, all
 * six calls here share one small multipart-capable sender — but it reuses `MetaApiError`,
 * `isGraphErrorBody` and `parseBigIntSafe` so error classification and id handling are
 * identical to the rest of the client.
 *
 * WHAT IS UNVERIFIED (and is therefore handled defensively rather than asserted)
 * The `upload_phase` parameters are confirmed verbatim on the `advideos` reference, but
 * the three *behavioural* rules are not stated in any currently reachable Meta primary
 * source — they come from the retired `/videos` guide and from SDK behaviour:
 *   1. that Meta, not the caller, dictates chunk boundaries;
 *   2. that the transfer loop terminates on `start_offset == end_offset`;
 *   3. that `finish` is where `title`/`description` are applied.
 * So the loop exits on ANY of three signals (offsets equal, next offset past EOF, or
 * `success: true`) and refuses to spin: a response that does not advance the offset is a
 * loud failure, not a silent infinite loop.
 *
 * Sources:
 *   https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/
 *   https://developers.facebook.com/docs/video-api/getting-started/
 *   https://developers.facebook.com/docs/video-api/guides/reels-publishing
 *   https://developers.facebook.com/docs/graph-api/reference/video-status/
 *   https://developers.facebook.com/docs/graph-api/reference/video/thumbnails/
 *   https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/
 */

import { createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';
import { GRAPH_BASE_URL } from './version.ts';
import { MetaApiError, isGraphErrorBody } from './errors.ts';
import { parseRateLimitHeaders } from './rateLimit.ts';
import { parseBigIntSafe, type RuntimeMode } from './client.ts';

/* ------------------------------------------------------------------ spec limits ---- */

/**
 * The strict intersection of the ad-placement specs and the (stricter) Instagram
 * organic specs. Encoding to this satisfies both, which is the whole point: Meta's
 * transcoder rejects the difference with error 352 and nobody is awake to read it.
 *
 * Read `SpecBasis` before quoting any of these numbers at anyone — several are
 * documented for ORGANIC publishing, not for ads, and the difference matters.
 */
export const AD_VIDEO_SPEC = {
  /** Ads-guide figure for every ad placement page. The app-ads page says 1 GB; that ceiling is app-ads-specific. */
  maxFileSizeBytes: 4 * 1024 * 1024 * 1024,
  /** Nothing about ad creative benefits from a huge master, and upload is the pipeline's tail latency. */
  recommendedMaxFileSizeBytes: 200 * 1024 * 1024,
  /** "VBR, 25Mbps maximum" — IG reel specification table. NOT the 100 Mbps figure that circulates. */
  maxVideoBitrateBps: 25_000_000,
  minFrameRate: 23,
  maxFrameRate: 60,
  /** "maximum 1920 horizontal pixels" — i.e. width. A 1080x1920 portrait master passes. */
  maxHorizontalPixels: 1920,
  minDurationSeconds: 3,
  maxDurationSeconds: 15 * 60,
  /** "stereo AAC audio compression at 128kbps+" — ads guide, verbatim. */
  minAudioBitrateBps: 128_000,
  /**
   * Fractional slack applied to `minAudioBitrateBps` before it becomes an ERROR, because
   * the spec and the measurement are not the same quantity.
   *
   * "128kbps+" describes the ENCODER SETTING (`-c:a aac -b:a 128k`, exactly as
   * creative-production-pipeline.md §12 writes it). `meta.audioBitrateBps` is whatever
   * the probe reports, and ffprobe reports the REALISED AVERAGE of the AAC stream, which
   * floats with content. [MEASURED here, ffmpeg 6.1.1] twenty renders at a nominal
   * `-b:a 128k` realised 126788-128450 bps (tones, pink and white noise, 3-30s); the
   * pipeline's own two-pass-loudnorm master realised 127097. A zero-tolerance
   * `< 128000 -> ERROR` therefore fails roughly half of all spec-compliant renders, and
   * `gateContainerSpec` turns that into a hard publish block — the module cannot publish
   * what it renders.
   *
   * 5% (>= 121600 bps) is 10x the measured ordinary spread and still 9.6 kbps clear of
   * the next rung down the standard AAC ladder: [MEASURED] a nominal `-b:a 112k` encode
   * realises 111085-112042 and a nominal `-b:a 96k` realises 95525-96146, so every
   * genuinely under-configured encode is still an ERROR. Inside the band the finding is
   * a WARNING, not silence: it names the realised number so a real 112k mistake that
   * somehow lands high is still visible.
   */
  audioBitrateMeasurementTolerance: 0.05,
  maxAudioSampleRateHz: 48_000,
  containers: ['mp4', 'mov'] as const,
  pixelFormat: 'yuv420p',
} as const;

/**
 * `title` on `/advideos`: *"Must be less than 255 characters. Special characters may
 * count as more than 1 character."* Checked before the upload starts, because `title` is
 * applied in the `finish` phase — an over-length title fails with a generic error 100
 * only after the entire file has already gone over the wire.
 */
export const MAX_VIDEO_TITLE_CHARS = 255;

/**
 * Where a constraint actually comes from. A caller that wants to ship anyway can filter
 * on this; what it must not do is believe Meta documents all of these as ad requirements.
 */
export type SpecBasis =
  /** Verbatim on the ads-guide placement pages. Meta documents this for ads. */
  | 'AD_SPEC'
  /** Verbatim on the Instagram organic reel/video spec table. Stricter; not an ad rule. */
  | 'ORGANIC_SPEC'
  /** Not documented as an ad requirement, but eliminates the dominant class of error 352/6000. */
  | 'ENCODER_HYGIENE';

export type SpecSeverity = 'ERROR' | 'WARNING';

export interface SpecFinding {
  field: string;
  severity: SpecSeverity;
  basis: SpecBasis;
  message: string;
}

export interface SpecValidation {
  /** True when nothing at ERROR severity was found. */
  ok: boolean;
  findings: SpecFinding[];
  errors: SpecFinding[];
  warnings: SpecFinding[];
}

/**
 * Probed facts about a rendered file. Deliberately a plain struct: this module must not
 * shell out to ffprobe — that belongs to the assembly module, which already runs it.
 *
 * Every field beyond the first six is optional because not every probe surfaces it; an
 * absent hygiene field produces a WARNING, never a silent pass.
 */
export interface VideoFileMetadata {
  fileSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  /** As reported by the probe: 'h264', 'avc1', 'hevc', ... Compared case-insensitively. */
  videoCodec: string;
  audioCodec?: string;
  videoBitrateBps?: number;
  audioBitrateBps?: number;
  audioSampleRateHz?: number;
  audioChannels?: number;
  /** 'mp4' | 'mov' (or an ffprobe format_name such as 'mov,mp4,m4a,3gp,3g2,mj2'). */
  container?: string;
  /** ffprobe `pix_fmt`. Anything but yuv420p is the commonest cause of error 352. */
  pixelFormat?: string;
  /** `-movflags +faststart`. False (or unknown) is the commonest cause of error 6000. */
  moovAtomAtFront?: boolean;
  /** "Videos should not contain edit lists or special boxes in file containers." */
  hasEditLists?: boolean;
  /** VFR is the #1 cause of "processed, but the audio drifts". */
  variableFrameRate?: boolean;
  closedGop?: boolean;
  interlaced?: boolean;
  /** ffprobe `sample_aspect_ratio` as a number; 1 means square pixels. */
  pixelAspectRatio?: number;
}

const H264_ALIASES = new Set(['h264', 'h.264', 'avc', 'avc1', 'libx264', 'x264']);
const HEVC_ALIASES = new Set(['hevc', 'h265', 'h.265', 'hvc1', 'libx265']);
const AAC_ALIASES = new Set(['aac', 'aac_lc', 'mp4a', 'mp4a.40.2', 'libfdk_aac']);

/**
 * Validate a probed render against the ad video spec BEFORE burning upload bandwidth.
 *
 * `ok === false` means: do not upload this file, it will come back as 352 or 6000 and
 * the retry will fail identically. Each finding names the offending value, because the
 * only person who will ever read it is reading a log at 3am.
 */
export function validateAdVideoSpec(meta: VideoFileMetadata): SpecValidation {
  const f: SpecFinding[] = [];
  const err = (field: string, basis: SpecBasis, message: string): void => {
    f.push({ field, severity: 'ERROR', basis, message });
  };
  const warn = (field: string, basis: SpecBasis, message: string): void => {
    f.push({ field, severity: 'WARNING', basis, message });
  };

  // ---- the probe itself ---------------------------------------------------------
  // ffprobe reports "N/A" for duration on a malformed container and "0/0" for the frame
  // rate of a stream it could not parse; both arrive here as NaN. Every comparison below
  // is false against NaN, so without this an unparseable render would validate CLEAN and
  // go straight to upload. A validator that passes what it could not measure is worse
  // than no validator.
  for (const [name, value] of [
    ['durationSeconds', meta.durationSeconds],
    ['width', meta.width],
    ['height', meta.height],
    ['frameRate', meta.frameRate],
  ] as const) {
    if (!Number.isFinite(value)) {
      err(
        name,
        'AD_SPEC',
        `${name} is ${value} — the probe did not produce a usable number. Re-probe the render; ` +
          `an unmeasurable field cannot be checked against any spec and must not be assumed good.`,
      );
    }
  }

  // ---- size -------------------------------------------------------------------
  if (!Number.isFinite(meta.fileSizeBytes) || meta.fileSizeBytes <= 0) {
    err('fileSizeBytes', 'AD_SPEC', `fileSizeBytes must be a positive number, got ${meta.fileSizeBytes}`);
  } else if (meta.fileSizeBytes > AD_VIDEO_SPEC.maxFileSizeBytes) {
    err(
      'fileSizeBytes',
      'AD_SPEC',
      `${mb(meta.fileSizeBytes)} exceeds Meta's 4 GB ad-placement maximum`,
    );
  } else if (meta.fileSizeBytes > AD_VIDEO_SPEC.recommendedMaxFileSizeBytes) {
    warn(
      'fileSizeBytes',
      'ENCODER_HYGIENE',
      `${mb(meta.fileSizeBytes)} is above the ${mb(AD_VIDEO_SPEC.recommendedMaxFileSizeBytes)} ` +
        `practical cap for this pipeline; upload time is our tail latency and no ad benefits from it`,
    );
  }

  // ---- duration ---------------------------------------------------------------
  if (meta.durationSeconds < AD_VIDEO_SPEC.minDurationSeconds) {
    err(
      'durationSeconds',
      'ORGANIC_SPEC',
      `${meta.durationSeconds}s is below the 3s minimum (error 382 "video file is too small")`,
    );
  }
  if (meta.durationSeconds > AD_VIDEO_SPEC.maxDurationSeconds) {
    err('durationSeconds', 'ORGANIC_SPEC', `${meta.durationSeconds}s exceeds the 15 minute maximum`);
  }

  // ---- geometry ---------------------------------------------------------------
  if (meta.width > AD_VIDEO_SPEC.maxHorizontalPixels) {
    err(
      'width',
      'ORGANIC_SPEC',
      `width ${meta.width}px exceeds the 1920 horizontal pixel maximum ` +
        `(a 1080x1920 portrait master is fine; a 1920x1080 landscape master is at the limit)`,
    );
  }
  if (meta.width <= 0 || meta.height <= 0) {
    err('width/height', 'AD_SPEC', `dimensions must be positive, got ${meta.width}x${meta.height}`);
  }
  if (meta.height > AD_VIDEO_SPEC.maxHorizontalPixels && meta.width <= AD_VIDEO_SPEC.maxHorizontalPixels) {
    // The source says "maximum 1920 horizontal pixels", which is read above as a width
    // rule — that is why a standard 1080x1920 reel passes. If Meta actually means the
    // LONG edge, this render is over. Warn rather than block: blocking every portrait
    // master on an ambiguous sentence would stop the pipeline dead.
    warn(
      'height',
      'ORGANIC_SPEC',
      `height ${meta.height}px is above 1920 while width is within it. The spec says "maximum 1920 ` +
        `horizontal pixels", read here as a width rule; if Meta means the long edge this will be ` +
        `rejected. Settle it with one real upload before relying on tall masters.`,
    );
  }
  if (meta.pixelAspectRatio !== undefined && meta.pixelAspectRatio !== 1) {
    err(
      'pixelAspectRatio',
      'AD_SPEC',
      `non-square pixels (SAR ${meta.pixelAspectRatio}); the ads guide requires "square pixels"`,
    );
  }

  // ---- frame rate -------------------------------------------------------------
  if (meta.frameRate < AD_VIDEO_SPEC.minFrameRate || meta.frameRate > AD_VIDEO_SPEC.maxFrameRate) {
    err('frameRate', 'ORGANIC_SPEC', `${meta.frameRate} fps is outside the accepted 23-60 fps range`);
  }
  if (meta.variableFrameRate === true) {
    err(
      'variableFrameRate',
      'AD_SPEC',
      `variable frame rate; the ads guide requires "fixed frame rate". VFR survives upload and ` +
        `then desynchronises audio after Meta's transcode. Re-encode with a fixed -r.`,
    );
  } else if (meta.variableFrameRate === undefined) {
    warn('variableFrameRate', 'AD_SPEC', 'unknown whether the render is CFR; probe it or force -r on encode');
  }

  // ---- video bitrate ----------------------------------------------------------
  if (meta.videoBitrateBps !== undefined && meta.videoBitrateBps > AD_VIDEO_SPEC.maxVideoBitrateBps) {
    err(
      'videoBitrateBps',
      'ORGANIC_SPEC',
      `${(meta.videoBitrateBps / 1e6).toFixed(1)} Mbps exceeds the documented "VBR, 25Mbps maximum"`,
    );
  }

  // ---- codecs -----------------------------------------------------------------
  const vcodec = normaliseCodec(meta.videoCodec);
  if (HEVC_ALIASES.has(vcodec)) {
    warn(
      'videoCodec',
      'AD_SPEC',
      `HEVC is allowed by Meta's broader video specs but every ad-placement page says ` +
        `"H.264 compression"; H.264 High is the only combination verified across placements`,
    );
  } else if (!H264_ALIASES.has(vcodec)) {
    err('videoCodec', 'AD_SPEC', `codec "${meta.videoCodec}" is not H.264 — this is error 352 waiting to happen`);
  }

  if (meta.audioCodec === undefined) {
    warn('audioCodec', 'AD_SPEC', 'no audio track detected; silent video ads under-deliver on sound-on placements');
  } else if (!AAC_ALIASES.has(normaliseCodec(meta.audioCodec))) {
    err('audioCodec', 'AD_SPEC', `audio codec "${meta.audioCodec}" is not AAC`);
  }
  if (meta.audioBitrateBps !== undefined && meta.audioBitrateBps < AD_VIDEO_SPEC.minAudioBitrateBps) {
    // The spec constrains the ENCODER SETTING; this number is the probe's REALISED
    // AVERAGE. See AD_VIDEO_SPEC.audioBitrateMeasurementTolerance for the measurements
    // that size the band, and for why a hard floor at exactly 128000 blocks the
    // pipeline's own compliant renders.
    const floor = AD_VIDEO_SPEC.minAudioBitrateBps * (1 - AD_VIDEO_SPEC.audioBitrateMeasurementTolerance);
    const measured = `${(meta.audioBitrateBps / 1000).toFixed(1)} kbps`;
    if (meta.audioBitrateBps < floor) {
      err(
        'audioBitrateBps',
        'AD_SPEC',
        `${measured} is below the documented "128kbps+" by more than the ` +
          `${(AD_VIDEO_SPEC.audioBitrateMeasurementTolerance * 100).toFixed(0)}% measurement tolerance ` +
          `(floor ${Math.round(floor)} bps). A realised AAC average this far down is a lower nominal ` +
          `setting, not encoder variance — re-encode with -c:a aac -b:a 128k. (If the encode really was ` +
          `128k, the source audio is so simple the encoder could not spend the bits; check the mix.)`,
      );
    } else {
      warn(
        'audioBitrateBps',
        'AD_SPEC',
        `${measured} is marginally under the documented "128kbps+". This is the REALISED average the ` +
          `probe measured, not the encoder setting the spec constrains: [MEASURED] a nominal ` +
          `-b:a 128k lands anywhere in 126.8-128.5 kbps depending on content, so this is not a defect ` +
          `on its own. Confirm the encode passes -b:a 128k; do not "fix" it by raising the bitrate.`,
      );
    }
  }
  if (meta.audioSampleRateHz !== undefined && meta.audioSampleRateHz > AD_VIDEO_SPEC.maxAudioSampleRateHz) {
    err('audioSampleRateHz', 'ORGANIC_SPEC', `${meta.audioSampleRateHz} Hz exceeds the 48 kHz maximum`);
  }
  if (meta.audioChannels !== undefined && meta.audioChannels !== 2) {
    warn(
      'audioChannels',
      'AD_SPEC',
      `${meta.audioChannels} channel(s); the ads guide says "stereo". 1-2 channels is accepted by the ` +
        `organic spec, so this is unlikely to be rejected — but it is not what Meta documents for ads`,
    );
  }

  // ---- container hygiene: the strict intersection that kills error 352/6000 ----
  if (meta.container !== undefined && !containerAccepted(meta.container)) {
    err('container', 'AD_SPEC', `container "${meta.container}" is not MP4 or MOV`);
  }
  checkHygiene(f, 'pixelFormat', meta.pixelFormat, AD_VIDEO_SPEC.pixelFormat, {
    bad: (v) =>
      `pix_fmt "${v}" is not 4:2:0. Generative video models routinely emit yuv444p or 10-bit, ` +
      `which Meta rejects with error 352. Re-encode with -pix_fmt yuv420p.`,
    unknown: 'pix_fmt not probed; force -pix_fmt yuv420p on encode',
  });
  if (meta.moovAtomAtFront === false) {
    err(
      'moovAtomAtFront',
      'ENCODER_HYGIENE',
      'moov atom is not at the front of the file. This is the commonest cause of error 6000. ' +
        'Re-mux with -movflags +faststart.',
    );
  } else if (meta.moovAtomAtFront === undefined) {
    warn('moovAtomAtFront', 'ENCODER_HYGIENE', 'moov position unknown; always encode with -movflags +faststart');
  }
  if (meta.hasEditLists === true) {
    err(
      'hasEditLists',
      'AD_SPEC',
      'container has edit lists. Verbatim from the ads guide: "Videos should not contain edit lists ' +
        'or special boxes in file containers." Second-commonest cause of error 6000.',
    );
  } else if (meta.hasEditLists === undefined) {
    warn('hasEditLists', 'AD_SPEC', 'edit-list presence unknown; re-mux to strip them');
  }
  if (meta.closedGop === false) {
    err('closedGop', 'ENCODER_HYGIENE', 'open GOP; encode closed GOP (-x264-params keyint=N:min-keyint=N:scenecut=0)');
  }
  if (meta.interlaced === true) {
    err('interlaced', 'AD_SPEC', 'interlaced source; the ads guide requires progressive scan');
  }

  const errors = f.filter((x) => x.severity === 'ERROR');
  return { ok: errors.length === 0, findings: f, errors, warnings: f.filter((x) => x.severity === 'WARNING') };
}

function checkHygiene(
  out: SpecFinding[],
  field: string,
  value: string | undefined,
  expected: string,
  msg: { bad: (v: string) => string; unknown: string },
): void {
  if (value === undefined) {
    out.push({ field, severity: 'WARNING', basis: 'ENCODER_HYGIENE', message: msg.unknown });
  } else if (value.toLowerCase() !== expected) {
    out.push({ field, severity: 'ERROR', basis: 'ENCODER_HYGIENE', message: msg.bad(value) });
  }
}

function containerAccepted(container: string): boolean {
  // ffprobe reports MP4 as the multi-name 'mov,mp4,m4a,3gp,3g2,mj2', so match on parts.
  const parts = container.toLowerCase().split(',').map((s) => s.trim());
  return parts.some((p) => (AD_VIDEO_SPEC.containers as readonly string[]).includes(p));
}

function normaliseCodec(codec: string): string {
  return codec.toLowerCase().replace(/^video\//, '').replace(/^audio\//, '').trim();
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------- chunk sources ---- */

/**
 * A random-access byte source. Meta dictates the windows, so the source must be able to
 * serve an arbitrary `[start, end)` — and must NOT require the whole file in memory: a
 * 200 MB render times four aspect ratios is not something to hold on the heap.
 */
export interface ChunkSource {
  readonly size: number;
  /** Returns exactly `end - start` bytes, or throws. */
  read(start: number, end: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** In-memory source. Convenient for posters and small clips; the natural test double. */
export function bufferChunkSource(bytes: Uint8Array): ChunkSource {
  return {
    size: bytes.byteLength,
    async read(start: number, end: number): Promise<Uint8Array> {
      assertWindow(start, end, bytes.byteLength);
      return bytes.subarray(start, end);
    },
    async close(): Promise<void> {
      /* nothing to release */
    },
  };
}

/** File-backed source. Holds one fd and reads only the window Meta asked for. */
export async function fileChunkSource(path: string): Promise<ChunkSource> {
  const handle = await open(path, 'r');
  let size: number;
  try {
    size = (await handle.stat()).size;
  } catch (e) {
    await handle.close();
    throw e;
  }
  return {
    size,
    async read(start: number, end: number): Promise<Uint8Array> {
      assertWindow(start, end, size);
      const length = end - start;
      const buf = Buffer.allocUnsafe(length);
      let filled = 0;
      // read() may return short. A short read that is silently accepted uploads a
      // truncated chunk, which Meta accepts and then fails to transcode.
      while (filled < length) {
        const { bytesRead } = await handle.read(buf, filled, length - filled, start + filled);
        if (bytesRead === 0) {
          throw new Error(
            `Unexpected EOF reading ${path} at byte ${start + filled}: wanted ${length} bytes from ` +
              `offset ${start} but the file ended. Did the render get truncated or replaced mid-upload?`,
          );
        }
        filled += bytesRead;
      }
      return buf;
    },
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

function assertWindow(start: number, end: number, size: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error(`Invalid byte window [${start}, ${end})`);
  }
  if (end > size) {
    throw new Error(`Byte window [${start}, ${end}) runs past end of source (${size} bytes)`);
  }
}

/* ------------------------------------------------------------------ upload types --- */

export interface ChunkedSession {
  videoId: string;
  uploadSessionId: string;
  /** Inclusive start of the window Meta wants next. Persist this before every chunk. */
  startOffset: number;
  /** Exclusive end of the window Meta wants next. */
  endOffset: number;
}

/**
 * Persisted resume point. `endOffset` is optional because a crash-recovery record may
 * only carry the start: there is NO offset-query call on `/advideos` (unlike the generic
 * Resumable Upload API), so a resumed transfer proposes a window and lets Meta's next
 * response — or its error body — re-dictate the boundaries.
 */
export interface ResumeState {
  videoId: string;
  uploadSessionId: string;
  startOffset: number;
  endOffset?: number;
}

export type ProgressPhase = 'chunk-start' | 'chunk-complete';

export interface UploadProgress {
  phase: ProgressPhase;
  videoId: string;
  uploadSessionId: string;
  /**
   * On 'chunk-start' this is the offset to replay from if this worker dies right now.
   * Persist it (fsynced) BEFORE the chunk goes out — the callback is awaited for exactly
   * that reason.
   */
  startOffset: number;
  endOffset: number;
  fileSize: number;
  /** 1-based attempt number for this window. >1 means we are retrying or resuming. */
  attempt: number;
}

export interface ChunkedUploadRequest {
  /**
   * Not closed by `uploadChunked` — the caller owns the lifecycle, because a resumed
   * or retried upload reuses the same source. Close it in a `finally` or leak the fd.
   */
  source: ChunkSource;
  title?: string;
  description?: string;
  name?: string;
  /**
   * `is_ai_generated` on `POST /act_{id}/advideos` exists in v26.0.1 SDK codegen. For a
   * platform whose whole creative pipeline is generative, set it. The downstream policy
   * consequence (label, reach) is UNVERIFIED — no Meta primary source describes it.
   */
  isAiGenerated?: boolean;
  resume?: ResumeState;
  onProgress?: (p: UploadProgress) => void | Promise<void>;
  /** Attempts per window before giving up. Re-sending a window is safe: offsets are absolute. */
  maxChunkAttempts?: number;
  /** Default true. Only ever fires for permanent failures — see `uploadChunked`. */
  cancelOnPermanentFailure?: boolean;
}

export interface ChunkedUploadResult {
  videoId: string;
  uploadSessionId: string;
  bytesTransferred: number;
  chunkCount: number;
  /** Meta already had these bytes and told us to skip the transfer phase. */
  skippedUpload: boolean;
}

/** Window proposed on resume when the persisted record carries no end offset. Meta's own start-phase example uses 50 MiB. */
export const RESUME_CHUNK_BYTES = 50 * 1024 * 1024;

/** A wedged loop costs money in wall-clock time, not in ad spend. Still, refuse to spin forever. */
const MAX_CHUNKS = 10_000;

const DEFAULT_MAX_CHUNK_ATTEMPTS = 4;

/* ------------------------------------------------------------------ status types --- */

export const VIDEO_STATUS_VALUES = [
  'uploading',
  'upload_complete',
  'upload_failed',
  'processing',
  'ready',
  'error',
  'expired',
] as const;
export type VideoStatusValue = (typeof VIDEO_STATUS_VALUES)[number];

/**
 * Terminal failures. `expired` is real: ad-account videos are not permanent, so a
 * `video_id` cached across a long horizon can come back expired rather than ready.
 */
const TERMINAL_FAILURE_STATUSES = new Set<string>(['error', 'upload_failed', 'expired']);

/**
 * Phase status. Meta's general publishing guide spells the terminal value `complete`;
 * the Reels guide spells it `completed`. Accept both — never assert on one.
 */
export const PHASE_STATUS_VALUES = ['not_started', 'in_progress', 'complete', 'completed', 'error'] as const;
export type PhaseStatusValue = (typeof PHASE_STATUS_VALUES)[number];

export interface VideoPhase {
  status: string | undefined;
  /** Meta's spelling, one 'r'. Not a typo here. */
  bytesTransfered: number | undefined;
  sourceFileSize: number | undefined;
  errorMessage: string | undefined;
}

export interface VideoProcessingStatus {
  videoId: string;
  /** Raw string, not the union: the VideoStatus reference and the Reels guide disagree on the enum. */
  videoStatus: string;
  /** 0-100. Distinguishes "slow but advancing" from "wedged" before the hard timeout fires. */
  processingProgress: number | undefined;
  uploadingPhase: VideoPhase | undefined;
  processingPhase: VideoPhase | undefined;
  publishingPhase: VideoPhase | undefined;
  raw: unknown;
}

export type ReadinessVerdict = 'READY' | 'FAILED' | 'PENDING';

/**
 * Anything unrecognised is PENDING, deliberately: the two Meta docs list different
 * enums, so an unknown value is far more likely to be a doc gap than a failure. The
 * hard timeout is what stops an unknown state from hanging the pipeline forever.
 */
export function classifyVideoStatus(s: VideoProcessingStatus): ReadinessVerdict {
  const v = s.videoStatus.toLowerCase();
  if (v === 'ready') return 'READY';
  if (TERMINAL_FAILURE_STATUSES.has(v)) return 'FAILED';
  // A phase can report an error while video_status still says 'processing'.
  for (const phase of [s.uploadingPhase, s.processingPhase, s.publishingPhase]) {
    if (phase?.status?.toLowerCase() === 'error') return 'FAILED';
  }
  return 'PENDING';
}

export class VideoProcessingError extends Error {
  readonly videoId: string;
  readonly kind: 'FAILED' | 'TIMEOUT';
  readonly status: VideoProcessingStatus | undefined;

  constructor(kind: 'FAILED' | 'TIMEOUT', videoId: string, message: string, status?: VideoProcessingStatus) {
    super(message);
    this.name = 'VideoProcessingError';
    this.kind = kind;
    this.videoId = videoId;
    this.status = status;
  }
}

export interface PollOptions {
  /** Hard timeout. Videos genuinely get stuck "Preparing" forever — Meta's own UI has this failure mode. */
  timeoutMs?: number;
  /** Backoff ladder; the last entry is the cap. */
  backoffMs?: readonly number[];
  onPoll?: (s: VideoProcessingStatus, elapsedMs: number) => void | Promise<void>;
}

export const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Tolerate a gateway blip on the status read; refuse to hide a sustained outage behind it. */
const MAX_CONSECUTIVE_STATUS_READ_FAILURES = 4;
export const DEFAULT_POLL_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;

/**
 * The `status` sub-object is not listed in the public Video node reference any more —
 * the page was trimmed, the field still works. Request the nested fields explicitly so
 * `processing_progress` comes back too.
 */
const STATUS_FIELDS =
  'status{video_status,processing_progress,uploading_phase,processing_phase,publishing_phase}';

/* ------------------------------------------------------------------ thumbnails ----- */

export interface VideoThumbnail {
  id: string;
  uri: string;
  width: number;
  height: number;
  scale: number | undefined;
  isPreferred: boolean;
}

export interface AdImage {
  hash: string;
  url: string | undefined;
  width: number | undefined;
  height: number | undefined;
  name: string | undefined;
}

/** Documented on the `/{video_id}/thumbnails` reference. */
export const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

/**
 * Pick a poster from the auto-generated candidates.
 *
 * Falls back to the largest candidate when nothing is flagged, because whether
 * `is_preferred` is even set on `advideos`-uploaded assets is UNVERIFIED — the edge is a
 * Page-video surface. For ad creative the reliable route is `/adimages` + `image_hash`
 * anyway; this is for when you want Meta's frame rather than your own.
 */
export function selectPreferredThumbnail(thumbs: readonly VideoThumbnail[]): VideoThumbnail | undefined {
  const preferred = thumbs.find((t) => t.isPreferred);
  if (preferred) return preferred;
  let best: VideoThumbnail | undefined;
  for (const t of thumbs) {
    if (!best || t.width * t.height > best.width * best.height) best = t;
  }
  return best;
}

/* ------------------------------------------------------------------ the uploader --- */

export interface VideoUploaderOptions {
  /** With or without the `act_` prefix; it is normalised. Never send it in a body — that is a 100. */
  adAccountId: string;
  accessToken: string;
  appSecret: string;
  /**
   * Only SIMULATE changes behaviour: it stubs the network entirely. VALIDATE and STAGE
   * upload for real, because there is no `validate_only` path for a binary upload and a
   * creative cannot be validated without a real `video_id`. Uploading spends no money —
   * the spend guard lives on the activation path, not here.
   */
  mode?: RuntimeMode;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Defaults to `graph.facebook.com`, which is correct: the Video API getting-started
   * page carries an explicit deprecation notice for `graph-video.facebook.com`. Older
   * research (and every official SDK's `url_override`) still says `graph-video`; this
   * override exists so that contradiction can be settled at 3am without a code change.
   */
  baseUrl?: string;
}

export class VideoUploader {
  readonly adAccountPath: string;
  readonly mode: RuntimeMode;
  private readonly accessToken: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly baseUrl: string;

  constructor(opts: VideoUploaderOptions) {
    this.adAccountPath = normaliseAdAccountPath(opts.adAccountId);
    this.accessToken = opts.accessToken;
    this.appSecret = opts.appSecret;
    this.mode = opts.mode ?? 'LIVE';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowImpl = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? GRAPH_BASE_URL;
  }

  /* ---------------------------------------------------------------- chunked ------- */

  /** `upload_phase=start`. Returns the first window Meta wants, plus the (not yet usable) video id. */
  async startUpload(
    fileSize: number,
    opts: { isAiGenerated?: boolean } = {},
  ): Promise<ChunkedSession & { skipUpload: boolean }> {
    this.assertNotSimulated('upload_phase=start');
    const form = new FormData();
    form.set('upload_phase', 'start');
    form.set('file_size', String(fileSize));
    if (opts.isAiGenerated !== undefined) form.set('is_ai_generated', String(opts.isAiGenerated));

    const res = await this.post<Record<string, unknown>>(`${this.adAccountPath}/advideos`, form);
    const videoId = firstString(res, ['video_id', 'id']);
    const uploadSessionId = firstString(res, ['upload_session_id']);
    if (!videoId || !uploadSessionId) {
      throw new Error(
        `advideos upload_phase=start returned no ${!videoId ? 'video_id' : 'upload_session_id'}: ` +
          JSON.stringify(res).slice(0, 400),
      );
    }
    return {
      videoId,
      uploadSessionId,
      startOffset: toOffset(res['start_offset'], 'start_offset'),
      endOffset: toOffset(res['end_offset'], 'end_offset'),
      skipUpload: res['skip_upload'] === true || res['skip_upload'] === 'true',
    };
  }

  /**
   * `upload_phase=transfer` for one window. Returns the NEXT window Meta wants.
   *
   * Re-sending an already-sent window is safe — offsets are absolute — so this is the
   * one operation in the publishing path that can be blind-retried without risking a
   * duplicate. Nothing here spends money.
   */
  async transferChunk(args: {
    uploadSessionId: string;
    startOffset: number;
    endOffset: number;
    bytes: Uint8Array;
  }): Promise<{ startOffset: number | undefined; endOffset: number | undefined; success: boolean | undefined }> {
    this.assertNotSimulated('upload_phase=transfer');
    const form = new FormData();
    form.set('upload_phase', 'transfer');
    form.set('upload_session_id', args.uploadSessionId);
    form.set('start_offset', String(args.startOffset));
    form.set('end_offset', String(args.endOffset));
    // The part must be a file part, not a text field, or the bytes get mangled by
    // charset handling. A filename is required for undici to emit `filename=`.
    form.set(
      'video_file_chunk',
      new Blob([args.bytes], { type: 'application/octet-stream' }),
      `chunk_${args.startOffset}`,
    );

    const res = await this.post<Record<string, unknown>>(`${this.adAccountPath}/advideos`, form);
    const success = typeof res['success'] === 'boolean' ? res['success'] : undefined;
    const startOffset = optionalOffset(res['start_offset']);
    const endOffset = optionalOffset(res['end_offset']);

    // `success: true` is one of the three documented exit signals, and a response that
    // carries it need not carry offsets. Demanding offsets unconditionally would turn a
    // successful FINAL chunk into a parse failure, then into three pointless retries of
    // bytes Meta already has, then into a spurious upload failure.
    if (startOffset === undefined || endOffset === undefined) {
      if (success === true) return { startOffset: undefined, endOffset: undefined, success };
      throw new Error(
        `advideos upload_phase=transfer returned neither a usable [start_offset, end_offset) nor ` +
          `success:true, so there is no way to know what Meta wants next: ${JSON.stringify(res).slice(0, 400)}`,
      );
    }
    return { startOffset, endOffset, success };
  }

  /** `upload_phase=finish`. Where title/description are applied (UNVERIFIED — see module header). */
  async finishUpload(
    uploadSessionId: string,
    meta: { title?: string; description?: string; name?: string } = {},
  ): Promise<Record<string, unknown>> {
    this.assertNotSimulated('upload_phase=finish');
    assertTitleLength(meta.title);
    const form = new FormData();
    form.set('upload_phase', 'finish');
    form.set('upload_session_id', uploadSessionId);
    if (meta.title !== undefined) form.set('title', meta.title);
    if (meta.description !== undefined) form.set('description', meta.description);
    if (meta.name !== undefined) form.set('name', meta.name);

    const res = await this.post<Record<string, unknown>>(`${this.adAccountPath}/advideos`, form);
    if (res['success'] === false) {
      throw new Error(
        `advideos upload_phase=finish returned success:false for session ${uploadSessionId}. ` +
          `The bytes are uploaded but the asset was not created; re-upload rather than polling for it.`,
      );
    }
    return res;
  }

  /** `upload_phase=cancel`. Orphaned sessions are otherwise invisible garbage. */
  async cancelUpload(uploadSessionId: string): Promise<void> {
    if (this.mode === 'SIMULATE') return;
    const form = new FormData();
    form.set('upload_phase', 'cancel');
    form.set('upload_session_id', uploadSessionId);
    await this.post(`${this.adAccountPath}/advideos`, form);
  }

  /**
   * The whole chunked protocol, resumable.
   *
   * Meta drives the chunk boundaries: each `transfer` response hands back the next
   * `[start_offset, end_offset)` and we slice exactly that. We never choose a window
   * except when resuming, where there is nothing to ask.
   *
   * On failure the session is cancelled ONLY when the error is permanent. A transient
   * or ambiguous failure leaves the session alive on purpose — that is what makes the
   * persisted offset worth anything; cancelling would force a full re-upload of a file
   * that may be hundreds of megabytes.
   */
  async uploadChunked(req: ChunkedUploadRequest): Promise<ChunkedUploadResult> {
    const size = req.source.size;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`Refusing to upload a source of size ${size}; nothing to send.`);
    }
    if (size > AD_VIDEO_SPEC.maxFileSizeBytes) {
      throw new Error(
        `Source is ${mb(size)}, above Meta's 4 GB ad video limit. Refusing to spend the bandwidth ` +
          `on an upload that cannot succeed.`,
      );
    }
    // Checked HERE, not in `finish`, because `finish` runs after every byte is uploaded.
    assertTitleLength(req.title);

    if (this.mode === 'SIMULATE') {
      return {
        videoId: simulatedId('video', `${this.adAccountPath}:${size}:${req.title ?? ''}`),
        uploadSessionId: simulatedId('session', `${this.adAccountPath}:${size}`),
        bytesTransferred: 0,
        chunkCount: 0,
        skippedUpload: true,
      };
    }

    let session: ChunkedSession;
    let skippedUpload = false;
    if (req.resume) {
      session = {
        videoId: req.resume.videoId,
        uploadSessionId: req.resume.uploadSessionId,
        startOffset: req.resume.startOffset,
        // No offset-query call exists on this edge, so propose a window; Meta's response
        // (or its error_data) re-dictates the boundaries from here on.
        endOffset: req.resume.endOffset ?? Math.min(req.resume.startOffset + RESUME_CHUNK_BYTES, size),
      };
    } else {
      const started = await this.startUpload(size, {
        ...(req.isAiGenerated !== undefined ? { isAiGenerated: req.isAiGenerated } : {}),
      });
      skippedUpload = started.skipUpload;
      session = {
        videoId: started.videoId,
        uploadSessionId: started.uploadSessionId,
        startOffset: started.startOffset,
        endOffset: started.endOffset,
      };
    }

    const firstOffset = session.startOffset;
    let chunkCount = 0;
    let lastStartOffset = -1;
    let metaSaidSuccess = false;

    try {
      while (!skippedUpload && session.startOffset < session.endOffset) {
        // Three independent exit signals are honoured below; this one guards the
        // fourth case Meta's docs do not cover — a response that does not advance.
        if (session.startOffset <= lastStartOffset) {
          throw new Error(
            `advideos transfer is not advancing: Meta returned start_offset=${session.startOffset} ` +
              `again (session ${session.uploadSessionId}, file ${size} bytes). Aborting rather than ` +
              `looping forever; cancel the session and re-upload.`,
          );
        }
        lastStartOffset = session.startOffset;
        if (chunkCount >= MAX_CHUNKS) {
          throw new Error(
            `advideos transfer exceeded ${MAX_CHUNKS} chunks for a ${size}-byte file; refusing to continue.`,
          );
        }

        // Meta can hand back an end offset past EOF on the final window.
        const end = Math.min(session.endOffset, size);
        const next = await this.transferWindow(session, end, size, req);
        chunkCount += 1;

        // A `success: true` with no offsets means Meta took everything: record the file
        // as fully sent rather than leaving the resume point stranded at the last window.
        const nextStart = next.startOffset ?? size;
        const nextEnd = next.endOffset ?? nextStart;

        await req.onProgress?.({
          phase: 'chunk-complete',
          videoId: session.videoId,
          uploadSessionId: session.uploadSessionId,
          startOffset: nextStart,
          endOffset: nextEnd,
          fileSize: size,
          attempt: next.attempts,
        });

        session.startOffset = nextStart;
        session.endOffset = nextEnd;

        if (next.success === true) {
          metaSaidSuccess = true; // documented `finish` signal, seen on transfer too
          break;
        }
        if (nextStart >= size) break; // nothing left, whatever the offsets claim
      }

      // The loop's primary exit is `start_offset == end_offset`. Meta converging them
      // EARLY therefore walks straight into `finish`, which builds an asset out of a
      // partial file — and a truncated video transcodes into a short ad rather than an
      // error, so nothing downstream would ever notice. Only Meta explicitly claiming
      // completion (`success: true`) or `skip_upload` may end a transfer below EOF.
      // Thrown as a plain Error on purpose: that leaves the session uncancelled, so the
      // caller can resume from the recorded offset instead of re-sending the whole file.
      if (!skippedUpload && !metaSaidSuccess && session.startOffset < size) {
        throw new Error(
          `advideos transfer ended at byte ${session.startOffset} of ${size}: Meta converged ` +
            `start_offset and end_offset before the whole file had been sent (session ` +
            `${session.uploadSessionId}). Refusing to run upload_phase=finish on a partial upload — ` +
            `the asset would come back as a truncated video, not as an error. The session is still ` +
            `open: resume from ${session.startOffset}.`,
        );
      }

      const finished = await this.finishUpload(session.uploadSessionId, {
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.description !== undefined ? { description: req.description } : {}),
        ...(req.name !== undefined ? { name: req.name } : {}),
      });
      const finishedId = firstString(finished, ['id', 'video_id']);

      return {
        videoId: finishedId ?? session.videoId,
        uploadSessionId: session.uploadSessionId,
        bytesTransferred: Math.max(0, session.startOffset - firstOffset),
        chunkCount,
        skippedUpload,
      };
    } catch (err) {
      if (req.cancelOnPermanentFailure !== false && isPermanentFailure(err)) {
        try {
          await this.cancelUpload(session.uploadSessionId);
        } catch (cancelErr) {
          // Never mask the real cause with a cleanup failure.
          console.warn(
            `[meta] failed to cancel upload session ${session.uploadSessionId}: ${String(cancelErr)}`,
          );
        }
      }
      throw err;
    }
  }

  /**
   * One window, with bounded retries.
   *
   * The important part is the error path: on a chunked-upload failure Meta returns the
   * offsets to resume from inside `error.error_data.start_offset`. Reading only the
   * success path makes resumption impossible — you would replay a window Meta has
   * already partly consumed and get the same error forever.
   */
  private async transferWindow(
    session: ChunkedSession,
    end: number,
    fileSize: number,
    req: ChunkedUploadRequest,
  ): Promise<{
    startOffset: number | undefined;
    endOffset: number | undefined;
    success: boolean | undefined;
    attempts: number;
  }> {
    const maxAttempts = req.maxChunkAttempts ?? DEFAULT_MAX_CHUNK_ATTEMPTS;
    let start = session.startOffset;
    let windowEnd = end;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Fired BEFORE the bytes go out and awaited, so the caller can fsync the resume
      // point first. A crash between here and the response replays this window.
      await req.onProgress?.({
        phase: 'chunk-start',
        videoId: session.videoId,
        uploadSessionId: session.uploadSessionId,
        startOffset: start,
        endOffset: windowEnd,
        fileSize,
        attempt,
      });

      try {
        const bytes = await req.source.read(start, windowEnd);
        const res = await this.transferChunk({
          uploadSessionId: session.uploadSessionId,
          startOffset: start,
          endOffset: windowEnd,
          bytes,
        });
        return { ...res, attempts: attempt };
      } catch (err) {
        lastErr = err;

        const resumeAt = resumeOffsetsFromError(err);
        if (resumeAt) {
          // Meta told us where it actually is. Adopt that even for an otherwise
          // permanent code — a 100 that carries offsets is an offset disagreement,
          // not a bad request.
          start = resumeAt.startOffset;
          windowEnd = Math.min(resumeAt.endOffset ?? start + RESUME_CHUNK_BYTES, fileSize);
          if (start >= fileSize) {
            return { startOffset: start, endOffset: start, success: undefined, attempts: attempt };
          }
          continue;
        }

        if (err instanceof MetaApiError && !isWorthRetrying(err)) {
          throw err;
        }
        if (attempt === maxAttempts) break;
        await this.sleepImpl(1000 * 2 ** (attempt - 1));
      }
    }

    throw new Error(
      `advideos transfer failed after ${maxAttempts} attempts at offset ${start} of ${fileSize} ` +
        `(session ${session.uploadSessionId}). The session is still open: persist the offset and ` +
        `resume rather than re-uploading. Last error: ${String(lastErr)}`,
      { cause: lastErr },
    );
  }

  /**
   * Single-request upload. Fine for posters and short clips; for anything above a few
   * tens of megabytes use `uploadChunked`, which survives a dropped connection.
   */
  async uploadSimple(args: {
    bytes: Uint8Array;
    filename: string;
    title?: string;
    description?: string;
    isAiGenerated?: boolean;
  }): Promise<{ videoId: string }> {
    assertTitleLength(args.title);
    if (this.mode === 'SIMULATE') {
      return { videoId: simulatedId('video', `${this.adAccountPath}:${args.filename}`) };
    }
    const form = new FormData();
    form.set('source', new Blob([args.bytes], { type: 'video/mp4' }), args.filename);
    if (args.title !== undefined) form.set('title', args.title);
    if (args.description !== undefined) form.set('description', args.description);
    if (args.isAiGenerated !== undefined) form.set('is_ai_generated', String(args.isAiGenerated));

    const res = await this.post<Record<string, unknown>>(`${this.adAccountPath}/advideos`, form);
    const videoId = firstString(res, ['id', 'video_id']);
    if (!videoId) {
      throw new Error(`advideos simple upload returned no video id: ${JSON.stringify(res).slice(0, 400)}`);
    }
    return { videoId };
  }

  /* ---------------------------------------------------------------- processing ---- */

  /**
   * One status read. Use the SAME token that performed the upload: polling an
   * ad-account video with a user token returns error 222 "Video not visible".
   */
  async getVideoStatus(videoId: string): Promise<VideoProcessingStatus> {
    if (this.mode === 'SIMULATE') {
      return {
        videoId,
        videoStatus: 'ready',
        processingProgress: 100,
        uploadingPhase: undefined,
        processingPhase: undefined,
        publishingPhase: undefined,
        raw: { __simulated: true },
      };
    }
    const res = await this.get<Record<string, unknown>>(videoId, { fields: STATUS_FIELDS });
    return parseVideoStatus(videoId, res);
  }

  /**
   * Poll until `video_status === 'ready'`.
   *
   * This is a hard gate: `POST /adcreatives` against a video that is still processing
   * either fails or produces an ad stuck in "Preparing" that never delivers and never
   * errors. Meta publishes no processing SLA (UNVERIFIED), so the timeout is a policy
   * decision, not a measured bound.
   */
  async pollUntilReady(videoId: string, opts: PollOptions = {}): Promise<VideoProcessingStatus> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const ladder = opts.backoffMs ?? DEFAULT_POLL_BACKOFF_MS;
    const startedAt = this.nowImpl();
    let attempt = 0;
    let last: VideoProcessingStatus | undefined;
    let consecutiveReadFailures = 0;

    for (;;) {
      let status: VideoProcessingStatus | undefined;
      try {
        status = await this.getVideoStatus(videoId);
        consecutiveReadFailures = 0;
      } catch (err) {
        // The video is fine; the READ failed. Aborting here would send the caller back to
        // re-upload a file Meta is already transcoding, so a gateway blip must not end the
        // poll — but a persistent one must, or this loop hides a real outage for 15 minutes.
        if (!(err instanceof MetaApiError) || !isWorthRetrying(err)) throw err;
        consecutiveReadFailures += 1;
        if (consecutiveReadFailures > MAX_CONSECUTIVE_STATUS_READ_FAILURES) {
          throw new Error(
            `Could not read the status of video ${videoId}: ${consecutiveReadFailures} consecutive ` +
              `transient failures. The upload itself may well have succeeded — check the asset before ` +
              `re-uploading. Last error: ${String(err)}`,
            { cause: err },
          );
        }
      }

      const elapsed = this.nowImpl() - startedAt;
      if (status !== undefined) {
        last = status;
        await opts.onPoll?.(status, elapsed);

        const verdict = classifyVideoStatus(status);
        if (verdict === 'READY') return status;
        if (verdict === 'FAILED') {
          throw new VideoProcessingError('FAILED', videoId, describeFailure(videoId, status), status);
        }
      }

      if (elapsed >= timeoutMs) break;
      const wait = ladder[Math.min(attempt, ladder.length - 1)] ?? 15_000;
      attempt += 1;
      // Do not overshoot the deadline just to complete a backoff step.
      await this.sleepImpl(Math.min(wait, Math.max(0, timeoutMs - elapsed)));
      if (this.nowImpl() - startedAt >= timeoutMs) break;
    }

    const progress = last?.processingProgress;
    throw new VideoProcessingError(
      'TIMEOUT',
      videoId,
      `Video ${videoId} was still "${last?.videoStatus ?? 'unknown'}" after ${Math.round(timeoutMs / 1000)}s` +
        (progress !== undefined ? ` (processing_progress ${progress}%)` : '') +
        `. Videos do get wedged in Meta's transcoder — treat as failed and re-upload rather than ` +
        `building a creative on it.`,
      last,
    );
  }

  /* ---------------------------------------------------------------- thumbnails ---- */

  /** Poll AFTER `ready`: the edge is empty or partial during processing. */
  async listThumbnails(videoId: string): Promise<VideoThumbnail[]> {
    // In SIMULATE the video id is fabricated, so a real read could only 404. An empty
    // list is the honest answer; fabricating a CDN uri would be a lie a caller may act on.
    if (this.mode === 'SIMULATE') return [];
    const res = await this.get<{ data?: unknown }>(`${videoId}/thumbnails`);
    const data = Array.isArray(res.data) ? res.data : [];
    return data.map((raw): VideoThumbnail => {
      const t = asRecord(raw);
      return {
        id: String(t['id'] ?? ''),
        uri: String(t['uri'] ?? ''),
        width: toNumberOr(t['width'], 0),
        height: toNumberOr(t['height'], 0),
        scale: typeof t['scale'] === 'number' ? t['scale'] : undefined,
        isPreferred: t['is_preferred'] === true || t['is_preferred'] === 'true',
      };
    });
  }

  /**
   * Upload a custom poster to `/{video_id}/thumbnails`.
   *
   * Whether `is_preferred` here is honoured by the AD renderer is UNVERIFIED — this is
   * a Page-video surface. For ad creative use `uploadAdImage` and pass the `image_hash`
   * into `video_data`; that path is deterministic and dedupes across creatives.
   */
  async setThumbnail(
    videoId: string,
    args: { bytes: Uint8Array; filename: string; isPreferred?: boolean; contentType?: string },
  ): Promise<void> {
    if (args.bytes.byteLength > MAX_THUMBNAIL_BYTES) {
      throw new Error(
        `Thumbnail is ${mb(args.bytes.byteLength)}; the documented maximum is 10 MB.`,
      );
    }
    // A WRITE. Every other write on this class stubs SIMULATE; this one did not, so a
    // SIMULATE run was posting a real poster to a real video. The size check above still
    // runs first, because catching a bad input is the entire point of a dry run.
    if (this.mode === 'SIMULATE') return;
    const form = new FormData();
    form.set(
      'source',
      new Blob([args.bytes], { type: args.contentType ?? 'image/jpeg' }),
      args.filename,
    );
    if (args.isPreferred !== undefined) form.set('is_preferred', String(args.isPreferred));
    await this.post(`${videoId}/thumbnails`, form);
  }

  /**
   * `POST /act_{id}/adimages` — the poster path that actually works for ads.
   *
   * The response map is keyed by the MULTIPART FIELD NAME you used, not by a constant.
   * Upload as `bytes` and you get `{"images":{"bytes":{...}}}`. So this reads the single
   * entry rather than looking up a key, and says so loudly if there is more than one.
   */
  async uploadAdImage(args: {
    bytes: Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<AdImage> {
    if (this.mode === 'SIMULATE') {
      return {
        hash: simulatedId('imagehash', `${this.adAccountPath}:${args.filename}`),
        url: undefined,
        width: undefined,
        height: undefined,
        name: args.filename,
      };
    }
    const form = new FormData();
    form.set(
      args.filename,
      new Blob([args.bytes], { type: args.contentType ?? 'image/jpeg' }),
      args.filename,
    );
    const res = await this.post<{ images?: unknown }>(`${this.adAccountPath}/adimages`, form);

    const images = asRecord(res.images);
    const entries = Object.entries(images);
    const entry = entries.find(([k]) => k === args.filename) ?? (entries.length === 1 ? entries[0] : undefined);
    if (!entry) {
      throw new Error(
        `adimages response did not contain a single image entry. Keys: [${entries.map(([k]) => k).join(', ')}]. ` +
          `The map is keyed by the multipart field name, so this means the upload field name was rewritten.`,
      );
    }
    const img = asRecord(entry[1]);
    const hash = typeof img['hash'] === 'string' ? img['hash'] : undefined;
    if (!hash) {
      throw new Error(`adimages entry "${entry[0]}" has no hash: ${JSON.stringify(img).slice(0, 300)}`);
    }
    return {
      hash,
      url: typeof img['url'] === 'string' ? img['url'] : undefined,
      width: typeof img['width'] === 'number' ? img['width'] : undefined,
      height: typeof img['height'] === 'number' ? img['height'] : undefined,
      name: typeof img['name'] === 'string' ? img['name'] : undefined,
    };
  }

  /* ---------------------------------------------------------------- transport ----- */

  /**
   * The raw phase methods speak a stateful protocol against a real session id, so there
   * is nothing coherent to fake. Refuse loudly and point at `uploadChunked`, which does
   * stub the whole path — far better than silently uploading in a dry run.
   */
  private assertNotSimulated(op: string): void {
    if (this.mode === 'SIMULATE') {
      throw new Error(
        `Refusing to run ${op} against Meta in SIMULATE mode. Drive the chunked protocol through ` +
          `uploadChunked(), which simulates the whole session; the phase methods have no meaningful stub.`,
      );
    }
  }

  private appsecretProof(): string {
    return createHmac('sha256', this.appSecret).update(this.accessToken).digest('hex');
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${stripLeadingSlash(path)}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', this.accessToken);
    url.searchParams.set('appsecret_proof', this.appsecretProof());
    return this.send<T>(url, { method: 'GET' });
  }

  private async post<T>(path: string, form: FormData): Promise<T> {
    // Auth in the body rather than the query string: chunk uploads are logged and
    // proxied, and an access token in a URL ends up in every one of those logs.
    form.set('access_token', this.accessToken);
    form.set('appsecret_proof', this.appsecretProof());
    const url = new URL(`${this.baseUrl}/${stripLeadingSlash(path)}`);
    return this.send<T>(url, { method: 'POST', body: form });
  }

  private async send<T>(url: URL, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, init);

    const limits = parseRateLimitHeaders(res.headers);
    if (limits.versionWarning) {
      // Meta auto-upgraded this call. The chunked protocol is exactly the sort of thing
      // that changes shape between versions, so this must never be swallowed.
      console.warn(`[meta] API VERSION WARNING: ${limits.versionWarning}`);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? parseBigIntSafe(text) : {};
    } catch {
      const detail = `Non-JSON response from Meta (HTTP ${res.status}): ${text.slice(0, 400)}`;
      // An intermediary's HTML error page is an HTTP-level failure exactly like a bodyless
      // one, and has to classify the same way. Raised as a plain Error it was invisible to
      // `isWorthRetrying`, so the two callers that exist to survive a gateway blip did not:
      // `pollUntilReady` aborted on the first HTML 502 and sent the caller off to re-upload
      // a video Meta was already transcoding, while a bodyless 502 one second earlier would
      // have been absorbed. `code: -1` keeps it distinguishable from a real Graph error.
      if (!res.ok) throw new MetaApiError({ message: detail, code: -1 }, res.status);
      throw new Error(detail);
    }

    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (isGraphErrorBody(err)) throw new MetaApiError(err, res.status);
      throw new Error(`Unrecognised Meta error shape: ${JSON.stringify(err).slice(0, 400)}`);
    }
    if (!res.ok) {
      throw new MetaApiError({ message: text.slice(0, 400), code: -1 }, res.status);
    }
    return parsed as T;
  }
}

/* ------------------------------------------------------------------ free helpers --- */

/**
 * `act_` belongs in the path and the account id never belongs in a body. Both mistakes
 * surface as a generic error 100, which is why this refuses anything ambiguous rather
 * than guessing.
 */
export function normaliseAdAccountPath(adAccountId: string): string {
  const id = adAccountId.trim();
  if (id.length === 0) throw new Error('adAccountId is empty');
  const bare = id.startsWith('act_') ? id.slice(4) : id;
  if (!/^\d+$/.test(bare)) {
    throw new Error(
      `adAccountId "${adAccountId}" is not "act_<digits>" or "<digits>". Passing a name, a URL or a ` +
        `business id here produces an opaque error 100 from Meta.`,
    );
  }
  return `act_${bare}`;
}

/**
 * Dig the resume offsets out of a failed chunk upload.
 *
 * `error_data` is documented as a string on some error shapes and arrives as an object
 * on others, so both are handled. Returning `undefined` means "this error carries no
 * offsets" — the caller must then decide from the disposition alone.
 */
export function resumeOffsetsFromError(
  err: unknown,
): { startOffset: number; endOffset: number | undefined } | undefined {
  if (!(err instanceof MetaApiError)) return undefined;
  const raw = (err.body as unknown as Record<string, unknown>)['error_data'];
  let data: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      data = asRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    data = raw as Record<string, unknown>;
  } else {
    return undefined;
  }

  const start = optionalOffset(data['start_offset']);
  if (start === undefined) return undefined;
  return { startOffset: start, endOffset: optionalOffset(data['end_offset']) };
}

export function parseVideoStatus(videoId: string, body: Record<string, unknown>): VideoProcessingStatus {
  const status = asRecord(body['status']);
  const videoStatus = typeof status['video_status'] === 'string' ? status['video_status'] : '';
  if (videoStatus === '') {
    // The public Video node reference no longer lists `status`; the field still works.
    // An empty one means the read was wrong (fields param, or a token that cannot see
    // the asset — error 222), not that the video is fine.
    throw new Error(
      `GET /${videoId}?fields=status returned no status.video_status: ${JSON.stringify(body).slice(0, 400)}. ` +
        `Use the same system-user token that uploaded the video; a user token returns 222 "Video not visible".`,
    );
  }
  return {
    videoId,
    videoStatus,
    processingProgress: toNumberOrUndefined(status['processing_progress']),
    uploadingPhase: parsePhase(status['uploading_phase']),
    processingPhase: parsePhase(status['processing_phase']),
    publishingPhase: parsePhase(status['publishing_phase']),
    raw: body,
  };
}

function parsePhase(raw: unknown): VideoPhase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const errors = p['errors'];
  const errorRecord = asRecord(p['error']);
  let message = typeof errorRecord['message'] === 'string' ? errorRecord['message'] : undefined;
  // Reels responses carry `errors: []`; the other guide carries `error: {}`. Both are
  // "no error" when empty, which is why an empty object must not read as a failure.
  if (message === undefined && Array.isArray(errors) && errors.length > 0) {
    const first = asRecord(errors[0]);
    if (typeof first['message'] === 'string') message = first['message'];
  }
  return {
    status: typeof p['status'] === 'string' ? p['status'] : undefined,
    bytesTransfered: toNumberOrUndefined(p['bytes_transfered']),
    sourceFileSize: toNumberOrUndefined(p['source_file_size']),
    errorMessage: message,
  };
}

/** The 3am message. Name the phase, the state and Meta's own words — nothing else is available. */
function describeFailure(videoId: string, s: VideoProcessingStatus): string {
  const parts = [`Video ${videoId} failed processing: video_status="${s.videoStatus}"`];
  for (const [label, phase] of [
    ['uploading_phase', s.uploadingPhase],
    ['processing_phase', s.processingPhase],
    ['publishing_phase', s.publishingPhase],
  ] as const) {
    if (!phase) continue;
    if (phase.status?.toLowerCase() === 'error' || phase.errorMessage) {
      parts.push(`${label}.status=${phase.status ?? 'unknown'}${phase.errorMessage ? ` ("${phase.errorMessage}")` : ''}`);
    }
  }
  if (s.processingProgress !== undefined) parts.push(`processing_progress=${s.processingProgress}%`);
  if (s.videoStatus.toLowerCase() === 'expired') {
    parts.push('expired means the ad-account asset is gone — re-upload; do not cache video ids indefinitely');
  }
  return parts.join('; ');
}

function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof MetaApiError)) return false;
  return !isWorthRetrying(err);
}

/**
 * Whether a failed chunk deserves another attempt — and, equivalently, whether the upload
 * session must be KEPT rather than cancelled.
 *
 * `classify()` maps anything it does not recognise to PERMANENT, which is the right
 * default for a write that might spend money. It is the wrong default here. `send()`
 * synthesises `MetaApiError({code: -1}, httpStatus)` for an HTTP failure that carried no
 * Graph error body — a load balancer 502, a 503 during a Meta deploy, a 504 on a slow
 * multipart POST — and large multipart POSTs are exactly the requests intermediaries
 * mangle. Treating those as permanent aborted the transfer on the first blip AND
 * cancelled the session, turning a one-second gateway hiccup into a full re-upload of up
 * to 4 GB. Nothing about a chunk transfer is money-sensitive: offsets are absolute, so
 * re-sending a window is idempotent by construction.
 */
function isWorthRetrying(err: MetaApiError): boolean {
  if (err.retryable) return true;
  // AMBIGUOUS (codes 1/2) may mean the bytes landed. Re-sending the window is safe.
  if (err.disposition === 'AMBIGUOUS') return true;
  // code -1 is this module's marker for "HTTP error, no Graph error body". A real Graph
  // error (352, 100, 190...) keeps its permanent classification whatever the status was.
  return err.code === -1 && (err.httpStatus >= 500 || err.httpStatus === 429 || err.httpStatus === 408);
}

function toOffset(v: unknown, label: string): number {
  const n = optionalOffset(v);
  if (n === undefined) {
    throw new Error(`advideos response has a missing or unusable ${label}: ${JSON.stringify(v)}`);
  }
  return n;
}

function assertTitleLength(title: string | undefined): void {
  if (title === undefined) return;
  // Count code points, not UTF-16 units: an emoji is one character to a human and two
  // here. Meta warns it may count some characters as MORE than one, so a title that only
  // just fits is still a risk — this catches the obvious overrun, not the marginal one.
  const chars = [...title].length;
  if (chars >= MAX_VIDEO_TITLE_CHARS) {
    throw new Error(
      `advideos title is ${chars} characters; Meta documents "must be less than 255 characters" and ` +
        `counts some special characters as more than one. Refusing now rather than failing with a ` +
        `generic error 100 in the finish phase, after the whole file has been uploaded.`,
    );
  }
}

function optionalOffset(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  // Offsets come back as numeric STRINGS on this edge.
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function toNumberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function toNumberOr(v: unknown, fallback: number): number {
  return toNumberOrUndefined(v) ?? fallback;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function simulatedId(kind: string, seed: string): string {
  return `simulated_${kind}_${createHmac('sha256', 'simulate').update(seed).digest('hex').slice(0, 16)}`;
}
