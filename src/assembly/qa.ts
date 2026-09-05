/**
 * Pre-publish QA gates.
 *
 * WHY EVERY GATE IS PURE
 * Nothing here shells out. Each gate takes an already-parsed struct from
 * `src/assembly/ffmpeg.ts` (an ffprobe result, a list of blackdetect intervals, an
 * ebur128 summary, a set of overlay bounding boxes) and returns a verdict with a reason
 * naming the offending value. The reason string is the entire product of this module:
 * it is what an escalation carries, and nobody is awake at 3am to open the render and
 * work out what "QA failed" meant.
 *
 * WHY A SKIPPED GATE BLOCKS
 * A gate that did not run is not a gate that passed. If the black-frame detector was
 * never fed its intervals, the honest state is "unknown", and the correct behaviour for
 * a system that publishes unattended is to refuse. Skips can be waived one gate at a
 * time via `QaOptions.allowSkipped`, which forces the waiver to be written down.
 *
 * Thresholds and their provenance are in `QA_THRESHOLDS`; the two that people get wrong
 * are called out there — limited-range black is Y=16 (not 0), and the loudness window is
 * a streaming convention rather than a documented Meta requirement.
 *
 * Sources: docs/research/creative-production-pipeline.md §14,
 *          docs/research/meta-video-creative.md §§1.6, 7.5, 9, 9.1.
 */

import { AD_VIDEO_SPEC, validateAdVideoSpec } from '../meta/videoUpload.ts';
import {
  MP4_HEADER_PROBE_BYTES,
  RENDER_MATRIX,
  aspectOf,
  canvasFor,
  safeZoneBox,
  type Canvas,
  type CutName,
  type FrameBbox,
  type LoudnessSummary,
  type ProbeResult,
  type TimeInterval,
} from './ffmpeg.ts';

export type GateId =
  | 'CONTAINER_SPEC'
  | 'DURATION'
  | 'RESOLUTION'
  | 'FRAME_RATE'
  | 'BLACK_FRAMES'
  | 'FREEZE'
  | 'SILENCE'
  | 'LOUDNESS'
  | 'SAFE_ZONE'
  | 'ASPECT_MANIFEST';

export type GateStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface GateResult {
  readonly gate: GateId;
  readonly status: GateStatus;
  /** Always populated, including on PASS — it says what was actually checked. */
  readonly reason: string;
  /** One line per offending value. Empty on a clean pass. */
  readonly evidence: readonly string[];
}

export const QA_THRESHOLDS = {
  /** AD_VIDEO_SPEC: 3s min (error 382 "video file is too small") / 15 min max. */
  minDurationSeconds: AD_VIDEO_SPEC.minDurationSeconds,
  maxDurationSeconds: AD_VIDEO_SPEC.maxDurationSeconds,
  /** A render that missed its target duration means the assembly maths was wrong. */
  durationToleranceSeconds: 0.15,
  /**
   * H.264 is limited-range: a true black frame reports YAVG=16, not 0. A `< 5` gate never
   * fires. (The mirror trap: white is 235, so a `> 235` flash detector never fires either.)
   */
  firstFrameLumaFloor: 20,
  maxBlackRunSeconds: 0.25,
  /** A held product beauty shot is legitimate; two seconds of it is not. */
  maxFreezeSeconds: 0.6,
  maxSilenceSeconds: 1.5,
  /** Trailing silence in the last 10% is a legitimate tail, not a defect. */
  silenceWindowFraction: 0.9,
  /**
   * -14 LUFS +/- 2 and a -1.0 dBTP ceiling. UNVERIFIED as a Meta requirement — Meta
   * publishes no loudness target and whether it normalises on ingest is unknown. This is
   * the streaming convention, and it exists so the ad is not the one that blows out
   * someone's earbuds.
   */
  loudnessMinLufs: -16.0,
  loudnessMaxLufs: -12.0,
  truePeakMaxDbfs: -1.0,
  /** "Aspect ratio tolerance: 1%" — Meta's Reels/Stories pages. */
  aspectRatioTolerance: 0.01,
  /** Minimum width: 250px under 30s, 500px at 30s and over. */
  minWidthUnder30sPx: 250,
  minWidthFrom30sPx: 500,
} as const;

/**
 * Placement-specific duration windows, from the ads-guide placement pages. Only the
 * documented ones are here; the one that actually bites is facebook_reels_overlay, which
 * is 1:1 AND 4-15s — a 24s ad is ineligible for it no matter how it is cropped.
 */
export const PLACEMENT_DURATION_WINDOWS: Readonly<
  Record<string, { readonly minSeconds: number; readonly maxSeconds: number }>
> = {
  'facebook:facebook_reels_overlay': { minSeconds: 4, maxSeconds: 15 },
  'facebook:story': { minSeconds: 1, maxSeconds: 180 },
  'facebook:feed': { minSeconds: 1, maxSeconds: 241 * 60 },
  'instagram:reels': { minSeconds: 0, maxSeconds: 15 * 60 },
  'instagram:story': { minSeconds: 1, maxSeconds: 60 * 60 },
  'instagram:stream': { minSeconds: 1, maxSeconds: 60 * 60 },
};

function pass(gate: GateId, reason: string): GateResult {
  return { gate, status: 'PASS', reason, evidence: [] };
}
function fail(gate: GateId, reason: string, evidence: readonly string[] = []): GateResult {
  return { gate, status: 'FAIL', reason, evidence };
}
function skip(gate: GateId, reason: string, evidence: readonly string[] = []): GateResult {
  return { gate, status: 'SKIP', reason, evidence };
}

/* =============================================================== single gates ==== */

/**
 * Container / codec conformance. Delegates to the ad-video spec validator that already
 * owns these rules for the upload path — a second copy would drift, and the two must
 * agree or the pipeline passes QA and then fails ingestion.
 */
export function gateContainerSpec(probe: ProbeResult): GateResult {
  const v = validateAdVideoSpec(probe.meta);
  const evidence = v.errors.map((e) => `${e.field} [${e.basis}]: ${e.message}`);
  if (!v.ok) {
    return fail(
      'CONTAINER_SPEC',
      `${v.errors.length} spec violation(s); Meta answers these with error 352 or 6000 and the retry fails identically`,
      evidence,
    );
  }
  // High profile is what Meta transcodes from; anything else is a warning, not a block,
  // because the ads guide says only "H.264 compression".
  const profileNote =
    probe.profile !== undefined && probe.profile.toLowerCase() !== 'high'
      ? ` (profile "${probe.profile}", not High)`
      : '';
  const warnings = v.warnings.map((w) => `${w.field} [${w.basis}]: ${w.message}`);

  // ffprobe CANNOT see either of these, so they arrive only if the caller ran the mp4 box
  // scan (scanTopLevelBoxes -> moovBeforeMdat / moovContainsEditList) and passed the result
  // into parseProbeJson. `validateAdVideoSpec` can only downgrade an unknown to a WARNING,
  // and a warning does not block — so without this branch the two commonest causes of
  // error 6000 would be waved through by the gate that exists to catch them. Unknown is a
  // SKIP: it blocks publish unless the waiver is written into QaOptions.allowSkipped.
  const unknown: string[] = [];
  if (probe.meta.moovAtomAtFront === undefined) {
    unknown.push(
      'moovAtomAtFront: the box order was never read. `+faststart` failing silently is the ' +
        'commonest cause of error 6000, and local playback does not reveal it.',
    );
  }
  if (probe.meta.hasEditLists === undefined) {
    unknown.push(
      'hasEditLists: the moov span was never scanned for `elst`. The ads guide forbids edit ' +
        'lists outright and `+faststart` does not remove one.',
    );
  }
  if (unknown.length > 0) {
    return skip(
      'CONTAINER_SPEC',
      `the spec fields ffprobe cannot see were not gathered${profileNote}; read the first ` +
        `${MP4_HEADER_PROBE_BYTES} bytes, run scanTopLevelBoxes over them, and pass ` +
        `moovBeforeMdat/moovContainsEditList into parseProbeJson`,
      [...unknown, ...warnings],
    );
  }

  return {
    gate: 'CONTAINER_SPEC',
    status: 'PASS',
    reason: `conforms to the ad video spec${profileNote}; ${warnings.length} warning(s)`,
    evidence: warnings,
  };
}

export interface DurationExpectation {
  readonly targetSeconds?: number;
  /** `platform:position` strings; each documented window is applied. */
  readonly placements?: readonly string[];
}

export function gateDuration(durationSeconds: number, expect: DurationExpectation = {}): GateResult {
  const problems: string[] = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return fail('DURATION', `duration is not a positive number (${durationSeconds})`);
  }
  if (durationSeconds < QA_THRESHOLDS.minDurationSeconds) {
    problems.push(
      `${durationSeconds.toFixed(2)}s is below the 3s minimum (Meta error 382 "video file is too small")`,
    );
  }
  if (durationSeconds > QA_THRESHOLDS.maxDurationSeconds) {
    problems.push(`${durationSeconds.toFixed(2)}s exceeds the 15 minute maximum`);
  }
  if (expect.targetSeconds !== undefined) {
    const drift = Math.abs(durationSeconds - expect.targetSeconds);
    if (drift > QA_THRESHOLDS.durationToleranceSeconds) {
      problems.push(
        `${durationSeconds.toFixed(2)}s is ${drift.toFixed(2)}s off the ${expect.targetSeconds}s target ` +
          `(tolerance ${QA_THRESHOLDS.durationToleranceSeconds}s) — the assembly maths is wrong, not the render. ` +
          `Crossfades shorten the ad: total = sum(durations) - sum(transitions).`,
      );
    }
  }
  for (const p of expect.placements ?? []) {
    const w = PLACEMENT_DURATION_WINDOWS[p];
    if (w === undefined) continue;
    if (durationSeconds < w.minSeconds || durationSeconds > w.maxSeconds) {
      problems.push(
        `${durationSeconds.toFixed(2)}s is outside ${p}'s documented ${w.minSeconds}-${w.maxSeconds}s window; ` +
          `drop that placement or re-cut, cropping will not help`,
      );
    }
  }
  return problems.length === 0
    ? pass('DURATION', `${durationSeconds.toFixed(2)}s is within every applicable window`)
    : fail('DURATION', 'duration is not publishable', problems);
}

export function gateResolution(probe: ProbeResult, cut: CutName): GateResult {
  const { width, height, durationSeconds } = probe.meta;
  const expected = canvasFor(cut);
  const problems: string[] = [];

  if (width <= 0 || height <= 0) {
    return fail('RESOLUTION', `probe reported non-positive dimensions ${width}x${height}`);
  }
  const actualRatio = width / height;
  const expectedRatio = aspectOf(expected);
  const drift = Math.abs(actualRatio / expectedRatio - 1);
  if (drift > QA_THRESHOLDS.aspectRatioTolerance) {
    problems.push(
      `${width}x${height} is ${(drift * 100).toFixed(2)}% off the ${cut} ratio; Meta's stated ` +
        `tolerance is 1%. Expected ${expected.width}x${expected.height}.`,
    );
  }
  if (width > AD_VIDEO_SPEC.maxHorizontalPixels) {
    // ORGANIC_SPEC, like the fps window: "maximum 1920 horizontal pixels" is Instagram's
    // organic publishing limit, not an ad rule. Enforced anyway — one master for both.
    problems.push(
      `width ${width}px exceeds the 1920 horizontal pixel maximum Instagram publishes for organic ` +
        `video (not documented as an ad requirement, but this pipeline encodes inside it)`,
    );
  }
  const minWidth =
    durationSeconds >= 30 ? QA_THRESHOLDS.minWidthFrom30sPx : QA_THRESHOLDS.minWidthUnder30sPx;
  if (width < minWidth) {
    problems.push(
      `width ${width}px is below the ${minWidth}px minimum for a ${durationSeconds.toFixed(1)}s video ` +
        `(250px under 30s, 500px at 30s and over)`,
    );
  }
  // Terminating every geometry chain in setsar=1 is what prevents this; a non-square SAR
  // is a spec violation ("square pixels") that no visual inspection catches.
  if (probe.meta.pixelAspectRatio !== undefined && probe.meta.pixelAspectRatio !== 1) {
    problems.push(
      `sample_aspect_ratio is ${probe.sampleAspectRatio ?? probe.meta.pixelAspectRatio} — non-square pixels. ` +
        `A geometry chain lost its trailing setsar=1.`,
    );
  } else if (probe.meta.pixelAspectRatio === undefined) {
    problems.push('sample_aspect_ratio was not probed; square pixels cannot be confirmed');
  }
  return problems.length === 0
    ? pass('RESOLUTION', `${width}x${height} matches ${cut} with square pixels`)
    : fail('RESOLUTION', `geometry is not publishable as ${cut}`, problems);
}

export function gateFrameRate(probe: ProbeResult): GateResult {
  const problems: string[] = [];
  const fps = probe.meta.frameRate;
  if (!(fps > 0)) return fail('FRAME_RATE', `probe reported no frame rate (${fps})`);
  if (fps < AD_VIDEO_SPEC.minFrameRate || fps > AD_VIDEO_SPEC.maxFrameRate) {
    problems.push(
      `${fps.toFixed(3)} fps is outside the 23-60 fps range Instagram publishes for organic video; ` +
        `the ads guide itself states only "fixed frame rate"`,
    );
  }
  if (probe.meta.variableFrameRate === true) {
    problems.push(
      `r_frame_rate ${probe.rFrameRate} != avg_frame_rate ${probe.avgFrameRate}: variable frame rate. ` +
        `The ads guide requires "fixed frame rate"; VFR survives upload and then desynchronises the ` +
        `audio after Meta's transcode.`,
    );
  } else if (probe.meta.variableFrameRate === undefined) {
    problems.push('CFR could not be confirmed (r_frame_rate or avg_frame_rate missing from the probe)');
  }
  return problems.length === 0
    ? pass('FRAME_RATE', `${fps.toFixed(3)} fps, constant`)
    : fail('FRAME_RATE', 'frame rate is not publishable', problems);
}

export interface BlackEvidence {
  readonly intervals: readonly TimeInterval[];
  /** From `signalstats` on frame 0. Absent means the check did not run. */
  readonly firstFrameYavg?: number;
}

export function gateBlackFrames(ev: BlackEvidence): GateResult {
  const problems: string[] = [];
  for (const i of ev.intervals) {
    if (i.durationSeconds > QA_THRESHOLDS.maxBlackRunSeconds) {
      problems.push(
        `${i.durationSeconds.toFixed(3)}s of black at ${i.startSeconds.toFixed(3)}-${i.endSeconds.toFixed(3)}s ` +
          `(limit ${QA_THRESHOLDS.maxBlackRunSeconds}s)`,
      );
    }
  }
  if (ev.firstFrameYavg === undefined) {
    return skip(
      'BLACK_FRAMES',
      'first-frame luma was not measured; a black first frame is the failure that actually matters ' +
        'and blackdetect\'s 2s default duration would not catch it',
    );
  }
  if (ev.firstFrameYavg < QA_THRESHOLDS.firstFrameLumaFloor) {
    problems.push(
      `first frame YAVG=${ev.firstFrameYavg} is below ${QA_THRESHOLDS.firstFrameLumaFloor}: the ad opens on ` +
        `black. (Limited-range black is 16, not 0 — that is why the floor is 20 and not 5.)`,
    );
  }
  return problems.length === 0
    ? pass('BLACK_FRAMES', `no black run over ${QA_THRESHOLDS.maxBlackRunSeconds}s; first frame YAVG=${ev.firstFrameYavg}`)
    : fail('BLACK_FRAMES', 'the render contains black frames', problems);
}

export function gateFreeze(intervals: readonly TimeInterval[]): GateResult {
  const problems = intervals
    .filter((i) => i.durationSeconds > QA_THRESHOLDS.maxFreezeSeconds)
    .map(
      (i) =>
        `${i.durationSeconds.toFixed(3)}s frozen at ${i.startSeconds.toFixed(3)}s ` +
        `(limit ${QA_THRESHOLDS.maxFreezeSeconds}s)`,
    );
  return problems.length === 0
    ? pass('FREEZE', `no freeze over ${QA_THRESHOLDS.maxFreezeSeconds}s`)
    : fail('FREEZE', 'the render freezes', problems);
}

export function gateSilence(
  intervals: readonly TimeInterval[],
  durationSeconds: number,
): GateResult {
  const cutoff = durationSeconds * QA_THRESHOLDS.silenceWindowFraction;
  const problems: string[] = [];
  for (const i of intervals) {
    // Silence in the last 10% is a legitimate tail; only silence inside the body counts.
    if (i.startSeconds >= cutoff) continue;
    const withinWindow = Math.min(i.endSeconds, cutoff) - i.startSeconds;
    if (withinWindow > QA_THRESHOLDS.maxSilenceSeconds) {
      problems.push(
        `${withinWindow.toFixed(3)}s of silence at ${i.startSeconds.toFixed(3)}s ` +
          `(limit ${QA_THRESHOLDS.maxSilenceSeconds}s in the first ${(QA_THRESHOLDS.silenceWindowFraction * 100).toFixed(0)}%)`,
      );
    }
  }
  return problems.length === 0
    ? pass('SILENCE', `no silence over ${QA_THRESHOLDS.maxSilenceSeconds}s before ${cutoff.toFixed(2)}s`)
    : fail('SILENCE', 'the audio drops out mid-ad', problems);
}

export function gateLoudness(summary: LoudnessSummary): GateResult {
  const problems: string[] = [];
  if (!Number.isFinite(summary.integratedLufs)) {
    problems.push(
      `integrated loudness is ${summary.integratedLufs} — the deliverable is digital silence. ` +
        `This is a mix or voiceover failure upstream, not a loudness problem.`,
    );
  } else if (
    summary.integratedLufs < QA_THRESHOLDS.loudnessMinLufs ||
    summary.integratedLufs > QA_THRESHOLDS.loudnessMaxLufs
  ) {
    problems.push(
      `I=${summary.integratedLufs} LUFS is outside ${QA_THRESHOLDS.loudnessMinLufs}..` +
        `${QA_THRESHOLDS.loudnessMaxLufs} LUFS. If this followed a loudnorm pass, check it was the ` +
        `TWO-pass form with linear=true — single-pass applies time-varying gain and pumps under a music bed.`,
    );
  }
  if (summary.truePeakDbfs > QA_THRESHOLDS.truePeakMaxDbfs) {
    problems.push(
      `true peak ${summary.truePeakDbfs} dBFS exceeds ${QA_THRESHOLDS.truePeakMaxDbfs} dBFS`,
    );
  }
  return problems.length === 0
    ? pass('LOUDNESS', `I=${summary.integratedLufs} LUFS, peak ${summary.truePeakDbfs} dBFS`)
    : fail('LOUDNESS', 'loudness is out of range', problems);
}

/**
 * The most valuable visual gate, because the failure is invisible in your player and
 * obvious in the Reels UI: text sitting under the profile row, the caption sheet, the CTA
 * button or the action rail.
 *
 * Takes bounding boxes measured on the OVERLAY LAYER ALONE (rendered onto black), so
 * bright generated scene content cannot produce a false positive.
 */
const SAFE_ZONE_LABEL = '14% top / 35% bottom / 6% sides';

export function gateSafeZone(bboxes: readonly FrameBbox[], canvas: Canvas): GateResult {
  if (bboxes.length === 0) {
    return skip(
      'SAFE_ZONE',
      'no overlay bounding boxes supplied. Zero frames is NOT evidence that no text was drawn — ' +
        'it is evidence the layer render or its parse did not run.',
    );
  }
  const box = safeZoneBox(canvas);
  const problems: string[] = [];
  for (const b of bboxes) {
    const v: string[] = [];
    if (b.x0 < box.x0) v.push(`left by ${box.x0 - b.x0}px`);
    if (b.x1 > box.x1) v.push(`right by ${b.x1 - box.x1}px`);
    if (b.y0 < box.y0) v.push(`top by ${box.y0 - b.y0}px`);
    if (b.y1 > box.y1) v.push(`bottom by ${b.y1 - box.y1}px`);
    if (v.length > 0) {
      problems.push(
        `frame ${b.frame}: text bbox (${b.x0},${b.y0})-(${b.x1},${b.y1}) violates ${v.join(', ')}`,
      );
    }
  }
  if (problems.length === 0) {
    return pass(
      'SAFE_ZONE',
      `all ${bboxes.length} overlay frames inside x∈[${box.x0},${box.x1}] y∈[${box.y0},${box.y1}]`,
    );
  }
  // Only the first few, then a count: a bad MarginV violates every frame identically and
  // 180 lines of the same message buries the one number that matters.
  const shown = problems.slice(0, 5);
  if (problems.length > shown.length) shown.push(`... and ${problems.length - shown.length} more frames`);
  return fail(
    'SAFE_ZONE',
    `overlay text leaves the ${SAFE_ZONE_LABEL} safe zone; on ${canvas.width}x${canvas.height} the ` +
      `text-safe box is x∈[${box.x0},${box.x1}] y∈[${box.y0},${box.y1}]. The usual cause is an ASS ` +
      `MarginV that is not 0.35 x height.`,
    shown,
  );
}

export interface DeliverableEntry {
  readonly cut: CutName;
  readonly width: number;
  readonly height: number;
  readonly path: string;
  /**
   * Set true only for an asset the generator produced natively at this ratio, never for one
   * derived from the master. It exists for the cuts the render matrix marks `regenerate`
   * (16:9): without it the gate cannot tell a native 1920x1080 from a 68% crop of a 9:16
   * master, and both measure identically. Asserting it is the caller's declaration, not a
   * measurement — which is why the gate blocks until someone makes it.
   */
  readonly nativeGeneration?: boolean;
}

/**
 * The render matrix is a promise made to the placement customisation spec: if a cut is
 * declared and missing, the ad serves the wrong ratio on that placement (or the creative
 * write fails). Checked as a set, not per file.
 */
export function gateAspectManifest(
  deliverables: readonly DeliverableEntry[],
  requiredCuts: readonly CutName[],
): GateResult {
  const problems: string[] = [];
  const byCut = new Map<CutName, DeliverableEntry[]>();
  for (const d of deliverables) {
    const list = byCut.get(d.cut);
    if (list === undefined) byCut.set(d.cut, [d]);
    else list.push(d);
  }
  if (requiredCuts.length === 0) {
    return fail('ASPECT_MANIFEST', 'no cuts required; the manifest check would assert nothing');
  }
  for (const cut of requiredCuts) {
    const entries = byCut.get(cut) ?? [];
    if (entries.length === 0) {
      problems.push(
        `${cut} is required but absent; its placements (${RENDER_MATRIX[cut].placements.join(', ')}) have no asset`,
      );
      continue;
    }
    if (entries.length > 1) {
      problems.push(`${cut} has ${entries.length} deliverables (${entries.map((e) => e.path).join(', ')}); expected one`);
    }
    const expected = canvasFor(cut);
    for (const e of entries) {
      if (e.width <= 0 || e.height <= 0) {
        problems.push(`${e.path}: non-positive dimensions ${e.width}x${e.height}`);
        continue;
      }
      const drift = Math.abs(e.width / e.height / aspectOf(expected) - 1);
      if (drift > QA_THRESHOLDS.aspectRatioTolerance) {
        problems.push(
          `${e.path} is ${e.width}x${e.height}, ${(drift * 100).toFixed(2)}% off ${cut} ` +
            `(expected ${expected.width}x${expected.height}, tolerance 1%)`,
        );
      }
    }
  }
  for (const [cut, entries] of byCut) {
    if (!requiredCuts.includes(cut)) {
      problems.push(`${cut} was rendered but is not in the required set; it will not be mapped to any placement`);
      continue;
    }
    if (RENDER_MATRIX[cut].derive !== 'regenerate') continue;
    // A native 16:9 and a 68%-of-the-width crop of the 9:16 master are the same numbers on
    // the wire, so the gate cannot measure this — it can only refuse until the caller says.
    for (const e of entries.filter((x) => x.nativeGeneration !== true)) {
      problems.push(
        `${e.path} (${cut}) is marked "regenerate" in the render matrix — it must not be derived from ` +
          `the 9:16 master, which would be a 68% crop of the wrong axis. Set nativeGeneration: true on ` +
          `the deliverable if it really came from a native ${cut} generation.`,
      );
    }
  }
  return problems.length === 0
    ? pass('ASPECT_MANIFEST', `all ${requiredCuts.length} required cut(s) present at the right ratio`)
    : fail('ASPECT_MANIFEST', 'the deliverable set does not match the render matrix', problems);
}

/* ================================================================== the report == */

export interface QaInput {
  readonly cut: CutName;
  readonly probe: ProbeResult;
  readonly targetDurationSeconds?: number;
  /** `platform:position` strings this cut will be mapped to. */
  readonly placements?: readonly string[];
  readonly black?: BlackEvidence;
  readonly freeze?: readonly TimeInterval[];
  readonly silence?: readonly TimeInterval[];
  readonly loudness?: LoudnessSummary;
  /** Bounding boxes from the overlay-only layer render. */
  readonly overlayBboxes?: readonly FrameBbox[];
  readonly deliverables?: readonly DeliverableEntry[];
  readonly requiredCuts?: readonly CutName[];
}

export interface QaOptions {
  /**
   * Gates whose inputs were deliberately not gathered. Writing the id here is the
   * waiver — an unlisted skip blocks publish exactly like a failure.
   */
  readonly allowSkipped?: readonly GateId[];
}

export interface QaReport {
  /** True only when nothing failed and every skip was explicitly waived. */
  readonly ok: boolean;
  readonly results: readonly GateResult[];
  readonly failures: readonly GateResult[];
  /** Skips that were NOT waived. These block publish. */
  readonly unwaivedSkips: readonly GateResult[];
}

export function runQaGates(input: QaInput, options: QaOptions = {}): QaReport {
  const results: GateResult[] = [];
  const canvas = canvasFor(input.cut);
  const duration = input.probe.meta.durationSeconds;

  results.push(gateContainerSpec(input.probe));
  results.push(
    gateDuration(duration, {
      ...(input.targetDurationSeconds !== undefined ? { targetSeconds: input.targetDurationSeconds } : {}),
      ...(input.placements !== undefined ? { placements: input.placements } : {}),
    }),
  );
  results.push(gateResolution(input.probe, input.cut));
  results.push(gateFrameRate(input.probe));

  results.push(
    input.black === undefined
      ? skip('BLACK_FRAMES', 'blackdetect was not run on this deliverable')
      : gateBlackFrames(input.black),
  );
  results.push(
    input.freeze === undefined
      ? skip('FREEZE', 'freezedetect was not run on this deliverable')
      : gateFreeze(input.freeze),
  );
  results.push(
    input.silence === undefined
      ? skip('SILENCE', 'silencedetect was not run on this deliverable')
      : gateSilence(input.silence, duration),
  );
  results.push(
    input.loudness === undefined
      ? skip('LOUDNESS', 'ebur128 was not run on this deliverable')
      : gateLoudness(input.loudness),
  );
  results.push(
    input.overlayBboxes === undefined
      ? skip('SAFE_ZONE', 'the overlay layer was not rendered, so safe-zone overlap is unknown')
      : gateSafeZone(input.overlayBboxes, canvas),
  );
  results.push(
    input.deliverables === undefined || input.requiredCuts === undefined
      ? skip('ASPECT_MANIFEST', 'no deliverable set supplied; the render matrix was not checked')
      : gateAspectManifest(input.deliverables, input.requiredCuts),
  );

  const waived = new Set(options.allowSkipped ?? []);
  const failures = results.filter((r) => r.status === 'FAIL');
  const unwaivedSkips = results.filter((r) => r.status === 'SKIP' && !waived.has(r.gate));
  return {
    ok: failures.length === 0 && unwaivedSkips.length === 0,
    results,
    failures,
    unwaivedSkips,
  };
}

export class QaBlockedError extends Error {
  readonly report: QaReport;

  constructor(report: QaReport, label: string) {
    const lines: string[] = [];
    for (const r of [...report.failures, ...report.unwaivedSkips]) {
      lines.push(`  ${r.gate} ${r.status}: ${r.reason}`);
      for (const e of r.evidence) lines.push(`      - ${e}`);
    }
    super(
      `QA blocked publish of ${label}: ${report.failures.length} failed gate(s), ` +
        `${report.unwaivedSkips.length} unwaived skip(s).\n${lines.join('\n')}`,
    );
    this.name = 'QaBlockedError';
    this.report = report;
  }
}

/**
 * The only correct way to consume a report. A failed gate must block publish: the whole
 * point of an unattended system is that nobody is going to eyeball the render, and a
 * black or silent ad spends real money at full delivery.
 */
export function assertPublishable(report: QaReport, label: string): void {
  if (!report.ok) throw new QaBlockedError(report, label);
}

/** Compact one-line-per-gate rendering for a log or an escalation payload. */
export function formatQaReport(report: QaReport): string {
  return report.results
    .map((r) => {
      const head = `${r.status.padEnd(4)} ${r.gate}: ${r.reason}`;
      return r.evidence.length === 0 ? head : `${head}\n${r.evidence.map((e) => `       - ${e}`).join('\n')}`;
    })
    .join('\n');
}
