import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AD_VIDEO_SPEC,
  MAX_THUMBNAIL_BYTES,
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
  type VideoThumbnail,
} from '../src/meta/videoUpload.ts';
import { MetaApiError } from '../src/meta/errors.ts';

/* ------------------------------------------------------------------ test harness --- */

interface Call {
  url: URL;
  method: string;
  form: FormData | undefined;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

function harness(responder: Responder): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      form: body instanceof FormData ? body : undefined,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Replays a fixed script of response bodies; a call past the end is a test bug, loudly. */
function script(...bodies: Array<unknown | Response>): Responder {
  return (call, i) => {
    const b = bodies[i];
    if (b === undefined) {
      throw new Error(`unexpected request #${i + 1} to ${call.url.pathname}`);
    }
    return b instanceof Response ? b : json(b);
  };
}

function field(call: Call, name: string): string {
  const v = call.form?.get(name);
  assert.equal(typeof v, 'string', `expected form field "${name}" on ${call.url.pathname}`);
  return v as string;
}

async function chunkBytes(call: Call): Promise<Uint8Array> {
  const v = call.form?.get('video_file_chunk');
  assert.ok(v && typeof v !== 'string', 'expected a binary video_file_chunk part');
  return new Uint8Array(await (v as Blob).arrayBuffer());
}

const NEVER: typeof fetch = () => {
  throw new Error('the network must not be touched');
};

function uploader(fetchImpl: typeof fetch, extra: Partial<{ sleep: (ms: number) => Promise<void>; now: () => number }> = {}) {
  return new VideoUploader({
    adAccountId: '123',
    accessToken: 'token',
    appSecret: 'secret',
    fetchImpl,
    // Nothing in these tests may take wall-clock time.
    sleep: extra.sleep ?? (async () => {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
}

/** A clock the test moves by hand; `sleep` is what advances it. */
function fakeClock(start = 1_700_000_000_000): {
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

const SOURCE_BYTES = Uint8Array.from({ length: 250 }, (_, i) => i % 256);
const source = (): ChunkSource => bufferChunkSource(SOURCE_BYTES);

/* ------------------------------------------------------------- chunked transfer ---- */

test('multi-chunk transfer follows the offsets Meta hands back, not offsets we choose', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: '178160000000001', upload_session_id: 's1', start_offset: '0', end_offset: '100' },
      { start_offset: '100', end_offset: '200' },
      { start_offset: '200', end_offset: '250' },
      { start_offset: '250', end_offset: '250' },
      { success: true },
    ),
  );

  const res = await uploader(fetchImpl).uploadChunked({ source: source(), title: 'hook A' });

  assert.equal(calls.length, 5);
  assert.equal(calls[0]?.url.origin, 'https://graph.facebook.com');
  assert.equal(calls[0]?.url.pathname, '/v26.0/act_123/advideos');
  assert.equal(field(calls[0] as Call, 'upload_phase'), 'start');
  assert.equal(field(calls[0] as Call, 'file_size'), '250');
  // Auth travels in the body, never the query string: chunk POSTs get logged and proxied.
  assert.equal(field(calls[0] as Call, 'access_token'), 'token');
  assert.equal(calls[0]?.url.searchParams.get('access_token'), null);
  assert.match(field(calls[0] as Call, 'appsecret_proof'), /^[0-9a-f]{64}$/);

  const windows = [
    [0, 100],
    [100, 200],
    [200, 250],
  ];
  for (const [i, [start, end]] of windows.entries()) {
    const call = calls[i + 1] as Call;
    assert.equal(field(call, 'upload_phase'), 'transfer');
    assert.equal(field(call, 'upload_session_id'), 's1');
    assert.equal(field(call, 'start_offset'), String(start));
    assert.equal(field(call, 'end_offset'), String(end));
    assert.deepEqual(
      Array.from(await chunkBytes(call)),
      Array.from(SOURCE_BYTES.subarray(start as number, end as number)),
      `chunk ${i} must carry exactly the bytes of the window Meta asked for`,
    );
  }

  const finish = calls[4] as Call;
  assert.equal(field(finish, 'upload_phase'), 'finish');
  assert.equal(field(finish, 'upload_session_id'), 's1');
  assert.equal(field(finish, 'title'), 'hook A');

  assert.deepEqual(res, {
    videoId: '178160000000001',
    uploadSessionId: 's1',
    bytesTransferred: 250,
    chunkCount: 3,
    skippedUpload: false,
  });
});

test('a resumed transfer starts at the persisted offset and never re-runs the start phase', async () => {
  const { fetchImpl, calls } = harness(
    script({ start_offset: '200', end_offset: '250' }, { start_offset: '250', end_offset: '250' }, { success: true }),
  );

  const res = await uploader(fetchImpl).uploadChunked({
    source: source(),
    resume: { videoId: 'v1', uploadSessionId: 's1', startOffset: 120, endOffset: 200 },
  });

  assert.equal(calls.length, 3);
  assert.equal(field(calls[0] as Call, 'upload_phase'), 'transfer');
  assert.equal(field(calls[0] as Call, 'start_offset'), '120');
  assert.equal(field(calls[0] as Call, 'end_offset'), '200');
  assert.deepEqual(Array.from(await chunkBytes(calls[0] as Call)), Array.from(SOURCE_BYTES.subarray(120, 200)));
  // Only the bytes actually re-sent are counted; the first 120 were another worker's.
  assert.equal(res.bytesTransferred, 130);
  assert.equal(res.videoId, 'v1');
});

test('resuming without a persisted end offset proposes a window, clamped to the file', async () => {
  assert.ok(RESUME_CHUNK_BYTES > SOURCE_BYTES.byteLength);
  const { fetchImpl, calls } = harness(script({ start_offset: '250', end_offset: '250' }, { success: true }));

  await uploader(fetchImpl).uploadChunked({
    source: source(),
    resume: { videoId: 'v1', uploadSessionId: 's1', startOffset: 10 },
  });

  assert.equal(field(calls[0] as Call, 'start_offset'), '10');
  assert.equal(field(calls[0] as Call, 'end_offset'), '250');
});

test('progress fires with the resume offset BEFORE the chunk goes out, and is awaited', async () => {
  const events: string[] = [];
  const { fetchImpl } = harness((call, i) => {
    events.push(`request:${field(call, 'upload_phase')}:${call.form?.get('start_offset') ?? '-'}`);
    return json(
      [
        { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '100' },
        { start_offset: '100', end_offset: '250' },
        { start_offset: '250', end_offset: '250' },
        { success: true },
      ][i],
    );
  });

  const seen: UploadProgress[] = [];
  await uploader(fetchImpl).uploadChunked({
    source: source(),
    onProgress: async (p) => {
      // An async callback proves the uploader awaits it — a caller that fsyncs the
      // resume point here must be able to finish before the bytes leave.
      await Promise.resolve();
      events.push(`progress:${p.phase}:${p.startOffset}`);
      seen.push(p);
    },
  });

  assert.deepEqual(events, [
    'request:start:-',
    'progress:chunk-start:0',
    'request:transfer:0',
    'progress:chunk-complete:100',
    'progress:chunk-start:100',
    'request:transfer:100',
    'progress:chunk-complete:250',
    'request:finish:-',
  ]);
  assert.deepEqual(
    seen.filter((p) => p.phase === 'chunk-start').map((p) => [p.startOffset, p.endOffset, p.attempt]),
    [
      [0, 100],
      [100, 250],
    ].map((w) => [...w, 1]),
  );
  assert.equal(seen[0]?.fileSize, 250);
  assert.equal(seen[0]?.uploadSessionId, 's1');
});

test('a failed chunk resumes from error_data.start_offset rather than replaying the window', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '100' },
      json(
        {
          error: {
            message: 'There was a problem uploading your video file. Please try again.',
            code: 6001,
            error_data: { start_offset: '60', end_offset: '100' },
          },
        },
        400,
      ),
      { start_offset: '100', end_offset: '250' },
      { start_offset: '250', end_offset: '250' },
      { success: true },
    ),
  );

  const attempts: number[] = [];
  const res = await uploader(fetchImpl).uploadChunked({
    source: source(),
    onProgress: (p) => {
      if (p.phase === 'chunk-start') attempts.push(p.startOffset);
    },
  });

  assert.equal(field(calls[1] as Call, 'start_offset'), '0');
  // Meta said it is at byte 60; the retry must continue from there, not from 0.
  assert.equal(field(calls[2] as Call, 'start_offset'), '60');
  assert.equal(field(calls[2] as Call, 'end_offset'), '100');
  assert.deepEqual(Array.from(await chunkBytes(calls[2] as Call)), Array.from(SOURCE_BYTES.subarray(60, 100)));
  assert.deepEqual(attempts, [0, 60, 100]);
  assert.equal(res.chunkCount, 2);
});

test('error_data arriving as a JSON string is read the same way', () => {
  const err = new MetaApiError(
    {
      message: 'Invalid parameter',
      code: 100,
      // Meta serialises error_data as a string on several error shapes.
      ...({ error_data: JSON.stringify({ start_offset: 4096, end_offset: 8192 }) } as object),
    },
    400,
  );
  assert.deepEqual(resumeOffsetsFromError(err), { startOffset: 4096, endOffset: 8192 });
  assert.equal(resumeOffsetsFromError(new MetaApiError({ message: 'nope', code: 100 }, 400)), undefined);
  assert.equal(resumeOffsetsFromError(new Error('not a Meta error')), undefined);
});

test('a permanent error with no resume offsets is not retried, and the session is cancelled', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      json(
        { error: { message: "The video file you selected is in a format that we don't support.", code: 352 } },
        400,
      ),
      { success: true },
    ),
  );

  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source() }),
    (e: unknown) => e instanceof MetaApiError && e.code === 352,
  );

  assert.equal(calls.length, 3, 'start, one transfer (no retry), cancel');
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'cancel');
  assert.equal(field(calls[2] as Call, 'upload_session_id'), 's1');
});

test('a transient failure exhausts retries but leaves the session open so it can be resumed', async () => {
  const transient = () => json({ error: { message: 'Please reduce the amount of data', code: 4 } }, 400);
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      transient(),
      transient(),
    ),
  );

  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source(), maxChunkAttempts: 2 }),
    (e: unknown) =>
      e instanceof Error &&
      /failed after 2 attempts at offset 0 of 250/.test(e.message) &&
      /resume rather than re-uploading/.test(e.message),
  );
  // No cancel: throwing away a resumable session is how a 200 MB upload gets re-done.
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => field(c, 'upload_phase') !== 'cancel'));
});

test('the transfer loop exits on success:true even if the offsets have not converged', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '100' },
      { start_offset: '100', end_offset: '200', success: true },
      { success: true },
    ),
  );
  const res = await uploader(fetchImpl).uploadChunked({ source: source() });
  assert.equal(res.chunkCount, 1);
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'finish');
});

test('the transfer loop exits when the next offset reaches EOF', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      // Offsets have not converged and there is no success flag, but there is nothing left.
      { start_offset: '250', end_offset: '400' },
      { success: true },
    ),
  );
  const res = await uploader(fetchImpl).uploadChunked({ source: source() });
  assert.equal(res.chunkCount, 1);
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'finish');
});

test('skip_upload from the start phase means Meta already has the bytes', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '0', skip_upload: true },
      { success: true },
    ),
  );
  const res = await uploader(fetchImpl).uploadChunked({ source: source() });
  assert.equal(res.skippedUpload, true);
  assert.equal(res.chunkCount, 0);
  assert.equal(calls.length, 2);
  assert.equal(field(calls[1] as Call, 'upload_phase'), 'finish');
});

test('a non-advancing offset is a loud failure, not an infinite loop', async () => {
  const { fetchImpl } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '100' },
      { start_offset: '0', end_offset: '100' },
      { success: true },
    ),
  );
  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source() }),
    (e: unknown) => e instanceof Error && /not advancing: Meta returned start_offset=0 again/.test(e.message),
  );
});

test('the start phase must return both a video id and a session id', async () => {
  const { fetchImpl } = harness(script({ upload_session_id: 's1', start_offset: '0', end_offset: '100' }));
  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source() }),
    (e: unknown) => e instanceof Error && /returned no video_id/.test(e.message),
  );
});

test('finish returning success:false is never mistaken for a usable asset', async () => {
  const { fetchImpl } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '0', skip_upload: true },
      { success: false },
    ),
  );
  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source() }),
    (e: unknown) => e instanceof Error && /success:false/.test(e.message),
  );
});

test('a source larger than the 4 GB ceiling is refused before any bandwidth is spent', async () => {
  const huge: ChunkSource = {
    size: AD_VIDEO_SPEC.maxFileSizeBytes + 1,
    read: async () => {
      throw new Error('must not read');
    },
    close: async () => {},
  };
  await assert.rejects(
    () => uploader(NEVER).uploadChunked({ source: huge }),
    /above Meta's 4 GB ad video limit/,
  );
});

test('SIMULATE stubs the whole upload path without touching the network', async () => {
  const u = new VideoUploader({
    adAccountId: 'act_123',
    accessToken: 't',
    appSecret: 's',
    mode: 'SIMULATE',
    fetchImpl: NEVER,
  });
  const a = await u.uploadChunked({ source: source(), title: 'x' });
  const b = await u.uploadChunked({ source: source(), title: 'x' });
  assert.match(a.videoId, /^simulated_video_/);
  assert.equal(a.videoId, b.videoId, 'the same intent must simulate to the same id');
  assert.equal((await u.getVideoStatus(a.videoId)).videoStatus, 'ready');
  assert.match((await u.uploadAdImage({ bytes: new Uint8Array([1]), filename: 'p.jpg' })).hash, /^simulated_imagehash_/);
});

test('is_ai_generated is sent on the start phase when the caller asks for it', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '0', skip_upload: true },
      { success: true },
    ),
  );
  await uploader(fetchImpl).uploadChunked({ source: source(), isAiGenerated: true });
  assert.equal(field(calls[0] as Call, 'is_ai_generated'), 'true');
});

/* ------------------------------------------------------------------ status poll ---- */

const PROCESSING = {
  status: {
    video_status: 'processing',
    processing_progress: 40,
    uploading_phase: { status: 'complete', bytes_transfered: 250, source_file_size: 250 },
    processing_phase: { status: 'in_progress' },
    publishing_phase: { status: 'not_started', error: {} },
  },
};
const READY = {
  status: {
    video_status: 'ready',
    processing_progress: 100,
    uploading_phase: { status: 'completed', bytes_transfered: 250 },
    processing_phase: { status: 'completed' },
  },
};

test('polling walks processing -> processing -> ready on the documented backoff ladder', async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = harness(script(PROCESSING, PROCESSING, READY));
  const u = uploader(fetchImpl, { sleep: clock.sleep, now: clock.now });

  const heartbeats: Array<[string, number | undefined, number]> = [];
  const status = await u.pollUntilReady('v1', {
    onPoll: (s, elapsed) => {
      heartbeats.push([s.videoStatus, s.processingProgress, elapsed]);
    },
  });

  assert.equal(status.videoStatus, 'ready');
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url.pathname, '/v26.0/v1');
  assert.equal(
    calls[0]?.url.searchParams.get('fields'),
    'status{video_status,processing_progress,uploading_phase,processing_phase,publishing_phase}',
  );
  assert.deepEqual(clock.slept, [2_000, 5_000]);
  assert.deepEqual(heartbeats, [
    ['processing', 40, 0],
    ['processing', 40, 2_000],
    ['ready', 100, 7_000],
  ]);
  // Meta's own spelling, one 'r'. This is the resume/progress signal, so it must survive parsing.
  assert.equal(status.uploadingPhase?.bytesTransfered, 250);
});

test('a video_status of error fails with Meta\'s own processing_phase message', async () => {
  const { fetchImpl } = harness(
    script({
      status: {
        video_status: 'error',
        processing_phase: { status: 'error', error: { message: 'Video codec not supported' } },
      },
    }),
  );
  await assert.rejects(
    () => uploader(fetchImpl).pollUntilReady('v9'),
    (e: unknown) =>
      e instanceof VideoProcessingError &&
      e.kind === 'FAILED' &&
      e.videoId === 'v9' &&
      /video_status="error"/.test(e.message) &&
      /Video codec not supported/.test(e.message),
  );
});

test('a phase-level error fails even while video_status still says processing', async () => {
  const { fetchImpl, calls } = harness(
    script({
      status: {
        video_status: 'processing',
        uploading_phase: { status: 'error', errors: [{ message: 'Upload was interrupted' }] },
        processing_phase: { status: 'not_started' },
      },
    }),
  );
  await assert.rejects(
    () => uploader(fetchImpl).pollUntilReady('v9'),
    (e: unknown) =>
      e instanceof VideoProcessingError && e.kind === 'FAILED' && /Upload was interrupted/.test(e.message),
  );
  assert.equal(calls.length, 1, 'a terminal failure must not be polled again');
});

test('expired is terminal, and says why it matters', async () => {
  const { fetchImpl } = harness(script({ status: { video_status: 'expired' } }));
  await assert.rejects(
    () => uploader(fetchImpl).pollUntilReady('v9'),
    (e: unknown) => e instanceof VideoProcessingError && /do not cache video ids indefinitely/.test(e.message),
  );
});

test('an unrecognised status keeps polling — the two Meta docs list different enums', async () => {
  const clock = fakeClock();
  const { fetchImpl } = harness(script({ status: { video_status: 'transcoding_variants' } }, READY));
  const u = uploader(fetchImpl, { sleep: clock.sleep, now: clock.now });
  assert.equal((await u.pollUntilReady('v1')).videoStatus, 'ready');
});

test('a wedged video times out at the deadline instead of polling forever', async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = harness(() => json(PROCESSING));
  const u = uploader(fetchImpl, { sleep: clock.sleep, now: clock.now });

  await assert.rejects(
    () => u.pollUntilReady('v1', { timeoutMs: 60_000 }),
    (e: unknown) =>
      e instanceof VideoProcessingError &&
      e.kind === 'TIMEOUT' &&
      /still "processing" after 60s/.test(e.message) &&
      /processing_progress 40%/.test(e.message),
  );
  // 2+5+10+15+15+13 == 60s: the last wait is clamped to the deadline, never overshot.
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 60_000);
  assert.ok(calls.length > 3 && calls.length < 12, `polled ${calls.length} times`);
});

test('an empty status object is a read error, not a healthy video', () => {
  assert.throws(
    () => parseVideoStatus('v1', { id: 'v1' }),
    /returned no status\.video_status/,
  );
  assert.throws(() => parseVideoStatus('v1', { id: 'v1' }), /222 "Video not visible"/);
});

test('both spellings of the terminal phase status are accepted', () => {
  for (const spelling of ['complete', 'completed']) {
    const s = parseVideoStatus('v1', {
      status: { video_status: 'ready', processing_phase: { status: spelling } },
    });
    assert.equal(classifyVideoStatus(s), 'READY');
  }
});

/* ------------------------------------------------------------------ thumbnails ----- */

test('thumbnail selection prefers is_preferred and otherwise takes the largest', async () => {
  const { fetchImpl, calls } = harness(
    script({
      data: [
        { id: 't1', uri: 'https://cdn/1.jpg', width: 640, height: 360, scale: 1, is_preferred: false },
        { id: 't2', uri: 'https://cdn/2.jpg', width: 1280, height: 720, is_preferred: true },
        { id: 't3', uri: 'https://cdn/3.jpg', width: 1920, height: 1080, is_preferred: false },
      ],
    }),
  );
  const thumbs = await uploader(fetchImpl).listThumbnails('v1');
  assert.equal(calls[0]?.url.pathname, '/v26.0/v1/thumbnails');
  assert.equal(thumbs.length, 3);
  assert.equal(selectPreferredThumbnail(thumbs)?.id, 't2');

  const none: VideoThumbnail[] = thumbs.map((t) => ({ ...t, isPreferred: false }));
  assert.equal(selectPreferredThumbnail(none)?.id, 't3', 'falls back to the largest candidate');
  assert.equal(selectPreferredThumbnail([]), undefined);
});

test('an oversized custom thumbnail is refused against the documented 10 MB limit', async () => {
  await assert.rejects(
    () =>
      uploader(NEVER).setThumbnail('v1', {
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        filename: 'poster.jpg',
      }),
    /documented maximum is 10 MB/,
  );
});

test('adimages is read by the single map entry, not by a constant key', async () => {
  const { fetchImpl, calls } = harness(
    // The response map is keyed by the multipart field name we used.
    script({ images: { 'poster_9x16.jpg': { hash: 'abc123', url: 'https://scontent/x', width: 1080, height: 1920 } } }),
  );
  const img = await uploader(fetchImpl).uploadAdImage({
    bytes: new Uint8Array([1, 2, 3]),
    filename: 'poster_9x16.jpg',
  });
  assert.equal(calls[0]?.url.pathname, '/v26.0/act_123/adimages');
  assert.ok(calls[0]?.form?.get('poster_9x16.jpg'), 'the file part is named after the file');
  assert.deepEqual(img, { hash: 'abc123', url: 'https://scontent/x', width: 1080, height: 1920, name: undefined });
});

test('adimages under a key we did not send still resolves when there is exactly one', async () => {
  const { fetchImpl } = harness(script({ images: { bytes: { hash: 'deadbeef' } } }));
  const img = await uploader(fetchImpl).uploadAdImage({ bytes: new Uint8Array([1]), filename: 'poster.jpg' });
  assert.equal(img.hash, 'deadbeef');
});

test('an ambiguous adimages response names the keys instead of guessing', async () => {
  const { fetchImpl } = harness(script({ images: { a: { hash: '1' }, b: { hash: '2' } } }));
  await assert.rejects(
    () => uploader(fetchImpl).uploadAdImage({ bytes: new Uint8Array([1]), filename: 'poster.jpg' }),
    /Keys: \[a, b\]/,
  );
});

/* --------------------------------------------------------------- path + errors ----- */

test('the ad account id is normalised into the path and never guessed at', () => {
  assert.equal(normaliseAdAccountPath('123'), 'act_123');
  assert.equal(normaliseAdAccountPath('act_123'), 'act_123');
  assert.equal(normaliseAdAccountPath('  act_123 '), 'act_123');
  for (const bad of ['', 'act_', 'my account', 'act_123/campaigns', 'https://x/act_1']) {
    assert.throws(() => normaliseAdAccountPath(bad), /adAccountId/, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('an HTTP error with no Graph error body still surfaces as a MetaApiError', async () => {
  const { fetchImpl } = harness(() => json({ nothing: 'useful' }, 502));
  await assert.rejects(
    () => uploader(fetchImpl).getVideoStatus('v1'),
    (e: unknown) => e instanceof MetaApiError && e.httpStatus === 502,
  );
});

test('an HTML error page from a proxy is reported as such, not parsed into nonsense', async () => {
  // Large multipart POSTs are exactly what intermediaries mangle; the status code and a
  // body snippet are the only diagnostics available at 3am.
  const { fetchImpl } = harness(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
  await assert.rejects(
    () => uploader(fetchImpl).getVideoStatus('v1'),
    /Non-JSON response from Meta \(HTTP 502\): <html>502 Bad Gateway<\/html>/,
  );
});

/* ------------------------------------------------------------------ spec checks ---- */

/** A render straight off the documented ffmpeg recipe. This must pass cleanly. */
const GOOD: VideoFileMetadata = {
  fileSizeBytes: 18 * 1024 * 1024,
  durationSeconds: 20,
  width: 1080,
  height: 1920,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  videoBitrateBps: 8_000_000,
  audioBitrateBps: 128_000,
  audioSampleRateHz: 48_000,
  audioChannels: 2,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  pixelFormat: 'yuv420p',
  moovAtomAtFront: true,
  hasEditLists: false,
  variableFrameRate: false,
  closedGop: true,
  interlaced: false,
  pixelAspectRatio: 1,
};

function fieldsFailing(meta: VideoFileMetadata): string[] {
  return validateAdVideoSpec(meta).errors.map((e) => e.field);
}

test('the recommended encode passes with no findings at all', () => {
  const v = validateAdVideoSpec(GOOD);
  assert.equal(v.ok, true);
  assert.deepEqual(v.findings, []);
});

test('each documented ad video limit is enforced and names the offending value', () => {
  const cases: Array<[string, Partial<VideoFileMetadata>, RegExp]> = [
    ['durationSeconds', { durationSeconds: 2.5 }, /below the 3s minimum/],
    ['durationSeconds', { durationSeconds: 901 }, /15 minute maximum/],
    ['width', { width: 2160, height: 3840 }, /exceeds the 1920 horizontal pixel maximum/],
    ['frameRate', { frameRate: 12 }, /outside the accepted 23-60 fps range/],
    ['frameRate', { frameRate: 120 }, /outside the accepted 23-60 fps range/],
    ['videoBitrateBps', { videoBitrateBps: 40_000_000 }, /40\.0 Mbps exceeds/],
    ['videoCodec', { videoCodec: 'vp9' }, /not H\.264/],
    ['audioCodec', { audioCodec: 'opus' }, /not AAC/],
    ['audioBitrateBps', { audioBitrateBps: 64_000 }, /64 kbps is below/],
    ['audioSampleRateHz', { audioSampleRateHz: 96_000 }, /exceeds the 48 kHz maximum/],
    ['container', { container: 'webm' }, /not MP4 or MOV/],
    ['fileSizeBytes', { fileSizeBytes: 5 * 1024 * 1024 * 1024 }, /exceeds Meta's 4 GB/],
    ['pixelAspectRatio', { pixelAspectRatio: 1.33 }, /square pixels/],
    ['interlaced', { interlaced: true }, /progressive scan/],
  ];
  for (const [field, patch, pattern] of cases) {
    const v = validateAdVideoSpec({ ...GOOD, ...patch });
    assert.equal(v.ok, false, `${field}=${JSON.stringify(patch)} must fail`);
    assert.deepEqual(v.errors.map((e) => e.field), [field]);
    assert.match(v.errors[0]?.message ?? '', pattern);
  }
});

test('the error-352 class of encoder faults is caught before upload', () => {
  assert.deepEqual(fieldsFailing({ ...GOOD, pixelFormat: 'yuv444p' }), ['pixelFormat']);
  assert.match(validateAdVideoSpec({ ...GOOD, pixelFormat: 'yuv420p10le' }).errors[0]?.message ?? '', /error 352/);
  assert.deepEqual(fieldsFailing({ ...GOOD, moovAtomAtFront: false }), ['moovAtomAtFront']);
  assert.deepEqual(fieldsFailing({ ...GOOD, hasEditLists: true }), ['hasEditLists']);
  assert.deepEqual(fieldsFailing({ ...GOOD, closedGop: false }), ['closedGop']);
  assert.deepEqual(fieldsFailing({ ...GOOD, variableFrameRate: true }), ['variableFrameRate']);
});

test('unknown hygiene metadata warns rather than silently passing', () => {
  const partial: VideoFileMetadata = {
    fileSizeBytes: 5_000_000,
    durationSeconds: 15,
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: 'h264',
  };
  const v = validateAdVideoSpec(partial);
  assert.equal(v.ok, true, 'unprobed fields must not fail a render outright');
  assert.deepEqual(v.warnings.map((w) => w.field).sort(), [
    'audioCodec',
    'hasEditLists',
    'moovAtomAtFront',
    'pixelFormat',
    'variableFrameRate',
  ]);
});

test('findings carry the basis, because half of these are not documented AD requirements', () => {
  const bitrate = validateAdVideoSpec({ ...GOOD, videoBitrateBps: 40_000_000 }).errors[0];
  assert.equal(bitrate?.basis, 'ORGANIC_SPEC');
  assert.equal(validateAdVideoSpec({ ...GOOD, moovAtomAtFront: false }).errors[0]?.basis, 'ENCODER_HYGIENE');
  assert.equal(validateAdVideoSpec({ ...GOOD, videoCodec: 'vp9' }).errors[0]?.basis, 'AD_SPEC');
});

test('HEVC and mono warn but do not block — Meta\'s own specs disagree with each other there', () => {
  const hevc = validateAdVideoSpec({ ...GOOD, videoCodec: 'hevc' });
  assert.equal(hevc.ok, true);
  assert.deepEqual(hevc.warnings.map((w) => w.field), ['videoCodec']);

  const mono = validateAdVideoSpec({ ...GOOD, audioChannels: 1 });
  assert.equal(mono.ok, true);
  assert.deepEqual(mono.warnings.map((w) => w.field), ['audioChannels']);
});

test('an oversized-but-legal render warns about pipeline tail latency', () => {
  const v = validateAdVideoSpec({ ...GOOD, fileSizeBytes: 500 * 1024 * 1024 });
  assert.equal(v.ok, true);
  assert.match(v.warnings[0]?.message ?? '', /practical cap/);
});

/* ---------------------------------------------------------------- chunk sources ---- */

test('a file chunk source reads only the requested window and never the whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'advideos-'));
  const path = join(dir, 'render.mp4');
  try {
    await writeFile(path, SOURCE_BYTES);
    const src = await fileChunkSource(path);
    try {
      assert.equal(src.size, 250);
      assert.deepEqual(Array.from(await src.read(0, 100)), Array.from(SOURCE_BYTES.subarray(0, 100)));
      assert.deepEqual(Array.from(await src.read(200, 250)), Array.from(SOURCE_BYTES.subarray(200, 250)));
      // Random access, out of order: Meta dictates the windows, so the source cannot
      // assume it is being read forwards.
      assert.deepEqual(Array.from(await src.read(120, 130)), Array.from(SOURCE_BYTES.subarray(120, 130)));
      await assert.rejects(() => src.read(200, 300), /runs past end of source/);
    } finally {
      await src.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a buffer chunk source serves exact windows and refuses windows past EOF', async () => {
  const src = source();
  assert.equal(src.size, 250);
  assert.deepEqual(Array.from(await src.read(10, 20)), Array.from(SOURCE_BYTES.subarray(10, 20)));
  await assert.rejects(() => src.read(240, 260), /runs past end of source/);
  await assert.rejects(() => src.read(20, 10), /Invalid byte window/);
});

/* ------------------------------------------------- transport-transient handling ---- */

/** A 502 whose body carries no Graph `error` object — what a load balancer actually returns. */
const GATEWAY_502 = () => json({ nothing: 'useful' }, 502);

test('a gateway 502 mid-transfer is retried and the session is NOT thrown away', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      GATEWAY_502(),
      { start_offset: '250', end_offset: '250' },
      { success: true },
    ),
  );

  const res = await uploader(fetchImpl).uploadChunked({ source: source() });

  // The regression this guards: classify() maps the synthetic code -1 to PERMANENT, so
  // the window was abandoned on the first blip AND the session cancelled — a full
  // re-upload of up to 4 GB because a proxy hiccuped on a large multipart POST.
  assert.equal(calls.length, 4, 'start, failed transfer, retried transfer, finish');
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'transfer');
  assert.equal(field(calls[2] as Call, 'start_offset'), '0', 'the same window is replayed; offsets are absolute');
  assert.ok(calls.every((c) => field(c, 'upload_phase') !== 'cancel'), 'a resumable session must survive a 502');
  assert.equal(res.bytesTransferred, 250);
});

test('a 400 with a real Graph error code is still permanent — only bodyless HTTP failures relax', async () => {
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      json({ error: { message: 'Invalid parameter', code: 100 } }, 400),
      { success: true },
    ),
  );
  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source() }),
    (e: unknown) => e instanceof MetaApiError && e.code === 100,
  );
  assert.equal(calls.length, 3, 'no retry');
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'cancel');
});

/* ------------------------------------------------------- transfer response shapes -- */

test('a final transfer that answers only success:true completes the upload', async () => {
  // The dossier lists `success: true` as an exit signal in its own right. A response
  // carrying it need not carry offsets; demanding them turned the last chunk into a
  // parse failure and then into a spurious upload failure.
  const { fetchImpl, calls } = harness(
    script(
      { video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' },
      { success: true },
      { success: true },
    ),
  );
  const res = await uploader(fetchImpl).uploadChunked({ source: source() });
  assert.equal(field(calls[2] as Call, 'upload_phase'), 'finish');
  assert.equal(res.chunkCount, 1);
  assert.equal(res.bytesTransferred, 250, 'the whole file is recorded as sent, not just the last window');
});

test('a transfer response with neither offsets nor success is a loud failure', async () => {
  const { fetchImpl } = harness(
    script({ video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '250' }, {}),
  );
  await assert.rejects(
    () => uploader(fetchImpl).uploadChunked({ source: source(), maxChunkAttempts: 1 }),
    /neither a usable \[start_offset, end_offset\) nor success:true/,
  );
});

/* ---------------------------------------------------------------- poll resilience -- */

test('a transient status-read failure does not abandon a video Meta is still transcoding', async () => {
  const clock = fakeClock();
  const { fetchImpl, calls } = harness(script(GATEWAY_502(), PROCESSING, READY));
  const u = uploader(fetchImpl, { sleep: clock.sleep, now: clock.now });

  // Throwing here would send the caller back to re-upload a file that is already fine.
  assert.equal((await u.pollUntilReady('v1')).videoStatus, 'ready');
  assert.equal(calls.length, 3);
});

test('a sustained status-read outage still gives up, and says the upload may have worked', async () => {
  const clock = fakeClock();
  const { fetchImpl } = harness(() => GATEWAY_502());
  const u = uploader(fetchImpl, { sleep: clock.sleep, now: clock.now });
  await assert.rejects(
    () => u.pollUntilReady('v1'),
    (e: unknown) =>
      e instanceof Error &&
      /consecutive\s+transient failures/.test(e.message) &&
      /check the asset before re-uploading/.test(e.message),
  );
});

test('an auth failure while polling is raised immediately, not retried into the timeout', async () => {
  const { fetchImpl, calls } = harness(() => json({ error: { message: 'Video not visible', code: 200 } }, 400));
  await assert.rejects(
    () => uploader(fetchImpl).pollUntilReady('v1'),
    (e: unknown) => e instanceof MetaApiError && e.code === 200,
  );
  assert.equal(calls.length, 1);
});

/* --------------------------------------------------------------- SIMULATE is dry --- */

function simulator(): VideoUploader {
  return new VideoUploader({
    adAccountId: '123',
    accessToken: 't',
    appSecret: 's',
    mode: 'SIMULATE',
    fetchImpl: NEVER,
  });
}

test('every write is dry in SIMULATE — setThumbnail was posting a real poster', async () => {
  const u = simulator();
  await u.setThumbnail('v1', { bytes: new Uint8Array([1, 2, 3]), filename: 'poster.jpg' });
  await u.cancelUpload('s1');
  assert.deepEqual(await u.listThumbnails('v1'), []);
  assert.match((await u.uploadSimple({ bytes: new Uint8Array([1]), filename: 'a.mp4' })).videoId, /^simulated_video_/);
});

test('SIMULATE still enforces input limits — a dry run that accepts bad input is useless', async () => {
  await assert.rejects(
    () => simulator().setThumbnail('v1', { bytes: new Uint8Array(MAX_THUMBNAIL_BYTES + 1), filename: 'p.jpg' }),
    /documented maximum is 10 MB/,
  );
});

test('the raw phase methods refuse in SIMULATE rather than quietly uploading', async () => {
  const u = simulator();
  for (const call of [
    () => u.startUpload(100),
    () => u.transferChunk({ uploadSessionId: 's1', startOffset: 0, endOffset: 1, bytes: new Uint8Array([1]) }),
    () => u.finishUpload('s1'),
  ]) {
    await assert.rejects(call, /SIMULATE mode.*uploadChunked/s);
  }
});

/* -------------------------------------------------------------------- title guard -- */

test('an over-length title is refused before a single byte is uploaded', async () => {
  // title is applied in the `finish` phase, so Meta would reject it only after the whole
  // file had gone over the wire — the most expensive possible place to discover it.
  await assert.rejects(
    () => uploader(NEVER).uploadChunked({ source: source(), title: 'x'.repeat(MAX_VIDEO_TITLE_CHARS) }),
    /must be less than 255 characters/,
  );
  await assert.rejects(
    () => simulator().uploadSimple({ bytes: new Uint8Array([1]), filename: 'a.mp4', title: '🙂'.repeat(300) }),
    /is 300 characters/,
  );
  // 254 code points is legal, and an emoji counts as one character, not two UTF-16 units.
  const { fetchImpl } = harness(
    script({ video_id: 'v1', upload_session_id: 's1', start_offset: '0', end_offset: '0', skip_upload: true }, { success: true }),
  );
  await uploader(fetchImpl).uploadChunked({ source: source(), title: '🙂'.repeat(254) });
});

/* ------------------------------------------------------- validator: unprobed input - */

test('an unmeasurable probe value fails instead of sailing through every comparison', () => {
  // ffprobe emits "N/A" for the duration of a malformed container and "0/0" for the frame
  // rate of a stream it could not parse; both land here as NaN, and every `<`/`>` below
  // is false against NaN. Silence here means an unplayable render reaches Meta.
  for (const patch of [
    { durationSeconds: NaN },
    { frameRate: NaN },
    { width: NaN },
    { height: Number.POSITIVE_INFINITY },
  ]) {
    const v = validateAdVideoSpec({ ...GOOD, ...patch });
    assert.equal(v.ok, false, `${JSON.stringify(patch)} must not validate clean`);
    assert.match(v.errors[0]?.message ?? '', /probe did not produce a usable number/);
  }
});

test('a portrait master taller than 1920 warns about the spec ambiguity without blocking', () => {
  const v = validateAdVideoSpec({ ...GOOD, width: 1080, height: 2400 });
  assert.equal(v.ok, true, 'an ambiguous sentence must not stop the pipeline');
  assert.deepEqual(v.warnings.map((w) => w.field), ['height']);
  assert.match(v.warnings[0]?.message ?? '', /maximum 1920 horizontal pixels/);
  // The standard 1080x1920 reel is exactly at the limit and must stay silent.
  assert.deepEqual(validateAdVideoSpec(GOOD).findings, []);
});
