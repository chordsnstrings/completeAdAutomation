# BytePlus ModelArk (Seedance video / Seedream image) for programmatic ad creative

**Research date: 2026-09-02.** Target use: fully-automated Meta (Facebook/Instagram) ad
creative generation — 9:16 vertical video + static images — published via the Marketing API
with no human in the loop.

**Verification method.** Two independent sources were used, and where they disagree the live
API wins:

1. **Live API probing** against `https://ark.ap-southeast.bytepluses.com/api/v3` with a real
   key on 2026-09-02. Enum values below marked *(probed)* were obtained by sending
   deliberately-invalid requests that die in server-side validation — these are free, nothing
   generates. Where a validator was needed *after* the field under test, a broken reference
   image URL (`https://nonexistent.invalid/a.jpg`) was used as a guaranteed-fail poison pill.
2. **Official docs** at `docs.byteplus.com/en/docs/ModelArk/...`. The doc site is a
   client-rendered SPA: plain `curl`/WebFetch returns only the nav shell. Content was read
   through a text-extraction proxy (`https://r.jina.ai/<url>`). Anything sourced only that way
   is flagged, because the proxy summarises and can drop table rows.

> **Headline for the build:** the single most important correction to prior assumptions is that
> video parameters are **top-level JSON fields** (`duration`, `resolution`, `ratio`,
> `generate_audio`, …), *not* `--flags` inside the prompt string. The `--flag` form still works
> but is an explicitly **legacy, loosely-validated** path where wrong values are silently
> ignored. Using it in an ad pipeline will silently ship 16:9 creative into a 9:16 placement.

---

## 1. Live model catalogue (probed 2026-09-02)

`GET /api/v3/models` returns the catalogue; it **lists models the key cannot call**, so it must
be cross-checked. Access status below is from live probes on the test key.

### Video — `domain: VideoGeneration`

| Model id | Access (probed) | Status | Input modalities | Declared task types |
|---|---|---|---|---|
| `seedance-1-0-pro-250528` | OK | active | text, image | ImageToVideo, TextToVideo |
| `seedance-1-0-pro-fast-251015` | OK | active | text, image | ImageToVideo, TextToVideo |
| `seedance-1-5-pro-251215` | OK | active | text, image | ImageToVideo, TextToVideo |
| `dreamina-seedance-2-0-260128` | OK | active | image, video, audio, text | MultimodalToVideo, VideoEditing, VideoExtension |
| `dreamina-seedance-2-0-fast-260128` | OK | active | image, video, audio, text | MultimodalToVideo, VideoEditing, VideoExtension |
| `dreamina-seedance-2-0-mini-260615` | OK | active | text, image, video, audio | MultimodalToVideo, VideoExtension, VideoEditing |
| `dreamina-seedance-2-5-260628` | **NOT ACTIVATED** | active | text, image, video, audio | MultimodalToVideo, VideoExtension, VideoEditing |
| `seedance-1-0-lite-t2v-250428` | NO ACCESS | Retiring | text | TextToVideo |
| `seedance-1-0-lite-i2v-250428` | NO ACCESS | Retiring | text, image | ImageToVideo |

**Seedance 2.5 now exists** — `dreamina-seedance-2-5-260628` — contradicting older notes that
said "there is no Seedance 2.5". It is in the catalogue and routable, but on the test key it
returns:

```
ModelNotOpen: Your account 3003309395 has not activated the model dreamina-seedance-2-5-260628.
Please activate the model service in the Ark Console.
```

### Image — `domain: ImageGeneration`

| Model id | Access (probed) | Pixel ceiling (probed) | Notes |
|---|---|---|---|
| `seedream-5-0-260128` | OK | 16,777,216 | current default |
| `seedream-5-0-lite-260128` | OK | 16,777,216 | **callable but NOT in `GET /models`** — only in pricing/docs |
| `dola-seedream-5-0-pro-260628` | OK | **4,624,220** | different, much lower ceiling |
| `seedream-4-5-251128` | OK | 16,777,216 | |
| `seedream-4-0-20260415` | OK | 16,777,216 | new build, not in older catalogues |
| `seedream-4-0-250828` | OK | 16,777,216 | |
| `seedream-3-0-t2i-250415` | NO ACCESS | — | Retiring |
| `seededit-3-0-i2i-250628` | — | — | **Shutdown** |

Exact probed error strings (note the inconsistent grammar between models — do not regex on it):

```
seedream-5-0-260128         -> `size` ... : image size must be at most 16777216 pixels.
dola-seedream-5-0-pro-...   -> `size` ... are not valid: image area must be at most 4624220 pixels.
```

---

## 2. Video generation API

### Endpoints

| Operation | Method + path |
|---|---|
| Create task | `POST /api/v3/contents/generations/tasks` |
| Query task | `GET /api/v3/contents/generations/tasks/{id}` |
| List tasks | `GET /api/v3/contents/generations/tasks?page_size=2&filter.status=succeeded` |
| Cancel/delete | `DELETE /api/v3/contents/generations/tasks/{id}` |

Auth: `Authorization: Bearer <ARK_API_KEY>`, `Content-Type: application/json`.

Video **and 3D** share `POST /contents/generations/tasks`; routing is by `model` id only.

Source: <https://docs.byteplus.com/en/docs/ModelArk/2298881>

### Request body — the modern, strictly-validated form

```json
{
  "model": "dreamina-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "<prompt>" },
    { "type": "image_url", "image_url": { "url": "<url>" }, "role": "first_frame" }
  ],
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "seed": 11,
  "camera_fixed": false,
  "watermark": true,
  "generate_audio": true,
  "return_last_frame": true,
  "service_tier": "default",
  "execution_expires_after": 172800,
  "callback_url": "<webhook_url>",
  "draft": false
}
```

### Field reference

| Field | Type | Default | Values / notes |
|---|---|---|---|
| `model` | string | — | required |
| `content[]` | array | — | blocks of `type`: `text`, `image_url`, `video_url`, `audio_url` |
| `content[].role` | string | — | `first_frame`, `last_frame`, `reference_image`, `reference_video`, `reference_audio` |
| `duration` | int | `-1` on 2.5 (auto) | per-model integer range — see §3 |
| `resolution` | string | `720p` | `480p`, `720p`, `1080p`, `4k` — per-model, see §3 |
| `ratio` | string | `adaptive` | see §4; `adaptive` preserves the input image aspect |
| `seed` | int | — | reproducibility |
| `camera_fixed` | bool | `false` | locks camera motion |
| `watermark` | bool | **`false`** | `true` renders an "AI generated" mark **bottom-right** |
| `generate_audio` | bool | **`true`** | native synchronised audio |
| `return_last_frame` | bool | — | also returns `content.last_frame_url` |
| `service_tier` | string | `default` | `default` (online) or `flex` (offline/batch). Docs: flex **not supported** on Dreamina 2.5 / 2.0 series. Half-price offline rate is published **only for `seedance-1-5-pro`** — see §5 correction |
| `execution_expires_after` | int | `172800` | seconds (48 h) |
| `callback_url` | string | — | webhook on completion — avoids polling |
| `draft` | bool | `false` | draft mode; 1.5 Pro only |

`watermark` default `false` and `generate_audio` default `true` are quoted from the Volcengine
mirror of the same API (<https://www.volcengine.com/docs/82379/1520757>), which states for
watermark: *"true：生成视频右下角会展示 AI 生成 水印。false：生成视频不含水印。"*
**Treat both defaults as advisory and set them explicitly on every call** — see Gotchas.

### Response

```json
{
  "id": "cgt-20260902164158-rqwgv",
  "model": "dreamina-seedance-2-5-260628",
  "status": "succeeded",
  "content": { "video_url": "<url>", "last_frame_url": "<url>" },
  "usage": { "completion_tokens": 246840, "total_tokens": 246840 },
  "created_at": 1765510475,
  "updated_at": 1765510559,
  "seed": 58944,
  "resolution": "1080p",
  "ratio": "16:9",
  "duration": 5,
  "framespersecond": 24,
  "service_tier": "default",
  "execution_expires_after": 172800
}
```

`status` enum: `queued`, `running`, `succeeded`, `failed`, `expired`.
Note the response key is `framespersecond` (one word, no underscores).

### The legacy `--flag` path — avoid

Parameters may also be appended to the prompt text. The docs list **short** forms:
`--rs` resolution, `--rt` ratio, `--dur` duration, `--seed`, `--cf` camera_fixed, `--wm` watermark.
The docs describe this path as using **loose validation** where "invalid parameters are ignored
or return errors".

Probing confirms exactly that, and it is worse than it sounds. Sending flags inside the prompt:

- `--duration` and `--resolution` **are** validated (error path `contents[0].text.duration`).
- `--ratio 99:1` was **accepted and generated a real, billed video** at the default aspect.
- `--fps`, `--camerafixed`, `--audio`, `--watermark`, `--seed` — and even invented flags
  `--hd true`, `--quality ultra` — were **all silently swallowed** with no error.

For an ad pipeline this is a silent-failure generator: a mistyped ratio produces correctly-
rendered 16:9 creative that is simply wrong for the placement, and you pay for it.

---

## 3. Verified per-model capability matrix *(probed)*

Duration probed in **i2v** mode with a broken-image poison pill (reliable ordering:
`duration` is validated **before** the image fetch). Resolution probed the same way.

| Model | Duration (integer seconds) | Resolutions | Max res for 9:16 ads |
|---|---|---|---|
| `seedance-1-0-pro-250528` | **2–12** (all integers) | 480p, 720p, 1080p | 1080p |
| `seedance-1-0-pro-fast-251015` | **2–12** | 480p, 720p, 1080p | 1080p |
| `seedance-1-5-pro-251215` | **4–12** | 480p, 720p, 1080p | 1080p |
| `dreamina-seedance-2-0-260128` | **4–15** | 480p, 720p, **4K** (no 1080p→2K gap: 1080p yes, 1440p/2K **no**) | 1080p / 4K |
| `dreamina-seedance-2-0-fast-260128` | **4–15** | 480p, 720p **only** | **720p** |
| `dreamina-seedance-2-0-mini-260615` | **4–15** | 480p, 720p **only** | **720p** |
| `dreamina-seedance-2-5-260628` | 4–30 (docs) | 480p, 720p, 1080p (docs) | not probed — ModelNotOpen |

Ranges are **contiguous integers**, not a discrete set — `7`, `9`, `11`, `13`, `14` all
validate where in range. This corrects the widespread belief that only `3/5/10` are accepted.

`360p`, `540p`, `1440p` and `2K` are rejected by **every** model probed. The only model
accepting `4K` is `dreamina-seedance-2-0-260128`.

**The cheap 2.0 tiers cap at 720p.** `2-0-fast` and `2-0-mini` cannot produce 1080p at all —
which matters because Meta's recommended vertical video spec is 1080×1920.

Top-level validation errors name the model *and the mode*, which is a useful debugging signal:

```
InvalidParameter: the parameter duration specified in the request must be less than or equal
to 12 for model seedance-1-0-pro in t2v
```

`framespersecond` is **fixed at 24** for all models; there is no fps control.

---

## 4. Aspect ratio enum *(probed)*

Documented set: `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `adaptive`.

Probing (poison = `duration:9999`, which validates *after* ratio) found the real set is larger
and **differs per model**:

| ratio | `seedance-1-0-pro` | `dreamina-seedance-2-0` |
|---|---|---|
| `21:9` `16:9` `4:3` `1:1` `3:4` `9:16` `adaptive` | accepted | accepted |
| `5:4` | accepted (undocumented) | accepted (undocumented) |
| `3:2` | **accepted** | **rejected** |
| `1.91:1` | **rejected** | **accepted** |
| `2:3` | rejected | rejected |

`9:16` — the one that matters for Reels/Stories — is supported everywhere. Do not assume the
undocumented extras are portable across models.

---

## 5. Cost model — exact, verified

Docs give an **estimate** formula:

> "Estimated token consumption = (Input video duration + Output video duration) × Output video
> width × Output video height × Output video frame rate / 1024"
> — <https://docs.byteplus.com/en/docs/ModelArk/1544106>

The **actual billed** figure is frame-exact. A real generation on `seedance-1-0-pro-250528`
returned `total_tokens: 49005`. The clip parsed as 864×480, 5.042 s, 24 fps, **121 frames**:

```
864 × 480 × 121 / 1024 = 49005.0     ← exact match to the billed number
```

So the true formula is:

```
frames  = fps × duration + 1          (fps is always 24)
tokens  = width × height × frames / 1024
cost    = tokens / 1e6 × rate_usd_per_million
```

The docs' `duration × w × h × fps` form under-counts by exactly one frame
(48,600 vs 49,005 — a 0.8 % under-estimate). Budget with the +1.

### Published rates (USD per 1M tokens)

Source: <https://docs.byteplus.com/en/docs/ModelArk/1544106>. "with video" = a video input was
supplied (cheaper); "without video" = text/image input.

| Model | Tier | online | offline (`flex`) |
|---|---|---|---|
| `seedance-1-0-pro-fast-251015` | — | **$1.00** | ~~$0.50~~ **no published offline rate** |
| `seedance-1-0-pro-250528` | — | $2.50 | ~~$1.25~~ **no published offline rate** |
| `seedance-1-5-pro-251215` | silent | $1.20 | $0.60 |
| `seedance-1-5-pro-251215` | **audio** | **$2.40** | $1.20 |
| `dreamina-seedance-2-0-mini-260615` | 480p/720p, no video in | $3.50 (60 % disc.) | not supported |
| `dreamina-seedance-2-0-mini-260615` | 480p/720p, with video in | $2.10 | not supported |
| `dreamina-seedance-2-0-fast-260128` | 480p/720p, no video in | $5.60 (25 % disc.) | not supported |
| `dreamina-seedance-2-0-fast-260128` | 480p/720p, with video in | $3.30 | not supported |
| `dreamina-seedance-2-0-260128` | 480p/720p, no video in | $7.00 | not supported |
| `dreamina-seedance-2-0-260128` | 480p/720p, **with video in** | **$4.30** | not supported |
| `dreamina-seedance-2-0-260128` | 1080p, no video in | $7.70 | not supported |
| `dreamina-seedance-2-0-260128` | 1080p, **with video in** | **$4.70** | not supported |
| `dreamina-seedance-2-0-260128` | **4K**, no video in | **$4.00** | not supported |
| `dreamina-seedance-2-0-260128` | **4K**, with video in | **$2.40** | not supported |
| `dreamina-seedance-2-5-260628` | 480p/720p | $10.70 | — |
| `dreamina-seedance-2-5-260628` | 1080p | $11.70 | — |

Note the inversion: on 2.0, **4K is cheaper per token than 1080p** ($4.00 vs $7.70) — but 4K
has ~4× the tokens, so it is still far more expensive per clip.

### Cost per 9:16 vertical clip, 5 s (computed from the verified formula)

| Model | 480p (480×864) | 720p (720×1280) | 1080p (1088×1920) |
|---|---|---|---|
| tokens | 49,005 | 108,900 | 246,840 |
| `seedance-1-0-pro-fast` | **$0.049** | **$0.109** | **$0.247** |
| `seedance-1-5-pro` silent | $0.059 | $0.131 | $0.296 |
| `seedance-1-0-pro` | $0.123 | $0.272 | $0.617 |
| `seedance-1-5-pro` + audio | $0.118 | $0.261 | $0.592 |
| `dreamina-2-0-mini` | $0.172 | $0.381 | n/a (720p cap) |
| `dreamina-2-0-fast` | $0.274 | $0.610 | n/a (720p cap) |
| `dreamina-2-0` | $0.343 | $0.762 | $1.901 |
| `dreamina-2-5` | $0.524 | $1.165 | $2.888 |

> **[FACT-CHECK CORRECTION]** ~~`service_tier: "flex"` halves the 1.x prices but is **only
> available on `seedance-1-5-pro`**.~~ **Wrong on availability, and unproven on price.**
> The API reference states flex/offline inference is supported on **Seedance 1.5 Pro *and* the
> Seedance 1.0 series**, and that *"Dreamina Seedance 2.5 and Dreamina Seedance 2.0 series
> models are not supported."* The rate-limit page confirms this by listing `flex: TPD: 500B`
> for `seedance-1-0-pro-250528`, `seedance-1-0-pro-fast-251015` **and** `seedance-1-5-pro-251215`.
> However, the **pricing page publishes offline rates only for Seedance 1.5 Pro** — there are no
> offline price rows for the 1.0 series. So flex is *accepted* on 1.0 models but the discount is
> **unpriced and unverified**; the `$0.50` / `$1.25` figures previously in the table above were
> assumed, not sourced. Do not budget against them.
> Sources: <https://docs.byteplus.com/en/docs/ModelArk/2298881>,
> <https://docs.byteplus.com/en/docs/ModelArk/1330310>,
> <https://docs.byteplus.com/en/docs/ModelArk/1544106>

Flex is offline/batch with a TPD cap, so it is unsuitable for latency-sensitive work regardless.

---

## 6. Audio

- `generate_audio` is a real top-level boolean and **defaults to `true`**.
- Native audio is supported on **Dreamina 2.5, 2.0 series, and Seedance 1.5 Pro**.
- **Seedance 1.0 Pro does not produce audio.** Empirically confirmed (the generated MP4
  contained exactly one track, `hdlr` handler `vide`, no audio stream at all) **and now also
  confirmed in the primary docs** — the model capability table marks audio generation `✗` for
  Seedance 1.0 Pro and `✓` for Dreamina 2.5 / 2.0 / 2.0 Fast / 2.0 Mini / Seedance 1.5 Pro.
  <https://docs.byteplus.com/en/docs/ModelArk/2298881>
- **Output container is MP4 only.** The capability table lists MP4 for every video model; there
  is **no `.mov` output** (see the corrected note in §17).
- Cost consequence: on `seedance-1-5-pro`, audio **doubles** the rate ($2.40 vs $1.20 / M).
  Since the default is `true`, forgetting the field silently doubles spend.
- For Meta feed placements the overwhelming majority of impressions are watched muted, so
  `generate_audio: false` is usually both cheaper and creatively irrelevant — but Reels
  rewards sound-on, so this should be a per-placement decision, not a global default.

---

## 7. Watermark

- `watermark` is a top-level boolean, **default `false`** (no watermark).
- When `true`, an "AI generated" mark is rendered in the **bottom-right corner**.
- The legacy `--wm` / `--watermark` prompt flag is **not validated** and was observed being
  silently ignored — so a pipeline that "disables" the watermark via the prompt string is
  relying on a default, not on the flag it thinks it set.

**Recommendation: always send `"watermark": false` as an explicit top-level field**, and run a
cheap bottom-right corner check on the first frame of each clip before it is uploaded to Meta.
A watermarked ad is a wasted impression buy and can read as low-quality creative.

---

## 8. Image-to-video, references, multi-shot

### First / last frame

```json
"content": [
  { "type": "text", "text": "slow push-in on the bottle, studio light" },
  { "type": "image_url", "image_url": {"url": "https://.../frame1.jpg"}, "role": "first_frame" },
  { "type": "image_url", "image_url": {"url": "https://.../frame2.jpg"}, "role": "last_frame" }
]
```

- First-frame-only: one `image_url` block; `role` may be omitted (defaults to first frame).
- First **and** last frame supported on Dreamina 2.5, 2.0 series, and 1.5 Pro.
  **Not supported on `seedance-1-0-pro-fast`.**
- Reference images/videos/audio use `role`: `reference_image`, `reference_video`,
  `reference_audio`, and are addressed **from inside the prompt text** as `[Image 1]`,
  `[Video 1]`, `[Audio 1]`. This is the mechanism for product/subject consistency.

### Multi-shot and editing (Dreamina 2.x only)

- **Omni Reference** — combine text + reference images + reference videos (with or without
  audio tracks) + audio in a single generation, inheriting characteristics from each.
- **Video Editing** — modify subjects/objects inside an existing video.
- **Video Extension** — extend a video forward or backward, or **stitch up to 3 clips**.

For a 15–30 s ad this is the practical storyboard path: generate shots individually, then use
extension/stitching, **or** chain shots with `return_last_frame: true` → feed the returned
`content.last_frame_url` as the next shot's `first_frame`. That chaining trick works on the
1.x models too and is the cheapest route to multi-shot continuity.

Image download failures surface synchronously and cheaply:

```
InvalidParameter: The parameter `content[1].image_url` specified in the request is not valid:
resource download failed.
```

Note the field path says `content[1]` (singular) while duration errors say `contents[0]`
(plural) — the API is inconsistent; do not build a shared error parser on that prefix.

---

## 9. Task lifecycle, expiry, cancellation

- Create → poll `GET .../tasks/{id}` (docs suggest ~10 s intervals) or supply `callback_url`
  for a webhook. **Use the webhook** in an autonomous system; polling 3-concurrent tasks at
  10 s burns quota for nothing.
- **Result URL retention: 24 hours, max 100 downloads.** Task *records* are retained 7 days.
  This **contradicts** the common claim that generated URLs last 7 days — it is the task
  metadata that lasts 7 days, not the media URL. Download and re-host to your own object
  store immediately on completion; treat the ModelArk URL as ephemeral.
- `execution_expires_after` defaults to 172800 s (48 h) — the task is killed if not executed.
- **A running task cannot be cancelled.** Probed:

  ```
  InvalidAction.RunningTaskDeletion: Cannot delete task `cgt-...` because it is currently running.
  ```

  `DELETE` only works while a task is `queued`. There is no way to abort a bad generation once
  it starts, and you are billed for it. Budget guards must run **before** submit, not after.

### Latency

Observed ~25–40 s for a 5 s 480p clip end-to-end. Docs put 3D at ~3.5 min. Plan for
minutes, not seconds, and never block an ad-publish path on a synchronous generate.

---

## 10. Rate limits, concurrency, regions

Source: <https://docs.byteplus.com/en/docs/ModelArk/1330310>

| Model | Max RPM | Max concurrency |
|---|---|---|
| `dreamina-seedance-2-5-260628` | 600 (enterprise) / **180 (individual)** | 10 (ent) / **3 (individual)** |
| `dreamina-seedance-2-0-260128` (non-4K) | 600 (ent) / 180 (individual) | 10 (ent) / **3 (individual)** |
| `dreamina-seedance-2-0-260128` **4K** | **15** (both account types) | **1** (both account types) |
| `dreamina-seedance-2-0-fast-260128` | 600 / 180 | 10 / **3** |
| `dreamina-seedance-2-0-mini-260615` | 600 / 180 | 10 / **3** |
| `seedance-1-5-pro-251215` | **600 — no account-type split** | **10**; flex TPD 500 B |
| `seedance-1-0-pro-250528` | **600 — no account-type split** | **10**; flex TPD 500 B |
| `seedance-1-0-pro-fast-251015` | **600 — no account-type split** | **10**; flex TPD 500 B |
| Seedream image models | **500 images/min** | — |

> **[FACT-CHECK CORRECTION — this was the most load-bearing error in the document]**
> ~~"On an individual account you get **3 simultaneous video tasks**" ... "design a job queue
> with a semaphore of 3".~~ **The 3-concurrency individual-account cap applies ONLY to the
> Dreamina Seedance 2.x models.** The rate-limit page gives the Seedance **1.x** models a single
> unified `default: Max RPM: 600, Max concurrency: 10` with **no individual/enterprise
> distinction at all**. `seedance-1-0-pro-fast` — the model §16 recommends for the exploration
> lane — therefore gets **10 concurrent tasks, not 3**, which is a ~3.3× higher throughput
> ceiling than this document assumed.
> Additionally, **4K on `dreamina-seedance-2-0-260128` is capped at concurrency 1**, not just
> 15 RPM — the original note recorded the RPM limit and missed the concurrency limit, which is
> the tighter of the two.
> Source: <https://docs.byteplus.com/en/docs/ModelArk/1330310>

**Concurrency, not RPM, is still the binding constraint — but the limit is per-model, so the
semaphore must be per-model, not global.** At ~30 s per 5 s clip: 10 concurrent on
`seedance-1-0-pro-fast` ≈ 1,200 clips/hour; 3 concurrent on Dreamina 2.x ≈ 360 clips/hour;
1 concurrent on Dreamina 2.0 4K ≈ 120 clips/hour (and far slower in practice at 4K). Design the
job queue with a **configurable per-model semaphore** seeded from a capability descriptor, not a
single hard-coded `3`.

`service_tier: "flex"` (offline) is governed by **TPD** (tokens per day, 500 B) rather than
concurrency, and is listed for **all three Seedance 1.x models** — the right lane for bulk
overnight creative refreshes, subject to the unresolved pricing question flagged in §5.

**Regions.** Image endpoint documented for `ap-southeast-1` (Singapore) and `eu-west-1`.
Base URL pattern `https://ark.ap-southeast.bytepluses.com/api/v3`. For an EU/US advertiser,
`eu-west-1` matters for both latency and data residency. Region availability per model:
<https://docs.byteplus.com/en/docs/ModelArk/2191806> (not fully enumerated here — verify).

**Billing path gotcha:** base path `/api/coding/v3` draws Coding-Plan quota while `/api/v3`
bills normally. They are otherwise identical on the wire, so a copy-pasted base URL can quietly
charge the wrong budget.

---

## 11. Seedream image generation (ad statics, product shots)

`POST /api/v3/images/generations` — **synchronous** (no task polling).

```json
{
  "model": "seedream-5-0-260128",
  "prompt": "...",
  "image": ["https://.../ref1.jpg", "https://.../ref2.jpg"],
  "size": "2K",
  "output_format": "png",
  "watermark": false,
  "response_format": "url",
  "sequential_image_generation": "auto",
  "sequential_image_generation_options": { "max_images": 4 },
  "stream": false,
  "optimize_prompt_options": { "mode": "standard" }
}
```

| Field | Values |
|---|---|
| `size` | tier (`1K`/`1.5K`/`2K`/`3K`/`4K`, model-dependent) or `WIDTHxHEIGHT` |
| `output_format` | `png`, `jpeg` — **seedream-5-0-pro / lite only** |
| `response_format` | `url`, `b64_json` |
| `sequential_image_generation` | `auto` — batch/series output |
| `optimize_prompt_options.mode` | `standard`, `fast` |
| `stream` | **not supported by `seedream-5-0-pro`** |

Prompt guidance from docs: *"Keep text prompts under 600 English words."*

### Size ceilings

| Model | Size tiers | Pixel range | Aspect range |
|---|---|---|---|
| `seedream-5-0-lite` | 2K, 3K, 4K | 3,686,400 – **16,777,216** | 1/16 – 16 |
| `dola-seedream-5-0-pro` | 1K, 1.5K, 2K | 921,600 – **4,624,220** | 1/16 – 16 |
| `seedream-4-5` | 2K, 4K | 3,686,400 – **16,777,216** | — |
| `seedream-4-0` | 1K, 2K, 4K | 921,600 (1280×720) – 16,777,216 (4096×4096) | — |

The "pro" model has a **lower** ceiling than lite — counter-intuitive and easy to get wrong.
Both ceilings were confirmed by live probe (§1) **and independently confirmed verbatim in the
primary docs during fact-check**: *"[1280x720(921,600), 2048x2048x1.1025(4,624,220)]"* for
Seedream 5.0 Pro vs *"[2560x1440(3,686,400), 4096x4096(16,777,216)]"* for Seedream 5.0 Lite.
Reference-image counts (pro = 10, lite/4.5/4.0 = 14) are also confirmed in the same doc.
Source: <https://docs.byteplus.com/en/docs/ModelArk/1541523>

### Reference images / subject consistency

- `image` accepts a URL **or an array** (also base64).
- `dola-seedream-5-0-pro`: **up to 10** reference images.
- `seedream-5-0-lite`, `4-5`, `4-0`: **up to 14** reference images.

This is the product-fidelity lever: pass several real product photographs as references so the
generated ad still shows *your* SKU rather than a plausible invention.

### Features that matter for ad statics

- **Text rendering**: Seedream 5.0 pro natively renders text in 14 additional languages
  (Russian, Arabic, Filipino, Thai, Turkish, Korean, Malay, Spanish, Portuguese, Indonesian,
  French, German, Vietnamese, Japanese) — directly useful for localised ad headlines.
- **Interactive editing**: *"Specify edit positions by using coordinates, bounding boxes,
  arrows, and other markers"* for local replacement and object positioning.
- **Layer decomposition**: *"automatically decompose subjects, backgrounds, text, decorative
  elements … into one base image and up to 16 independent layers with alpha channels."*
  This is the standout feature for this project: it turns one generated static into an
  editable, recomposable asset — swap the headline, keep the product, re-render per audience —
  without re-generating (and re-paying, and re-rolling the dice on product fidelity).

### Image pricing (per image, output)

| Model | Output price | Input |
|---|---|---|
| `seedream-4-0-250828` | $0.03 | free |
| `seedream-5-0-lite-260128` | $0.035 | free |
| `seedream-4-5-251128` | $0.04 | free |
| `dola-seedream-5-0-pro-260628` | $0.045 (≤1.5K) / $0.09 (>1.5K) | 1st image free, $0.003 each after |
| `dola-seedream-5-0-pro` layer decomposition | $0.0225 (≤1.5K) / $0.045 (>1.5K) | |

Images are billed **per image, not per token** — unlike video. Static ad creative is
essentially free at these prices ($0.03–0.09); do not over-engineer image cost control.

---

## 12. Commercial usage rights — read this before shipping

This is the weakest-verified and highest-risk area.

- The BytePlus Terms of Service (<https://docs.byteplus.com/en/legal/docs/terms-of-service>)
  contains **no clause that explicitly assigns ownership of generated output to the customer**,
  and no indemnity for generated content. The absence is itself the finding.
- Section 4 grants BytePlus a broad licence over customer data: *"you hereby grant to BytePlus
  and its affiliates a non-exclusive, worldwide, royalty-free, perpetual, irrevocable,
  sub-licensable, and transferable right and license without any license fee to access and use
  any data collected from you, or stored or uploaded by you."* For an ad platform this covers
  uploaded product photography and brand assets.
- The only trademark restriction found protects **BytePlus's own** marks, not third parties'.
- **No verified statement was found** on: generating identifiable people, celebrity likeness,
  or third-party brand content.

**Engineering consequence:** do not treat commercial clearance as settled. Meta separately
requires advertiser rights in all creative, and several jurisdictions (EU AI Act transparency
duties, US state synthetic-media/election rules) require disclosure of AI-generated
advertising. Route this to counsel before spend, and build a provenance log (model id, seed,
prompt, references, timestamp, task id) for every asset shipped to an ad account — you will
need it for both Meta appeals and regulatory response.

---

## 13. Honest comparison vs Google Veo for ad creative

| Dimension | BytePlus Seedance | Google Veo 3.1 |
|---|---|---|
| Billing unit | **per token** (w×h×frames/1024) | **per generation** ("$0.20 / 1 count") |
| 9:16 vertical | yes, all models | yes |
| Native audio | 2.5 / 2.0 / 1.5 Pro | yes, priced as a tier |
| Max duration | 12 s (1.x), 15 s (2.0), 30 s (2.5) | shorter per clip |
| Frame rate | fixed 24 fps | — |
| Concurrency (documented) | **10** on Seedance 1.x; **3** on Dreamina 2.x for individual accounts; **1** at 4K | Google Cloud quota model |
| First+last frame | yes (except 1-0-pro-fast) | yes |
| Video edit / extend / stitch | **2.x only** — up to 3 clips | limited |
| Layer-decomposed statics | **yes (Seedream 5 pro, 16 layers)** | no equivalent |

### The cost picture is decisive and it does not favour Seedance's flagships

Veo bills **per generation regardless of duration**; Seedance bills per pixel-frame. So the
comparison collapses to cost per usable clip:

Full Veo price list, verified verbatim against
<https://cloud.google.com/vertex-ai/generative-ai/pricing> (billing unit is literally
`/ 1 count`, i.e. per generation):

| Veo model | 720p | 1080p | 4K |
|---|---|---|---|
| Veo 3.1 — video only | $0.20 | $0.20 | **$0.40** |
| Veo 3.1 — with audio | $0.40 | $0.40 | **$0.60** |
| Veo 3.1 Fast — video only | **$0.08** | $0.10 | $0.25 |
| Veo 3.1 Fast — with audio | $0.10 | $0.12 | $0.30 |
| Veo 3.1 Lite — video only | $0.03 | $0.05 | n/a |
| Veo 3.1 Lite — with audio | $0.05 | $0.08 | n/a |
| Veo 3 — video only / with audio | $0.20 / $0.40 | $0.20 / $0.40 | n/a |
| Veo 3 Fast — video only / with audio | $0.08 / $0.10 | $0.10 / $0.12 | n/a |
| Veo 2 | $0.50 | — | — |

*(Additions found during fact-check: the original note omitted the Veo 3.1 **4K** tier, the
Veo 3.1 Fast **720p** rate of $0.08 — cheaper than the $0.10 quoted below — and the Veo 3 /
Veo 3 Fast / Veo 2 rows entirely.)*

| Option | 1080p vertical clip | with audio |
|---|---|---|
| Veo 3.1 Fast | **$0.10** | $0.12 |
| Veo 3.1 | $0.20 | $0.40 |
| Veo 3.1 Lite | $0.03–0.05 | $0.05–0.08 |
| Seedance 1-0-pro-fast (5 s) | $0.247 | n/a (no audio) |
| Seedance 1-5-pro (5 s) | $0.296 | $0.592 |
| Seedance dreamina-2-0 (5 s) | $1.901 | included |
| Seedance dreamina-2-5 (5 s) | $2.888 | included |

At 1080p 9:16, **Veo 3.1 Fast is roughly 2.5× cheaper than the cheapest Seedance model and
~29× cheaper than Dreamina 2.5** — and Veo's per-count billing means longer clips do not cost
more, whereas Seedance cost scales linearly with duration *and* quadratically with resolution.

Because Seedance's price is a function of pixels × frames, its cost advantage exists **only at
low resolution**. A 480p Seedance draft at $0.049 is the cheapest way to test a concept
anywhere; a 1080p Dreamina 2.5 hero clip at $2.89 is among the most expensive.

**Where Seedance still wins for this project:**
- 480p exploration is dirt cheap — ideal for the "generate 50 variants, kill 45" loop that an
  autonomous optimiser needs.
- Duration up to 30 s (2.5) exceeds typical Veo clip length; fewer stitches for a 30 s ad.
- Video **editing and extension** (2.x) — regenerating one shot inside an existing winning ad
  is exactly the self-improvement primitive this platform needs, and Veo has no clean analogue.
- **Seedream's layer decomposition** has no Veo/Imagen equivalent and is arguably more valuable
  to an ad platform than any video feature, because most Meta performance creative is static
  or near-static.

**Unverified but decision-relevant:** text-rendering fidelity in-frame, product fidelity from
reference images, and clip-level reliability (how many generations are usable) were **not
measured**. Those determine *effective* cost per usable clip and can invert any table above —
a $0.05 model with a 20 % hit rate costs $0.25/usable, worse than a $0.20 model at 90 %.
**Measure this before committing.**

---

## 14. Alternatives (justifying a provider-abstraction layer)

| Provider | Production API | Pricing (verified where cited) | Notes |
|---|---|---|---|
| **Google Veo 3.1 / Fast / Lite** | yes (Vertex AI) | $0.20 / $0.10 / $0.03–0.05 per generation; +audio tiers | per-count billing; best $/clip found |
| **OpenAI Sora** | yes | `sora-2` **$0.10/s @720p**; `sora-2-pro` $0.30/s 720p, $0.50/s 1024p, $0.70/s 1080p; **50 % batch discount** | native portrait 720×1280 / 1080×1920; per-second billing makes long clips costly |
| **BytePlus Seedance** | yes | per-token, see §5 | edit/extend + Seedream layers |
| **MiniMax / Hailuo** | yes — `video-generation-v2-create`, `-s2v` (subject reference), `-fl2v` (first & last frame) endpoints exist; "MiniMax H3" is current | **UNVERIFIED** | subject-reference endpoint is notable for product consistency |
| **Kling** | yes (docs gated behind login) | **UNVERIFIED** | could not read docs without auth |
| **Runway / Luma / Pika** | believed yes | **UNVERIFIED** | not reachable this session |

Sora pricing at $0.10/s means a 5 s 720p clip is **$0.50** — more expensive than every Seedance
option at 720p and 5× Veo 3.1 Fast at 1080p.

**Conclusion: build the provider-abstraction layer.** The three verified providers use three
mutually incompatible billing units (per-token, per-generation, per-second), three different
async lifecycles, and different duration/resolution/ratio enums. A `VideoProvider` interface
with `submit(spec) -> task_id`, `poll(task_id)`, `estimate_cost(spec)` and a per-provider
capability descriptor (allowed durations, resolutions, ratios, audio support, max concurrency)
is not premature abstraction here — it is the only way to make cost-per-usable-clip
comparable, and to fail over when one provider's per-model concurrency cap is saturated.

---

## 15. Gotchas

1. **Prompt `--flags` are a legacy, loosely-validated path.** Only `duration` and `resolution`
   are checked. `--ratio 99:1` **generated a billed video** at the wrong aspect. `--fps`,
   `--camerafixed`, `--audio`, `--watermark`, `--seed`, and invented flags like `--hd` /
   `--quality` are silently ignored. **Use top-level JSON fields.**
2. **Unknown top-level fields are also silently ignored** (`bogus_field` produced no error).
   Validate your request client-side against a whitelist; the API will not catch your typo.
3. **`generate_audio` defaults to `true`** and doubles the rate on `seedance-1-5-pro`
   ($2.40 vs $1.20/M). Set it explicitly.
4. **A running task cannot be cancelled** (`InvalidAction.RunningTaskDeletion`). `DELETE` works
   only while `queued`. Enforce budget before submit.
5. **Result URLs live 24 h / 100 downloads**, not 7 days. Only the *task record* lasts 7 days.
   Re-host immediately.
6. **`GET /models` lies both ways.** It lists models the key cannot call
   (`InvalidEndpointOrModel.NotFound`) *and* omits models that work — `seedream-5-0-lite-260128`
   is callable but absent from the listing.
7. **`ModelNotOpen` ≠ `NotFound`.** A naive access probe that only checks for `NotFound` reports
   `dreamina-seedance-2-5-260628` as accessible when it is not activated on the account. Check
   for both error codes.
8. **The cheap 2.0 tiers cap at 720p.** `2-0-fast` and `2-0-mini` cannot render 1080p, so they
   cannot hit Meta's recommended 1080×1920 vertical spec.
9. **`dola-seedream-5-0-pro` has a 4,624,220 px ceiling** — ~3.6× *lower* than the 16,777,216 of
   the non-pro models. "Pro" does not mean bigger.
10. **Validation order is not stable across paths.** Top-level: `ratio`/`resolution`/`camera_fixed`
    validate *before* `duration`. Legacy flags: `duration` before `resolution`. Both validate
    before the reference-image fetch. Do not rely on which error surfaces first.
11. **Error field paths are inconsistent**: `contents[0].text.duration` (plural) vs
    `content[1].image_url` (singular). Don't build one parser on the prefix.
12. **`/api/coding/v3` vs `/api/v3`** charge different budgets while behaving identically.
13. **Concurrency limits are per-model, not per-account.** ~~"Individual-account concurrency is 3."~~
    **Corrected:** individual accounts get **3** concurrent tasks on **Dreamina 2.x only**; the
    Seedance **1.x** models are documented at **10** concurrent with no account-type split, and
    **Dreamina 2.0 at 4K is capped at 1**. Use a per-model semaphore.
    (<https://docs.byteplus.com/en/docs/ModelArk/1330310>)
14. **Billed tokens include a +1 frame** over the documented estimate formula.
15. **4K is cheaper per token than 1080p on 2.0** ($4.00 vs $7.70) but ~4× the tokens — cheaper
    rate, more expensive clip.
16. **API keys embedded in tooling.** The local skill ships a live `ARK_API_KEY` in
    `scripts/ark.py`. Do not replicate that pattern in this platform; use a secret manager.

---

## 16. Implications for the build

- Use **top-level JSON fields** exclusively; add a client-side schema whitelist since neither
  unknown fields nor most legacy flags are validated.
- Always set explicitly: `watermark: false`, `generate_audio: <decided>`, `ratio: "9:16"`,
  `resolution`, `duration`, `seed`.
- **Two-stage creative funnel**: explore at 480p on `seedance-1-0-pro-fast` (~$0.05/clip),
  then re-render only proven winners at 1080p — or on Veo, which is cheaper at 1080p.
- **Use `callback_url`**, not polling. **Per-model** semaphore driven by a capability descriptor
  (10 for Seedance 1.x, 3 for Dreamina 2.x on an individual account, 1 for Dreamina 2.0 4K),
  not a single global `3`.
- **Re-host every asset within 24 h**; store `(task_id, model, seed, prompt, refs)` for
  provenance, Meta appeals, and reproducibility.
- **Provider abstraction is mandatory**, given three incompatible billing units and the hard
  concurrency cap.
- **Seedream layer decomposition** deserves a first-class place in the architecture: generate
  one hero static, decompose to ≤16 alpha layers, then recompose headline/CTA/background
  variants locally at zero marginal model cost. This is the cheapest variant-generation
  mechanism found anywhere in this research.
- Verify pre-flight: watermark absence (bottom-right crop check), aspect ratio, and duration
  on every returned asset before it reaches a real ad account.

---

## 17. Open questions / UNVERIFIED

- **Seedance 2.5 capabilities unprobed** — account not activated (`ModelNotOpen`). Duration
  4–30 s and 480p/720p/1080p are **docs-only**, not confirmed against the API — and both were
  re-verified in the primary docs during fact-check (1080p is 10-bit; 480p/720p are 8-bit).
  ~~`.mp4`/`.mov`~~ **CORRECTED: the docs list MP4 only for every video model — there is no
  `.mov` output option.** <https://docs.byteplus.com/en/docs/ModelArk/2298881>
- **Watermark and `generate_audio` defaults** come from the Volcengine (China) mirror of the
  API, not the BytePlus English doc, which does not state them. The international service may
  differ. **Verify empirically before first spend.**
- **Commercial ownership of output is not established.** No clause found granting the customer
  rights in generated content; no indemnity. Legal review required.
- **No policy language found** on generating identifiable people, celebrities, or third-party
  brands. Genuinely unverified, not "unrestricted".
- **Quality is entirely unmeasured.** No assessment was made of: 9:16 composition quality, text
  rendering legibility in-frame, product fidelity from reference images, temporal coherence, or
  **usable-clip rate**. Every cost-per-clip figure here is cost per *generated* clip, which is
  the wrong denominator for a real decision.
- **Kling, Runway, Luma, Pika pricing and API status unverified** (docs gated or unreachable).
  MiniMax endpoint names captured but no pricing.
- **Region availability per model** (`eu-west-1` vs `ap-southeast-1`) not enumerated per model;
  matters for EU data residency.
- **`draft: true` mode on 1.5 Pro** — cost and quality implications unknown; docs say draft task
  ids stay valid 7 days for generating the final video. Potentially a cheap preview lane worth
  investigating.
- **`service_tier` is not validated at all.** Probing showed both `"flex"` and a nonsense
  `"bogus"` value pass validation on `seedance-1-0-pro` (the poison-pill duration error
  surfaced instead in both cases). So "flex was accepted" proves nothing — it is an unvalidated
  field, and it is unknown whether requesting `flex` on a model that does not support offline
  inference silently bills at the online rate. **Verify against an invoice before relying on
  the 50 % offline discount.**
- Whether `filter.status` supports multiple values / other filters on the task-list endpoint.

---

## 18. Fact-check log

**Fact-checked 2026-09-02** by an adversarial second pass. Method: WebFetch against primary
sources only — `docs.byteplus.com` (ModelArk API reference 2298881, rate limits 1330310,
pricing 1544106, image API 1541523), `docs.byteplus.com/en/legal/docs/terms-of-service`,
`www.volcengine.com/docs/82379/1520757` (the Volcengine mirror of the same API),
`cloud.google.com/vertex-ai/generative-ai/pricing`, `developers.openai.com/api/docs/pricing`.
The BytePlus doc site is a client-rendered SPA, so pages were read through `r.jina.ai` — the
same caveat as the original research applies (the proxy can drop table rows), but every number
below was requested as a verbatim quote and returned as one.

### Verdicts

| # | Claim | Verdict |
|---|---|---|
| 1 | Video params are top-level JSON fields; `--flag` path is legacy and loosely validated | **CONFIRMED** (field list and the phrase *"loose validation. If a parameter is invalid, it is ignored or an error is returned"* are both in the API reference). Per-flag probe results remain empirical-only. |
| 2 | `tokens = w × h × frames / 1024`, `frames = 24×duration + 1` | **CONFIRMED (docs formula) / PLAUSIBLE (the +1)** — see below. |
| 3 | Duration limits are contiguous ranges; 2.0-fast/mini cap at 720p; only 2.0 accepts 4K | **CONFIRMED in full, from the docs' own capability table.** |
| 4 | Veo per-count, Sora per-second, Seedance per pixel-frame | **CONFIRMED**, with additions. |
| 5 | `generate_audio` defaults true; doubles cost on 1.5 Pro; 1.0 Pro has no audio | **CONFIRMED** (and 1.0 Pro's lack of audio upgraded from empirical to doc-confirmed). |
| 6 | `watermark` defaults false, bottom-right | **CONFIRMED** (Volcengine mirror verbatim; BytePlus EN doc genuinely states no default — the original note was right to flag this). |
| 7 | Individual concurrency is 3, the binding constraint | **REFUTED — partially.** See correction. |
| 8 | Result URLs expire in 24 h / 100 downloads; task records 7 days | **CONFIRMED verbatim.** |
| 9 | A running task cannot be cancelled and is billed | **CONFIRMED** (docs: DELETE *"Cancel queued video generation tasks, or delete video generation task records"*). |
| 10 | Seedance 2.5 exists (`dreamina-seedance-2-5-260628`), not activated on the test account | **CONFIRMED**, except the file-format detail — see correction. |
| 11 | `GET /models` unreliable both ways; `ModelNotOpen` ≠ `NotFound` | **UNCERTAIN** — account-specific runtime behaviour, not externally verifiable. |
| 12 | Seedream pixel ceilings: "pro" is lower; 10 vs 14 reference images | **CONFIRMED verbatim in the image API reference.** |
| 13 | Ratio enum larger than documented, differs per model | **UNCERTAIN** — documented set confirmed; the probed extras are not. |
| 14 | No output-ownership clause in BytePlus ToS | **CONFIRMED**, including the Section 4 licence text verbatim. |

### What was wrong, and what was corrected in place

1. **Claim 7 — concurrency (§10, §13, §15 gotcha 13, §16). The most consequential error.**
   The "3 concurrent tasks" cap is **per-model, not per-account**, and applies only to the
   **Dreamina Seedance 2.x** family. The rate-limit page gives `seedance-1-0-pro-250528`,
   `seedance-1-0-pro-fast-251015` and `seedance-1-5-pro-251215` a single unified
   `default: Max RPM: 600, Max concurrency: 10` with **no individual/enterprise split at all**.
   Since §16 recommends `seedance-1-0-pro-fast` as the exploration workhorse, the real ceiling
   for the recommended pipeline is **10 concurrent, not 3** — a ~3.3× throughput difference, and
   the "≈360 clips/hour absolute" figure was therefore too pessimistic by the same factor for
   that lane. Corrected throughout; the recommendation is now a per-model semaphore.
2. **Claim 7 — missed 4K limit.** `dreamina-seedance-2-0-260128` at 4K is limited to
   **`Max RPM: 15, Max concurrency: 1`** for *both* account types. The original captured the
   15 RPM and missed the concurrency-1, which is by far the tighter constraint.
3. **`service_tier: "flex"` availability (§5).** The claim that flex is *"only available on
   `seedance-1-5-pro`"* is **wrong**: the API reference says flex is unsupported on Dreamina 2.5
   and the 2.0 series, i.e. it *is* supported on the whole Seedance 1.x line, and the rate-limit
   page lists `flex: TPD: 500B` for all three 1.x models. **But** the pricing page publishes
   offline rates **only for Seedance 1.5 Pro** — so the `$0.50` and `$1.25` offline figures
   previously tabulated for the 1.0 series were **fabricated by halving the online rate**, not
   sourced. Removed and flagged as unpriced. This also means §17's existing worry about flex
   silently billing at the online rate is well-founded and now has a documented basis.
4. **Dreamina 2.0 pricing was incomplete (§5).** The table omitted every "with video input" row
   for `dreamina-seedance-2-0-260128`: **$4.30** (480p/720p), **$4.70** (1080p), **$2.40** (4K).
   For a pipeline that uses Video Editing / Video Extension — which §8 recommends — these are
   the rates that actually apply, and they are ~40 % below the no-video-input rates. Added.
5. **`.mov` output does not exist (§17).** The claim that Seedance 2.5 supports `.mp4`/`.mov`
   is **refuted**: the capability table lists **MP4 only** for every video model. Corrected.
6. **Veo pricing was incomplete (§13, §14).** Every quoted figure was right, but the table
   omitted the Veo 3.1 **4K** tier ($0.40 video-only / $0.60 with audio), the Veo 3.1 Fast
   **720p** rate of **$0.08** (cheaper than the $0.10 the comparison is built on), and the
   Veo 3 / Veo 3 Fast / Veo 2 rows. Full verbatim table added. The headline conclusions survive:
   Veo 3.1 Fast at $0.10/count vs Seedance 1-0-pro-fast at $0.247 is **2.47×**, and vs Dreamina
   2.5 at $2.888 is **28.9×** — both as stated.
7. **Sora (§14).** `sora-2` **$0.10/s @720p** and the `sora-2-pro` ladder ($0.30 / $0.50 / $0.70
   per second at 720p / 1024p / 1080p) confirmed verbatim, as is the 50 % batch discount
   (`sora-2` batch = **$0.05/s**).

### Claims that survived scrutiny and are now doc-backed rather than probe-only

- **Per-model duration ranges** are quoted in the docs as literal ranges — `[2, 12]`,
  `[4, 12] or -1`, `[4, 15] or -1`, `[4, 30] or -1` — which independently confirms the
  "contiguous integers, not a discrete 3/5/10 set" finding without needing the probe.
- **Resolution caps**: the docs' capability table shows `dreamina-seedance-2-0-fast-260128` and
  `-mini-260615` at **480p/720p only**, and the pricing page has no 1080p/4K rows for either —
  two independent confirmations of the probe.
- **`seedance-1-0-pro-fast` does not support first+last frame** — the capability table marks it
  `✗` while every other model is `✓`. This was asserted in §8 without a source; it is now
  doc-confirmed.
- **Colour depth (new, not in the original):** Dreamina 2.5 renders 1080p at **10-bit**, while
  Dreamina 2.0 renders 1080p at 8-bit and only its **4K** output is 10-bit. Relevant if any
  downstream encode or Meta ingest step assumes 8-bit.
- **Result URL retention** — *"Video URLs are retained for 24 hours and can be downloaded up to
  100 times."* — and *"Task records are retained for 7 days."* Both verbatim. The Volcengine
  mirror states the 7-day task-record retention but **does not** state the 24 h URL retention,
  which is likely the origin of the "7 day" folklore the original note correctly debunked.

### Still unverified after fact-check

- **Every live-probe-only finding.** Claims 11 and 13, the per-flag legacy-path behaviour in
  claim 1, the `--ratio 99:1` billed-video incident, unknown-top-level-field silence, and
  validation-order observations are all runtime behaviours with no documentary counterpart.
  They are plausible and internally consistent, but a second account should reproduce them
  before anything depends on them.
- **The `+1` frame in the billing formula.** The arithmetic is exact and checks out
  (864×480×121/1024 = 49,005.0 vs 48,600 for the docs' estimate, and the 720p/1080p figures of
  108,900 and 246,840 reproduce the same way), but it rests on **a single generation**. The docs
  publish only the estimate formula and explicitly call it an estimate. Confirm across at least
  one more duration and resolution before hard-coding the +1 into budget guards.
- **`ModelNotOpen` on Seedance 2.5** is an account-state error, not a platform fact; it says
  nothing about whether 2.5 is generally available.
- **Seedream `output_format` restricted to 5.0 pro/lite, and `stream` unsupported on 5.0 pro**
  (§11) — not located in the primary docs; treat as unverified.
- **The commercial-rights gap is real and was re-confirmed**, including the Section 4 licence
  text and the absence of any output-ownership assignment, indemnity, or policy language on
  generating people or third-party brands. The trademark clause protects only BytePlus's own
  marks (*"'BytePlus', 'BytePlus Data Intelligence', 'BytePlus Analyze', 'DataPlayer', and
  'ByteDance'"*). §12's instruction to route this to counsel before spend stands unchanged.
- **Region availability per model** and the `/api/coding/v3` billing-path gotcha were not
  re-checked in this pass.
