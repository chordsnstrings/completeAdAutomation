/**
 * ffmpeg assembly: command CONSTRUCTION, output PARSING, and a thin injected runner.
 *
 * WHY THE SHAPE IS "PURE FUNCTIONS + INJECTED RUNNER"
 * Every function here that matters returns an argv array or parses a fixed string.
 * Nothing in this file spawns a process except `createChildProcessRunner`, and every
 * caller takes the runner as a parameter. That is not testing ceremony: an ad-render
 * bug is only ever visible in the argv (a missing `setsar=1`, a wrong `xfade` offset,
 * a `loudnorm` second pass built from the wrong measurement) and those are all
 * assertable without ffmpeg on the box. The render itself has nothing left to test.
 *
 * THE THREE KNOWN-BAD DEFAULTS, FIXED HERE BY CONSTRUCTION
 * (docs/research/creative-production-pipeline.md §12.3, §12.4, §12.6 — all [MEASURED])
 *   1. `pad` after `scale=...force_original_aspect_ratio` yields SAR 2025:2024, i.e.
 *      NON-SQUARE PIXELS, and Meta's ads guide requires "square pixels". No visual
 *      inspection catches it. Every geometry chain built here TERMINATES in `setsar=1`.
 *   2. Single-pass `loudnorm` outputs 192 kHz audio against Meta's 48 kHz ceiling.
 *      There is no single-pass builder in this file; `buildLoudnormFilter` requires a
 *      parsed measurement and always appends `aresample=48000`.
 *   3. `+faststart` is not the default, so `moov` lands after `mdat` and Meta answers
 *      with error 6000. `buildEncodeArgs` has no switch to turn it off.
 *
 * ffmpeg is NOT installed in this environment, so nothing here has been executed
 * end-to-end. The command shapes and the sample outputs the parsers are written
 * against are the [MEASURED] ones recorded in the dossier against ffmpeg 7.0.2-static.
 *
 * Sources: docs/research/creative-production-pipeline.md §§11-15,
 *          docs/research/meta-video-creative.md §§1.6, 7.5, 9.
 */

import { execFile } from 'node:child_process';
import { AD_VIDEO_SPEC, type VideoFileMetadata } from '../meta/videoUpload.ts';

/* =================================================================== runner ======= */

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Contract: `run` RESOLVES for any process that actually started, including one that
 * exited non-zero — the caller decides what a non-zero exit means. It REJECTS only when
 * the binary could not be spawned at all, which is how "ffmpeg is not installed" is
 * distinguished from "ffmpeg ran and hated the input".
 */
export interface CommandRunner {
  run(bin: string, args: readonly string[]): Promise<CommandResult>;
}

export interface FfmpegTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly runner: CommandRunner;
}

export class FfmpegMissingError extends Error {
  readonly binary: string;

  constructor(binary: string, detail: string) {
    super(
      `ffmpeg toolchain binary "${binary}" could not be executed (${detail}). ` +
        `The assembly stage cannot run without it — install ffmpeg/ffprobe in the render ` +
        `image and pin the version, because x264 build changes invalidate the content-addressed ` +
        `render cache (creative-production-pipeline.md §15.3).`,
    );
    this.name = 'FfmpegMissingError';
    this.binary = binary;
  }
}

export class FfmpegFailedError extends Error {
  readonly binary: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(binary: string, args: readonly string[], result: CommandResult) {
    const diagnosis = diagnoseFfmpegStderr(result.stderr);
    super(
      `${binary} exited ${result.code ?? 'by signal'}: ${diagnosis ?? lastStderrLine(result.stderr)}\n` +
        `  argv: ${args.join(' ')}`,
    );
    this.name = 'FfmpegFailedError';
    this.binary = binary;
    this.args = args;
    this.code = result.code;
    this.stderr = result.stderr;
  }
}

/** Raised when a plan is impossible before a single frame is encoded. */
export class AssemblyPlanError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length > 0 ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'AssemblyPlanError';
    this.problems = problems;
  }
}

/**
 * ffmpeg's stderr is a wall of text whose last line is often useless. These signatures
 * are the failures the dossier actually hit; naming the cause matters because the reader
 * is a log at 3am, not a person with the terminal open.
 */
export function diagnoseFfmpegStderr(stderr: string): string | undefined {
  const drawtext = /Unknown filter '(drawtext)'|No such filter: '(drawtext)'/.exec(stderr);
  if (drawtext) {
    return (
      `this build has no "drawtext" filter. libharfbuzz became a hard dependency for it at ` +
      `FFmpeg n6.1 and common static builds omit it. Do not use drawtext at all — the text ` +
      `system here is libass ("ass"/"subtitles"), which is dependency-stable and strictly more capable.`
    );
  }
  const unknownFilter = /(?:Unknown filter '|No such filter: ')([^']+)'/.exec(stderr);
  if (unknownFilter?.[1] !== undefined) {
    return `this build has no "${unknownFilter[1]}" filter — check the render image's ffmpeg configure flags`;
  }
  if (/width not divisible by 2|height not divisible by 2/.test(stderr)) {
    return (
      `libx264 refused an odd output dimension. A scale with force_original_aspect_ratio can ` +
      `compute a fractional size; every scale built here passes force_divisible_by=2, so an odd ` +
      `dimension means a hand-written filter string got into the graph.`
    );
  }
  if (/Unknown encoder '(libx264|aac)'/.test(stderr)) {
    return `the render image's ffmpeg was built without the required encoder: ${lastStderrLine(stderr)}`;
  }
  if (/Fontconfig error|Cannot find font|fontselect/.test(stderr)) {
    return (
      `libass could not resolve a font. Render containers routinely ship no Inter/Helvetica/Arial ` +
      `(the dossier's had 59 fonts and none of those). Bake brand fonts into the image and pass ` +
      `fontsdir to the ass filter.`
    );
  }
  const noStream = /Stream map '([^']+)' matches no streams/.exec(stderr);
  if (noStream?.[1] !== undefined) {
    return (
      `the input has no stream matching "${noStream[1]}". [MEASURED] this is what a silent ` +
      `generated clip does to buildReframeCommand, whose default withAudio maps 0:a: ffmpeg ` +
      `exits 234 and its last line is the useless "Error opening output files: Invalid argument". ` +
      `Either the clip really has no audio track (pass encode.withAudio: false) or the wrong ` +
      `input index was mapped.`
    );
  }
  if (/No such file or directory/.test(stderr)) {
    return `an input path does not exist: ${lastStderrLine(stderr)}`;
  }
  if (/Invalid data found when processing input/.test(stderr)) {
    return `an input file is truncated or not a media file: ${lastStderrLine(stderr)}`;
  }
  return undefined;
}

function lastStderrLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '(no stderr)';
}

/**
 * The only place in this module that touches `child_process`. Kept out of every other
 * function so tests never need a real binary.
 */
export function createChildProcessRunner(
  opts: { readonly maxBufferBytes?: number; readonly timeoutMs?: number } = {},
): CommandRunner {
  // ffmpeg's stderr for a long render is large; the default 1 MB truncates and takes the
  // loudnorm JSON with it, which then fails to parse for a reason that looks unrelated.
  const maxBuffer = opts.maxBufferBytes ?? 32 * 1024 * 1024;
  return {
    run(bin, args) {
      return new Promise<CommandResult>((resolve, reject) => {
        execFile(
          bin,
          [...args],
          {
            maxBuffer,
            ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
            encoding: 'utf8' as const,
          },
          (err, stdout, stderr) => {
            const errno = (err as NodeJS.ErrnoException | null)?.code;
            if (errno === 'ENOENT' || errno === 'EACCES') {
              reject(new FfmpegMissingError(bin, String(errno)));
              return;
            }
            const code =
              err && typeof (err as { code?: unknown }).code === 'number'
                ? ((err as { code: number }).code)
                : err
                  ? null
                  : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    },
  };
}

/** Runs a tool and turns a non-zero exit into an error that names the actual cause. */
export async function runTool(
  runner: CommandRunner,
  bin: string,
  args: readonly string[],
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runner.run(bin, args);
  } catch (e) {
    if (e instanceof FfmpegMissingError) throw e;
    throw new FfmpegMissingError(bin, e instanceof Error ? e.message : String(e));
  }
  if (result.code !== 0) throw new FfmpegFailedError(bin, args, result);
  return result;
}

export function parseToolVersion(stdout: string): string | undefined {
  // "ffmpeg version 7.0.2-static https://..." / "ffprobe version n6.1.1 ..."
  const m = /^\s*(?:ffmpeg|ffprobe) version (\S+)/m.exec(stdout);
  return m?.[1];
}

/**
 * Runtime presence check. Call it once at pipeline start, not per render: discovering a
 * missing binary after twelve paid clip generations is the expensive ordering.
 */
export async function assertToolchain(
  tools: FfmpegTools,
): Promise<{ readonly ffmpeg: string | undefined; readonly ffprobe: string | undefined }> {
  const ffmpeg = await runTool(tools.runner, tools.ffmpeg, ['-hide_banner', '-version']);
  const ffprobe = await runTool(tools.runner, tools.ffprobe, ['-hide_banner', '-version']);
  return { ffmpeg: parseToolVersion(ffmpeg.stdout), ffprobe: parseToolVersion(ffprobe.stdout) };
}

/**
 * Filters this module can emit. `drawtext` is deliberately absent — see
 * `diagnoseFfmpegStderr`. A build that lacks any of these fails at RENDER time, in
 * production, so the check belongs at startup.
 */
export const REQUIRED_FILTERS: readonly string[] = [
  'ass', 'scale', 'crop', 'pad', 'setsar', 'fps', 'format', 'split', 'overlay', 'gblur',
  'concat', 'xfade', 'acrossfade', 'aformat', 'aresample', 'loudnorm', 'sendcmd',
  'blackdetect', 'freezedetect', 'silencedetect', 'ebur128', 'signalstats', 'metadata', 'tile',
];

export function buildFilterListCommand(): readonly string[] {
  return ['-hide_banner', '-filters'];
}

/** Parses `ffmpeg -filters`: lines are `<3 flag chars> <name> <in->out> <description>`. */
export function parseFilterNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*[TSC.]{3}\s+(\S+)\s+\S+->\S+/.exec(line);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return names;
}

export function assertFiltersAvailable(
  available: ReadonlySet<string>,
  required: readonly string[] = REQUIRED_FILTERS,
): void {
  const missing = required.filter((f) => !available.has(f));
  if (missing.length === 0) return;
  const hint = missing.includes('ass')
    ? ' "ass" missing means the build has no libass; the entire caption system depends on it.'
    : '';
  throw new AssemblyPlanError(
    `this ffmpeg build is missing filters the assembly stage emits.${hint}`,
    missing,
  );
}

/* ============================================================== render matrix ===== */

export type CutName = '9:16' | '4:5' | '1:1' | '16:9';

export interface Canvas {
  readonly width: number;
  readonly height: number;
}

/**
 * From meta-video-creative.md §7.5. `derive` is the honest part: 16:9 is marked
 * `regenerate` because deriving it from a 9:16 master is a 68% crop of the wrong axis,
 * and the dossier says do not do it.
 */
export const RENDER_MATRIX: Readonly<
  Record<
    CutName,
    {
      readonly canvas: Canvas;
      readonly derive: 'master' | 'centre-crop' | 'regenerate';
      readonly placements: readonly string[];
    }
  >
> = {
  '9:16': {
    canvas: { width: 1080, height: 1920 },
    derive: 'master',
    placements: [
      'instagram:reels', 'instagram:story', 'instagram:profile_reels',
      'facebook:facebook_reels', 'facebook:story', 'threads:threads_stream',
    ],
  },
  '4:5': {
    canvas: { width: 1080, height: 1350 },
    derive: 'centre-crop',
    placements: ['facebook:feed', 'instagram:stream', 'instagram:profile_feed'],
  },
  '1:1': {
    canvas: { width: 1080, height: 1080 },
    derive: 'centre-crop',
    // facebook_reels_overlay is 1:1 AND 4-15s only; the duration gate enforces the second half.
    placements: [
      'facebook:facebook_reels_overlay', 'facebook:marketplace', 'facebook:video_feeds',
      'facebook:search', 'instagram:ig_search', 'instagram:explore',
    ],
  },
  '16:9': {
    canvas: { width: 1920, height: 1080 },
    derive: 'regenerate',
    placements: ['audience_network:instream_video', 'facebook:instream_video'],
  },
};

export function canvasFor(cut: CutName): Canvas {
  return RENDER_MATRIX[cut].canvas;
}

export function aspectOf(canvas: Canvas): number {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new AssemblyPlanError(`canvas must be positive, got ${canvas.width}x${canvas.height}`);
  }
  return canvas.width / canvas.height;
}

/* ================================================================== reframing ==== */

export type ReframeStrategy = 'centre-crop' | 'scale-pad' | 'blur-pad' | 'tracked-crop';

/**
 * A naive centre crop that keeps less than half of an axis is refused.
 *
 * The two anchors, both [MEASURED] in the dossier: 9:16 -> 1:1 keeps 56.3% of the height
 * and is the tightest derivation the render matrix asks for; 16:9 -> 9:16 keeps 31.6% of
 * the WIDTH and "for an ad where the product is off-centre, that is a total loss".
 * 0.5 separates them and is a property of the geometry, not a special case for one pair.
 */
export const MIN_CENTRE_CROP_RETENTION = 0.5;

export interface ReframePlan {
  readonly from: Canvas;
  readonly to: Canvas;
  readonly strategy: ReframeStrategy;
  /** Which axis a crop would consume. 'none' when the ratios already match. */
  readonly axis: 'width' | 'height' | 'none';
  /** Fraction of `axis` retained by a centre crop, 0..1. */
  readonly retainedFraction: number;
  readonly safeForNaiveCrop: boolean;
  readonly notes: readonly string[];
}

export class UnsafeReframeError extends Error {
  readonly plan: ReframePlan;

  constructor(plan: ReframePlan) {
    super(
      `refusing to centre-crop ${plan.from.width}x${plan.from.height} -> ` +
        `${plan.to.width}x${plan.to.height}: it keeps only ` +
        `${(plan.retainedFraction * 100).toFixed(1)}% of the ${plan.axis}, below the ` +
        `${(MIN_CENTRE_CROP_RETENTION * 100).toFixed(0)}% floor. A centre crop this aggressive ` +
        `discards the subject whenever it is off-centre and nothing downstream can detect that. ` +
        `Choose explicitly: 'tracked-crop' (sendcmd-driven crop path from a subject tracker), ` +
        `'blur-pad' (keeps the whole frame, invents the edges), or regenerate at the target ratio. ` +
        `Generating the master at 9:16 makes this problem disappear.`,
    );
    this.name = 'UnsafeReframeError';
    this.plan = plan;
  }
}

export function planReframe(from: Canvas, to: Canvas, strategy: ReframeStrategy): ReframePlan {
  const aFrom = aspectOf(from);
  const aTo = aspectOf(to);
  const notes: string[] = [];

  let axis: 'width' | 'height' | 'none';
  let retained: number;
  if (Math.abs(aTo - aFrom) < 1e-9) {
    axis = 'none';
    retained = 1;
  } else if (aTo < aFrom) {
    // Target is narrower: a crop eats width.
    axis = 'width';
    retained = aTo / aFrom;
  } else {
    axis = 'height';
    retained = aFrom / aTo;
  }

  const safe = axis === 'none' || retained >= MIN_CENTRE_CROP_RETENTION;
  if (!safe) {
    notes.push(
      `a centre crop keeps ${(retained * 100).toFixed(1)}% of the ${axis}; the subject must be ` +
        `tracked or the frame extended`,
    );
  }
  if (strategy === 'scale-pad') {
    notes.push(
      'letterboxing wastes the scarcest resource in a Reels ad (screen area) and reads as ' +
        'repurposed content; prefer crop or blur-pad unless a crop destroys the composition',
    );
  }
  if (to.width > AD_VIDEO_SPEC.maxHorizontalPixels) {
    notes.push(
      `target width ${to.width}px exceeds the 1920 horizontal pixel maximum (Instagram's organic ` +
        `publishing spec, which this pipeline encodes inside)`,
    );
  }
  return { from, to, strategy, axis, retainedFraction: retained, safeForNaiveCrop: safe, notes };
}

export interface GraphLabels {
  /** Defaults to '0:v'. */
  readonly inLabel?: string;
  /** Defaults to 'v'. */
  readonly outLabel?: string;
}

export interface TrackedCropOptions {
  /** Path to a sendcmd script produced by `renderSendCmdScript`. */
  readonly commandFile: string;
  /** Starting crop origin, used until the first command fires. */
  readonly initialX: number;
  readonly initialY: number;
}

/**
 * Builds a filter_complex fragment that reframes one labelled input to one labelled
 * output. Every branch terminates in `setsar=1` — that is the whole point of the
 * function existing rather than callers writing scale/crop by hand.
 */
export function buildReframeGraph(
  plan: ReframePlan,
  labels: GraphLabels = {},
  tracked?: TrackedCropOptions,
): string {
  const inL = labels.inLabel ?? '0:v';
  const outL = labels.outLabel ?? 'v';
  const w = plan.to.width;
  const h = plan.to.height;

  switch (plan.strategy) {
    case 'centre-crop': {
      if (!plan.safeForNaiveCrop) throw new UnsafeReframeError(plan);
      return `[${inL}]${centreCropChain(w, h)}[${outL}]`;
    }
    case 'scale-pad':
      // setsar=1 LAST: pad inherits the non-square SAR that force_original_aspect_ratio
      // sets when it rounds a fractional dimension. [MEASURED] SAR 2025:2024 without it.
      return (
        `[${inL}]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${outL}]`
      );
    case 'blur-pad': {
      const bg = `${outL}_bg`;
      const fg = `${outL}_fg`;
      return (
        `[${inL}]split=2[${bg}][${fg}];` +
        `[${bg}]scale=${w}:${h}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
        `crop=${w}:${h},gblur=sigma=40[${bg}b];` +
        `[${fg}]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2[${fg}s];` +
        `[${bg}b][${fg}s]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1[${outL}]`
      );
    }
    case 'tracked-crop': {
      if (tracked === undefined) {
        throw new AssemblyPlanError(
          `'tracked-crop' needs a sendcmd command file; build one with renderSendCmdScript(). ` +
            `Note cropdetect is NOT a subject detector — [MEASURED] it returns the full frame on ` +
            `non-letterboxed content. The tracker is yours; sendcmd is the stable interface.`,
        );
      }
      const win = computeCropWindow(plan.from, plan.to);
      // crop's w/h are fixed at graph-build time; only x/y are runtime-settable, which is
      // exactly what sendcmd can drive.
      return (
        `[${inL}]sendcmd=f=${escapeFilterArgument(tracked.commandFile)},` +
        `crop=w=${win.width}:h=${win.height}:x=${Math.round(tracked.initialX)}:y=${Math.round(tracked.initialY)},` +
        `scale=${w}:${h}:force_divisible_by=2,setsar=1[${outL}]`
      );
    }
    default: {
      const never: never = plan.strategy;
      throw new AssemblyPlanError(`unknown reframe strategy ${String(never)}`);
    }
  }
}

function centreCropChain(w: number, h: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${w}:${h},setsar=1`;
}

/** The largest window of the target aspect that fits inside the source. Always even. */
export function computeCropWindow(
  from: Canvas,
  to: Canvas,
): { readonly width: number; readonly height: number; readonly axis: 'width' | 'height' | 'none' } {
  const aFrom = aspectOf(from);
  const aTo = aspectOf(to);
  if (Math.abs(aTo - aFrom) < 1e-9) return { width: from.width, height: from.height, axis: 'none' };
  if (aTo < aFrom) {
    // 1920x1080 -> 9:16 gives 1080 * 0.5625 = 607.5 -> 608. Odd widths are a hard
    // libx264 failure, not a warning. [MEASURED] "width not divisible by 2 (759x1350)".
    return { width: evenClamp(from.height * aTo, from.width), height: from.height, axis: 'width' };
  }
  return { width: from.width, height: evenClamp(from.width / aTo, from.height), axis: 'height' };
}

function evenClamp(value: number, max: number): number {
  const rounded = 2 * Math.round(value / 2);
  const capped = Math.min(rounded, 2 * Math.floor(max / 2));
  return Math.max(2, capped);
}

/* ------------------------------------------------------------- crop path (9:16) -- */

export interface CropSample {
  readonly timeSeconds: number;
  /** Subject centre in SOURCE pixel coordinates. */
  readonly centreX: number;
  readonly centreY: number;
}

export interface CropPoint {
  readonly timeSeconds: number;
  readonly x: number;
  readonly y: number;
}

export interface CropPathOptions {
  /** EMA coefficient. 0.1 reads as a camera pan; 1.0 reproduces the raw detections. */
  readonly emaAlpha?: number;
  /** Pixels per FRAME. Above ~15 the move stops reading as a pan and starts reading as a glitch. */
  readonly maxVelocityPxPerFrame?: number;
  readonly fps: number;
}

/**
 * Turns raw tracker detections into a crop path that will not jitter.
 *
 * Feed this samples at 5-10 Hz, not per frame: sendcmd interpolates nothing, so a
 * per-frame command file is large and buys nothing once the path is smoothed. Both the
 * EMA and the velocity clamp are load-bearing — raw per-frame detections visibly shake.
 */
export function smoothCropPath(
  samples: readonly CropSample[],
  from: Canvas,
  crop: { readonly width: number; readonly height: number },
  opts: CropPathOptions,
): readonly CropPoint[] {
  const alpha = opts.emaAlpha ?? 0.1;
  const maxV = opts.maxVelocityPxPerFrame ?? 15;
  if (alpha <= 0 || alpha > 1) {
    throw new AssemblyPlanError(`emaAlpha must be in (0, 1], got ${alpha}`);
  }
  if (!(opts.fps > 0)) throw new AssemblyPlanError(`fps must be positive, got ${opts.fps}`);

  const maxX = Math.max(0, from.width - crop.width);
  const maxY = Math.max(0, from.height - crop.height);
  const out: CropPoint[] = [];

  let smoothX: number | undefined;
  let smoothY: number | undefined;
  let prevTime: number | undefined;

  for (const s of samples) {
    const wantX = clamp(s.centreX - crop.width / 2, 0, maxX);
    const wantY = clamp(s.centreY - crop.height / 2, 0, maxY);

    if (smoothX === undefined || smoothY === undefined || prevTime === undefined) {
      smoothX = wantX;
      smoothY = wantY;
    } else {
      const emaX = smoothX + alpha * (wantX - smoothX);
      const emaY = smoothY + alpha * (wantY - smoothY);
      // Velocity budget is per frame, so the allowance scales with the gap between samples.
      const frames = Math.max(1, (s.timeSeconds - prevTime) * opts.fps);
      const budget = maxV * frames;
      smoothX = clamp(emaX, smoothX - budget, smoothX + budget);
      smoothY = clamp(emaY, smoothY - budget, smoothY + budget);
    }
    prevTime = s.timeSeconds;
    out.push({
      timeSeconds: s.timeSeconds,
      x: Math.round(clamp(smoothX, 0, maxX)),
      y: Math.round(clamp(smoothY, 0, maxY)),
    });
  }
  return out;
}

/** sendcmd script: `TIME target command arg[, target command arg];` one line per keyframe. */
export function renderSendCmdScript(path: readonly CropPoint[]): string {
  return path.map((p) => `${num(p.timeSeconds, 3)} crop x ${p.x}, crop y ${p.y};`).join('\n') + '\n';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ============================================================ concat / xfade ===== */

/** [MEASURED] full transition enum in ffmpeg 7.0.2. */
export const XFADE_TRANSITIONS = [
  'custom', 'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright',
  'slideup', 'slidedown', 'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite',
  'radial', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'circleopen', 'circleclose',
  'vertopen', 'vertclose', 'horzopen', 'horzclose', 'dissolve', 'pixelize', 'diagtl', 'diagtr',
  'diagbl', 'diagbr', 'hlslice', 'hrslice', 'vuslice', 'vdslice', 'hblur', 'fadegrays', 'wipetl',
  'wipetr', 'wipebl', 'wipebr', 'squeezeh', 'squeezev', 'zoomin', 'fadefast', 'fadeslow',
  'hlwind', 'hrwind', 'vuwind', 'vdwind', 'coverleft', 'coverright', 'coverup', 'coverdown',
  'revealleft', 'revealright', 'revealup', 'revealdown',
] as const;
export type XfadeTransition = (typeof XFADE_TRANSITIONS)[number];

export const ACROSSFADE_CURVES = [
  'nofade', 'tri', 'qsin', 'esin', 'hsin', 'log', 'ipar', 'qua', 'squ', 'cbr', 'par', 'exp',
  'iqsin', 'ihsin', 'dese', 'desi', 'losi', 'sinc', 'isinc', 'quat', 'quatr', 'qsin2', 'hsin2',
] as const;
export type AcrossfadeCurve = (typeof ACROSSFADE_CURVES)[number];

export interface Transition {
  readonly kind: XfadeTransition;
  readonly durationSeconds: number;
  readonly audioCurve?: AcrossfadeCurve;
}

export interface ClipInput {
  readonly path: string;
  readonly durationSeconds: number;
  /**
   * Source geometry, when it is known (the generation stage knows it — the provider
   * descriptor fixes the clip's aspect ratio before the clip is paid for).
   *
   * Supply it. The concat normalisation chain centre-crops every input to the canvas, so a
   * 16:9 clip dropped into a 9:16 ad loses 68% of its width in silence — the exact
   * derivation `buildReframeGraph` refuses. Given these, `buildConcatCommand` applies the
   * same refusal; without them it cannot, and the crop happens unchecked.
   */
  readonly width?: number;
  readonly height?: number;
}

/**
 * `xfade`'s `offset` is measured on the ACCUMULATING OUTPUT timeline, not on the source
 * clip. [MEASURED] 3x4s with 2x0.5s transitions runs 11.03s, not 12s.
 *
 *   offset_k = Σ_{i<=k} duration_i − Σ_{i<=k} transition_i   (k 0-indexed)
 */
export function crossfadeOffsets(
  durations: readonly number[],
  transitions: readonly number[],
): readonly number[] {
  const offsets: number[] = [];
  let d = 0;
  let t = 0;
  for (let k = 0; k < transitions.length; k += 1) {
    d += durations[k] ?? 0;
    t += transitions[k] ?? 0;
    offsets.push(d - t);
  }
  return offsets;
}

export function crossfadeTotalDuration(
  durations: readonly number[],
  transitions: readonly number[],
): number {
  const d = durations.reduce((a, b) => a + b, 0);
  const t = transitions.reduce((a, b) => a + b, 0);
  return d - t;
}

export interface ConcatRequest {
  readonly clips: readonly ClipInput[];
  readonly canvas: Canvas;
  readonly fps: number;
  readonly output: string;
  /** Must be exactly clips.length - 1 entries when present. Hard cuts otherwise. */
  readonly transitions?: readonly Transition[];
  /** Default true. A clip with no audio stream breaks the whole graph, so it is explicit. */
  readonly withAudio?: boolean;
  readonly encode?: Partial<EncodeOptions>;
}

export interface ConcatPlan {
  readonly args: readonly string[];
  readonly filterGraph: string;
  readonly expectedDurationSeconds: number;
}

/**
 * Concat with RE-ENCODE, always.
 *
 * The concat demuxer with `-c copy` requires byte-level codec/timebase/SAR identity
 * across inputs. Clips from different models — or the same model on different days —
 * differ, and the failure mode when you are unlucky is broken timestamps rather than an
 * error. The pipeline re-encodes for Meta anyway, so the saving is imaginary.
 *
 * The per-input normalisation chain is the concat filter's PRECONDITION, not decoration:
 * all video inputs must share width, height, SAR and pix_fmt, and all audio inputs must
 * share sample rate and channel layout.
 */
export function buildConcatCommand(req: ConcatRequest): ConcatPlan {
  const withAudio = req.withAudio ?? true;
  const n = req.clips.length;
  const problems: string[] = [];

  if (n === 0) problems.push('no clips supplied');
  for (const [i, c] of req.clips.entries()) {
    if (!(c.durationSeconds > 0)) {
      problems.push(`clip ${i} ("${c.path}") has non-positive duration ${c.durationSeconds}s`);
    }
    // The normalisation chain is a centre crop, so the retention floor has to hold here too
    // or it is trivially bypassed by routing the same geometry through concat instead of
    // buildReframeGraph. Only checkable when the caller stated the source geometry.
    if (c.width !== undefined && c.height !== undefined && c.width > 0 && c.height > 0) {
      const p = planReframe({ width: c.width, height: c.height }, req.canvas, 'centre-crop');
      if (!p.safeForNaiveCrop) {
        problems.push(
          `clip ${i} ("${c.path}") is ${c.width}x${c.height} and the canvas is ` +
            `${req.canvas.width}x${req.canvas.height}: normalisation would centre-crop it to ` +
            `${(p.retainedFraction * 100).toFixed(1)}% of its ${p.axis}, below the ` +
            `${(MIN_CENTRE_CROP_RETENTION * 100).toFixed(0)}% floor. Reframe it first with an explicit ` +
            `strategy (buildReframeCommand with 'tracked-crop' or 'blur-pad'), or regenerate the clip ` +
            `at the ad's ratio — concat must not be the back door around that refusal.`,
        );
      }
    }
  }
  const transitions = req.transitions ?? [];
  if (transitions.length > 0 && transitions.length !== n - 1) {
    problems.push(
      `${transitions.length} transition(s) for ${n} clip(s); xfade takes two inputs, so N clips ` +
        `need exactly N-1 transitions`,
    );
  }
  if (!(req.fps > 0)) problems.push(`fps must be positive, got ${req.fps}`);
  if (req.encode?.fps !== undefined && req.encode.fps !== req.fps) {
    // The normalisation chain pins fps INSIDE the graph. Encoding at a different -r would
    // resample the whole thing and drift the caption cues off the audio.
    problems.push(
      `encode.fps (${req.encode.fps}) contradicts the graph's fps (${req.fps}); set one of them`,
    );
  }
  if (problems.length > 0) throw new AssemblyPlanError('cannot build a concat command', problems);

  const durations = req.clips.map((c) => c.durationSeconds);
  const tDurations = transitions.map((t) => t.durationSeconds);

  const statements: string[] = [];
  for (let i = 0; i < n; i += 1) {
    statements.push(`[${i}:v]${normaliseVideoChain(req.canvas, req.fps)}[v${i}]`);
    if (withAudio) statements.push(`[${i}:a]${NORMALISE_AUDIO_CHAIN}[a${i}]`);
  }

  let expected: number;
  if (transitions.length === 0) {
    // [0:v][0:a][1:v][1:a]... concat=n=N:v=1:a=1[v][a] — the [MEASURED] interleaved form.
    const inputs: string[] = [];
    for (let i = 0; i < n; i += 1) {
      inputs.push(`[v${i}]`);
      if (withAudio) inputs.push(`[a${i}]`);
    }
    statements.push(`${inputs.join('')}concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? '[a]' : ''}`);
    expected = durations.reduce((a, b) => a + b, 0);
  } else {
    validateCrossfadePlan(durations, tDurations);
    const offsets = crossfadeOffsets(durations, tDurations);
    let vPrev = 'v0';
    let aPrev = 'a0';
    for (let k = 0; k < transitions.length; k += 1) {
      const tr = transitions[k];
      const off = offsets[k];
      if (tr === undefined || off === undefined) continue;
      const vOut = k === transitions.length - 1 ? 'v' : `vx${k}`;
      statements.push(
        `[${vPrev}][v${k + 1}]xfade=transition=${tr.kind}:duration=${num(tr.durationSeconds)}:` +
          `offset=${num(off)}[${vOut}]`,
      );
      vPrev = vOut;
      if (withAudio) {
        const aOut = k === transitions.length - 1 ? 'a' : `ax${k}`;
        const curve = tr.audioCurve ?? 'tri';
        statements.push(
          `[${aPrev}][a${k + 1}]acrossfade=d=${num(tr.durationSeconds)}:c1=${curve}:c2=${curve}[${aOut}]`,
        );
        aPrev = aOut;
      }
    }
    expected = crossfadeTotalDuration(durations, tDurations);
  }

  const graph = statements.join(';');
  const args: string[] = ['-hide_banner', '-nostdin', '-y'];
  for (const c of req.clips) args.push('-i', c.path);
  args.push('-filter_complex', graph, '-map', '[v]');
  if (withAudio) args.push('-map', '[a]');
  // `-an` (when there is no audio) comes from buildEncodeArgs, so there is one owner of it.
  args.push(...buildEncodeArgs({ ...(req.encode ?? {}), withAudio }, { fps: req.fps, canvas: req.canvas }));
  args.push(req.output);

  return { args, filterGraph: graph, expectedDurationSeconds: round3(expected) };
}

function normaliseVideoChain(canvas: Canvas, fps: number): string {
  return `${centreCropChain(canvas.width, canvas.height)},fps=${num(fps)},format=yuv420p`;
}

const NORMALISE_AUDIO_CHAIN =
  'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/**
 * xfade eats the tail of clip k and the head of clip k+1. If a transition is not shorter
 * than the clips it joins, the offsets stop increasing and the output is silently wrong
 * (or ffmpeg errors) — either way it is not something to discover after the render.
 */
export function validateCrossfadePlan(
  durations: readonly number[],
  transitions: readonly number[],
): void {
  const problems: string[] = [];
  const offsets = crossfadeOffsets(durations, transitions);
  for (let k = 0; k < transitions.length; k += 1) {
    const t = transitions[k];
    const before = durations[k];
    const after = durations[k + 1];
    if (t === undefined || before === undefined || after === undefined) continue;
    if (!(t > 0)) {
      problems.push(`transition ${k} has non-positive duration ${t}s`);
      continue;
    }
    if (t >= before || t >= after) {
      problems.push(
        `transition ${k} is ${t}s but joins clips of ${before}s and ${after}s; a crossfade must ` +
          `be shorter than both clips it consumes`,
      );
    }
    const off = offsets[k];
    const prev = k === 0 ? 0 : offsets[k - 1];
    if (off === undefined || prev === undefined) continue;
    if (off <= prev) {
      problems.push(
        `xfade offset ${k} is ${round3(off)}s, not after offset ${k - 1} (${round3(prev)}s) — ` +
          `offsets are on the accumulating OUTPUT timeline and must strictly increase`,
      );
    }
  }
  const total = crossfadeTotalDuration(durations, transitions);
  if (!(total > 0)) {
    problems.push(`transitions consume the whole ad: total would be ${round3(total)}s`);
  }
  if (problems.length > 0) throw new AssemblyPlanError('crossfade plan is not renderable', problems);
}

/* ============================================================== loudness (R128) == */

/**
 * −14 LUFS integrated / −1.0 dBTP is the de-facto streaming convention, NOT a documented
 * Meta requirement — the dossier marks Meta's actual loudness expectation UNVERIFIED.
 * It is here so the ad is not the one that blows out someone's earbuds.
 */
export const LOUDNESS_TARGET = {
  integratedLufs: -14,
  truePeakDb: -1.0,
  loudnessRangeLu: 11,
} as const;

export interface LoudnessTarget {
  readonly integratedLufs: number;
  readonly truePeakDb: number;
  readonly loudnessRangeLu: number;
}

export interface LoudnormMeasurement {
  readonly inputI: number;
  readonly inputTp: number;
  readonly inputLra: number;
  readonly inputThresh: number;
  readonly targetOffset: number;
  readonly normalizationType: string;
}

export class LoudnormParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoudnormParseError';
  }
}

export function buildLoudnormMeasureCommand(
  input: string,
  target: LoudnessTarget = LOUDNESS_TARGET,
): readonly string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-af', `loudnorm=I=${num(target.integratedLufs)}:TP=${num(target.truePeakDb)}:LRA=${num(target.loudnessRangeLu)}:print_format=json`,
    '-f', 'null', '-',
  ];
}

/**
 * The measurement is the LAST JSON object on stderr. Walks back from the final `}` and
 * brace-matches, rather than `lastIndexOf('{')`, so a future nested field does not
 * silently truncate the object.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement {
  const end = stderr.lastIndexOf('}');
  if (end < 0) {
    throw new LoudnormParseError(
      'no JSON object on loudnorm stderr. Either print_format=json was omitted, or the stderr ' +
        'buffer was truncated (raise the runner maxBuffer — a long render overflows the 1 MB default).',
    );
  }
  let depth = 0;
  let start = -1;
  for (let i = end; i >= 0; i -= 1) {
    const ch = stderr[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      depth -= 1;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) throw new LoudnormParseError('unbalanced braces in loudnorm output');

  let raw: unknown;
  try {
    raw = JSON.parse(stderr.slice(start, end + 1));
  } catch (e) {
    throw new LoudnormParseError(`loudnorm JSON did not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new LoudnormParseError('loudnorm JSON was not an object');
  }
  const obj = raw as Record<string, unknown>;
  // Every value is a STRING in loudnorm's output, including "-inf".
  const field = (key: string): number => {
    const v = obj[key];
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new LoudnormParseError(`loudnorm JSON is missing "${key}"; got keys: ${Object.keys(obj).join(', ')}`);
    }
    // loudnorm writes "-inf" (not "-Infinity") for silence, which Number() reads as NaN.
    // Mapping it to -Infinity is what lets the silence case below produce its own message
    // instead of a generic "not numeric".
    const text = String(v).trim();
    const n = /^-?inf(inity)?$/i.test(text) ? (text.startsWith('-') ? -Infinity : Infinity) : Number(text);
    if (Number.isNaN(n)) throw new LoudnormParseError(`loudnorm "${key}" is not numeric: ${text}`);
    return n;
  };

  const inputI = field('input_i');
  if (!Number.isFinite(inputI)) {
    // loudnorm reports -inf for digital silence. Feeding that back as measured_I produces
    // a meaningless second pass; the real fault is upstream in the mix or the VO.
    throw new LoudnormParseError(
      `loudnorm measured input_i=${obj['input_i']} — the input is digital silence. Two-pass ` +
        `normalisation cannot fix that; the mix or the voiceover stage produced no audio.`,
    );
  }
  const normalizationType = typeof obj['normalization_type'] === 'string' ? obj['normalization_type'] : 'unknown';
  return {
    inputI,
    inputTp: field('input_tp'),
    inputLra: field('input_lra'),
    inputThresh: field('input_thresh'),
    targetOffset: field('target_offset'),
    normalizationType,
  };
}

/**
 * Pass two. `linear=true` is what keeps the sample rate at 48 kHz and makes the gain
 * predictable; `aresample=48000` is belt and braces because [MEASURED] single-pass
 * (dynamic) loudnorm emits 192 kHz, which is 4x Meta's ceiling and perturbs sample counts
 * for anything doing cue placement.
 */
export function buildLoudnormFilter(
  m: LoudnormMeasurement,
  target: LoudnessTarget = LOUDNESS_TARGET,
): string {
  return (
    `loudnorm=I=${num(target.integratedLufs)}:TP=${num(target.truePeakDb)}:LRA=${num(target.loudnessRangeLu)}:` +
    `measured_I=${num(m.inputI)}:measured_TP=${num(m.inputTp)}:measured_LRA=${num(m.inputLra)}:` +
    `measured_thresh=${num(m.inputThresh)}:offset=${num(m.targetOffset)}:linear=true,aresample=48000`
  );
}

export function buildLoudnormApplyCommand(
  input: string,
  output: string,
  m: LoudnormMeasurement,
  target: LoudnessTarget = LOUDNESS_TARGET,
): readonly string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-af', buildLoudnormFilter(m, target),
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    // Same goal as buildEncodeArgs — no `elst` — but NOT the same flags, and the difference
    // is measured, not stylistic. This pass re-muxes, so it re-creates the edit list the
    // encode pass was careful not to write: [MEASURED] with `+faststart` alone the output
    // carries edit lists on BOTH tracks and fails gateContainerSpec, even though `-c:v copy`
    // never touches a frame.
    //
    // On a COPY the reorder delay is already baked into the packet timestamps, so
    // `-use_editlist 0` on its own leaves the track duration at 12.063s over 289 frames ->
    // avg_frame_rate 289000/12063 = 23.958 against r_frame_rate 24/1, and parseProbeJson
    // then reports a perfectly constant file as VFR. Adding `+negative_cts_offsets` here
    // restores duration 12.041667s / avg 24/1 / start_time 0.000000 with no elst.
    // buildEncodeArgs wants the opposite pairing for the same reason inverted — see its doc.
    '-movflags', '+faststart+negative_cts_offsets', '-use_editlist', '0',
    output,
  ];
}

/* ================================================================== captions ===== */

/**
 * Meta publishes two safe-zone numbers: 14%/35%/6% on the Reels & Stories ad pages, and
 * 14%/20% on the Facebook Stories page. The stricter set is used everywhere here.
 * On 1080x1920 that leaves x∈[64,1015], y∈[268,1248] — 25% of the canvas. Compose to it
 * from the keyframe prompt onward; it cannot be retrofitted.
 */
export const SAFE_ZONE = {
  topFraction: 0.14,
  bottomFraction: 0.35,
  sideFraction: 0.06,
} as const;

export interface SafeZoneBox {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export function safeZoneBox(canvas: Canvas): SafeZoneBox {
  // floor() on both edges, matching the [MEASURED] gate: 1080x1920 -> 64,1015,268,1248.
  return {
    x0: Math.floor(SAFE_ZONE.sideFraction * canvas.width),
    x1: Math.floor(canvas.width - SAFE_ZONE.sideFraction * canvas.width),
    y0: Math.floor(SAFE_ZONE.topFraction * canvas.height),
    y1: Math.floor(canvas.height - SAFE_ZONE.bottomFraction * canvas.height),
  };
}

/**
 * ASS colours are `&HAABBGGRR` — BGR order with an INVERTED alpha where 00 is opaque —
 * and ASS booleans are -1/0, not 1/0. Both are 30-minute debugging sessions per brand if
 * you write them by hand, which is why this exists rather than a literal in a template.
 */
export function assColour(hexRgb: string, alphaPercent = 0): string {
  const hex = hexRgb.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new AssemblyPlanError(`assColour expects a 6-digit RGB hex, got "${hexRgb}"`);
  }
  if (alphaPercent < 0 || alphaPercent > 100) {
    throw new AssemblyPlanError(`alphaPercent must be 0..100 (0 = fully opaque), got ${alphaPercent}`);
  }
  const rr = hex.slice(0, 2);
  const gg = hex.slice(2, 4);
  const bb = hex.slice(4, 6);
  const aa = Math.round((alphaPercent / 100) * 255).toString(16).padStart(2, '0');
  return `&H${(aa + bb + gg + rr).toUpperCase()}`;
}

/** ASS timestamps are `H:MM:SS.CC` — centiseconds, single-digit hours. */
export function assTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new AssemblyPlanError(`assTimestamp needs a non-negative finite time, got ${seconds}`);
  }
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export interface AssStyle {
  readonly name: string;
  readonly fontName: string;
  readonly fontSizePx: number;
  readonly primaryColour: string;
  readonly outlineColour: string;
  readonly backColour: string;
  readonly bold: boolean;
  /** 1 = outline+shadow, 3 = opaque box. Never ship captions with neither. */
  readonly borderStyle: 1 | 3;
  readonly outline: number;
  readonly shadow: number;
  /** libass numpad alignment; 2 = bottom centre. */
  readonly alignment: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly marginVertical: number;
}

/**
 * The [MEASURED] safe-zone-correct style. `marginVertical = 0.35 x height` puts the
 * caption bottom exactly on Meta's strict bottom boundary: on 1080x1920 the rendered bbox
 * was (223,1187)-(859,1234) against a limit of y <= 1248, i.e. inside with 14px to spare.
 */
export function defaultCaptionStyle(canvas: Canvas): AssStyle {
  return {
    name: 'Cap',
    fontName: 'DejaVu Sans',
    // 72px at 1920 tall. Scaled by height so a 1080-tall cut is not captioned in giant type.
    fontSizePx: Math.round(canvas.height * (72 / 1920)),
    primaryColour: assColour('FFFFFF'),
    outlineColour: assColour('000000'),
    // 59% transparent black box. Without a box or a heavy outline, white text on a bright
    // generated frame is unreadable and you do not control the frame.
    backColour: assColour('000000', 59),
    bold: true,
    borderStyle: 3,
    outline: 6,
    shadow: 0,
    alignment: 2,
    marginLeft: Math.round(SAFE_ZONE.sideFraction * canvas.width),
    marginRight: Math.round(SAFE_ZONE.sideFraction * canvas.width),
    marginVertical: Math.round(SAFE_ZONE.bottomFraction * canvas.height),
  };
}

export interface CaptionEvent {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly styleName?: string;
}

/** `{`, `}` and `\` are ASS override syntax; a stray one in ad copy eats the caption. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\u2216')
    .replace(/\{/g, '\uFF5B')
    .replace(/\}/g, '\uFF5D')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Authors a real `.ass` file with explicit PlayResX/Y.
 *
 * NEVER tune `force_style` numbers on an SRT instead: FFmpeg's SRT->ASS converter writes
 * PlayResY 288, so libass scales everything by height/288 — [MEASURED] `Fontsize=24`
 * rendered a 263px-tall caption on 1080x1920, and `original_size` did not change it.
 */
export function buildAssFile(
  canvas: Canvas,
  events: readonly CaptionEvent[],
  style: AssStyle = defaultCaptionStyle(canvas),
): string {
  for (const [i, e] of events.entries()) {
    if (!(e.endSeconds > e.startSeconds)) {
      throw new AssemblyPlanError(
        `caption event ${i} ends (${e.endSeconds}s) at or before it starts (${e.startSeconds}s). ` +
          `Caption timings are DERIVED from forced alignment, never authored — re-align rather ` +
          `than patching offsets.`,
      );
    }
  }
  const styleLine = [
    style.name,
    style.fontName,
    String(style.fontSizePx),
    style.primaryColour,
    // SecondaryColour, the karaoke not-yet-sung fill. RGB red, i.e. &H000000FF in ASS's
    // BGR order — the value in the dossier's measured style line, kept identical so the
    // emitted line can be diffed against it byte for byte.
    assColour('FF0000'),
    style.outlineColour,
    style.backColour,
    style.bold ? '-1' : '0',
    '0', '0', '0',
    '100', '100', '0', '0',
    String(style.borderStyle),
    String(style.outline),
    String(style.shadow),
    String(style.alignment),
    String(style.marginLeft),
    String(style.marginRight),
    String(style.marginVertical),
    '1',
  ].join(',');

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Must equal the video dimensions or every size and margin is silently scaled.
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    // 0 = smart wrapping with evenly balanced lines. NOT the dossier's `WrapStyle: 2`,
    // which means "no automatic wrapping at all" — and the dossier's own measurement could
    // not see the difference, because every event it rendered was a short one ("THIS IS THE
    // HOOK", 636px wide on a 1080px canvas).
    //
    // [MEASURED here] one line of realistic ad copy (33 characters at the default 72px
    // bold DejaVu Sans) rendered through `bbox` on the overlay layer:
    //   WrapStyle 2 -> bbox x 0..1079 on 43/43 frames: full-bleed, clipped at BOTH frame
    //                  edges, every frame outside the 6% side safe zone.
    //   WrapStyle 1 -> x 81..993, inside.
    //   WrapStyle 0 -> x 221..830, inside and balanced across two lines.
    // MarginL/MarginR (65px = 6%) only constrain the wrap width once wrapping is on, so
    // with WrapStyle 2 the safe-zone margins this module computes do nothing at all.
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const e of events) {
    lines.push(
      `Dialogue: 0,${assTimestamp(e.startSeconds)},${assTimestamp(e.endSeconds)},` +
        `${e.styleName ?? style.name},,0,0,0,,${escapeAssText(e.text)}`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Escapes a value for use inside a filtergraph option. Colons matter (Windows drive
 * letters, and `ass=filename=` itself), and so do the graph separators.
 */
export function escapeFilterArgument(value: string): string {
  return value.replace(/([\\':,;\[\]])/g, '\\$1');
}

/**
 * Burn-in via libass. `drawtext` is never used here — it needs libharfbuzz since n6.1 and
 * is absent from common static builds, failing at render time with `Unknown filter`.
 */
export function buildCaptionBurnFilter(assPath: string, fontsDir?: string): string {
  const base = `ass=filename=${escapeFilterArgument(assPath)}`;
  // Render containers routinely ship no usable fonts; point libass at the baked-in ones.
  return fontsDir === undefined ? base : `${base}:fontsdir=${escapeFilterArgument(fontsDir)}`;
}

/* ================================================================ Meta encode ==== */

export interface EncodeOptions {
  readonly fps: number;
  readonly videoBitrateBps: number;
  readonly maxrateBps: number;
  readonly bufsizeBps: number;
  readonly audioBitrateBps: number;
  /** Keyframe interval in seconds. 2s closed GOP is what Meta's transcoder wants. */
  readonly gopSeconds: number;
  readonly level: string;
  /**
   * Byte-reproducible output, for a content-addressed render cache.
   *
   * `+bitexact` and `-map_metadata -1` strip the encoder string and creation time, but
   * they are NOT sufficient on their own. [MEASURED here, ffmpeg 6.1.1] three runs of one
   * identical concat+encode produced three different files (6164190 / 6175360 / 6170983
   * bytes) — the BITSTREAM differs, not just the metadata. Isolated: the filter graph is
   * bit-exact (identical `-f framemd5` over three runs); dropping `-maxrate`/`-bufsize`
   * makes it reproducible; pinning `threads=1` makes it reproducible; `threads=2` and
   * `threads=4` do NOT. The cause is x264's row-level VBV rate control reading the
   * progress of frames encoding concurrently, which is thread-timing dependent. Since
   * `buildEncodeArgs` always emits VBV, determinism costs single-threaded encoding
   * (measured 8.8s vs 3.7s wall for a 12s 1080x1920 render on 4 cores). Set this false to
   * buy that back and give up cache hits.
   */
  readonly deterministic: boolean;
  /**
   * `-avoid_negative_ts make_zero`. It shifts timestamps; it does NOT suppress the `elst`
   * edit list — see `buildEncodeArgs`, where that is handled by `-use_editlist 0`.
   */
  readonly avoidNegativeTs: boolean;
  readonly withAudio: boolean;
}

export const DEFAULT_ENCODE: EncodeOptions = {
  fps: 30,
  // Meta re-transcodes everything, so anything above ~10-12 Mbps at 1080x1920 is pure
  // upload latency — which is this pipeline's tail latency.
  videoBitrateBps: 8_000_000,
  maxrateBps: 10_000_000,
  bufsizeBps: 16_000_000,
  audioBitrateBps: 128_000,
  gopSeconds: 2,
  level: '4.0',
  deterministic: true,
  avoidNegativeTs: true,
  withAudio: true,
};

export class EncodeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeSettingsError';
  }
}

/**
 * The Meta-compliant encode. There is deliberately NO switch to disable `+faststart`:
 * [MEASURED] without it the box order is ftyp/free/mdat/moov, Meta requires moov at the
 * front, and the resulting error 6000 is indistinguishable from a dozen other faults.
 *
 * `+empty_moov` is NOT offered: the dossier marks its Meta-ingestion safety UNVERIFIED.
 *
 * `-use_editlist 0` and `+negative_cts_offsets` are equally non-optional, and neither was
 * here before this pipeline was ever executed. [MEASURED here, ffmpeg 6.1.1] the mp4
 * muxer writes an `edts`/`elst` box on EVERY track it produces — a 2-entry list on the
 * video track (the empty edit that compensates the B-frame reorder delay) and one on the
 * audio track (AAC encoder priming). It appears even on a video-only render with no AAC
 * anywhere, because `bframes=2` alone is enough. The ads guide is verbatim: "Videos
 * should not contain edit lists or special boxes in file containers", and `gateContainerSpec`
 * blocks on it — so without these two flags every file this module renders fails its own
 * QA gate and, if forced past it, is the second-commonest cause of error 6000.
 * `-avoid_negative_ts make_zero` does NOT prevent it; that was the previous, wrong, guard.
 *
 * `+negative_cts_offsets` is deliberately NOT paired with it, which is counter-intuitive
 * enough to be worth the paragraph. It does make the video track's `start_time` read
 * 0.000000 instead of 0.083333 — but [MEASURED] it also inflates the track's reported
 * duration by the reorder delay (12.041667s -> 12.125s over the same 289 frames), so
 * `avg_frame_rate` comes back 2312/97 = 23.835 against an `r_frame_rate` of 24/1. That
 * trips the CFR test in `parseProbeJson`, and `gateFrameRate` plus `validateAdVideoSpec`
 * then reject a perfectly constant-frame-rate file as VFR. Trading a cosmetic `start_time`
 * for a false VFR rejection is a bad trade.
 *
 * And the `start_time` it fixes is cosmetic: [MEASURED] on a clip with a one-frame white
 * flash and a 20 ms click both authored at t=2.000s, the decoded flash/click separation is
 * -0.0056s with the edit list, -0.0053s with `-use_editlist 0`, and -0.0053s with
 * `+negative_cts_offsets` as well. Dropping the edit list shifts BOTH tracks by the same
 * ~62 ms; it does not desynchronise them. There is no sync cost to pay for.
 */
export function buildEncodeArgs(
  overrides: Partial<EncodeOptions> = {},
  context: { readonly fps?: number; readonly canvas?: Canvas } = {},
): readonly string[] {
  const o: EncodeOptions = {
    ...DEFAULT_ENCODE,
    ...(context.fps !== undefined ? { fps: context.fps } : {}),
    ...overrides,
  };

  if (o.fps < AD_VIDEO_SPEC.minFrameRate || o.fps > AD_VIDEO_SPEC.maxFrameRate) {
    // 23-60 is the ORGANIC Instagram publishing spec, not a published ad requirement (the
    // ads guide says only "fixed frame rate"). Encoding inside it satisfies both, so it is
    // enforced — but the message must not claim Meta documents it for ads, because the next
    // person to read this log will act on what it says.
    throw new EncodeSettingsError(
      `${o.fps} fps is outside the 23-60 fps range Instagram publishes for organic video. ` +
        `Meta documents no fps range for ads beyond "fixed frame rate"; this pipeline encodes ` +
        `inside the stricter organic window so one master satisfies both.`,
    );
  }
  if (o.videoBitrateBps > AD_VIDEO_SPEC.maxVideoBitrateBps || o.maxrateBps > AD_VIDEO_SPEC.maxVideoBitrateBps) {
    throw new EncodeSettingsError(
      `video bitrate ${(Math.max(o.videoBitrateBps, o.maxrateBps) / 1e6).toFixed(1)} Mbps exceeds the ` +
        `documented "VBR, 25Mbps maximum". (The 100 Mbps figure that circulates is wrong.)`,
    );
  }
  if (!(o.gopSeconds > 0)) {
    // Math.max(1, ...) below would quietly turn this into keyint=1 — every frame an IDR,
    // which triples the bitrate and looks like a mystery quality/size regression.
    throw new EncodeSettingsError(
      `gopSeconds must be positive, got ${o.gopSeconds}; Meta's transcoder wants a closed 2s GOP`,
    );
  }
  if (o.maxrateBps < o.videoBitrateBps) {
    // x264 clamps to the lower of the two, so this silently encodes at maxrate and the
    // requested -b:v is a lie. Loud beats subtly-wrong for something nobody will inspect.
    throw new EncodeSettingsError(
      `maxrate ${(o.maxrateBps / 1e6).toFixed(1)} Mbps is below the target bitrate ` +
        `${(o.videoBitrateBps / 1e6).toFixed(1)} Mbps; the encode would silently run at maxrate`,
    );
  }
  if (o.audioBitrateBps < AD_VIDEO_SPEC.minAudioBitrateBps) {
    throw new EncodeSettingsError(
      `audio bitrate ${Math.round(o.audioBitrateBps / 1000)} kbps is below the ads guide's "128kbps+"`,
    );
  }
  if (context.canvas !== undefined && context.canvas.width > AD_VIDEO_SPEC.maxHorizontalPixels) {
    throw new EncodeSettingsError(
      `canvas width ${context.canvas.width}px exceeds the 1920 horizontal pixel maximum (Instagram's ` +
        `organic publishing spec; Meta documents no width ceiling for ads, but 1920 satisfies both)`,
    );
  }

  const gop = Math.max(1, Math.round(o.fps * o.gopSeconds));
  const args: string[] = [
    '-c:v', 'libx264',
    // High profile is what Meta transcodes from.
    '-profile:v', 'high',
    '-level', o.level,
    // Generative models routinely emit yuv444p or 10-bit; Meta answers with error 352.
    '-pix_fmt', 'yuv420p',
    // `threads=1` only under `deterministic`: VBV row-level rate control reads the
    // progress of concurrently encoding frames, so with any thread count above 1 the
    // bitstream is timing-dependent and the content-addressed cache never hits. See the
    // `deterministic` field doc for the measurement.
    '-x264-params',
    `keyint=${gop}:min-keyint=${gop}:scenecut=0:bframes=2:ref=3${o.deterministic ? ':threads=1' : ''}`,
    // VFR is the #1 cause of "uploaded fine but the audio drifts".
    '-r', num(o.fps),
    '-b:v', String(o.videoBitrateBps),
    '-maxrate', String(o.maxrateBps),
    '-bufsize', String(o.bufsizeBps),
  ];
  if (o.withAudio) {
    args.push('-c:a', 'aac', '-b:a', `${Math.round(o.audioBitrateBps / 1000)}k`, '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }
  // moov to the front, and NO edit list. Both mandatory; see the function doc for what
  // each costs if omitted, and for why `+negative_cts_offsets` is NOT here.
  args.push('-movflags', '+faststart', '-use_editlist', '0');
  // Integer timescale; avoids fractional-timebase rounding when clips are concatenated.
  args.push('-video_track_timescale', String(Math.round(o.fps * 1000)));
  if (o.avoidNegativeTs) args.push('-avoid_negative_ts', 'make_zero');
  if (o.deterministic) {
    // Strips the encoder string and creation time. NOT sufficient on its own — the
    // `threads=1` above is the other half. See the `deterministic` field doc.
    args.push('-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1');
  }
  return args;
}

/**
 * Reframe one finished master into a derived cut, in a single Meta-compliant pass.
 *
 * `sourceFps` is REQUIRED and is the master's measured frame rate (ffprobe, not the
 * shotlist's intent). `buildEncodeArgs` always pins `-r`, so a default would silently
 * resample the derived cut: Veo and Seedance both emit 24 fps, and re-timing a 24 fps
 * master to 30 duplicates every fourth frame. The derived cut is the SAME footage as the
 * master and must carry the same frame rate — so the caller has to state it.
 */
export function buildReframeCommand(
  input: string,
  output: string,
  plan: ReframePlan,
  opts: {
    readonly sourceFps: number;
    readonly encode?: Partial<EncodeOptions>;
    readonly tracked?: TrackedCropOptions;
  },
): readonly string[] {
  if (!(opts.sourceFps > 0)) {
    throw new AssemblyPlanError(
      `sourceFps must be the master's measured frame rate, got ${opts.sourceFps}`,
    );
  }
  if (opts.encode?.fps !== undefined && opts.encode.fps !== opts.sourceFps) {
    throw new AssemblyPlanError(
      `encode.fps (${opts.encode.fps}) contradicts the master's ${opts.sourceFps} fps. A derived ` +
        `cut is the same footage re-framed; changing its frame rate here judders the picture and ` +
        `desynchronises nothing else, so it is never what was meant.`,
    );
  }
  const graph = buildReframeGraph(plan, { inLabel: '0:v', outLabel: 'v' }, opts.tracked);
  const withAudio = opts.encode?.withAudio ?? DEFAULT_ENCODE.withAudio;
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', graph, '-map', '[v]'];
  if (withAudio) args.push('-map', '0:a');
  args.push(...buildEncodeArgs(opts.encode ?? {}, { fps: opts.sourceFps, canvas: plan.to }));
  args.push(output);
  return args;
}

/* ==================================================================== ffprobe ==== */

export function buildProbeCommand(input: string): readonly string[] {
  return ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input];
}

export interface ProbeResult {
  /** Shaped for `validateAdVideoSpec` in src/meta/videoUpload.ts. */
  readonly meta: VideoFileMetadata;
  readonly profile: string | undefined;
  readonly sampleAspectRatio: string | undefined;
  readonly rFrameRate: string | undefined;
  readonly avgFrameRate: string | undefined;
  readonly nbFrames: number | undefined;
}

/** "30000/1001" -> 29.97. "0/0" and "N/A" -> undefined. */
export function parseRational(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'N/A') return undefined;
  const m = /^(-?\d+(?:\.\d+)?)(?:\/(-?\d+(?:\.\d+)?))?$/.exec(trimmed);
  if (m?.[1] === undefined) return undefined;
  const numerator = Number(m[1]);
  const denominator = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

/**
 * Container facts ffprobe cannot see (`moovAtomAtFront`, `hasEditLists`) come in as
 * `container`, from `scanTopLevelBoxes` over the file's first `MP4_HEADER_PROBE_BYTES`.
 * Leaving them out is not a pass: `validateAdVideoSpec` can only downgrade an unknown
 * hygiene field to a WARNING, so `gateContainerSpec` turns either unknown into a SKIP,
 * which blocks publish unless the waiver is written into `QaOptions.allowSkipped`.
 */
export function parseProbeJson(
  stdout: string,
  container?: {
    readonly moovAtomAtFront?: boolean;
    readonly hasEditLists?: boolean;
    readonly fileSizeBytes?: number;
  },
): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new AssemblyPlanError(
      `ffprobe output did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AssemblyPlanError('ffprobe output was not an object');
  }
  const root = parsed as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : [];
  const format = (typeof root.format === 'object' && root.format !== null ? root.format : {}) as Record<string, unknown>;

  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');
  if (video === undefined) {
    throw new AssemblyPlanError('ffprobe found no video stream — the render produced audio only or a broken file');
  }

  const str = (o: Record<string, unknown>, k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : typeof o[k] === 'number' ? String(o[k]) : undefined;
  const int = (o: Record<string, unknown>, k: string): number | undefined => {
    const v = str(o, k);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const rFrameRate = str(video, 'r_frame_rate');
  const avgFrameRate = str(video, 'avg_frame_rate');
  const rParsed = parseRational(rFrameRate);
  const aParsed = parseRational(avgFrameRate);
  const frameRate = aParsed ?? rParsed ?? 0;
  // CFR iff the container's nominal rate and the realised average agree. Only asserted
  // when BOTH are readable; otherwise it stays unknown and surfaces as a warning.
  const variableFrameRate =
    rParsed !== undefined && aParsed !== undefined ? Math.abs(rParsed - aParsed) > 0.01 : undefined;

  const sar = str(video, 'sample_aspect_ratio');
  const sarValue = sar === undefined || sar === 'N/A' ? undefined : parseRational(sar.replace(':', '/'));

  const fileSizeBytes = container?.fileSizeBytes ?? int(format, 'size') ?? 0;
  const meta: VideoFileMetadata = {
    fileSizeBytes,
    durationSeconds: Number(str(format, 'duration') ?? str(video, 'duration') ?? 0),
    width: int(video, 'width') ?? 0,
    height: int(video, 'height') ?? 0,
    frameRate,
    videoCodec: str(video, 'codec_name') ?? 'unknown',
    ...(audio !== undefined && str(audio, 'codec_name') !== undefined
      ? { audioCodec: str(audio, 'codec_name') as string }
      : {}),
    ...(int(video, 'bit_rate') !== undefined ? { videoBitrateBps: int(video, 'bit_rate') as number } : {}),
    ...(audio !== undefined && int(audio, 'bit_rate') !== undefined
      ? { audioBitrateBps: int(audio, 'bit_rate') as number }
      : {}),
    ...(audio !== undefined && int(audio, 'sample_rate') !== undefined
      ? { audioSampleRateHz: int(audio, 'sample_rate') as number }
      : {}),
    ...(audio !== undefined && int(audio, 'channels') !== undefined
      ? { audioChannels: int(audio, 'channels') as number }
      : {}),
    ...(str(format, 'format_name') !== undefined ? { container: str(format, 'format_name') as string } : {}),
    ...(str(video, 'pix_fmt') !== undefined ? { pixelFormat: str(video, 'pix_fmt') as string } : {}),
    ...(variableFrameRate !== undefined ? { variableFrameRate } : {}),
    ...(sarValue !== undefined ? { pixelAspectRatio: sarValue } : {}),
    ...(container?.moovAtomAtFront !== undefined ? { moovAtomAtFront: container.moovAtomAtFront } : {}),
    ...(container?.hasEditLists !== undefined ? { hasEditLists: container.hasEditLists } : {}),
  };

  return {
    meta,
    profile: str(video, 'profile'),
    sampleAspectRatio: sar,
    rFrameRate,
    avgFrameRate,
    nbFrames: int(video, 'nb_frames'),
  };
}

/* ============================================================= mp4 box order ===== */

export interface Mp4Box {
  readonly type: string;
  readonly offset: number;
  readonly size: number;
}

/** Reading this many leading bytes covers a faststart moov for any render this pipeline makes. */
export const MP4_HEADER_PROBE_BYTES = 4 * 1024 * 1024;

/**
 * Walks the top-level box list. `+faststart` is not the default and ffprobe will not tell
 * you where the moov landed, so this is the only way to check the one container property
 * Meta actually documents.
 */
export function scanTopLevelBoxes(buf: Uint8Array, maxBoxes = 16): readonly Mp4Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: Mp4Box[] = [];
  let off = 0;
  while (boxes.length < maxBoxes && off + 8 <= buf.byteLength) {
    let size = view.getUint32(off);
    let headerSize = 8;
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) {
      if (off + 16 > buf.byteLength) break;
      // 64-bit largesize. Renders here are well under 2^53 bytes, so Number is exact.
      size = Number(view.getBigUint64(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      // Extends to EOF — record it and stop, there is nothing after it by definition.
      boxes.push({ type, offset: off, size: buf.byteLength - off });
      break;
    }
    if (size < headerSize) break;
    boxes.push({ type, offset: off, size });
    off += size;
  }
  return boxes;
}

/** undefined when the buffer did not reach one of the two boxes — unknown, not false. */
export function moovBeforeMdat(boxes: readonly Mp4Box[]): boolean | undefined {
  const moov = boxes.findIndex((b) => b.type === 'moov');
  const mdat = boxes.findIndex((b) => b.type === 'mdat');
  if (moov < 0 || mdat < 0) return undefined;
  return moov < mdat;
}

/**
 * "Videos should not contain edit lists or special boxes in file containers." — the ads
 * guide, verbatim. ffprobe does not surface `elst`, so this scans the moov span for the
 * fourcc. Scoped to moov deliberately: scanning the whole file would false-positive on
 * arbitrary mdat bytes. Returns undefined when moov is not fully inside the buffer.
 */
export function moovContainsEditList(buf: Uint8Array, boxes: readonly Mp4Box[]): boolean | undefined {
  const moov = boxes.find((b) => b.type === 'moov');
  if (moov === undefined) return undefined;
  const end = moov.offset + moov.size;
  if (end > buf.byteLength) return undefined;
  const needle = [0x65, 0x6c, 0x73, 0x74]; // 'elst'
  for (let i = moov.offset; i + 4 <= end; i += 1) {
    if (
      buf[i] === needle[0] && buf[i + 1] === needle[1] &&
      buf[i + 2] === needle[2] && buf[i + 3] === needle[3]
    ) {
      return true;
    }
  }
  return false;
}

/* ================================================================== detectors ==== */

export interface TimeInterval {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
}

/**
 * `d` defaults to 2s, which would miss a black FIRST FRAME — the failure that actually
 * matters for an ad. 0.2 is the dossier's recommendation for short-form.
 */
export const BLACKDETECT_DEFAULTS = {
  minDurationSeconds: 0.2,
  pictureBlackRatio: 0.98,
  pixelBlackThreshold: 0.1,
} as const;

export function buildBlackdetectCommand(
  input: string,
  opts: Partial<typeof BLACKDETECT_DEFAULTS> = {},
): readonly string[] {
  const o = { ...BLACKDETECT_DEFAULTS, ...opts };
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-vf', `blackdetect=d=${num(o.minDurationSeconds)}:pic_th=${num(o.pictureBlackRatio)}:pix_th=${num(o.pixelBlackThreshold)}`,
    '-f', 'null', '-',
  ];
}

export function parseBlackdetect(stderr: string): readonly TimeInterval[] {
  const out: TimeInterval[] = [];
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  for (const m of stderr.matchAll(re)) {
    if (m[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
    out.push({ startSeconds: Number(m[1]), endSeconds: Number(m[2]), durationSeconds: Number(m[3]) });
  }
  return out;
}

export function buildFreezedetectCommand(
  input: string,
  opts: { readonly noise?: number; readonly minDurationSeconds?: number } = {},
): readonly string[] {
  const noise = opts.noise ?? 0.001;
  const d = opts.minDurationSeconds ?? 0.5;
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-vf', `freezedetect=n=${num(noise, 6)}:d=${num(d)}`,
    '-f', 'null', '-',
  ];
}

/**
 * freezedetect emits three separate metadata lines per run (start, duration, end) rather
 * than one summary line. A freeze that runs to EOF never gets its `freeze_end`, so the
 * pending run is emitted anyway — silently dropping it would hide the worst case.
 */
export function parseFreezedetect(stderr: string): readonly TimeInterval[] {
  const out: TimeInterval[] = [];
  let start: number | undefined;
  let duration: number | undefined;
  for (const line of stderr.split('\n')) {
    const s = /lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/.exec(line);
    if (s?.[1] !== undefined) {
      start = Number(s[1]);
      duration = undefined;
      continue;
    }
    const d = /lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/.exec(line);
    if (d?.[1] !== undefined) {
      duration = Number(d[1]);
      continue;
    }
    const e = /lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/.exec(line);
    if (e?.[1] !== undefined && start !== undefined) {
      const end = Number(e[1]);
      out.push({ startSeconds: start, endSeconds: end, durationSeconds: duration ?? end - start });
      start = undefined;
      duration = undefined;
    }
  }
  if (start !== undefined) {
    const dur = duration ?? 0;
    out.push({ startSeconds: start, endSeconds: start + dur, durationSeconds: dur });
  }
  return out;
}

export function buildSilencedetectCommand(
  input: string,
  opts: { readonly noiseDb?: number; readonly minDurationSeconds?: number } = {},
): readonly string[] {
  const noise = opts.noiseDb ?? -50;
  const d = opts.minDurationSeconds ?? 0.5;
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-af', `silencedetect=n=${num(noise)}dB:d=${num(d)}`,
    '-f', 'null', '-',
  ];
}

export function parseSilencedetect(stderr: string): readonly TimeInterval[] {
  const out: TimeInterval[] = [];
  let start: number | undefined;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s?.[1] !== undefined) {
      start = Number(s[1]);
      continue;
    }
    const e = /silence_end:\s*([\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/.exec(line);
    if (e?.[1] !== undefined) {
      const end = Number(e[1]);
      const st = start ?? (e[2] !== undefined ? end - Number(e[2]) : 0);
      out.push({
        startSeconds: st,
        endSeconds: end,
        durationSeconds: e[2] !== undefined ? Number(e[2]) : end - st,
      });
      start = undefined;
    }
  }
  return out;
}

export function buildEbur128Command(input: string): readonly string[] {
  return [
    '-hide_banner', '-nostats', '-nostdin',
    '-i', input,
    '-filter_complex', 'ebur128=peak=true',
    '-f', 'null', '-',
  ];
}

export interface LoudnessSummary {
  readonly integratedLufs: number;
  readonly thresholdLufs: number;
  readonly loudnessRangeLu: number;
  readonly truePeakDbfs: number;
}

/**
 * ebur128 also prints a per-frame `t: ... I: ... LUFS` line, so a naive `/I:\s*(...)/`
 * picks up the running value instead of the integrated one. The summary block is the last
 * "Integrated loudness:" in the stream; everything is parsed from there forward.
 */
export function parseEbur128Summary(stderr: string): LoudnessSummary {
  const at = stderr.lastIndexOf('Integrated loudness:');
  if (at < 0) {
    throw new AssemblyPlanError(
      'no ebur128 summary block on stderr; the filter did not run to completion (check for a decode error)',
    );
  }
  const tail = stderr.slice(at);
  const pick = (label: string, unit: string): number => {
    const re = new RegExp(`${label}:\\s*(-?(?:inf|[\\d.]+))\\s*${unit}`);
    const m = re.exec(tail);
    if (m?.[1] === undefined) {
      throw new AssemblyPlanError(`ebur128 summary is missing "${label}"`);
    }
    return m[1].includes('inf') ? (m[1].startsWith('-') ? -Infinity : Infinity) : Number(m[1]);
  };
  return {
    integratedLufs: pick('I', 'LUFS'),
    thresholdLufs: pick('Threshold', 'LUFS'),
    loudnessRangeLu: pick('LRA', 'LU'),
    truePeakDbfs: pick('Peak', 'dBFS'),
  };
}

/**
 * First-frame luma. Read the [MEASURED] trap before choosing a threshold: H.264 is
 * limited-range, so a true black frame reports YAVG=16, not 0. A `< 5` gate never fires.
 */
export function buildFirstFrameLumaCommand(input: string): readonly string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-i', input,
    '-vf', 'select=eq(n\\,0),signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-frames:v', '1',
    '-f', 'null', '-',
  ];
}

export function parseSignalstatsYavg(stderr: string): number | undefined {
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/* ------------------------------------------------------------- safe-zone probe --- */

/**
 * Renders the overlay layer ALONE onto black. Isolating the authored text from the
 * generated imagery is what makes the gate free of false positives — bright scene content
 * cannot trip it.
 */
export function buildSafeZoneLayerCommand(
  assPath: string,
  canvas: Canvas,
  durationSeconds: number,
  outputPattern: string,
  fps = 30,
  fontsDir?: string,
): readonly string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${canvas.width}x${canvas.height}:r=${num(fps)}:d=${num(durationSeconds)}`,
    '-vf', buildCaptionBurnFilter(assPath, fontsDir),
    '-q:v', '2',
    outputPattern,
  ];
}

/**
 * Same layer, but ffmpeg's own `bbox` filter computes the non-black bounding box so no
 * PNG decoding is needed (there is no image library in this project's dependency set).
 *
 * UNVERIFIED here: the dossier measured the PNG + numpy route, not this one. `bbox`'s
 * availability and log format have not been executed in this environment, so treat a
 * parse of zero frames as "the gate did not run", never as "no text was found".
 */
export function buildSafeZoneBboxCommand(
  assPath: string,
  canvas: Canvas,
  durationSeconds: number,
  fps = 30,
  fontsDir?: string,
): readonly string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${canvas.width}x${canvas.height}:r=${num(fps)}:d=${num(durationSeconds)}`,
    // min_val=16 rather than 0: limited-range black is 16 (see buildFirstFrameLumaCommand).
    '-vf', `${buildCaptionBurnFilter(assPath, fontsDir)},bbox=min_val=16`,
    '-f', 'null', '-',
  ];
}

export interface FrameBbox {
  readonly frame: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export function parseBboxFrames(stderr: string): readonly FrameBbox[] {
  const out: FrameBbox[] = [];
  const re = /n:(\d+)\s+pts:\S+\s+pts_time:\S+\s+x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/g;
  for (const m of stderr.matchAll(re)) {
    if (m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined || m[5] === undefined) {
      continue;
    }
    out.push({
      frame: Number(m[1]),
      x0: Number(m[2]),
      x1: Number(m[3]),
      y0: Number(m[4]),
      y1: Number(m[5]),
    });
  }
  return out;
}

/** One PNG showing the whole ad — what a human looks at when the pipeline escalates. */
export function buildContactSheetCommand(
  input: string,
  output: string,
  opts: { readonly columns?: number; readonly rows?: number; readonly thumbWidth?: number } = {},
): readonly string[] {
  const cols = opts.columns ?? 6;
  const rows = opts.rows ?? 5;
  const w = opts.thumbWidth ?? 270;
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vf', `fps=1,scale=${w}:-1,tile=${cols}x${rows}`,
    '-frames:v', '1',
    output,
  ];
}

/* ============================================================ probe convenience == */

export async function probeVideo(
  tools: FfmpegTools,
  path: string,
  container?: Parameters<typeof parseProbeJson>[1],
): Promise<ProbeResult> {
  const res = await runTool(tools.runner, tools.ffprobe, buildProbeCommand(path));
  return parseProbeJson(res.stdout, container);
}

/** Two-pass loudness. There is no single-pass path here, by design. */
export async function measureLoudness(
  tools: FfmpegTools,
  path: string,
  target: LoudnessTarget = LOUDNESS_TARGET,
): Promise<LoudnormMeasurement> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildLoudnormMeasureCommand(path, target));
  return parseLoudnormJson(res.stderr);
}

export async function verifyLoudness(tools: FfmpegTools, path: string): Promise<LoudnessSummary> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildEbur128Command(path));
  return parseEbur128Summary(res.stderr);
}

export async function detectBlack(
  tools: FfmpegTools,
  path: string,
  opts?: Partial<typeof BLACKDETECT_DEFAULTS>,
): Promise<readonly TimeInterval[]> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildBlackdetectCommand(path, opts));
  return parseBlackdetect(res.stderr);
}

export async function detectFreeze(tools: FfmpegTools, path: string): Promise<readonly TimeInterval[]> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildFreezedetectCommand(path));
  return parseFreezedetect(res.stderr);
}

export async function detectSilence(tools: FfmpegTools, path: string): Promise<readonly TimeInterval[]> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildSilencedetectCommand(path));
  return parseSilencedetect(res.stderr);
}

export async function firstFrameLuma(tools: FfmpegTools, path: string): Promise<number | undefined> {
  const res = await runTool(tools.runner, tools.ffmpeg, buildFirstFrameLumaCommand(path));
  return parseSignalstatsYavg(res.stderr);
}

/* ==================================================================== helpers ==== */

/** Formats a number for an argv slot without float noise (7.000000000000001 -> "7"). */
function num(n: number, dp = 3): string {
  if (!Number.isFinite(n)) {
    throw new AssemblyPlanError(`refusing to put a non-finite number (${n}) into an ffmpeg argument`);
  }
  let s = n.toFixed(dp);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
