/**
 * ffmpeg is NOT installed in this environment and these tests never try to run it.
 * Everything is asserted against argv arrays and against the [MEASURED] sample outputs
 * recorded in docs/research/creative-production-pipeline.md. The runner is always a fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACROSSFADE_CURVES,
  AssemblyPlanError,
  BLACKDETECT_DEFAULTS,
  DEFAULT_ENCODE,
  EncodeSettingsError,
  FfmpegFailedError,
  FfmpegMissingError,
  LOUDNESS_TARGET,
  LoudnormParseError,
  MIN_CENTRE_CROP_RETENTION,
  RENDER_MATRIX,
  SAFE_ZONE,
  UnsafeReframeError,
  XFADE_TRANSITIONS,
  assColour,
  assTimestamp,
  assertFiltersAvailable,
  assertToolchain,
  buildAssFile,
  buildBlackdetectCommand,
  buildCaptionBurnFilter,
  buildConcatCommand,
  buildContactSheetCommand,
  buildEbur128Command,
  buildEncodeArgs,
  buildFirstFrameLumaCommand,
  buildFreezedetectCommand,
  buildLoudnormApplyCommand,
  buildLoudnormFilter,
  buildLoudnormMeasureCommand,
  buildProbeCommand,
  buildReframeCommand,
  buildReframeGraph,
  buildSafeZoneBboxCommand,
  buildSafeZoneLayerCommand,
  buildSilencedetectCommand,
  canvasFor,
  computeCropWindow,
  crossfadeOffsets,
  crossfadeTotalDuration,
  defaultCaptionStyle,
  diagnoseFfmpegStderr,
  escapeAssText,
  escapeFilterArgument,
  measureLoudness,
  moovBeforeMdat,
  moovContainsEditList,
  parseBboxFrames,
  parseBlackdetect,
  parseEbur128Summary,
  parseFilterNames,
  parseFreezedetect,
  parseLoudnormJson,
  parseProbeJson,
  parseRational,
  parseSignalstatsYavg,
  parseSilencedetect,
  parseToolVersion,
  planReframe,
  probeVideo,
  renderSendCmdScript,
  runTool,
  safeZoneBox,
  scanTopLevelBoxes,
  smoothCropPath,
  validateCrossfadePlan,
  type Canvas,
  type CommandResult,
  type CommandRunner,
  type FfmpegTools,
  type ProbeResult,
} from '../src/assembly/ffmpeg.ts';
import {
  PLACEMENT_DURATION_WINDOWS,
  QA_THRESHOLDS,
  QaBlockedError,
  assertPublishable,
  formatQaReport,
  gateAspectManifest,
  gateBlackFrames,
  gateContainerSpec,
  gateDuration,
  gateFrameRate,
  gateFreeze,
  gateLoudness,
  gateResolution,
  gateSafeZone,
  gateSilence,
  runQaGates,
} from '../src/assembly/qa.ts';

/* ------------------------------------------------------------------- fixtures ---- */

const NINE_SIXTEEN: Canvas = { width: 1080, height: 1920 };
const FOUR_FIVE: Canvas = { width: 1080, height: 1350 };
const SQUARE: Canvas = { width: 1080, height: 1080 };
const LANDSCAPE: Canvas = { width: 1920, height: 1080 };

function fakeRunner(
  responder: (bin: string, args: readonly string[]) => CommandResult | Promise<CommandResult>,
): { runner: CommandRunner; calls: { bin: string; args: readonly string[] }[] } {
  const calls: { bin: string; args: readonly string[] }[] = [];
  return {
    calls,
    runner: {
      async run(bin, args) {
        calls.push({ bin, args });
        return responder(bin, args);
      },
    },
  };
}

function tools(runner: CommandRunner): FfmpegTools {
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', runner };
}

/** A conformant 9:16 render, as ffprobe -show_streams -show_format -of json reports it. */
function probeJson(
  video: Record<string, unknown> = {},
  audio: Record<string, unknown> | null = {},
  format: Record<string, unknown> = {},
): string {
  const v = {
    index: 0,
    codec_name: 'h264',
    codec_type: 'video',
    profile: 'High',
    width: 1080,
    height: 1920,
    sample_aspect_ratio: '1:1',
    display_aspect_ratio: '9:16',
    pix_fmt: 'yuv420p',
    r_frame_rate: '30/1',
    avg_frame_rate: '30/1',
    bit_rate: '8106000',
    nb_frames: '721',
    ...video,
  };
  const a =
    audio === null
      ? undefined
      : {
          index: 1,
          codec_name: 'aac',
          codec_type: 'audio',
          sample_rate: '48000',
          channels: 2,
          bit_rate: '128000',
          ...audio,
        };
  return JSON.stringify({
    streams: a === undefined ? [v] : [v, a],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '24.033000',
      size: '24500000',
      ...format,
    },
  });
}

function goodProbe(overrides: Parameters<typeof probeJson>[0] = {}): ProbeResult {
  return parseProbeJson(probeJson(overrides), {
    moovAtomAtFront: true,
    hasEditLists: false,
  });
}

/* ================================================================= geometry ====== */

test('render matrix carries the documented canvases and marks 16:9 as regenerate-only', () => {
  assert.deepEqual(canvasFor('9:16'), { width: 1080, height: 1920 });
  assert.deepEqual(canvasFor('4:5'), { width: 1080, height: 1350 });
  assert.deepEqual(canvasFor('1:1'), { width: 1080, height: 1080 });
  assert.equal(RENDER_MATRIX['4:5'].derive, 'centre-crop');
  // Deriving 16:9 from a 9:16 master is a 68% crop of the wrong axis. Never automatic.
  assert.equal(RENDER_MATRIX['16:9'].derive, 'regenerate');
  assert.ok(RENDER_MATRIX['1:1'].placements.includes('facebook:facebook_reels_overlay'));
});

test('retained-fraction maths reproduces the dossier percentages', () => {
  // [MEASURED] 9:16 -> 4:5 keeps 70% of the height, -> 1:1 keeps 56%.
  assert.equal(planReframe(NINE_SIXTEEN, FOUR_FIVE, 'centre-crop').axis, 'height');
  assert.ok(Math.abs(planReframe(NINE_SIXTEEN, FOUR_FIVE, 'centre-crop').retainedFraction - 0.703) < 0.001);
  assert.ok(Math.abs(planReframe(NINE_SIXTEEN, SQUARE, 'centre-crop').retainedFraction - 0.5625) < 0.0001);
  // 16:9 -> 9:16 keeps 31.6% of the WIDTH.
  const bad = planReframe(LANDSCAPE, NINE_SIXTEEN, 'centre-crop');
  assert.equal(bad.axis, 'width');
  assert.ok(Math.abs(bad.retainedFraction - 0.3164) < 0.001);
  assert.equal(bad.safeForNaiveCrop, false);
  assert.ok(MIN_CENTRE_CROP_RETENTION > 0.3164 && MIN_CENTRE_CROP_RETENTION <= 0.5625);
});

test('every geometry chain terminates in setsar=1 — the non-square-pixel bug', () => {
  const crop = buildReframeGraph(planReframe(NINE_SIXTEEN, FOUR_FIVE, 'centre-crop'));
  assert.match(crop, /setsar=1\[v\]$/);
  assert.match(crop, /force_divisible_by=2/);
  assert.equal(crop, '[0:v]scale=1080:1350:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1350,setsar=1[v]');

  // pad inherits SAR 2025:2024 from the scale, so setsar=1 must come LAST, after pad.
  const pad = buildReframeGraph(planReframe(NINE_SIXTEEN, FOUR_FIVE, 'scale-pad'));
  assert.match(pad, /pad=1080:1350:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black,setsar=1\[v\]$/);
  assert.ok(pad.indexOf('setsar=1') > pad.indexOf('pad='));

  const blur = buildReframeGraph(planReframe(LANDSCAPE, NINE_SIXTEEN, 'blur-pad'));
  assert.match(blur, /gblur=sigma=40/);
  assert.match(blur, /overlay=\(W-w\)\/2:\(H-h\)\/2:format=auto,setsar=1\[v\]$/);
});

test('16:9 -> 9:16 centre crop is refused with the numbers that justify the refusal', () => {
  const plan = planReframe(LANDSCAPE, NINE_SIXTEEN, 'centre-crop');
  assert.throws(
    () => buildReframeGraph(plan),
    (e: unknown) => {
      assert.ok(e instanceof UnsafeReframeError);
      assert.match(e.message, /31\.6% of the width/);
      assert.match(e.message, /tracked-crop/);
      assert.match(e.message, /blur-pad/);
      return true;
    },
  );
  // The narrower derivations the render matrix actually asks for stay allowed.
  assert.doesNotThrow(() => buildReframeGraph(planReframe(NINE_SIXTEEN, SQUARE, 'centre-crop')));
});

test('crop window is even and matches the measured 608x1080 for 16:9 -> 9:16', () => {
  assert.deepEqual(computeCropWindow(LANDSCAPE, NINE_SIXTEEN), { width: 608, height: 1080, axis: 'width' });
  assert.deepEqual(computeCropWindow(NINE_SIXTEEN, FOUR_FIVE), { width: 1080, height: 1350, axis: 'height' });
  assert.deepEqual(computeCropWindow(NINE_SIXTEEN, NINE_SIXTEEN), { width: 1080, height: 1920, axis: 'none' });
  // Odd dimensions are a hard libx264 failure, never a warning.
  assert.equal(computeCropWindow({ width: 1001, height: 1000 }, SQUARE).width % 2, 0);
});

test('tracked-crop refuses without a command file and otherwise drives crop x/y via sendcmd', () => {
  const plan = planReframe(LANDSCAPE, NINE_SIXTEEN, 'tracked-crop');
  assert.throws(() => buildReframeGraph(plan), AssemblyPlanError);
  const graph = buildReframeGraph(plan, {}, { commandFile: '/w/crop.cmd', initialX: 200, initialY: 0 });
  assert.match(graph, /sendcmd=f=\/w\/crop\.cmd/);
  assert.match(graph, /crop=w=608:h=1080:x=200:y=0/);
  assert.match(graph, /scale=1080:1920:force_divisible_by=2,setsar=1\[v\]$/);
});

test('crop path is smoothed, velocity-clamped and clamped to the frame', () => {
  const crop = { width: 608, height: 1080 };
  // A tracker that teleports the subject across the frame between two 10 Hz samples.
  const path = smoothCropPath(
    [
      { timeSeconds: 0, centreX: 304, centreY: 540 },
      { timeSeconds: 0.1, centreX: 1900, centreY: 540 },
    ],
    LANDSCAPE,
    crop,
    { fps: 30, emaAlpha: 1, maxVelocityPxPerFrame: 15 },
  );
  assert.equal(path[0]?.x, 0);
  // 0.1s at 30fps = 3 frames of budget = 45px, not the full 1312px jump.
  assert.equal(path[1]?.x, 45);

  const clamped = smoothCropPath(
    [{ timeSeconds: 0, centreX: 5000, centreY: -900 }],
    LANDSCAPE,
    crop,
    { fps: 30 },
  );
  assert.equal(clamped[0]?.x, LANDSCAPE.width - crop.width);
  assert.equal(clamped[0]?.y, 0);

  assert.equal(
    renderSendCmdScript([{ timeSeconds: 0, x: 200, y: 0 }, { timeSeconds: 0.1, x: 210, y: 0 }]),
    '0 crop x 200, crop y 0;\n0.1 crop x 210, crop y 0;\n',
  );
});

/* ================================================================== concat ======= */

test('crossfade offsets are on the accumulating output timeline, not the source clips', () => {
  // [MEASURED] 3x4s with 2x0.5s transitions -> offsets 3.5 and 7.0, total 11.03s.
  assert.deepEqual(crossfadeOffsets([4, 4, 4], [0.5, 0.5]), [3.5, 7]);
  assert.equal(crossfadeTotalDuration([4, 4, 4], [0.5, 0.5]), 11);
});

test('hard-cut concat re-encodes and normalises every input first', () => {
  const plan = buildConcatCommand({
    clips: [
      { path: 's1.mp4', durationSeconds: 4 },
      { path: 's2.mp4', durationSeconds: 4 },
      { path: 's3.mp4', durationSeconds: 4 },
    ],
    canvas: NINE_SIXTEEN,
    fps: 30,
    output: 'out.mp4',
  });
  // The concat filter's precondition: identical w/h/SAR/pix_fmt and identical audio params.
  assert.match(plan.filterGraph, /\[0:v\]scale=1080:1920:[^;]*setsar=1,fps=30,format=yuv420p\[v0\]/);
  assert.match(plan.filterGraph, /\[0:a\]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo\[a0\]/);
  assert.match(plan.filterGraph, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[v\]\[a\]/);
  assert.equal(plan.expectedDurationSeconds, 12);
  // Never `-c copy`: the concat demuxer needs byte-level parameter identity across inputs.
  assert.ok(!plan.args.includes('-c'));
  assert.ok(plan.args.includes('-filter_complex'));
  assert.equal(plan.args.filter((a) => a === '-i').length, 3);
  assert.equal(plan.args[plan.args.length - 1], 'out.mp4');
});

test('xfade chain emits the measured offsets and acrossfade for audio', () => {
  const plan = buildConcatCommand({
    clips: [
      { path: 's1.mp4', durationSeconds: 4 },
      { path: 's2.mp4', durationSeconds: 4 },
      { path: 's3.mp4', durationSeconds: 4 },
    ],
    canvas: NINE_SIXTEEN,
    fps: 30,
    output: 'out.mp4',
    transitions: [
      { kind: 'fade', durationSeconds: 0.5 },
      { kind: 'smoothleft', durationSeconds: 0.5 },
    ],
  });
  assert.match(plan.filterGraph, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.5:offset=3\.5\[vx0\]/);
  assert.match(plan.filterGraph, /\[vx0\]\[v2\]xfade=transition=smoothleft:duration=0\.5:offset=7\[v\]/);
  assert.match(plan.filterGraph, /\[a0\]\[a1\]acrossfade=d=0\.5:c1=tri:c2=tri\[ax0\]/);
  assert.equal(plan.expectedDurationSeconds, 11);
  assert.ok(XFADE_TRANSITIONS.includes('smoothleft'));
  assert.ok(ACROSSFADE_CURVES.includes('tri'));
});

test('unrenderable crossfade plans are refused before any frame is encoded', () => {
  // N clips need exactly N-1 transitions.
  assert.throws(
    () =>
      buildConcatCommand({
        clips: [
          { path: 'a.mp4', durationSeconds: 4 },
          { path: 'b.mp4', durationSeconds: 4 },
        ],
        canvas: NINE_SIXTEEN,
        fps: 30,
        output: 'o.mp4',
        transitions: [
          { kind: 'fade', durationSeconds: 0.5 },
          { kind: 'fade', durationSeconds: 0.5 },
        ],
      }),
    /exactly N-1 transitions/,
  );
  // A transition at least as long as the clips it joins.
  assert.throws(
    () => validateCrossfadePlan([1, 1], [1]),
    (e: unknown) => {
      assert.ok(e instanceof AssemblyPlanError);
      assert.match(e.message, /shorter than both clips/);
      return true;
    },
  );
  assert.throws(() => validateCrossfadePlan([4, 4], [0]), /non-positive duration/);
  // An fps stated twice, differently, would resample the graph out from under the cues.
  assert.throws(
    () =>
      buildConcatCommand({
        clips: [{ path: 'a.mp4', durationSeconds: 4 }],
        canvas: NINE_SIXTEEN,
        fps: 30,
        output: 'o.mp4',
        encode: { fps: 24 },
      }),
    /contradicts the graph's fps/,
  );
});

test('concat is not a back door around the centre-crop refusal', () => {
  // The normalisation chain centre-crops every input to the canvas. A 16:9 clip in a 9:16
  // ad keeps 31.6% of its width — the derivation buildReframeGraph refuses outright.
  assert.throws(
    () =>
      buildConcatCommand({
        clips: [
          { path: 'v.mp4', durationSeconds: 4, width: 1080, height: 1920 },
          { path: 'h.mp4', durationSeconds: 4, width: 1920, height: 1080 },
        ],
        canvas: NINE_SIXTEEN,
        fps: 30,
        output: 'o.mp4',
      }),
    (e: unknown) => {
      assert.ok(e instanceof AssemblyPlanError);
      assert.match(e.message, /clip 1 \("h\.mp4"\) is 1920x1080/);
      assert.match(e.message, /31\.6% of its width/);
      assert.match(e.message, /tracked-crop/);
      return true;
    },
  );
  // 9:16 -> 1:1 keeps 56.3% and stays allowed, exactly as in buildReframeGraph.
  assert.doesNotThrow(() =>
    buildConcatCommand({
      clips: [{ path: 'v.mp4', durationSeconds: 4, width: 1080, height: 1920 }],
      canvas: SQUARE,
      fps: 30,
      output: 'o.mp4',
    }),
  );
});

/* ================================================================= encoding ====== */

test('the Meta encode satisfies every stated requirement', () => {
  const args = buildEncodeArgs({}, { fps: 30, canvas: NINE_SIXTEEN });
  const s = args.join(' ');
  assert.match(s, /-c:v libx264/);
  assert.match(s, /-profile:v high/);
  assert.match(s, /-pix_fmt yuv420p/); // 4:2:0 — generative models emit yuv444p, Meta returns 352
  assert.match(s, /-x264-params keyint=60:min-keyint=60:scenecut=0:bframes=2:ref=3/);
  assert.match(s, /-r 30/); // fixed frame rate; VFR desynchronises after Meta's transcode
  assert.match(s, /-c:a aac -b:a 128k -ar 48000 -ac 2/);
  assert.match(s, /-movflags \+faststart/);
  assert.match(s, /-video_track_timescale 30000/);
  assert.match(s, /-fflags \+bitexact/);
  assert.match(s, /-map_metadata -1/);
  assert.match(s, /-avoid_negative_ts make_zero/);
  assert.equal(DEFAULT_ENCODE.videoBitrateBps, 8_000_000);
});

test('faststart cannot be turned off, in any configuration', () => {
  for (const o of [{}, { withAudio: false }, { deterministic: false }, { fps: 24 }, { gopSeconds: 1 }]) {
    assert.ok(buildEncodeArgs(o).join(' ').includes('-movflags +faststart'));
  }
  assert.ok(buildEncodeArgs({ withAudio: false }).includes('-an'));
});

test('encode settings outside the spec fail loudly, and name whose spec it is', () => {
  assert.throws(() => buildEncodeArgs({ fps: 61 }), (e: unknown) => {
    assert.ok(e instanceof EncodeSettingsError);
    assert.match(e.message, /23-60 fps range Instagram publishes for organic video/);
    // 23-60 is ORGANIC_SPEC. The message must not tell a 3am reader that Meta documents
    // it for ads, because they will act on what it says.
    assert.match(e.message, /Meta documents no fps range for ads/);
    return true;
  });
  assert.throws(() => buildEncodeArgs({ fps: 22 }), EncodeSettingsError);
  assert.throws(() => buildEncodeArgs({ videoBitrateBps: 30_000_000 }), /25Mbps maximum/);
  assert.throws(() => buildEncodeArgs({ audioBitrateBps: 96_000 }), /128kbps\+/);
  assert.throws(
    () => buildEncodeArgs({}, { canvas: { width: 3840, height: 2160 } }),
    /1920 horizontal pixel maximum/,
  );
  // keyint=1 (every frame an IDR) and a maxrate under -b:v are both silent, not loud.
  assert.throws(() => buildEncodeArgs({ gopSeconds: 0 }), /gopSeconds must be positive/);
  assert.throws(
    () => buildEncodeArgs({ videoBitrateBps: 10_000_000, maxrateBps: 6_000_000 }),
    /silently run at maxrate/,
  );
});

test('reframe command maps video from the graph and audio from the source', () => {
  const plan = planReframe(NINE_SIXTEEN, FOUR_FIVE, 'centre-crop');
  const args = buildReframeCommand('master.mp4', 'out_4x5.mp4', plan, { sourceFps: 24 });
  const s = args.join(' ');
  assert.match(s, /-i master\.mp4/);
  assert.match(s, /-map \[v\] -map 0:a/);
  assert.match(s, /setsar=1\[v\]/);
  assert.match(s, /-movflags \+faststart/);
  assert.equal(args[args.length - 1], 'out_4x5.mp4');
  // The derived cut keeps the master's frame rate. Veo and Seedance emit 24 fps; a default
  // of 30 here would duplicate every fourth frame of a cut nobody watches before it ships.
  assert.match(s, /-r 24 /);
  assert.match(s, /-video_track_timescale 24000/);
  assert.throws(
    () => buildReframeCommand('m.mp4', 'o.mp4', plan, { sourceFps: 24, encode: { fps: 30 } }),
    /contradicts the master's 24 fps/,
  );
});

/* ================================================================= loudness ====== */

const MEASURED_LOUDNORM_JSON = `
[Parsed_loudnorm_0 @ 0x5601]
{
	"input_i" : "-21.91",
	"input_tp" : "-20.01",
	"input_lra" : "0.50",
	"input_thresh" : "-31.91",
	"output_i" : "-13.91",
	"output_tp" : "-11.98",
	"output_lra" : "0.40",
	"output_thresh" : "-23.91",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.09"
}
`;

test('pass one asks for JSON and pass two feeds every measured value back', () => {
  const measure = buildLoudnormMeasureCommand('in.mp4').join(' ');
  assert.match(measure, /loudnorm=I=-14:TP=-1:LRA=11:print_format=json/);
  assert.match(measure, /-f null -/);

  const m = parseLoudnormJson(MEASURED_LOUDNORM_JSON);
  assert.equal(m.inputI, -21.91);
  assert.equal(m.inputTp, -20.01);
  assert.equal(m.targetOffset, -0.09);
  assert.equal(m.normalizationType, 'dynamic');

  const filter = buildLoudnormFilter(m);
  assert.match(filter, /measured_I=-21\.91/);
  assert.match(filter, /measured_TP=-20\.01/);
  assert.match(filter, /measured_LRA=0\.5/);
  assert.match(filter, /measured_thresh=-31\.91/);
  assert.match(filter, /offset=-0\.09/);
  // linear=true keeps 48 kHz and makes the gain predictable; single-pass emits 192 kHz.
  assert.match(filter, /linear=true/);
  assert.ok(filter.endsWith(',aresample=48000'));

  const apply = buildLoudnormApplyCommand('in.mp4', 'out.mp4', m).join(' ');
  assert.match(apply, /-ar 48000 -ac 2/);
  assert.equal(LOUDNESS_TARGET.integratedLufs, -14);
});

test('loudnorm parsing takes the LAST object and refuses digital silence', () => {
  const noisy = `{"input_i":"-9.9"}\nsome log line\n${MEASURED_LOUDNORM_JSON}`;
  assert.equal(parseLoudnormJson(noisy).inputI, -21.91);

  assert.throws(
    () => parseLoudnormJson('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-inf","target_offset":"0","normalization_type":"dynamic"}'),
    (e: unknown) => {
      assert.ok(e instanceof LoudnormParseError);
      assert.match(e.message, /digital silence/);
      return true;
    },
  );
  assert.throws(() => parseLoudnormJson('no json here'), LoudnormParseError);
  assert.throws(() => parseLoudnormJson('{"input_i":"-14"}'), /missing "input_tp"/);
});

/* ================================================================= captions ====== */

test('ASS colours are &HAABBGGRR with inverted alpha, and booleans are -1', () => {
  assert.equal(assColour('FFFFFF'), '&H00FFFFFF');
  assert.equal(assColour('000000'), '&H00000000');
  // 59% transparent black == the dossier's &H96000000 box colour.
  assert.equal(assColour('000000', 59), '&H96000000');
  // BGR order: #FF8800 (orange) becomes 0088FF, not FF8800.
  assert.equal(assColour('#FF8800'), '&H000088FF');
  assert.throws(() => assColour('xyz'), AssemblyPlanError);
  assert.throws(() => assColour('FFFFFF', 101), AssemblyPlanError);
});

test('ASS timestamps are H:MM:SS.CC', () => {
  assert.equal(assTimestamp(0), '0:00:00.00');
  assert.equal(assTimestamp(2.5), '0:00:02.50');
  assert.equal(assTimestamp(65.03), '0:01:05.03');
  assert.equal(assTimestamp(3661.999), '1:01:02.00');
  assert.throws(() => assTimestamp(-1), AssemblyPlanError);
});

test('authored .ass carries explicit PlayRes and safe-zone margins', () => {
  const ass = buildAssFile(NINE_SIXTEEN, [
    { startSeconds: 0, endSeconds: 2, text: 'THIS IS THE HOOK' },
    { startSeconds: 2, endSeconds: 5, text: 'SECOND LINE' },
  ]);
  // PlayResX/Y must equal the video dimensions or libass scales every size and margin.
  assert.match(ass, /^PlayResX: 1080$/m);
  assert.match(ass, /^PlayResY: 1920$/m);
  // MarginV = 0.35 * 1920 = 672, the [MEASURED] safe-zone-correct value. The whole line is
  // the dossier's measured style line, byte for byte — including the &HAABBGGRR colours.
  assert.match(
    ass,
    /^Style: Cap,DejaVu Sans,72,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,6,0,2,65,65,672,1$/m,
  );
  assert.match(ass, /^Dialogue: 0,0:00:00\.00,0:00:02\.00,Cap,,0,0,0,,THIS IS THE HOOK$/m);

  const style = defaultCaptionStyle(NINE_SIXTEEN);
  assert.equal(style.marginVertical, 672);
  assert.equal(style.marginLeft, 65);
  assert.equal(style.fontSizePx, 72);
  assert.equal(style.bold, true);
  // Never ship captions with neither a box nor an outline: you do not control the frame.
  assert.equal(style.borderStyle, 3);
  assert.ok(style.outline > 0);
  // A 4:5 cut gets proportionally smaller type, not 72px on a shorter canvas.
  assert.equal(defaultCaptionStyle(FOUR_FIVE).fontSizePx, 51);
});

test('caption timings are derived, so an inverted event is a hard error', () => {
  assert.throws(
    () => buildAssFile(NINE_SIXTEEN, [{ startSeconds: 2, endSeconds: 2, text: 'x' }]),
    /re-align rather than patching offsets/,
  );
});

test('text and filter-path escaping', () => {
  assert.equal(escapeAssText('a\nb'), 'a\\Nb');
  assert.ok(!escapeAssText('{\\an8}hi').includes('{'));
  assert.equal(escapeFilterArgument('C:/w/o.ass'), 'C\\:/w/o.ass');
  assert.equal(escapeFilterArgument("a,b;c[d]"), 'a\\,b\\;c\\[d\\]');
});

test('burn-in uses libass, never drawtext', () => {
  const f = buildCaptionBurnFilter('/w/cap.ass', '/opt/fonts');
  assert.equal(f, 'ass=filename=/w/cap.ass:fontsdir=/opt/fonts');
  assert.ok(!f.includes('drawtext'));
  assert.equal(buildCaptionBurnFilter('/w/cap.ass'), 'ass=filename=/w/cap.ass');
});

test('safe-zone box reproduces the measured 1080x1920 numbers', () => {
  assert.deepEqual(safeZoneBox(NINE_SIXTEEN), { x0: 64, x1: 1015, y0: 268, y1: 1248 });
  assert.equal(SAFE_ZONE.bottomFraction, 0.35);
});

/* ================================================================= detectors ===== */

test('blackdetect lowers d from its 2s default, which would miss a black first frame', () => {
  assert.equal(BLACKDETECT_DEFAULTS.minDurationSeconds, 0.2);
  assert.match(buildBlackdetectCommand('in.mp4').join(' '), /blackdetect=d=0\.2:pic_th=0\.98:pix_th=0\.1/);
  const parsed = parseBlackdetect(
    '[blackdetect @ 0x7f] black_start:0 black_end:1.033333 black_duration:1.033333\n' +
      '[blackdetect @ 0x7f] black_start:5.5 black_end:5.8 black_duration:0.3\n',
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { startSeconds: 0, endSeconds: 1.033333, durationSeconds: 1.033333 });
  assert.equal(parsed[1]?.durationSeconds, 0.3);
});

test('freezedetect pairs its three separate metadata lines, and keeps a run that hits EOF', () => {
  assert.match(buildFreezedetectCommand('in.mp4').join(' '), /freezedetect=n=0\.001:d=0\.5/);
  const out = parseFreezedetect(
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0\n' +
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.033333\n' +
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 1.033333\n',
  );
  assert.deepEqual(out, [{ startSeconds: 0, endSeconds: 1.033333, durationSeconds: 1.033333 }]);

  const unterminated = parseFreezedetect(
    'lavfi.freezedetect.freeze_start: 20\nlavfi.freezedetect.freeze_duration: 4\n',
  );
  assert.equal(unterminated.length, 1);
  assert.equal(unterminated[0]?.durationSeconds, 4);
});

test('silencedetect parses the start/end pair', () => {
  assert.match(buildSilencedetectCommand('in.mp4').join(' '), /silencedetect=n=-50dB:d=0\.5/);
  const out = parseSilencedetect(
    '[silencedetect @ 0x1] silence_start: 0\n' +
      '[silencedetect @ 0x1] silence_end: 1.021354 | silence_duration: 1.021354\n',
  );
  assert.deepEqual(out, [{ startSeconds: 0, endSeconds: 1.021354, durationSeconds: 1.021354 }]);
});

test('ebur128 summary is read from the summary block, not the per-frame lines', () => {
  assert.match(buildEbur128Command('in.mp4').join(' '), /ebur128=peak=true/);
  const stderr =
    '[Parsed_ebur128_0 @ 0x1] t: 0.4  M: -70.0 S: -70.0     I: -70.0 LUFS     LRA: 0.0 LU\n' +
    '[Parsed_ebur128_0 @ 0x1] t: 0.9  M: -22.0 S: -30.0     I: -99.0 LUFS     LRA: 0.0 LU\n' +
    '[Parsed_ebur128_0 @ 0x1] Summary:\n' +
    '\n' +
    '  Integrated loudness:\n' +
    '    I:         -14.0 LUFS\n' +
    '    Threshold: -24.0 LUFS\n' +
    '\n' +
    '  Loudness range:\n' +
    '    LRA:         0.6 LU\n' +
    '    Threshold: -34.0 LUFS\n' +
    '\n' +
    '  True peak:\n' +
    '    Peak:      -20.0 dBFS\n';
  const s = parseEbur128Summary(stderr);
  assert.equal(s.integratedLufs, -14);
  assert.equal(s.thresholdLufs, -24);
  assert.equal(s.loudnessRangeLu, 0.6);
  assert.equal(s.truePeakDbfs, -20);
  assert.throws(() => parseEbur128Summary('no summary'), AssemblyPlanError);
});

test('first-frame luma probe and its limited-range reading', () => {
  assert.match(buildFirstFrameLumaCommand('in.mp4').join(' '), /select=eq\(n\\,0\),signalstats,metadata=print/);
  // [MEASURED] a true-black frame reports 16, not 0.
  assert.equal(parseSignalstatsYavg('[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YAVG=16'), 16);
  assert.equal(parseSignalstatsYavg('nothing'), undefined);
});

test('safe-zone layer renders the overlay alone onto black', () => {
  const png = buildSafeZoneLayerCommand('/w/cap.ass', NINE_SIXTEEN, 24, '/w/layer_%03d.png').join(' ');
  assert.match(png, /color=c=black:s=1080x1920:r=30:d=24/);
  assert.match(png, /ass=filename=\/w\/cap\.ass/);

  const bbox = buildSafeZoneBboxCommand('/w/cap.ass', NINE_SIXTEEN, 24).join(' ');
  assert.match(bbox, /bbox=min_val=16/); // limited-range black again
  const frames = parseBboxFrames(
    '[Parsed_bbox_1 @ 0x1] n:0 pts:0 pts_time:0 x1:223 x2:859 y1:1187 y2:1234 w:637 h:48\n',
  );
  assert.deepEqual(frames, [{ frame: 0, x0: 223, x1: 859, y0: 1187, y1: 1234 }]);

  assert.match(buildContactSheetCommand('in.mp4', 'sheet.png').join(' '), /fps=1,scale=270:-1,tile=6x5/);
});

/* ================================================================== ffprobe ====== */

test('ffprobe output becomes the struct the ad-spec validator already understands', () => {
  const p = goodProbe();
  assert.equal(p.meta.width, 1080);
  assert.equal(p.meta.height, 1920);
  assert.equal(p.meta.frameRate, 30);
  assert.equal(p.meta.videoCodec, 'h264');
  assert.equal(p.meta.audioCodec, 'aac');
  assert.equal(p.meta.audioSampleRateHz, 48000);
  assert.equal(p.meta.audioChannels, 2);
  assert.equal(p.meta.pixelFormat, 'yuv420p');
  assert.equal(p.meta.pixelAspectRatio, 1);
  assert.equal(p.meta.variableFrameRate, false);
  assert.equal(p.meta.durationSeconds, 24.033);
  assert.equal(p.meta.fileSizeBytes, 24_500_000);
  assert.equal(p.profile, 'High');
  assert.equal(p.nbFrames, 721);
});

test('probe flags VFR and the non-square SAR the pad bug produces', () => {
  const vfr = parseProbeJson(probeJson({ r_frame_rate: '30/1', avg_frame_rate: '29001/1000' }));
  assert.equal(vfr.meta.variableFrameRate, true);
  // [MEASURED] SAR 2025:2024 from pad after force_original_aspect_ratio.
  const sar = parseProbeJson(probeJson({ sample_aspect_ratio: '2025:2024' }));
  assert.ok((sar.meta.pixelAspectRatio ?? 1) !== 1);
  // Unknown rather than falsely clean when the probe cannot say.
  const unknown = parseProbeJson(probeJson({ sample_aspect_ratio: 'N/A', avg_frame_rate: '0/0' }));
  assert.equal(unknown.meta.pixelAspectRatio, undefined);
  assert.equal(unknown.meta.variableFrameRate, undefined);
});

test('rational parsing', () => {
  assert.ok(Math.abs((parseRational('30000/1001') ?? 0) - 29.97) < 0.01);
  assert.equal(parseRational('30/1'), 30);
  assert.equal(parseRational('0/0'), undefined);
  assert.equal(parseRational('N/A'), undefined);
  assert.equal(parseRational(undefined), undefined);
});

test('probe commands and a video-less file', () => {
  assert.deepEqual(buildProbeCommand('a.mp4'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', 'a.mp4']);
  assert.throws(
    () => parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} })),
    /no video stream/,
  );
  assert.throws(() => parseProbeJson('not json'), AssemblyPlanError);
});

/* ============================================================== mp4 box order ==== */

function box(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}
function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test('moov position is checked by walking the box list, because ffprobe cannot see it', () => {
  // [MEASURED] with +faststart:    ftyp moov free mdat
  //            without +faststart: ftyp free mdat moov
  const good = join(box('ftyp'), box('moov', new Uint8Array(16)), box('free'), box('mdat', new Uint8Array(32)));
  const bad = join(box('ftyp'), box('free'), box('mdat', new Uint8Array(32)), box('moov', new Uint8Array(16)));
  assert.deepEqual(scanTopLevelBoxes(good).map((b) => b.type), ['ftyp', 'moov', 'free', 'mdat']);
  assert.equal(moovBeforeMdat(scanTopLevelBoxes(good)), true);
  assert.equal(moovBeforeMdat(scanTopLevelBoxes(bad)), false);
  // A truncated head is unknown, not false — the caller must not read that as a pass.
  assert.equal(moovBeforeMdat(scanTopLevelBoxes(box('ftyp'))), undefined);
});

test('edit lists are detected inside moov only', () => {
  const withElst = join(box('ftyp'), box('moov', box('elst', new Uint8Array(4))), box('mdat', new Uint8Array(8)));
  assert.equal(moovContainsEditList(withElst, scanTopLevelBoxes(withElst)), true);

  const clean = join(box('ftyp'), box('moov', box('mvhd', new Uint8Array(4))), box('mdat', new Uint8Array(8)));
  assert.equal(moovContainsEditList(clean, scanTopLevelBoxes(clean)), false);

  // 'elst' bytes sitting in mdat must not produce a false positive.
  const decoy = join(box('ftyp'), box('moov', box('mvhd')), box('mdat', new TextEncoder().encode('elst')));
  assert.equal(moovContainsEditList(decoy, scanTopLevelBoxes(decoy)), false);
});

/* ============================================================= runner / probes === */

test('a missing binary is named, not swallowed', async () => {
  const { runner } = fakeRunner(() => {
    throw new FfmpegMissingError('ffmpeg', 'ENOENT');
  });
  await assert.rejects(runTool(runner, 'ffmpeg', ['-version']), (e: unknown) => {
    assert.ok(e instanceof FfmpegMissingError);
    assert.equal(e.binary, 'ffmpeg');
    assert.match(e.message, /could not be executed/);
    return true;
  });
});

test('a non-zero exit becomes an error naming the actual cause', async () => {
  const { runner } = fakeRunner(() => ({
    code: 1,
    stdout: '',
    stderr: "[AVFilterGraph @ 0x1] No such filter: 'drawtext'\nError initializing complex filters.\n",
  }));
  await assert.rejects(runTool(runner, 'ffmpeg', ['-vf', 'drawtext=text=x', 'o.mp4']), (e: unknown) => {
    assert.ok(e instanceof FfmpegFailedError);
    assert.match(e.message, /libharfbuzz/);
    assert.equal(e.code, 1);
    return true;
  });
  assert.match(String(diagnoseFfmpegStderr('[libx264 @ 0x1] width not divisible by 2 (759x1350)')), /force_divisible_by=2/);
  assert.match(String(diagnoseFfmpegStderr('Fontconfig error: Cannot load default config file')), /libass could not resolve a font/);
  assert.equal(diagnoseFfmpegStderr('everything was fine'), undefined);
});

test('toolchain and filter availability are checked before a render, not during one', async () => {
  const { runner, calls } = fakeRunner((bin) => ({
    code: 0,
    stdout: `${bin} version 7.0.2-static https://johnvansickle.com/ffmpeg/\n`,
    stderr: '',
  }));
  const versions = await assertToolchain(tools(runner));
  assert.equal(versions.ffmpeg, '7.0.2-static');
  assert.equal(versions.ffprobe, '7.0.2-static');
  assert.equal(calls.length, 2);
  assert.equal(parseToolVersion('ffprobe version n6.1.1 Copyright'), 'n6.1.1');

  const names = parseFilterNames(
    'Filters:\n  T.. = Timeline support\n' +
      ' T.. ass               V->V       Render ASS subtitles onto input video using the libass library.\n' +
      ' ... scale             V->V       Scale the input video size.\n',
  );
  assert.ok(names.has('ass'));
  assert.ok(names.has('scale'));
  assert.doesNotThrow(() => assertFiltersAvailable(names, ['ass', 'scale']));
  assert.throws(() => assertFiltersAvailable(names, ['ass', 'xfade', 'loudnorm']), (e: unknown) => {
    assert.ok(e instanceof AssemblyPlanError);
    assert.deepEqual(e.problems, ['xfade', 'loudnorm']);
    return true;
  });
  assert.throws(() => assertFiltersAvailable(new Set(['scale']), ['ass']), /no libass/);
});

test('probe and loudness helpers go through the injected runner only', async () => {
  const { runner, calls } = fakeRunner((bin) =>
    bin === 'ffprobe'
      ? { code: 0, stdout: probeJson(), stderr: '' }
      : { code: 0, stdout: '', stderr: MEASURED_LOUDNORM_JSON },
  );
  const t = tools(runner);
  const p = await probeVideo(t, 'in.mp4', { moovAtomAtFront: true, hasEditLists: false });
  assert.equal(p.meta.width, 1080);
  const m = await measureLoudness(t, 'in.mp4');
  assert.equal(m.inputI, -21.91);
  assert.deepEqual(calls.map((c) => c.bin), ['ffprobe', 'ffmpeg']);
});

/* ==================================================================== QA gates === */

test('container gate delegates to the ad-video spec validator and blocks on ERROR', () => {
  assert.equal(gateContainerSpec(goodProbe()).status, 'PASS');
  const bad = gateContainerSpec(parseProbeJson(probeJson({ pix_fmt: 'yuv444p' }), { moovAtomAtFront: false }));
  assert.equal(bad.status, 'FAIL');
  assert.ok(bad.evidence.some((e) => e.includes('yuv444p')));
  assert.ok(bad.evidence.some((e) => e.includes('faststart')));
});

test('container gate SKIPs — never passes — when the box scan was not run', () => {
  // ffprobe cannot see either fact, so a probe without the box scan leaves both unknown.
  // validateAdVideoSpec can only WARN about them, and a warning does not block; without a
  // SKIP here the two commonest causes of error 6000 sail through the gate meant to catch
  // them.
  const unscanned = gateContainerSpec(parseProbeJson(probeJson()));
  assert.equal(unscanned.status, 'SKIP');
  assert.match(unscanned.evidence.join(' '), /moovAtomAtFront: the box order was never read/);
  assert.match(unscanned.evidence.join(' '), /never scanned for `elst`/);

  // Half the scan is still a skip.
  assert.equal(
    gateContainerSpec(parseProbeJson(probeJson(), { moovAtomAtFront: true })).status,
    'SKIP',
  );
  assert.equal(gateContainerSpec(goodProbe()).status, 'PASS');

  // And it blocks the whole report until the waiver is written down.
  const report = runQaGates({ ...fullQaInput(), probe: parseProbeJson(probeJson()) });
  assert.equal(report.ok, false);
  assert.deepEqual(report.unwaivedSkips.map((r) => r.gate), ['CONTAINER_SPEC']);
  assert.equal(
    runQaGates(
      { ...fullQaInput(), probe: parseProbeJson(probeJson()) },
      { allowSkipped: ['CONTAINER_SPEC'] },
    ).ok,
    true,
  );
});

test('duration gate: absolute bounds, the target tolerance, and the placement windows', () => {
  assert.equal(gateDuration(24.03).status, 'PASS');
  assert.match(String(gateDuration(2.5).evidence[0]), /below the 3s minimum/);
  assert.equal(gateDuration(901).status, 'FAIL');
  assert.equal(gateDuration(24.03, { targetSeconds: 24 }).status, 'PASS');
  assert.match(String(gateDuration(24.5, { targetSeconds: 24 }).evidence[0]), /assembly maths/);
  // facebook_reels_overlay is 1:1 AND 4-15s; a 24s ad is ineligible however it is cropped.
  const overlay = gateDuration(24.03, { placements: ['facebook:facebook_reels_overlay'] });
  assert.equal(overlay.status, 'FAIL');
  assert.match(String(overlay.evidence[0]), /4-15s window/);
  assert.equal(gateDuration(12, { placements: ['facebook:facebook_reels_overlay'] }).status, 'PASS');
  assert.equal(PLACEMENT_DURATION_WINDOWS['facebook:facebook_reels_overlay']?.maxSeconds, 15);
});

test('resolution gate enforces the 1% ratio tolerance, the width floors and square pixels', () => {
  const nineSixteen = goodProbe();
  assert.equal(gateResolution(nineSixteen, '9:16').status, 'PASS');
  const wrongCut = gateResolution(nineSixteen, '4:5');
  assert.equal(wrongCut.status, 'FAIL');
  assert.match(String(wrongCut.evidence[0]), /tolerance is 1%/);

  const nonSquare = gateResolution(
    parseProbeJson(probeJson({ sample_aspect_ratio: '2025:2024' })),
    '9:16',
  );
  assert.equal(nonSquare.status, 'FAIL');
  assert.match(nonSquare.evidence.join(' '), /lost its trailing setsar=1/);

  // Not probed is not a pass.
  const unknownSar = gateResolution(parseProbeJson(probeJson({ sample_aspect_ratio: 'N/A' })), '9:16');
  assert.equal(unknownSar.status, 'FAIL');

  const tiny = gateResolution(
    parseProbeJson(probeJson({ width: 200, height: 356 }), { fileSizeBytes: 10 }),
    '9:16',
  );
  assert.match(tiny.evidence.join(' '), /250px minimum/);
  assert.equal(QA_THRESHOLDS.minWidthFrom30sPx, 500);
});

test('frame-rate gate blocks VFR and an unconfirmable CFR', () => {
  assert.equal(gateFrameRate(goodProbe()).status, 'PASS');
  const vfr = gateFrameRate(parseProbeJson(probeJson({ avg_frame_rate: '29001/1000' })));
  assert.equal(vfr.status, 'FAIL');
  assert.match(vfr.evidence.join(' '), /desynchronises the audio/);
  assert.equal(gateFrameRate(parseProbeJson(probeJson({ r_frame_rate: '15/1', avg_frame_rate: '15/1' }))).status, 'FAIL');
  assert.equal(gateFrameRate(parseProbeJson(probeJson({ avg_frame_rate: '0/0' }))).status, 'FAIL');
});

test('black-frame gate uses the limited-range floor a naive gate would miss', () => {
  // YAVG=16 is a genuinely black frame. A `< 5` threshold would call this a pass.
  const black = gateBlackFrames({ intervals: [], firstFrameYavg: 16 });
  assert.equal(black.status, 'FAIL');
  assert.match(black.evidence.join(' '), /Limited-range black is 16, not 0/);
  assert.equal(gateBlackFrames({ intervals: [], firstFrameYavg: 96 }).status, 'PASS');

  const run = gateBlackFrames({
    intervals: [{ startSeconds: 0, endSeconds: 1.033, durationSeconds: 1.033 }],
    firstFrameYavg: 96,
  });
  assert.equal(run.status, 'FAIL');
  // A gate with no first-frame measurement is unknown, and unknown blocks.
  assert.equal(gateBlackFrames({ intervals: [] }).status, 'SKIP');
});

test('freeze and silence gates', () => {
  assert.equal(gateFreeze([{ startSeconds: 0, endSeconds: 1.03, durationSeconds: 1.03 }]).status, 'FAIL');
  // A held beauty shot is legitimate.
  assert.equal(gateFreeze([{ startSeconds: 3, endSeconds: 3.5, durationSeconds: 0.5 }]).status, 'PASS');

  assert.equal(gateSilence([{ startSeconds: 0, endSeconds: 1.02, durationSeconds: 1.02 }], 24).status, 'PASS');
  const dropout = gateSilence([{ startSeconds: 4, endSeconds: 7, durationSeconds: 3 }], 24);
  assert.equal(dropout.status, 'FAIL');
  assert.match(dropout.evidence.join(' '), /3\.000s of silence at 4\.000s/);
  // Trailing silence beyond 90% of the runtime is a tail, not a defect.
  assert.equal(gateSilence([{ startSeconds: 22, endSeconds: 24, durationSeconds: 2 }], 24).status, 'PASS');
});

test('loudness gate window and the silent-deliverable case', () => {
  assert.equal(gateLoudness({ integratedLufs: -14, thresholdLufs: -24, loudnessRangeLu: 0.6, truePeakDbfs: -1.2 }).status, 'PASS');
  const quiet = gateLoudness({ integratedLufs: -21.9, thresholdLufs: -31, loudnessRangeLu: 0.5, truePeakDbfs: -20 });
  assert.equal(quiet.status, 'FAIL');
  assert.match(quiet.evidence.join(' '), /TWO-pass form with linear=true/);
  assert.equal(gateLoudness({ integratedLufs: -14, thresholdLufs: -24, loudnessRangeLu: 1, truePeakDbfs: -0.5 }).status, 'FAIL');
  const silent = gateLoudness({ integratedLufs: -Infinity, thresholdLufs: -Infinity, loudnessRangeLu: 0, truePeakDbfs: -Infinity });
  assert.match(silent.evidence.join(' '), /digital silence/);
});

test('safe-zone gate reproduces both measured outcomes exactly', () => {
  // MarginV 672 -> bbox (223,1187)-(859,1234), inside the y<=1248 limit with 14px to spare.
  assert.equal(gateSafeZone([{ frame: 0, x0: 223, y0: 1187, x1: 859, y1: 1234 }], NINE_SIXTEEN).status, 'PASS');
  // MarginV 60 -> bbox (223,1799)-(859,1846), squarely under the Reels action rail.
  const bad = gateSafeZone([{ frame: 0, x0: 223, y0: 1799, x1: 859, y1: 1846 }], NINE_SIXTEEN);
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.evidence.join(' '), /bottom by 598px/);
  assert.match(bad.reason, /MarginV that is not 0\.35 x height/);
  // Zero frames is "did not run", never "no text found".
  assert.equal(gateSafeZone([], NINE_SIXTEEN).status, 'SKIP');
});

test('aspect manifest checks the deliverable set against the render matrix', () => {
  const ok = gateAspectManifest(
    [
      { cut: '9:16', width: 1080, height: 1920, path: 'a.mp4' },
      { cut: '4:5', width: 1080, height: 1350, path: 'b.mp4' },
      { cut: '1:1', width: 1080, height: 1080, path: 'c.mp4' },
    ],
    ['9:16', '4:5', '1:1'],
  );
  assert.equal(ok.status, 'PASS');

  const missing = gateAspectManifest([{ cut: '9:16', width: 1080, height: 1920, path: 'a.mp4' }], ['9:16', '4:5']);
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.evidence.join(' '), /4:5 is required but absent/);
  assert.match(missing.evidence.join(' '), /facebook:feed/);

  const wrongDims = gateAspectManifest([{ cut: '4:5', width: 1080, height: 1920, path: 'b.mp4' }], ['4:5']);
  assert.match(wrongDims.evidence.join(' '), /expected 1080x1350/);

  const stray = gateAspectManifest(
    [
      { cut: '9:16', width: 1080, height: 1920, path: 'a.mp4' },
      { cut: '16:9', width: 1920, height: 1080, path: 'd.mp4' },
    ],
    ['9:16'],
  );
  assert.match(stray.evidence.join(' '), /rendered but is not in the required set/);

  // Requiring 16:9 flags it: it must be a native generation, not a crop of the master.
  const derived = gateAspectManifest([{ cut: '16:9', width: 1920, height: 1080, path: 'd.mp4' }], ['16:9']);
  assert.equal(derived.status, 'FAIL');
  assert.match(derived.evidence.join(' '), /must not be derived from the 9:16 master/);
  // ...and the gate must be SATISFIABLE, or a brand that buys in-stream can never publish:
  // a FAIL is not waivable through allowSkipped. The declaration is what clears it.
  const native = gateAspectManifest(
    [{ cut: '16:9', width: 1920, height: 1080, path: 'd.mp4', nativeGeneration: true }],
    ['16:9'],
  );
  assert.equal(native.status, 'PASS');
});

/* ================================================================= the report === */

function fullQaInput() {
  return {
    cut: '9:16' as const,
    probe: goodProbe(),
    targetDurationSeconds: 24,
    placements: ['instagram:reels', 'facebook:facebook_reels'],
    black: { intervals: [], firstFrameYavg: 96 },
    freeze: [],
    silence: [],
    loudness: { integratedLufs: -14, thresholdLufs: -24, loudnessRangeLu: 0.6, truePeakDbfs: -1.2 },
    overlayBboxes: [{ frame: 0, x0: 223, y0: 1187, x1: 859, y1: 1234 }],
    deliverables: [{ cut: '9:16' as const, width: 1080, height: 1920, path: 'a.mp4' }],
    requiredCuts: ['9:16' as const],
  };
}

test('a fully-evidenced conformant render passes every gate', () => {
  const report = runQaGates(fullQaInput());
  assert.equal(report.ok, true, formatQaReport(report));
  assert.equal(report.results.length, 10);
  assert.equal(report.failures.length, 0);
  assert.equal(report.unwaivedSkips.length, 0);
  assert.doesNotThrow(() => assertPublishable(report, 'brand/ad-1 9:16'));
});

test('gates that were never run block publish until the skip is written down', () => {
  const partial = runQaGates({ cut: '9:16', probe: goodProbe() });
  assert.equal(partial.ok, false);
  assert.equal(partial.failures.length, 0);
  assert.deepEqual(
    partial.unwaivedSkips.map((r) => r.gate).sort(),
    ['ASPECT_MANIFEST', 'BLACK_FRAMES', 'FREEZE', 'LOUDNESS', 'SAFE_ZONE', 'SILENCE'],
  );
  const waived = runQaGates(
    { cut: '9:16', probe: goodProbe() },
    { allowSkipped: ['ASPECT_MANIFEST', 'BLACK_FRAMES', 'FREEZE', 'LOUDNESS', 'SAFE_ZONE', 'SILENCE'] },
  );
  assert.equal(waived.ok, true, formatQaReport(waived));
});

test('a failed gate blocks publish and the error names every cause', () => {
  const input = fullQaInput();
  const report = runQaGates({
    ...input,
    black: { intervals: [], firstFrameYavg: 16 },
    loudness: { integratedLufs: -21.9, thresholdLufs: -31, loudnessRangeLu: 0.5, truePeakDbfs: -20 },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures.map((f) => f.gate), ['BLACK_FRAMES', 'LOUDNESS']);
  assert.throws(
    () => assertPublishable(report, 'brand/ad-1 9:16'),
    (e: unknown) => {
      assert.ok(e instanceof QaBlockedError);
      assert.match(e.message, /QA blocked publish of brand\/ad-1 9:16/);
      assert.match(e.message, /BLACK_FRAMES FAIL/);
      assert.match(e.message, /LOUDNESS FAIL/);
      assert.equal(e.report.failures.length, 2);
      return true;
    },
  );
  assert.match(formatQaReport(report), /FAIL BLACK_FRAMES/);
});
