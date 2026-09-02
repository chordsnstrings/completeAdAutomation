# Google Veo / Gemini Video + Image Generation — Engineering Dossier

**Researched:** 2026-09-02
**Scope:** programmatic generation of Meta (Facebook/Instagram) ad creative — video, image, and ad copy — via Google's Gemini Developer API and Vertex AI (now branded **"Gemini Enterprise Agent Platform"**).
**Method:** official docs only (ai.google.dev, docs.cloud.google.com, cloud.google.com/terms, policies.google.com). Every non-obvious claim carries a source URL. Anything I could not confirm from official docs is tagged **UNVERIFIED**.

---

## 0. TL;DR for the architect

1. **Two Google surfaces, and they are NOT the same product.** The Gemini Developer API (`generativelanguage.googleapis.com`, API-key auth) ships Veo as **preview** models. Vertex AI (`aiplatform.googleapis.com`, OAuth/service-account auth) ships Veo as **GA `-001`** models. **Only the GA Vertex models are covered by Google's IP indemnity.** For a production ad platform, use Vertex.
2. **A brand-new model family landed: `gemini-omni-flash-preview` / `gemini-omni-1.1-flash-preview`.** Google's own docs now position Gemini Omni Flash as the *default* video model and Veo 3.1 as the model you pick for "specific capabilities like scene extension, last-frame control, or integration with legacy pipelines." Omni uses a completely different API (the **Interactions API**), supports **3–10s** arbitrary durations (Veo is locked to 4/6/8), does conversational multi-turn video *editing*, and is priced by token.
3. **Aspect ratio is the single biggest creative constraint.** Veo generates **only `16:9` and `9:16`**. Meta's Feed placements want **4:5** and **1:1**. You *must* post-process (crop/pad) — there is no native 4:5 or 1:1 from Veo. Gemini's *image* models, by contrast, do support 1:1/4:5/9:16/etc. natively.
4. **The Gemini Developer API has a spend-based rate limit that will kill an autonomous pipeline**: a rolling 10-minute spend cap of **$10 (Tier 1) / $50 (Tier 2) / $200 (Tier 3)**. At $3.20 for an 8s Veo 3.1 video, Tier 1 = ~3 videos per 10 minutes. Vertex's quota is request-based (50 RPM) and far more workable.
5. **Everything is watermarked with SynthID (invisible) *and* signed with C2PA Content Credentials** naming "Google Media Processing Services". Plan for ad platforms detecting the provenance metadata.
6. **The indemnity has a carve-out that is aimed squarely at advertising**: it does not apply where "the allegation is based on a **trademark**-related right as a result of Customer's use of such Generated Output **in trade or commerce**."

---

## 1. Model inventory (as of 2026-09-02)

### 1.1 Video — Vertex AI (GA, indemnified)

| Model ID | Launch stage | Released | Retirement | Notes |
|---|---|---|---|---|
| `veo-3.1-generate-001` | **GA** | 2025-11-17 | 2026-11-17 or later | top tier; 4K; reference images |
| `veo-3.1-fast-generate-001` | **GA** | 2025-11-17 | 2026-11-17 or later | 720p/1080p only per model card |
| `veo-3.1-lite-generate-001` | Preview | 2026-04-02 | — | no reference images; cheapest |
| `veo-3.0-generate-001` | GA | — | — | previous generation |
| `veo-3.0-fast-generate-001` | GA | — | — | previous generation |
| `veo-2.0-generate-001` | GA | — | — | only family with structured **camera control** params |

Source: <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate> (redirects to `/gemini-enterprise-agent-platform/models/veo/3-1-generate`), and <https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations>

Vertex *also* still exposes preview aliases `veo-3.1-generate-preview` and `veo-3.1-fast-generate-preview` — the reference-image doc lists all four as accepted `MODEL_ID` values (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-references>).

### 1.2 Video — Gemini Developer API (preview only)

| Model ID | Notes |
|---|---|
| `veo-3.1-generate-preview` | "Cinematic video generation with advanced creative controls" |
| `veo-3.1-fast-generate-preview` | fast tier |
| `veo-3.1-lite-generate-preview` | **no 4K, no video extension**; 1080p is 8s-only |

Source: <https://ai.google.dev/gemini-api/docs/models>, <https://ai.google.dev/gemini-api/docs/veo>

### 1.3 Video — Gemini Omni Flash (the new default)

| Model ID | Surface | Stage |
|---|---|---|
| `gemini-omni-flash-preview` | Vertex | Preview |
| `gemini-omni-1.1-flash-preview` | Vertex | Preview |
| `gemini-omni-1.1-flash` | Gemini Developer API | (see §4) |

Google's video overview page states Veo 3.1 is now recommended "for specific capabilities like scene extension, last-frame control, or integration with legacy pipelines", while Gemini Omni Flash is "a fast, multimodal model for video generation and conversational video editing" and is the recommended default (<https://ai.google.dev/gemini-api/docs/video>).

### 1.4 Image models

| Model ID | Marketing name | Stage |
|---|---|---|
| `gemini-3.1-flash-image` | **Nano Banana 2** | Stable |
| `gemini-3.1-flash-lite-image` | **Nano Banana 2 Lite** | Stable |
| `gemini-3-pro-image` | **Nano Banana Pro** | Stable |
| `gemini-2.5-flash-image` | Nano Banana (original) | Stable/legacy |
| `imagen-4.0-generate` | Imagen 4 | **DEPRECATED** on the Gemini Developer API |

Source: <https://ai.google.dev/gemini-api/docs/models>. Imagen 4/4 Ultra/4 Fast still appear on the Vertex pricing table (<https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>) but the Gemini API model list marks Imagen 4 deprecated. **Do not build new work on Imagen.**

### 1.5 Text models (for ad copy, scripts, research)

Stable: `gemini-3.7-flash` (latest/most capable Flash), `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
Preview: `gemini-3.1-pro-preview`, `gemini-3-flash-preview`.
Legacy: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`.
Source: <https://ai.google.dev/gemini-api/docs/models>

### 1.6 Adjacent models worth knowing

- Music: `lyria-3-pro-preview` (full songs), `lyria-3-clip-preview` (≤30s clips), `lyria-realtime-exp`.
- TTS: `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`.
- `virtual-try-on-001` (Vertex) — relevant if the advertiser sells apparel.

---

## 2. Veo 3.1 exact capabilities

From the Vertex model card (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate>), verbatim spec fields:

| Spec | `veo-3.1-generate-001` | `veo-3.1-fast-generate-001` | `veo-3.1-lite-generate-001` |
|---|---|---|---|
| Video lengths | **4, 6, or 8 seconds**; reference-image-to-video only supports 8s | 4, 6, or 8 s | 4, 6, or 8 s |
| Max output videos per prompt | **4** | 4 | 4 |
| Max input image size | 20 MB | 20 MB | 20 MB |
| Aspect ratios | **9:16, 16:9** (nothing else) | 9:16, 16:9 | 9:16, 16:9 |
| Input resolutions | 720p, 1080p | 720p, 1080p | 720p, 1080p |
| **Output resolutions** | **720p, 1080p, 4K** | 720p, 1080p | 720p, 1080p |
| Frame rate | **24 FPS** (fixed, no options) | 24 FPS | 24 FPS |
| Output MIME | `video/mp4` | `video/mp4` | `video/mp4` |
| Text→video | ✅ | ✅ | ✅ |
| Image→video | ✅ | ✅ | ✅ (but "Image: Not supported" in its modality row — see Gotchas) |
| First+last frame | ✅ | ✅ | ✅ |
| **Reference images (asset)** | ✅ (up to 3) | ✅ (up to 3) | ❌ **Not supported** |
| Extend videos | ✅ | ✅ | ✅ (Vertex) / ❌ (Gemini API) |
| Sound generation | ✅ | ✅ | ✅ |
| C2PA Content Credentials | ✅ | ✅ | ✅ |
| Prompt languages | **English only** | English only | English only (preview) |
| Regions | **us-central1 only** | us-central1 only | us-central1 only |
| Quota | 50 requests/min/base-model/region | same | same |
| Provisioned Throughput | Supported | Supported | Supported |
| Batch inference | **Not supported** | Not supported | Not supported |
| Standard PayGo (dynamic shared quota) | **Not supported** — fixed quota only | same | same |

### 2.1 Is 9:16 vertical supported natively? **Yes.**
`aspectRatio: "9:16"` is a first-class enum value on both surfaces and on every Veo 3.x model. Google's own best-practices page calls it out for exactly your use case:

> "9:16: Also called portrait, vertical, or rotated widescreen. 9:16 is essential for mobile-first platforms like TikTok, Instagram Reels, and YouTube Shorts."
> — <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/best-practice>

**But 4:5 and 1:1 are NOT supported.** The only accepted values are `"16:9"` and `"9:16"`. For Meta Feed (4:5) and square (1:1) placements you must crop or pad a 9:16 master in post (ffmpeg). Design the pipeline to generate 9:16 as the master and derive 4:5 / 1:1 / 16:9 crops, keeping safe-zones in mind when writing prompts (keep the subject centred vertically so a 4:5 centre-crop of a 9:16 master doesn't decapitate anyone).

### 2.2 Native audio
All Veo 3.x variants "natively generate audio with video" — dialogue, SFX, ambience, and music — in a single pass, synchronised, with lip-sync on speaking characters. Pricing distinguishes "Video + Audio generation" from "Video generation" (audio off) on Vertex, so audio is a billable toggle there (§5).

Vertex prompting guidance for audio (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/video-gen-prompt-guide>):
- **Sound effects**: "the sound of a phone ringing", "water splashing in the background"
- **Ambient noise**: "the sounds of city traffic and distant sirens"
- **Dialogue**: `the man in the red hat says: Where is the rabbit?`
- Use **separate sentences** in the prompt to describe audio.

### 2.3 Video extension — the two surfaces disagree

| | Gemini Developer API | Vertex AI |
|---|---|---|
| Input video | Veo-generated only, **up to 141 s** | **1–30 s** |
| Extension increment | **+7 s** per call | +7 s per call |
| Max chained extensions | **up to 20** | (capped by the 30s input limit) |
| Max final length | **148 s** | **37 s** for Veo (40 s for Gemini Omni Flash) |
| Resolution during extension | **720p only** | **720p, 1080p, or 4k** (corrected — see Gotcha 9) |
| Aspect ratios | 9:16 or 16:9 | 9:16 or 16:9 |
| Model support | Veo 3.1 & 3.1 Fast (**not Lite**) | 3.1, 3.1 Fast, **and** 3.1 Lite |
| Retention | extended videos treated as newly generated; 2-day timer resets | GCS, your bucket |

Sources: <https://ai.google.dev/gemini-api/docs/veo>, <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos>

The mechanism is the same (+7s per call); the platforms differ on how long an input they will accept, so the *effective* ceiling differs enormously (148s vs 37s). **If you need a 30s+ ad, that alone is a reason to use the Gemini Developer API for the extension step, or to stitch clips yourself with ffmpeg** (which is what Google's own best-practices page recommends anyway — see §8).

### 2.4 Camera control
There is **no structured camera-control parameter on Veo 3.x.** The `cameraControl` enum (e.g. pan/zoom/dolly presets) belongs to **Veo 2** — the Vertex pricing table lists it under "Veo 2 → Advanced Controls: Generate videos through start and end frame interpolation, extend generated videos, and **apply camera controls**", and no Veo 3.x doc exposes such a field.

On Veo 3.x, camera direction is **natural-language only**, inside `prompt`. The prompt guide enumerates the vocabulary the model was trained on: static/fixed, pan (left/right), tilt (up/down), **dolly** (in/out), **truck** (left/right), **pedestal** (up/down), zoom (in/out), crane shot, handheld/shaky cam, arc shot; plus angles: low-angle, high-angle, eye-level, bird's-eye, worm's-eye, Dutch/canted angle, over-the-shoulder, POV. It also warns: *"Some advanced camera angles are not officially supported"* and *"Some advanced camera lenses are not officially supported."*
Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/video-gen-prompt-guide>

**Implication:** you cannot deterministically A/B "same scene, different camera move" via a parameter. You must vary prompt text and pin `seed`.

---

## 3. API surface — exact request shapes

### 3.1 Vertex AI (recommended for production)

**Start the job (long-running):**
```
POST https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/publishers/google/models/MODEL_ID:predictLongRunning
Authorization: Bearer $(gcloud auth print-access-token)
Content-Type: application/json; charset=utf-8
```

**Text-to-video / image-to-video body:**
```json
{
  "instances": [
    {
      "prompt": "TEXT_PROMPT",
      "image": {
        "bytesBase64Encoded": "INPUT_IMAGE",
        "mimeType": "image/jpeg"
      }
    }
  ],
  "parameters": {
    "storageUri": "gs://video-bucket/output/",
    "aspectRatio": "9:16",
    "durationSeconds": 8,
    "resolution": "1080p",
    "negativePrompt": "NEGATIVE_PROMPT",
    "personGeneration": "allow_adult",
    "sampleCount": 4,
    "seed": 12345,
    "resizeMode": "crop"
  }
}
```

**First+last frame interpolation** — add `lastFrame` as a sibling of `image` *inside the instance*:
```json
{
  "instances": [{
    "prompt": "TEXT_PROMPT",
    "image":     { "gcsUri": "gs://.../first.png", "mimeType": "image/png" },
    "lastFrame": { "gcsUri": "gs://.../last.png",  "mimeType": "image/png" }
  }],
  "parameters": { "storageUri": "gs://...", "sampleCount": 1 }
}
```

**Reference images (subject/asset consistency)** — up to **3**, `referenceType: "asset"`:
```json
{
  "instances": [{
    "prompt": "TEXT_PROMPT",
    "referenceImages": [
      { "image": { "bytesBase64Encoded": "…", "mimeType": "image/png" },
        "referenceType": "asset" }
    ]
  }],
  "parameters": {
    "aspectRatio": "9:16",
    "durationSeconds": 8,
    "storageUri": "gs://…",
    "sampleCount": 1,
    "resolution": "1080p"
  }
}
```

**Extension** — pass a `video` object in the instance (Python SDK: `video=Video(uri="gs://…", mime_type="video/mp4")`).

**Poll (note: POST, not GET):**
```
POST https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/publishers/google/models/MODEL_ID:fetchPredictOperation
{ "operationName": "projects/PROJECT_ID/locations/us-central1/publishers/google/models/MODEL_ID/operations/OPERATION_ID" }
```

**Completed response:**
```json
{
  "name": "projects/…/operations/OPERATION_ID",
  "done": true,
  "response": {
    "raiMediaFilteredCount": 0,
    "@type": "type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse",
    "videos": [
      { "gcsUri": "gs://BUCKET_NAME/TIMESTAMPED_FOLDER/sample_0.mp4",
        "mimeType": "video/mp4" }
    ]
  }
}
```
If `storageUri` is omitted, videos come back **base64 inline** as `bytesBase64Encoded` instead of `gcsUri`. For 8s 1080p MP4s that is a multi-megabyte JSON payload — **always set `storageUri`** in production.

Sources: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-an-image>, `/generate-videos-from-first-and-last-frames`, `/generate-videos-from-references`, `/extend-videos`

**Parameter enum reference (Vertex):**
- `aspectRatio`: `"16:9"` (default) \| `"9:16"`
- `resolution`: `"720p"` (default) \| `"1080p"` \| `"4k"` — Veo 3 models only; docs say `"4k"` is "Veo 3.1 Preview models only" (contradicts the GA model card — see Gotchas)
- `durationSeconds`: Veo 2 → 5–8 (default 8); **Veo 3 → 4, 6, or 8 (default 8)**
- `personGeneration`: `"allow_adult"` (default) \| `"disallow"`
- `sampleCount`: 1–4
- `seed`: uint32, 0–4294967295
- `resizeMode`: `"crop"` \| `"pad"`
- `negativePrompt`: free string
- `storageUri`: `gs://…/`
- Input image MIME: `image/jpeg` or `image/png` only

**Parameters the REST guides do NOT document but the official `google-genai` SDK sends (verified in
`google-genai` 2.21.0 `models.py`, Vertex path; probe before depending on them per model):**

| JSON path | SDK field | Type / values | Why it matters |
|---|---|---|---|
| `parameters.generateAudio` | `generate_audio` | bool | **This is the audio-off toggle** that the Vertex price sheet's "Video generation" (vs "Video + Audio generation") SKU bills against. §5.1 asserts audio is a billable toggle but never named the field — this is it. |
| `parameters.enhancePrompt` | `enhance_prompt` | bool — "Whether to use the prompt rewriting logic." | **Silently rewrites your prompt.** Directly undermines the §2.4 / §10.3 advice to pin `seed` for A/B consistency: a rewritten prompt is a different prompt. Set it explicitly. |
| `parameters.pubsubTopic` | `pubsub_topic` | string | **Push completion notification instead of polling** on Vertex. §6.3 assumes a polling loop; Pub/Sub removes it. |
| `webhookConfig` (top level) | `webhook_config` | object | **Gemini Developer API only** — the SDK raises `ValueError` if you send it on Vertex. |
| `parameters.compressionQuality` | `compression_quality` | `"OPTIMIZED"` \| `"LOSSLESS"` | File-size vs quality. Relevant to Meta upload size limits and to the ffmpeg re-encode step. |
| `parameters.fps` | `fps` | int | Present in the API surface even though every Veo model card says 24 FPS fixed. Assume 24 until probed. |
| `instances[0].mask` | `mask` | object | Masked video editing (see the Vertex "Edit videos" page). |
| `labels` (top level) | `labels` | map<string,string> | **Per-campaign / per-advertiser billing attribution.** Worth wiring from day one. |
| `referenceImages[].referenceType` | `reference_type` | `"ASSET"` \| **`"STYLE"`** | §3.1 above only lists `"asset"`. `STYLE` also exists ("aesthetics including colors, lighting, texture … such as 'anime', 'photography', 'origami'"). SDK note: "Veo 2 supports up to 3 asset images *or* 1 style image." |

**Response schema (from the official Vertex v1 discovery document,
`https://aiplatform.googleapis.com/$discovery/rest?version=v1`, type `GoogleCloudAiplatformV1GenerateVideoResponse`):**

```
raiMediaFilteredReasons : string[]   "Returns rai failure reasons if any."
raiMediaFilteredCount   : int32      "Returns if any videos were filtered due to RAI policies."
videos                  : Video[]    { bytesBase64Encoded, gcsUri, mimeType }
generatedSamples        : string[]   DEPRECATED — GCS URIs. Do not use.
```

`bytesBase64Encoded` is confirmed as the inline-video field (§3.1's inference was right).
`raiMediaFilteredReasons[]` **does** exist for Veo — this resolves Open Question §16.3.
`generatedSamples` is marked `deprecated: true` — note the *Gemini Developer API* result path
(`response.generateVideoResponse.generatedSamples[0].video.uri`) is a different, non-deprecated shape.

### 3.2 Gemini Developer API

**Start:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
x-goog-api-key: $GEMINI_API_KEY
```
Instance fields: `prompt`, `image`, `lastFrame`, `referenceImages[]` (`referenceType: "asset"`, ≤3), `video` (extension, Veo-generated only).
Parameters: `aspectRatio` (`"16:9"` default, `"9:16"`), `durationSeconds` (`"4"`,`"6"`,`"8"` — **8 is mandatory for 1080p, 4K, and reference-image mode**), `resolution` (`"720p"` default, `"1080p"`, `"4k"`; **720p only for extension**), `personGeneration` (`"allow_all"`, `"allow_adult"`), `numberOfVideos` (**1** — no batching), `seed` (does not guarantee determinism).

**Poll:** `GET https://generativelanguage.googleapis.com/v1beta/{operation_name}`, recommended interval **10 s**.
**Result:** `response.generateVideoResponse.generatedSamples[0].video.uri`
**Download:** `curl -L -o output.mp4 -H "x-goog-api-key: $GEMINI_API_KEY" "${video_uri}"` — the URI is **not public**; it requires the API-key header.
Python: `client.files.download(file=generated_video.video, destination="output.mp4")`
**Retention: "Generated videos are stored on the server for 2 days, after which they are removed."** Extended videos reset the 2-day timer.

Source: <https://ai.google.dev/gemini-api/docs/veo>

### 3.3 The Interactions API (new; Omni Flash video + all image gen)

`generateContent` is now explicitly **legacy**. Note the Interactions API reached **GA in June 2026** ("As of June 2026, it is Generally Available and recommended for all new projects") — the original dossier did not record its launch stage:
> "While it is now considered legacy, the original `generateContent` API remains fully supported." … "all new models, multimodal capabilities, tools, and agentic features will launch on the Interactions API."
> — <https://ai.google.dev/gemini-api/docs/interactions>

**Vertex endpoint:**
```
POST https://aiplatform.googleapis.com/v1beta1/projects/PROJECT_ID/locations/global/interactions
```

**Omni Flash text→video body:**
```json
{
  "model": "gemini-omni-1.1-flash-preview",
  "input": [ { "type": "text", "text": "TEXT_PROMPT" } ],
  "response_format": [{
    "type": "video",
    "delivery": "uri",
    "gcs_uri": "gs://video-bucket/output/",
    "aspect_ratio": "9:16",
    "resolution": "1080p",
    "duration": "10s"
  }],
  "generation_config": { "video_config": { "task": "text_to_video" } }
}
```
- `video_config.task`: `"text_to_video"` \| `"extend"` (and editing tasks)
- `duration`: string, **integers 3–10 followed by `"s"`** — e.g. `"10s"`. This is far more flexible than Veo's fixed 4/6/8.
- `resolution`: `gemini-omni-1.1-flash-preview` → `"360p"`, `"720p"`, `"1080p"`, `"4k"`; `gemini-omni-flash-preview` → **`"720p"` only**
- `aspect_ratio`: `"16:9"` \| `"9:16"` — **if omitted, "the aspect ratio is inferred from the prompt"** (a nasty non-determinism; always set it explicitly)
- `delivery`: `"uri"` \| `"base64"` (Gemini API doc notes `"uri"` is required for videos > 4 MB)
- **Async:** set `"background": true` in the input item. "Asynchronous requests are retained for up to **14 days**."

**Response** is an `interaction` with `steps[]`; the video lands in the `model_output` step:
```json
{ "type": "model_output",
  "content": [ { "type": "video", "uri": "gs://some/output_path/123.mp4", "mime_type": "video/mp4" } ] }
```
plus a `usage` block with `output_tokens_by_modality` — which is how you're billed (§5.3).

**Interaction storage (Gemini Developer API):** `store=true` by default; retained **55 days on paid tier, 1 day on free tier**. `store=false` disables background execution and server-side state.

Sources: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text>, <https://ai.google.dev/gemini-api/docs/interactions>, <https://ai.google.dev/gemini-api/docs/omni>

---

## 4. Gemini Omni Flash — the model Google now recommends first

| Attribute | Value |
|---|---|
| Vertex IDs | `gemini-omni-flash-preview`, `gemini-omni-1.1-flash-preview` |
| Gemini Dev API ID | `gemini-omni-1.1-flash` |
| Duration | **3–10 s** (arbitrary integer seconds), extension **+10 s up to 40 s total** |
| Resolutions | 360p / 720p / 1080p / 4K (`gemini-omni-1.1-flash-preview`); 720p only (`gemini-omni-flash-preview`) |
| Aspect ratios | 16:9, 9:16 (inferred from prompt if unset) |
| Audio | native, generated with video |
| Editing | **conversational multi-turn editing** — element replacement, perspective changes — unique to Omni |
| Input video for editing | must be **≤ 10 seconds** |
| Endpoint | Interactions API (`/interactions`), sync or `background: true` |
| Global endpoint | **Supported** (unlike Veo) |
| Provisioned Throughput | **Not supported** |
| Regional restriction | "Editing or extending uploaded videos is not currently available for users in the European Economic Area (EEA), Switzerland, and the United Kingdom." |
| Content Credentials | Supported |

Sources: <https://ai.google.dev/gemini-api/docs/omni>, <https://ai.google.dev/gemini-api/docs/video>, <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/content-credentials>, <https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations>

**Why this matters for ads:** a 6-second hook, a 10-second demo, and iterative "change the shirt to red" edits without regenerating from scratch are all natively Omni features. Veo can't do arbitrary durations or conversational edits. But **Omni is Preview → not indemnified** (§7).

---

## 5. Pricing (exact, current)

### 5.1 Veo — Vertex AI (`/ 1 count` = **per second of output video**)
Source: <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>

| Model | Mode | 720p | 1080p | 4K |
|---|---|---|---|---|
| **Veo 3.1** | Video + Audio | $0.40/s | $0.40/s | $0.60/s |
| **Veo 3.1** | Video only | **$0.20/s** | **$0.20/s** | $0.40/s |
| **Veo 3.1 Fast** | Video + Audio | $0.10/s | $0.12/s | $0.30/s |
| **Veo 3.1 Fast** | Video only | $0.08/s | $0.10/s | $0.25/s |
| **Veo 3.1 Lite** | Video + Audio | **$0.05/s** | $0.08/s | — |
| **Veo 3.1 Lite** | Video only | **$0.03/s** | $0.05/s | — |
| Veo 3 | Video + Audio | $0.40/s | $0.40/s | — |
| Veo 3 | Video only | $0.20/s | $0.20/s | — |
| Veo 3 Fast | Video + Audio | $0.10/s | $0.12/s | — |
| Veo 3 Fast | Video only | $0.08/s | $0.10/s | — |
| Veo 2 | Video (+ Advanced Controls) | $0.50/s | — | — |

**Turning audio off halves the Veo 3.1 price.** That option exists only on Vertex's price sheet. **The parameter is `parameters.generateAudio: false`** — undocumented in the REST guides, present in the official SDK (see §3.1). On the Gemini Developer API audio is documented as “Always on” for all Veo 3.x models, which is why no audio-off price exists there.

**Also on the Gemini API price sheet:** “In some cases, an audio processing issue may prevent a video from being generated. **You will only be charged if your video is successfully generated.**” The Veo doc repeats it for the audio-block failure mode (§9.1.3): “You will not be charged if your video is blocked from generating.” Audio-block retries are therefore free — budget accordingly.

### 5.2 Veo — Gemini Developer API
Source: <https://ai.google.dev/gemini-api/docs/pricing>

| Model | 720p | 1080p | 4K | Free tier |
|---|---|---|---|---|
| `veo-3.1-generate-preview` | $0.40/s | $0.40/s | $0.60/s | ❌ |
| `veo-3.1-fast-generate-preview` | $0.10/s | $0.12/s | $0.30/s | ❌ |
| `veo-3.1-lite-generate-preview` | $0.05/s | $0.08/s | — | ❌ |

No audio-off discount is listed on the Gemini API price sheet.

### 5.3 Gemini Omni Flash (token-priced — do the arithmetic)
Source: <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>

- Input (text, image, video, audio): **$1.50 / 1M tokens**
- Text output (response + reasoning): **$9.00 / 1M tokens**
- **Video output: $17.50 / 1M tokens**
- Input token rates: 1,120 tokens/image, 32 tokens/audio-second, 5,792 tokens/video-second
- **Video output token rates (with audio):** 1,931 tok/s @360p · **5,792 tok/s @720p** · **8,688 tok/s @1080p** · 17,376 tok/s @4K

Derived effective price per second of generated video:
| Resolution | tokens/s | $/s |
|---|---|---|
| 360p | 1,931 | **$0.0338** |
| 720p | 5,792 | **$0.1014** |
| 1080p | 8,688 | **$0.1520** |
| 4K | 17,376 | **$0.3041** |

So Omni 720p ≈ Veo 3.1 Fast 720p, and Omni 1080p is ~27% *more* than Veo 3.1 Fast 1080p but gives you 3–10s granularity.

### 5.4 Cost per finished ad creative (worked)

| Recipe | Math | Cost |
|---|---|---|
| 8s, 9:16, 720p, audio, Veo 3.1 **Lite** | 8 × $0.05 | **$0.40** |
| 8s, 9:16, 720p, audio, Veo 3.1 **Fast** | 8 × $0.10 | **$0.80** |
| 8s, 9:16, 1080p, audio, Veo 3.1 **Fast** | 8 × $0.12 | **$0.96** |
| 8s, 9:16, 1080p, audio, Veo 3.1 (quality) | 8 × $0.40 | **$3.20** |
| 8s, 9:16, 1080p, **no audio**, Veo 3.1 (Vertex only) | 8 × $0.20 | **$1.60** |
| 10s, 9:16, 1080p, Omni 1.1 Flash | 10 × $0.152 | **$1.52** |
| 24s ad = 3 × 8s Veo 3.1 Fast 1080p clips stitched | 3 × $0.96 | **$2.88** |
| Same, but `sampleCount: 4` for A/B variants (Vertex) | 4 × $2.88 | **$11.52** for 4 full variants |

At Veo 3.1 Fast 1080p, **a 1,000-creative/day autonomous pipeline costs ~$960/day** in video generation alone. Budget accordingly; the Lite tier at $0.40/creative is the obvious volume-testing tier, with winners regenerated on the quality tier.

### 5.5 Image models
Gemini Developer API (<https://ai.google.dev/gemini-api/docs/pricing>):
| Model | Input $/1M | Output $/1M | Effective per image |
|---|---|---|---|
| `gemini-3.1-flash-image` (Nano Banana 2) | $0.50 | $60 | ~$0.045 @0.5K, ~$0.067 @1K |
| `gemini-3.1-flash-lite-image` (NB2 Lite) | $0.25 | $30 | ~$0.0336 @1K |
| `gemini-3-pro-image` (NB Pro) | $2.00 | $120 | ~$0.134 @1K/2K, **$0.24 @4K** |
| `gemini-2.5-flash-image` (NB1) | — | — | ~$0.039 |

Vertex (<https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>) — same token rates on the **global** endpoint, **+10% on non-global** endpoints (e.g. `gemini-3.1-flash-image` image output $60 global / $66 non-global). Text output from image models is billed separately ($3.00/1M for NB2, $12.00/1M for NB Pro).

Imagen on Vertex (legacy): Imagen 4 Ultra $0.06/image, Imagen 4 $0.04, Imagen 4 Fast $0.02, Imagen 4 upscaling to 2K/3K/4K $0.06.

### 5.6 Text models
Gemini Developer API:
- `gemini-3.7-flash`: **$0.75 in / $3.75 out** per 1M tokens **through 2026-12-31**; **$1.50 / $7.50 from 2027-01-01**
- `gemini-3.5-flash`: $1.50 / $9.00
- `gemini-2.5-flash-lite`: $0.10 / $0.40

Vertex standard (global endpoint; non-global is +10%):
- `gemini-3.7-flash` / `gemini-3.6-flash`: $0.75 / $3.75 (→ $1.50 / $7.50 in 2027); cached input $0.075
- `gemini-3-flash-preview`: $0.50 in (text/image/video), $1.00 in (audio), $3.00 out
- `gemini-3.5-flash`: $1.50 / $9.00
- `gemini-3.5-flash-lite`: $0.30 / $2.50
- `gemini-3.1-flash-lite`: $0.25 / $1.50
- `gemini-3.1-pro-preview` (Priority PayGo): $3.60 / $21.60 (≤200K input), $7.20 / $32.40 (>200K)

### 5.7 Grounding with Google Search (for market research)
> "Includes **5,000 search queries per month at no charge**, aggregated across all Gemini 3 models. Search queries exceeding those limits are billed at **$14 per 1,000 search queries**. A customer-submitted request to Gemini may result in **one or more** queries to Google Search… You will be charged for each individual search query performed. Billing will start January 5, 2026."
> — <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>

With Gemini 3 models you are billed **per query the model decides to run**, not per prompt (that was the Gemini 2.5 behaviour). An agentic research loop can silently fire many queries per call. Tool config is `{"type": "google_search"}` (older models: `google_search_retrieval`). Response carries `google_search_call.queries`, `google_search_result.search_suggestions` (HTML), and `text.annotations[]` with `url_citation` (`start_index`, `end_index`, `url`, `title`). Source: <https://ai.google.dev/gemini-api/docs/google-search>

---

## 6. Quotas, rate limits, and throughput

### 6.1 Vertex AI
- **Veo: 50 online-prediction requests per minute, per base model, per region.** (The model card renders this as "Regional online prediction requests per base model per minute per base model: 50 tokens per minute" — the "tokens per minute" wording is a docs bug; the metric is requests.) Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate>
- Because `sampleCount` goes to **4**, one request can yield 4 videos → theoretical **200 videos/minute** ceiling from a single project/region. This is the single strongest reason to prefer Vertex for a high-volume ad factory.
- Veo does **not** participate in Standard PayGo / dynamic shared quota — it is **fixed quota** only. Source: model card "Consumption options" table; <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/standard-paygo>
- **Batch inference: not supported for Veo.** No 50%-off batch lane for video.
- **Provisioned Throughput for Veo has huge quota-enforcement windows** that scale inversely with GSU count:
  | GSUs purchased | Enforcement period |
  |---|---|
  | 1–9 | **2000 s** |
  | 10–19 | 400 s |
  | 20–39 | 200 s |
  | 40–66 | 100 s |
  | 67+ | 60 s |
  > "if you have a workload that requires generating a four-second video on the Veo 3 model and you purchase 1 GSU, you can generate that video within a few minutes. However, because the enforcement window for 1 GSU is 2000 seconds, you can't generate a video of the same size until the end of that period."
  > — <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/veo-models>

  **Do not buy a small PT order thinking it smooths your burst traffic — it does the opposite.**

### 6.2 Gemini Developer API — the spend cap
Tier qualification and the rolling spend limit (<https://ai.google.dev/gemini-api/docs/rate-limits>):

| Tier | How to reach it | **Rolling 10-minute spend limit** |
|---|---|---|
| Free | — | N/A |
| Tier 1 | link an active billing account | **$10** |
| Tier 2 | paid $100 + 3 days since first successful payment | **$50** |
| Tier 3 | paid $1,000 + 30 days since first successful payment | **$200** |

Upgrades: Free→Tier 1 "instantly"; subsequent upgrades "within 10 minutes".

**MISSED IN THE ORIGINAL PASS — the tiers also carry a hard billing cap**, published in the same table
(<https://ai.google.dev/gemini-api/docs/rate-limits>):

| Usage tier | Qualification | **Billing tier cap** |
|---|---|---|
| Free | active project or free trial | N/A |
| Tier 1 | link an active billing account | **$250** |
| Tier 2 | paid $100 + 3 days | **$2,000** |
| Tier 3 | paid $1,000 + 30 days | **$20,000 – $100,000+** |

A 1,000-creative/day pipeline (~$960/day, §5.4) blows through the Tier 3 *floor* in three weeks.
Also documented on that page: **Priority inference gets 0.3x the standard rate limit** for each model and tier.
Both are further arguments for Vertex.

**Translate that:** at $3.20/video (Veo 3.1, 8s), Tier 1 permits ~3 videos per 10 min; Tier 3 permits ~62. At the Lite tier ($0.40/video) Tier 3 permits ~500 per 10 min. **The spend cap, not RPM, is your binding constraint on the Gemini Developer API.**

Per-model numeric RPM/TPM/RPD for Veo and image models are **not published** — the docs say "Rate limits depend on a variety of factors (such as your usage tier) and can be viewed in Google AI Studio" (<https://aistudio.google.com/rate-limit>). **UNVERIFIED — read them from your own account before sizing the pipeline.**

### 6.3 Latency (official numbers)
> "Request latency: Min: **11 seconds**; Max: **6 minutes** (during peak hours)."
> — <https://ai.google.dev/gemini-api/docs/veo>

Recommended polling interval: **10 s** (Gemini API docs); Vertex SDK samples use **15 s**. Design for a p99 of 6 minutes per clip and never block a request thread on it.

---

## 7. Terms of service, commercial use, indemnification

### 7.1 Ownership
> "Google won't claim ownership over that content. You acknowledge that Google may generate the same or similar content for others."
> — <https://ai.google.dev/gemini-api/terms>

You own/control the output; Google does not. There is no "no commercial use" restriction on generated media. Note the second sentence: **no exclusivity** — a competitor could receive a near-identical video.

### 7.2 Training on your data
- **Gemini Developer API, unpaid/free tier:** Google uses your prompts and responses "to provide, improve, and develop Google products and services and machine learning technologies", and **human reviewers may read and annotate them.**
- **Gemini Developer API, paid tier:** "Google doesn't use your prompts … or responses to improve our products." Retained only briefly for safety/compliance.
- **Vertex AI:** governed by the Cloud Data Processing Addendum — customer data is not used to train Google's models.

**Never send a client's unreleased product photography or account data through the free tier.**

### 7.3 Indemnification — **only Vertex, only GA models, only if paid**
Veo is on Google's list of **Generative AI Indemnified Services**:
> "Gemini Enterprise Agent Platform API (formerly Vertex AI API) used with **generally available versions** of these foundation models: Codey, Gemini, Imagen, PaLM, **Veo**"
> — <https://cloud.google.com/terms/generative-ai-indemnified-services> (last modified 2026-07-20)

The obligation itself (Service Specific Terms, <https://cloud.google.com/terms/service-terms>):
> "Google's indemnification obligations under the Agreement also apply to allegations that an unmodified Generated Output from a Generative AI Indemnified Service using only Google Pre-Trained Model(s) … infringes a third party's Intellectual Property Rights."

**Carve-outs that matter to an ad platform** — the indemnity does NOT apply if:
1. "Customer creates or uses such Generated Output that it **knew or should have known** was likely infringing"
2. "Customer … **disregards, disables, modifies, or circumvents** source citations, **filters**, instructions, or other tools Google makes available"
3. "Customer uses such Generated Output **after receiving notice of an infringement claim**"
4. "the allegation is based on a **trademark-related right as a result of Customer's use of such Generated Output in trade or commerce**"
5. Customer lacks rights to Customer Data used to customize the model

And: `"Generative AI Indemnified Service" means a Service or feature listed at [the URL above], where the use of such Service or feature is **not provided to Customer free of charge**.`

Also:
> "**Modifying, Disregarding, or Disabling Safety Filters.** Google makes available safety filters for certain Generative AI Services. Customer is solely responsible for (i) its use, non-use, or modification … of safety filters in creating Generated Output, and (ii) disregarding safety instructions or Documentation."

**Load-bearing consequences:**
- **Use `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` on Vertex for anything that ships to a paying advertiser.** `veo-3.1-lite-generate-001` (Preview), all `-preview` Gemini API models, and all Gemini Omni Flash models are **outside the indemnity**.
- Carve-out (4) means **trademark claims arising from your ads are on you**, always. Advertising *is* "trade or commerce". You need your own brand-safety layer: reject outputs containing third-party logos, wordmarks, or trade dress.
- Carve-out (2) means **never lower `personGeneration` or disable safety filters** to get past a refusal. Doing so voids indemnity for that output.
- Preview terms explicitly *permit* commercial use nonetheless: "Customers may elect to use it for production or commercial purposes, or disclose Generated Output to third-parties" (Pre-GA Offerings Terms note on the Veo 3.1 Lite model card). Permitted ≠ indemnified.

### 7.4 Content restrictions (Generative AI Prohibited Use Policy, last modified 2024-12-17)
<https://policies.google.com/terms/generative-ai/use-policy>. The clauses an ad pipeline will actually trip:

- "**Violates the rights of others, including privacy and intellectual property rights** — for example, using personal data or biometrics without legally-required consent."
- "**Frauds, scams, or other deceptive actions.**"
- "**Impersonating an individual (living or dead) without explicit disclosure, in order to deceive.**"
- "**Facilitating misleading claims of expertise or capability in sensitive areas** — for example in health, finance, government services, or the law, in order to deceive."
- "**Misrepresenting the provenance of generated content by claiming it was created solely by a human, in order to deceive.**"

That last one is directly relevant: an AI-generated "customer testimonial" or "doctor recommends" ad is a policy violation, not merely a Meta ad-review problem.

**Celebrity likeness and children** are blocked at the model level, not just in policy — see the safety codes in §9.

---

## 8. SynthID and C2PA watermarking

### 8.1 SynthID — always on, invisible
> "Videos created by Veo are watermarked using SynthID, our tool for watermarking and identifying AI-generated content. Videos can be verified using the SynthID verification platform."
> — <https://ai.google.dev/gemini-api/docs/veo>

> "All generated images include a SynthID watermark"
> — <https://ai.google.dev/gemini-api/docs/image-generation>

Properties (<https://deepmind.google/science/synthid/>):
- "**imperceptible to humans** — but can be detected by SynthID's technology"
- "The watermark **doesn't change the image or video quality**."
- "designed to stand up to modifications like **cropping, adding filters, changing frame rates, or lossy compression**"

**There is no API to disable it, and no documented opt-out.** It survives the crop-to-4:5 / re-encode steps your pipeline will do. It is *not* a visible overlay on API output — the visible "Veo" bug is a consumer Gemini-app thing. **UNVERIFIED:** I found no official statement that API output carries no visible watermark; verify empirically on first generation.

### 8.2 C2PA Content Credentials — cryptographically signed provenance metadata
> "If you generate a media file, such as an image, using a supported Google model, **Content Credentials are automatically added and signed by Google LLC**." … "**'Google Media Processing Services' is specified as the app or device** used in the Content Credential."
> — <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/content-credentials>

Supported models include every Veo 2/3/3.1 variant, all Nano Banana image models, both Gemini Omni Flash models, and `virtual-try-on-001`.

> "Any modification to a C2PA-compliant media file using a **non-C2PA tool is considered tampering, resulting in a validation failure**."

**Implications for the ad pipeline:**
- Your ffmpeg crop/stitch step will **break C2PA validation** (ffmpeg is not C2PA-aware) while **leaving the SynthID watermark intact**. So the delivered asset will fail C2PA verification but still test positive for SynthID.
- Ad platforms that read C2PA/IPTC "AI-generated" metadata will see it on any *unmodified* upload. Meta's behaviour here (auto-applying an "AI info" label) is **outside this dossier's scope and UNVERIFIED** — flag it for the Meta research track. If an "AI info" label is undesirable, note that a re-encode strips C2PA but *not* SynthID, and that deliberately stripping provenance to deceive is itself a Prohibited Use Policy violation ("Misrepresenting the provenance of generated content…").

---

## 9. Failure modes, refusals, and safety-filter behaviour

This is the part that breaks autonomous pipelines. Veo failures are mostly **silent partial failures**, not exceptions.

### 9.1 The three failure shapes
1. **Hard prompt rejection** — the operation errors with "The prompt couldn't be submitted or it might violate our policies."
2. **Silent under-delivery** — "If fewer videos than requested are returned, then some generated output is being blocked for not meeting safety requirements." With `sampleCount: 4` you may get 1, 2, or 0 videos back and `done: true`. **You must compare `len(response.videos)` against `sampleCount` and inspect `raiMediaFilteredCount` on every single completion.**
3. **Audio-specific block** — "Veo 3.1 will sometimes block a video from generating because of safety filters or other processing issues **with the audio**." (<https://ai.google.dev/gemini-api/docs/veo>) A visually-innocuous prompt can fail purely on its dialogue. **Retry strategy: drop the dialogue line and regenerate, or generate audio-off and dub with TTS.**

Source for 1 & 2: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/responsible-ai-and-usage-guidelines>

### 9.2 Safety support-code → category map (log and route on these)
Error text looks like: *"Veo could not generate videos because the input image violates Agent Platform's usage guidelines. If you think this was an error, send feedback. **Support codes: 15236754**"*

| Support code(s) | Category | Description |
|---|---|---|
| 58061214, 17301594 | **Child** | "Rejects requests to generate content depicting children if `personGeneration` isn't set to `allow_all` or if the project isn't on the allowlist" |
| **29310472, 15236754** | **Celebrity** | "Rejects requests to generate a photorealistic representation of a prominent person or if the project isn't on the allowlist" |
| 64151117, 42237218 | Video safety violation | General safety violation |
| 62263041 | Dangerous content | |
| 57734940, 22137204 | Hate | |
| 74803281, 29578790, 42876398 | Other | Miscellaneous safety issues |
| 89371032, 49114662, 63429089, 72817394, 60599140 | Prohibited content | Child safety or other sensitive content |
| **35561574, 35561575** | **Third-party content** | "Guardrails related to third-party content" |
| 90789179, 43188360 | Sexual | |
| 78610348 | Toxic | |
| 61493863, 56562880 | Violence | |
| 32635315 | Vulgar | |

Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/responsible-ai-and-usage-guidelines>

**Two codes deserve dedicated pipeline handling:**
- **Celebrity (29310472 / 15236754)** — fires on *photorealistic prominent people*. If your ad brief mentions any named person, or the reference image resembles one, expect this. Route to a "rewrite the prompt with a generic descriptor" retry.
- **Third-party content (35561574 / 35561575)** — this is the **brand/logo/IP guardrail**. Uploading a competitor's product shot, a logo, or a copyrighted character as a reference image will trip it. Route to a human-review queue; do **not** auto-retry with a weakened prompt (that is carve-out (2) of the indemnity).

### 9.3 `personGeneration` — different enums on the two surfaces (a real bug source)

> **CORRECTED 2026-09-02 (fact-check).** The original table below was wrong in two ways: it listed the
> Gemini API values as a free choice, and it mis-attributed the mode-gating to *regional* rules.
> On the Gemini Developer API the allowed value is fixed **by generation mode**, globally — it is not a
> setting you choose. Verified against <https://ai.google.dev/gemini-api/docs/veo> (parameter table).

| Surface / model | Mode | Allowed values | Default |
|---|---|---|---|
| **Vertex, Veo 3.x** (all) | any | `"allow_adult"`, `"disallow"` | `"allow_adult"` |
| **Gemini API, Veo 3.1 / 3.1 Fast** | text-to-video, **extension** | `"allow_all"` **only** | — |
| **Gemini API, Veo 3.1 / 3.1 Fast** | image-to-video, interpolation, reference images | `"allow_adult"` **only** | — |
| **Gemini API, Veo 3.1 Lite** | text-to-video | `"allow_all"` only | — |
| **Gemini API, Veo 3.1 Lite** | image-to-video, interpolation, reference images | `"allow_adult"` only | — |
| **Gemini API, Veo 3 / 3 Fast** | text-to-video | `"allow_all"` only | — |
| **Gemini API, Veo 3 / 3 Fast** | image-to-video | `"allow_adult"` only | — |
| **Gemini API, Veo 2** | text-to-video | `"allow_all"`, `"allow_adult"`, `"dont_allow"` | — |
| **Gemini API, Veo 2** | image-to-video | `"allow_adult"`, `"dont_allow"` | — |

~~| **Gemini API, Veo 3/3.1** | `"allow_all"`, `"allow_adult"` | — |~~ (wrong: not a free choice)
~~| **Gemini API, Veo 2** | `"dont_allow"`, `"allow_adult"` | `"dont_allow"` |~~ (wrong: Veo 2 text-to-video
also accepts `"allow_all"`; `"dont_allow"` is the default **only inside the EU/UK/CH/MENA restriction**, not globally)

Note `"disallow"` (Vertex) vs `"dont_allow"` (Gemini API/Veo 2) — different spellings for the same idea. Sending the wrong one is a 400.

**Regional gating** (Gemini API, <https://ai.google.dev/gemini-api/docs/veo>) — this is an *additional*
restriction layered on top of the mode gating above, and it is the **only** place a default is stated:

> "Regional limitations: In EU, UK, CH, MENA locations, the following are the allowed values for
> `personGeneration`: **Veo 3 and 3.1: `allow_adult` only.** **Veo 2: `dont_allow` and `allow_adult`. Default is `dont_allow`.**"

Generating children requires `personGeneration: "allow_all"` **and** a project allowlist. Assume you do not have it.
(Verified: safety support codes 58061214 / 17301594 — see §9.2.)

### 9.4 Other documented limitations
- "**Multi-video prompting:** Referencing or reasoning across multiple videos is not currently supported."
- "**Language support:** English (EN) is fully supported, but other languages have not been evaluated." — **all Veo prompts must be English.** (Localised ad copy is a separate Gemini text-model task; the *spoken dialogue inside the video* being non-English is untested.)
- `seed` "does not guarantee determinism" (Gemini API wording) even though Vertex describes it as producing "deterministic videos". Treat seeds as a *consistency nudge*, not a reproducibility guarantee.

---

## 10. Prompting rules that materially change output quality

From <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/best-practice> and the prompt guide:

1. **Avoid quotation marks around dialogue.**
   > "To prevent the model from rendering text in the video, use a colon (:) after the speaker's action to denote speech and avoid using quotation marks (")."
   > Not recommended: `A woman says: "My name is Clara."`
   > Recommended: `A woman says: My name is Clara.`

   **This directly contradicts the Gemini Developer API doc**, which says *"Use quotes for specific speech. (Example: 'This must be the key,' he murmured.)"* (<https://ai.google.dev/gemini-api/docs/veo>). **Trust the Vertex guidance** — it is the more specific, mechanism-explaining statement, and burned-in on-screen text would wreck an ad creative. Strip quotes from all generated dialogue before sending.

2. **One scene per prompt.** "Trying to chain multiple distinct events (A then B then C) in one prompt for a short video often leads to muddled or incomplete videos." Generate each beat as a separate clip and stitch. This is the officially-recommended way to build a 20–30s ad, and it is cheaper and more parallel than chained extension.

3. **Character + voice consistency recipe** (for a recurring brand spokesperson across many ads):
   - Write one exhaustive, *unchangeable* character description: physical build and age, hair colour and style, facial structure, eye colour and shape, defining marks, wardrobe, **and a named voice style** ("a voice that is crisp and clear, with a thoughtful, analytical tone and a standard American accent").
   - **Copy/paste that block verbatim into every prompt**, changing only the action and setting.
   - **Use the same `seed` across scenes** — "To ensure consistent visual, stylistic, and voice output across multiple scenes, use the same seed parameter."
   - Optionally add the same 1–3 `referenceImages` with `referenceType: "asset"`.

4. **Image-to-video: prompt for motion only.** "Your source image already provides the subject, scene, and style… Re-describ[ing] the character, the background, or the lighting depicted in the image… confuse[s] the model and lead[s] to poor results." Refer to the person as "the subject"/"she"/"they", never re-describe them. Direct one or more of: **camera motion**, **subject animation**, **environmental animation**.

5. **Source image quality is load-bearing.** "Think of your source image as the first frame of your film." This argues for a two-stage pipeline: Nano Banana Pro at 2K → Veo image-to-video, rather than pure text-to-video.

6. **Use Gemini as a pre- and post-processor.** Google's own recommended loop: (a) ask a Gemini model to act as "an expert prompter for a generative AI video generation model" and expand a brief into a detailed prompt; (b) after generation, feed the video back to a Gemini model to "evaluate the final output, check it against company or brand guidelines, and flag any potentially problematic areas." **That second step is your automated brand-safety and logo-detection gate** — build it.

---

## 11. Image generation for static ad creative

**Endpoint:** Interactions API. Request shape (<https://ai.google.dev/gemini-api/docs/image-generation>):
```json
{
  "model": "gemini-3.1-flash-image",
  "input": [
    { "type": "text",  "text": "prompt" },
    { "type": "image", "mime_type": "image/png", "data": "<BASE64_DATA>" }
  ],
  "response_format": {
    "type": "image",
    "mime_type": "image/jpeg",
    "aspect_ratio": "4:5",
    "image_size": "2K"
  },
  "generation_config": { "thinking_level": "high" },
  "tools": [ { "type": "google_search" } ]
}
```

**Aspect ratios — this is where you get Meta's native formats:**
`1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`

**Refined 2026-09-02:** that 10-value list is correct for `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`
and `gemini-2.5-flash-image`. **`gemini-3.1-flash-image` supports 14** — the same ten *plus* the extreme
banner/skyscraper ratios **`1:4`, `1:8`, `4:1`, `8:1`** (e.g. `8:1` → 2048x512 @1K). Useful for display-style
banner units. Source: the per-model aspect-ratio tables at <https://ai.google.dev/gemini-api/docs/image-generation>.
**`4:5` and `1:1` are natively supported for images but not for video.** Meta Feed static ads can be generated at exactly the right ratio; video cannot.

**`image_size` (uppercase K required):** `"512px"` (0.5K), `"1K"`, `"2K"`, `"4K"`
| Model | Sizes |
|---|---|
| `gemini-3.1-flash-lite-image` | 1K only |
| `gemini-3.1-flash-image` | 0.5K, 1K, 2K, 4K |
| `gemini-3-pro-image` | 1K, 2K, 4K |
| `gemini-2.5-flash-image` | 1K, 2K, 4K |

**Reference-image budgets (for product/brand consistency):**
| Model | Limits |
|---|---|
| `gemini-3.1-flash-lite-image` | up to **14 object** images |
| `gemini-3.1-flash-image` | up to **10 object + 4 character + 3 style** references |
| `gemini-3-pro-image` | up to **6 object + 5 character** references |

**`thinking_level`:** `"minimal"` or `"high"` (Gemini 3.1 Flash only). Higher = better composition, more cost/latency.

**Text rendering:** "Advanced text rendering: Capable of generating legible, stylized text for infographics, menus, diagrams, and **marketing assets**." This means you can burn headline copy into a static ad directly — a real differentiator vs. earlier image models.

**Grounding inside image generation:** the `tools: [{"type": "google_search"}]` field is accepted on image requests — useful for factually-current visuals, but it bills search queries (§5.7).

---

## 12. Gemini text models for ad copy, scripts, and market research

**Structured output** (<https://ai.google.dev/gemini-api/docs/structured-output>) — on the Interactions API the shape is:
```json
"response_format": {
  "type": "text",
  "mime_type": "application/json",
  "schema": { "...JSON Schema..." }
}
```
Supported schema features: types `string, number, integer, boolean, object, array, null`; `title`, `description`, `enum`, `format` (`date-time`, `date`, `time`); `properties`, `required`, `additionalProperties`; `items`, `prefixItems`, `minItems`, `maxItems`; `minimum`, `maximum`.

Documented limits: "**Not all JSON Schema features are supported**" and "**Very large or deeply nested schemas may be rejected.**" Required fields are only enforced if listed in `required`. Output is syntactically valid JSON but still needs application-level validation.
Gemini 3-series models support **combining structured output with tools** (e.g. grounded search + a typed result) — that is the right primitive for "research the market, return a typed `AdConcept[]`".

**Model choice for this pipeline:**
- Ad copy / headline / primary-text variants at volume → `gemini-3.5-flash-lite` ($0.30/$2.50) or `gemini-3.1-flash-lite` ($0.25/$1.50).
- Video script + Veo prompt authoring, brand-guideline checking, video QA → `gemini-3.7-flash` ($0.75/$3.75 through 2026).
- Deep market research with grounding → `gemini-3.7-flash` + `google_search`, or the **Gemini Deep Research Agent** ($2/M in, $12/M out, $0.2/M cached).

**Legacy path still works:** `generateContent` with `generationConfig.responseMimeType`/`responseSchema` remains "fully supported" but new capabilities land only on Interactions.

---

## 13. Auth, regions, and server-side setup

### 13.1 Vertex AI (recommended)
- **Auth:** Application Default Credentials with a service account. Docs: "We recommend using an API key for testing and using **application default credentials for production**" (<https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys>). Vertex *does* also accept a Google Cloud API key (via `GOOGLE_API_KEY`), but ADC is the production path.
- Service-account impersonation is supported and is the safer pattern for CI/servers: requires `iam.serviceAccounts.getAccessToken`, i.e. **`roles/iam.serviceAccountTokenCreator`**. Local ADC file via `gcloud auth application-default login --impersonate-service-account=SA_EMAIL` (Go, Java, Node.js, Python client libraries only). Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication>
- **Region: `us-central1` only for all Veo models.** Veo is **absent** from the global-endpoint supported-model list (which includes Gemini Omni Flash, all Nano Banana models, and the Gemini 3.x text models). Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations>
- SDK env vars (Gen AI SDK against Vertex):
  ```bash
  export GOOGLE_CLOUD_PROJECT=<project>
  export GOOGLE_CLOUD_LOCATION=us-central1   # NOT global for Veo — see Gotchas
  export GOOGLE_GENAI_USE_ENTERPRISE=True
  ```
  (Note `GOOGLE_GENAI_USE_ENTERPRISE` — this replaced the older `GOOGLE_GENAI_USE_VERTEXAI` in current samples.)
- Security controls available on Veo online prediction: **Data residency, CMEK, VPC-SC, AXT**.
- Client library: `pip install --upgrade google-genai` / `npm install @google/genai` — one SDK for both surfaces, switched by `vertexai: true` + project/location.

### 13.2 Gemini Developer API
- Auth: `x-goog-api-key: $GEMINI_API_KEY` header. Simple; no OAuth.
- No region selection; no GCS output; results land on Google's file service for **2 days**.
- Use for prototyping and for the long-chain extension case (§2.3). Not for indemnified production.

---

## 14. Gotchas

1. **`fetchPredictOperation` is a `POST`, not a `GET`,** and it takes `{"operationName": "..."}` in the body. The Gemini Developer API's equivalent *is* a `GET` on the operation name. Two surfaces, two polling idioms.
2. **Omitting `storageUri` on Vertex returns the whole MP4 base64-inline.** Silent memory blowup on 1080p/8s. Always set it.
3. **Partial success looks like success.** `done: true` with fewer videos than `sampleCount` and `raiMediaFilteredCount > 0` means content was blocked. There is no error. Assert on the count.
4. **The `resolution: "4k"` docs contradict each other.** The GA `veo-3.1-generate-001` model card lists output resolutions "720p, 1080p, 4K", but the image-to-video / reference REST docs annotate `"4k"` as "**Veo 3.1 Preview models only**". The pricing table lists 4K prices for both Veo 3.1 and Veo 3.1 Fast, while the Veo 3.1 Fast model card lists only 720p/1080p output. **Probe empirically before depending on 4K on a GA model ID.**
5. **`veo-3.1-lite-generate-001`'s modality table says "Image: Not supported" while its capability table says "Text to video, image to video, from first and last frame — Supported."** Direct self-contradiction in the same model card. Assume image input may not work on Lite until tested.
6. **`durationSeconds` is a string on the Gemini Developer API (`"4"`,`"6"`,`"8"`) and an integer on Vertex (`4`,`6`,`8`).** Gemini Omni Flash uses yet a third form: `"10s"` with a unit suffix.
7. **`personGeneration` enum differs**: `"disallow"` (Vertex) vs `"dont_allow"` (Gemini API/Veo 2) vs `"allow_all"` (Gemini API only). **CORRECTED:** on the Gemini API the value is not region-gated but **mode-gated and mandatory** — text-to-video *must* send `"allow_all"`, image-to-video/interpolation/reference *must* send `"allow_adult"`. The EU/UK/CH/MENA rule is a second, separate restriction on top. See §9.3.
8. **8 seconds is mandatory for 1080p, 4K, and reference-image mode on the Gemini Developer API.** Asking for 4s at 1080p fails.
9. ~~**Extension is 720p only** on both surfaces.~~ **CORRECTED 2026-09-02:** 720p-only is true on the **Gemini Developer API** only. On **Vertex the extend-videos doc explicitly allows 720p, 1080p *or* 4k for both the input and the extended output** — "The resolution must be one of: 720p, 1080p, or 4k" (input) / "The resolution can be 720p, 1080p, or 4k" (output). Vertex input must additionally be MP4, 1–30 s, 24 fps, 9:16 or 16:9. Source: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos>
10. **Extension input must be a Veo-generated video** — you cannot extend arbitrary footage or a stitched file.
11. **Google's own Python/Node samples set `GOOGLE_CLOUD_LOCATION=global` while showing `veo-3.1-generate-001`**, but Veo is not on the global-endpoint model list and every REST sample uses `us-central1`. Follow the REST samples; the `global` in the SDK snippets appears to be copy-paste from the Omni Flash sections.
12. **Dialogue quoting**: Vertex says avoid `"` (renders on-screen text); Gemini API says use `"`. Follow Vertex; strip quotes.
13. **Veo has no batch-inference lane and no dynamic shared quota** — 50 RPM fixed, and the 50%-off batch discount that applies to Gemini text/image models does not exist for video.
14. **Provisioned Throughput at low GSU counts makes latency *worse*** (2000-second enforcement window at 1–9 GSUs).
15. **The Gemini Developer API's rolling 10-minute spend cap** ($10/$50/$200 by tier) is invisible until you hit it, and it is denominated in dollars, not requests. A pipeline that works fine on Lite will 429 the moment you switch to the quality tier.
16. **Imagen 4 is deprecated on the Gemini Developer API** but still price-listed on Vertex. Don't start there.
17. **`generateContent` is now "legacy."** New models and features ship on the Interactions API only. Any new integration should target Interactions.
18. **Grounding bills per *query*, not per prompt, on Gemini 3 models** — one API call can fire several $0.014 searches.
19. **English-only prompts for Veo.** Localised campaigns need English prompts describing non-English dialogue, which is explicitly "not evaluated."
20. **ffmpeg post-processing breaks C2PA validation but not SynthID.** Whatever you ship will be detectably AI-generated by SynthID regardless of your crop/re-encode chain.
21. **Veo only does 24 FPS.** No 30fps option. If a downstream spec or an editorial timeline assumes 30fps, you are resampling.
22. **Veo aspect ratios exclude 4:5 and 1:1** — Meta's two most common Feed video ratios. Plan the crop step from day one, and prompt with vertical safe-zones in mind.

---

## 15. Concrete recommendations for the build

1. **Primary generation path:** Vertex AI, `us-central1`, `veo-3.1-fast-generate-001`, `aspectRatio: "9:16"`, `resolution: "1080p"`, `durationSeconds: 8`, `sampleCount: 4`, `storageUri` set, pinned `seed` per campaign character. ~$0.96/clip, 4 variants per request, 50 RPM.
2. **Volume-test tier:** `veo-3.1-lite-generate-001` at $0.40/clip for hook exploration; promote winners to `veo-3.1-generate-001` (indemnified, 1080p/4K).
3. **Two-stage creative:** Nano Banana Pro (`gemini-3-pro-image`, 2K, `aspect_ratio: "9:16"`, up to 6 object + 5 character references) generates the hero frame from the advertiser's product photos → Veo image-to-video with a motion-only prompt. Better product fidelity than text-to-video, and gives you a matching static ad for free.
4. **Ratio fan-out:** generate one 9:16 1080p master → ffmpeg centre-crop to 4:5 and 1:1, letterbox/pad to 16:9. Write prompts that keep the subject in the vertical centre third.
5. **Longer ads:** generate 3 × 8s single-scene clips with an identical character block and identical `seed`, concatenate with ffmpeg. Cheaper, more parallel, and higher quality than chained extension — and it is Google's own recommendation.
6. **Mandatory completion check:** on every `done: true`, assert `len(response.videos) == sampleCount` and `raiMediaFilteredCount == 0`; on mismatch, parse the support code, map to the §9.2 table, and route Celebrity / Third-party-content codes to human review rather than auto-retrying.
7. **Audio strategy:** default to native Veo audio. On repeated audio-block failures, fall back to Vertex's audio-off pricing ($0.20/s on Veo 3.1) and dub with `gemini-3.1-flash-tts-preview` — cheaper *and* it removes a whole failure class.
8. **Brand-safety gate:** after generation, feed each clip to `gemini-3.7-flash` with the advertiser's brand guidelines and a logo/trademark detector prompt. Required both for quality and because indemnity carve-out (4) leaves trademark exposure entirely on you.
9. **Never disable or weaken safety filters** to clear a refusal — it voids the indemnity for that output under carve-out (2).
10. **Watch Gemini Omni Flash.** Arbitrary 3–10s durations, conversational editing, and global-endpoint availability are all better fits for ad iteration than Veo. Re-evaluate the moment it goes GA and joins the indemnified-services list.

---

## 16. Open questions / UNVERIFIED

1. **Numeric RPM/TPM/RPD per tier for Veo and image models on the Gemini Developer API** — not published; docs point to the AI Studio dashboard. Must be read from the actual account.
2. **Does API-generated Veo output carry a *visible* watermark?** Only SynthID (explicitly invisible) and C2PA are documented. No official statement that the API output is free of the consumer app's visible "Veo" bug. Verify on first generation.
3. ~~**`raiMediaFilteredReasons`** — UNVERIFIED for Veo.~~ **RESOLVED 2026-09-02:** `raiMediaFilteredReasons: string[]` ("Returns rai failure reasons if any.") **is** a documented field of `GoogleCloudAiplatformV1GenerateVideoResponse` in the Vertex v1 discovery document. Code against it. Also note `generatedSamples` on that same Vertex type is marked `deprecated: true`.
4. **4K on GA model IDs** — docs contradict (Gotcha 4). Needs an empirical probe of `veo-3.1-generate-001` with `resolution: "4k"`.
5. **Image input on `veo-3.1-lite-generate-001`** — model card self-contradicts (Gotcha 5).
6. **Gemini Omni Flash GA date, indemnification status, and Gemini-Developer-API pricing.** The Vertex token pricing is published; the Gemini Developer API price sheet I retrieved did not list Omni separately.
7. **Whether `sampleCount: 4` counts as 1 or 4 against the 50 RPM Veo quota.** The quota is described as "online prediction requests per minute", implying 1 — but unconfirmed. If it's 1, Vertex gives you 200 videos/min; if 4, it's 50. This materially changes throughput planning.
8. **Exact Meta-side behaviour on C2PA-signed uploads** (auto "AI info" labelling, any ad-review consequence). Out of scope here — hand to the Meta research track.
9. **Whether SynthID detection is used by any ad platform for enforcement.** No official Google statement either way.
10. **Veo 3.1 retirement**: "November 17, 2026 or later." A pipeline hard-coding `veo-3.1-generate-001` has a ~14-month runway from GA. Build model IDs as configuration, not constants.
11. **Provisioned Throughput GSU → videos/minute conversion.** Google points to an estimation tool in the console rather than publishing a formula.
12. **`gemini-omni-1.1-flash` (Gemini Dev API) vs `gemini-omni-1.1-flash-preview` (Vertex)** — the Gemini Developer API doc gives the ID without a `-preview` suffix. Whether that indicates GA on that surface is unclear.

---

## 17. Source index

- Veo (Gemini Developer API): <https://ai.google.dev/gemini-api/docs/veo>
- Video overview / Omni vs Veo positioning: <https://ai.google.dev/gemini-api/docs/video>
- Gemini Omni: <https://ai.google.dev/gemini-api/docs/omni>
- Interactions API: <https://ai.google.dev/gemini-api/docs/interactions>
- Image generation: <https://ai.google.dev/gemini-api/docs/image-generation>
- Model list: <https://ai.google.dev/gemini-api/docs/models>
- Gemini API pricing: <https://ai.google.dev/gemini-api/docs/pricing>
- Rate limits & tiers: <https://ai.google.dev/gemini-api/docs/rate-limits>
- Structured output: <https://ai.google.dev/gemini-api/docs/structured-output>
- Google Search grounding: <https://ai.google.dev/gemini-api/docs/google-search>
- Gemini API terms: <https://ai.google.dev/gemini-api/terms>
- Veo 3.1 Vertex model card: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate>
- Text→video: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text>
- Image→video: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-an-image>
- First+last frame: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-first-and-last-frames>
- Reference images: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-references>
- Extend videos: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos>
- Edit videos: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/edit-videos>
- Prompt guide: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/video-gen-prompt-guide>
- Best practices: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/best-practice>
- Responsible AI + safety codes: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/responsible-ai-and-usage-guidelines>
- Content Credentials (C2PA): <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/content-credentials>
- Vertex GenAI pricing: <https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing>
- Locations / global endpoint: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations>
- Provisioned Throughput for Veo: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/veo-models>
- Standard PayGo: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/standard-paygo>
- Authentication: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication>
- API keys: <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys>
- Indemnified services list: <https://cloud.google.com/terms/generative-ai-indemnified-services>
- Service Specific Terms (indemnity text): <https://cloud.google.com/terms/service-terms>
- Generative AI Prohibited Use Policy: <https://policies.google.com/terms/generative-ai/use-policy>
- SynthID: <https://deepmind.google/science/synthid/>

---

## 18. Fact-check log

**Date:** 2026-09-02 · **Method:** independent adversarial re-verification against primary sources only
(`ai.google.dev`, `docs.cloud.google.com/vertex-ai/...` and `.../gemini-enterprise-agent-platform/...`,
`cloud.google.com/vertex-ai/generative-ai/pricing`, `cloud.google.com/terms/...`, `deepmind.google`,
the Vertex **v1/v1beta1 discovery documents**, and the published **`google-genai` 2.21.0** SDK source).
Docs pages carried "Last updated 2026-09-01 UTC"; the indemnified-services list "Last modified July 20, 2026".

### 18.1 Verdicts

| # | Claim checked | Verdict |
|---|---|---|
| 1 | Vertex GA IDs `veo-3.1-generate-001` / `-fast-generate-001` (GA, released **November 17, 2025**, "Retirement date: November 17, 2026 or later"); `veo-3.1-lite-generate-001` Preview, released **April 2, 2026**; Gemini API `-preview` triplet; Vertex still accepts the `-preview` aliases | **CONFIRMED** — model card verbatim; alias list verbatim on the reference-images page |
| 2 | Veo aspect ratio enum is exactly `{"16:9" (default), "9:16"}`, no 4:5 / 1:1; image models do support 4:5 and 1:1 | **CONFIRMED** (image list refined — see §11) |
| 3 | 4/6/8 s, 24 FPS fixed, reference-image mode 8 s only; Vertex int vs Gemini string; Gemini 8 s mandatory for 1080p/4k/reference; Omni 3–10 s as `"10s"` | **CONFIRMED** — verbatim: "Must be `8` when using extension, reference images or with 1080p and 4k resolutions"; "Allowed strings are integers between 3 and 10, followed by `s`" |
| 4 | `predictLongRunning` POST + `fetchPredictOperation` **POST** with `{"operationName":…}`; instance/parameter field names; Gemini API polls with GET | **CONFIRMED** — all four Vertex REST guides |
| 5 | Response `videos[].gcsUri` + `raiMediaFilteredCount`; omitting `storageUri` returns base64 inline | **CONFIRMED** — response example verbatim; "If not provided, video bytes are returned in the response"; field name `bytesBase64Encoded` now **positively verified** in the v1 discovery doc rather than inferred |
| 6 | Silent partial failure; full support-code → category map | **CONFIRMED** — every code and category matches the Responsible-AI page verbatim, including Celebrity 29310472/15236754 and Third-party 35561574/35561575 |
| 7 | Per-second pricing; audio-off halves Veo 3.1 on Vertex; all 14 rate cells; Veo 2 $0.50/s; no audio-off discount on the Gemini price sheet | **CONFIRMED** — every figure matches. Gemini sheet header reads "Paid Tier, **per second** in USD", settling the "/ 1 count" unit question |
| 8 | Rolling 10-minute spend cap $10/$50/$200; tier qualifications; per-model RPM/TPM/RPD unpublished | **CONFIRMED** — plus a **missed** billing tier cap table, now added to §6.2 |
| 9 | 50 online-prediction requests/min/base-model/region (rendered as "50 tokens per minute"); no batch; no PayGo/DSQ; PT windows 2000 s→60 s | **CONFIRMED** — model card renders the quota exactly as described ("…per minute per base model : 50 tokens per minute"); "Batch inference: Not supported", "Pay-as-you-go: Not supported", "Fixed quota: Supported"; PT windows verbatim |
| 10 | Indemnity covers GA Vertex Veo only; "not provided … free of charge" | **CONFIRMED** verbatim |
| 11 | Carve-out (4) trademark-in-trade-or-commerce; carve-out (2) filters; separate safety-filter clause | **CONFIRMED** verbatim (Service Specific Terms §i(i)(1)–(5) and §j) |
| 12 | SynthID always on and invisible; C2PA auto-signed by Google LLC, app = "Google Media Processing Services"; non-C2PA edit breaks C2PA not SynthID | **CONFIRMED** verbatim. Source URL corrected: SynthID page is `deepmind.google/**science**/synthid/`, not `/models/` |
| 13 | Gemini Omni Flash is the recommended default; model IDs; Interactions endpoint; `response_format` shape; `video_config.task`; 3–10 s; 360p–4k; `background:true` retained 14 days; $17.50/1M → ~$0.101/s @720p, ~$0.152/s @1080p; EEA/CH/UK editing restriction | **CONFIRMED** — every element, including the arithmetic (5,792 × $17.50/1M = $0.10136; 8,688 × = $0.15204) |
| 14 | `generateContent` officially legacy; Interactions is the forward path | **CONFIRMED** verbatim — **plus** the missed fact that Interactions went **GA in June 2026** |
| 15 | No structured camera-control parameter on Veo 3.x; Veo 2 has it; prompt-only vocabulary; "not officially supported" warnings | **CONFIRMED** — vocabulary and both warnings verbatim in the prompt guide; pricing sheet gives Veo 2 "apply camera controls"; **no** camera field in any Veo REST guide, the v1/v1beta1 discovery docs, or the SDK's `GenerateVideosConfig` |
| 16 | Vertex says avoid quotation marks; Gemini API says use quotes | **CONFIRMED** — both verbatim, and the contradiction is real |
| 17 | `personGeneration` enums per surface + regional gating | **REFUTED (partially)** — see §18.2 |
| 18 | Latency 11 s / 6 min; 2-day retention; 10 s poll; `x-goog-api-key` needed to download | **CONFIRMED** — all verbatim in the Gemini API Veo doc and its bash sample. The "**15 s** in Vertex SDK samples" sub-claim I could **not** find in the current Vertex pages — treat as **UNVERIFIED** (harmless either way) |

### 18.2 What was actually wrong

**Claim 17 — `personGeneration` (REFUTED, partially).** Two errors, both capable of producing 400s:

1. On the Gemini Developer API the value is **not a free choice between `"allow_all"` and `"allow_adult"`** —
   it is **fixed by generation mode, globally**: text-to-video *and extension* accept `"allow_all"` **only**;
   image-to-video, interpolation and reference-image modes accept `"allow_adult"` **only**.
2. The dossier presented that mode-gating as a *regional* rule ("Other regions: …"). It is not.
   The genuine regional rule is narrower and is the only place a default appears:
   *"In EU, UK, CH, MENA locations … Veo 3 and 3.1: `allow_adult` only. Veo 2: `dont_allow` and `allow_adult`. Default is `dont_allow`."*
3. The Veo 2 row was also incomplete: Gemini API **Veo 2 text-to-video accepts `"allow_all"`, `"allow_adult"` *and* `"dont_allow"`**
   (image-to-video: `"allow_adult"`, `"dont_allow"`). §9.3 has been rewritten.

**Gotcha 9 — extension resolution (REFUTED for Vertex).** "Extension is 720p only **on both surfaces**" is wrong.
720p-only is a Gemini Developer API limit. Vertex's extend-videos page states input "must be one of: 720p, 1080p, or 4k"
and output "can be 720p, 1080p, or 4k". §2.3 and Gotcha 9 corrected. This changes the build plan: on Vertex you *can*
extend a 1080p master and stay at 1080p.

**Open question §16.3 — RESOLVED.** `raiMediaFilteredReasons: string[]` **does** exist on the Veo response type.

**Minor:** SynthID source URL path; the `gemini-3.1-flash-image` aspect-ratio list understated by four values.

### 18.3 What the original pass MISSED (added above)

1. **`parameters.generateAudio` (bool)** — the actual audio-off switch behind §5.1's "$0.20/s video-only" pricing.
   The dossier recommended the audio-off fallback (Rec. 7) **without ever naming a parameter to set**, which would
   have made that recommendation unimplementable. Not in any REST guide; present in `google-genai` 2.21.0.
2. **`parameters.enhancePrompt` (bool)** — "Whether to use the prompt rewriting logic." A model that silently rewrites
   your prompt breaks the seed-pinned A/B methodology in §2.4 and §10.3. Set it explicitly in every request.
3. **`parameters.pubsubTopic`** — Vertex can *push* completion to Pub/Sub. §6.3's polling loop is optional.
   `webhookConfig` is the Gemini-Developer-API-only equivalent; the SDK raises `ValueError` if you send it to Vertex.
4. **`parameters.compressionQuality` = `OPTIMIZED` | `LOSSLESS`**, **`parameters.fps`**, **`instances[0].mask`**.
5. **`labels` (top-level map)** — "User specified labels to track billing usage." Per-advertiser/per-campaign cost
   attribution for free; wire it in from day one on a multi-tenant ad platform.
6. **`referenceType` also accepts `STYLE`**, not just `asset` — a style reference carries "colors, lighting, texture".
   That is a brand-look-and-feel lever the dossier did not know existed. (SDK: "Veo 2 supports up to 3 asset images *or* 1 style image.")
7. **`generatedSamples` is `deprecated: true`** on the Vertex response type — do not code against it on Vertex.
   (The similarly-named Gemini Developer API path `response.generateVideoResponse.generatedSamples[0].video.uri` is a
   *different*, current shape. Easy to confuse.)
8. **Free retries on audio blocks** — "You will only be charged if your video is successfully generated" (Gemini price
   sheet) / "You will not be charged if your video is blocked from generating" (Veo doc). The §9.1.3 audio-block retry
   loop costs nothing.
9. **Gemini API billing tier caps** ($250 / $2,000 / $20,000–$100,000+) and **Priority inference = 0.3x standard rate limit**.
10. **Interactions API is GA (June 2026)**, not preview.
11. **Veo 2 on the Gemini API is silent-only** ("Audio: ❌ Silent only") and is the only Veo that returns **1 or 2** videos
    per request there; all Veo 3.x on the Gemini API are capped at **1** video per request (`numberOfVideos: 1`), which is
    why `sampleCount: 4` on Vertex is the throughput argument §6.1 makes.
12. **Model status on the Gemini API:** Veo 3.1 / 3.1 Fast / 3.1 Lite are all **Preview**; Veo 3 / Veo 3 Fast and Veo 2 are
    **Stable**. Reinforces §7.3: nothing Veo-3.1-shaped on that surface is indemnified.

### 18.4 Still unverified

- **"Vertex SDK samples poll at 15 s"** (§6.3) — not found in the current Vertex REST/SDK pages. Gemini API samples use 10 s.
- Whether `sampleCount: 4` counts as 1 or 4 against the 50 RPM quota (§16.7) — still unpublished.
- 4K on GA model IDs (§14.4) — the contradiction is **real and still present**: the GA model card lists 720p/1080p/4K
  output while every REST guide annotates `"4k"` as "**Veo 3.1 Preview models only**". Probe before relying on it.
- Image input on `veo-3.1-lite-generate-001` (§14.5) — the self-contradiction is **real and still present**: the modality
  row says "Image: Not supported" while the capability row says "Text to video, image to video, from first and last frame: Supported".
- Visible-watermark question (§16.2), Meta-side C2PA behaviour (§16.8), SynthID enforcement by ad platforms (§16.9) — unchanged.
- Whether `generateAudio` / `enhancePrompt` / `pubsubTopic` / `compressionQuality` / `fps` / `STYLE` references are accepted by
  **every** Veo 3.x model on Vertex. They are in the SDK's Vertex request builder; per-model support is undocumented. **Probe.**
