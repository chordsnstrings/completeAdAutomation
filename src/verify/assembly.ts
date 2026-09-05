/**
 * Capability probe for src/assembly/ffmpeg.ts + src/assembly/qa.ts.
 *
 * NOT a unit test. The unit tests assert on argv strings and on parsers fed canned
 * stdout; every one of them passes with no ffmpeg on the box. This file answers a
 * different question: when the argv this module builds is handed to a REAL ffmpeg and
 * the real output is probed back, does the pipeline actually produce a publishable ad?
 *
 * Everything here synthesises its own footage (colour bars, a moving box, testsrc2, a
 * tone) at 1080x1920, runs the module's own command builders, and asserts on what
 * ffprobe and the mp4 box tree say afterwards. Nothing is stubbed; the only fake is the
 * source footage, because no generation provider is reachable from here.
 *
 * Measured against ffmpeg 6.1.1-3ubuntu5 (the dossier's numbers came from 7.0.2-static).
 * Scratch renders go under os.tmpdir(); nothing is written into the repo.
 */

import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AssemblyPlanError,
  BLACKDETECT_DEFAULTS,
  LOUDNESS_TARGET,
  MP4_HEADER_PROBE_BYTES,
  UnsafeReframeError,
  assertFiltersAvailable,
  assertToolchain,
  buildAssFile,
  buildBlackdetectCommand,
  buildCaptionBurnFilter,
  buildConcatCommand,
  buildContactSheetCommand,
  buildEbur128Command,
  buildFilterListCommand,
  buildFirstFrameLumaCommand,
  buildFreezedetectCommand,
  buildLoudnormApplyCommand,
  buildLoudnormMeasureCommand,
  buildProbeCommand,
  buildReframeCommand,
  buildReframeGraph,
  buildSafeZoneBboxCommand,
  buildSafeZoneLayerCommand,
  buildSilencedetectCommand,
  canvasFor,
  createChildProcessRunner,
  diagnoseFfmpegStderr,
  escapeFilterArgument,
  moovBeforeMdat,
  moovContainsEditList,
  parseBboxFrames,
  parseBlackdetect,
  parseEbur128Summary,
  parseFilterNames,
  parseFreezedetect,
  parseLoudnormJson,
  parseProbeJson,
  parseSignalstatsYavg,
  parseSilencedetect,
  planReframe,
  renderSendCmdScript,
  safeZoneBox,
  scanTopLevelBoxes,
  smoothCropPath,
  type Canvas,
  type CommandRunner,
  type CutName,
  type ProbeResult,
} from '../assembly/ffmpeg.ts';
import { formatQaReport, runQaGates } from '../assembly/qa.ts';

/* ================================================================== contract ==== */

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  /**
   * Set when the check could not run for an environmental reason (no assets assigned, no
   * API key, binary missing) rather than because the code is wrong.
   */
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

/* =================================================================== harness ==== */

const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe';

/** 9:16 at 24 fps: what Veo and Seedance actually emit, not the 30 fps encode default. */
const CANVAS: Canvas = canvasFor('9:16');
const SOURCE_FPS = 24;
const CLIP_SECONDS = 4;

interface Ctx {
  readonly dir: string;
  readonly runner: CommandRunner;
  readonly tools: { readonly ffmpeg: string; readonly ffprobe: string; readonly runner: CommandRunner };
  readonly clips: string[];
}

class Recorder {
  readonly checks: Check[] = [];

  pass(name: string, detail: string): void {
    this.checks.push({ name, status: 'PASS', detail });
  }
  fail(name: string, detail: string): void {
    this.checks.push({ name, status: 'FAIL', detail });
  }
  skip(name: string, detail: string, blockedBy: string): void {
    this.checks.push({ name, status: 'SKIP', detail, blockedBy });
  }
  /** Any throw becomes a FAIL naming the error, never an escaped exception. */
  async step(name: string, fn: () => Promise<string>): Promise<void> {
    try {
      this.pass(name, await fn());
    } catch (e) {
      if (e instanceof CheckFailure) this.fail(name, e.message);
      else if (e instanceof CheckSkip) this.skip(name, e.message, e.blockedBy);
      else this.fail(name, `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  }
}

class CheckFailure extends Error {}
class CheckSkip extends Error {
  readonly blockedBy: string;
  constructor(message: string, blockedBy: string) {
    super(message);
    this.blockedBy = blockedBy;
  }
}

function need(condition: boolean, message: string): void {
  if (!condition) throw new CheckFailure(message);
}

/* ================================================================= utilities ==== */

async function ffmpeg(ctx: Ctx, args: readonly string[]): Promise<string> {
  const r = await ctx.runner.run(ctx.tools.ffmpeg, args);
  if (r.code !== 0) {
    const why = diagnoseFfmpegStderr(r.stderr) ?? r.stderr.trim().split('\n').slice(-1)[0] ?? '(no stderr)';
    throw new CheckFailure(`ffmpeg exited ${r.code}: ${why}\n  argv: ${args.join(' ')}`);
  }
  return r.stderr;
}

/** Runs and returns stderr even on a non-zero exit — for probing failure paths. */
async function ffmpegAllowFail(
  ctx: Ctx,
  args: readonly string[],
): Promise<{ code: number | null; stderr: string }> {
  const r = await ctx.runner.run(ctx.tools.ffmpeg, args);
  return { code: r.code, stderr: r.stderr };
}

async function probe(ctx: Ctx, path: string): Promise<ProbeResult> {
  const r = await ctx.runner.run(ctx.tools.ffprobe, buildProbeCommand(path));
  if (r.code !== 0) throw new CheckFailure(`ffprobe exited ${r.code} on ${path}: ${r.stderr.trim()}`);
  const buf = headerBytes(path);
  const boxes = scanTopLevelBoxes(buf);
  const moovFirst = moovBeforeMdat(boxes);
  const elst = moovContainsEditList(buf, boxes);
  return parseProbeJson(r.stdout, {
    ...(moovFirst !== undefined ? { moovAtomAtFront: moovFirst } : {}),
    ...(elst !== undefined ? { hasEditLists: elst } : {}),
    fileSizeBytes: statSync(path).size,
  });
}

function headerBytes(path: string): Uint8Array {
  const size = Math.min(statSync(path).size, MP4_HEADER_PROBE_BYTES);
  const buf = new Uint8Array(size);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

/* ============================================================== source assets ==== */

/**
 * Three real 9:16 clips with audio. Deliberately different content per clip so
 * blackdetect / freezedetect / xfade have something to bite on, and deliberately 24 fps
 * so the "was the frame rate silently resampled to the 30 fps encode default" question
 * has a real answer.
 */
async function synthesiseClips(ctx: Ctx): Promise<string> {
  const specs: Array<{ readonly name: string; readonly video: string; readonly hz: number }> = [
    { name: 'clipA', video: `smptebars=s=${CANVAS.width}x${CANVAS.height}:r=${SOURCE_FPS}:d=${CLIP_SECONDS}`, hz: 440 },
    { name: 'clipB', video: `testsrc2=s=${CANVAS.width}x${CANVAS.height}:r=${SOURCE_FPS}:d=${CLIP_SECONDS}`, hz: 660 },
    { name: 'clipC', video: `rgbtestsrc=s=${CANVAS.width}x${CANVAS.height}:r=${SOURCE_FPS}:d=${CLIP_SECONDS}`, hz: 880 },
  ];
  for (const s of specs) {
    const out = join(ctx.dir, `${s.name}.mp4`);
    await ffmpeg(ctx, [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', s.video,
      '-f', 'lavfi', '-i', `sine=frequency=${s.hz}:sample_rate=48000:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest', out,
    ]);
    ctx.clips.push(out);
  }
  const checked: string[] = [];
  for (const p of ctx.clips) {
    const r = await probe(ctx, p);
    need(
      r.meta.width === CANVAS.width && r.meta.height === CANVAS.height,
      `source ${p} is ${r.meta.width}x${r.meta.height}, wanted ${CANVAS.width}x${CANVAS.height}`,
    );
    need(near(r.meta.frameRate, SOURCE_FPS, 0.01), `source ${p} is ${r.meta.frameRate} fps, wanted ${SOURCE_FPS}`);
    need(r.meta.audioCodec !== undefined, `source ${p} has no audio stream`);
    checked.push(`${p.split('/').pop() ?? p} ${r.meta.width}x${r.meta.height} ${r.meta.frameRate}fps ${r.meta.durationSeconds.toFixed(3)}s`);
  }
  return `synthesised and verified 3 sources: ${checked.join('; ')}`;
}

/* =================================================================== the run ==== */

export async function run(): Promise<VerifyReport> {
  const rec = new Recorder();
  const module = 'assembly';
  let dir: string | undefined;

  try {
    dir = mkdtempSync(join(tmpdir(), 'verify-assembly-'));
    // `dir` is the cleanup handle and stays `string | undefined`; `work` is the narrowed
    // value every closure below uses.
    const work: string = dir;
    const runner = createChildProcessRunner({ maxBufferBytes: 64 * 1024 * 1024, timeoutMs: 180_000 });
    const ctx: Ctx = { dir: work, runner, tools: { ffmpeg: FFMPEG, ffprobe: FFPROBE, runner }, clips: [] };

    /* ---- 1. is there a toolchain at all? Everything below depends on it. ---- */
    let toolchainOk = false;
    try {
      const v = await assertToolchain(ctx.tools);
      toolchainOk = true;
      rec.pass(
        'toolchain: ffmpeg and ffprobe execute',
        `ffmpeg ${v.ffmpeg ?? '?'} / ffprobe ${v.ffprobe ?? '?'} (the dossier's commands were transcribed ` +
          `against 7.0.2-static; every version-sensitive result below is re-measured here)`,
      );
    } catch (e) {
      rec.skip(
        'toolchain: ffmpeg and ffprobe execute',
        `assertToolchain could not run the binaries: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
        'ffmpeg/ffprobe not executable in this environment',
      );
    }

    if (!toolchainOk) {
      for (const name of BLOCKED_WITHOUT_FFMPEG) {
        rec.skip(name, 'requires a working ffmpeg/ffprobe', 'ffmpeg/ffprobe not executable in this environment');
      }
      return { module, checks: rec.checks };
    }

    /* ---- 2. filters ---- */
    await rec.step('filters: every filter the module emits exists in this build', async () => {
      const r = await ctx.runner.run(ctx.tools.ffmpeg, buildFilterListCommand());
      need(r.code === 0, `ffmpeg -filters exited ${r.code}`);
      const names = parseFilterNames(r.stdout);
      need(names.size > 100, `parseFilterNames found only ${names.size} filters — the parse is wrong, not the build`);
      assertFiltersAvailable(names);
      // bbox is used by buildSafeZoneBboxCommand but is NOT in REQUIRED_FILTERS.
      const bbox = names.has('bbox');
      return (
        `parsed ${names.size} filter names; all REQUIRED_FILTERS present including "ass" (libass). ` +
        `bbox (used by buildSafeZoneBboxCommand, absent from REQUIRED_FILTERS): ${bbox ? 'present' : 'MISSING'}`
      );
    });

    /* ---- 3. sources ---- */
    let haveClips = false;
    await rec.step('sources: real 1080x1920 24fps clips with audio can be synthesised', async () => {
      const s = await synthesiseClips(ctx);
      haveClips = true;
      return s;
    });
    if (!haveClips) {
      for (const name of BLOCKED_WITHOUT_CLIPS) {
        rec.skip(name, 'source synthesis failed, so nothing downstream could be rendered', 'no source clips');
      }
      return { module, checks: rec.checks };
    }

    const master = join(work, 'master.mp4');
    const clipInputs = ctx.clips.map((p) => ({
      path: p,
      durationSeconds: CLIP_SECONDS,
      width: CANVAS.width,
      height: CANVAS.height,
    }));

    /* ---- 4. the concat, executed ---- */
    let masterProbe: ProbeResult | undefined;
    await rec.step('concat: buildConcatCommand renders a real master and ffprobe agrees', async () => {
      const plan = buildConcatCommand({ clips: clipInputs, canvas: CANVAS, fps: SOURCE_FPS, output: master });
      await ffmpeg(ctx, plan.args);
      const p = await probe(ctx, master);
      masterProbe = p;
      need(p.meta.width === CANVAS.width && p.meta.height === CANVAS.height, `master is ${p.meta.width}x${p.meta.height}`);
      need(p.meta.audioCodec === 'aac', `master audio codec is ${String(p.meta.audioCodec)}, expected aac`);
      need(p.meta.videoCodec === 'h264', `master video codec is ${p.meta.videoCodec}`);
      need(p.meta.pixelFormat === 'yuv420p', `master pix_fmt is ${String(p.meta.pixelFormat)}`);
      need(p.meta.pixelAspectRatio === 1, `master SAR is ${String(p.sampleAspectRatio)} — setsar=1 did not hold`);
      need(p.meta.variableFrameRate === false, `master reads VFR: r=${String(p.rFrameRate)} avg=${String(p.avgFrameRate)}`);
      need(near(p.meta.frameRate, SOURCE_FPS, 0.01), `master is ${p.meta.frameRate} fps, not ${SOURCE_FPS}`);
      const drift = p.meta.durationSeconds - plan.expectedDurationSeconds;
      need(
        Math.abs(drift) <= 0.15,
        `master is ${p.meta.durationSeconds.toFixed(3)}s against an expected ${plan.expectedDurationSeconds}s ` +
          `(${drift.toFixed(3)}s drift); gateDuration's tolerance is 0.15s`,
      );
      return (
        `${p.meta.width}x${p.meta.height} SAR ${String(p.sampleAspectRatio)} ${p.meta.frameRate}fps CFR, ` +
        `h264/High + aac, ${p.meta.durationSeconds.toFixed(3)}s vs expected ${plan.expectedDurationSeconds}s ` +
        `(drift ${drift.toFixed(3)}s, tolerance 0.15s — the residue is the container reporting the B-frame ` +
        `reorder lead-in plus the AAC tail, and it is the whole budget minus ${(0.15 - Math.abs(drift)).toFixed(3)}s)`
      );
    });

    /* ---- 5. container hygiene, the two things ffprobe cannot see ---- */
    await rec.step('container: moov is at the front and NO edit list is written', async () => {
      const buf = headerBytes(master);
      const boxes = scanTopLevelBoxes(buf);
      const order = boxes.map((b) => b.type).join(',');
      need(moovBeforeMdat(boxes) === true, `box order is ${order}: +faststart did not move moov to the front`);
      need(
        moovContainsEditList(buf, boxes) === false,
        `the moov span contains an "elst" edit list (box order ${order}). The ads guide forbids edit lists ` +
          `verbatim and gateContainerSpec blocks on it. ffmpeg's mp4 muxer writes one on EVERY track unless ` +
          `-use_editlist 0 is passed; -avoid_negative_ts make_zero does not suppress it.`,
      );
      return `box order ${order}; moov before mdat; no elst in the moov span`;
    });

    /* ---- 6. the crossfade timeline ---- */
    await rec.step('xfade: offsets are on the output timeline and the render is that long', async () => {
      const out = join(work, 'xfade.mp4');
      const plan = buildConcatCommand({
        clips: clipInputs,
        canvas: CANVAS,
        fps: SOURCE_FPS,
        output: out,
        transitions: [
          { kind: 'fade', durationSeconds: 0.5 },
          { kind: 'wipeleft', durationSeconds: 0.5 },
        ],
      });
      need(
        plan.expectedDurationSeconds === 11,
        `3x${CLIP_SECONDS}s with 2x0.5s transitions should predict 11s, predicted ${plan.expectedDurationSeconds}s`,
      );
      need(/offset=3\.5/.test(plan.filterGraph) && /offset=7/.test(plan.filterGraph), `offsets are wrong: ${plan.filterGraph}`);
      await ffmpeg(ctx, plan.args);
      const p = await probe(ctx, out);
      need(
        near(p.meta.durationSeconds, 11, 0.15),
        `rendered ${p.meta.durationSeconds.toFixed(3)}s against a predicted 11s — the accumulating-timeline ` +
          `offset formula does not match what xfade actually does in this build`,
      );
      return `predicted 11s (offsets 3.5, 7), rendered ${p.meta.durationSeconds.toFixed(3)}s; both xfade transitions accepted`;
    });

    /* ---- 7. reframing, all four strategies, executed ---- */
    await rec.step('reframe: 9:16 -> 4:5 and 1:1 in crop / pad / blur-pad give real dimensions', async () => {
      const lines: string[] = [];
      const cases: Array<{ readonly cut: CutName; readonly strategy: 'centre-crop' | 'scale-pad' | 'blur-pad' }> = [
        { cut: '4:5', strategy: 'centre-crop' },
        { cut: '4:5', strategy: 'scale-pad' },
        { cut: '1:1', strategy: 'centre-crop' },
        { cut: '1:1', strategy: 'scale-pad' },
        { cut: '1:1', strategy: 'blur-pad' },
      ];
      for (const c of cases) {
        const to = canvasFor(c.cut);
        const plan = planReframe(CANVAS, to, c.strategy);
        const out = join(work, `re_${c.cut.replace(':', 'x')}_${c.strategy}.mp4`);
        await ffmpeg(ctx, buildReframeCommand(master, out, plan, { sourceFps: SOURCE_FPS }));
        const p = await probe(ctx, out);
        need(
          p.meta.width === to.width && p.meta.height === to.height,
          `${c.cut}/${c.strategy} produced ${p.meta.width}x${p.meta.height}, wanted ${to.width}x${to.height}`,
        );
        need(
          p.meta.pixelAspectRatio === 1,
          `${c.cut}/${c.strategy} produced SAR ${String(p.sampleAspectRatio)} — a chain lost its setsar=1`,
        );
        need(
          near(p.meta.frameRate, SOURCE_FPS, 0.01),
          `${c.cut}/${c.strategy} came out at ${p.meta.frameRate} fps: the master's ${SOURCE_FPS} fps was ` +
            `resampled (the encode default is 30 — that is exactly the silent judder buildReframeCommand's ` +
            `required sourceFps exists to prevent)`,
        );
        need(p.meta.variableFrameRate === false, `${c.cut}/${c.strategy} reads VFR`);
        lines.push(`${c.cut}/${c.strategy}=${p.meta.width}x${p.meta.height}@${p.meta.frameRate}fps SAR1:1`);
      }
      return `${lines.join(' ')} — no strategy resampled ${SOURCE_FPS} fps to the 30 fps encode default`;
    });

    /* ---- 8. the setsar guard is load-bearing, proven by removing it ---- */
    await rec.step('setsar: removing the trailing setsar=1 really does yield non-square pixels', async () => {
      const to = canvasFor('1:1');
      const naked = join(work, 'nosetsar.mp4');
      // The module's scale-pad chain with the terminal setsar=1 deleted. Nothing else changed.
      await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y', '-i', master, '-t', '2',
        '-filter_complex',
        `[0:v]scale=${to.width}:${to.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
          `pad=${to.width}:${to.height}:(ow-iw)/2:(oh-ih)/2:color=black[v]`,
        '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', naked,
      ]);
      const bad = await probe(ctx, naked);
      need(
        bad.meta.pixelAspectRatio !== undefined && bad.meta.pixelAspectRatio !== 1,
        `the setsar-less chain still produced square pixels (SAR ${String(bad.sampleAspectRatio)}); either this ` +
          `build no longer sets a fractional SAR or the check is measuring the wrong thing`,
      );
      const guarded = await probe(ctx, join(work, 're_1x1_scale-pad.mp4'));
      need(guarded.meta.pixelAspectRatio === 1, `the guarded chain produced SAR ${String(guarded.sampleAspectRatio)}`);
      return (
        `scale+pad without setsar=1 -> SAR ${String(bad.sampleAspectRatio)} (non-square pixels, an AD_SPEC ` +
        `violation no visual inspection catches); the module's chain -> SAR ${String(guarded.sampleAspectRatio)}. ` +
        `Dossier measured 2025:2024 on 7.0.2; this build gives a different ratio for the same reason.`
      );
    });

    /* ---- 9. the reframe refusals ---- */
    await rec.step('reframe: an unsafe derivation is refused before a frame is encoded', async () => {
      let threw = '';
      try {
        buildReframeGraph(planReframe({ width: 1920, height: 1080 }, CANVAS, 'centre-crop'));
      } catch (e) {
        threw = e instanceof UnsafeReframeError ? e.message : `wrong error type: ${String(e)}`;
      }
      need(threw.startsWith('refusing to centre-crop'), `16:9 -> 9:16 was NOT refused (got: ${threw || 'no throw'})`);
      need(/31\.6% of the width/.test(threw), `the refusal did not name the retained fraction: ${threw}`);
      // ...and concat must not be the back door around it.
      let concatThrew = '';
      try {
        buildConcatCommand({
          clips: [{ path: ctx.clips[0] ?? '', durationSeconds: 4, width: 1920, height: 1080 }],
          canvas: CANVAS,
          fps: SOURCE_FPS,
          output: join(work, 'never.mp4'),
        });
      } catch (e) {
        concatThrew = e instanceof AssemblyPlanError ? e.problems.join(' | ') : `wrong error: ${String(e)}`;
      }
      need(/below the 50% floor/.test(concatThrew), `concat accepted a 16:9 clip into a 9:16 canvas: ${concatThrew || 'no throw'}`);
      return `buildReframeGraph refused 16:9->9:16 (31.6% of the width retained) and buildConcatCommand refused the same geometry`;
    });

    /* ---- 10. tracked crop through sendcmd, actually rendered ---- */
    await rec.step('tracked-crop: a smoothed sendcmd path drives a real crop render', async () => {
      const from: Canvas = { width: 1920, height: 1080 };
      const wide = join(work, 'wide.mp4');
      await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${SOURCE_FPS}:d=${CLIP_SECONDS}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${CLIP_SECONDS}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-shortest', wide,
      ]);
      const plan = planReframe(from, CANVAS, 'tracked-crop');
      const win = { width: 608, height: 1080 };
      const path = smoothCropPath(
        Array.from({ length: 20 }, (_, i) => ({ timeSeconds: i * 0.2, centreX: 400 + 60 * i, centreY: 540 })),
        from,
        win,
        { fps: SOURCE_FPS },
      );
      const cmdFile = join(work, 'crop.cmd');
      writeFileSync(cmdFile, renderSendCmdScript(path));
      const first = path[0];
      need(first !== undefined, 'smoothCropPath returned no points');
      const out = join(work, 'tracked.mp4');
      await ffmpeg(
        ctx,
        buildReframeCommand(wide, out, plan, {
          sourceFps: SOURCE_FPS,
          tracked: { commandFile: cmdFile, initialX: first?.x ?? 0, initialY: first?.y ?? 0 },
        }),
      );
      const p = await probe(ctx, out);
      need(p.meta.width === CANVAS.width && p.meta.height === CANVAS.height, `tracked cut is ${p.meta.width}x${p.meta.height}`);
      need(p.meta.pixelAspectRatio === 1, `tracked cut SAR ${String(p.sampleAspectRatio)}`);
      const xs = path.map((q) => q.x);
      const maxStep = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - (xs[i] ?? x))));
      return (
        `sendcmd accepted a ${path.length}-keyframe script, crop window 608x1080 -> ${p.meta.width}x${p.meta.height} ` +
        `SAR 1:1; largest smoothed x step ${maxStep}px per 0.2s sample (raw detections moved 60px)`
      );
    });

    /* ---- 11. two-pass loudness, measured on the result ---- */
    const loud = join(work, 'loud.mp4');
    await rec.step('loudness: the two-pass loudnorm lands on target and stays at 48 kHz', async () => {
      const m = await ffmpeg(ctx, buildLoudnormMeasureCommand(master));
      const measurement = parseLoudnormJson(m);
      need(Number.isFinite(measurement.inputI), `loudnorm measured input_i=${measurement.inputI}`);
      await ffmpeg(ctx, buildLoudnormApplyCommand(master, loud, measurement));
      const verified = parseEbur128Summary(await ffmpeg(ctx, buildEbur128Command(loud)));
      need(
        near(verified.integratedLufs, LOUDNESS_TARGET.integratedLufs, 0.5),
        `the normalised file measures I=${verified.integratedLufs} LUFS against a ${LOUDNESS_TARGET.integratedLufs} target`,
      );
      need(
        verified.truePeakDbfs <= LOUDNESS_TARGET.truePeakDb,
        `true peak ${verified.truePeakDbfs} dBFS exceeds the ${LOUDNESS_TARGET.truePeakDb} dBFS ceiling`,
      );
      const p = await probe(ctx, loud);
      need(p.meta.audioSampleRateHz === 48000, `the normalised file is ${String(p.meta.audioSampleRateHz)} Hz, not 48000`);
      need(
        moovContainsEditList(headerBytes(loud), scanTopLevelBoxes(headerBytes(loud))) === false,
        `the loudnorm apply pass re-muxed an edit list back in`,
      );
      return (
        `pass 1 measured I=${measurement.inputI} TP=${measurement.inputTp} LRA=${measurement.inputLra}; ` +
        `pass 2 (linear=true) landed I=${verified.integratedLufs} LUFS / peak ${verified.truePeakDbfs} dBFS at ` +
        `48000 Hz, no edit list`
      );
    });

    /* ---- 12. the trap the two-pass design exists to avoid ---- */
    await rec.step('loudness: single-pass loudnorm still emits 192 kHz in this build', async () => {
      const out = join(work, 'singlepass.wav');
      await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y', '-i', ctx.clips[0] ?? master,
        '-af', `loudnorm=I=${LOUDNESS_TARGET.integratedLufs}:TP=${LOUDNESS_TARGET.truePeakDb}:LRA=${LOUDNESS_TARGET.loudnessRangeLu}`,
        '-vn', '-c:a', 'pcm_s16le', out,
      ]);
      const r = await ctx.runner.run(ctx.tools.ffprobe, [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', out,
      ]);
      const hz = Number(r.stdout.trim());
      need(
        hz === 192000,
        `single-pass loudnorm produced ${hz} Hz, not the 192000 the dossier measured. The module has no ` +
          `single-pass path either way, but the stated reason for that no longer holds and should be re-checked.`,
      );
      return `single-pass loudnorm output is ${hz} Hz — 4x Meta's 48 kHz ceiling, which is why buildLoudnormFilter always appends aresample=48000`;
    });

    /* ---- 13. captions burned with libass ---- */
    const assPath = join(work, 'caps.ass');
    await rec.step('captions: libass burn-in runs and the .ass this module writes is accepted', async () => {
      const ass = buildAssFile(CANVAS, [
        { startSeconds: 0.2, endSeconds: 3.0, text: 'Ready in 90 seconds' },
        { startSeconds: 3.2, endSeconds: 6.5, text: 'Braces {like this} and a \\ survive' },
        { startSeconds: 6.7, endSeconds: 11.5, text: 'Shop now' },
      ]);
      writeFileSync(assPath, ass);
      need(/PlayResY: 1920/.test(ass), 'the .ass did not carry PlayResY equal to the canvas height');
      need(!/[{}]/.test(ass.split('[Events]')[1] ?? ''), 'raw ASS override braces survived escapeAssText');
      const out = join(work, 'burned.mp4');
      const stderr = await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y', '-i', master,
        '-vf', buildCaptionBurnFilter(assPath),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', out,
      ]);
      need(/Added subtitle file/.test(stderr), `libass never reported loading the subtitle file:\n${stderr.slice(-400)}`);
      need(!/Fontconfig error|Cannot find font/.test(stderr), `libass could not resolve a font:\n${stderr.slice(-400)}`);
      const libass = /libass source: (\S+ \S+)/.exec(stderr)?.[1] ?? 'unknown';
      const p = await probe(ctx, out);
      need(p.meta.width === CANVAS.width, `the burned file is ${p.meta.width}x${p.meta.height}`);
      return `libass ${libass} loaded the generated .ass (3 events) and burned it into a ${p.meta.width}x${p.meta.height} render; no font fallback error`;
    });

    /* ---- 14. safe-zone gate, on real measured boxes ---- */
    await rec.step('safe zone: the overlay-only bbox render measures inside Meta’s box', async () => {
      const stderr = await ffmpeg(ctx, buildSafeZoneBboxCommand(assPath, CANVAS, 12, SOURCE_FPS));
      const frames = parseBboxFrames(stderr);
      need(
        frames.length > 0,
        `bbox produced no parseable frames. The dossier marked this path UNVERIFIED (it measured the PNG+numpy ` +
          `route); zero frames must never be read as "no text was drawn".`,
      );
      const box = safeZoneBox(CANVAS);
      const outside = frames.filter((f) => f.x0 < box.x0 || f.x1 > box.x1 || f.y0 < box.y0 || f.y1 > box.y1);
      need(
        outside.length === 0,
        `${outside.length}/${frames.length} caption frames leave the safe box x∈[${box.x0},${box.x1}] ` +
          `y∈[${box.y0},${box.y1}]; worst: ${JSON.stringify(outside[0])}`,
      );
      const lowest = Math.max(...frames.map((f) => f.y1));
      // The PNG-sequence variant of the same probe must also run.
      await ffmpeg(ctx, buildSafeZoneLayerCommand(assPath, CANVAS, 1, join(work, 'layer_%03d.png'), SOURCE_FPS));
      return (
        `bbox parsed ${frames.length} overlay frames; all inside x∈[${box.x0},${box.x1}] y∈[${box.y0},${box.y1}], ` +
        `lowest caption edge y=${lowest} (${box.y1 - lowest}px of clearance under the 35% bottom limit). ` +
        `The PNG-sequence layer command also rendered.`
      );
    });

    /* ---- 15. detectors against footage built to trip them ---- */
    const badRender = join(work, 'bad.mp4');
    await rec.step('detectors: blackdetect / freezedetect / silencedetect / signalstats all fire', async () => {
      // 1s of black then 1s of motion; silent throughout; 15 fps; 1080x1080.
      await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=1080x1080:r=15:d=1',
        '-f', 'lavfi', '-i', 'testsrc2=s=1080x1080:r=15:d=1',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '15',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-t', '2', badRender,
      ]);
      const black = parseBlackdetect(await ffmpeg(ctx, buildBlackdetectCommand(badRender)));
      need(black.length > 0, `blackdetect found no black run in a file that opens on 1s of black (d=${BLACKDETECT_DEFAULTS.minDurationSeconds})`);
      const freeze = parseFreezedetect(await ffmpeg(ctx, buildFreezedetectCommand(badRender)));
      need(freeze.length > 0, 'freezedetect found no frozen run in a file that opens on 1s of flat black');
      const silence = parseSilencedetect(await ffmpeg(ctx, buildSilencedetectCommand(badRender)));
      need(silence.length > 0, 'silencedetect found no silence in an anullsrc track');
      const yavg = parseSignalstatsYavg(await ffmpeg(ctx, buildFirstFrameLumaCommand(badRender)));
      need(yavg !== undefined, 'signalstats/metadata produced no YAVG line to parse');
      need(
        yavg !== undefined && yavg < 20,
        `the first frame of an all-black render reported YAVG=${String(yavg)}, which the 20 floor would pass`,
      );
      // ...and the same detectors must stay quiet on real content.
      const goodYavg = parseSignalstatsYavg(await ffmpeg(ctx, buildFirstFrameLumaCommand(loud)));
      need(
        goodYavg !== undefined && goodYavg >= 20,
        `the good master's first frame reported YAVG=${String(goodYavg)} — below the floor, so the gate would ` +
          `false-positive on legitimate footage`,
      );
      return (
        `black ${black.length} run(s) (first ${black[0]?.durationSeconds.toFixed(3)}s), freeze ${freeze.length}, ` +
        `silence ${silence.length}, first-frame YAVG ${String(yavg)} on black vs ${String(goodYavg)} on real ` +
        `footage — the limited-range trap is real: black reads ${String(yavg)}, not 0`
      );
    });

    /* ---- 16. contact sheet ---- */
    await rec.step('escalation: the contact sheet a human would look at actually renders', async () => {
      const sheet = join(work, 'sheet.png');
      await ffmpeg(ctx, buildContactSheetCommand(loud, sheet));
      const size = statSync(sheet).size;
      need(size > 5000, `the contact sheet is only ${size} bytes`);
      return `tile=6x5 contact sheet rendered, ${(size / 1024).toFixed(0)} KB`;
    });

    /* ---- 17. QA gates, on the module's own good output ---- */
    await rec.step('QA: the module’s own render passes its own gates', async () => {
      const p = await probe(ctx, loud);
      const yavg = parseSignalstatsYavg(await ffmpeg(ctx, buildFirstFrameLumaCommand(loud)));
      const report = runQaGates(
        {
          cut: '9:16',
          probe: p,
          placements: ['instagram:reels'],
          black: {
            intervals: parseBlackdetect(await ffmpeg(ctx, buildBlackdetectCommand(loud))),
            ...(yavg !== undefined ? { firstFrameYavg: yavg } : {}),
          },
          freeze: parseFreezedetect(await ffmpeg(ctx, buildFreezedetectCommand(loud))),
          silence: parseSilencedetect(await ffmpeg(ctx, buildSilencedetectCommand(loud))),
          loudness: parseEbur128Summary(await ffmpeg(ctx, buildEbur128Command(loud))),
        },
        { allowSkipped: ['SAFE_ZONE', 'ASPECT_MANIFEST', 'FREEZE'] },
      );
      // FREEZE is waived because the synthetic sources are static test patterns, which are
      // legitimately frozen; nothing about that is a property of the module.
      const structural = report.failures.filter((f) => f.gate !== 'FREEZE');
      need(
        structural.length === 0,
        `the module cannot publish what it renders. Failing gates:\n${formatQaReport(report)}\n` +
          `Measured audio bitrate on this render: ${String(p.meta.audioBitrateBps)} bps from a nominal ` +
          `-b:a 128k. ffprobe reports the REALISED average of the AAC stream, and across the renders in ` +
          `this probe it lands between 127097 and 128218 bps depending on content — so a zero-tolerance ` +
          `"< 128000 is an ERROR" test in validateAdVideoSpec (src/meta/videoUpload.ts:290) rejects roughly ` +
          `half of all spec-compliant renders.`,
      );
      return `every gate passed on the module's own output (FREEZE waived: the synthetic sources are static test patterns)`;
    });

    /* ---- 18. QA gates, on something deliberately broken ---- */
    await rec.step('QA: a deliberately bad render is refused, gate by gate', async () => {
      const p = await probe(ctx, badRender);
      const yavg = parseSignalstatsYavg(await ffmpeg(ctx, buildFirstFrameLumaCommand(badRender)));
      const report = runQaGates(
        {
          cut: '9:16',
          probe: p,
          targetDurationSeconds: 12,
          placements: ['instagram:reels'],
          black: {
            intervals: parseBlackdetect(await ffmpeg(ctx, buildBlackdetectCommand(badRender))),
            ...(yavg !== undefined ? { firstFrameYavg: yavg } : {}),
          },
          freeze: parseFreezedetect(await ffmpeg(ctx, buildFreezedetectCommand(badRender))),
          silence: parseSilencedetect(await ffmpeg(ctx, buildSilencedetectCommand(badRender))),
          loudness: parseEbur128Summary(await ffmpeg(ctx, buildEbur128Command(badRender))),
        },
        {},
      );
      const failed = new Set(report.failures.map((f) => f.gate));
      for (const g of ['CONTAINER_SPEC', 'DURATION', 'RESOLUTION', 'FRAME_RATE', 'BLACK_FRAMES', 'SILENCE', 'LOUDNESS'] as const) {
        need(failed.has(g), `${g} passed a render that is 2s, 15 fps, 1:1, opens on black and is digitally silent`);
      }
      need(!report.ok, 'runQaGates called a deliberately broken render publishable');
      return `${report.failures.length} gates failed as designed (${[...failed].join(', ')}) and the report is not ok`;
    });

    /* ---- 18b. the VFR detector, on genuinely variable timing ---- */
    await rec.step('CFR: the variable-frame-rate detector fires on real VFR, not just on artefacts', async () => {
      const vfr = join(work, 'vfr.mp4');
      // First 30 frames at 30 fps, the rest at 7.5 fps: genuinely irregular frame intervals,
      // which is the shape a screen capture or a re-timed generation actually has.
      await ffmpeg(ctx, [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=4',
        '-vf', "setpts='if(lt(N,30), N/30/TB, (30+(N-30)*4)/30/TB)'",
        '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', vfr,
      ]);
      const p = await probe(ctx, vfr);
      need(
        p.meta.variableFrameRate === true,
        `a file with two different frame intervals reported variableFrameRate=${String(p.meta.variableFrameRate)} ` +
          `(r=${String(p.rFrameRate)} avg=${String(p.avgFrameRate)}) — the detector that guards against ` +
          `post-transcode audio drift does not fire`,
      );
      const own = await probe(ctx, loud);
      need(
        own.meta.variableFrameRate === false,
        `the module's own render reads VFR (r=${String(own.rFrameRate)} avg=${String(own.avgFrameRate)}); ` +
          `the detector false-positives on the container's own reorder bookkeeping`,
      );
      return (
        `real VFR detected (r=${String(p.rFrameRate)} avg=${String(p.avgFrameRate)}) and the module's own ` +
        `CFR render is not flagged (r=${String(own.rFrameRate)} avg=${String(own.avgFrameRate)})`
      );
    });

    /* ---- 19. determinism, the claim the content-addressed cache rests on ---- */
    await rec.step('determinism: three identical renders are byte-identical', async () => {
      const hashes: string[] = [];
      const sizes: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const out = join(work, `det${i}.mp4`);
        await ffmpeg(ctx, buildConcatCommand({ clips: clipInputs, canvas: CANVAS, fps: SOURCE_FPS, output: out }).args);
        hashes.push(sha256(out));
        sizes.push(statSync(out).size);
      }
      need(
        new Set(hashes).size === 1,
        `three renders of one identical command produced ${new Set(hashes).size} distinct files (sizes ` +
          `${sizes.join(' / ')}). deterministic:true is a false promise and the content-addressed render cache ` +
          `never hits. Cause: x264's row-level VBV rate control reads the progress of concurrently encoding ` +
          `frames, so any thread count above 1 makes the bitstream timing-dependent.`,
      );
      return `3/3 renders identical (sha256 ${hashes[0]?.slice(0, 16)}, ${sizes[0]} bytes)`;
    });

    /* ---- 20. the diagnosis path, on a real failure ---- */
    await rec.step('diagnosis: a real render failure is explained, not just echoed', async () => {
      const silentMaster = join(work, 'silent_master.mp4');
      await ffmpeg(ctx, buildConcatCommand({
        clips: clipInputs, canvas: CANVAS, fps: SOURCE_FPS, output: silentMaster, withAudio: false,
      }).args);
      const p = await probe(ctx, silentMaster);
      need(p.meta.audioCodec === undefined, 'the withAudio:false render still carries an audio stream');
      // buildReframeCommand defaults to withAudio:true, so it maps 0:a against a track that is not there.
      const plan = planReframe(CANVAS, canvasFor('1:1'), 'centre-crop');
      const r = await ffmpegAllowFail(ctx, buildReframeCommand(silentMaster, join(work, 'never2.mp4'), plan, { sourceFps: SOURCE_FPS }));
      need(r.code !== 0, 'reframing an audio-less master with the default withAudio:true unexpectedly succeeded');
      const diagnosis = diagnoseFfmpegStderr(r.stderr);
      need(
        diagnosis !== undefined,
        `diagnoseFfmpegStderr returned undefined for the commonest real render failure. The operator is left ` +
          `with ffmpeg's own last line: "${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}"`,
      );
      // And an unknown filter must still be named.
      const uf = await ffmpegAllowFail(ctx, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1', '-vf', 'drawtext=text=x', '-f', 'null', '-']);
      const ufDiag = uf.code === 0 ? '(this build HAS drawtext, so the drawtext branch could not be exercised)' : String(diagnoseFfmpegStderr(uf.stderr)).slice(0, 60);
      return `audio-less master: exit ${r.code} diagnosed as "${diagnosis?.slice(0, 90)}..."; drawtext probe: ${ufDiag}`;
    });

    /* ---- 21. filter-argument escaping, executed rather than asserted ---- */
    await rec.step('escaping: escapeFilterArgument survives a real filtergraph', async () => {
      const results: string[] = [];
      const broken: string[] = [];
      for (const name of ['plain', 'co,mma', 'col:on', 'semi;colon', 'brack[et]']) {
        const p = join(work, `${name}.ass`);
        writeFileSync(p, readFileSync(assPath));
        const r = await ffmpegAllowFail(ctx, [
          '-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=160x160:r=5:d=0.2',
          '-vf', `ass=filename=${escapeFilterArgument(p)}`, '-f', 'null', '-',
        ]);
        results.push(`${name}=${r.code === 0 ? 'ok' : 'FAIL'}`);
        if (r.code !== 0) broken.push(`"${name}" -> ${escapeFilterArgument(p)} (${r.stderr.trim().split('\n').slice(-1)[0] ?? ''})`);
      }
      need(
        broken.length === 0,
        `escapeFilterArgument produces a filtergraph ffmpeg rejects for ${broken.length} of 5 character ` +
          `classes: ${broken.join(' ; ')}. A ":" is special at BOTH the filtergraph level and the filter-option ` +
          `level, so it needs two backslashes ("\\\\:"), not one; "," ";" "[" "]" are graph-level only and one ` +
          `is correct. Verified fix: value.replace(/([\\\\':])/g,'\\\\$1').replace(/([\\\\',;\\[\\]])/g,'\\\\$1'), ` +
          `which round-trips all of , : ; [ ] ' and backslash. Note test/assembly.test.ts:602 asserts the ` +
          `current single-backslash colon output and must change with it.`,
      );
      return `all five character classes round-tripped through a live ass=filename= graph: ${results.join(' ')}`;
    });

    return { module, checks: rec.checks };
  } catch (e) {
    rec.fail('probe harness', `the probe itself threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return { module, checks: rec.checks };
  } finally {
    if (dir !== undefined && process.env['VERIFY_KEEP_SCRATCH'] !== '1') {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* scratch cleanup is best-effort */
      }
    }
  }
}

/** Names reported as SKIP when the environment has no usable ffmpeg. */
const BLOCKED_WITHOUT_FFMPEG: readonly string[] = [
  'filters: every filter the module emits exists in this build',
  'sources: real 1080x1920 24fps clips with audio can be synthesised',
  'concat: buildConcatCommand renders a real master and ffprobe agrees',
  'container: moov is at the front and NO edit list is written',
  'xfade: offsets are on the output timeline and the render is that long',
  'reframe: 9:16 -> 4:5 and 1:1 in crop / pad / blur-pad give real dimensions',
  'setsar: removing the trailing setsar=1 really does yield non-square pixels',
  'reframe: an unsafe derivation is refused before a frame is encoded',
  'tracked-crop: a smoothed sendcmd path drives a real crop render',
  'loudness: the two-pass loudnorm lands on target and stays at 48 kHz',
  'loudness: single-pass loudnorm still emits 192 kHz in this build',
  'captions: libass burn-in runs and the .ass this module writes is accepted',
  'safe zone: the overlay-only bbox render measures inside Meta’s box',
  'detectors: blackdetect / freezedetect / silencedetect / signalstats all fire',
  'escalation: the contact sheet a human would look at actually renders',
  'QA: the module’s own render passes its own gates',
  'QA: a deliberately bad render is refused, gate by gate',
  'CFR: the variable-frame-rate detector fires on real VFR, not just on artefacts',
  'determinism: three identical renders are byte-identical',
  'diagnosis: a real render failure is explained, not just echoed',
  'escaping: escapeFilterArgument survives a real filtergraph',
];

/** Everything that needs source footage, once synthesis itself has failed. */
const BLOCKED_WITHOUT_CLIPS: readonly string[] = BLOCKED_WITHOUT_FFMPEG.slice(2);

/* ================================================================ standalone ==== */

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await run();
  const width = Math.max(...report.checks.map((c) => c.name.length));
  for (const c of report.checks) {
    process.stdout.write(`${c.status.padEnd(4)} ${c.name.padEnd(width)}  ${c.detail}\n`);
    if (c.blockedBy !== undefined) process.stdout.write(`     ${' '.repeat(width)}  blockedBy: ${c.blockedBy}\n`);
  }
  const n = (s: Check['status']): number => report.checks.filter((c) => c.status === s).length;
  process.stdout.write(`\n${report.module}: ${n('PASS')} pass / ${n('FAIL')} fail / ${n('SKIP')} skip\n`);
  process.exitCode = n('FAIL') > 0 ? 1 : 0;
}
